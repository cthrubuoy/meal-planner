/* =====================================================
   Meal Planner — Cook mode + Today (v13, Today v18)
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

  /* Amount text for one ingredient in the chosen units (factor 2 = double batch). */
  function ingAmount(i, mode = state.prefs.cookUnits, factor = 1){
    const v = (Number(i.amount) || 0) * factor;
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
      out.push({ label, secs: Math.round(lo * mult), at: m.index });
    }
    return out;
  }

  /* v28: a timer is named after what it's timing — "Rice simmer", "Chicken bake" —
     from the ingredient mentioned nearest before the time, and the cooking verb. */
  const TIMER_VERB_RE = /\b(simmer|boil|bake|roast|fry|sear|grill|steam|rest|marinate|reduce|toast|soften|brown|blanch|poach|chill|stew|braise|cook|leave)/gi;
  const MEAT_WORDS = new Set(["chicken", "beef", "pork", "lamb", "turkey", "duck", "salmon", "cod", "fish", "prawn"]);
  function timerName(meal, text, t, step){
    const lower = stepWords(String(text).slice(0, t.at ?? String(text).length));      // the words before the time
    const sentence = stepWords(String(text).slice(0, t.at ?? String(text).length).split(/[.;!?]\s/).pop());
    const whole = stepWords(text);                                                   // …and after it, as a last resort
    const where = word => { const k = lower.lastIndexOf(` ${word} `); return k >= 0 ? k + 1000 + (sentence.includes(` ${word} `) ? 1e5 : 0) : whole.includes(` ${word} `) ? 1 : -1; };
    let name = "", best = -1;
    const used = new Set(ingredientsInStep(meal, text));
    for (const ing of meal.ingredients || []){
      const w = ingredientKey(ing.name).split(" ");
      const head = w[w.length - 1];
      let label = head, pos = where(head);
      if (CUTS.has(head)){                                   // "pork loin steak": the meat if it's named, else the cut
        const meat = w.find(x => MEAT_WORDS.has(x));
        const pm = meat ? where(meat) : -1;
        if (pm >= 0 || pos < 0){ label = meat || w[0]; pos = Math.max(pm, pos); }
      } else if (GENERIC_HEADS.has(head) && w.length > 1){   // "soy sauce", "chicken stock": keep the phrase
        const phrase = w.slice(-2).join(" ");
        if (whole.includes(` ${phrase} `)){ label = phrase; pos = Math.max(pos, where(w[w.length - 2])); }
      }
      if (pos < 0) continue;
      // the main thing being cooked wins over seasonings: meat/fish, then rice/pasta, then veg
      const rank = { "Meat & fish": 4, "Pasta, rice & grains": 3, "Fruit & veg": 2, "Dairy, eggs & chilled": 2, "Bakery": 1 }[shopCategory(ing.name)] || 0;
      const score = rank * 1e6 + pos + (used.has(ing) ? 5e4 : 0);
      if (score > best){ best = score; name = label; }
    }
    // "put the dish in the oven for 30 min (until the cheese melts)": the oven, not what's named after the time
    if ((!name || best % 1e6 < 1000) && / (oven|grill) /.test(sentence)) name = / grill /.test(sentence) ? "grill" : "oven";
    let verb = "";
    for (const m of sentence.matchAll(TIMER_VERB_RE)) verb = m[1].toLowerCase();
    if (verb === "leave" || verb === "cook" || name === verb) verb = !name && verb === "cook" ? "cook" : "";
    const short = name ? titleCase(name) : verb ? titleCase(verb) : `Step ${step}`;
    const full = name && verb && name !== "oven" && name !== "grill" ? `${titleCase(name)} ${verb}` : short;
    return { short, full };
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
  /* ============== This week's menu (from the planner) ==============
     The Cook tab starts from the week's plan: Mon–Sun in order, today first in
     focus, pinned meals included, ✓ once cooked (cook log on/after that day). */
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  function thisWeekMenu(){
    const now = new Date(); now.setHours(12, 0, 0, 0);
    const today = isoOf(now);
    const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const out = [];
    for (let i = 0; i < 7; i++){
      const d = new Date(monday); d.setDate(monday.getDate() + i);
      const iso = isoOf(d);
      const raw = state.plan[iso] || [];
      const entries = raw.filter(e => !e.skipped);
      // pinned meals the planner hasn't written onto this day yet
      if (iso >= today) for (const id of (state.pins?.[String(d.getDay())] || [])){
        if (!raw.some(e => e.mealId === id)) entries.push({ mealId: id, pin: true });
      }
      for (const e of entries){
        const m = mealById(e.mealId);
        if (!m) continue;
        const cooked = (state.cooklog[m.id] || []).some(c => c.date >= iso);
        out.push({ iso, m, x: e.x || 1, pin: !!e.pin, left: !!e.left, chef: e.chef ? chefById(e.chef) : null, isToday: iso === today, past: iso < today, cooked,
          label: iso === today ? "Today" : `${DAYS[d.getDay()]} ${d.getDate()}` });
      }
    }
    return out;
  }
  /* What to show first: today's uncooked meal, else the next uncooked one, else
     anything uncooked from earlier this week, else the first shopped-for meal */
  function suggestedCookId(menu = thisWeekMenu()){
    const open = menu.filter(r => !r.cooked);
    return (open.find(r => r.isToday) || open.find(r => !r.past) || open[0])?.m.id
      || state.cookQueue.find(q => mealById(q.mealId))?.mealId || null;
  }

  let userPicked = false;   // once you choose from the list, leave your choice alone
  function populateCookSelect(){
    const dd = $("#cook-meal");
    if (!dd) return;
    const menu = thisWeekMenu();
    const suggested = suggestedCookId(menu);
    const keep = userPicked ? dd.value : (suggested || dd.value || store.get(LAST_KEY));
    const weekOpts = menu.map(r => `<option value="${escapeHtml(r.m.id)}">${escapeHtml(r.label)} · ${escapeHtml(r.m.title)}${r.cooked ? " ✓" : ""}</option>`).join("");
    const allOpts = state.meals.slice()
      .sort((a, b) => (a.title || "").localeCompare(b.title || "", "en-GB", { sensitivity:"base" }))
      .map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.title)}</option>`).join("");
    dd.innerHTML = (weekOpts ? `<optgroup label="This week's menu">${weekOpts}</optgroup><optgroup label="All meals">${allOpts}</optgroup>` : allOpts);
    if (keep && state.meals.some(m => m.id === keep)) dd.value = keep;
    renderCookTab();
  }

  function cookCard(m, { day = "", isToday = false, cooked = false, x = 1, pin = false, dismiss = false } = {}){
    const steps = (m.steps || []).length;
    return `<div class="queue-card ${isToday ? "today" : ""} ${cooked ? "cooked" : ""}" data-id="${escapeHtml(m.id)}" data-x="${x}">
      ${day ? `<div class="queue-day">${escapeHtml(day)}</div>` : ""}
      <img alt="" loading="lazy" />
      <div class="queue-body">
        <button class="queue-title" data-show="${escapeHtml(m.id)}">${pin ? icon("pin", 14, "pin-ic") : ""}${escapeHtml(m.title)}</button>
        <div class="chips">
          ${cooked ? `<span class="chip chip-x2">${icon("check", 13)}Cooked</span>` : ""}
          ${typeof m.cookMins === "number" ? `<span class="chip">${icon("clock", 13)}${m.cookMins} min</span>` : ""}
          <span class="chip">${steps ? `${icon("steps", 13)}${plural(steps, "step")}` : "no steps yet"}</span>
          ${x > 1 ? `<span class="chip chip-x2">×2 · leftovers</span>` : ""}
        </div>
      </div>
      <button class="btn ${cooked ? "" : "primary"}" data-cook="${escapeHtml(m.id)}">${icon("play", 14)}Cook</button>
      ${dismiss ? `<button class="btn mini" data-dismiss="${escapeHtml(m.id)}" title="Remove from this week" aria-label="Remove ${escapeHtml(m.title)} from this week">${icon("x", 16)}</button>` : ""}
    </div>`;
  }

  function renderQueue(){
    const wrap = $("#cook-queue");
    if (!wrap) return;
    const menu = thisWeekMenu();
    const planned = new Set(menu.map(r => r.m.id));
    const extra = state.cookQueue.map(q => ({ q, m: mealById(q.mealId) })).filter(x => x.m && !planned.has(x.m.id));
    if (!menu.length && !extra.length){
      wrap.innerHTML = `<div class="empty">Nothing planned this week yet.
        <br><button type="button" class="btn mini mt8" id="cook-go-plan">${icon("plan", 16)}Plan the week</button>
        <br><span class="small">Meals you shop for also appear here.</span></div>`;
      $("#cook-go-plan", wrap)?.addEventListener("click", () => setView("plan"));
      return;
    }
    wrap.innerHTML =
      (menu.length ? `<h4 class="h4 queue-head">This week's menu</h4>` + menu.map(r => cookCard(r.m, { day: r.label, isToday: r.isToday, cooked: r.cooked, x: r.x, pin: r.pin })).join("") : "")
      + (extra.length ? `<h4 class="h4 queue-head">${menu.length ? "Also bought this week" : "Bought this week"}</h4>` + extra.map(({ q, m }) => cookCard(m, { x: q.x || 1, dismiss: true })).join("") : "");
    // images set directly (large data URLs stay out of the HTML string); grid thumbnail if there is one
    $$(".queue-card", wrap).forEach(card => {
      const m = mealById(card.dataset.id);
      card.querySelector("img").src = window.gridImageSrc ? gridImageSrc(m) : (m.image?.src || placeholderSvg(m.title));
    });
    $$("[data-cook]", wrap).forEach(b => b.addEventListener("click", () => {
      openGuided(b.dataset.cook, Number(b.closest(".queue-card")?.dataset.x) || undefined);
    }));
    $$("[data-show]", wrap).forEach(b => b.addEventListener("click", () => {
      userPicked = true;
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
    return `<p class="last-cook">${icon("cook", 15)}Cooked ${plural(count, "time")}${avg != null ? ` (avg ★${formatNumber(Math.round(avg * 10) / 10)})` : ""}. Last: ${escapeHtml(formatShortDate(last.date))}${stars}${note}</p>`;
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
        ${typeof meal.cookMins === "number" ? `${icon("clock", 15)}${meal.cookMins} min · ` : ""}${plural(ings.length, "ingredient")} · ${plural(steps.length, "step")}
      </div>
      ${lastCookLine(meal.id)}
      ${meal.notes ? `<p class="muted small">${escapeHtml(meal.notes)}</p>` : ""}
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
                 <button class="btn" id="ov-scan">${icon("camera", 18)}Scan back of card</button>
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

  /* ============== Today (v18): tonight's meal, the week, the list ============== */
  function weekDays(){
    const now = new Date(); now.setHours(12, 0, 0, 0);
    const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
  }
  function renderTodayHero(menu){
    const wrap = $("#today-hero");
    if (!wrap) return;
    const open = menu.filter(r => !r.cooked);
    const row = open.find(r => r.isToday) || open.find(r => !r.past);
    const offToday = state.offDays[isoOf(new Date())];
    if (!row || (offToday && !row.isToday)){
      const greeting = menu.some(r => r.isToday && r.cooked) ? "Tonight's meal is cooked." : offToday ? `Not cooking tonight: ${offToday}` : "Nothing planned for tonight.";
      wrap.className = "today-hero empty-hero";
      wrap.innerHTML = `<div class="today-hero-empty">
          <span class="today-kicker">Tonight</span>
          <h2 class="today-title">${greeting}</h2>
          <div class="group">
            <button type="button" class="btn primary" data-go="plan">${icon("sparkles", 18)}Plan the week</button>
            <button type="button" class="btn" data-go="meals">${icon("meals", 18)}Browse meals</button>
          </div>
        </div>`;
      $$("[data-go]", wrap).forEach(b => b.addEventListener("click", () => switchView(b.dataset.go)));
      return;
    }
    const m = row.m, steps = (m.steps || []).length, cs = cookStats(m.id);
    const meta = [
      typeof m.cookMins === "number" ? `${icon("clock", 15)}${m.cookMins} min` : "",
      steps ? `${icon("steps", 15)}${plural(steps, "step")}` : "",
      cs.avg != null ? `${icon("star-filled", 15, "gold")}${formatNumber(Math.round(cs.avg * 10) / 10)}` : "",
      row.x > 1 ? "×2 · leftovers" : ""
    ].filter(Boolean).map(s => `<span>${s}</span>`).join("");
    wrap.className = "today-hero";
    wrap.innerHTML = `
      <img alt="" />
      <div class="scrim"></div>
      <div class="today-hero-text">
        <span class="today-kicker">${row.isToday ? "Tonight" : `Next up · ${escapeHtml(row.label)}`}${row.left ? " · leftovers" : ""}</span>
        ${row.chef ? `<span class="today-chef">${chefAvatar(row.chef, 34)}${escapeHtml(row.chef.name)} is cooking</span>` : ""}
        <h2 class="today-title">${escapeHtml(m.title)}</h2>
        ${meta ? `<div class="mag-meta">${meta}</div>` : ""}
        <div class="group today-hero-btns">
          <button type="button" class="btn primary" data-hero-cook>${icon("play", 16)}Cook</button>
          <button type="button" class="btn glass" data-hero-open>Open meal</button>
        </div>
      </div>`;
    wrap.querySelector("img").src = m.image?.src || placeholderSvg(m.title);
    $("[data-hero-cook]", wrap).addEventListener("click", () => openGuided(m.id, row.x > 1 ? row.x : undefined));
    $("[data-hero-open]", wrap).addEventListener("click", () => openMealView(m.id));
  }
  function renderTodayStrip(menu){
    const wrap = $("#today-strip");
    if (!wrap) return;
    const todayIso = isoOf(new Date());
    wrap.innerHTML = weekDays().map(d => {
      const iso = isoOf(d);
      const rows = menu.filter(r => r.iso === iso);
      const cooked = rows.length && rows.every(r => r.cooked);
      const title = rows.map(r => r.m.title).join(", ");
      const why = !rows.length && state.offDays[iso];
      return `<button type="button" class="day-pill ${iso === todayIso ? "is-today" : ""} ${rows.length ? "has" : ""} ${cooked ? "done" : ""} ${iso < todayIso ? "past" : ""} ${why ? "off-why" : ""}"
        data-iso="${iso}" title="${escapeHtml(title || why || "Nothing planned")}" aria-label="${DAYS[d.getDay()]} ${d.getDate()}: ${escapeHtml(title || "nothing planned")}">
        <span class="dp-day">${DAYS[d.getDay()].slice(0, 1)}</span><span class="dp-date">${d.getDate()}</span>
        <span class="dp-dot">${cooked ? icon("check", 12) : ""}</span>
      </button>`;
    }).join("");
    $$(".day-pill", wrap).forEach(b => b.addEventListener("click", () => {
      const rows = menu.filter(r => r.iso === b.dataset.iso);
      if (rows.length === 1) openMealView(rows[0].m.id);
      else switchView("plan");
    }));
    const planned = menu.length, cookedN = menu.filter(r => r.cooked).length;
    const sub = $("#today-strip-sub") || Object.assign(document.createElement("p"), { id: "today-strip-sub", className: "muted small" });
    sub.textContent = planned ? `${plural(planned, "meal")} planned · ${cookedN} cooked` : "Nothing planned yet — tap Plan to fill the week.";
    wrap.after(sub);
  }
  function renderTodayShop(){
    const wrap = $("#today-shop");
    if (!wrap) return;
    const meals = state.selected.size;
    const toBuy = typeof rowsToBuy === "function" ? rowsToBuy().length : 0;
    const got = state.haveIt.size;
    wrap.innerHTML = meals
      ? `<div class="today-card-head"><h3 class="h3">Shopping list</h3></div>
         <div class="today-shop-num"><b>${toBuy}</b> item${toBuy === 1 ? "" : "s"} to buy</div>
         <p class="muted small">${plural(meals, "meal")} ticked${got ? ` · ${got} got` : ""}</p>
         <div class="group">
           <button type="button" class="btn" data-shop-open>${icon("cart", 18)}Open list</button>
           <button type="button" class="btn" data-shop-ocado>Ocado</button>
         </div>`
      : `<div class="today-card-head"><h3 class="h3">Shopping list</h3></div>
         <p class="muted small">No meals ticked for this shop yet.</p>
         <div class="group">
           <button type="button" class="btn" data-shop-plan>${icon("cart", 18)}From the plan</button>
           <button type="button" class="btn" data-go-meals>${icon("meals", 18)}Choose meals</button>
         </div>`;
    $("[data-shop-open]", wrap)?.addEventListener("click", () => {
      if (isMobile()) switchView("shopping");
      else $("#shop-panel")?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    });
    $("[data-shop-ocado]", wrap)?.addEventListener("click", () => $("#ocado")?.click());
    $("[data-shop-plan]", wrap)?.addEventListener("click", () => $("#plan-shop")?.click());
    $("[data-go-meals]", wrap)?.addEventListener("click", () => switchView("meals"));
  }
  function renderToday(){
    const td = $("#today-date");
    if (td) td.textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    const menu = thisWeekMenu();
    renderTodayHero(menu);
    renderTodayStrip(menu);
    renderTodayShop();
  }
  $("#today-to-plan")?.addEventListener("click", () => switchView("plan"));

  function renderCookTab(){
    renderToday();
    renderQueue();
    renderOverview();
    syncUnitsUI();
  }

  $("#cook-meal")?.addEventListener("change", () => { userPicked = true; renderOverview(); });
  $("#cook-start")?.addEventListener("click", () => {
    const id = $("#cook-meal")?.value;
    if (!id) return;
    const r = thisWeekMenu().find(x => x.m.id === id && !x.cooked);
    openGuided(id, r?.x > 1 ? r.x : undefined);
  });

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

  function openGuided(id, batch){
    const meal = mealById(id);
    if (!meal) return;
    // "Cook once, eat twice": ×2 from the week's menu / queue entry, or a doubled meal in the current shop
    const q = state.cookQueue.find(e => e.mealId === id);
    const factor = batch || q?.x || (state.selected.has(id) && state.doubled.has(id) ? 2 : 1);
    guided = { id, page: 0, gathered: new Set(), extrasDone: new Set(), rating: 0, note: "", factor, by: plannedChef(id)?.id || null };
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
    populateCookSelect();   // moves the suggestion on to the next meal once one is cooked
  }

  function ingredientChecklist(meal){
    return `<ul class="co-checklist">${(meal.ingredients || []).map((i, idx) => `
      <li><label><input type="checkbox" data-gather="${idx}" ${guided.gathered.has(idx) ? "checked" : ""}/>
        <span class="co-ing-name">${escapeHtml(titleCase(i.name))}</span>
        <span class="co-ing-amt">${escapeHtml(ingAmount(i, undefined, guided.factor))}</span></label></li>`).join("")}${extrasItems(meal, true)}</ul>`;
  }
  /* "You usually add" (v24): not in the recipe, but whoever's cooking usually adds
     it — sometimes it needs prep, so it's shown early and can be ticked off. */
  function extrasItems(meal, tagged){
    return (meal.extras || []).map((i, idx) => `
      <li><label><input type="checkbox" data-extra="${idx}" ${guided.extrasDone.has(idx) ? "checked" : ""}/>
        <span class="co-ing-name">${escapeHtml(titleCase(i.name))}${tagged ? ` <span class="co-extra-tag">extra</span>` : ""}</span>
        <span class="co-ing-amt">${escapeHtml(ingAmount(i, undefined, guided.factor))}</span></label></li>`).join("");
  }
  function extrasCard(meal){
    if (!(meal.extras || []).length) return "";
    return `<div class="co-extras"><div class="co-extras-head">You usually add</div><ul class="co-checklist">${extrasItems(meal, false)}</ul>
      <div class="muted small">Not in the recipe — get these ready too. Tick them off when they're done.</div></div>`;
  }
  /* On the steps: a small reminder until every extra is ticked */
  function extrasReminder(meal){
    const ex = meal.extras || [];
    const left = ex.map((i, idx) => ({ i, idx })).filter(x => !guided.extrasDone.has(x.idx));
    if (!left.length) return "";
    return `<div class="co-extra-reminder">${icon("info", 16)}<span>You usually add:</span>${left.map(x => `<label class="co-extra-chip"><input type="checkbox" data-extra="${x.idx}"/>${escapeHtml(titleCase(x.i.name))}</label>`).join("")}</div>`;
  }

  /* v19: the steps around the current one — the previous step above it, up next below.
     Tap any of them to jump there. Per device: prefs.cookContext (on unless false). */
  const contextOn = () => state.prefs.cookContext !== false;
  function stepPreview(meal, n, cls = ""){   // n = step number = page index
    const text = meal.steps[n - 1] || "";
    const marks = (parseDurations(text).length ? icon("timer", 14) : "") + (ovenTemps([text]).length ? icon("cook", 14) : "");
    return `<button type="button" class="co-preview ${cls}" data-goto="${n}" aria-label="Go to step ${n}">
      <span class="co-pnum">${n}</span><span class="co-ptext">${escapeHtml(text)}</span>${marks ? `<span class="co-pmarks">${marks}</span>` : ""}
    </button>`;
  }
  function upNext(meal, p, count = 3){
    const steps = meal.steps || [];
    const items = [];
    for (let n = p + 1; n <= Math.min(steps.length, p + count); n++) items.push(stepPreview(meal, n));
    if (p + count >= steps.length) items.push(`<button type="button" class="co-preview co-finish" data-goto="${steps.length + 1}">${icon("check", 16)}<span class="co-ptext">Then: rate &amp; mark as cooked</span></button>`);
    return `<div class="co-upnext"><div class="co-upnext-head">${p === 0 ? "First up" : "Up next"}</div><div class="co-next-list">${items.join("")}</div></div>`;
  }
  function syncContextBtn(){
    const b = $("#co-context");
    if (!b) return;
    b.setAttribute("aria-pressed", String(contextOn()));
    b.classList.toggle("on", contextOn());
  }

  function renderGuided(){
    const meal = mealById(guided?.id);
    if (!meal){ closeGuided(); return; }
    const steps = meal.steps || [];
    const total = pageCount(meal);
    const p = guided.page;

    $("#co-title").textContent = meal.title;
    $("#co-progress-label").textContent =
      (p === 0 ? "Get ready" : p === total - 1 ? "Done" : `Step ${p} of ${steps.length}`) + (guided.factor > 1 ? " · ×2 batch" : "");
    $("#co-progress-bar").style.width = `${Math.round((p / (total - 1)) * 100)}%`;
    syncContextBtn();
    $("#co-ings").innerHTML = `<h4 class="h4">Ingredients</h4>${ingredientChecklist(meal)}`;

    let html;
    if (p === 0){
      const temps = ovenTemps(steps);
      html = `
        <div class="co-kicker">Get ready</div>
        ${guided.factor > 1 ? `<p class="co-double">×2 — double batch for leftovers. Ingredient amounts are doubled; the step text is as written.</p>` : ""}
        ${extrasCard(meal)}
        ${lastCookLine(meal.id)}
        ${temps.length ? `<p class="co-temps">Oven: ${temps.map(t => annotateStep(t)).join(" · ")}</p>` : ""}
        ${meal.notes ? `<p class="muted">${escapeHtml(meal.notes)}</p>` : ""}
        ${steps.length && contextOn() ? upNext(meal, 0, 2) : ""}
        ${steps.length ? `<p class="muted co-hint">Gather your ingredients, then tap Next. Swipe or use ‹ › to move between steps.</p>`
                       : `<div class="no-steps"><p>No steps saved for this meal — use it as an ingredients checklist, or add steps:</p>
                          <button class="btn" id="co-scan">${icon("camera", 18)}Scan back of card</button></div>`}
        <div class="co-inline-ings">${ingredientChecklist(meal)}</div>`;
    } else if (p === total - 1){
      html = `
        <div class="co-kicker">All done 🎉</div>
        <p>How was it?</p>
        <div class="co-stars" role="radiogroup" aria-label="Rating">
          ${[1, 2, 3, 4, 5].map(n => `<button class="co-star ${n <= guided.rating ? "on" : ""}" data-star="${n}" role="radio" aria-checked="${n === guided.rating}" aria-label="${n} star${n === 1 ? "" : "s"}">★</button>`).join("")}
        </div>
        ${state.chefs.length ? `<div class="co-who"><span class="muted">Who cooked?</span>${state.chefs.map(c => `<button type="button" class="tchip ${guided.by === c.id ? "on" : ""}" data-by="${escapeHtml(c.id)}">${chefAvatar(c, 22)}${escapeHtml(c.name)}</button>`).join("")}</div>` : ""}
        <label for="co-note" class="mt8">Note for next time (optional)</label>
        <textarea id="co-note" rows="2" placeholder="e.g. needed more salt, double the sauce">${escapeHtml(guided.note)}</textarea>
        <div class="group mt8">
          <button class="btn primary" id="co-done">${icon("check", 18)}Mark as cooked</button>
          <button class="btn" id="co-skip">Close without logging</button>
        </div>`;
    } else {
      const text = steps[p - 1];
      const used = ingredientsInStep(meal, text);
      const timers = parseDurations(text);
      html = `
        ${extrasReminder(meal)}
        ${contextOn() && p > 1 ? stepPreview(meal, p - 1, "co-prev-step") : ""}
        <div class="co-stepnum co-kicker"><span class="co-num">${p}</span><span class="co-of">of ${steps.length} · ${escapeHtml(meal.title)}</span></div>
        <p class="co-step">${annotateStep(text)}</p>
        ${used.length ? `<div class="co-chips">${used.map(i => { const a = ingAmount(i, undefined, guided.factor); return `<span class="chip co-chip">${escapeHtml(titleCase(i.name))}${a ? ` · <b>${escapeHtml(a)}</b>` : ""}</span>`; }).join("")}</div>` : ""}
        ${timers.map((t, k) => timerCard(meal, text, t, p, k)).join("")}
        ${contextOn() ? upNext(meal, p) : ""}`;
    }
    const page = $("#co-page");
    page.innerHTML = html;
    page.scrollTop = 0;

    $("#co-prev").disabled = p === 0;
    $("#co-next").hidden = p === total - 1;
    $("#co-next").textContent = p === total - 2 ? "Finish ›" : "Next ›";

    // wiring for this page
    $$("[data-extra]", overlay).forEach(cb => cb.addEventListener("change", () => {
      const idx = Number(cb.dataset.extra);
      if (cb.checked) guided.extrasDone.add(idx); else guided.extrasDone.delete(idx);
      $$(`[data-extra="${idx}"]`, overlay).forEach(o => { o.checked = cb.checked; });
      if (cb.closest(".co-extra-reminder")) renderGuided();     // ticked from the reminder: tidy it away
    }));
    $$("[data-gather]", overlay).forEach(cb => cb.addEventListener("change", () => {
      const idx = Number(cb.dataset.gather);
      if (cb.checked) guided.gathered.add(idx); else guided.gathered.delete(idx);
      $$(`[data-gather="${idx}"]`, overlay).forEach(o => { o.checked = cb.checked; });
    }));
    $("#co-scan")?.addEventListener("click", () => { const id = guided.id; closeGuided(); scanStepsFor(id); });
    $$("[data-goto]", page).forEach(b => b.addEventListener("click", () => goTo(Number(b.dataset.goto))));
    $$(".co-timer", page).forEach(b => b.addEventListener("click", () => {
      const card = b.closest(".co-tcard");
      startTimer(Number(b.dataset.secs), card.dataset.full, { name: card.dataset.short, key: card.dataset.tkey, meal: meal.title, step: p });
      renderGuided();
    }));
    $$("[data-tadd]", page).forEach(b => b.addEventListener("click", () => addMinute(b.dataset.tadd)));
    $$("[data-tstop]", page).forEach(b => b.addEventListener("click", () => { stopTimer(b.dataset.tstop); renderGuided(); }));
    $$("[data-star]", page).forEach(b => b.addEventListener("click", () => {
      guided.note = $("#co-note")?.value || "";
      guided.rating = Number(b.dataset.star) === guided.rating ? 0 : Number(b.dataset.star);
      renderGuided();
    }));
    $("#co-note")?.addEventListener("input", e => { guided.note = e.target.value; });
    $$("[data-by]", page).forEach(b => b.addEventListener("click", () => { guided.note = $("#co-note")?.value || ""; guided.by = guided.by === b.dataset.by ? null : b.dataset.by; renderGuided(); }));
    $("#co-done")?.addEventListener("click", async () => {
      const id = guided.id, title = meal.title;
      await logCooked(id, guided.rating, guided.note, guided.by);
      closeGuided();
      status(`🍳 Logged "${title}" as cooked`);
    });
    $("#co-skip")?.addEventListener("click", closeGuided);
  }

  /* A timer card: ring, time left, what it's timing; Start → +1 / Stop while running */
  const RING = 2 * Math.PI * 24;
  function timerCard(meal, text, t, p, k){
    const nm = timerName(meal, text, t, p);
    const key = `${meal.id}:${p}:${k}`;
    const run = timers.find(x => x.key === key);
    const left = run ? (run.done ? 0 : run.end - Date.now()) : t.secs * 1000;
    const frac = run ? Math.max(0, Math.min(1, left / (run.total || t.secs * 1000))) : 1;
    return `<div class="co-tcard ${run ? (run.done ? "done" : "running") : ""}" data-tkey="${key}" data-short="${escapeHtml(nm.short)}" data-full="${escapeHtml(nm.full)}">
      <svg class="ring" viewBox="0 0 58 58" aria-hidden="true"><circle cx="29" cy="29" r="24" class="ring-bg"/><circle cx="29" cy="29" r="24" class="ring-fg" stroke-dasharray="${RING.toFixed(1)}" stroke-dashoffset="${(RING * (1 - frac)).toFixed(1)}" transform="rotate(-90 29 29)"/></svg>
      <div class="tc-text"><div class="tc-time">${run?.done ? "Done!" : fmtLeft(left)}</div><div class="tc-label">${escapeHtml(nm.full)} · ${escapeHtml(t.label)}</div></div>
      ${run ? `${run.done ? "" : `<button type="button" class="btn" data-tadd="${run.id}" aria-label="Add a minute">+1</button>`}<button type="button" class="btn" data-tstop="${run.id}">${run.done ? "Dismiss" : "Stop"}</button>`
        : `<button type="button" class="btn primary co-timer" data-secs="${t.secs}" data-label="${escapeHtml(t.label)}">${icon("play", 16)}Start</button>`}
    </div>`;
  }

  function go(delta){ if (guided) goTo(guided.page + delta); }
  function goTo(page){
    if (!guided) return;
    const meal = mealById(guided.id);
    const next = Math.max(0, Math.min(pageCount(meal) - 1, page));
    if (next === guided.page) return;
    guided.page = next;
    setIngsShown(false);
    renderGuided();
  }
  $("#co-prev")?.addEventListener("click", () => go(-1));
  $("#co-next")?.addEventListener("click", () => go(1));
  $("#co-close")?.addEventListener("click", closeGuided);
  $("#co-context")?.addEventListener("click", async () => {
    state.prefs.cookContext = !contextOn();
    renderGuided();
    await idbSet(IDB_KEYS.prefs, state.prefs);
  });
  /* Phone/portrait: the button swaps the step for the ingredient checklist */
  function setIngsShown(on){
    overlay.classList.toggle("show-ings", on);
    const b = $("#co-ing-toggle");
    if (b) b.textContent = on ? "Step" : "Ingredients";
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

  function startTimer(secs, label, extra = {}){
    if (!audio){ try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; } }
    audio?.resume?.();
    if ("Notification" in window && Notification.permission === "default"){
      try { Notification.requestPermission(); } catch { /* unsupported */ }
    }
    timers.push({ id: uid(), label: extra.meal ? `${label} — ${extra.meal.slice(0, 28)}` : label, name: extra.name || "", key: extra.key || "", step: extra.step || 0, total: secs * 1000, end: Date.now() + secs * 1000, done: false });
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
        <button class="btn mini" data-stop="${t.id}" aria-label="${t.done ? "Dismiss" : "Cancel"} timer">${icon("x", 16)}</button>
      </div>`).join("");
    $$("[data-add]", tray).forEach(b => b.addEventListener("click", () => addMinute(b.dataset.add)));
    $$("[data-stop]", tray).forEach(b => b.addEventListener("click", () => stopTimer(b.dataset.stop)));
    renderTimerPills();
    tickTimers();
  }
  function addMinute(id){
    const t = timers.find(x => x.id === id);
    if (!t) return;
    t.end += 60000; t.total = (t.total || 0) + 60000;
    saveTimers(); tickTimers();
  }
  function stopTimer(id){ timers = timers.filter(x => x.id !== id); saveTimers(); renderTimers(); }
  /* Cook mode header: every running timer as "Rice 08:42"; tap to go to its step */
  function renderTimerPills(){
    const wrap = $("#co-timers");
    if (!wrap) return;
    wrap.innerHTML = timers.map(t => `<button type="button" class="co-tpill ${t.done ? "done" : ""}" data-tpill="${t.id}" title="${escapeHtml(t.label)}">
      ${icon("timer", 14)}<span>${escapeHtml(t.name || "Timer")}</span> <b class="tp-left">${t.done ? "Done" : fmtLeft(t.end - Date.now())}</b></button>`).join("");
    $$("[data-tpill]", wrap).forEach(b => b.addEventListener("click", () => {
      const t = timers.find(x => x.id === b.dataset.tpill);
      if (!t) return;
      if (guided && t.key.startsWith(guided.id + ":")) goTo(t.step);
      else if (t.done) stopTimer(t.id);
    }));
  }
  function tickTimers(){
    const now = Date.now();
    let finished = false;
    for (const t of timers){
      if (!t.done && t.end <= now){ t.done = true; finished = true; alarm(t); }
    }
    if (finished){ saveTimers(); renderTimers(); if (guided) renderGuided(); return; }
    for (const t of timers){
      if (t.done) continue;
      const left = fmtLeft(t.end - now);
      const el = $(`[data-timer="${t.id}"] .timer-left`);
      if (el) el.textContent = left;
      const pill = $(`[data-tpill="${t.id}"] .tp-left`);
      if (pill) pill.textContent = left;
      const card = t.key && document.querySelector(`.co-tcard[data-tkey="${CSS.escape(t.key)}"]`);
      if (card){
        card.querySelector(".tc-time").textContent = left;
        const frac = Math.max(0, Math.min(1, (t.end - now) / (t.total || 1)));
        card.querySelector(".ring-fg")?.setAttribute("stroke-dashoffset", (RING * (1 - frac)).toFixed(1));
      }
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
  window.renderToday = renderToday;
  window.renderTodayShop = renderTodayShop;
  window.openGuided = openGuided;
  window.cookWeekMenu = thisWeekMenu;
  window.scanStepsFor = scanStepsFor;
  // Test hooks (pure helpers)
  window.cookHelpers = { parseDurations, ingredientsInStep, ingAmount, annotateStep, ovenTemps };

  if (window.appReady) init();
  else document.addEventListener("app:ready", init, { once: true });
})();
