/* =====================================================
   Meal Planner & Shopping List — v10
   - PWA, offline-first
   - IndexedDB storage
   - Mobile polish: list cards, no overflow, safe-area
   - Ingredient normaliser MERGES across existing meals
   - Backfill tags, unit defaults (locked), favourites, cook mode
   - Export/import with schema version + migration
   ===================================================== */

const DB_NAME = "mealPlannerDBv8";   // keep DB name -> preserve user data from older builds
const STORE = "kv";
const IDB_KEYS = {
  meals: "meals",
  normaliser: "normaliser",
  unitDefaults: "unitDefaults",
  prefs: "prefs"
};
const EXPORT_SCHEMA_VERSION = 10;
const NO_TAGS = "__NO_TAGS__";
const COOK_LAST_KEY = "cook-last-meal-id-v10";

const state = {
  meals: [],
  selected: new Set(),
  editingId: null,

  showFavsOnly: false,
  search: "",
  tagFilter: new Set(),
  tagMode: "ANY",
  containsFilter: new Set(),   // ingredient names that meals must all contain

  normaliser: [],
  unitDefaults: {},
  prefs: {
    theme: "auto",
    gridMin: "cozy",
    includeIngredientTags: false,
    tagStripMax: 12
  },

  timeFilter: { min: 0, max: 120 },
  view: "meals"
};

/* ============== tiny helpers ============== */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c => (
    { "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]
  ));
}
function titleCase(s){
  return String(s ?? "").toLowerCase().replace(/(^|\s|[-_])([a-z])/g, (_,p1,p2) => p1 + p2.toUpperCase());
}
function normaliseRaw(s){ return String(s ?? "").trim().toLowerCase(); }
function normaliseKey(s){
  return String(s ?? "").trim().toLowerCase()
    .replace(/[-_]/g," ")
    .replace(/\s+/g," ")
    .replace(/[^a-z0-9\s]/g,"");
}
function singularise(s){
  if (/ies$/.test(s)) return s.replace(/ies$/, "y");
  if (/ses$/.test(s)) return s.replace(/es$/, "");
  if (/s$/.test(s))   return s.replace(/s$/, "");
  return s;
}

/* Singularise a unit *label* (like "cloves", "tins", "pieces").
   Conservative — only normalises known plural forms, leaves unknowns alone.
   This means "rice" stays "rice", but "cloves" becomes "clove". */
const UNIT_LABEL_PLURALS = {
  "cloves": "clove",
  "pieces": "piece",
  "slices": "slice",
  "tins": "tin",
  "cans": "can",
  "packs": "pack",
  "packets": "packet",
  "bunches": "bunch",
  "sprigs": "sprig",
  "leaves": "leaf",
  "stalks": "stalk",
  "heads": "head",
  "sticks": "stick",
  "rashers": "rasher",
  "fillets": "fillet",
  "breasts": "breast",
  "thighs": "thigh",
  "drumsticks": "drumstick",
  "wings": "wing",
  "shoulders": "shoulder",
  "joints": "joint",
  "links": "link",
  "sausages": "sausage",
  "patties": "patty",
  "meatballs": "meatball",
  "chops": "chop",
  "steaks": "steak",
  "ribs": "rib",
  "loaves": "loaf",
  "rolls": "roll",
  "buns": "bun",
  "tortillas": "tortilla",
  "wraps": "wrap",
  "sheets": "sheet",
  "bars": "bar",
  "bottles": "bottle",
  "jars": "jar",
  "tubs": "tub",
  "punnets": "punnet",
  "bags": "bag",
  "boxes": "box",
  "blocks": "block",
  "cubes": "cube",
  "knobs": "knob",
  "splashes": "splash",
  "pinches": "pinch",
  "dashes": "dash",
  "drops": "drop",
  "handfuls": "handful"
};
function singulariseUnitLabel(s){
  const lower = String(s ?? "").trim().toLowerCase();
  if (!lower) return "";
  return UNIT_LABEL_PLURALS[lower] || lower;
}
function formatNumber(n){
  const t = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isInteger(t) ? String(t) : t.toFixed(2).replace(/\.?0+$/, "");
}

/* Common unit-label aliases — collapsed to canonical singulars so things like
   "10 clove" and "2 cloves" merge in the shopping list. Add freely. */
const UNIT_LABEL_ALIASES = {
  "cloves": "clove",
  "pieces": "piece",
  "pcs": "piece",
  "pc": "piece",
  "tins": "tin",
  "cans": "can",
  "packs": "pack",
  "packets": "packet",
  "sachets": "sachet",
  "slices": "slice",
  "sprigs": "sprig",
  "leaves": "leaf",
  "stalks": "stalk",
  "stems": "stem",
  "bunches": "bunch",
  "heads": "head",
  "rashers": "rasher",
  "fillets": "fillet",
  "strips": "strip",
  "wedges": "wedge",
  "cubes": "cube",
  "bottles": "bottle",
  "jars": "jar",
  "tbsps": "tbsp",
  "tablespoons": "tbsp",
  "tablespoon": "tbsp",
  "tsps": "tsp",
  "teaspoons": "tsp",
  "teaspoon": "tsp",
  "cups": "cup",
  "to-taste": "to taste",
  "totaste": "to taste"
};
function normaliseUnitLabel(s){
  const raw = String(s ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (UNIT_LABEL_ALIASES[raw]) return UNIT_LABEL_ALIASES[raw];
  // generic plural -> singular
  const sing = singularise(raw);
  return UNIT_LABEL_ALIASES[sing] || sing;
}

/* Walk all meals, normalise ingredient names + unit labels, and return a
   structured report of what changed. Used by the Settings "Clean up" button. */
function planIngredientCleanup(){
  const changes = [];
  for (const m of state.meals){
    for (const ing of (m.ingredients || [])){
      const oldName = ing.name || "";
      const oldUnit = ing.unit || "";
      const oldType = ing.type;

      const newName = normaliserLookup(oldName) || normaliseRaw(oldName);
      let newUnit = oldUnit;
      let newType = oldType;

      // Singularise unit labels for qty-typed ingredients
      if (oldType === "qty" && oldUnit){
        newUnit = normaliseUnitLabel(oldUnit);
      }

      // Special case: type=qty with no unit label is meaningless — promote to "piece"
      if (oldType === "qty" && !oldUnit){
        newUnit = "piece";
      }

      if (newName !== oldName || newUnit !== oldUnit || newType !== oldType){
        changes.push({
          mealId: m.id,
          mealTitle: m.title,
          oldName, newName,
          oldUnit, newUnit,
          oldType, newType
        });
      }
    }
  }
  return changes;
}
function applyIngredientCleanup(plan){
  const byMeal = new Map();
  for (const c of plan){
    if (!byMeal.has(c.mealId)) byMeal.set(c.mealId, []);
    byMeal.get(c.mealId).push(c);
  }
  let mealsTouched = 0;
  for (const m of state.meals){
    const ch = byMeal.get(m.id);
    if (!ch) continue;
    let changed = false;
    for (const c of ch){
      // Find the matching ingredient (best-effort by old triplet)
      const ing = (m.ingredients || []).find(i =>
        i.name === c.oldName && i.unit === c.oldUnit && i.type === c.oldType
      );
      if (!ing) continue;
      ing.name = c.newName;
      ing.unit = c.newUnit;
      ing.type = c.newType;
      changed = true;
    }
    if (changed) mealsTouched++;
  }
  return mealsTouched;
}

/* ============== status / toast ============== */
let toastTimer = null;
function status(msg, ms = 2400){
  const el = $("#status");
  if (el) el.textContent = msg;
  const toast = $("#toast");
  if (toast){
    toast.innerHTML = "";
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), ms);
  }
}

/* Toast with an Undo action. The undo button stays for `ms` ms (default 6000)
   then disappears. Calling status() again will replace it. */
function showUndoToast(msg, onUndo, ms = 6000){
  const toast = $("#toast");
  if (!toast) return;
  toast.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = msg;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-undo";
  btn.textContent = "Undo";
  btn.addEventListener("click", async () => {
    clearTimeout(toastTimer);
    toast.classList.remove("show");
    try { await onUndo(); } catch (e) { console.error("Undo failed:", e); }
  });
  toast.append(span, btn);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), ms);
}

/* ============== IndexedDB ============== */
function idbOpen(){
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}
async function idbGet(k){
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const rq = tx.objectStore(STORE).get(k);
    rq.onsuccess = () => res(rq.result);
    rq.onerror   = () => rej(rq.error);
  });
}
async function idbSet(k, v){
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    const rq = tx.objectStore(STORE).put(v, k);
    rq.onsuccess = () => res();
    rq.onerror   = () => rej(rq.error);
  });
}
async function saveAll(){
  await Promise.all([
    idbSet(IDB_KEYS.meals, state.meals),
    idbSet(IDB_KEYS.normaliser, state.normaliser),
    idbSet(IDB_KEYS.unitDefaults, state.unitDefaults),
    idbSet(IDB_KEYS.prefs, state.prefs)
  ]);
}
async function loadAll(){
  const [meals, normaliser, unitDefaults, prefs] = await Promise.all([
    idbGet(IDB_KEYS.meals),
    idbGet(IDB_KEYS.normaliser),
    idbGet(IDB_KEYS.unitDefaults),
    idbGet(IDB_KEYS.prefs)
  ]);
  if (Array.isArray(meals)){
    state.meals = meals.map(m => ({
      fav: false, tags: [], steps: [], notes: "", ingredients: [], cookMins: null,
      ...m
    }));
  }
  state.normaliser   = Array.isArray(normaliser) ? normaliser : [];
  state.unitDefaults = (unitDefaults && typeof unitDefaults === "object") ? unitDefaults : {};
  state.prefs        = (prefs && typeof prefs === "object")
    ? { theme:"auto", gridMin:"cozy", includeIngredientTags:false, tagStripMax:12, ...prefs }
    : { theme:"auto", gridMin:"cozy", includeIngredientTags:false, tagStripMax:12 };
}

/* ============== Theme ============== */
function applyTheme(){
  let mode = state.prefs.theme;
  if (mode === "auto"){
    mode = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", mode === "light" ? "light" : "dark");
  const t = $("#theme-toggle");
  if (t) t.textContent = mode === "light" ? "☀️" : "🌙";
}
$("#theme-toggle")?.addEventListener("click", async () => {
  const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  state.prefs.theme = current === "light" ? "dark" : "light";
  applyTheme();
  await saveAll();
});
$$("[data-theme-set]").forEach(b => b.addEventListener("click", async () => {
  state.prefs.theme = b.dataset.themeSet;
  applyTheme();
  await saveAll();
}));
window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => {
  if (state.prefs.theme === "auto") applyTheme();
});

/* ============== View switching ============== */
const VIEWS = ["meals", "shopping", "add", "cook"];
function isMobile(){ return window.matchMedia("(max-width:720px)").matches; }

function setView(view){
  if (!VIEWS.includes(view)) view = "meals";
  state.view = view;

  if (isMobile()){
    VIEWS.forEach(v => {
      const el = document.getElementById(`view-${v}`);
      if (el) el.classList.toggle("active", v === view);
    });
    const addPanel = $("#add-panel");
    const rightPanel = $("#right-panel");
    if (view === "add"){
      addPanel.style.display = "";
      rightPanel.style.display = "none";
      addPanel.classList.add("open");
      // Scroll to top of add panel & focus title
      window.scrollTo({ top:0, behavior:"smooth" });
      setTimeout(() => $("#title")?.focus(), 200);
    } else {
      addPanel.style.display = "none";
      rightPanel.style.display = "";
    }
  } else {
    $("#add-panel").style.display = "";
    $("#right-panel").style.display = "";
    VIEWS.forEach(v => {
      const el = document.getElementById(`view-${v}`);
      if (el){ el.classList.add("active"); el.style.display = ""; }
    });
  }

  $$("#bottom-nav .navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  if (view === "cook") populateCookSelect();
}
$$("#bottom-nav .navbtn").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
window.addEventListener("resize", () => {
  // re-evaluate view layout when crossing breakpoint
  setView(state.view);
});

/* ============== Mobile collapsible add panel ============== */
function setupMobileAddPanel(){
  const panel = $("#add-panel");
  const header = $("#add-header");
  if (!panel || !header) return;
  if (isMobile()){
    panel.classList.add("collapsible");
    panel.classList.add("open");
    header.addEventListener("click", () => panel.classList.toggle("open"));
  } else {
    panel.classList.remove("collapsible");
  }
}

/* ============== Suggestions / datalists ============== */
function updateIngredientSuggestions(){
  const set = new Set();
  state.meals.forEach(m => (m.ingredients || []).forEach(i => set.add(normaliseRaw(i.name))));
  // include canonicals
  state.normaliser.forEach(e => set.add(normaliseRaw(e.canonical)));
  const list = $("#ingredient-suggestions");
  if (!list) return;
  list.innerHTML = "";
  Array.from(set).filter(Boolean).sort().forEach(n => {
    const o = document.createElement("option");
    o.value = n;
    list.appendChild(o);
  });
}
function allTagsSet(){
  const s = new Set();
  state.meals.forEach(m => (m.tags || []).forEach(t => s.add(String(t).toLowerCase())));
  return s;
}
function refreshTagSuggestions(){
  const list = $("#tag-suggestions");
  if (!list) return;
  list.innerHTML = "";
  Array.from(allTagsSet()).sort().forEach(t => {
    const o = document.createElement("option");
    o.value = t;
    list.appendChild(o);
  });
}

/* ============== Image helpers ============== */
function canvasSupportsType(mime){
  try{
    const c = document.createElement("canvas");
    c.width = 1; c.height = 1;
    const d = c.toDataURL(mime);
    return typeof d === "string" && d.startsWith("data:") && d.includes(mime);
  } catch { return false; }
}
function drawToDataURL(img, maxW, maxH, mime, quality){
  return new Promise(resolve => {
    const r = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    const w = Math.max(1, Math.round(img.naturalWidth * r));
    const h = Math.max(1, Math.round(img.naturalHeight * r));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    resolve(c.toDataURL(mime, quality));
  });
}
async function fileToCompressedDataURL(file){
  if (!file) return null;
  const preferWebp = canvasSupportsType("image/webp");
  const mime = preferWebp ? "image/webp" : "image/jpeg";
  let objectUrl;
  try{
    const img = await new Promise((res, rej) => {
      const o = new Image();
      o.onload = () => res(o);
      o.onerror = rej;
      objectUrl = URL.createObjectURL(file);
      o.src = objectUrl;
    });

    let max = 1400;
    let quality = mime === "image/jpeg" ? 0.82 : 0.86;
    let data = null;
    for (let i = 0; i < 4; i++){
      data = await drawToDataURL(img, max, max, mime, quality);
      if (data && data.length < 1.6 * 1024 * 1024) break;
      quality = Math.max(0.5, quality - 0.10);
      max = Math.max(600, max - 200);
    }
    return data || null;
  } catch (err){
    console.warn("Image compress failed:", err);
    status("Image upload failed — saving meal without image.", 3500);
    return null;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
function placeholderSvg(text){
  const t = (text || "Meal").slice(0, 24).replace(/&/g,"&amp;").replace(/</g,"&lt;");
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 360' preserveAspectRatio='xMidYMid slice'>
    <defs>
      <linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
        <stop offset='0' stop-color='#1f2937'/>
        <stop offset='1' stop-color='#0f172a'/>
      </linearGradient>
    </defs>
    <rect width='100%' height='100%' fill='url(#g)'/>
    <g fill='#94a3b8' font-family='ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto' font-size='28'>
      <text x='50%' y='52%' dominant-baseline='middle' text-anchor='middle' font-weight='700'>${t}</text>
    </g>
  </svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

/* ============== Normaliser lookup ============== */
function normaliserLookup(name){
  const key = normaliseKey(name);
  if (!key) return null;
  const singular = singularise(key);
  for (const e of state.normaliser){
    const ck = normaliseKey(e.canonical);
    if (key === ck || singular === ck) return normaliseRaw(e.canonical);
    for (const a of (e.aliases || [])){
      const ak = normaliseKey(a);
      if (key === ak || singular === ak) return normaliseRaw(e.canonical);
    }
  }
  return null;
}
function ingredientNamesToTags(ings){
  const out = new Set();
  (ings || []).forEach(i => {
    const raw = normaliseRaw(i.name);
    if (!raw) return;
    out.add(normaliserLookup(raw) || raw);
  });
  return Array.from(out);
}

/* Apply current normaliser entries across all meals.
   - rewrites ingredient.name to canonical
   - rewrites tags that match any alias to canonical
   Returns count of changes. Used after user adds a normaliser entry. */
function applyNormaliserAcrossMeals(){
  let changes = 0;
  for (const m of state.meals){
    let changed = false;
    (m.ingredients || []).forEach(ing => {
      const canon = normaliserLookup(ing.name);
      if (canon && normaliseRaw(ing.name) !== canon){
        ing.name = canon;
        changed = true;
      }
    });
    if (Array.isArray(m.tags)){
      const next = [];
      const seen = new Set();
      for (const t of m.tags){
        const canon = normaliserLookup(t);
        const v = canon || normaliseRaw(t);
        if (v && !seen.has(v)){
          seen.add(v);
          next.push(v);
        }
      }
      if (JSON.stringify(next) !== JSON.stringify(m.tags || [])){
        m.tags = next;
        changed = true;
      }
    }
    if (changed) changes++;
  }
  return changes;
}

/* Walk all meals, dry-run a singularise + qty-needs-unit cleanup.
   Returns { changes: [{mealTitle, before, after}, ...], totalChanges }.
   Pass apply=true to actually mutate state.meals. */
function cleanupIngredientUnits(apply = false){
  const changes = [];
  for (const m of state.meals){
    for (let i = 0; i < (m.ingredients || []).length; i++){
      const ing = m.ingredients[i];
      const oldUnit = ing.unit || "";
      let newUnit = singulariseUnitLabel(oldUnit);
      if (ing.type === "qty" && !newUnit) newUnit = "piece";
      if (newUnit !== oldUnit){
        changes.push({
          mealTitle: m.title,
          ingredient: ing.name,
          type: ing.type,
          before: oldUnit || "(empty)",
          after: newUnit
        });
        if (apply) ing.unit = newUnit;
      }
    }
  }
  return { changes, totalChanges: changes.length };
}

/* ============== Token (tag) editor ============== */
function tokenEditor(container, input, initial = []){
  const tokens = new Set((initial || []).map(t => String(t).toLowerCase()));
  function render(){
    container.innerHTML = "";
    tokens.forEach(t => {
      const tok = document.createElement("span");
      tok.className = "token";
      const text = document.createElement("span");
      text.textContent = t;
      const x = document.createElement("button");
      x.type = "button"; x.className = "x"; x.setAttribute("aria-label", `Remove ${t}`);
      x.textContent = "×";
      x.addEventListener("click", () => { tokens.delete(t); render(); });
      tok.append(text, x);
      container.appendChild(tok);
    });
  }
  function addToken(v){
    v = (v || "").trim().replace(/,$/, "").toLowerCase();
    if (!v) return;
    tokens.add(v);
    render();
    input.value = "";
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault(); addToken(input.value);
    } else if (e.key === "Backspace" && !input.value && tokens.size){
      const last = Array.from(tokens).pop();
      tokens.delete(last); render();
    }
  });
  input.addEventListener("blur", () => { if (input.value.trim()) addToken(input.value); });

  render();
  return {
    get: () => Array.from(tokens),
    set: arr => { tokens.clear(); (arr || []).forEach(x => tokens.add(String(x).toLowerCase())); render(); },
    addMany: arr => { (arr || []).forEach(x => tokens.add(String(x).toLowerCase())); render(); }
  };
}

/* ============== Ingredient row ============== */
function maybeApplyUnitDefault(row){
  const [nameEl, typeEl, amtEl, unitEl] = row.children;
  const key = normaliseKey(nameEl.value);
  if (!key) return;
  const def = state.unitDefaults[key];
  if (def){
    typeEl.value = def.type;
    if (def.unitLabel) unitEl.value = def.unitLabel;
  }
  const locked = !!def?.locked;
  typeEl.disabled = locked;
  unitEl.disabled = locked && def?.type === "qty";
  typeEl.title = locked ? "Locked by unit defaults (Settings)" : "";
  unitEl.title = typeEl.title;

  if (typeEl.value === "qty"){
    amtEl.step = "1";
    if (amtEl.value) amtEl.value = String(Math.max(0, Math.round(parseFloat(amtEl.value) || 0)));
  } else {
    amtEl.step = "any";
  }
}

function addIngredientRow(container, pref = {}, opts = {}){
  const row = $("#ingredient-template").content.firstElementChild.cloneNode(true);
  const [nameEl, typeEl, amtEl, unitEl, rmBtn] = row.children;

  nameEl.value = pref.name || "";
  typeEl.value = pref.type || "grams";
  amtEl.value  = (pref.amount ?? "");
  unitEl.value = pref.unit || "";

  const enforce = () => {
    if (typeEl.value === "qty"){
      amtEl.step = "1";
      if (amtEl.value) amtEl.value = String(Math.max(0, Math.round(parseFloat(amtEl.value) || 0)));
    } else {
      amtEl.step = "any";
    }
  };
  enforce();

  typeEl.addEventListener("change", enforce);
  rmBtn.addEventListener("click", () => row.remove());
  nameEl.addEventListener("change", () => maybeApplyUnitDefault(row));

  container.appendChild(row);

  if (!pref?.name && opts.focus !== false){
    setTimeout(() => {
      nameEl.focus();
      nameEl.classList.add("flash-input");
      nameEl.scrollIntoView({ behavior:"smooth", block:"center" });
      setTimeout(() => nameEl.classList.remove("flash-input"), 1300);
    }, 30);
  }
  if (nameEl.value) maybeApplyUnitDefault(row);
  return row;
}

/* ============== Steps UI ============== */
function renderSteps(container, steps, onChange){
  container.innerHTML = "";
  if (!steps.length){
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "No steps yet.";
    container.appendChild(d);
    return;
  }
  steps.forEach((text, idx) => {
    const row = document.createElement("div");
    row.className = "step-row";

    const t = document.createElement("div");
    t.className = "step-text";
    t.textContent = `${idx + 1}. ${text}`;

    const up = document.createElement("button");
    up.type = "button"; up.className = "btn mini"; up.textContent = "↑";
    up.disabled = idx === 0;
    up.setAttribute("aria-label", "Move up");
    up.addEventListener("click", () => {
      [steps[idx - 1], steps[idx]] = [steps[idx], steps[idx - 1]];
      onChange();
    });

    const down = document.createElement("button");
    down.type = "button"; down.className = "btn mini"; down.textContent = "↓";
    down.disabled = idx === steps.length - 1;
    down.setAttribute("aria-label", "Move down");
    down.addEventListener("click", () => {
      [steps[idx + 1], steps[idx]] = [steps[idx], steps[idx + 1]];
      onChange();
    });

    const del = document.createElement("button");
    del.type = "button"; del.className = "btn danger mini"; del.textContent = "×";
    del.setAttribute("aria-label", "Delete step");
    del.addEventListener("click", () => { steps.splice(idx, 1); onChange(); });

    row.append(t, up, down, del);
    container.appendChild(row);
  });
}
function addStepFromInput(inputEl, steps, onChange){
  const v = (inputEl.value || "").trim();
  if (!v) return;
  steps.push(v);
  inputEl.value = "";
  onChange();
}

/* ============== Modal helpers ============== */
function lockBodyScroll(locked){
  document.body.classList.toggle("modal-open", !!locked);
}

/* ============== Selection count ============== */
function updateSelectedCount(){
  const n = state.selected.size;
  const el = $("#selected-count");
  if (el) el.textContent = n ? `${n} meal${n === 1 ? "" : "s"} selected` : "No meals selected";
}

/* =====================================================
   CREATE FORM WIRING
   ===================================================== */
const ingContainer = $("#ingredients");
$("#add-ingredient")?.addEventListener("click", () => addIngredientRow(ingContainer));
addIngredientRow(ingContainer, {}, { focus:false });
addIngredientRow(ingContainer, {}, { focus:false });

const tagEditor = tokenEditor($("#tags-editor"), $("#tags-input"));

let createSteps = [];
function refreshCreateSteps(){ renderSteps($("#steps"), createSteps, refreshCreateSteps); }
$("#add-step")?.addEventListener("click", () => addStepFromInput($("#step-input"), createSteps, refreshCreateSteps));
$("#step-input")?.addEventListener("keydown", e => {
  if (e.key === "Enter"){ e.preventDefault(); addStepFromInput($("#step-input"), createSteps, refreshCreateSteps); }
});
refreshCreateSteps();

$("#meal-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try{
    const title = $("#title").value.trim();
    if (!title){ alert("Please provide a meal name."); $("#title").focus(); return; }

    let imageDataUrl = null;
    const file = $("#image-file").files[0];
    if (file){
      try{ imageDataUrl = await fileToCompressedDataURL(file); }
      catch(err){ console.warn(err); imageDataUrl = null; }
    }

    const cookRaw = ($("#cook-mins").value || "").trim();
    let cookMins = cookRaw === "" ? null : Number(cookRaw);
    if (cookMins !== null && !isFinite(cookMins)) cookMins = null;
    if (cookMins !== null) cookMins = Math.max(0, Math.min(120, cookMins));

    const ingredients = [];
    $$(".ingredient-row", ingContainer).forEach(row => {
      const [n, t, a, u] = row.children;
      const name = n.value.trim();
      if (!name) return;
      let amount = Number(a.value);
      if (!isFinite(amount) || amount < 0) return;
      const type = t.value;
      if (type === "qty") amount = Math.max(0, Math.round(amount));
      let unit = singulariseUnitLabel(u.value.trim());
      if (type === "qty" && !unit) unit = "piece";   // never store qty without a label
      // apply normaliser at save time
      const canon = normaliserLookup(name) || normaliseRaw(name);
      ingredients.push({ name: canon, type, amount, unit });
    });
    if (!ingredients.length){ alert("Please add at least one valid ingredient."); return; }

    const autoTags = ingredientNamesToTags(ingredients);
    const userTags = tagEditor.get();
    const tags = Array.from(new Set([...userTags, ...autoTags]));

    const meal = {
      id: uid(),
      title,
      image: imageDataUrl ? { type:"data", src: imageDataUrl } : null,
      fav: false,
      tags,
      ingredients,
      cookMins: (typeof cookMins === "number") ? cookMins : null,
      steps: createSteps.slice(),
      notes: ($("#notes").value || "").trim()
    };

    state.meals.unshift(meal);
    await saveAll();

    renderMeals(); renderShopping(); populateCookSelect();
    updateIngredientSuggestions(); refreshTagSuggestions();

    // reset form
    e.target.reset();
    ingContainer.innerHTML = "";
    addIngredientRow(ingContainer, {}, { focus:false });
    addIngredientRow(ingContainer, {}, { focus:false });
    tagEditor.set([]);
    createSteps = [];
    refreshCreateSteps();

    status(`✓ ${meal.title} added`);
    if (isMobile()) setView("meals");
  } catch(err){
    console.error(err);
    alert("Something went wrong while saving. See console for details.");
  }
});

$("#reset-form")?.addEventListener("click", () => {
  ingContainer.innerHTML = "";
  addIngredientRow(ingContainer, {}, { focus:false });
  addIngredientRow(ingContainer, {}, { focus:false });
  tagEditor.set([]);
  createSteps = [];
  refreshCreateSteps();
});

$("#duplicate-last")?.addEventListener("click", async () => {
  if (!state.meals.length){ status("Nothing to duplicate yet."); return; }
  const copy = JSON.parse(JSON.stringify(state.meals[0]));
  copy.id = uid();
  copy.title = `${copy.title} (copy)`;
  state.meals.unshift(copy);
  await saveAll();
  renderMeals(); populateCookSelect();
  status("Duplicated last meal.");
});

/* =====================================================
   EDIT MODAL
   ===================================================== */
const editModal = $("#edit-modal");
const editIng   = $("#edit-ingredients");
const editTagEditor = tokenEditor($("#edit-tags-editor"), $("#edit-tags-input"));
let editSteps = [];

function refreshEditSteps(){ renderSteps($("#edit-steps"), editSteps, refreshEditSteps); }
$("#edit-add-step")?.addEventListener("click", () => addStepFromInput($("#edit-step-input"), editSteps, refreshEditSteps));
$("#edit-step-input")?.addEventListener("keydown", e => {
  if (e.key === "Enter"){ e.preventDefault(); addStepFromInput($("#edit-step-input"), editSteps, refreshEditSteps); }
});
$("#edit-add-ingredient")?.addEventListener("click", () => addIngredientRow(editIng));

function openEdit(id){
  const meal = state.meals.find(m => m.id === id);
  if (!meal) return;
  state.editingId = id;

  $("#edit-title").value = meal.title;
  $("#edit-cook-mins").value = (meal.cookMins ?? "");
  editIng.innerHTML = "";
  (meal.ingredients || []).forEach(i => addIngredientRow(editIng, i, { focus:false }));
  if (!(meal.ingredients || []).length) addIngredientRow(editIng, {}, { focus:false });

  editTagEditor.set(meal.tags || []);
  editSteps = Array.isArray(meal.steps) ? meal.steps.slice() : [];
  refreshEditSteps();
  $("#edit-notes").value = meal.notes || "";

  editModal.classList.add("open");
  editModal.setAttribute("aria-hidden", "false");
  lockBodyScroll(true);
  setTimeout(() => $("#edit-title")?.focus(), 40);
}
function closeEdit(){
  editModal.classList.remove("open");
  editModal.setAttribute("aria-hidden", "true");
  state.editingId = null;
  $("#edit-form").reset();
  editIng.innerHTML = "";
  editSteps = [];
  refreshEditSteps();
  $("#edit-notes").value = "";
  lockBodyScroll(false);
}
$("#edit-close")?.addEventListener("click", closeEdit);
$("#edit-cancel")?.addEventListener("click", closeEdit);

$("#edit-tags-from-ingredients")?.addEventListener("click", () => {
  const ings = [];
  $$(".ingredient-row", editIng).forEach(row => {
    const [n] = row.children;
    const name = n.value.trim();
    if (name) ings.push({ name });
  });
  editTagEditor.addMany(ingredientNamesToTags(ings));
});

$("#edit-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const meal = state.meals.find(m => m.id === state.editingId);
  if (!meal) return;

  meal.title = $("#edit-title").value.trim() || meal.title;

  const f = $("#edit-image-file").files[0];
  if (f){
    const data = await fileToCompressedDataURL(f);
    if (data) meal.image = { type:"data", src:data };
  }

  const editCookRaw = ($("#edit-cook-mins").value || "").trim();
  let cook = editCookRaw === "" ? null : Number(editCookRaw);
  if (cook !== null && !isFinite(cook)) cook = null;
  if (cook !== null) cook = Math.max(0, Math.min(120, cook));
  meal.cookMins = cook;

  const ing = [];
  $$(".ingredient-row", editIng).forEach(row => {
    const [n, t, a, u] = row.children;
    const name = n.value.trim();
    if (!name) return;
    let amount = Number(a.value);
    if (!isFinite(amount) || amount < 0) return;
    const type = t.value;
    if (type === "qty") amount = Math.max(0, Math.round(amount));
    const canon = normaliserLookup(name) || normaliseRaw(name);
    let unit = singulariseUnitLabel(u.value.trim());
    if (type === "qty" && !unit) unit = "piece";
    ing.push({ name: canon, type, amount, unit });
  });
  if (!ing.length){ alert("Please add at least one ingredient."); return; }

  meal.ingredients = ing;
  meal.tags = editTagEditor.get();
  meal.steps = editSteps.slice();
  meal.notes = ($("#edit-notes").value || "").trim();

  await saveAll();
  renderMeals(); renderShopping(); populateCookSelect();
  updateIngredientSuggestions(); refreshTagSuggestions();
  closeEdit();
  status("Meal updated.");
});

/* Escape closes modals & popovers */
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if ($("#filters-modal")?.classList.contains("open")) closeFilters();
  if ($("#settings-modal")?.classList.contains("open")) closeSettings();
  if (editModal?.classList.contains("open")) closeEdit();
  if (popEl) closePopover();
});

/* =====================================================
   TAG BAR + POPOVER
   ===================================================== */
function computeTagStats(){
  const counts = new Map();
  const ingNames = new Set();
  state.meals.forEach(m => (m.ingredients || []).forEach(i => ingNames.add(normaliseRaw(i.name))));
  state.meals.forEach(m => (m.tags || []).forEach(t => {
    const k = String(t).toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }));
  const rows = Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count, isIngredient: ingNames.has(tag) }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const noTagsCount = state.meals.filter(m => !m.tags || !m.tags.length).length;
  return { rows, noTagsCount };
}
function pruneTagFilter(){
  const all = allTagsSet();
  for (const t of Array.from(state.tagFilter)){
    if (t === NO_TAGS) continue;
    if (!all.has(t)) state.tagFilter.delete(t);
  }
  if (!state.tagFilter.size) state.tagMode = "ANY";
}

function buildTagBar(){
  pruneTagFilter();
  const bar = $("#tag-bar");
  if (!bar) return;
  bar.innerHTML = "";

  const { rows } = computeTagStats();
  const includeIng = !!state.prefs.includeIngredientTags;
  const max = Number(state.prefs.tagStripMax) || 12;
  const active = Array.from(state.tagFilter).filter(t => t !== NO_TAGS);

  const list = [];
  active.forEach(t => {
    if (!list.find(x => x.tag === t)){
      list.push({ tag:t, count: rows.find(r => r.tag === t)?.count || 0 });
    }
  });
  rows.forEach(r => {
    if (!includeIng && r.isIngredient) return;
    if (!list.find(x => x.tag === r.tag)) list.push({ tag:r.tag, count:r.count });
  });

  const show = list.slice(0, max);

  function toggleTag(tag){
    if (state.tagFilter.has(tag)) state.tagFilter.delete(tag);
    else state.tagFilter.add(tag);
    renderMeals();
    buildTagBar();
  }

  show.forEach(x => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tag" + (state.tagFilter.has(x.tag) ? " active" : "");
    b.innerHTML = `${escapeHtml(x.tag)}${x.count ? ` <span class="count">${x.count}</span>` : ""}`;
    b.addEventListener("click", () => toggleTag(x.tag));
    bar.appendChild(b);
  });

  const mode = state.tagMode === "ALL" ? "ALL" : "ANY";
  $("#tag-active").textContent = state.tagFilter.size ? `${state.tagFilter.size} selected (${mode})` : "";
  $("#m-tag-active") && ($("#m-tag-active").textContent = state.tagFilter.size ? `${state.tagFilter.size} selected (${mode})` : "");
}

let popEl = null;
function closePopover(){
  if (!popEl) return;
  popEl.remove();
  popEl = null;
  window.removeEventListener("click", closePopover);
}
function openTagPopover(anchor){
  closePopover();
  const { rows, noTagsCount } = computeTagStats();
  const incIng = !!state.prefs.includeIngredientTags;
  const rect = anchor.getBoundingClientRect();
  const p = document.createElement("div");
  p.className = "popover";

  // viewport-aware positioning
  const top = Math.min(window.innerHeight - 360, rect.bottom + 8);
  const leftMax = window.innerWidth - 500;
  const left = Math.max(10, Math.min(leftMax, rect.left));
  p.style.top = `${top}px`;
  p.style.left = `${left}px`;

  p.innerHTML = `
    <div class="pop-title">Filter by tag</div>
    <div class="pop-row">
      <input id="tag-search" type="text" placeholder="Search tags…" style="flex:1" />
      <button class="btn mini" id="tag-mode-toggle">Mode: ${state.tagMode}</button>
    </div>
    <label class="pop-row" style="user-select:none">
      <input id="toggle-ingredient-tags" type="checkbox" ${incIng ? "checked" : ""}/>
      <span>Include ingredient-derived tags</span>
    </label>
    <div class="pop-sub">Select tags</div>
    <div class="pop-list" id="tag-list"></div>
    <div class="pop-row" style="justify-content:space-between">
      <button class="btn mini" id="clear-tags">Clear</button>
      <button class="btn mini" id="close-tags">Done</button>
    </div>
  `;
  document.body.appendChild(p);
  popEl = p;
  // prevent clicks INSIDE popover from closing it
  p.addEventListener("click", (e) => e.stopPropagation());
  setTimeout(() => window.addEventListener("click", closePopover), 0);

  const listEl = $("#tag-list", p);
  function renderList(){
    const q = ($("#tag-search", p).value || "").trim().toLowerCase();
    listEl.innerHTML = "";
    const sentinel = { tag:NO_TAGS, label:"no tags", count:noTagsCount };
    const candidates = rows.filter(r => incIng || !r.isIngredient);
    const items = [sentinel, ...candidates.map(r => ({ tag:r.tag, label:r.tag, count:r.count }))]
      .filter(x => !q || x.label.includes(q));

    items.forEach(x => {
      const b = document.createElement("div");
      b.className = "pop-chip" + (state.tagFilter.has(x.tag) ? " active" : "");
      b.innerHTML = `<input type="checkbox" ${state.tagFilter.has(x.tag) ? "checked" : ""}/> ${escapeHtml(x.label)} <span class="count" style="margin-left:auto">${x.count}</span>`;
      const cb = b.querySelector("input");
      const toggle = () => {
        if (state.tagFilter.has(x.tag)) state.tagFilter.delete(x.tag);
        else state.tagFilter.add(x.tag);
        cb.checked = state.tagFilter.has(x.tag);
        b.classList.toggle("active", cb.checked);
        buildTagBar();
        renderMeals();
      };
      b.addEventListener("click", (ev) => { if (ev.target.tagName !== "INPUT") toggle(); });
      cb.addEventListener("change", toggle);
      listEl.appendChild(b);
    });
  }

  $("#tag-search", p).addEventListener("input", renderList);
  $("#tag-mode-toggle", p).addEventListener("click", () => {
    state.tagMode = state.tagMode === "ANY" ? "ALL" : "ANY";
    $("#tag-mode-toggle", p).textContent = `Mode: ${state.tagMode}`;
    renderMeals(); buildTagBar();
  });
  $("#toggle-ingredient-tags", p).addEventListener("change", async (e) => {
    state.prefs.includeIngredientTags = !!e.target.checked;
    await saveAll();
    buildTagBar(); renderList();
  });
  $("#clear-tags", p).addEventListener("click", () => {
    state.tagFilter.clear();
    buildTagBar(); renderMeals(); renderList();
  });
  $("#close-tags", p).addEventListener("click", closePopover);

  renderList();
}

$("#tag-filter")?.addEventListener("click", (e) => {
  e.preventDefault(); e.stopPropagation();
  openTagPopover(e.currentTarget);
});

/* =====================================================
   FILTERS MODAL (mobile)
   ===================================================== */
const filtersModal = $("#filters-modal");
function openFilters(){
  filtersModal.classList.add("open");
  filtersModal.setAttribute("aria-hidden", "false");
  lockBodyScroll(true);
  syncMobileFiltersUI();
}
function closeFilters(){
  filtersModal.classList.remove("open");
  filtersModal.setAttribute("aria-hidden", "true");
  lockBodyScroll(false);
}
$("#open-filters")?.addEventListener("click", openFilters);
$("#filters-close")?.addEventListener("click", closeFilters);
$("#m-tag-filter")?.addEventListener("click", (e) => {
  e.stopPropagation();
  openTagPopover(e.currentTarget);
});

function syncMobileFiltersUI(){
  $("#m-time-min").value = String(state.timeFilter.min);
  $("#m-time-max").value = String(state.timeFilter.max);
  $("#m-time-label").textContent = `${state.timeFilter.min}–${state.timeFilter.max} min`;
  $("#m-favs").textContent = state.showFavsOnly ? "Show all" : "Show favourites only";
  $("#m-tag-active").textContent = state.tagFilter.size
    ? `${state.tagFilter.size} selected (${state.tagMode === "ALL" ? "ALL" : "ANY"})` : "";
}
function clampMobileTime(){
  let a = Number($("#m-time-min").value);
  let b = Number($("#m-time-max").value);
  if (a > b) [a, b] = [b, a];
  state.timeFilter.min = a; state.timeFilter.max = b;
  $("#m-time-label").textContent = `${a}–${b} min`;
  syncTimeSliders();
  renderMeals();
}
$("#m-time-min")?.addEventListener("input", clampMobileTime);
$("#m-time-max")?.addEventListener("input", clampMobileTime);
$("#m-time-clear")?.addEventListener("click", () => {
  state.timeFilter.min = 0; state.timeFilter.max = 120;
  syncTimeSliders(); syncMobileFiltersUI(); renderMeals();
});
$("#m-favs")?.addEventListener("click", () => {
  state.showFavsOnly = !state.showFavsOnly;
  $("#toggle-favs").textContent = state.showFavsOnly ? "Show all" : "Show favourites only";
  syncMobileFiltersUI(); renderMeals();
});

/* =====================================================
   MEALS RENDER
   ===================================================== */
const grid = $("#meal-grid");

function visibleMeals(){
  let items = [...state.meals];
  if (state.showFavsOnly) items = items.filter(m => m.fav);

  // Search now matches title OR any ingredient name
  if (state.search){
    const q = state.search;
    items = items.filter(m => {
      if ((m.title || "").toLowerCase().includes(q)) return true;
      return (m.ingredients || []).some(i => normaliseRaw(i.name).includes(q));
    });
  }

  // Contains filter: meal must contain ALL listed ingredients (substring match,
  // canonicalised via normaliser so "scallion" matches if mapped to "spring onion")
  if (state.containsFilter.size){
    const need = [...state.containsFilter].map(s => {
      const canon = normaliserLookup(s) || normaliseRaw(s);
      return canon;
    });
    items = items.filter(m => {
      const ingNames = (m.ingredients || []).map(i => normaliseRaw(i.name));
      return need.every(n => ingNames.some(ing => ing.includes(n)));
    });
  }

  if (state.tagFilter.size){
    const need = [...state.tagFilter];
    items = items.filter(m => {
      const hasNoTags = !m.tags || !m.tags.length;
      const tags = new Set((m.tags || []).map(t => String(t).toLowerCase()));
      if (state.tagMode === "ANY") return need.some(t => t === NO_TAGS ? hasNoTags : tags.has(t));
      return need.every(t => t === NO_TAGS ? hasNoTags : tags.has(t));
    });
  }
  items = items.filter(m => {
    const t = m.cookMins;
    if (typeof t !== "number") return (state.timeFilter.min === 0 && state.timeFilter.max === 120);
    return t >= state.timeFilter.min && t <= state.timeFilter.max;
  });
  return items.sort((a, b) => {
    const fav = (b.fav === true) - (a.fav === true);
    if (fav) return fav;
    return (a.title || "").localeCompare(b.title || "", "en-GB", { sensitivity:"base" });
  });
}

function renderMeals(){
  buildTagBar();
  grid.innerHTML = "";
  const items = visibleMeals();

  if (!items.length){
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = state.meals.length ? "No meals match your filters." : "No meals yet — add one with the form ↑";
    grid.appendChild(d);
    return;
  }

  items.forEach(meal => {
    const card = document.createElement("article");
    card.className = "card";

    // ---- media ----
    const media = document.createElement("div");
    media.className = "media";

    const img = document.createElement("img");
    img.alt = meal.title;
    img.loading = "lazy";
    img.decoding = "async";
    img.src = meal.image?.src || placeholderSvg(meal.title);
    img.addEventListener("load", () => img.classList.add("ready"));

    const sel = document.createElement("label");
    sel.className = "select";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.selected.has(meal.id);
    cb.setAttribute("aria-label", `Include ${meal.title}`);
    cb.addEventListener("change", () => {
      if (cb.checked) state.selected.add(meal.id); else state.selected.delete(meal.id);
      renderShopping();
      updateSelectedCount();
    });
    sel.append(cb, document.createTextNode("Include"));

    const fav = document.createElement("button");
    fav.type = "button";
    fav.className = "fav";
    fav.dataset.on = meal.fav ? "true" : "false";
    fav.setAttribute("aria-pressed", meal.fav ? "true" : "false");
    fav.setAttribute("aria-label", meal.fav ? "Unfavourite" : "Favourite");
    const star = document.createElement("span");
    star.textContent = meal.fav ? "★" : "☆";
    const ft = document.createElement("span");
    ft.textContent = meal.fav ? "Favourited" : "Favourite";
    fav.append(star, ft);
    fav.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const m = state.meals.find(x => x.id === meal.id);
      if (!m) return;
      m.fav = !m.fav;
      await saveAll();
      renderMeals();
    });

    function toggleSelected(){
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change", { bubbles:true }));
    }
    media.addEventListener("click", (ev) => {
      if (ev.target.closest(".fav")) return;
      if (ev.target.tagName === "INPUT") return;
      toggleSelected();
    });
    media.append(img, sel, fav);

    // ---- body ----
    const body = document.createElement("div");

    const title = document.createElement("h3");
    title.textContent = meal.title;
    title.style.cursor = "pointer";
    title.addEventListener("click", toggleSelected);
    body.append(title);

    const chips = document.createElement("div");
    chips.className = "chips";
    if (typeof meal.cookMins === "number"){
      const t = document.createElement("span");
      t.className = "chip"; t.textContent = `⏱ ${meal.cookMins} min`;
      chips.appendChild(t);
    }
    if (Array.isArray(meal.steps) && meal.steps.length){
      const s = document.createElement("span");
      s.className = "chip"; s.textContent = `🧾 ${meal.steps.length} step${meal.steps.length === 1 ? "" : "s"}`;
      chips.appendChild(s);
    }
    if (meal.notes && meal.notes.trim()){
      const n = document.createElement("span");
      n.className = "chip"; n.textContent = "📝 notes";
      chips.appendChild(n);
    }
    if (chips.childElementCount) body.append(chips);

    if (!meal.tags || !meal.tags.length){
      const nt = document.createElement("div");
      nt.className = "no-tags";
      nt.textContent = "no tags — click to add";
      nt.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openEdit(meal.id);
        setTimeout(() => $("#edit-tags-input")?.focus(), 80);
      });
      body.appendChild(nt);
    }

    const controls = document.createElement("div");
    controls.className = "controls";
    const editBtn = document.createElement("button");
    editBtn.type = "button"; editBtn.className = "btn"; editBtn.textContent = "Edit";
    editBtn.addEventListener("click", (ev) => { ev.stopPropagation(); openEdit(meal.id); });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn danger card-del";
    del.innerHTML = "🗑";
    del.title = "Delete meal";
    del.setAttribute("aria-label", `Delete ${meal.title}`);
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete "${meal.title}"?`)) return;
      const idx = state.meals.findIndex(m => m.id === meal.id);
      if (idx === -1) return;
      const removed = state.meals[idx];
      state.meals.splice(idx, 1);
      state.selected.delete(meal.id);
      await saveAll();
      renderMeals(); renderShopping(); populateCookSelect();
      updateIngredientSuggestions(); refreshTagSuggestions(); updateSelectedCount();
      showUndoToast(`"${removed.title}" deleted`, async () => {
        // restore at the same index
        state.meals.splice(Math.min(idx, state.meals.length), 0, removed);
        await saveAll();
        renderMeals(); renderShopping(); populateCookSelect();
        updateIngredientSuggestions(); refreshTagSuggestions();
        status(`"${removed.title}" restored`);
      });
    });
    controls.append(editBtn, del);
    body.appendChild(controls);

    card.append(media, body);
    grid.appendChild(card);
  });

  syncMobileFiltersUI();
}

/* Density buttons */
$$("[data-density]").forEach(btn => btn.addEventListener("click", async () => {
  const mode = btn.dataset.density;
  document.documentElement.style.setProperty(
    "--card-min",
    mode === "compact" ? "200px" : mode === "cozy" ? "260px" : "320px"
  );
  state.prefs.gridMin = mode;
  await saveAll();
  renderMeals();
}));

/* ===== Contains filter (search by ingredient) ===== */
let containsEditor = null;
function refreshContainsBadge(){
  const btn = $("#contains-toggle");
  if (!btn) return;
  const n = state.containsFilter.size;
  btn.textContent = n ? `🥬 ${n} ingredient${n === 1 ? "" : "s"} ▾` : "🥬 Contains ▾";
  btn.classList.toggle("active", n > 0);
}
$("#contains-toggle")?.addEventListener("click", () => {
  const bar = $("#contains-bar");
  if (!bar) return;
  const opening = bar.hasAttribute("hidden");
  if (opening){
    bar.removeAttribute("hidden");
    if (!containsEditor){
      containsEditor = tokenEditor($("#contains-editor"), $("#contains-input"), Array.from(state.containsFilter));
      // Rewire to update state on every change
      const origGet = containsEditor.get;
      const sync = () => {
        state.containsFilter = new Set(origGet());
        refreshContainsBadge();
        renderMeals();
      };
      // Patch by observing the editor's container
      new MutationObserver(sync).observe($("#contains-editor"), { childList: true, subtree: true });
    }
    setTimeout(() => $("#contains-input")?.focus(), 30);
  } else {
    bar.setAttribute("hidden", "");
  }
});
$("#contains-clear")?.addEventListener("click", () => {
  state.containsFilter.clear();
  if (containsEditor) containsEditor.set([]);
  refreshContainsBadge();
  renderMeals();
});

/* Search */
$("#search")?.addEventListener("input", (e) => {
  state.search = (e.target.value || "").trim().toLowerCase();
  if ($("#search-m")) $("#search-m").value = e.target.value;
  renderMeals();
});
$("#search-m")?.addEventListener("input", (e) => {
  state.search = (e.target.value || "").trim().toLowerCase();
  if ($("#search")) $("#search").value = e.target.value;
  renderMeals();
});

/* Time filter (desktop) */
function clampTime(){
  const minEl = $("#time-min");
  const maxEl = $("#time-max");
  if (!minEl || !maxEl) return;
  let a = Number(minEl.value), b = Number(maxEl.value);
  if (a > b) [a, b] = [b, a];
  state.timeFilter.min = a; state.timeFilter.max = b;
  $("#time-label").textContent = `${a}–${b} min`;
  syncMobileFiltersUI();
}
function syncTimeSliders(){
  if ($("#time-min")) $("#time-min").value = String(state.timeFilter.min);
  if ($("#time-max")) $("#time-max").value = String(state.timeFilter.max);
  if ($("#time-label")) $("#time-label").textContent = `${state.timeFilter.min}–${state.timeFilter.max} min`;
  if ($("#m-time-min")) $("#m-time-min").value = String(state.timeFilter.min);
  if ($("#m-time-max")) $("#m-time-max").value = String(state.timeFilter.max);
  if ($("#m-time-label")) $("#m-time-label").textContent = `${state.timeFilter.min}–${state.timeFilter.max} min`;
}
$("#time-min")?.addEventListener("input", () => { clampTime(); renderMeals(); });
$("#time-max")?.addEventListener("input", () => { clampTime(); renderMeals(); });
$("#time-clear")?.addEventListener("click", (e) => {
  e.preventDefault();
  state.timeFilter.min = 0; state.timeFilter.max = 120;
  syncTimeSliders(); renderMeals();
});
$("#toggle-favs")?.addEventListener("click", () => {
  state.showFavsOnly = !state.showFavsOnly;
  $("#toggle-favs").textContent = state.showFavsOnly ? "Show all" : "Show favourites only";
  syncMobileFiltersUI(); renderMeals();
});

/* =====================================================
   SHOPPING LIST
   ===================================================== */
const shoppingWrap = $("#shopping");

function aggKey(i){
  const n = normaliseRaw(i.name);
  if (i.type === "grams") return `${n}|g`;
  if (i.type === "ml")    return `${n}|ml`;
  if (["tsp","tbsp","cup"].includes(i.type)) return `${n}|${i.type}`;
  return `${n}|qty|${(i.unit || "").toLowerCase()}`;
}
function aggregate(){
  const sel = state.meals.filter(m => state.selected.has(m.id));
  const map = new Map();
  for (const m of sel){
    for (const i of (m.ingredients || [])){
      const k = aggKey(i);
      const p = map.get(k) || { name:i.name, type:i.type, unit:i.unit, total:0 };
      p.total += Number(i.amount) || 0;
      map.set(k, p);
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.name.localeCompare(b.name, "en-GB", { sensitivity:"base" })
  );
}
function displayValueAndUnit(r){
  if (r.type === "ml")    return r.total >= 1000 ? { value:r.total/1000, unit:"L" } : { value:r.total, unit:"ml" };
  if (r.type === "grams") return r.total >= 1000 ? { value:r.total/1000, unit:"kg" } : { value:r.total, unit:"g" };
  if (["tsp","tbsp","cup"].includes(r.type)) return { value:r.total, unit:r.type };
  return { value:r.total, unit:(r.unit || "qty") };
}
/* Per-shop "I have it" ticks. Keyed by aggKey, lives in memory only. */
const haveIt = new Set();

function renderShopping(){
  shoppingWrap.innerHTML = "";
  const rows = aggregate();
  if (!rows.length){
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "Select meals to build your shopping list.";
    shoppingWrap.appendChild(d);
    updateSelectedCount();
    updateShoppingActions();
    return;
  }

  // Prune ticks for rows that no longer exist
  const liveKeys = new Set(rows.map(r => aggKey(r)));
  for (const k of Array.from(haveIt)) if (!liveKeys.has(k)) haveIt.delete(k);

  const table = document.createElement("table");
  table.className = "table shopping-table";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th class='col-tick' aria-label='Have'></th><th>Ingredient</th><th>Total</th><th>Unit</th><th class='col-merge' aria-label='Merge'></th></tr>";
  const tbody = document.createElement("tbody");

  rows.forEach(r => {
    const k = aggKey(r);
    const tr = document.createElement("tr");
    const ticked = haveIt.has(k);
    if (ticked) tr.classList.add("ticked");

    const { value, unit } = displayValueAndUnit(r);

    // Tick column
    const tdTick = document.createElement("td");
    tdTick.className = "col-tick";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = ticked;
    cb.setAttribute("aria-label", `I have ${r.name}`);
    cb.addEventListener("change", () => {
      if (cb.checked) haveIt.add(k); else haveIt.delete(k);
      tr.classList.toggle("ticked", cb.checked);
      updateShoppingActions();
    });
    tdTick.appendChild(cb);

    // Ingredient name
    const tdName = document.createElement("td");
    tdName.textContent = titleCase(r.name);

    // Total
    const tdTotal = document.createElement("td");
    tdTotal.textContent = formatNumber(value);
    tdTotal.className = "col-total";

    // Unit
    const tdUnit = document.createElement("td");
    tdUnit.textContent = unit;
    tdUnit.className = "col-unit";

    // Merge button
    const tdMerge = document.createElement("td");
    tdMerge.className = "col-merge";
    const merge = document.createElement("button");
    merge.type = "button";
    merge.className = "btn mini merge-btn";
    merge.textContent = "⇄";
    merge.title = `Merge "${r.name}" into a canonical name`;
    merge.setAttribute("aria-label", `Merge ${r.name}`);
    merge.addEventListener("click", () => openMergeDialog(r.name));
    tdMerge.appendChild(merge);

    tr.append(tdTick, tdName, tdTotal, tdUnit, tdMerge);
    tbody.appendChild(tr);
  });

  table.append(thead, tbody);
  shoppingWrap.appendChild(table);
  updateSelectedCount();
  updateShoppingActions();
}

function updateShoppingActions(){
  const tickedN = haveIt.size;
  const reset = $("#reset-ticks");
  if (reset){
    reset.disabled = tickedN === 0;
    reset.textContent = tickedN ? `Reset ticks (${tickedN})` : "Reset ticks";
  }
}

/* Reset ticks button (hooked up below in init handlers) */
function resetHaveItTicks(){
  haveIt.clear();
  renderShopping();
}

/* ===== Merge dialog: quick-add an alias to an existing canonical or create a new one ===== */
function openMergeDialog(rawName){
  // Build a list of canonical options
  const canonicals = state.normaliser.map(e => e.canonical);
  const wrap = document.createElement("div");
  wrap.className = "modal open";
  wrap.innerHTML = `
    <div class="dialog merge-dialog" style="max-width:520px">
      <div class="stickybar group space-between">
        <h3 class="h3">Merge "${escapeHtml(rawName)}"</h3>
        <button class="btn" data-close aria-label="Close">✕</button>
      </div>
      <p class="muted small" style="margin:0 0 10px;">
        Merge this ingredient into a canonical name. All existing meals using
        "<strong>${escapeHtml(rawName)}</strong>" will be updated.
      </p>

      <div class="form-row">
        <label>Merge into</label>
        <select id="merge-canonical">
          ${canonicals.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}
          <option value="__new__">+ Create new canonical…</option>
        </select>
      </div>

      <div id="merge-new-canonical-row" class="form-row" style="display:none;">
        <label for="merge-new-canonical">New canonical name</label>
        <input id="merge-new-canonical" type="text" placeholder="e.g. garlic" value="${escapeHtml(rawName)}" />
      </div>

      <div class="group" style="justify-content:flex-end;">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" id="merge-confirm">Merge</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  document.body.classList.add("modal-open");

  const close = () => {
    wrap.remove();
    if (!$(".modal.open")) document.body.classList.remove("modal-open");
  };
  wrap.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", close));
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });

  // If no existing canonicals, default to "create new" mode
  const sel = $("#merge-canonical", wrap);
  const newRow = $("#merge-new-canonical-row", wrap);
  if (!canonicals.length){
    sel.value = "__new__";
    newRow.style.display = "";
  }
  sel.addEventListener("change", () => {
    newRow.style.display = sel.value === "__new__" ? "" : "none";
    if (sel.value === "__new__") $("#merge-new-canonical", wrap).focus();
  });

  $("#merge-confirm", wrap).addEventListener("click", async () => {
    let canonical;
    if (sel.value === "__new__"){
      canonical = ($("#merge-new-canonical", wrap).value || "").trim().toLowerCase();
      if (!canonical) { alert("Please enter a canonical name."); return; }
    } else {
      canonical = sel.value;
    }
    const alias = normaliseRaw(rawName);

    // If a canonical entry already exists, just append the alias.
    // Otherwise create a new entry.
    let entry = state.normaliser.find(e => normaliseRaw(e.canonical) === canonical);
    if (entry){
      if (!entry.aliases) entry.aliases = [];
      if (alias !== normaliseRaw(entry.canonical) && !entry.aliases.map(normaliseRaw).includes(alias)){
        entry.aliases.push(alias);
      }
    } else {
      const aliases = (alias !== canonical) ? [alias] : [];
      state.normaliser.push({ canonical, aliases });
    }

    // Apply across existing meals
    const changed = applyNormaliserAcrossMeals();
    await saveAll();
    renderMeals(); renderShopping();
    updateIngredientSuggestions(); refreshTagSuggestions();
    close();
    status(changed
      ? `Merged "${rawName}" → "${canonical}" (${changed} meal${changed === 1 ? "" : "s"})`
      : `Merged "${rawName}" → "${canonical}"`);
  });
}

/* TSV copy with mobile fallback */
function showFallbackTSV(tsv){
  // small modal-ish overlay to allow manual copy on iOS where clipboard often fails
  const wrap = document.createElement("div");
  wrap.className = "modal open";
  wrap.innerHTML = `
    <div class="dialog" style="max-width:680px">
      <div class="stickybar group space-between">
        <h3 class="h3">Copy shopping list</h3>
        <button class="btn" data-close>✕</button>
      </div>
      <p class="muted">Long-press / select-all and copy.</p>
      <textarea readonly style="height:240px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;"></textarea>
    </div>
  `;
  document.body.appendChild(wrap);
  const ta = wrap.querySelector("textarea");
  ta.value = tsv;
  ta.focus(); ta.select();
  wrap.addEventListener("click", (e) => { if (e.target === wrap) wrap.remove(); });
  wrap.querySelector("[data-close]").addEventListener("click", () => wrap.remove());
}

$("#copy-tsv")?.addEventListener("click", async () => {
  const allRows = aggregate();
  if (!allRows.length){ status("No items to copy."); return; }
  const rows = allRows.filter(r => !haveIt.has(aggKey(r)));
  if (!rows.length){ status("Everything is ticked — nothing to copy."); return; }
  const selectedCount = state.selected.size;
  const tickedCount = allRows.length - rows.length;
  const header = ["Ingredient", "Total", "Unit"];
  const body = rows.map(r => {
    const { value, unit } = displayValueAndUnit(r);
    return [titleCase(r.name), String(value), unit];
  });
  const top = [
    ["Meals selected", String(selectedCount), ""]
  ];
  if (tickedCount) top.push(["Skipped (ticked as 'have')", String(tickedCount), ""]);
  top.push(["", "", ""]);
  top.push(header);
  const tsv = [...top, ...body]
    .map(cols => cols.map(v => String(v).replaceAll("\t", " ")).join("\t"))
    .join("\n");

  try {
    if (navigator.clipboard && window.isSecureContext){
      await navigator.clipboard.writeText(tsv);
      status(tickedCount
        ? `Copied ${rows.length} items (${tickedCount} skipped).`
        : `Copied ${rows.length} items.`);
      return;
    }
    throw new Error("clipboard unavailable");
  } catch {
    showFallbackTSV(tsv);
  }
});
$("#print")?.addEventListener("click", () => window.print());
$("#reset-ticks")?.addEventListener("click", resetHaveItTicks);

/* =====================================================
   COOK MODE
   ===================================================== */
function populateCookSelect(){
  const dd = $("#cook-meal");
  if (!dd) return;
  if (!state.meals.length){
    dd.innerHTML = "";
    $("#cook-meta").textContent = "";
    $("#cook-steps").innerHTML = `<div class="empty">No meals saved yet.</div>`;
    return;
  }
  dd.innerHTML = state.meals
    .slice()
    .sort((a, b) => (a.title || "").localeCompare(b.title || "", "en-GB", { sensitivity:"base" }))
    .map(m => `<option value="${m.id}">${escapeHtml(m.title)}</option>`)
    .join("");
  const last = localStorage.getItem(COOK_LAST_KEY);
  const exists = last && state.meals.some(m => m.id === last);
  dd.value = exists ? last : dd.value;
  renderCook(dd.value);
}
function renderCook(id){
  const meal = state.meals.find(m => m.id === id);
  if (!meal) return;
  localStorage.setItem(COOK_LAST_KEY, meal.id);

  const meta = $("#cook-meta");
  const stepsWrap = $("#cook-steps");
  const bits = [];
  if (typeof meal.cookMins === "number") bits.push(`⏱ ${meal.cookMins} min`);
  if (Array.isArray(meal.ingredients) && meal.ingredients.length) bits.push(`🥕 ${meal.ingredients.length} ingredient${meal.ingredients.length === 1 ? "" : "s"}`);
  if (meal.notes && meal.notes.trim()) bits.push(`📝 ${meal.notes.trim()}`);
  meta.textContent = bits.join("  •  ");

  const steps = Array.isArray(meal.steps) ? meal.steps : [];
  if (!steps.length){
    stepsWrap.innerHTML = `<div class="empty">No steps saved for this meal.</div>`;
    return;
  }
  stepsWrap.innerHTML = steps.map((s, i) => `
    <label>
      <input type="checkbox" />
      <div><b>${i + 1}.</b> ${escapeHtml(s)}</div>
    </label>
  `).join("");
}
$("#cook-meal")?.addEventListener("change", (e) => renderCook(e.target.value));

/* =====================================================
   EXPORT / IMPORT / CLEAR
   ===================================================== */
$("#export")?.addEventListener("click", () => {
  const data = JSON.stringify({
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    meals: state.meals,
    normaliser: state.normaliser,
    unitDefaults: state.unitDefaults,
    prefs: state.prefs
  }, null, 2);

  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `meal-planner-${stamp}-v${EXPORT_SCHEMA_VERSION}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  status("Exported.");
});

function migrateImport(json){
  if (!json || typeof json !== "object") return null;
  if (!Array.isArray(json.meals)) return null;
  const meals = json.meals.map(m => {
    const clone = {
      fav: false,
      tags: [],
      cookMins: (typeof m.cookMins === "number") ? m.cookMins : null,
      steps: Array.isArray(m.steps) ? m.steps.map(x => String(x)) : [],
      notes: (typeof m.notes === "string") ? m.notes : "",
      ingredients: [],
      ...m
    };
    // older imageDataUrl -> image
    if (clone.imageDataUrl){
      clone.image = { type:"data", src: clone.imageDataUrl };
      delete clone.imageDataUrl;
    }
    // sanitise ingredients
    clone.ingredients = (clone.ingredients || []).map(i => ({
      name: normaliseRaw(i.name),
      type: ["grams","ml","tsp","tbsp","cup","qty"].includes(i.type) ? i.type : "grams",
      amount: Number(i.amount) || 0,
      unit: typeof i.unit === "string" ? i.unit : ""
    })).filter(i => i.name);
    if (!clone.id) clone.id = uid();
    return clone;
  });
  return {
    meals,
    normaliser: Array.isArray(json.normaliser) ? json.normaliser : [],
    unitDefaults: (json.unitDefaults && typeof json.unitDefaults === "object") ? json.unitDefaults : {},
    prefs: (json.prefs && typeof json.prefs === "object") ? json.prefs : state.prefs
  };
}
$("#import")?.addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try{
    const json = JSON.parse(await f.text());
    const migrated = migrateImport(json);
    if (!migrated) throw new Error("Invalid file");

    if (!confirm(`Import will REPLACE current data with ${migrated.meals.length} meal${migrated.meals.length === 1 ? "" : "s"}. Continue?`)){
      e.target.value = ""; return;
    }
    state.meals = migrated.meals;
    state.normaliser = migrated.normaliser || [];
    state.unitDefaults = migrated.unitDefaults || {};
    state.prefs = { ...state.prefs, ...(migrated.prefs || {}) };
    state.selected.clear();

    await saveAll();
    applyTheme();
    renderMeals(); renderShopping(); populateCookSelect();
    updateIngredientSuggestions(); refreshTagSuggestions(); updateSelectedCount();
    status(`Imported ${migrated.meals.length} meal${migrated.meals.length === 1 ? "" : "s"}.`);
  } catch(err){
    console.error(err);
    alert("Import failed. Expecting a JSON file exported by this app.");
  } finally {
    e.target.value = "";
  }
});

$("#clear-all")?.addEventListener("click", async () => {
  if (!state.meals.length){ status("Nothing to clear."); return; }
  if (!confirm("Delete ALL saved meals? This cannot be undone (export first if needed).")) return;
  state.meals = [];
  state.selected.clear();
  await saveAll();
  renderMeals(); renderShopping(); populateCookSelect();
  updateIngredientSuggestions(); refreshTagSuggestions(); updateSelectedCount();
  status("All meals cleared.");
});

/* =====================================================
   SETTINGS MODAL
   ===================================================== */
const settingsModal = $("#settings-modal");
function openSettings(){
  renderSettings();
  settingsModal.classList.add("open");
  settingsModal.setAttribute("aria-hidden", "false");
  lockBodyScroll(true);
}
function closeSettings(){
  settingsModal.classList.remove("open");
  settingsModal.setAttribute("aria-hidden", "true");
  lockBodyScroll(false);
}
$("#settings")?.addEventListener("click", openSettings);
$("#settings-close")?.addEventListener("click", closeSettings);

function renderSettings(){
  const nt = $("#norm-table tbody");
  nt.innerHTML = "";
  state.normaliser.forEach((e, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(e.canonical)}</td>
      <td>${escapeHtml((e.aliases || []).join(", "))}</td>
      <td><button class="btn mini" data-del-norm="${idx}">Delete</button></td>`;
    nt.appendChild(tr);
  });
  $$("[data-del-norm]", nt).forEach(b => b.addEventListener("click", async (ev) => {
    const i = Number(ev.currentTarget.getAttribute("data-del-norm"));
    state.normaliser.splice(i, 1);
    await saveAll();
    renderSettings();
  }));

  const ut = $("#unit-table tbody");
  ut.innerHTML = "";
  Object.entries(state.unitDefaults)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([name, def]) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(def.type)}</td>
        <td>${escapeHtml(def.unitLabel || "")}</td>
        <td>${def.locked ? "yes" : "no"}</td>
        <td><button class="btn mini" data-del-unit="${escapeHtml(name)}">Delete</button></td>`;
      ut.appendChild(tr);
    });
  $$("[data-del-unit]", ut).forEach(b => b.addEventListener("click", async (ev) => {
    const key = ev.currentTarget.getAttribute("data-del-unit");
    delete state.unitDefaults[key];
    await saveAll();
    renderSettings();
  }));
}

$("#backfill-tags")?.addEventListener("click", async () => {
  if (!state.meals.length){ status("No meals saved."); return; }
  let changed = 0;
  for (const m of state.meals){
    const auto = ingredientNamesToTags(m.ingredients || []);
    const set = new Set((m.tags || []).map(t => t.toLowerCase()));
    auto.forEach(t => set.add(t));
    const next = Array.from(set);
    if (JSON.stringify(next) !== JSON.stringify(m.tags || [])){
      m.tags = next; changed++;
    }
  }
  await saveAll();
  refreshTagSuggestions(); renderMeals();
  status(changed ? `Backfilled tags on ${changed} meal${changed === 1 ? "" : "s"}.` : "Nothing to backfill.");
});

/* ===== Data cleanup (singularise units, fill missing qty labels) ===== */
let cleanupPreviewData = null;
$("#cleanup-preview")?.addEventListener("click", () => {
  const results = $("#cleanup-results");
  const applyBtn = $("#cleanup-apply");
  if (!state.meals.length){
    results.style.display = "block";
    results.innerHTML = "<em>No meals saved yet.</em>";
    applyBtn.disabled = true;
    return;
  }
  cleanupPreviewData = cleanupIngredientUnits(false);
  results.style.display = "block";

  if (!cleanupPreviewData.totalChanges){
    results.innerHTML = "<em>Nothing to clean up — your data already looks tidy. ✓</em>";
    applyBtn.disabled = true;
    return;
  }

  // Group changes by before→after for compactness
  const grouped = new Map();
  cleanupPreviewData.changes.forEach(c => {
    const key = `${c.before} → ${c.after}`;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  });
  const summaryRows = Array.from(grouped.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<li><code>${escapeHtml(k)}</code> &mdash; ${n} time${n === 1 ? "" : "s"}</li>`)
    .join("");

  results.innerHTML = `
    <strong>${cleanupPreviewData.totalChanges} change${cleanupPreviewData.totalChanges === 1 ? "" : "s"} would be made:</strong>
    <ul style="margin:6px 0 0; padding-left:20px;">${summaryRows}</ul>
  `;
  applyBtn.disabled = false;
});
$("#cleanup-apply")?.addEventListener("click", async () => {
  if (!cleanupPreviewData || !cleanupPreviewData.totalChanges) return;
  const result = cleanupIngredientUnits(true);
  await saveAll();
  renderMeals();
  renderShopping();
  cleanupPreviewData = null;
  $("#cleanup-results").innerHTML = `<em>✓ Applied ${result.totalChanges} change${result.totalChanges === 1 ? "" : "s"}.</em>`;
  $("#cleanup-apply").disabled = true;
  status(`Cleaned up ${result.totalChanges} ingredient${result.totalChanges === 1 ? "" : "s"}.`);
});

$("#norm-add")?.addEventListener("click", async () => {
  const c = $("#norm-canonical").value.trim();
  const a = $("#norm-aliases").value.split(",").map(s => s.trim()).filter(Boolean);
  if (!c){ alert("Enter a canonical name."); return; }
  const applyToExisting = $("#norm-apply-existing")?.checked;

  // append new entry (canonical lowercased; aliases lowercased)
  state.normaliser.push({
    canonical: normaliseRaw(c),
    aliases: a.map(normaliseRaw)
  });

  $("#norm-canonical").value = "";
  $("#norm-aliases").value = "";

  let changedMeals = 0;
  if (applyToExisting){
    changedMeals = applyNormaliserAcrossMeals();
  }

  await saveAll();
  renderSettings();
  renderMeals(); renderShopping();
  updateIngredientSuggestions(); refreshTagSuggestions();

  status(applyToExisting && changedMeals
    ? `Normaliser added — merged across ${changedMeals} meal${changedMeals === 1 ? "" : "s"}.`
    : "Normaliser entry added.");
});

$("#unit-add")?.addEventListener("click", async () => {
  const n = $("#unit-name").value.trim();
  const t = $("#unit-type").value;
  const l = $("#unit-label").value.trim();
  const locked = $("#unit-locked").checked;
  if (!n){ alert("Enter an ingredient name."); return; }
  const key = normaliseKey(n);
  state.unitDefaults[key] = { type:t, unitLabel: l || undefined, locked };
  $("#unit-name").value = "";
  $("#unit-label").value = "";
  $("#unit-locked").checked = false;
  await saveAll();
  renderSettings();
  status("Unit default saved.");
});

/* =====================================================
   INIT
   ===================================================== */
(async () => {
  await loadAll();
  applyTheme();

  document.documentElement.style.setProperty(
    "--card-min",
    state.prefs.gridMin === "compact" ? "200px" :
    state.prefs.gridMin === "cozy"    ? "260px" : "320px"
  );

  updateIngredientSuggestions();
  refreshTagSuggestions();
  setupMobileAddPanel();
  setView("meals");

  syncTimeSliders();
  clampTime();

  renderMeals();
  renderShopping();
  populateCookSelect();
  updateSelectedCount();
})();
