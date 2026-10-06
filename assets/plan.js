/* =====================================================
   Meal Planner — Planner (v15; pins, 7/14 days and calendar in v16)
   - Plan stored in state.plan { "YYYY-MM-DD": [{ mealId, x?, pin?, skipped? }] }
   - Pins: state.pins { weekday: [mealId] } — a meal on that weekday every week;
     removing it for one week leaves a "skipped" marker so it isn't re-added
   - 7 or 14 days, as a list or (tablet/desktop) a calendar grid
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
  const rawDay = iso => state.plan[iso] || [];
  const planned = iso => rawDay(iso).filter(e => !e.skipped);
  async function savePlan(){ await Promise.all([idbSet(IDB_KEYS.plan, state.plan), idbSet(IDB_KEYS.pins, state.pins)]); }
  /* Replace a day's visible meals, keeping its "skipped pin" markers */
  function setDay(iso, items){
    const tomb = rawDay(iso).filter(e => e.skipped && !items.some(i => i.mealId === e.mealId));
    const all = [...items, ...tomb];
    if (all.length) state.plan[iso] = all; else delete state.plan[iso];
  }
  /* The days on screen: 7 or 14 from Monday of the chosen week */
  function visibleDates(){
    const span = Number(state.prefs.planSpan) === 14 ? 14 : 7;
    return weekDates(weekOffset).concat(span === 14 ? weekDates(weekOffset + 1) : []);
  }

  /* ============== Pins: a meal on a weekday, every week ============== */
  const pinnedOn = wd => state.pins[String(wd)] || [];
  const isPinned = (id, wd) => pinnedOn(wd).includes(id);
  /* Put pinned meals onto today-or-later days that don't have them yet */
  function applyPins(dates){
    const today = localISO(new Date());
    let changed = false;
    for (const d of dates){
      const iso = localISO(d);
      if (iso < today || state.offDays[iso]) continue;  // never rewrite the past, or a not-cooking day
      for (const id of pinnedOn(d.getDay())){
        if (!mealById(id) || rawDay(iso).some(e => e.mealId === id)) continue;
        state.plan[iso] = [...rawDay(iso), { mealId: id, pin: true }];
        changed = true;
      }
    }
    return changed;
  }
  async function togglePin(iso, idx){
    const d = new Date(iso + "T12:00:00"), wd = String(d.getDay());
    const e = planned(iso)[idx];
    if (!e) return;
    const before = { plan: JSON.stringify(state.plan), pins: JSON.stringify(state.pins) };
    const title = mealById(e.mealId)?.title || "meal";
    if (isPinned(e.mealId, wd)){
      state.pins[wd] = pinnedOn(wd).filter(id => id !== e.mealId);
      if (!state.pins[wd].length) delete state.pins[wd];
      // drop the copies the pin put on later days (this one stays as a normal meal)
      const today = localISO(new Date());
      for (const [day, items] of Object.entries(state.plan)){
        if (day <= iso || day < today || new Date(day + "T12:00:00").getDay() !== d.getDay()) continue;
        const keep = items.filter(x => !(x.mealId === e.mealId && x.pin));
        if (keep.length) state.plan[day] = keep; else delete state.plan[day];
      }
      setDay(iso, planned(iso).map((x, i) => i === idx ? { mealId: x.mealId, ...(x.x === 2 ? { x: 2 } : {}) } : x));
      status(`Unpinned "${title}" from ${DAY[d.getDay()]}s`);
    } else {
      state.pins[wd] = [...pinnedOn(wd), e.mealId];
      setDay(iso, planned(iso).map((x, i) => i === idx ? { ...x, pin: true } : x));
      applyPins(visibleDates());
      showUndoToast(`Pinned "${title}" to every ${DAY[d.getDay()]}`, async () => {
        state.plan = JSON.parse(before.plan); state.pins = JSON.parse(before.pins); await savePlan(); renderPlan();
      });
    }
    await savePlan();
    renderPlan();
  }

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
    for (const [day, items] of Object.entries(state.plan)) if (day >= from && day < to) items.forEach(e => { if (!e.skipped) out.add(e.mealId); });
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
    const dates = visibleDates();
    applyPins(dates);
    const ctx = weekContext(dates);
    const before = JSON.stringify(state.plan);
    let added = 0;
    dates.forEach((d, idx) => {
      const iso = localISO(d);
      if (!(state.prefs.planDays || []).includes(d.getDay()) || planned(iso).length || state.offDays[iso]) return;
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
    const dates = visibleDates();
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
    if (items[idx]?.pin) items.push({ mealId: items[idx].mealId, pin: true, skipped: true });   // swapping a pinned meal skips it this week
    items[idx] = { mealId: m.id };
    setDay(iso, items);
    await savePlan();
    renderPlan();
  }

  /* "Suggest" on an empty day: the best meal for it, as auto-fill would choose */
  async function suggestFor(iso){
    const dates = visibleDates();
    const m = bestFor(new Date(iso + "T12:00:00"), weekContext(dates));
    if (!m){ status("No more meals to suggest — add some, or check the avoid list."); return; }
    await addToDay(iso, m.id);
    const el = $(`#plan-body [data-day="${iso}"]`);
    el?.classList.remove("flash"); void el?.offsetWidth; el?.classList.add("flash");
  }
  async function addToDay(iso, mealId){
    setDay(iso, [...planned(iso), { mealId }]);
    await savePlan();
    renderPlan();
  }
  async function removeFrom(iso, idx){
    const items = planned(iso).slice();
    const [gone] = items.splice(idx, 1);
    if (gone?.pin) items.push({ mealId: gone.mealId, pin: true, skipped: true });   // skip the pin this week only
    setDay(iso, items);
    await savePlan();
    renderPlan();
    const title = mealById(gone?.mealId)?.title || "meal";
    showUndoToast(gone?.pin ? `Skipped "${title}" this week (still pinned)` : `Removed "${title}"`, async () => {
      const back = planned(iso).slice(); back.splice(idx, 0, gone);
      state.plan[iso] = [...back, ...rawDay(iso).filter(x => x.skipped && x.mealId !== gone.mealId)];
      await savePlan(); renderPlan();
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
  /* Clears the visible days; pinned meals stay (unpin them to remove) */
  async function clearWeek(){
    const before = JSON.stringify(state.plan);
    visibleDates().forEach(d => {
      const iso = localISO(d);
      const keep = rawDay(iso).filter(e => e.pin);
      if (keep.length) state.plan[iso] = keep; else delete state.plan[iso];
    });
    await savePlan(); renderPlan();
    showUndoToast("Cleared (pinned meals kept)", async () => { state.plan = JSON.parse(before); await savePlan(); renderPlan(); });
  }
  /* Put the week's meals on the shopping list (adds to what's already selected) */
  function shopWeek(){
    let n = 0;
    visibleDates().forEach(d => planned(localISO(d)).forEach(e => {
      if (!mealById(e.mealId) || e.left) return;      // leftovers: nothing to buy
      if (!state.selected.has(e.mealId)) n++;
      state.selected.add(e.mealId);
      if (e.x === 2) state.doubled.add(e.mealId);
    }));
    saveSession();
    renderMeals(); renderShopping(); renderPlanSummary(visibleDates());
    status(n ? `Added ${n} meal${n === 1 ? "" : "s"} to the shopping list` : "These meals are already on the shopping list.");
    if (n && isMobile()) setView("shopping");
  }

  /* ============== Render ============== */
  function mealRow(e, iso, idx){
    const m = mealById(e.mealId);
    if (!m) return "";
    const wd = new Date(iso + "T12:00:00").getDay();
    const pinned = isPinned(m.id, wd);
    const pinLabel = `${pinned ? "Unpin from" : "Pin to every"} ${DAY[wd]}`;
    return `<div class="plan-meal" data-iso="${iso}" data-idx="${idx}">
      <img alt="" data-img="${escapeHtml(m.id)}" />
      <button type="button" class="plan-title" data-open="${escapeHtml(m.id)}">${e.left ? `<span class="muted">Leftovers:</span> ` : ""}${pinned ? icon("pin", 14, "pin-ic") : ""}${escapeHtml(m.title)}</button>
      <span class="plan-btns">
        <button type="button" class="btn mini chef-btn" data-act="chef" title="Who's cooking?" aria-label="Who's cooking?">${e.chef && chefById(e.chef) ? chefAvatar(chefById(e.chef), 22) : icon("user", 16)}</button>
        <button type="button" class="btn mini pin-btn ${pinned ? "on" : ""}" data-act="pin" aria-pressed="${pinned}" title="${pinLabel}" aria-label="${pinLabel}">${icon("pin", 16)}</button>
        <button type="button" class="chip x2 ${e.x === 2 ? "on" : ""}" data-act="x2" aria-pressed="${e.x === 2}" title="Cook once, eat twice">×2</button>
        <button type="button" class="btn mini" data-act="swap" title="Swap for another suggestion" aria-label="Swap">${icon("swap", 16)}</button>
        <button type="button" class="btn mini" data-act="remove" title="Remove" aria-label="Remove">${icon("x", 16)}</button>
      </span>
    </div>`;
  }
  /* Calendar cell item: compact; its actions are in a menu */
  /* Calendar cell item (v28): the photo fills the card, title over it; actions in a menu */
  function calItem(e, iso, idx){
    const m = mealById(e.mealId);
    if (!m) return "";
    const pinned = isPinned(m.id, new Date(iso + "T12:00:00").getDay());
    return `<button type="button" class="cal-item" data-iso="${iso}" data-idx="${idx}" title="${escapeHtml(m.title)}">
      <img alt="" draggable="false" data-img="${escapeHtml(m.id)}" />
      <span class="cal-title">${e.left ? "Leftovers: " : ""}${pinned ? icon("pin", 13, "pin-ic") : ""}${escapeHtml(m.title)}</span>
      ${e.x === 2 ? `<span class="chip chip-x2 cal-x2">×2</span>` : ""}
      ${e.chef && chefById(e.chef) ? `<span class="cal-chef">${chefAvatar(chefById(e.chef), 26)}</span>` : ""}
    </button>`;
  }
  /* Under the week: how many are planned, how many aren't on the list yet; tonight's meal */
  function renderPlanSummary(dates){
    const box = $("#plan-summary");
    if (!box) return;
    const ids = [];
    dates.forEach(d => planned(localISO(d)).forEach(e => { if (mealById(e.mealId) && !e.left) ids.push(e.mealId); }));
    const notListed = new Set(ids.filter(id => !state.selected.has(id))).size;
    box.hidden = !ids.length;
    $("#plan-sum-title").textContent = `${ids.length} meal${ids.length === 1 ? "" : "s"} planned`;
    $("#plan-sum-sub").textContent = notListed ? `${notListed} ${notListed === 1 ? "isn't" : "aren't"} on the shopping list yet` : "All on the shopping list";
    $("#plan-shop").disabled = !notListed;
    const t = $("#plan-tonight");
    const todayIso = localISO(new Date());
    const tonight = weekOffset === 0 ? planned(todayIso).map(e => mealById(e.mealId)).filter(Boolean)[0] : null;
    t.hidden = !tonight;
    if (!tonight) return;
    t.innerHTML = `<div class="h3">Tonight · ${new Date().toLocaleDateString("en-GB", { weekday: "long" })}</div>
      <div class="pt-row"><img alt="" /><div class="pt-text"><b>${escapeHtml(tonight.title)}</b>${typeof tonight.cookMins === "number" ? `<span class="muted small">${tonight.cookMins} min</span>` : ""}</div>
      <button type="button" class="btn primary" data-cook-tonight>${icon("play", 16)}Cook</button></div>`;
    t.querySelector("img").src = gridImageSrc(tonight);
    t.querySelector("[data-cook-tonight]").addEventListener("click", () => window.openGuided?.(tonight.id));
  }
  function calMenu(anchor, iso, idx){
    const e = planned(iso)[idx];
    const m = e && mealById(e.mealId);
    if (!m) return;
    const wd = new Date(iso + "T12:00:00").getDay();
    const pinned = isPinned(m.id, wd);
    openMenu(anchor, [
      { icon: "meals", label: "Open meal", run: () => openMealView(m.id) },
      { icon: "refresh", label: e.x === 2 ? "×2 off" : "×2 Cook once, eat twice", run: () => toggleX2(iso, idx) },
      { icon: "swap", label: "Swap", run: () => swap(iso, idx) },
      { icon: "user", label: e.chef && chefById(e.chef) ? `Cooking: ${chefById(e.chef).name} — change` : "Who's cooking?", run: () => chefMenu(anchor, iso, idx) },
      ...(e.x === 2 ? [{ icon: "plan", label: "Leftovers on another day…", run: () => leftoversMenu(anchor, iso, idx) }] : []),
      { icon: "pin", label: pinned ? `Unpin from ${DAY[wd]}s` : `Pin to every ${DAY[wd]}`, run: () => togglePin(iso, idx) },
      { icon: "x", label: e.pin ? "Skip this week" : "Remove", danger: true, run: () => removeFrom(iso, idx) }
    ]);
  }

  /* ============== Who's cooking (v29) ============== */
  function chefMenu(anchor, iso, idx){
    const e = planned(iso)[idx];
    if (!e) return;
    const pick = async (id) => { if (id) e.chef = id; else delete e.chef; await savePlan(); renderPlan(); };
    if (!state.chefs.length){
      openMenu(anchor, [{ icon: "user", label: "Add the people who cook…", run: () => { openSettings(); showSettingsTab("chefs"); } }]);
      return;
    }
    openMenu(anchor, [
      ...state.chefs.map(c => ({ icon: e.chef === c.id ? "check" : "user", label: c.name, run: () => pick(c.id) })),
      { icon: "x", label: "Nobody set", run: () => pick(null) }
    ]);
  }
  /* A ×2 meal's leftovers on a later day: no shopping, no cooking */
  function leftoversMenu(anchor, iso, idx){
    const e = planned(iso)[idx];
    const later = visibleDates().filter(d => localISO(d) > iso);
    if (!e || !later.length){ status("No later days in view."); return; }
    openMenu(anchor, later.map(d => ({ icon: "plan", label: dayLabel(d), run: async () => {
      const to = localISO(d);
      state.plan[to] = [...rawDay(to), { mealId: e.mealId, left: 1 }];
      delete state.offDays[to];
      await Promise.all([savePlan(), idbSet(IDB_KEYS.offDays, state.offDays)]);
      renderPlan();
      status(`Leftovers on ${dayLabel(d)}`);
    } })));
  }
  /* Not cooking on a day, and why */
  async function setOff(iso, why){
    if (why) state.offDays[iso] = why.slice(0, 60); else delete state.offDays[iso];
    await idbSet(IDB_KEYS.offDays, state.offDays);
    renderPlan();
  }
  function renderOffChips(){
    const wrap = $("#pp-off-chips");
    if (!wrap) return;
    const cur = state.offDays[pickIso];
    const dates = visibleDates();
    const x2s = [];
    dates.forEach(d => { const iso = localISO(d); if (iso < pickIso) planned(iso).forEach(e => { if (e.x === 2 && !e.left && mealById(e.mealId)) x2s.push(mealById(e.mealId)); }); });
    wrap.innerHTML = OFF_REASONS.map(r => `<button type="button" class="tchip ${cur === r ? "on" : ""}" data-off="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join("")
      + x2s.map(m => `<button type="button" class="tchip" data-left="${escapeHtml(m.id)}">Leftovers: ${escapeHtml(m.title.slice(0, 28))}</button>`).join("")
      + `<button type="button" class="tchip" data-off-own>Other…</button>`
      + (cur ? `<button type="button" class="tchip off-clear" data-off-clear>${icon("x", 14)}Cooking after all</button>` : "");
    $$("[data-off]", wrap).forEach(b => b.addEventListener("click", async () => { await setOff(pickIso, b.dataset.off); closePicker(); }));
    $$("[data-left]", wrap).forEach(b => b.addEventListener("click", async () => {
      state.plan[pickIso] = [...rawDay(pickIso), { mealId: b.dataset.left, left: 1 }];
      delete state.offDays[pickIso];
      await Promise.all([savePlan(), idbSet(IDB_KEYS.offDays, state.offDays)]);
      renderPlan(); closePicker();
    }));
    wrap.querySelector("[data-off-own]")?.addEventListener("click", async () => {
      const why = prompt("Why aren't you cooking? (e.g. Dinner at Mum's)", cur || "");
      if (why && why.trim()){ await setOff(pickIso, why.trim()); closePicker(); }
    });
    wrap.querySelector("[data-off-clear]")?.addEventListener("click", async () => { await setOff(pickIso, null); renderOffChips(); });
  }

  /* ============== Week strip (v18): a pill per day, tap to jump to it ============== */
  function renderPlanStrip(dates){
    const wrap = $("#plan-strip");
    if (!wrap) return;
    const today = localISO(new Date());
    wrap.innerHTML = dates.map(d => {
      const iso = localISO(d), items = planned(iso);
      const cooked = items.length && items.every(e => (state.cooklog[e.mealId] || []).some(c => c.date >= iso));
      return `<button type="button" class="day-pill ${iso === today ? "is-today" : ""} ${items.length ? "has" : ""} ${cooked ? "done" : ""} ${iso < today ? "past" : ""}"
        data-jump="${iso}" aria-label="${escapeHtml(dayLabel(d))}: ${items.length ? escapeHtml(items.map(e => mealById(e.mealId)?.title || "").join(", ")) : "nothing planned"}">
        <span class="dp-day">${DAY[d.getDay()].slice(0, 1)}</span><span class="dp-date">${d.getDate()}</span>
        <span class="dp-dot">${cooked ? icon("check", 12) : ""}</span>
      </button>`;
    }).join("");
    $$("[data-jump]", wrap).forEach(b => b.addEventListener("click", () => {
      const el = $(`#plan-body [data-day="${b.dataset.jump}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
      el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    }));
  }

  /* ============== Calendar drag & drop (v18) ==============
     Mouse/pen: drag a meal to another day. Touch: press and hold, then drag
     (a quick swipe still scrolls). A tap without dragging opens the menu. */
  async function moveMeal(fromIso, idx, toIso){
    if (fromIso === toIso) return;
    const items = planned(fromIso).slice();
    const [e] = items.splice(idx, 1);
    if (!e) return;
    const before = JSON.stringify(state.plan);
    if (e.pin) items.push({ mealId: e.mealId, pin: true, skipped: true });   // a pinned meal is skipped on its old day this week
    setDay(fromIso, items);
    setDay(toIso, [...planned(toIso), { mealId: e.mealId, ...(e.x === 2 ? { x: 2 } : {}) }]);
    await savePlan();
    renderPlan();
    haptic(15);
    showUndoToast(`Moved "${mealById(e.mealId)?.title || "meal"}" to ${dayLabel(new Date(toIso + "T12:00:00"))}`, async () => {
      state.plan = JSON.parse(before); await savePlan(); renderPlan();
    });
  }
  let drag = null;
  function attachCalDrag(item){
    item.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      drag = { item, id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType === "touch", armed: false, on: false, timer: null };
      // touch: a hold arms the drag (buzz + lift); the ghost appears on the first move
      if (drag.touch) drag.timer = setTimeout(() => { if (drag && drag.item === item){ drag.armed = true; item.classList.add("drag-armed"); haptic(10); } }, 320);
    });
    item.addEventListener("pointermove", (e) => {
      if (!drag || drag.item !== item || e.pointerId !== drag.id) return;
      const dist = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
      if (!drag.on){
        if (drag.touch && !drag.armed){ if (dist > 8){ clearTimeout(drag.timer); drag = null; } return; }   // a scroll
        if (dist > (drag.touch ? 4 : 6)) startDrag(e.clientX, e.clientY); else return;
      }
      try { item.setPointerCapture(e.pointerId); } catch { /* ok */ }
      moveGhost(e.clientX, e.clientY);
    });
    item.addEventListener("touchmove", (e) => { if (drag?.armed || drag?.on) e.preventDefault(); }, { passive: false });
    const end = async (e, cancelled) => {
      if (!drag || drag.item !== item) return;
      clearTimeout(drag.timer);
      const d = drag; drag = null;
      item.classList.remove("drag-armed");
      if (!d.on){
        // held, then let go without moving: treat it as a tap
        if (d.armed && !cancelled){ swallowClick(item); calMenu(item, item.dataset.iso, Number(item.dataset.idx)); }
        return;
      }
      d.ghost.remove();
      item.classList.remove("drag-src");
      $$(".cal-cell.drop").forEach(c => c.classList.remove("drop"));
      swallowClick(item);
      const cell = !cancelled && cellAt(e.clientX, e.clientY);
      if (cell) await moveMeal(item.dataset.iso, Number(item.dataset.idx), cell.dataset.day);
    };
    item.addEventListener("pointerup", e => end(e, false));
    item.addEventListener("pointercancel", e => end(e, true));
    item.addEventListener("contextmenu", e => { if (drag) e.preventDefault(); });
  }
  /* The click that follows a drag (or a handled hold) must not open the menu */
  function swallowClick(item){
    item.dataset.dragged = "1";
    setTimeout(() => delete item.dataset.dragged, 350);
  }
  function startDrag(x, y){
    if (!drag) return;
    drag.on = true;
    const r = drag.item.getBoundingClientRect();
    const g = drag.item.cloneNode(true);
    g.className = "cal-item drag-ghost";
    g.style.width = `${r.width}px`;
    drag.dx = x - r.left; drag.dy = y - r.top;
    document.body.appendChild(g);
    drag.ghost = g;
    drag.item.classList.add("drag-src");
    if (!drag.touch) haptic(10);
    moveGhost(x, y);
  }
  function cellAt(x, y){
    return document.elementFromPoint(x, y)?.closest("#plan-body .cal-cell[data-day]") || null;
  }
  function moveGhost(x, y){
    if (!drag?.ghost) return;
    drag.ghost.style.transform = `translate(${x - drag.dx}px, ${y - drag.dy}px) rotate(-2deg)`;
    const cell = cellAt(x, y);
    $$(".cal-cell.drop").forEach(c => { if (c !== cell) c.classList.remove("drop"); });
    if (cell && cell.dataset.day !== drag.item.dataset.iso) cell.classList.add("drop");
  }

  function renderPlan(){
    const wrap = $("#plan-body");
    if (!wrap) return;
    const dates = visibleDates();
    if (applyPins(dates)) savePlan();
    const today = localISO(new Date());
    const span = dates.length;
    const calendar = state.prefs.planLayout === "calendar" && !isMobile();
    const n = dates.reduce((s, d) => s + planned(localISO(d)).length, 0);
    const wk = weekOffset === 0 ? "This week" : weekOffset === 1 ? "Next week" : weekOffset === -1 ? "Last week"
      : `Week of ${dates[0].getDate()} ${dates[0].toLocaleDateString("en-GB", { month: "short" })}`;
    $("#plan-week").textContent = span === 14 ? `${wk} + next` : wk;
    $("#plan-range").textContent = `${dayLabel(dates[0])} – ${dayLabel(dates[span - 1])} · ${n} meal${n === 1 ? "" : "s"}`;
    $$("[data-cookday]").forEach(b => b.classList.toggle("on", (state.prefs.planDays || []).includes(Number(b.dataset.cookday))));
    $$("[data-span]").forEach(b => b.classList.toggle("on", Number(b.dataset.span) === span));
    $$("[data-layout]").forEach(b => b.classList.toggle("on", b.dataset.layout === (calendar ? "calendar" : "list")));
    wrap.classList.toggle("calendar", calendar);
    renderPlanStrip(dates);
    renderPlanSummary(dates);
    window.renderToday?.();   // cook.js

    if (calendar){
      const heads = dates.slice(0, 7).map(d => `<div class="cal-head ${localISO(d) === today ? "today" : ""}">${DAY[d.getDay()]} <b>${d.getDate()}</b></div>`).join("");
      wrap.innerHTML = heads + dates.map(d => {
        const iso = localISO(d);
        const cooking = (state.prefs.planDays || []).includes(d.getDay());
        const items = planned(iso);
        return `<div class="cal-cell ${iso === today ? "today" : ""} ${cooking ? "" : "off"} ${iso < today ? "past" : ""} ${items.length ? "" : "empty"}" data-day="${iso}">
          <div class="cal-date">${d.getDate()} <span class="muted small">${d.toLocaleDateString("en-GB", { month: "short" })}</span></div>
          ${items.map((e, i) => calItem(e, iso, i)).join("")}
          ${!items.length && state.offDays[iso] ? `<button type="button" class="cal-off cal-why" data-add="${iso}">${icon("moon2", 16)}<span>${escapeHtml(state.offDays[iso])}</span></button>` : ""}
          ${!items.length && !state.offDays[iso] && cooking && iso >= today ? `<button type="button" class="cal-suggest" data-suggest="${iso}">${icon("sparkles", 18)}<span>Suggest</span></button>` : ""}
          ${!items.length && !state.offDays[iso] && !cooking ? `<span class="cal-off muted small">Not cooking</span>` : ""}
          <button type="button" class="cal-add" data-add="${iso}" aria-label="Choose a meal for ${dayLabel(d)}">${icon("plus", 16)}</button>
        </div>`;
      }).join("");
      $$("img[data-img]", wrap).forEach(img => { img.src = gridImageSrc(mealById(img.dataset.img)); });
      $$("[data-add]", wrap).forEach(b => b.addEventListener("click", () => openPicker(b.dataset.add)));
      $$("[data-suggest]", wrap).forEach(b => b.addEventListener("click", () => suggestFor(b.dataset.suggest)));
      $$(".cal-item", wrap).forEach(b => {
        b.addEventListener("click", (ev) => { ev.stopPropagation(); if (b.dataset.dragged) return; calMenu(b, b.dataset.iso, Number(b.dataset.idx)); });
        attachCalDrag(b);
      });
      return;
    }

    wrap.innerHTML = dates.map(d => {
      const iso = localISO(d);
      const items = planned(iso);
      const cooking = (state.prefs.planDays || []).includes(d.getDay());
      return `<div class="plan-day ${iso === today ? "today" : ""} ${cooking ? "" : "off"}" data-day="${iso}">
        <div class="plan-date">${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}${iso === today ? ` <span class="chip">today</span>` : ""}</div>
        <div class="plan-items">${items.map((e, i) => mealRow(e, iso, i)).join("") || (state.offDays[iso] ? `<span class="plan-why">${icon("moon2", 14)}${escapeHtml(state.offDays[iso])}</span>` : `<span class="muted small">${cooking ? "Nothing planned" : "Not cooking"}</span>`)}</div>
        <button type="button" class="btn mini plan-add" data-add="${iso}" aria-label="Add a meal to ${dayLabel(d)}">${icon("plus", 18)}</button>
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
      row.querySelector('[data-act="pin"]').addEventListener("click", () => togglePin(iso, idx));
      row.querySelector('[data-act="chef"]').addEventListener("click", (ev) => chefMenu(ev.currentTarget, iso, idx));
    });
  }

  $("#plan-prev")?.addEventListener("click", () => { weekOffset--; swapSeen.clear(); renderPlan(); });
  $("#plan-next")?.addEventListener("click", () => { weekOffset++; swapSeen.clear(); renderPlan(); });
  $("#plan-today")?.addEventListener("click", () => { weekOffset = 0; renderPlan(); });
  $("#plan-autofill")?.addEventListener("click", autoFill);
  $("#plan-swipe")?.addEventListener("click", openSwiper);
  const closePlanMore = () => $(".plan-more")?.removeAttribute("open");
  $("#plan-copy")?.addEventListener("click", () => { closePlanMore(); copyLastWeek(); });
  $("#plan-shop")?.addEventListener("click", shopWeek);
  $("#plan-clear")?.addEventListener("click", () => { closePlanMore(); clearWeek(); });
  $$("[data-span]").forEach(b => b.addEventListener("click", async () => {
    state.prefs.planSpan = Number(b.dataset.span);
    renderPlan();
    await idbSet(IDB_KEYS.prefs, state.prefs);
  }));
  $$("[data-layout]").forEach(b => b.addEventListener("click", async () => {
    state.prefs.planLayout = b.dataset.layout;
    renderPlan();
    await idbSet(IDB_KEYS.prefs, state.prefs);
  }));
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
    $("#pp-off").hidden = planned(iso).length > 0;
    renderOffChips();
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
    const dates = visibleDates();
    const ctx = weekContext(dates);
    const list = state.meals.filter(m => !mealAvoided(m))
      .filter(m => !q || m.title.toLowerCase().includes(q) || (m.ingredients || []).some(i => i.name.includes(q)))
      .map(m => ({ m, s: ctx.inWeek.has(m.id) ? -100 : score(m, d, { ...ctx, inWeek: new Set() }) }))
      .sort((a, b) => b.s - a.s);
    $("#pp-list").innerHTML = list.map(({ m }) => `
      <button type="button" class="pp-item" data-pick="${escapeHtml(m.id)}">
        <img alt="" data-img="${escapeHtml(m.id)}" />
        <span class="pp-name">${escapeHtml(m.title)}${ctx.inWeek.has(m.id) ? ` <span class="muted small">(already this week)</span>` : ""}</span>
        <span class="muted small">${typeof m.cookMins === "number" ? `${icon("clock", 13)}${m.cookMins}` : ""}${m.fav ? " ★" : ""}</span>
      </button>`).join("") || `<div class="empty">No meals match.</div>`;
    $$("img[data-img]", $("#pp-list")).forEach(img => { img.loading = "lazy"; img.src = gridImageSrc(mealById(img.dataset.img)); });
    $$("[data-pick]", $("#pp-list")).forEach(b => b.addEventListener("click", async () => { delete state.offDays[pickIso]; idbSet(IDB_KEYS.offDays, state.offDays); await addToDay(pickIso, b.dataset.pick); closePicker(); }));
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
    const dates = visibleDates();
    if (applyPins(dates)) savePlan();
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
      icon: "plan", label: `${dayLabel(d)}${planned(localISO(d)).length ? " ·" : ""}`,
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
  window.planHelpers = { weekDates, visibleDates, localISO, autoFill, swap, shopWeek, copyLastWeek, mainProtein, openWcim, togglePin, removeFrom, clearWeek };

  function init(){ renderPlan(); }
  if (window.appReady) init();
  else document.addEventListener("app:ready", init, { once: true });
})();
