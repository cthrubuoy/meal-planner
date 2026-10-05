/* =====================================================
   Meal Planner — Planner (v15)
   - Weekly plan (Mon–Sun), stored in state.plan { "YYYY-MM-DD": [{ mealId, x? }] }
   - Auto-fill from your own meals: no repeats (this week or the last two),
     favours favourites, good ratings and meals not had for a while; unlimited swaps
   - Swipe picker: yes / no through suggestions to fill the week
   - "What can I make?": meals ranked by how few ingredients you're missing
   Reuses app.js globals (state, $, escapeHtml, gridImageSrc, cookStats…).
   ===================================================== */

(function () {
  const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // word → protein family (steak counts as beef, cod as fish…)
  // Specific meats first; cut words ("steak", "mince") only decide when no meat is named
  const PROTEINS = [["chicken","chicken"], ["beef","beef"], ["pork","pork"], ["lamb","lamb"], ["turkey","turkey"], ["duck","duck"],
    ["sausage","pork"], ["chorizo","pork"], ["bacon","pork"], ["nduja","pork"],
    ["salmon","fish"], ["cod","fish"], ["basa","fish"], ["haddock","fish"], ["tuna","fish"], ["prawn","fish"], ["fish","fish"],
    ["tofu","veg"], ["halloumi","veg"], ["paneer","veg"], ["steak","beef"], ["mince","beef"]];
  let weekOffset = 0;                 // 0 = this week, -1 = last week…
  const swapSeen = new Map();         // "day|index" -> Set of meal ids already offered there

  const mealById = id => state.meals.find(m => m.id === id);
  const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  function weekDates(offset = weekOffset){
    const d = new Date(); d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);      // Monday
    return Array.from({ length: 7 }, (_, i) => { const x = new Date(d); x.setDate(d.getDate() + i); return x; });
  }
  const dayLabel = d => `${DAY[d.getDay()]} ${d.getDate()} ${d.toLocaleDateString("en-GB", { month: "short" })}`;
  const planned = iso => state.plan[iso] || [];
  async function savePlan(){ await idbSet(IDB_KEYS.plan, state.plan); }
  function setDay(iso, items){ if (items.length) state.plan[iso] = items; else delete state.plan[iso]; }

  /* ============== Suggestions ============== */
  /* Main protein: the title first ("Pork Belly…"), then ingredients — ignoring
     stock / gravy, so chicken stock doesn't make a pork dish "chicken". */
  function mainProtein(m){
    const find = text => PROTEINS.find(([w]) => ` ${text} `.includes(` ${w}`))?.[1];
    const title = (m.title || "").toLowerCase().replace(/[^a-z ]/g, " ");
    const ings = (m.ingredients || []).map(i => ingredientKey(i.name)).filter(k => !/stock|gravy|bouillon/.test(k)).join(" | ");
    return find(title) || find(ings) || "veg";
  }
  /* Meals planned or shopped for in the 14 days before this week */
  function recentIds(dates){
    const start = new Date(dates[0]); start.setDate(start.getDate() - 14);
    const from = localISO(start), to = localISO(dates[0]);
    const out = new Set();
    for (const [day, items] of Object.entries(state.plan)) if (day >= from && day < to) items.forEach(e => out.add(e.mealId));
    for (const [id, h] of Object.entries(state.history)){
      const last = (h.dates || [])[h.dates.length - 1];
      if (last && last >= from) out.add(id);
    }
    return out;
  }
  function score(m, date, ctx){
    if (mealAvoided(m) || ctx.inWeek.has(m.id) || ctx.exclude?.has(m.id)) return -Infinity;
    let s = Math.random() * 2;                                  // a little variety
    if (m.fav) s += 3;
    const cs = cookStats(m.id);
    if (cs.avg != null) s += cs.avg - 3;                         // ★5 +2 … ★1 −2
    if (ctx.recent.has(m.id)) s -= 5;                            // had it lately
    const last = lastChosen(m.id);
    s += last ? Math.min((Date.now() - new Date(last)) / (14 * 864e5), 3) : 1.5;
    const dow = date.getDay();
    if (dow >= 1 && dow <= 4 && typeof m.cookMins === "number" && m.cookMins > 45) s -= 2;   // quick on weeknights
    const p = mainProtein(m);
    if (ctx.neighbourProteins?.includes(p) && p !== "veg") s -= 1.5;                       // vary proteins day to day
    return s;
  }
  function bestFor(date, ctx){
    let best = null, bestS = -Infinity;
    for (const m of state.meals){ const s = score(m, date, ctx); if (s > bestS){ best = m; bestS = s; } }
    return bestS === -Infinity ? null : best;
  }
  function weekContext(dates, skipIso, skipIdx){
    const inWeek = new Set();
    dates.forEach(d => planned(localISO(d)).forEach((e, i) => {
      if (!(localISO(d) === skipIso && i === skipIdx)) inWeek.add(e.mealId);
    }));
    return { inWeek, recent: recentIds(dates) };
  }
  function neighbours(dates, idx){
    return [dates[idx - 1], dates[idx + 1]].filter(Boolean)
      .flatMap(d => planned(localISO(d)).map(e => mealById(e.mealId))).filter(Boolean).map(mainProtein);
  }

  async function autoFill(){
    const dates = weekDates();
    const ctx = weekContext(dates);
    const before = JSON.stringify(state.plan);
    let added = 0;
    dates.forEach((d, idx) => {
      const iso = localISO(d);
      if (!(state.prefs.planDays || []).includes(d.getDay()) || planned(iso).length) return;
      const m = bestFor(d, { ...ctx, neighbourProteins: neighbours(dates, idx) });
      if (!m) return;
      setDay(iso, [{ mealId: m.id }]);
      ctx.inWeek.add(m.id);
      added++;
    });
    if (!added){ status("Nothing to fill — every cooking day already has a meal."); return; }
    await savePlan();
    renderPlan();
    showUndoToast(`Planned ${added} meal${added === 1 ? "" : "s"}`, async () => {
      state.plan = JSON.parse(before); await savePlan(); renderPlan();
    });
  }

  async function swap(iso, idx){
    const dates = weekDates();
    const d = dates.find(x => localISO(x) === iso) || new Date(iso + "T12:00:00");
    const key = `${iso}|${idx}`;
    const seen = swapSeen.get(key) || new Set();
    const cur = planned(iso)[idx];
    if (cur) seen.add(cur.mealId);
    const ctx = { ...weekContext(dates, iso, idx), exclude: seen, neighbourProteins: neighbours(dates, dates.indexOf(d)) };
    let m = bestFor(d, ctx);
    if (!m){ seen.clear(); if (cur) seen.add(cur.mealId); m = bestFor(d, { ...ctx, exclude: seen }); }   // cycled through everything: start again
    if (!m){ status("No other meals to swap in."); return; }
    seen.add(m.id);
    swapSeen.set(key, seen);
    const items = planned(iso).slice();
    items[idx] = { mealId: m.id };
    setDay(iso, items);
    await savePlan();
    renderPlan();
  }

  async function addToDay(iso, mealId){
    setDay(iso, [...planned(iso), { mealId }]);
    await savePlan();
    renderPlan();
  }
  async function removeFrom(iso, idx){
    const items = planned(iso).slice();
    const [gone] = items.splice(idx, 1);
    setDay(iso, items);
    await savePlan();
    renderPlan();
    showUndoToast(`Removed "${mealById(gone?.mealId)?.title || "meal"}"`, async () => {
      const back = planned(iso).slice(); back.splice(idx, 0, gone); setDay(iso, back); await savePlan(); renderPlan();
    });
  }
  async function toggleX2(iso, idx){
    const items = planned(iso).map(e => ({ ...e }));
    if (items[idx].x === 2) delete items[idx].x; else items[idx].x = 2;
    setDay(iso, items);
    await savePlan();
    renderPlan();
  }

  async function copyLastWeek(){
    const prev = weekDates(weekOffset - 1), cur = weekDates();
    const before = JSON.stringify(state.plan);
    let n = 0;
    cur.forEach((d, i) => {
      const from = planned(localISO(prev[i])), iso = localISO(d);
      if (from.length && !planned(iso).length){ setDay(iso, from.map(e => ({ ...e }))); n += from.length; }
    });
    if (!n){ status("Nothing to copy — last week was empty, or these days are already planned."); return; }
    await savePlan(); renderPlan();
    showUndoToast(`Copied ${n} meal${n === 1 ? "" : "s"} from last week`, async () => { state.plan = JSON.parse(before); await savePlan(); renderPlan(); });
  }
  async function clearWeek(){
    const before = JSON.stringify(state.plan);
    weekDates().forEach(d => delete state.plan[localISO(d)]);
    await savePlan(); renderPlan();
    showUndoToast("Week cleared", async () => { state.plan = JSON.parse(before); await savePlan(); renderPlan(); });
  }
  /* Put the week's meals on the shopping list (adds to what's already selected) */
  function shopWeek(){
    let n = 0;
    weekDates().forEach(d => planned(localISO(d)).forEach(e => {
      if (!mealById(e.mealId)) return;
      if (!state.selected.has(e.mealId)) n++;
      state.selected.add(e.mealId);
      if (e.x === 2) state.doubled.add(e.mealId);
    }));
    saveSession();
    renderMeals(); renderShopping();
    status(n ? `Added ${n} meal${n === 1 ? "" : "s"} to the shopping list` : "This week's meals are already on the shopping list.");
    if (n && isMobile()) setView("shopping");
  }

  /* ============== Render ============== */
  function mealRow(e, iso, idx){
    const m = mealById(e.mealId);
    if (!m) return "";
    return `<div class="plan-meal" data-iso="${iso}" data-idx="${idx}">
      <img alt="" data-img="${escapeHtml(m.id)}" />
      <button type="button" class="plan-title" data-open="${escapeHtml(m.id)}">${escapeHtml(m.title)}</button>
      <span class="plan-btns">
        <button type="button" class="chip x2 ${e.x === 2 ? "on" : ""}" data-act="x2" aria-pressed="${e.x === 2}" title="Cook once, eat twice">×2</button>
        <button type="button" class="btn mini" data-act="swap" title="Swap for another suggestion" aria-label="Swap">⇄</button>
        <button type="button" class="btn mini" data-act="remove" title="Remove" aria-label="Remove">✕</button>
      </span>
    </div>`;
  }
  function renderPlan(){
    const wrap = $("#plan-body");
    if (!wrap) return;
    const dates = weekDates();
    const today = localISO(new Date());
    const n = dates.reduce((s, d) => s + planned(localISO(d)).length, 0);
    $("#plan-week").textContent = weekOffset === 0 ? "This week" : weekOffset === 1 ? "Next week" : weekOffset === -1 ? "Last week"
      : `Week of ${dates[0].getDate()} ${dates[0].toLocaleDateString("en-GB", { month: "short" })}`;
    $("#plan-range").textContent = `${dayLabel(dates[0])} – ${dayLabel(dates[6])} · ${n} meal${n === 1 ? "" : "s"}`;
    $$("[data-cookday]").forEach(b => b.classList.toggle("on", (state.prefs.planDays || []).includes(Number(b.dataset.cookday))));
    wrap.innerHTML = dates.map(d => {
      const iso = localISO(d);
      const items = planned(iso);
      const cooking = (state.prefs.planDays || []).includes(d.getDay());
      return `<div class="plan-day ${iso === today ? "today" : ""} ${cooking ? "" : "off"}">
        <div class="plan-date">${dayLabel(d)}${iso === today ? ` <span class="chip">today</span>` : ""}</div>
        <div class="plan-items">${items.map((e, i) => mealRow(e, iso, i)).join("") || `<span class="muted small">${cooking ? "Nothing planned" : "Not cooking"}</span>`}</div>
        <button type="button" class="btn mini plan-add" data-add="${iso}" aria-label="Add a meal to ${dayLabel(d)}">＋</button>
      </div>`;
    }).join("");
    $$("img[data-img]", wrap).forEach(img => { img.src = gridImageSrc(mealById(img.dataset.img)); });
    $$("[data-open]", wrap).forEach(b => b.addEventListener("click", () => openMealView(b.dataset.open)));
    $$("[data-add]", wrap).forEach(b => b.addEventListener("click", () => openPicker(b.dataset.add)));
    $$(".plan-meal", wrap).forEach(row => {
      const iso = row.dataset.iso, idx = Number(row.dataset.idx);
      row.querySelector('[data-act="x2"]').addEventListener("click", () => toggleX2(iso, idx));
      row.querySelector('[data-act="swap"]').addEventListener("click", () => swap(iso, idx));
      row.querySelector('[data-act="remove"]').addEventListener("click", () => removeFrom(iso, idx));
    });
  }

  $("#plan-prev")?.addEventListener("click", () => { weekOffset--; swapSeen.clear(); renderPlan(); });
  $("#plan-next")?.addEventListener("click", () => { weekOffset++; swapSeen.clear(); renderPlan(); });
  $("#plan-today")?.addEventListener("click", () => { weekOffset = 0; renderPlan(); });
  $("#plan-autofill")?.addEventListener("click", autoFill);
  $("#plan-swipe")?.addEventListener("click", openSwiper);
  $("#plan-copy")?.addEventListener("click", copyLastWeek);
  $("#plan-shop")?.addEventListener("click", shopWeek);
  $("#plan-clear")?.addEventListener("click", clearWeek);
  $$("[data-cookday]").forEach(b => b.addEventListener("click", async () => {
    const d = Number(b.dataset.cookday);
    const days = new Set(state.prefs.planDays || []);
    if (days.has(d)) days.delete(d); else days.add(d);
    state.prefs.planDays = Array.from(days);
    renderPlan();
    await idbSet(IDB_KEYS.prefs, state.prefs);
  }));

  /* ============== Meal picker for a day ============== */
  const picker = $("#plan-picker");
  let pickIso = null;
  function openPicker(iso){
    pickIso = iso;
    $("#pp-title").textContent = `Add to ${dayLabel(new Date(iso + "T12:00:00"))}`;
    $("#pp-search").value = "";
    renderPicker();
    picker.classList.add("open");
    picker.setAttribute("aria-hidden", "false");
    lockBodyScroll(true);
    setTimeout(() => $("#pp-search")?.focus(), 50);
  }
  function closePicker(){
    picker.classList.remove("open");
    picker.setAttribute("aria-hidden", "true");
    lockBodyScroll(false);
  }
  function renderPicker(){
    const q = ($("#pp-search").value || "").trim().toLowerCase();
    const d = new Date(pickIso + "T12:00:00");
    const dates = weekDates();
    const ctx = weekContext(dates);
    const list = state.meals.filter(m => !mealAvoided(m))
      .filter(m => !q || m.title.toLowerCase().includes(q) || (m.ingredients || []).some(i => i.name.includes(q)))
      .map(m => ({ m, s: ctx.inWeek.has(m.id) ? -100 : score(m, d, { ...ctx, inWeek: new Set() }) }))
      .sort((a, b) => b.s - a.s);
    $("#pp-list").innerHTML = list.map(({ m }) => `
      <button type="button" class="pp-item" data-pick="${escapeHtml(m.id)}">
        <img alt="" data-img="${escapeHtml(m.id)}" />
        <span class="pp-name">${escapeHtml(m.title)}${ctx.inWeek.has(m.id) ? ` <span class="muted small">(already this week)</span>` : ""}</span>
        <span class="muted small">${typeof m.cookMins === "number" ? `⏱ ${m.cookMins}` : ""}${m.fav ? " ★" : ""}</span>
      </button>`).join("") || `<div class="empty">No meals match.</div>`;
    $$("img[data-img]", $("#pp-list")).forEach(img => { img.loading = "lazy"; img.src = gridImageSrc(mealById(img.dataset.img)); });
    $$("[data-pick]", $("#pp-list")).forEach(b => b.addEventListener("click", async () => { await addToDay(pickIso, b.dataset.pick); closePicker(); }));
  }
  $("#pp-search")?.addEventListener("input", renderPicker);
  $("#pp-close")?.addEventListener("click", closePicker);
  picker?.addEventListener("click", e => { if (e.target === picker) closePicker(); });

  /* ============== Swipe picker ============== */
  const swiper = $("#swipe-picker");
  let sw = null;   // { dates, ctx, skipped:Set, current }
  function nextEmptyDay(){
    return sw.dates.find(d => (state.prefs.planDays || []).includes(d.getDay()) && !planned(localISO(d)).length);
  }
  function openSwiper(){
    const dates = weekDates();
    sw = { dates, ctx: weekContext(dates), skipped: new Set(), current: null };
    swiper.classList.add("open");
    swiper.setAttribute("aria-hidden", "false");
    lockBodyScroll(true);
    nextCard();
  }
  function closeSwiper(){
    sw = null;
    swiper.classList.remove("open");
    swiper.setAttribute("aria-hidden", "true");
    lockBodyScroll(false);
    renderPlan();
  }
  function nextCard(){
    const day = nextEmptyDay();
    const card = $("#sw-card");
    if (!day){ $("#sw-day").textContent = "All cooking days are planned 🎉"; card.innerHTML = ""; $("#sw-actions").hidden = true; return; }
    const idx = sw.dates.indexOf(day);
    const m = bestFor(day, { ...sw.ctx, exclude: sw.skipped, neighbourProteins: neighbours(sw.dates, idx) });
    $("#sw-actions").hidden = !m;
    $("#sw-day").textContent = `For ${dayLabel(day)}`;
    if (!m){ card.innerHTML = `<div class="empty">You've seen every meal. Close, or skip fewer next time!</div>`; return; }
    sw.current = { m, day };
    card.style.transform = "";
    card.innerHTML = `<img alt="" />
      <div class="sw-info"><h3 class="h3">${escapeHtml(m.title)}</h3><div class="chips">${mealChips(m, { withDoubled: false })}</div></div>`;
    card.querySelector("img").src = m.image?.src || gridImageSrc(m);
  }
  async function swYes(){
    if (!sw?.current) return;
    const { m, day } = sw.current;
    setDay(localISO(day), [...planned(localISO(day)), { mealId: m.id }]);
    sw.ctx.inWeek.add(m.id);
    await savePlan();
    nextCard();
  }
  function swNo(){ if (!sw?.current) return; sw.skipped.add(sw.current.m.id); nextCard(); }
  $("#sw-yes")?.addEventListener("click", swYes);
  $("#sw-no")?.addEventListener("click", swNo);
  $("#sw-close")?.addEventListener("click", closeSwiper);
  (function swipeGestures(){
    const card = $("#sw-card");
    if (!card) return;
    let start = null;
    card.addEventListener("pointerdown", e => { start = { x: e.clientX, y: e.clientY }; try { card.setPointerCapture(e.pointerId); } catch { /* ok */ } });
    card.addEventListener("pointermove", e => {
      if (!start) return;
      const dx = e.clientX - start.x;
      card.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg)`;
    });
    card.addEventListener("pointerup", e => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      start = null;
      card.style.transform = "";
      if (Math.abs(dx) > 80 && Math.abs(dy) < 80){ if (dx > 0) swYes(); else swNo(); }
    });
  })();

  /* ============== What can I make? ============== */
  const wcim = $("#wcim");
  let haveEditor = null;
  function openWcim(){
    if (!haveEditor){
      haveEditor = tokenEditor($("#wcim-editor"), $("#wcim-input"), []);
      new MutationObserver(renderWcim).observe($("#wcim-editor"), { childList: true });
    }
    wcim.classList.add("open");
    wcim.setAttribute("aria-hidden", "false");
    lockBodyScroll(true);
    renderWcim();
    setTimeout(() => $("#wcim-input")?.focus(), 50);
  }
  function closeWcim(){
    wcim.classList.remove("open");
    wcim.setAttribute("aria-hidden", "true");
    lockBodyScroll(false);
  }
  function renderWcim(){
    const have = (haveEditor?.get() || []).map(ingredientKey).filter(Boolean);
    const useStaples = $("#wcim-staples")?.checked;
    const out = $("#wcim-list");
    if (!have.length){ out.innerHTML = `<div class="empty">Add a few ingredients you have — e.g. chicken thigh, rice, spring onion.</div>`; return; }
    const has = key => have.some(h => ` ${key} `.includes(` ${h} `) || ` ${h} `.includes(` ${key} `)) || (useStaples && state.pantry.has(key));
    // Rank by how much of the recipe you already have, then by how many of your ingredients it uses
    const rows = state.meals.filter(m => !mealAvoided(m)).map(m => {
      const keys = [...new Set((m.ingredients || []).map(i => ingredientKey(canonicalName(i.name))))];
      const missing = keys.filter(k => !has(k));
      return { m, used: keys.length - missing.length, missing, cover: keys.length ? (keys.length - missing.length) / keys.length : 0 };
    }).filter(r => r.used > 0)
      .sort((a, b) => b.cover - a.cover || b.used - a.used || a.missing.length - b.missing.length || (b.m.fav - a.m.fav));
    out.innerHTML = rows.slice(0, 30).map(r => `
      <button type="button" class="pp-item" data-open="${escapeHtml(r.m.id)}">
        <img alt="" data-img="${escapeHtml(r.m.id)}" />
        <span class="pp-name">${escapeHtml(r.m.title)}
          <span class="muted small wcim-miss">${r.missing.length ? `Missing ${r.missing.length}: ${escapeHtml(r.missing.slice(0, 6).join(", "))}${r.missing.length > 6 ? "…" : ""}` : "✓ You have everything"}</span>
        </span>
        <span class="chip ${r.missing.length ? "" : "chip-x2"}">${r.used}/${r.used + r.missing.length}</span>
      </button>`).join("") || `<div class="empty">No meals use those ingredients.</div>`;
    $$("img[data-img]", out).forEach(img => { img.loading = "lazy"; img.src = gridImageSrc(mealById(img.dataset.img)); });
    $$("[data-open]", out).forEach(b => b.addEventListener("click", () => { closeWcim(); openMealView(b.dataset.open); }));
  }
  $("#wcim-open")?.addEventListener("click", openWcim);
  $("#wcim-close")?.addEventListener("click", closeWcim);
  $("#wcim-staples")?.addEventListener("change", renderWcim);

  /* "📅 Add to plan" from a meal's ⋯ menu / meal page */
  function planMenuItems(mealId){
    const today = localISO(new Date());
    return weekDates(0).concat(weekDates(1)).filter(d => localISO(d) >= today).slice(0, 8).map(d => ({
      label: `📅 ${dayLabel(d)}${planned(localISO(d)).length ? " ·" : ""}`,
      run: async () => { await addToDay(localISO(d), mealId); status(`Planned for ${dayLabel(d)}`); }
    }));
  }

  // Escape closes the planner's sheets
  window.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (swiper?.classList.contains("open")) closeSwiper();
    else if (picker?.classList.contains("open")) closePicker();
    else if (wcim?.classList.contains("open")) closeWcim();
  });

  window.renderPlan = renderPlan;
  window.planMenuItems = planMenuItems;
  window.planHelpers = { weekDates, localISO, autoFill, swap, shopWeek, copyLastWeek, mainProtein, openWcim };

  function init(){ renderPlan(); }
  if (window.appReady) init();
  else document.addEventListener("app:ready", init, { once: true });
})();
