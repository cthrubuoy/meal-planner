/* =====================================================
   Meal Planner — Cook mode (v13)
   - Cook tab: "This week" queue (meals you shopped for), meal overview
   - Guided cook mode: full-screen, one step at a time, screen kept awake
   - Step timers parsed from step text ("10-12 min", "30 secs")
   - Per-step ingredient chips, unit conversion, cook log + rating
   Reuses app.js globals (state, $, escapeHtml, ingredientKey, logCooked…).
   ===================================================== */

(function () {
  const LAST_KEY = "cook-last-meal-id-v10";
  const TIMERS_KEY = "cook-timers-v13";

  const store = {
    get(k){ try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v){ try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } }
  };
  const mealById = id => state.meals.find(m => m.id === id);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  /* ============== Unit conversion (display only) ============== */
  const FRACTIONS = [[0, ""], [0.25, "¼"], [0.5, "½"], [0.75, "¾"], [1, ""]];
  function quarters(x){
    let whole = Math.floor(x), frac = x - whole, best = FRACTIONS[0];
    for (const f of FRACTIONS) if (Math.abs(frac - f[0]) < Math.abs(frac - best[0])) best = f;
    if (best[0] === 1){ whole += 1; best = FRACTIONS[0]; }
    if (!whole && !best[1]) return "¼";   // never show 0
    return `${whole || ""}${best[1]}`;
  }
  const oneDp = x => formatNumber(Math.round(x * 10) / 10);

  function usVolume(ml){
    if (ml >= 60) { const c = ml / 240; return `${quarters(c)} cup${c > 1.12 ? "s" : ""}`; }
    if (ml >= 15) return `${quarters(ml / 15)} tbsp`;
    return `${quarters(ml / 5)} tsp`;
  }
  function usWeight(g){
    return g >= 454 ? `${oneDp(g / 453.6)} lb` : `${oneDp(g / 28.35)} oz`;
  }

  /* Amount text for one ingredient in the chosen units. */
  function ingAmount(i, mode = state.prefs.cookUnits){
    const v = Number(i.amount) || 0;
    if (!v) return "";
    switch (i.type){
      case "grams": return mode === "us" ? usWeight(v) : `${formatNumber(v)} g`;
      case "ml":    return mode === "us" ? usVolume(v) : `${formatNumber(v)} ml`;
      case "tsp":   return mode === "metric" ? `${formatNumber(v * 5)} ml`   : `${formatNumber(v)} tsp`;
      case "tbsp":  return mode === "metric" ? `${formatNumber(v * 15)} ml`  : `${formatNumber(v)} tbsp`;
      case "cup":   return mode === "metric" ? `${formatNumber(v * 240)} ml` : `${formatNumber(v)} cup${v === 1 ? "" : "s"}`;
      default:      return `${formatNumber(v)} ${displayUnit(i.unit || "piece", v)}`;
    }
  }

  /* Step text as HTML, with conversions appended after temperatures and
     (US mode) metric amounts. The stored text is never changed. */
  const CONV_RE = /(\d{2,3})\s*°\s*([CF])\b|(\d+(?:\.\d+)?)\s*(ml|g)\b/gi;
  function annotateStep(text, mode = state.prefs.cookUnits){
    let out = "", last = 0;
    for (const m of String(text).matchAll(CONV_RE)){
      let note = "";
      if (m[1]){
        const n = Number(m[1]), scale = m[2].toUpperCase();
        if (mode === "metric" && scale === "F") note = `≈ ${Math.round((n - 32) * 5 / 9 / 5) * 5} °C`;
        if (mode === "us" && scale === "C") note = `≈ ${Math.round((n * 9 / 5 + 32) / 5) * 5} °F`;
      } else if (mode === "us"){
        const n = Number(m[3]);
        note = m[4].toLowerCase() === "ml" ? usVolume(n) : usWeight(n);
      }
      out += escapeHtml(text.slice(last, m.index + m[0].length));
      if (note) out += ` <span class="conv">(${escapeHtml(note)})</span>`;
      last = m.index + m[0].length;
    }
    return out + escapeHtml(String(text).slice(last));
  }

  /* ============== Step parsing ============== */
  /* "10-12 min", "2 mins", "30 secs", "1½ hours". A range uses its lower
     bound (the "check it" point); the label keeps the full range. */
  const DUR_RE = /(\d*½|\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*-?\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/gi;
  function parseDurations(text){
    const out = [], seen = new Set();
    for (const m of String(text).matchAll(DUR_RE)){
      const lo = m[1].includes("½") ? (Number(m[1].replace("½", "")) || 0) + 0.5 : Number(m[1]);
      const u = m[3].toLowerCase();
      const mult = u.startsWith("h") ? 3600 : u.startsWith("s") ? 1 : 60;
      const short = u.startsWith("h") ? "hr" : u.startsWith("s") ? "sec" : "min";
      const label = m[2] ? `${m[1]}–${m[2]} ${short}` : `${m[1]} ${short}`;
      if (!lo || seen.has(label)) continue;
      seen.add(label);
      out.push({ label, secs: Math.round(lo * mult) });
    }
    return out;
  }

  /* Oven settings as written, e.g. "220°C/ 200°C (fan)/ gas 7": from the
     first temperature to the end of that sentence. */
  const TEMP_RE = /\d{2,3}\s*°\s*[CF]\b[^.]*/gi;
  function ovenTemps(steps){
    const out = new Set();
    for (const s of steps) for (const m of String(s).matchAll(TEMP_RE)) out.add(m[0].trim().replace(/[\s,;]+$/, "").slice(0, 70));
    return Array.from(out);
  }

  /* Which of the meal's ingredients a step mentions.
     1) full name or its longest multi-word ending ("spring onion")
     2) else its main noun ("ginger" for "fresh root ginger"), unless that noun
        is generic or already claimed by a fuller match in this step. */
  const GENERIC_HEADS = new Set(["oil", "sauce", "paste", "seed", "powder", "stock", "mix", "vinegar",
    "cheese", "pepper", "water", "salt", "sugar", "flour", "juice", "leaf", "onion", "cube", "pot"]);
  // Cuts: "diced chicken thigh" is often just "the diced chicken" in the steps
  const CUTS = new Set(["breast", "thigh", "fillet", "steak", "mince", "loin", "belly", "drumstick", "wing", "chop"]);
  function stepWords(text){
    return " " + String(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").trim().split(" ").map(singulariseWord).join(" ") + " ";
  }
  function ingredientsInStep(meal, text){
    const hay = stepWords(text);
    const ings = meal.ingredients || [];
    const hit = new Set(), claimedHeads = new Set();
    ings.forEach((i, idx) => {
      const w = ingredientKey(i.name).split(" ");
      // full name first, then shorter endings down to two words ("root ginger")
      const phrases = w.length === 1 ? [w] : w.slice(0, -1).map((_, k) => w.slice(k));
      if (w.length > 1 && CUTS.has(w[w.length - 1])) phrases.push(w.slice(0, -1));
      // "chicken stock cube" → "the chicken stock" (generic noun dropped, 2+ words left)
      if (w.length > 2 && GENERIC_HEADS.has(w[w.length - 1])) phrases.push(w.slice(0, -1));
      if (phrases.some(p => hay.includes(` ${p.join(" ")} `))){ hit.add(idx); claimedHeads.add(w[w.length - 1]); }
    });
    ings.forEach((i, idx) => {
      if (hit.has(idx)) return;
      const head = ingredientKey(i.name).split(" ").pop();
      if (!GENERIC_HEADS.has(head) && !claimedHeads.has(head) && hay.includes(` ${head} `)) hit.add(idx);
    });
    return ings.filter((_, idx) => hit.has(idx));
  }

  /* ============== Cook tab ============== */
  function populateCookSelect(){
    const dd = $("#cook-meal");
    if (!dd) return;
    const keep = dd.value || store.get(LAST_KEY);
    dd.innerHTML = state.meals.slice()
      .sort((a, b) => (a.title || "").localeCompare(b.title || "", "en-GB", { sensitivity:"base" }))
      .map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.title)}</option>`).join("");
    if (keep && state.meals.some(m => m.id === keep)) dd.value = keep;
    renderCookTab();
  }

  function renderQueue(){
    const wrap = $("#cook-queue");
    if (!wrap) return;
    const items = state.cookQueue.map(q => ({ q, m: mealById(q.mealId) })).filter(x => x.m);
    if (!items.length){
      wrap.innerHTML = `<div class="empty">Meals you shop for appear here, ready to cook.</div>`;
      return;
    }
    wrap.innerHTML = items.map(({ m }) => {
      const steps = (m.steps || []).length;
      return `<div class="queue-card" data-id="${escapeHtml(m.id)}">
        <img src="${escapeHtml(m.image?.src || placeholderSvg(m.title))}" alt="" loading="lazy" />
        <div class="queue-body">
          <button class="queue-title" data-show="${escapeHtml(m.id)}">${escapeHtml(m.title)}</button>
          <div class="chips">
            ${typeof m.cookMins === "number" ? `<span class="chip">⏱ ${m.cookMins} min</span>` : ""}
            <span class="chip">${steps ? `🧾 ${plural(steps, "step")}` : "no steps yet"}</span>
          </div>
        </div>
        <button class="btn primary" data-cook="${escapeHtml(m.id)}">▶ Cook</button>
        <button class="btn mini" data-dismiss="${escapeHtml(m.id)}" title="Remove from this week" aria-label="Remove ${escapeHtml(m.title)} from this week">✕</button>
      </div>`;
    }).join("");
    $$("[data-cook]", wrap).forEach(b => b.addEventListener("click", () => openGuided(b.dataset.cook)));
    $$("[data-show]", wrap).forEach(b => b.addEventListener("click", () => {
      $("#cook-meal").value = b.dataset.show; renderOverview();
      $("#cook-overview")?.scrollIntoView({ behavior:"smooth", block:"start" });
    }));
    $$("[data-dismiss]", wrap).forEach(b => b.addEventListener("click", async () => {
      const id = b.dataset.dismiss;
      const before = state.cookQueue.slice();
      state.cookQueue = state.cookQueue.filter(q => q.mealId !== id);
      await idbSet(IDB_KEYS.cookQueue, state.cookQueue);
      renderQueue();
      showUndoToast(`Removed "${mealById(id)?.title}" from this week`, async () => {
        state.cookQueue = before;
        await idbSet(IDB_KEYS.cookQueue, state.cookQueue);
        renderQueue();
      });
    }));
  }

  function lastCookLine(id){
    const { count, avg, last } = cookStats(id);
    if (!count) return "";
    const stars = last.rating ? ` ★${last.rating}` : "";
    const note = last.note ? ` — “${escapeHtml(last.note)}”` : "";
    return `<p class="last-cook">🍳 Cooked ${plural(count, "time")}${avg != null ? ` (avg ★${formatNumber(Math.round(avg * 10) / 10)})` : ""}. Last: ${escapeHtml(formatShortDate(last.date))}${stars}${note}</p>`;
  }

  function renderOverview(){
    const wrap = $("#cook-overview");
    const meal = mealById($("#cook-meal")?.value);
    if (!wrap) return;
    if (!meal){ wrap.innerHTML = state.meals.length ? "" : `<div class="empty">No meals saved yet.</div>`; return; }
    store.set(LAST_KEY, meal.id);
    const steps = meal.steps || [];
    const ings = meal.ingredients || [];
    wrap.innerHTML = `
      <div class="cook-meta muted">
        ${typeof meal.cookMins === "number" ? `⏱ ${meal.cookMins} min · ` : ""}🥕 ${plural(ings.length, "ingredient")} · 🧾 ${plural(steps.length, "step")}
      </div>
      ${lastCookLine(meal.id)}
      ${meal.notes ? `<p class="muted small">📝 ${escapeHtml(meal.notes)}</p>` : ""}
      <div class="overview-cols">
        <div>
          <h4 class="h4">Ingredients</h4>
          <ul class="ov-ings">${ings.map(i => `<li><span>${escapeHtml(titleCase(i.name))}</span><span class="muted">${escapeHtml(ingAmount(i))}</span></li>`).join("")}</ul>
        </div>
        <div>
          <h4 class="h4">Steps</h4>
          ${steps.length
            ? `<ol class="ov-steps">${steps.map(s => `<li>${annotateStep(s)}</li>`).join("")}</ol>`
            : `<div class="no-steps">
                 <p>This meal has no steps yet.</p>
                 <button class="btn" id="ov-scan">📷 Scan back of card</button>
               </div>`}
        </div>
      </div>`;
    $("#ov-scan", wrap)?.addEventListener("click", () => scanStepsFor(meal.id));
  }

  /* Opens Edit and the existing "Scan back of card" picker in one tap.
     Must run inside the click handler so the file picker is allowed. */
  function scanStepsFor(id){
    openEdit(id);
    $("#edit-scan-steps")?.click();
  }

  function renderCookTab(){
    renderQueue();
    renderOverview();
    syncUnitsUI();
  }

  $("#cook-meal")?.addEventListener("change", renderOverview);
  $("#cook-start")?.addEventListener("click", () => { const id = $("#cook-meal")?.value; if (id) openGuided(id); });

  /* ============== Units toggle ============== */
  function syncUnitsUI(){
    $$("#cook-units, #co-units").forEach(s => { s.value = state.prefs.cookUnits || "asWritten"; });
  }
  $$("#cook-units, #co-units").forEach(sel => sel.addEventListener("change", async () => {
    state.prefs.cookUnits = sel.value;
    syncUnitsUI();
    renderOverview();
    if (guided) renderGuided();
    await idbSet(IDB_KEYS.prefs, state.prefs);
  }));

  /* ============== Guided cook mode ============== */
  const overlay = $("#cook-overlay");
  let guided = null;   // { id, page, gathered:Set, rating }
  let wakeLock = null;

  async function requestWakeLock(){
    try {
      if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
      wakeLock = await navigator.wakeLock.request("screen");
    } catch { wakeLock = null; }
  }
  document.addEventListener("visibilitychange", () => {
    if (guided && document.visibilityState === "visible") requestWakeLock();
  });

  function pageCount(meal){ return (meal.steps || []).length + 2; }   // get ready + steps + done

  function openGuided(id){
    const meal = mealById(id);
    if (!meal) return;
    guided = { id, page: 0, gathered: new Set(), rating: 0, note: "" };
    overlay.hidden = false;
    overlay.classList.add("open");   // counts as an open modal for lockBodyScroll
    lockBodyScroll(true);
    document.body.classList.add("cooking");   // docks the timer tray above Back/Next
    setIngsShown(false);
    requestWakeLock();
    renderGuided();
    $("#co-next")?.focus();
  }
  function closeGuided(){
    guided = null;
    overlay.hidden = true;
    overlay.classList.remove("open");
    lockBodyScroll(false);
    document.body.classList.remove("cooking");
    try { wakeLock?.release(); } catch { /* already released */ }
    wakeLock = null;
    renderCookTab();
  }

  function ingredientChecklist(meal){
    return `<ul class="co-checklist">${(meal.ingredients || []).map((i, idx) => `
      <li><label><input type="checkbox" data-gather="${idx}" ${guided.gathered.has(idx) ? "checked" : ""}/>
        <span class="co-ing-name">${escapeHtml(titleCase(i.name))}</span>
        <span class="co-ing-amt">${escapeHtml(ingAmount(i))}</span></label></li>`).join("")}</ul>`;
  }

  function renderGuided(){
    const meal = mealById(guided?.id);
    if (!meal){ closeGuided(); return; }
    const steps = meal.steps || [];
    const total = pageCount(meal);
    const p = guided.page;

    $("#co-title").textContent = meal.title;
    $("#co-progress-label").textContent =
      p === 0 ? "Get ready" : p === total - 1 ? "Done" : `Step ${p} of ${steps.length}`;
    $("#co-progress-bar").style.width = `${Math.round((p / (total - 1)) * 100)}%`;
    $("#co-ings").innerHTML = `<h4 class="h4">Ingredients</h4>${ingredientChecklist(meal)}`;

    let html;
    if (p === 0){
      const temps = ovenTemps(steps);
      html = `
        <div class="co-kicker">Get ready</div>
        ${lastCookLine(meal.id)}
        ${temps.length ? `<p class="co-temps">🔥 Oven: ${temps.map(t => annotateStep(t)).join(" · ")}</p>` : ""}
        ${meal.notes ? `<p class="muted">📝 ${escapeHtml(meal.notes)}</p>` : ""}
        ${steps.length ? `<p class="muted co-hint">Gather your ingredients, then tap Next. Swipe or use ‹ › to move between steps.</p>`
                       : `<div class="no-steps"><p>No steps saved for this meal — use it as an ingredients checklist, or add steps:</p>
                          <button class="btn" id="co-scan">📷 Scan back of card</button></div>`}
        <div class="co-inline-ings">${ingredientChecklist(meal)}</div>`;
    } else if (p === total - 1){
      html = `
        <div class="co-kicker">All done 🎉</div>
        <p>How was it?</p>
        <div class="co-stars" role="radiogroup" aria-label="Rating">
          ${[1, 2, 3, 4, 5].map(n => `<button class="co-star ${n <= guided.rating ? "on" : ""}" data-star="${n}" role="radio" aria-checked="${n === guided.rating}" aria-label="${n} star${n === 1 ? "" : "s"}">★</button>`).join("")}
        </div>
        <label for="co-note" class="mt8">Note for next time (optional)</label>
        <textarea id="co-note" rows="2" placeholder="e.g. needed more salt, double the sauce">${escapeHtml(guided.note)}</textarea>
        <div class="group mt8">
          <button class="btn primary" id="co-done">✓ Mark as cooked</button>
          <button class="btn" id="co-skip">Close without logging</button>
        </div>`;
    } else {
      const text = steps[p - 1];
      const used = ingredientsInStep(meal, text);
      const timers = parseDurations(text);
      html = `
        <div class="co-kicker">Step ${p}</div>
        <p class="co-step">${annotateStep(text)}</p>
        ${used.length ? `<div class="co-chips">${used.map(i => `<span class="chip co-chip">${escapeHtml(titleCase(i.name))}${ingAmount(i) ? ` · <b>${escapeHtml(ingAmount(i))}</b>` : ""}</span>`).join("")}</div>` : ""}
        ${timers.length ? `<div class="co-chips">${timers.map(t => `<button class="btn co-timer" data-secs="${t.secs}" data-label="${escapeHtml(t.label)}">⏱ Start ${escapeHtml(t.label)}</button>`).join("")}</div>` : ""}`;
    }
    const page = $("#co-page");
    page.innerHTML = html;
    page.scrollTop = 0;

    $("#co-prev").disabled = p === 0;
    $("#co-next").hidden = p === total - 1;
    $("#co-next").textContent = p === total - 2 ? "Finish ›" : "Next ›";

    // wiring for this page
    $$("[data-gather]", overlay).forEach(cb => cb.addEventListener("change", () => {
      const idx = Number(cb.dataset.gather);
      if (cb.checked) guided.gathered.add(idx); else guided.gathered.delete(idx);
      $$(`[data-gather="${idx}"]`, overlay).forEach(o => { o.checked = cb.checked; });
    }));
    $("#co-scan")?.addEventListener("click", () => { const id = guided.id; closeGuided(); scanStepsFor(id); });
    $$(".co-timer", page).forEach(b => b.addEventListener("click", () =>
      startTimer(Number(b.dataset.secs), `${meal.title.slice(0, 28)} — step ${p} (${b.dataset.label})`)));
    $$("[data-star]", page).forEach(b => b.addEventListener("click", () => {
      guided.note = $("#co-note")?.value || "";
      guided.rating = Number(b.dataset.star) === guided.rating ? 0 : Number(b.dataset.star);
      renderGuided();
    }));
    $("#co-note")?.addEventListener("input", e => { guided.note = e.target.value; });
    $("#co-done")?.addEventListener("click", async () => {
      const id = guided.id, title = meal.title;
      await logCooked(id, guided.rating, guided.note);
      closeGuided();
      status(`🍳 Logged "${title}" as cooked`);
    });
    $("#co-skip")?.addEventListener("click", closeGuided);
  }

  function go(delta){
    if (!guided) return;
    const meal = mealById(guided.id);
    const next = Math.max(0, Math.min(pageCount(meal) - 1, guided.page + delta));
    if (next === guided.page) return;
    guided.page = next;
    setIngsShown(false);
    renderGuided();
  }
  $("#co-prev")?.addEventListener("click", () => go(-1));
  $("#co-next")?.addEventListener("click", () => go(1));
  $("#co-close")?.addEventListener("click", closeGuided);
  /* Phone/portrait: the button swaps the step for the ingredient checklist */
  function setIngsShown(on){
    overlay.classList.toggle("show-ings", on);
    const b = $("#co-ing-toggle");
    if (b) b.textContent = on ? "📖 Step" : "🥕 Ingredients";
  }
  $("#co-ing-toggle")?.addEventListener("click", () => setIngsShown(!overlay.classList.contains("show-ings")));
  window.addEventListener("keydown", (e) => {
    if (!guided || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowRight" || e.key === "PageDown"){ e.preventDefault(); go(1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp"){ e.preventDefault(); go(-1); }
    else if (e.key === "Escape") closeGuided();
  });
  // Swipe left/right on the step area
  let swipe = null;
  $("#co-page")?.addEventListener("pointerdown", e => { swipe = { x: e.clientX, y: e.clientY }; });
  $("#co-page")?.addEventListener("pointerup", e => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 50) go(dx < 0 ? 1 : -1);
  });

  /* ============== Timers ==============
     Stored as end times, so they survive a reload (including the
     auto-reload after a service-worker update). Shown in a tray that
     stays visible across views and in cook mode. */
  let timers = [];
  try { timers = JSON.parse(store.get(TIMERS_KEY) || "[]").filter(t => t && t.end); } catch { timers = []; }
  let tick = null, audio = null;
  const saveTimers = () => store.set(TIMERS_KEY, JSON.stringify(timers));

  function startTimer(secs, label){
    if (!audio){ try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; } }
    audio?.resume?.();
    if ("Notification" in window && Notification.permission === "default"){
      try { Notification.requestPermission(); } catch { /* unsupported */ }
    }
    timers.push({ id: uid(), label, end: Date.now() + secs * 1000, done: false });
    saveTimers();
    renderTimers();
  }
  function beep(){
    if (!audio) return;
    try {
      [0, 0.45, 0.9].forEach(t => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = 880; o.type = "sine";
        g.gain.setValueAtTime(0.0001, audio.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.4, audio.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t + 0.35);
        o.connect(g).connect(audio.destination);
        o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.4);
      });
    } catch { /* audio blocked */ }
  }
  function alarm(t){
    beep();
    try { navigator.vibrate?.([300, 150, 300, 150, 300]); } catch { /* unsupported */ }
    status(`⏱ Time's up: ${t.label}`, 15000);
    if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted"){
      navigator.serviceWorker?.ready
        .then(r => r.showNotification("⏱ Time's up", { body: t.label, tag: t.id, vibrate: [300, 150, 300] }))
        .catch(() => {});
    }
  }
  function fmtLeft(ms){
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
  }
  /* Rebuilds the tray rows. Only called when timers are added, removed or
     finish — the 1-second tick just updates the countdown text, so a tap on
     +1 / ✕ never lands on a row that's being replaced. */
  function renderTimers(){
    const tray = $("#timer-tray");
    if (!tray) return;
    tray.hidden = !timers.length;
    tray.innerHTML = timers.map(t => `
      <div class="timer ${t.done ? "done" : ""}" data-timer="${t.id}">
        <span class="timer-left">${t.done ? "Done!" : fmtLeft(t.end - Date.now())}</span>
        <span class="timer-label">${escapeHtml(t.label)}</span>
        ${t.done ? "" : `<button class="btn mini" data-add="${t.id}" aria-label="Add a minute">+1</button>`}
        <button class="btn mini" data-stop="${t.id}" aria-label="${t.done ? "Dismiss" : "Cancel"} timer">✕</button>
      </div>`).join("");
    $$("[data-add]", tray).forEach(b => b.addEventListener("click", () => {
      const t = timers.find(x => x.id === b.dataset.add); if (t){ t.end += 60000; saveTimers(); tickTimers(); }
    }));
    $$("[data-stop]", tray).forEach(b => b.addEventListener("click", () => {
      timers = timers.filter(x => x.id !== b.dataset.stop); saveTimers(); renderTimers();
    }));
    tickTimers();
  }
  function tickTimers(){
    const now = Date.now();
    let finished = false;
    for (const t of timers){
      if (!t.done && t.end <= now){ t.done = true; finished = true; alarm(t); }
    }
    if (finished){ saveTimers(); renderTimers(); return; }
    for (const t of timers){
      const el = $(`[data-timer="${t.id}"] .timer-left`);
      if (el && !t.done) el.textContent = fmtLeft(t.end - now);
    }
    const running = timers.some(t => !t.done);
    if (running && !tick) tick = setInterval(tickTimers, 1000);
    if (!running && tick){ clearInterval(tick); tick = null; }
  }

  /* ============== Init ============== */
  function init(){
    populateCookSelect();
    renderTimers();
  }
  window.populateCookSelect = populateCookSelect;
  window.renderCookTab = renderCookTab;
  window.openGuided = openGuided;
  // Test hooks (pure helpers)
  window.cookHelpers = { parseDurations, ingredientsInStep, ingAmount, annotateStep, ovenTemps };

  if (window.appReady) init();
  else document.addEventListener("app:ready", init, { once: true });
})();
