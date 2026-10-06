/* =====================================================
   Meal Planner — sync across devices and the household (v21)
   Talks to the sync Worker (separate Cloudflare project, see CLAUDE.md).

   How it works
   - IndexedDB stays the source of truth on each device; the app works
     offline exactly as before.
   - Every save goes through idbSet() (app.js), which calls syncNoteChange(key).
     That key's state is turned into small records (one meal, one plan day,
     one shopping tick…) and compared with what this device last synced
     (`syncMeta.hashes`); changed/deleted records go into a persistent outbox
     and are pushed after a short pause.
   - Pulls bring other devices' records since `syncMeta.cursor`; they're
     applied into `state`, saved, and the screens re-render.
   - Photos travel separately, once each, by SHA-256 of their bytes.
   - Last write wins per record. A record with an unsent local change is not
     overwritten by a pull (the local change is pushed next).
   Device-only: theme, text size, views, units, thumbnails, settings tab.
   Reuses app.js globals (state, idbGet/idbSet, IDB_KEYS, $, $$, icon, status…).
   ===================================================== */

(function () {
  const ENDPOINT_DEFAULT = "https://meal-planner-sync.meal-planner-backend.workers.dev";
  const POLL_MS = 15000;
  const PUSH_DELAY_MS = 1500;
  const PUSH_CHUNK = 40;   // records per push: one D1 transaction each, kept well under the free plan's per-request query limit
  const K = { auth: "syncAuth", meta: "syncMeta", outbox: "syncOutbox" };   // IndexedDB keys (not exported)

  // which app IndexedDB key holds which record collections
  const KEY_COLLS = {
    meals: ["meal"], plan: ["plan"], pins: ["pin"], cooklog: ["cooklog"], history: ["history"],
    unitDefaults: ["unitDefault"], normaliser: ["normaliser"], pantry: ["pantry"],
    cookQueue: ["queue"], prefs: ["prefs"], session: ["shop"]
  };
  const COLL_KEY = Object.fromEntries(Object.entries(KEY_COLLS).flatMap(([k, cs]) => cs.map(c => [c, k])));

  let auth = null;            // { endpoint, deviceToken, deviceId, householdId, recoveryKey, deviceName }
  let meta = freshMeta();     // { cursor, hashes: { "coll/id": hash }, uploaded: [photo hashes] }
  let outbox = new Map();     // "coll/id" → { coll, id, data?, deleted? }
  let ready = false, paused = false;
  let timer = null, dueAt = Infinity, running = false, rerun = false, failures = 0;
  const pendingKeys = new Set(); let diffTimer = null;
  const sync = { state: "off", last: 0, error: "" };   // not "status": that's app.js's toast
  function freshMeta(){ return { cursor: 0, hashes: {}, uploaded: [] }; }
  const endpoint = () => (auth?.endpoint || localStorageGet("sync-endpoint") || ENDPOINT_DEFAULT).replace(/\/+$/, "");
  function localStorageGet(k){ try { return localStorage.getItem(k); } catch { return null; } }

  /* ---------- hashing ---------- */
  function stable(v){
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
    return JSON.stringify(v === undefined ? null : v);
  }
  function hashStr(str){   // cyrb53 — fast, 53 bits; only compares versions of the same record
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++){ const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const hashOf = data => hashStr(stable(data));

  /* ---------- photos (data URL ⇄ bytes, by SHA-256) ---------- */
  const photoByFp = new Map();     // fingerprint of a data URL → { hash, mime }
  const srcByHash = new Map();     // hash → data URL (for uploads and reuse)
  const fp = src => `${src.length}|${src.slice(-64)}|${src.slice(30, 94)}`;
  function dataUrlBytes(src){
    const comma = src.indexOf(",");
    const mime = (/^data:([^;,]+)/.exec(src) || [])[1] || "image/jpeg";
    const bin = atob(src.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, bytes };
  }
  async function sha256Hex(bytes){
    const d = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  async function photoRef(src){
    const f = fp(src);
    let ref = photoByFp.get(f);
    if (!ref){
      const { mime, bytes } = dataUrlBytes(src);
      ref = { hash: await sha256Hex(bytes), mime };
      photoByFp.set(f, ref);
    }
    srcByHash.set(ref.hash, src);
    return ref;
  }
  const blobToDataUrl = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });

  /* ---------- state → records ---------- */
  async function mealRecord(m){
    const out = { ...m };
    const src = m.image?.src;
    if (typeof src === "string" && src.startsWith("data:")) out.image = await photoRef(src);
    else out.image = m.image || null;
    return out;
  }
  const entries = (obj, coll) => Object.entries(obj || {}).map(([id, data]) => [coll, id, data]);
  async function derive(key){
    switch (key){
      case "meals": { const out = []; for (const m of state.meals) out.push(["meal", m.id, await mealRecord(m)]); return out; }
      case "plan": return entries(state.plan, "plan");
      case "pins": return entries(state.pins, "pin");
      case "cooklog": return entries(state.cooklog, "cooklog");
      case "history": return entries(state.history, "history");
      case "unitDefaults": return entries(state.unitDefaults, "unitDefault");
      case "normaliser": {
        const seen = new Map();
        for (const e of state.normaliser || []) seen.set(ingredientKey(e.canonical || ""), e);
        return [...seen].filter(([id]) => id).map(([id, e]) => ["normaliser", id, e]);
      }
      case "pantry": return [...state.pantry].map(k => ["pantry", k, 1]);
      case "cookQueue": return state.cookQueue.map(q => ["queue", q.mealId, q]);
      case "prefs": return [["prefs", "shared", { avoid: state.prefs.avoid || [], planDays: state.prefs.planDays || [] }]];
      case "session": return [
        ...[...state.selected].map(id => ["shop", "sel:" + id, 1]),
        ...[...state.haveIt].map(k => ["shop", "have:" + k, 1]),
        ...[...state.pantryUse].map(k => ["shop", "use:" + k, 1]),
        ...[...state.countedIds].map(id => ["shop", "counted:" + id, 1]),
        ...[...state.doubled].map(id => ["shop", "x2:" + id, 1])
      ];
    }
    return [];
  }
  /* Compare one IndexedDB key's state with the last synced version → outbox */
  async function diffKey(key){
    const colls = KEY_COLLS[key];
    if (!colls) return 0;
    const seen = new Set();
    let n = 0;
    for (const [coll, id, data] of await derive(key)){
      const k = `${coll}/${id}`, h = hashOf(data);
      seen.add(k);
      if (meta.hashes[k] !== h){ meta.hashes[k] = h; outbox.set(k, { coll, id, data }); n++; }
    }
    for (const k of Object.keys(meta.hashes)){
      const coll = k.slice(0, k.indexOf("/"));
      if (colls.includes(coll) && !seen.has(k)){ delete meta.hashes[k]; outbox.set(k, { coll, id: k.slice(coll.length + 1), deleted: true }); n++; }
    }
    return n;
  }
  async function diffAll(){ let n = 0; for (const key of Object.keys(KEY_COLLS)) n += await diffKey(key); await saveLocal(); return n; }

  /* Called by idbSet() after every successful save */
  function noteChange(key){
    if (!auth || !ready || !KEY_COLLS[key]) return;
    pendingKeys.add(key);
    clearTimeout(diffTimer);
    diffTimer = setTimeout(flushNotes, 250);
  }
  async function flushNotes(){
    if (paused){ diffTimer = setTimeout(flushNotes, 500); return; }
    const keys = [...pendingKeys]; pendingKeys.clear();
    let n = 0;
    for (const k of keys) n += await diffKey(k);
    if (n){ await saveLocal(); schedule(PUSH_DELAY_MS); renderStatus(); }
  }

  /* ---------- records → state ---------- */
  const SHOP_SETS = { sel: "selected", have: "haveIt", use: "pantryUse", counted: "countedIds", x2: "doubled" };
  function applyRecord(c){
    const del = c.deleted, d = c.data;
    switch (c.coll){
      case "meal": {
        const i = state.meals.findIndex(m => m.id === c.id);
        if (del){ if (i >= 0) state.meals.splice(i, 1); return; }
        const meal = { ...d };
        if (d.image?.hash) meal.image = { type: "data", src: srcByHash.get(d.image.hash) };
        if (i >= 0) state.meals[i] = meal; else state.meals.push(meal);
        return;
      }
      case "plan": if (del) delete state.plan[c.id]; else state.plan[c.id] = d; return;
      case "pin": if (del) delete state.pins[c.id]; else state.pins[c.id] = d; return;
      case "cooklog": if (del) delete state.cooklog[c.id]; else state.cooklog[c.id] = d; return;
      case "history": if (del) delete state.history[c.id]; else state.history[c.id] = d; return;
      case "unitDefault": if (del) delete state.unitDefaults[c.id]; else state.unitDefaults[c.id] = d; return;
      case "normaliser": {
        const i = state.normaliser.findIndex(e => ingredientKey(e.canonical || "") === c.id);
        if (del){ if (i >= 0) state.normaliser.splice(i, 1); }
        else if (i >= 0) state.normaliser[i] = d; else state.normaliser.push(d);
        return;
      }
      case "pantry": if (del) state.pantry.delete(c.id); else state.pantry.add(c.id); return;
      case "queue": {
        const i = state.cookQueue.findIndex(q => q.mealId === c.id);
        if (del){ if (i >= 0) state.cookQueue.splice(i, 1); }
        else if (i >= 0) state.cookQueue[i] = d; else state.cookQueue.push(d);
        state.cookQueue.sort((a, b) => String(a.added).localeCompare(String(b.added)));
        return;
      }
      case "prefs": if (!del && d){ state.prefs.avoid = d.avoid || []; state.prefs.planDays = d.planDays || []; } return;
      case "shop": {
        const at = c.id.indexOf(":"), set = state[SHOP_SETS[c.id.slice(0, at)]];
        if (!set) return;
        if (del) set.delete(c.id.slice(at + 1)); else set.add(c.id.slice(at + 1));
        return;
      }
    }
  }
  async function saveKey(key){
    switch (key){
      case "session": return saveSession();
      case "pantry": return idbSet(IDB_KEYS.pantry, Array.from(state.pantry));
      default: return idbSet(IDB_KEYS[key], state[key === "unitDefaults" ? "unitDefaults" : key]);
    }
  }
  async function applyChanges(changes){
    // photos first, so a meal never lands without its picture (throws → retried next sync)
    const need = [...new Set(changes.filter(c => c.coll === "meal" && !c.deleted && c.data?.image?.hash && !srcByHash.has(c.data.image.hash)).map(c => c.data.image.hash))];
    for (const h of need){
      const blob = await api("GET", `/v1/photo/${h}`, { blob: true });
      const src = await blobToDataUrl(blob);
      srcByHash.set(h, src);
      photoByFp.set(fp(src), { hash: h, mime: blob.type || "image/jpeg" });
    }
    const touched = new Set();
    for (const c of changes){
      const k = `${c.coll}/${c.id}`;
      if (outbox.has(k)) continue;                       // our unsent change wins; it's pushed next
      const h = c.deleted ? undefined : hashOf(c.data);
      if (!c.deleted && meta.hashes[k] === h) continue;   // deletions always apply (idempotent), e.g. on a fresh join
      if (h === undefined) delete meta.hashes[k]; else meta.hashes[k] = h;
      applyRecord(c);
      if (COLL_KEY[c.coll]) touched.add(COLL_KEY[c.coll]);
    }
    if (!touched.size) return 0;
    for (const key of touched) await saveKey(key);
    rerender(touched);
    return touched.size;
  }
  function rerender(keys){
    try {
      renderMeals(); renderShopping();
      if (keys.has("meals") || keys.has("normaliser")){ updateIngredientSuggestions(); refreshTagSuggestions(); }
      if (keys.has("prefs") && typeof syncAvoidEditor === "function") syncAvoidEditor();
      window.populateCookSelect?.();
      window.renderToday?.();
      if (state.leftView === "plan") window.renderPlan?.();
      refreshMealView();
    } catch (e){ console.warn("Sync re-render:", e); }
  }

  /* ---------- server calls ---------- */
  async function api(method, path, { body, raw, type, blob, noAuth } = {}){
    const headers = {};
    if (!noAuth && auth?.deviceToken) headers.Authorization = `Bearer ${auth.deviceToken}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (raw) headers["Content-Type"] = type;
    let r;
    try {
      r = await fetch(endpoint() + path, { method, headers, body: raw || (body !== undefined ? JSON.stringify(body) : undefined), cache: "no-store" });
    } catch {
      throw Object.assign(new Error("You're offline, or the sync server can't be reached."), { offline: true });
    }
    if (r.status === 401 && !noAuth) throw Object.assign(new Error("unlinked"), { unlinked: true });
    if (!r.ok){
      let reason = `Sync server error ${r.status}`;
      try { const j = await r.json(); reason = j.reason || j.error || reason; } catch { /* not JSON */ }
      throw Object.assign(new Error(reason), { status: r.status });
    }
    return blob ? r.blob() : r.json();
  }

  async function pushOutbox(progress){
    if (!outbox.size) return;
    // photos referenced by meals in the outbox, uploaded once
    const uploaded = new Set(meta.uploaded);
    const want = [...new Set([...outbox.values()].filter(e => e.coll === "meal" && !e.deleted && e.data?.image?.hash).map(e => e.data.image.hash))].filter(h => !uploaded.has(h));
    if (want.length){
      const { missing } = await api("POST", "/v1/photos/missing", { body: { hashes: want } });
      let done = 0;
      for (const h of missing){
        const src = srcByHash.get(h);
        if (!src) continue;
        const { mime, bytes } = dataUrlBytes(src);
        await api("PUT", `/v1/photo/${h}`, { raw: bytes, type: mime });
        progress?.(`Uploading photos ${++done} of ${missing.length}`, done / Math.max(1, missing.length));
      }
      want.forEach(h => uploaded.add(h));
      meta.uploaded = [...uploaded];
    }
    const all = [...outbox.entries()];
    for (let i = 0; i < all.length; i += PUSH_CHUNK){
      const chunk = all.slice(i, i + PUSH_CHUNK);
      await api("POST", "/v1/push", { body: { changes: chunk.map(([, e]) => e) } });
      for (const [k, e] of chunk) if (outbox.get(k) === e) outbox.delete(k);
      progress?.(`Uploading meals and lists…`, Math.min(1, (i + chunk.length) / all.length));
      await saveLocal();
    }
  }
  async function pullAll(){
    let more = true, applied = 0;
    while (more){
      const r = await api("GET", `/v1/pull?since=${meta.cursor}`);
      if (r.changes.length) applied += await applyChanges(r.changes);
      meta.cursor = r.cursor;
      more = r.more;
      await saveLocal();
    }
    return applied;
  }

  /* ---------- the loop ---------- */
  function schedule(ms){
    if (!auth) return;
    const at = Date.now() + ms;
    if (at >= dueAt && timer) return;      // something sooner is already planned
    clearTimeout(timer);
    dueAt = at;
    timer = setTimeout(() => { timer = null; dueAt = Infinity; syncNow(); }, ms);
  }
  async function syncNow(){
    if (!auth || paused) return;
    if (running){ rerun = true; return; }
    if (document.hidden && !outbox.size) return;           // no polling in the background
    running = true; sync.state = "syncing"; renderStatus();
    try {
      if (pendingKeys.size){ clearTimeout(diffTimer); await flushNotes(); }
      await pushOutbox();
      await pullAll();
      if (failures) logEvent("info", "sync", "Back in sync", { waiting: outbox.size });
      failures = 0;
      sync.state = "ok"; sync.last = Date.now(); sync.error = "";
    } catch (e){
      if (e.unlinked){ await unlinkedByServer(); return; }
      failures++;
      const was = sync.state, wasErr = sync.error;
      sync.state = e.offline ? "offline" : "error";
      sync.error = e.message;
      if (was !== sync.state || wasErr !== sync.error) logEvent(e.offline ? "warn" : "error", "sync", e.message, { status: e.status, waiting: outbox.size });
    } finally {
      running = false;
      renderStatus();
      if (auth){
        if (rerun){ rerun = false; schedule(0); }
        else if (!document.hidden) schedule(failures ? Math.min(120000, POLL_MS * 2 ** Math.min(failures, 3)) : POLL_MS);
      }
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (!auth) return;
    if (document.hidden){ clearTimeout(timer); timer = null; dueAt = Infinity; if (outbox.size) syncNow(); }
    else schedule(0);
  });
  window.addEventListener("online", () => schedule(0));
  window.addEventListener("focus", () => schedule(300));

  /* ---------- local persistence ---------- */
  async function saveLocal(){
    await Promise.all([
      idbSet(K.meta, meta),
      idbSet(K.outbox, [...outbox.values()])
    ]);
  }
  async function loadLocal(){
    const [a, m, o] = await Promise.all([idbGet(K.auth), idbGet(K.meta), idbGet(K.outbox)]);
    auth = a && a.deviceToken ? a : null;
    meta = m && typeof m === "object" ? { ...freshMeta(), ...m } : freshMeta();
    outbox = new Map((Array.isArray(o) ? o : []).map(e => [`${e.coll}/${e.id}`, e]));
  }
  async function forget(){
    auth = null; meta = freshMeta(); outbox.clear();
    clearTimeout(timer); timer = null; dueAt = Infinity;
    await Promise.all([idbSet(K.auth, null), saveLocal()]);
    sync.state = "off"; renderStatus(); renderPanel();
  }
  async function unlinkedByServer(){
    running = false;
    logEvent("warn", "sync", "This device was unlinked from sync (the server no longer accepts its key)");
    await forget();
    status("This device was unlinked from sync. Its data is still here.", 6000);
  }

  /* ---------- turning sync on: create or join ---------- */
  function guessDeviceName(){
    const ua = navigator.userAgent;
    if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "Phone" : "Tablet";
    if (/iPhone/i.test(ua)) return "iPhone";
    if (/iPad|Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return "iPad";
    if (/Windows|Macintosh|Linux/i.test(ua)) return "Computer";
    return "Device";
  }
  const deviceName = () => ($("#sync-device-name")?.value || "").trim() || guessDeviceName();
  function progress(text, frac){
    const box = $("#sync-progress");
    if (!box) return;
    box.hidden = text == null;
    if (text != null){ $("#sync-progress-text").textContent = text; $("#sync-progress-bar").style.width = `${Math.round((frac || 0) * 100)}%`; }
  }
  async function busy(fn){
    paused = true;
    $$("#sync-panel button").forEach(b => { b.disabled = true; });
    try { return await fn(); }
    finally {
      paused = false;
      $$("#sync-panel button").forEach(b => { b.disabled = false; });
      progress(null);
      renderPanel(); renderStatus();
    }
  }
  async function createHousehold(){
    if (!confirm("Turn on sync with this device's meals, plan and lists? You can then add your other devices and your household.")) return;
    await busy(async () => {
      try {
        progress("Setting up…", 0);
        const r = await api("POST", "/v1/household", { body: { deviceName: deviceName() }, noAuth: true });
        auth = { endpoint: endpoint(), deviceToken: r.deviceToken, deviceId: r.deviceId, householdId: r.householdId, recoveryKey: r.recoveryKey, deviceName: deviceName() };
        meta = freshMeta(); outbox.clear();
        await idbSet(K.auth, auth);
        progress("Preparing your data…", 0.05);
        await diffAll();
        await pushOutbox(progress);
        await pullAll();
        sync.state = "ok"; sync.last = Date.now();
        logEvent("info", "sync", "Sync turned on (new household)", { records: Object.keys(meta.hashes).length });
        status("Sync is on. Add your other devices with \"Show a code\".", 5000);
        schedule(POLL_MS);
      } catch (e){
        logEvent("error", "sync", `Couldn't turn on sync: ${e.message}`, { status: e.status });
        alert(`Couldn't turn on sync: ${e.message}\n\nNothing has changed on this device. Anything already uploaded will finish next time.`);
        sync.state = auth ? "error" : "off"; sync.error = e.message;
        if (auth) schedule(POLL_MS);
      }
    });
  }
  async function join(codeOrKey){
    const v = String(codeOrKey || "").trim();
    if (!v){ $("#sync-code")?.focus(); return; }
    const isKey = v.replace(/[^A-Za-z0-9]/g, "").length > 14;
    const hasData = state.meals.length > 0;
    if (hasData && !confirm(`Join the household?\n\nFirst, a backup of this device's data downloads (just in case). Then:\n• meals on both keep the household's version\n• meals only on this device are added for everyone\n• this device's current shopping list is replaced by the household's`)) return;
    await busy(async () => {
      try {
        if (hasData){ $("#export")?.click(); await new Promise(r => setTimeout(r, 600)); }
        progress("Linking…", 0);
        const r = await api("POST", "/v1/join", { body: { ...(isKey ? { recoveryKey: v } : { code: v }), deviceName: deviceName() }, noAuth: true });
        auth = { endpoint: endpoint(), deviceToken: r.deviceToken, deviceId: r.deviceId, householdId: r.householdId, recoveryKey: r.recoveryKey, deviceName: deviceName() };
        meta = freshMeta(); outbox.clear();
        await idbSet(K.auth, auth);
        // the household's shopping list and "this week" replace this device's
        state.selected.clear(); state.haveIt.clear(); state.pantryUse.clear(); state.countedIds.clear(); state.doubled.clear();
        state.cookQueue = [];
        await Promise.all([saveSession(), idbSet(IDB_KEYS.cookQueue, state.cookQueue)]);
        progress("Downloading the household's meals…", 0.2);
        await pullAll();                       // household wins where both have it
        progress("Adding this device's extra meals…", 0.7);
        await diffAll();                       // anything left that the household doesn't have
        await pushOutbox(progress);
        sync.state = "ok"; sync.last = Date.now();
        logEvent("info", "sync", "Joined the household", { meals: state.meals.length });
        status("Linked — this device is now in sync.", 4000);
        schedule(POLL_MS);
        rerender(new Set(Object.keys(KEY_COLLS)));
      } catch (e){
        logEvent("error", "sync", `Joining failed: ${e.message}`, { status: e.status });
        if (!auth || e.status === 403 || e.status === 400){
          alert(e.message);
          if (auth && !meta.cursor){ await forget(); }
        } else {
          alert(`Linked, but the first sync didn't finish: ${e.message}\nIt will carry on automatically.`);
          schedule(POLL_MS);
        }
      }
    });
  }
  async function leave({ quiet = false } = {}){
    if (!auth) return true;
    if (!quiet && !confirm("Turn off sync on this device? Its meals, plan and lists stay here; it just stops sharing changes. You can link it again later.")) return false;
    try { await api("DELETE", `/v1/devices/${encodeURIComponent(auth.deviceId)}`); } catch { /* offline: the token is simply forgotten */ }
    await forget();
    if (!quiet) status("Sync is off on this device.", 3000);
    return true;
  }

  /* ---------- Settings › Sync ---------- */
  let household = null, inviteTimer = null;
  function ago(ms){
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 10) return "just now";
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  function statusText(){
    const n = outbox.size;
    if (!auth) return "Sync is off.";
    if (sync.state === "syncing") return "Syncing…";
    if (sync.state === "offline") return `Offline${n ? ` — ${n} change${n === 1 ? "" : "s"} waiting` : ""}. Will sync when back online.`;
    if (sync.state === "error") return `Sync problem: ${sync.error}${n ? ` (${n} waiting)` : ""}`;
    return sync.last ? `Synced ${ago(sync.last)}${n ? ` · ${n} waiting` : ""}` : "Connecting…";
  }
  function renderStatus(){
    const dot = $("#settings .sync-badge");
    if (dot){ dot.hidden = !auth; dot.dataset.state = sync.state; }
    const t = $("#sync-status-text");
    if (t) t.textContent = statusText();
    const d = $("#sync-dot");
    if (d) d.dataset.state = sync.state;
  }
  async function renderPanel(){
    const on = !!auth;
    if ($("#sync-off")) $("#sync-off").hidden = on;
    if ($("#sync-on")) $("#sync-on").hidden = !on;
    const nameInput = $("#sync-device-name");
    if (nameInput && !nameInput.value) nameInput.value = guessDeviceName();
    renderStatus();
    if (!on) return;
    $("#sync-recovery").textContent = auth.recoveryKey || "";
    try {
      household = await api("GET", "/v1/household");
      if (household.recoveryKey && household.recoveryKey !== auth.recoveryKey){ auth.recoveryKey = household.recoveryKey; idbSet(K.auth, auth); $("#sync-recovery").textContent = auth.recoveryKey; }
      $("#sync-devices").innerHTML = household.devices.map(d => `
        <li>
          <span class="sync-dev-name">${icon(/phone/i.test(d.name) ? "today" : "grid", 16)}${escapeHtml(d.name)}${d.you ? ` <span class="chip">this device</span>` : ""}</span>
          <span class="muted small">active ${escapeHtml(ago(d.lastSeen))}</span>
          ${d.you ? "" : `<button type="button" class="btn mini ghost" data-unlink="${escapeHtml(d.id)}">Unlink</button>`}
        </li>`).join("");
      $$("[data-unlink]", $("#sync-devices")).forEach(b => b.addEventListener("click", async () => {
        const name = household.devices.find(d => d.id === b.dataset.unlink)?.name || "this device";
        if (!confirm(`Unlink "${name}"? It keeps its data but stops syncing.`)) return;
        try { await api("DELETE", `/v1/devices/${encodeURIComponent(b.dataset.unlink)}`); renderPanel(); }
        catch (e){ alert(e.message); }
      }));
    } catch (e){
      if (e.unlinked) return unlinkedByServer();
      $("#sync-devices").innerHTML = `<li class="muted small">Couldn't load the device list (${escapeHtml(e.message)}).</li>`;
    }
  }
  async function showInvite(){
    try {
      const { code, expiresAt } = await api("POST", "/v1/invite");
      const link = `${location.origin}${location.pathname}#join=${code}`;
      const qr = qrcode(0, "M");
      qr.addData(link); qr.make();
      $("#sync-qr").innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
      $("#sync-invite-code").textContent = code;
      $("#sync-invite-box").hidden = false;
      $("#sync-invite-box").dataset.link = link;
      clearInterval(inviteTimer);
      const tick = () => {
        const left = Math.max(0, expiresAt - Date.now());
        $("#sync-invite-exp").textContent = left ? `Works once · expires in ${Math.ceil(left / 60000)} min` : "Expired — make a new code.";
        if (!left){ clearInterval(inviteTimer); $("#sync-invite-box").classList.add("expired"); }
      };
      $("#sync-invite-box").classList.remove("expired");
      tick(); inviteTimer = setInterval(tick, 15000);
    } catch (e){
      if (e.unlinked) return unlinkedByServer();
      alert(`Couldn't make a code: ${e.message}`);
    }
  }

  /* In-app QR scanning where the browser supports it (Chrome/Brave on Android) */
  let scanStream = null;
  async function scanQr(){
    const video = $("#sync-video");
    try {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      video.srcObject = scanStream; video.hidden = false; await video.play();
      const started = Date.now();
      while (scanStream && Date.now() - started < 60000){
        const codes = await detector.detect(video).catch(() => []);
        const raw = codes[0]?.rawValue;
        if (raw){
          const m = /#join=([A-Za-z0-9-]+)/.exec(raw);
          $("#sync-code").value = m ? m[1] : raw;
          stopScan();
          return;
        }
        await new Promise(r => setTimeout(r, 250));
      }
    } catch (e){
      alert("Couldn't use the camera here. Type the code instead, or scan the QR with your camera app.");
    }
    stopScan();
  }
  function stopScan(){
    scanStream?.getTracks().forEach(t => t.stop());
    scanStream = null;
    const v = $("#sync-video"); if (v){ v.hidden = true; v.srcObject = null; }
  }

  function wire(){
    $("#sync-create")?.addEventListener("click", createHousehold);
    $("#sync-join-open")?.addEventListener("click", () => { $("#sync-join").hidden = false; $("#sync-code").focus(); });
    $("#sync-join-go")?.addEventListener("click", () => join($("#sync-code").value));
    $("#sync-code")?.addEventListener("keydown", e => { if (e.key === "Enter"){ e.preventDefault(); join($("#sync-code").value); } });
    const scanBtn = $("#sync-scan");
    if (scanBtn){ scanBtn.hidden = !("BarcodeDetector" in window && navigator.mediaDevices?.getUserMedia); scanBtn.addEventListener("click", scanQr); }
    $("#sync-now")?.addEventListener("click", () => { schedule(0); });
    $("#sync-invite")?.addEventListener("click", showInvite);
    $("#sync-invite-share")?.addEventListener("click", async () => {
      const link = $("#sync-invite-box").dataset.link, code = $("#sync-invite-code").textContent;
      const text = `Join my Meal Planner: open ${link} (or enter code ${code} in Settings › Sync). Works once, for 15 minutes.`;
      try { if (navigator.share) await navigator.share({ title: "Meal Planner", text }); else { await navigator.clipboard.writeText(text); status("Link copied."); } } catch { /* cancelled */ }
    });
    $("#sync-recovery-show")?.addEventListener("click", () => { const r = $("#sync-recovery"); r.hidden = !r.hidden; $("#sync-recovery-show").textContent = r.hidden ? "Show" : "Hide"; });
    $("#sync-recovery-copy")?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(auth?.recoveryKey || ""); status("Recovery key copied — keep it somewhere safe."); } catch { alert(auth?.recoveryKey || ""); }
    });
    $("#sync-leave")?.addEventListener("click", () => leave());
    $$('[data-stab="sync"]').forEach(b => b.addEventListener("click", renderPanel));
  }

  /* #join=CODE links (from the QR) open Settings › Sync with the code filled in */
  function handleJoinLink(){
    const m = /^#join=([A-Za-z0-9-]+)$/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, "", location.pathname + location.search);
    if (auth){ status("This device is already linked to sync.", 4000); return; }
    openSettings();
    $('[data-stab="sync"]')?.click();
    $("#sync-join").hidden = false;
    $("#sync-code").value = m[1];
  }

  async function init(){
    await loadLocal();
    wire();
    ready = true;
    renderStatus();
    handleJoinLink();
    window.addEventListener("hashchange", handleJoinLink);
    if (auth){
      sync.state = "syncing";
      if (outbox.size) schedule(0);
      else schedule(200);
    }
  }

  window.syncNoteChange = noteChange;
  window.syncLeave = leave;
  window.syncIsOn = () => !!auth;
  window.syncNow = () => schedule(0);
  window.syncDebug = () => ({ auth: auth && { ...auth, deviceToken: "…" }, cursor: meta.cursor, records: Object.keys(meta.hashes).length, outbox: outbox.size, status: { ...sync } });

  if (window.appReady) init();
  else document.addEventListener("app:ready", init, { once: true });
})();
