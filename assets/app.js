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
  prefs: "prefs",
  pantry: "pantry",     // ingredient keys you always have
  history: "history",   // { mealId: { count, dates[] } } — times chosen for a shop
  session: "session",   // current shop: selected meals, ticks (not exported)
  cooklog: "cooklog",   // { mealId: [{ date, rating, note }] } — times actually cooked
  cookQueue: "cookQueue", // [{ mealId, added, x? }] — "This week" meals to cook (not exported)
  thumbs: "thumbs",       // { mealId: { src, of } } — grid thumbnails, rebuildable (not exported)
  plan: "plan",           // { "YYYY-MM-DD": [{ mealId, x?, pin?, skipped? }] } — planner (exported)
  pins: "pins"            // { "0".."6": [mealId] } — meals pinned to a weekday, every week (exported)
};
const EXPORT_SCHEMA_VERSION = 14;
const DEFAULT_PREFS = {
  theme: "auto",
  gridMin: "cozy",
  includeIngredientTags: false,
  tagStripMax: 12,
  mealSort: "az",
  cookUnits: "asWritten",  // cook mode: asWritten | metric | us
  mealView: "",            // "grid" | "list"; "" = grid on tablet/desktop, list on phone
  textSize: "normal",      // normal | large | xlarge
  settingsTab: "appearance",
  avoid: [],               // ingredient keys: meals containing any are hidden and never suggested
  planDays: [1,2,3,4,5,6,0], // days auto-fill plans for (0 = Sun … 6 = Sat)
  planSpan: 7,             // planner shows 7 or 14 days
  planLayout: "list"       // planner layout: "list" | "calendar"
};
const HISTORY_MAX_DATES = 50;
const COOKLOG_MAX = 30;
const NO_TAGS = "__NO_TAGS__";

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
  prefs: { ...DEFAULT_PREFS },

  pantry: new Set(),        // ingredient keys
  history: {},
  cooklog: {},
  cookQueue: [],
  thumbs: {},
  plan: {},
  pins: {},
  haveIt: new Set(),        // shopping rows ticked as "have it" (row keys)
  pantryUse: new Set(),     // staples pulled back into the list for this shop
  countedIds: new Set(),    // meals already counted in history for this shop
  doubled: new Set(),       // "cook once, eat twice": selected meals bought ×2 this shop

  timeFilter: { min: 0, max: 120 },
  view: "today",            // phone: the one visible view
  leftView: "today"         // split view: which tab the left pane shows
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
/* Legacy key — only used to find unit defaults saved by older builds. */
function normaliseKey(s){
  return String(s ?? "").trim().toLowerCase()
    .replace(/[-_]/g," ")
    .replace(/\s+/g," ")
    .replace(/[^a-z0-9\s]/g,"");
}

/* Singularise one English word. Conservative: words ending -ss/-us/-is are
   left alone (couscous, lemongrass, hummus), as are known non-plurals. */
const SINGULAR_IRREGULAR = {
  leaves:"leaf", loaves:"loaf", halves:"half", molasses:"molasses",
  chillies:"chilli", chilies:"chili"   // not "chilly"
};
function singulariseWord(w){
  if (SINGULAR_IRREGULAR[w]) return SINGULAR_IRREGULAR[w];
  if (w.length <= 3 || !w.endsWith("s")) return w;
  if (/(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + "y";
  if (/oes$/.test(w)) return w.slice(0, -2);
  if (/(ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  return w.slice(0, -1);
}

/* Matching key for an ingredient (or tag) name: accents stripped, punctuation
   dropped, last word singularised. "Cashew Nuts" and "cashew nut" share a key,
   as do "tomato purée" / "tomato puree" and "Henderson's" / "hendersons". */
function ingredientKey(s){
  const base = String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) return "";
  const words = base.split(" ");
  words[words.length - 1] = singulariseWord(words[words.length - 1]);
  return words.join(" ");
}

/* Singular form of a stored name, keeping its punctuation and accents. */
function singularName(s){
  const raw = normaliseRaw(s);
  const m = raw.match(/^(.*?)([a-z]+)$/);
  return m ? m[1] + singulariseWord(m[2]) : raw;
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
  const sing = singulariseWord(raw);
  return UNIT_LABEL_ALIASES[sing] || sing;
}

/* ============== Tidy ingredients (Settings) ==============
   An opt-in rewrite of stored data. planTidy() lists suggested changes;
   applyTidy() applies the ones ticked and returns a snapshot for Undo.
   The shopping list already merges plurals without any of this. */
const SUGGESTED_MERGES = [
  ["bulgar wheat", "bulgur wheat"],
  ["tomato purée", "tomato paste"],
  ["garlic clove", "garlic"],
  ["fresh root ginger", "ginger"],
  ["mozzarella cheese", "mozzarella"],
  ["parmesan cheese", "parmesan"],
  ["baby leaf spinach", "baby spinach"],
  ["chicken breast fillet", "chicken breast"],
  ["lemongrass stalk", "lemongrass"]
];
const SUGGESTED_UNIT_FIXES = [
  { id:"garlic-clove", match: k => k === "garlic", from:"piece", to:"clove",
    note:"a “piece” might be a whole bulb — check before applying" },
  { id:"stock-cube", match: k => k.endsWith("stock cube"), from:"cube", to:"piece" }
];

function planTidy(){
  const uses = new Map();
  state.meals.forEach(m => (m.ingredients || []).forEach(i => uses.set(i.name, (uses.get(i.name) || 0) + 1)));
  const names = Array.from(uses.keys()).sort();
  const items = [];

  // 1. Synonym merges — only those whose alias appears in your meals
  for (const [alias, canonical] of SUGGESTED_MERGES){
    const ak = ingredientKey(alias);
    if (ak === ingredientKey(canonical)) continue;
    const hits = names.filter(n => ingredientKey(n) === ak);
    if (!hits.length) continue;
    items.push({
      group:"merge", id:`merge:${ak}`, checked:true,
      label:`${hits.join(" / ")} → ${canonical}`,
      uses: hits.reduce((s, h) => s + uses.get(h), 0),
      aliases: hits, canonical
    });
  }

  // 2. Singular names. Ticked when both forms are in use (real duplicates);
  //    otherwise listed unticked — purely cosmetic.
  for (const n of names){
    const to = singularName(n);
    if (to === n) continue;
    items.push({
      group:"singular", id:`sing:${n}`, checked: names.some(o => o !== n && ingredientKey(o) === ingredientKey(n)),
      label:`${n} → ${to}`, uses: uses.get(n), from:n, to
    });
  }

  // 3. Unit fixes for known mixed units
  for (const fix of SUGGESTED_UNIT_FIXES){
    const hit = new Map();   // ingredient name -> uses
    state.meals.forEach(m => (m.ingredients || []).forEach(i => {
      if (i.type !== "qty" || normaliseUnitLabel(i.unit) !== fix.from) return;
      if (!fix.match(ingredientKey(canonicalName(i.name)))) return;
      hit.set(i.name, (hit.get(i.name) || 0) + 1);
    }));
    if (!hit.size) continue;
    items.push({
      group:"units", id:`unit:${fix.id}`, checked:false,
      label:`${Array.from(hit.keys()).join(" / ")}: ${fix.from} → ${fix.to}`,
      note: fix.note, uses: Array.from(hit.values()).reduce((a, b) => a + b, 0), fix
    });
  }

  // 4. Unit labels: plural → singular, and quantity with no label → "piece"
  const labelFix = new Map();
  state.meals.forEach(m => (m.ingredients || []).forEach(i => {
    if (i.type !== "qty") return;
    const to = i.unit ? singulariseUnitLabel(i.unit) : "piece";
    if (to !== (i.unit || "")) labelFix.set(`${i.unit || "(none)"} → ${to}`, (labelFix.get(`${i.unit || "(none)"} → ${to}`) || 0) + 1);
  }));
  for (const [label, n] of labelFix){
    items.push({ group:"units", id:`label:${label}`, checked:true, label:`unit label ${label}`, uses:n, labelFix:true });
  }

  // 5. Unit defaults saved under old (plural / punctuated) keys
  const rekey = Object.keys(state.unitDefaults).filter(k => ingredientKey(canonicalName(k)) !== k);
  if (rekey.length){
    items.push({
      group:"defaults", id:"rekey", checked:true,
      label:`Update ${rekey.length} unit default${rekey.length === 1 ? "" : "s"} to the new matching names (e.g. ${rekey.slice(0, 3).join(", ")})`,
      uses: rekey.length, rekey:true
    });
  }
  return items;
}

function applyTidy(items){
  const snapshot = {
    meals: new Map(state.meals.map(m => [m.id, JSON.stringify({ ingredients: m.ingredients, tags: m.tags })])),
    normaliser: JSON.stringify(state.normaliser),
    unitDefaults: JSON.stringify(state.unitDefaults)
  };
  const eachIng = fn => state.meals.forEach(m => (m.ingredients || []).forEach(i => fn(i, m)));

  const merges = items.filter(x => x.group === "merge");
  merges.forEach(x => addNormaliserAliases(x.canonical, x.aliases));
  if (merges.length) applyNormaliserAcrossMeals();

  const sing = new Map(items.filter(x => x.group === "singular").map(x => [x.from, x.to]));
  if (sing.size) eachIng(i => { if (sing.has(i.name)) i.name = sing.get(i.name); });

  items.filter(x => x.fix).forEach(({ fix }) => eachIng(i => {
    if (i.type === "qty" && normaliseUnitLabel(i.unit) === fix.from && fix.match(ingredientKey(canonicalName(i.name)))) i.unit = fix.to;
  }));

  if (items.some(x => x.labelFix)){
    eachIng(i => { if (i.type === "qty") i.unit = i.unit ? singulariseUnitLabel(i.unit) : "piece"; });
  }

  if (items.some(x => x.rekey)){
    const next = {};
    for (const [k, def] of Object.entries(state.unitDefaults)){
      const nk = ingredientKey(canonicalName(k));
      if (!next[nk] || k === nk) next[nk] = def;
    }
    state.unitDefaults = next;
  }
  return snapshot;
}
function restoreTidy(snapshot){
  for (const m of state.meals){
    const s = snapshot.meals.get(m.id);
    if (!s) continue;
    const { ingredients, tags } = JSON.parse(s);
    m.ingredients = ingredients; m.tags = tags;
  }
  state.normaliser = JSON.parse(snapshot.normaliser);
  state.unitDefaults = JSON.parse(snapshot.unitDefaults);
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

/* Toast with one action button (Undo, Open Ocado…). The button stays for
   `ms` ms then disappears. Calling status() again will replace it. */
function showActionToast(msg, label, onAction, ms = 6000){
  const toast = $("#toast");
  if (!toast) return;
  toast.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = msg;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-undo";
  btn.textContent = label;
  btn.addEventListener("click", async () => {
    clearTimeout(toastTimer);
    toast.classList.remove("show");
    try { await onAction(); } catch (e) { console.error(`${label} failed:`, e); }
  });
  toast.append(span, btn);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), ms);
}
function showUndoToast(msg, onUndo, ms = 6000){
  showActionToast(msg, "Undo", onUndo, ms);
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
    idbSet(IDB_KEYS.prefs, state.prefs),
    idbSet(IDB_KEYS.pantry, Array.from(state.pantry)),
    idbSet(IDB_KEYS.history, state.history),
    idbSet(IDB_KEYS.cooklog, state.cooklog),
    idbSet(IDB_KEYS.cookQueue, state.cookQueue),
    idbSet(IDB_KEYS.plan, state.plan),
    idbSet(IDB_KEYS.pins, state.pins),
    saveSession()
  ]);
}
/* Plan: drop unknown meals and anything older than 12 weeks */
function cleanPlan(plan, ids){
  const out = {};
  if (!plan || typeof plan !== "object") return out;
  const cutoff = new Date(Date.now() - 84 * 864e5).toISOString().slice(0, 10);
  for (const [day, items] of Object.entries(plan)){
    if (!/^\d{4}-\d\d-\d\d$/.test(day) || day < cutoff || !Array.isArray(items)) continue;
    const keep = items.filter(e => e && ids.has(e.mealId)).map(e => {
      const o = { mealId: e.mealId };
      if (e.x === 2) o.x = 2;
      if (e.pin) o.pin = true;           // came from a weekday pin
      if (e.skipped) o.skipped = true;   // pin skipped this week (kept so it isn't re-added)
      return o;
    });
    if (keep.length) out[day] = keep;
  }
  return out;
}
/* Pins: { weekday: [mealId] } with known meals only */
function cleanPins(pins, ids){
  const out = {};
  if (!pins || typeof pins !== "object") return out;
  for (const [d, list] of Object.entries(pins)){
    if (!/^[0-6]$/.test(d) || !Array.isArray(list)) continue;
    const keep = [...new Set(list.filter(id => ids.has(id)))];
    if (keep.length) out[d] = keep;
  }
  return out;
}

/* Small, frequent writes: the current shop (selection + ticks). Keeps the
   shopping list alive if Android kills the app mid-shop. */
function saveSession(){
  return idbSet(IDB_KEYS.session, {
    selected: Array.from(state.selected),
    haveIt: Array.from(state.haveIt),
    pantryUse: Array.from(state.pantryUse),
    countedIds: Array.from(state.countedIds),
    doubled: Array.from(state.doubled)
  }).catch(err => console.warn("Session save failed:", err));
}
async function loadAll(){
  const [meals, normaliser, unitDefaults, prefs, pantry, history, session, cooklog, cookQueue, thumbs, plan, pins] = await Promise.all([
    idbGet(IDB_KEYS.meals),
    idbGet(IDB_KEYS.normaliser),
    idbGet(IDB_KEYS.unitDefaults),
    idbGet(IDB_KEYS.prefs),
    idbGet(IDB_KEYS.pantry),
    idbGet(IDB_KEYS.history),
    idbGet(IDB_KEYS.session),
    idbGet(IDB_KEYS.cooklog),
    idbGet(IDB_KEYS.cookQueue),
    idbGet(IDB_KEYS.thumbs),
    idbGet(IDB_KEYS.plan),
    idbGet(IDB_KEYS.pins)
  ]);
  if (Array.isArray(meals)){
    state.meals = meals.map(m => ({
      fav: false, tags: [], steps: [], notes: "", ingredients: [], cookMins: null,
      ...m
    }));
  }
  state.normaliser   = Array.isArray(normaliser) ? normaliser : [];
  state.unitDefaults = (unitDefaults && typeof unitDefaults === "object") ? unitDefaults : {};
  state.prefs        = { ...DEFAULT_PREFS, ...((prefs && typeof prefs === "object") ? prefs : {}) };
  state.pantry       = new Set(Array.isArray(pantry) ? pantry : []);
  state.history      = (history && typeof history === "object") ? history : {};

  const ids = new Set(state.meals.map(m => m.id));
  for (const id of Object.keys(state.history)) if (!ids.has(id)) delete state.history[id];
  state.cooklog   = (cooklog && typeof cooklog === "object") ? cooklog : {};
  for (const id of Object.keys(state.cooklog)) if (!ids.has(id)) delete state.cooklog[id];
  state.cookQueue = (Array.isArray(cookQueue) ? cookQueue : []).filter(q => ids.has(q.mealId));
  state.thumbs    = (thumbs && typeof thumbs === "object") ? thumbs : {};
  for (const id of Object.keys(state.thumbs)) if (!ids.has(id)) delete state.thumbs[id];
  state.plan      = cleanPlan(plan, ids);
  state.pins      = cleanPins(pins, ids);

  const s = (session && typeof session === "object") ? session : {};
  state.selected   = new Set((s.selected || []).filter(id => ids.has(id)));
  state.haveIt     = new Set(s.haveIt || []);
  state.pantryUse  = new Set(s.pantryUse || []);
  state.countedIds = new Set((s.countedIds || []).filter(id => ids.has(id)));
  state.doubled    = new Set((s.doubled || []).filter(id => ids.has(id)));
}

/* ============== Theme ============== */
/* Themes: auto | light | dark | black (OLED: true black backgrounds) */
function applyTheme(){
  let mode = state.prefs.theme;
  if (mode === "auto"){
    mode = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light" : "dark";
  }
  if (!["light", "dark", "black"].includes(mode)) mode = "dark";
  document.documentElement.setAttribute("data-theme", mode);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content",
    mode === "light" ? "#f6f7fb" : mode === "black" ? "#000000" : "#0b0f1a");
  $$("[data-theme-set]").forEach(b => b.classList.toggle("active", b.dataset.themeSet === state.prefs.theme));
}
$$("[data-theme-set]").forEach(b => b.addEventListener("click", async () => {
  state.prefs.theme = b.dataset.themeSet;
  applyTheme();
  await saveAll();
}));
window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => {
  if (state.prefs.theme === "auto") applyTheme();
});

/* ============== View switching ============== */
/* Below SPLIT_MIN_PX: phone layout, one view at a time + bottom nav.
   At or above: split view — Meals/Cook on the left, Shopping list on the right.
   Keep in sync with the 839px / 840px media queries in styles.css. */
const SPLIT_MIN_PX = 840;
/* "today" is the landing screen (tonight's meal, the week, the shopping list,
   and cooking — it replaced the Cook tab, so "cook" is an alias for it). */
const VIEWS = ["today", "meals", "plan", "shopping"];
function isMobile(){ return window.matchMedia(`(max-width:${SPLIT_MIN_PX - 1}px)`).matches; }
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function setView(view){
  if (view === "add"){ openAddSheet(); return; }
  if (view === "cook") view = "today";
  if (!VIEWS.includes(view)) view = "today";
  state.view = view;
  if (view !== "shopping") state.leftView = view;

  // body[data-view] drives which panel shows on phones (see styles.css)
  document.body.dataset.view = view;
  $("#view-today")?.classList.toggle("active", state.leftView === "today");
  $("#view-meals")?.classList.toggle("active", state.leftView === "meals");
  $("#view-plan")?.classList.toggle("active", state.leftView === "plan");
  $$("#pane-tabs .tab").forEach(b => b.classList.toggle("active", b.dataset.view === state.leftView));
  $$("#bottom-nav .navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  if (state.leftView === "today") window.populateCookSelect?.();
  if (state.leftView === "plan") window.renderPlan?.();
  showHintFor(view);
}
/* Tab switches animate (cross-fade) where the browser supports View Transitions */
function switchView(view){
  const go = () => { setView(view); if (isMobile()) window.scrollTo({ top:0 }); };
  if (document.startViewTransition && !reducedMotion()) document.startViewTransition(go);
  else go();
}
$$("#bottom-nav .navbtn, #pane-tabs .tab").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));

/* Haptics: a short buzz for ticks, selections and swipes (Android) */
function haptic(ms = 12){ try { navigator.vibrate?.(ms); } catch { /* unsupported */ } }

/* ============== First-time hints (one per screen, shown once) ============== */
const HINTS = {
  today:    "This is Today: tonight's meal, your week and the shopping list at a glance. Tap Cook when you're ready.",
  meals:    "Tap a meal to open it. Tap + on its photo to add it to the shopping list.",
  plan:     "Auto-fill plans the week from your meals. Open a meal's menu to pin it to a weekday every week.",
  shopping: "Swipe an item right to tick it off as you shop; swipe left to undo."
};
const HINTS_KEY = "hints-seen-v18";
function hintsSeen(){ try { return JSON.parse(localStorage.getItem(HINTS_KEY) || "[]"); } catch { return []; } }
let hintShowing = null;
function showHintFor(view){
  const el = $("#hint");
  if (!el) return;
  if (!HINTS[view] || hintsSeen().includes(view) || $(".modal.open")){ el.hidden = true; hintShowing = null; return; }
  hintShowing = view;
  $("#hint-text").textContent = HINTS[view];
  el.hidden = false;
}
$("#hint-ok")?.addEventListener("click", () => {
  const seen = new Set(hintsSeen()); if (hintShowing) seen.add(hintShowing);
  try { localStorage.setItem(HINTS_KEY, JSON.stringify([...seen])); } catch { /* private mode */ }
  $("#hint").hidden = true;
  hintShowing = null;
});
$("#hints-reset")?.addEventListener("click", () => {
  try { localStorage.removeItem(HINTS_KEY); } catch { /* ok */ }
  status("Tips will show again on each screen.");
});

/* ============== What's new (once per version; also Settings › About) ============== */
const APP_VERSION = 19;
const WHATS_NEW_KEY = "whatsnew-seen";
const WHATS_NEW = [
  ["steps",    "Cook mode: see what's coming", "Each step now shows the step before it (faded) and the next few steps below — tap any of them to jump there. Turn it off with the list button at the top of cook mode."],
  ["play",     "\"First up\" on the Get ready page", "See the first steps before you start, so you know what to prep."]
];
function openWhatsNew(){
  $("#whatsnew-body").innerHTML = `<p class="muted small">Version ${APP_VERSION}</p><ul class="whatsnew-list">${
    WHATS_NEW.map(([ic, t, d]) => `<li><span class="wn-ic">${icon(ic, 20)}</span><span><b>${escapeHtml(t)}</b><br><span class="muted">${escapeHtml(d)}</span></span></li>`).join("")}</ul>`;
  $("#whatsnew").classList.add("open");
  $("#whatsnew").setAttribute("aria-hidden", "false");
  lockBodyScroll(true);
}
/* Marked as seen only when closed, so an update reload while it's open shows it again */
function closeWhatsNew(){
  local.set(WHATS_NEW_KEY, String(APP_VERSION));
  $("#whatsnew").classList.remove("open");
  $("#whatsnew").setAttribute("aria-hidden", "true");
  lockBodyScroll(false);
}
/* Returning users see it once after updating; a brand-new install doesn't. */
function maybeShowWhatsNew(){
  if (local.get(WHATS_NEW_KEY) === String(APP_VERSION)) return;
  if (!state.meals.length){ local.set(WHATS_NEW_KEY, String(APP_VERSION)); return; }
  if ($(".modal.open")) return;
  openWhatsNew();
}
$("#whatsnew-close")?.addEventListener("click", closeWhatsNew);
$("#whatsnew")?.addEventListener("click", (e) => { if (e.target.id === "whatsnew") closeWhatsNew(); });
$("#whatsnew-open")?.addEventListener("click", () => { closeSettings(); openWhatsNew(); });

/* Header height feeds the sticky shopping pane's offset. */
function syncHeaderHeight(){
  const h = $("header")?.offsetHeight || 0;
  document.documentElement.style.setProperty("--header-h", `${h}px`);
}
window.addEventListener("resize", syncHeaderHeight);

/* ============== Add-meal sheet ============== */
const addModal = $("#add-modal");
function openAddSheet(){
  addModal.classList.add("open");
  addModal.setAttribute("aria-hidden", "false");
  lockBodyScroll(true);
  $("#add-open")?.classList.add("active");
  $$("#bottom-nav .navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === "add"));
  setTimeout(() => $("#title")?.focus(), 60);
}
function closeAddSheet(){
  addModal.classList.remove("open");
  addModal.setAttribute("aria-hidden", "true");
  lockBodyScroll(false);
  $$("#bottom-nav .navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === state.view));
}
$("#add-open")?.addEventListener("click", openAddSheet);
$("#add-close")?.addEventListener("click", closeAddSheet);

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
/* Crop part of a photo (File or data URL) to a compressed data URL.
   box = [ymin, xmin, ymax, xmax] on 0–1000, as the scan server returns it. */
async function cropImageToDataURL(src, box){
  let objectUrl = null;
  try {
    const img = new Image();
    if (src instanceof Blob){ objectUrl = URL.createObjectURL(src); img.src = objectUrl; }
    else img.src = src;
    await img.decode();
    const W = img.naturalWidth, H = img.naturalHeight;
    const [y0, x0, y1, x1] = box;
    const sx = Math.round(x0 / 1000 * W), sy = Math.round(y0 / 1000 * H);
    const sw = Math.max(1, Math.round((x1 - x0) / 1000 * W)), sh = Math.max(1, Math.round((y1 - y0) / 1000 * H));
    const scale = Math.min(1, 1400 / Math.max(sw, sh));
    const c = document.createElement("canvas");
    c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const mime = canvasSupportsType("image/webp") ? "image/webp" : "image/jpeg";
    return c.toDataURL(mime, 0.86);
  } catch (err){
    console.warn("Crop failed:", err);
    return null;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

/* Edit form: a photo waiting to be saved (from "Take dish photo from a recipe card") */
let editPendingImage = null;
function setEditPendingImage(dataUrl){
  editPendingImage = dataUrl || null;
  const box = document.getElementById("edit-photo-pending");
  if (!box) return;
  box.hidden = !editPendingImage;
  const img = box.querySelector("img");
  if (img) img.src = editPendingImage || "";
}

/* A meal without a photo: a warm colour pair picked from its title, its
   initials and a plate-and-cutlery mark — clearly a placeholder, not a broken image. */
const PLACEHOLDER_HUES = [[14, 32], [28, 45], [150, 170], [200, 220], [265, 290], [340, 10], [95, 120], [45, 25]];
function placeholderSvg(text){
  const title = String(text || "Meal");
  let h = 0; for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [a, b] = PLACEHOLDER_HUES[h % PLACEHOLDER_HUES.length];
  const initials = title.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(w => w && !/^(with|and|the|of|in|a)$/i.test(w))
    .slice(0, 2).map(w => w[0].toUpperCase()).join("") || "M";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 400' preserveAspectRatio='xMidYMid slice'>
    <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
      <stop offset='0' stop-color='hsl(${a} 55% 42%)'/><stop offset='1' stop-color='hsl(${b} 60% 26%)'/>
    </linearGradient></defs>
    <rect width='100%' height='100%' fill='url(#g)'/>
    <circle cx='320' cy='175' r='92' fill='none' stroke='rgba(255,255,255,.28)' stroke-width='6'/>
    <circle cx='320' cy='175' r='64' fill='rgba(255,255,255,.10)'/>
    <path d='M190 110v62a16 16 0 0 0 16 16h0M206 110v130M222 110v62a16 16 0 0 1-16 16' fill='none' stroke='rgba(255,255,255,.35)' stroke-width='7' stroke-linecap='round'/>
    <path d='M450 110c-20 8-26 40-26 60 0 14 10 20 22 20h4v50' fill='none' stroke='rgba(255,255,255,.35)' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/>
    <text x='320' y='178' dominant-baseline='middle' text-anchor='middle' font-family='Bricolage Grotesque, system-ui, sans-serif' font-weight='700' font-size='64' fill='rgba(255,255,255,.92)'>${initials}</text>
  </svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

/* ============== Normaliser lookup ============== */
function normaliserLookup(name){
  const key = ingredientKey(name);
  if (!key) return null;
  for (const e of state.normaliser){
    if (ingredientKey(e.canonical) === key) return normaliseRaw(e.canonical);
    for (const a of (e.aliases || [])){
      if (ingredientKey(a) === key) return normaliseRaw(e.canonical);
    }
  }
  return null;
}
/* Canonical name for an ingredient: normaliser match, else the name as typed. */
function canonicalName(name){
  return normaliserLookup(name) || normaliseRaw(name);
}
/* Unit default for an ingredient name. Tries the current key, then the
   pre-v12 key (plural, punctuation-sensitive) so older entries still apply. */
function unitDefaultFor(name){
  const key = ingredientKey(canonicalName(name));
  return state.unitDefaults[key] || state.unitDefaults[normaliseKey(name)] || null;
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
/* The unit label only means something for "quantity" rows; hide it otherwise. */
function syncIngredientRowType(row){
  const [, typeEl, amtEl] = row.children;
  const isQty = typeEl.value === "qty";
  row.classList.toggle("is-qty", isQty);
  if (isQty){
    amtEl.step = "1";
    if (amtEl.value) amtEl.value = String(Math.max(0, Math.round(parseFloat(amtEl.value) || 0)));
  } else {
    amtEl.step = "any";
  }
}

/* existing=true when the row is loading a saved ingredient: then only a
   *locked* default may change it, so opening Edit never rewrites saved units. */
function maybeApplyUnitDefault(row, existing = false){
  const [nameEl, typeEl, , unitEl] = row.children;
  if (!ingredientKey(nameEl.value)) return;
  const def = unitDefaultFor(nameEl.value);
  const locked = !!def?.locked;
  if (def && (!existing || locked)){
    typeEl.value = def.type;
    if (def.unitLabel) unitEl.value = def.unitLabel;
  }
  typeEl.disabled = locked;
  unitEl.disabled = locked && def?.type === "qty";
  typeEl.title = locked ? "Locked by unit defaults (Settings)" : "";
  unitEl.title = typeEl.title;
  syncIngredientRowType(row);
}

/* ============== Paste a block of ingredients ==============
   "200g chicken thigh", "2 tbsp soy sauce", "1½ tsp cumin", "3 cloves garlic",
   "1 red onion, chopped", "salt" → rows (amount, type, unit, name). */
const FRACTION_CHARS = { "½":0.5, "¼":0.25, "¾":0.75, "⅓":1/3, "⅔":2/3, "⅛":0.125 };
const PASTE_UNITS = [
  [/^(kg|kilos?|kilograms?)$/, "grams", 1000], [/^(g|grams?|gr)$/, "grams", 1],
  [/^(l|litres?|liters?)$/, "ml", 1000], [/^(ml|millilitres?|milliliters?)$/, "ml", 1],
  [/^(tsps?|teaspoons?)$/, "tsp", 1], [/^(tbsps?|tablespoons?|tbs)$/, "tbsp", 1],
  [/^(cups?)$/, "cup", 1]
];
const PASTE_QTY_UNITS = ["clove", "tin", "can", "pack", "packet", "bunch", "sprig", "slice", "piece", "handful",
  "pinch", "stalk", "sheet", "jar", "bag", "punnet", "fillet", "rasher", "cube", "ball", "pod", "knob", "head"];
function parseAmount(s){
  s = s.trim();
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);                 // 1 1/2
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = s.match(/^(\d+)\/(\d+)$/);                              // 1/2
  if (m) return Number(m[1]) / Number(m[2]);
  m = s.match(/^(\d*)([½¼¾⅓⅔⅛])$/);                           // 1½, ½
  if (m) return (Number(m[1]) || 0) + FRACTION_CHARS[m[2]];
  const n = Number(s.replace(",", "."));
  return isFinite(n) ? n : null;
}
function parseIngredientLine(line){
  let s = String(line).replace(/^[\s\-•*·–]+/, "").replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  s = s.split(/,| - /)[0].trim();                             // drop ", chopped"
  const m = s.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d*[½¼¾⅓⅔⅛]|\d+(?:[.,]\d+)?)\s*(?:x\s*)?([a-zA-Z]+\.?)?\s*(?:of\s+)?(.*)$/);
  if (!m) return { name: normaliseRaw(s), type:"qty", amount:1, unit:"piece" };   // "salt"
  const amount = parseAmount(m[1]) ?? 1;
  const word = (m[2] || "").replace(/\.$/, "").toLowerCase();
  const rest = (m[3] || "").trim();
  for (const [re, type, mult] of PASTE_UNITS){
    if (re.test(word)) return { name: normaliseRaw(rest), type, amount: Math.round(amount * mult * 100) / 100, unit:"" };
  }
  const qtyUnit = singulariseWord(word);
  if (word && PASTE_QTY_UNITS.includes(qtyUnit)) return { name: normaliseRaw(rest), type:"qty", amount: Math.max(1, Math.round(amount)), unit: qtyUnit };
  // no unit up front ("1 red onion"): the word is part of the name…
  const words = normaliseRaw(`${word} ${rest}`.trim()).split(" ");
  // …unless the name ends with one ("2 garlic cloves" → 2 clove garlic)
  const tail = singulariseWord(words[words.length - 1]);
  if (words.length > 1 && PASTE_QTY_UNITS.includes(tail)){
    return { name: words.slice(0, -1).join(" "), type:"qty", amount: Math.max(1, Math.round(amount)), unit: tail };
  }
  return { name: words.join(" "), type:"qty", amount: Math.max(1, Math.round(amount)), unit:"piece" };
}
let pasteTarget = null;
function openPaste(containerId){
  pasteTarget = document.getElementById(containerId);
  $("#paste-text").value = "";
  $("#paste-preview").innerHTML = "";
  $("#paste-modal").classList.add("open");
  $("#paste-modal").setAttribute("aria-hidden", "false");
  lockBodyScroll(true);
  setTimeout(() => $("#paste-text")?.focus(), 50);
}
function closePaste(){
  $("#paste-modal").classList.remove("open");
  $("#paste-modal").setAttribute("aria-hidden", "true");
  lockBodyScroll(false);
}
function pasteParsed(){
  return ($("#paste-text").value || "").split(/\r?\n/).map(parseIngredientLine).filter(r => r && r.name);
}
$$("[data-paste-into]").forEach(b => b.addEventListener("click", () => openPaste(b.dataset.pasteInto)));
$("#paste-text")?.addEventListener("input", () => {
  const rows = pasteParsed();
  $("#paste-preview").innerHTML = rows.length
    ? `<ul class="ov-ings">${rows.map(r => `<li><span>${escapeHtml(titleCase(r.name))}</span><span class="muted">${formatNumber(r.amount)} ${escapeHtml(r.type === "qty" ? r.unit : r.type === "grams" ? "g" : r.type)}</span></li>`).join("")}</ul>`
    : "";
});
$("#paste-add")?.addEventListener("click", () => {
  const rows = pasteParsed();
  if (!rows.length || !pasteTarget){ closePaste(); return; }
  // replace blank rows first, then append
  $$(".ingredient-row", pasteTarget).forEach(r => { if (!r.children[0].value.trim()) r.remove(); });
  rows.forEach(r => addIngredientRow(pasteTarget, { ...r, name: canonicalName(r.name) }, { focus:false }));
  closePaste();
  status(`Added ${rows.length} ingredient${rows.length === 1 ? "" : "s"} — check the amounts.`);
});
$("#paste-close")?.addEventListener("click", closePaste);
$("#paste-cancel")?.addEventListener("click", closePaste);

/* ============== Drag to reorder ingredient rows (⋮⋮ handle) ============== */
document.addEventListener("pointerdown", (e) => {
  const handle = e.target.closest(".drag-handle");
  if (!handle) return;
  const row = handle.closest(".ingredient-row");
  const list = row?.parentElement;
  if (!row || !list) return;
  e.preventDefault();
  row.classList.add("dragging");
  try { handle.setPointerCapture(e.pointerId); } catch { /* ok */ }
  const move = (ev) => {
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".ingredient-row");
    if (!over || over === row || over.parentElement !== list) return;
    const r = over.getBoundingClientRect();
    list.insertBefore(row, ev.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  };
  const up = () => {
    row.classList.remove("dragging");
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
});

function addIngredientRow(container, pref = {}, opts = {}){
  const row = $("#ingredient-template").content.firstElementChild.cloneNode(true);
  const [nameEl, typeEl, amtEl, unitEl, rmBtn] = row.children;

  nameEl.value = pref.name || "";
  typeEl.value = pref.type || "grams";
  amtEl.value  = (pref.amount ?? "");
  unitEl.value = pref.unit || "";
  syncIngredientRowType(row);

  typeEl.addEventListener("change", () => syncIngredientRowType(row));
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
  if (nameEl.value) maybeApplyUnitDefault(row, true);
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
  // Stay locked while any modal is still open (e.g. Scan over Add)
  document.body.classList.toggle("modal-open", !!locked || !!$(".modal.open, .cook-overlay.open"));
}


/* Cook time in minutes, or null when blank/invalid. Same limit as Scan. */
const MAX_COOK_MINS = 600;
function parseCookMins(raw){
  raw = String(raw ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  return isFinite(n) ? Math.max(0, Math.min(MAX_COOK_MINS, n)) : null;
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

    const cookMins = parseCookMins($("#cook-mins").value);

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
    closeAddSheet();
    setView("meals");
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
  setEditPendingImage(null);
  $("#edit-form").reset();
  editIng.innerHTML = "";
  editSteps = [];
  refreshEditSteps();
  $("#edit-notes").value = "";
  lockBodyScroll(false);
}
$("#edit-close")?.addEventListener("click", closeEdit);
$("#edit-delete")?.addEventListener("click", async () => {
  const id = state.editingId;
  if (id && await deleteMeal(id)){ closeEdit(); closeMealView(); }
});
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

  if (editPendingImage) meal.image = { type:"data", src: editPendingImage };
  const f = $("#edit-image-file").files[0];
  if (f){
    const data = await fileToCompressedDataURL(f);
    if (data) meal.image = { type:"data", src:data };
  }

  meal.cookMins = parseCookMins($("#edit-cook-mins").value);

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
  refreshMealView();
  status("Meal updated.");
});

/* Escape closes modals & popovers */
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if ($("#filters-modal")?.classList.contains("open")) closeFilters();
  if ($("#settings-modal")?.classList.contains("open")) closeSettings();
  if (editModal?.classList.contains("open")) closeEdit();
  else if (viewingId && !$("#scan-modal")?.classList.contains("open")) closeMealView();
  if (addModal?.classList.contains("open") && !$("#scan-modal")?.classList.contains("open")) closeAddSheet();
  if (popEl) closePopover();
  if (searchSheet?.classList.contains("open")) closeSearch();
  if ($("#whatsnew")?.classList.contains("open")) closeWhatsNew();
});

/* =====================================================
   TAG BAR + POPOVER
   Tags are identified by ingredientKey(), so "tomato" and "tomatoes" are one
   tag; the label shown is the most common spelling.
   ===================================================== */
function mostCommon(countMap){
  let best = "", bestN = -1;
  for (const [s, n] of countMap){
    if (n > bestN || (n === bestN && s.length < best.length)){ best = s; bestN = n; }
  }
  return best;
}
function computeTagStats(){
  const counts = new Map();    // key -> meals
  const spellings = new Map(); // key -> Map(spelling -> uses)
  const ingKeys = new Set();
  state.meals.forEach(m => (m.ingredients || []).forEach(i => ingKeys.add(ingredientKey(i.name))));
  state.meals.forEach(m => {
    const seen = new Set();
    (m.tags || []).forEach(t => {
      const k = ingredientKey(t);
      if (!k) return;
      const sp = spellings.get(k) || new Map();
      const label = String(t).toLowerCase();
      sp.set(label, (sp.get(label) || 0) + 1);
      spellings.set(k, sp);
      if (!seen.has(k)){ seen.add(k); counts.set(k, (counts.get(k) || 0) + 1); }
    });
  });
  const rows = Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, label: mostCommon(spellings.get(tag)), count, isIngredient: ingKeys.has(tag) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const noTagsCount = state.meals.filter(m => !m.tags || !m.tags.length).length;
  return { rows, noTagsCount };
}
function pruneTagFilter(){
  const all = new Set();
  state.meals.forEach(m => (m.tags || []).forEach(t => all.add(ingredientKey(t))));
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
      const r = rows.find(r => r.tag === t);
      list.push({ tag:t, label: r?.label || t, count: r?.count || 0 });
    }
  });
  // Real tags (cuisine, "quick"…) first; ingredient-name tags only if switched on, after them
  rows.filter(r => !r.isIngredient).forEach(r => { if (!list.find(x => x.tag === r.tag)) list.push(r); });
  if (includeIng) rows.filter(r => r.isIngredient).forEach(r => { if (!list.find(x => x.tag === r.tag)) list.push(r); });

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
    b.innerHTML = `${escapeHtml(x.label)}${x.count ? ` <span class="count">${x.count}</span>` : ""}`;
    b.addEventListener("click", () => toggleTag(x.tag));
    bar.appendChild(b);
  });

  const mode = state.tagMode === "ALL" ? "ALL" : "ANY";
  $("#tag-active").textContent = state.tagFilter.size ? `${state.tagFilter.size} selected (${mode})` : "";
  $("#m-tag-active") && ($("#m-tag-active").textContent = state.tagFilter.size ? `${state.tagFilter.size} selected (${mode})` : "");
  refreshFiltersBadge();
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
    const items = [sentinel, ...candidates]
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
   FILTERS MODAL (all sizes)
   ===================================================== */
const TIME_FILTER_MAX = 120;   // slider top end means "120+ min"
const filtersModal = $("#filters-modal");
function openFilters(){
  filtersModal.classList.add("open");
  filtersModal.setAttribute("aria-hidden", "false");
  lockBodyScroll(true);
  syncFiltersUI();
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

function timeLabel(){
  const { min, max } = state.timeFilter;
  return max >= TIME_FILTER_MAX ? `${min}–${TIME_FILTER_MAX}+ min` : `${min}–${max} min`;
}
function timeFilterActive(){
  return state.timeFilter.min > 0 || state.timeFilter.max < TIME_FILTER_MAX;
}
function refreshFiltersBadge(){
  const n = (state.showFavsOnly ? 1 : 0) + (timeFilterActive() ? 1 : 0) + (state.tagFilter.size ? 1 : 0)
    + (state.containsFilter.size ? 1 : 0) + ((state.prefs.mealSort || "az") !== "az" ? 1 : 0);
  const label = $("#open-filters-label");
  if (label) label.textContent = n ? `Filter & sort (${n})` : "Filter & sort";
  $("#open-filters")?.classList.toggle("active", n > 0);
}
$("#filters-reset")?.addEventListener("click", async () => {
  state.showFavsOnly = false;
  state.timeFilter.min = 0; state.timeFilter.max = TIME_FILTER_MAX;
  state.tagFilter.clear();
  state.containsFilter.clear(); containsEditor?.set([]);
  state.prefs.mealSort = "az"; syncSortUI();
  syncFiltersUI(); renderMeals();
  await idbSet(IDB_KEYS.prefs, state.prefs);
});

/* Active filters as removable chips under the toolbar */
const SORT_LABELS = { most:"Most chosen", least:"Least chosen", oldest:"Longest since chosen", cooked:"Most cooked", rated:"Top rated" };
function renderActiveFilters(){
  const wrap = $("#active-filters");
  if (!wrap) return;
  const chips = [];
  if (state.search) chips.push({ label: `“${state.search}”`, clear: () => { state.search = ""; $("#search").value = ""; } });
  if ((state.prefs.mealSort || "az") !== "az") chips.push({ label: `Sort: ${SORT_LABELS[state.prefs.mealSort]}`, clear: () => { state.prefs.mealSort = "az"; syncSortUI(); idbSet(IDB_KEYS.prefs, state.prefs); } });
  if (state.showFavsOnly) chips.push({ label: "Favourites", clear: () => { state.showFavsOnly = false; } });
  if (timeFilterActive()) chips.push({ label: timeLabel(), clear: () => { state.timeFilter.min = 0; state.timeFilter.max = TIME_FILTER_MAX; } });
  const { rows } = computeTagStats();
  for (const t of state.tagFilter) chips.push({ label: t === NO_TAGS ? "No tags" : `#${rows.find(r => r.tag === t)?.label || t}`, clear: () => { state.tagFilter.delete(t); } });
  for (const c of state.containsFilter) chips.push({ label: `Has ${c}`, clear: () => { state.containsFilter.delete(c); containsEditor?.set([...state.containsFilter]); } });
  wrap.hidden = !chips.length;
  wrap.innerHTML = chips.map((c, i) => `<button type="button" class="filter-chip" data-chip="${i}" aria-label="Remove filter ${escapeHtml(c.label)}">${escapeHtml(c.label)}${icon("x", 14)}</button>`).join("")
    + (chips.length > 1 ? `<button type="button" class="filter-chip clear-all" data-chip="all">Clear all</button>` : "");
  $$("[data-chip]", wrap).forEach(b => b.addEventListener("click", () => {
    if (b.dataset.chip === "all") chips.forEach(c => c.clear()); else chips[Number(b.dataset.chip)].clear();
    syncFiltersUI(); renderMeals();
  }));
}
function syncFiltersUI(){
  $("#m-time-min").value = String(state.timeFilter.min);
  $("#m-time-max").value = String(state.timeFilter.max);
  $("#m-time-label").textContent = timeLabel();
  $("#m-favs").textContent = state.showFavsOnly ? "Show all" : "Show favourites only";
  $("#m-tag-active").textContent = state.tagFilter.size
    ? `${state.tagFilter.size} selected (${state.tagMode === "ALL" ? "ALL" : "ANY"})` : "";
  refreshFiltersBadge();
}
function clampTime(){
  let a = Number($("#m-time-min").value);
  let b = Number($("#m-time-max").value);
  if (a > b) [a, b] = [b, a];
  state.timeFilter.min = a; state.timeFilter.max = b;
  syncFiltersUI();
  renderMeals();
}
$("#m-time-min")?.addEventListener("input", clampTime);
$("#m-time-max")?.addEventListener("input", clampTime);
$("#m-time-clear")?.addEventListener("click", () => {
  state.timeFilter.min = 0; state.timeFilter.max = TIME_FILTER_MAX;
  syncFiltersUI(); renderMeals();
});
$("#m-favs")?.addEventListener("click", () => {
  state.showFavsOnly = !state.showFavsOnly;
  syncFiltersUI(); renderMeals();
});

/* =====================================================
   MEALS RENDER
   ===================================================== */
const grid = $("#meal-grid");

/* Avoid list (Settings › Ingredients): meals containing any of these are hidden
   and never suggested. Matches whole words, so "nut" catches "cashew nut". */
function mealAvoided(m){
  const avoid = state.prefs.avoid || [];
  if (!avoid.length) return false;
  return (m.ingredients || []).some(i => {
    const k = ` ${ingredientKey(canonicalName(i.name))} `;
    return avoid.some(a => k.includes(` ${a} `));
  });
}

function visibleMeals(){
  let items = state.meals.filter(m => !mealAvoided(m));
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
    const need = [...state.containsFilter].map(s => ingredientKey(canonicalName(s)));
    items = items.filter(m => {
      const ingKeys = (m.ingredients || []).map(i => ingredientKey(i.name));
      return need.every(n => ingKeys.some(ing => ing.includes(n)));
    });
  }

  if (state.tagFilter.size){
    const need = [...state.tagFilter];
    items = items.filter(m => {
      const hasNoTags = !m.tags || !m.tags.length;
      const tags = new Set((m.tags || []).map(ingredientKey));
      if (state.tagMode === "ANY") return need.some(t => t === NO_TAGS ? hasNoTags : tags.has(t));
      return need.every(t => t === NO_TAGS ? hasNoTags : tags.has(t));
    });
  }
  if (timeFilterActive()){
    const { min, max } = state.timeFilter;
    items = items.filter(m => {
      const t = m.cookMins;
      if (typeof t !== "number") return false;
      return t >= min && (max >= TIME_FILTER_MAX || t <= max);
    });
  }

  const byTitle = (a, b) => (a.title || "").localeCompare(b.title || "", "en-GB", { sensitivity:"base" });
  const count = m => state.history[m.id]?.count || 0;
  const last  = m => lastChosen(m.id) || "";
  const sorts = {
    az:     (a, b) => ((b.fav === true) - (a.fav === true)) || byTitle(a, b),
    most:   (a, b) => (count(b) - count(a)) || byTitle(a, b),
    least:  (a, b) => (count(a) - count(b)) || byTitle(a, b),
    oldest: (a, b) => last(a).localeCompare(last(b)) || byTitle(a, b),  // never chosen ("") first
    rated:  (a, b) => ((cookStats(b.id).avg ?? -1) - (cookStats(a.id).avg ?? -1)) || byTitle(a, b),
    cooked: (a, b) => (cookStats(b.id).count - cookStats(a.id).count) || byTitle(a, b)
  };
  return items.sort(sorts[state.prefs.mealSort] || sorts.az);
}

/* ============== Meal history (times chosen for a shop) ============== */
function lastChosen(id){
  const d = state.history[id]?.dates;
  return d && d.length ? d[d.length - 1] : null;
}
function formatShortDate(iso){
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day:"numeric", month:"short" });
}
/* Count each selected meal once per shop. Called when the list is used
   (Ocado, Share, Copy as TSV, Print). Clear selection starts a new shop. */
async function recordShopUse(){
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (const id of state.selected){
    if (state.countedIds.has(id)) continue;
    const h = state.history[id] || { count:0, dates:[] };
    h.count += 1;
    h.dates = [...(h.dates || []), today].slice(-HISTORY_MAX_DATES);
    state.history[id] = h;
    state.countedIds.add(id);
    if (!state.cookQueue.some(q => q.mealId === id)){
      state.cookQueue.push(state.doubled.has(id) ? { mealId:id, added:today, x:2 } : { mealId:id, added:today });
    }
    n++;
  }
  if (!n) return;
  await Promise.all([idbSet(IDB_KEYS.history, state.history), idbSet(IDB_KEYS.cookQueue, state.cookQueue), saveSession()]);
  renderMeals();
  window.renderCookTab?.();   // cook.js
}

/* ============== Cook log (times actually cooked) ============== */
function cookStats(id){
  const log = state.cooklog[id] || [];
  const rated = log.filter(e => typeof e.rating === "number");
  return {
    count: log.length,
    avg: rated.length ? rated.reduce((s, e) => s + e.rating, 0) / rated.length : null,
    last: log[log.length - 1] || null
  };
}
async function logCooked(id, rating, note){
  const log = state.cooklog[id] || [];
  log.push({ date: new Date().toISOString().slice(0, 10), rating: rating || null, note: (note || "").trim() });
  state.cooklog[id] = log.slice(-COOKLOG_MAX);
  state.cookQueue = state.cookQueue.filter(q => q.mealId !== id);
  await Promise.all([idbSet(IDB_KEYS.cooklog, state.cooklog), idbSet(IDB_KEYS.cookQueue, state.cookQueue)]);
  renderMeals();
}

/* ============== Meal actions (cards, meal page, menus) ============== */
async function setSelected(id, on){
  if (on) state.selected.add(id);
  else { state.selected.delete(id); state.doubled.delete(id); syncQueueBatch(id); }
  saveSession();
  updateCard(id); renderShopping();
  refreshMealView();
}
/* "Cook once, eat twice": only for meals in the current shop */
function toggleDoubled(id){
  if (!state.selected.has(id)) return;
  if (state.doubled.has(id)) state.doubled.delete(id); else state.doubled.add(id);
  syncQueueBatch(id);
  saveSession();
  updateCard(id); renderShopping();
  refreshMealView();
}
/* If this shop was already exported, keep its "This week" entry's ×2 in step. */
function syncQueueBatch(id){
  if (!state.countedIds.has(id)) return;
  const q = state.cookQueue.find(e => e.mealId === id);
  if (!q) return;
  if (state.doubled.has(id)) q.x = 2; else delete q.x;
  idbSet(IDB_KEYS.cookQueue, state.cookQueue);
  window.renderCookTab?.();
}
/* Refresh one card in place (tick, ×2) — no full grid rebuild. */
/* Refresh one card in place (tick, ×2, ★): its photo element is kept, so nothing flickers */
function updateCard(id){
  const card = grid.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  const meal = state.meals.find(m => m.id === id);
  if (!card || !meal){ renderMeals(); return; }
  const fresh = buildCard(meal);
  const oldImg = card.querySelector("img"), newImg = fresh.querySelector("img");
  if (oldImg && newImg) newImg.replaceWith(oldImg);
  card.replaceWith(fresh);
  if (state.selected.has(id)) fresh.classList.add("just-picked");
}
async function toggleFav(id){
  const m = state.meals.find(x => x.id === id);
  if (!m) return;
  m.fav = !m.fav;
  await saveAll();
  renderMeals();
  refreshMealView();
}
async function duplicateMeal(id){
  const idx = state.meals.findIndex(m => m.id === id);
  if (idx === -1) return;
  const copy = JSON.parse(JSON.stringify(state.meals[idx]));
  copy.id = uid();
  copy.title = `${copy.title} (copy)`;
  state.meals.splice(idx + 1, 0, copy);
  await saveAll();
  renderMeals(); populateCookSelect();
  status(`Duplicated "${state.meals[idx].title}".`);
  return copy.id;
}
/* Delete with confirm + Undo. Used by the card menu, the meal page and Edit. */
async function deleteMeal(id){
  const idx = state.meals.findIndex(m => m.id === id);
  if (idx === -1) return false;
  const removed = state.meals[idx];
  if (!confirm(`Delete "${removed.title}"?`)) return false;
  state.meals.splice(idx, 1);
  state.selected.delete(id);
  state.doubled.delete(id);
  state.countedIds.delete(id);
  await saveAll();
  renderMeals(); renderShopping(); populateCookSelect();
  updateIngredientSuggestions(); refreshTagSuggestions();
  const UNDO_MS = 6000;
  showUndoToast(`"${removed.title}" deleted`, async () => {
    state.meals.splice(Math.min(idx, state.meals.length), 0, removed);   // same position
    await saveAll();
    renderMeals(); renderShopping(); populateCookSelect();
    updateIngredientSuggestions(); refreshTagSuggestions();
    status(`"${removed.title}" restored`);
  }, UNDO_MS);
  // Drop its history once Undo is no longer possible (loadAll also prunes orphans)
  setTimeout(() => {
    if (state.meals.some(m => m.id === removed.id)) return;   // restored via Undo
    delete state.history[removed.id];
    delete state.cooklog[removed.id];
    delete state.thumbs[removed.id];
    for (const d of Object.keys(state.pins)){
      state.pins[d] = state.pins[d].filter(x => x !== removed.id);
      if (!state.pins[d].length) delete state.pins[d];
    }
    idbSet(IDB_KEYS.pins, state.pins);
    state.cookQueue = state.cookQueue.filter(q => q.mealId !== removed.id);
    idbSet(IDB_KEYS.history, state.history);
    idbSet(IDB_KEYS.cooklog, state.cooklog);
    idbSet(IDB_KEYS.cookQueue, state.cookQueue);
    idbSet(IDB_KEYS.thumbs, state.thumbs);
  }, UNDO_MS + 500);
  return true;
}

/* Small pop-up menu (⋯) anchored to a button. items: [{label, danger?, run}] */
let menuEl = null;
function closeMenu(){
  menuEl?.remove(); menuEl = null;
  document.removeEventListener("click", closeMenu);
}
function openMenu(anchor, items){
  closeMenu();
  const r = anchor.getBoundingClientRect();
  const m = document.createElement("div");
  m.className = "menu-list floating-menu";
  m.setAttribute("role", "menu");
  for (const it of items){
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn" + (it.danger ? " danger" : "");
    b.innerHTML = (it.icon ? icon(it.icon, 18) : "") + escapeHtml(it.label);
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); it.run(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  m.style.top = `${r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  menuEl = m;
  m.addEventListener("click", e => e.stopPropagation());
  setTimeout(() => document.addEventListener("click", closeMenu), 0);
}
function mealMenuItems(id, anchor){
  return [
    { icon: "plan", label: "Add to plan…", run: () => openMenu(anchor, window.planMenuItems?.(id) || []) },
    { icon: "edit", label: "Edit", run: () => { closeMealView(); openEdit(id); } },
    { icon: "copy", label: "Duplicate", run: () => duplicateMeal(id) },
    { icon: "trash", label: "Delete", danger: true, run: async () => { if (await deleteMeal(id)) closeMealView(); } }
  ];
}

function mealChips(meal, { withDoubled = true } = {}){
  const out = [];
  if (typeof meal.cookMins === "number") out.push(`<span class="chip">${icon("clock", 13)}${meal.cookMins} min</span>`);
  if (meal.steps?.length) out.push(`<span class="chip">${icon("steps", 13)}${meal.steps.length} step${meal.steps.length === 1 ? "" : "s"}</span>`);
  const hist = state.history[meal.id];
  if (hist?.count) out.push(`<span class="chip chip-history" title="Chosen for ${hist.count} shop${hist.count === 1 ? "" : "s"}">${icon("cart", 13)}Shopped ×${hist.count} · ${escapeHtml(formatShortDate(lastChosen(meal.id)))}</span>`);
  const cs = cookStats(meal.id);
  if (cs.count) out.push(`<span class="chip chip-history" title="Cooked ${cs.count} time${cs.count === 1 ? "" : "s"}">${icon("cook", 13)}Cooked ×${cs.count}${cs.avg != null ? ` · ★${formatNumber(Math.round(cs.avg * 10) / 10)}` : ""}</span>`);
  if (withDoubled && state.doubled.has(meal.id) && state.selected.has(meal.id)) out.push(`<span class="chip chip-x2">×2 leftovers</span>`);
  return out.join("");
}

/* Grid view: magazine card — the photo carries the title, time and rating; details are on the meal page.
   List view: compact row with chips, ×2 and ⋯. */
function buildCard(meal){
  const sel = state.selected.has(meal.id), dbl = state.doubled.has(meal.id);
  const list = effectiveMealView() === "list";
  const cs = cookStats(meal.id);
  const card = document.createElement("article");
  card.className = "card" + (sel ? " selected" : "") + (list ? "" : " mag");
  card.tabIndex = 0;
  card.dataset.id = meal.id;
  card.setAttribute("aria-label", `${meal.title} — open`);
  const pick = `<button type="button" class="pick" aria-pressed="${sel}" aria-label="${sel ? "Remove from" : "Add to"} shop: ${escapeHtml(meal.title)}">${icon(sel ? "check" : "plus", 20)}</button>`;
  const star = `<button type="button" class="star ${meal.fav ? "on" : ""}" aria-pressed="${!!meal.fav}" aria-label="${meal.fav ? "Unfavourite" : "Favourite"}">${icon(meal.fav ? "star-filled" : "star", 20)}</button>`;
  const meta = [
    typeof meal.cookMins === "number" ? `<span>${icon("clock", 14)}${meal.cookMins} min</span>` : "",
    cs.avg != null ? `<span>${icon("star-filled", 14, "gold")}${formatNumber(Math.round(cs.avg * 10) / 10)}</span>` : ""
  ].join("");
  if (!list){
    card.innerHTML = `
      <div class="media">
        <img alt="" loading="lazy" decoding="async" />
        <div class="scrim"></div>
        ${pick}${star}
        <div class="mag-text">
          ${sel ? `<span class="mag-pill">In this shop${dbl ? " · ×2" : ""}</span>` : ""}
          <h3>${escapeHtml(meal.title)}</h3>
          ${meta ? `<div class="mag-meta">${meta}</div>` : ""}
        </div>
      </div>`;
  } else {
    card.innerHTML = `
      <div class="media">
        <img alt="" loading="lazy" decoding="async" />
        ${pick}${star}
      </div>
      <div class="card-body">
        <h3>${escapeHtml(meal.title)}</h3>
        <div class="card-foot">
          <div class="chips">${mealChips(meal, { withDoubled:false })}</div>
          ${sel ? `<button type="button" class="chip x2 ${dbl ? "on" : ""}" aria-pressed="${dbl}" title="Cook once, eat twice: buy double for leftovers">×2</button>` : ""}
          <button type="button" class="btn mini more icon-btn" aria-label="More actions for ${escapeHtml(meal.title)}">${icon("more", 18)}</button>
        </div>
      </div>`;
  }
  card.querySelector("img").src = gridImageSrc(meal);   // set directly: data URLs are large, keep them out of the HTML string
  card.querySelector(".pick").addEventListener("click", (e) => { e.stopPropagation(); haptic(); setSelected(meal.id, !state.selected.has(meal.id)); });
  card.querySelector(".star").addEventListener("click", (e) => { e.stopPropagation(); haptic(); toggleFav(meal.id); });
  card.querySelector(".x2")?.addEventListener("click", (e) => { e.stopPropagation(); haptic(); toggleDoubled(meal.id); });
  card.querySelector(".more")?.addEventListener("click", (e) => { e.stopPropagation(); openMenu(e.currentTarget, mealMenuItems(meal.id, e.currentTarget)); });
  card.addEventListener("click", () => openMealView(meal.id));
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === card) openMealView(meal.id); });
  return card;
}

function renderMeals(){
  buildTagBar();
  renderBackupBanner();
  renderActiveFilters();
  grid.innerHTML = "";
  grid.classList.toggle("list", effectiveMealView() === "list");
  const items = visibleMeals();

  const hiddenN = state.meals.filter(mealAvoided).length;
  $("#avoid-note")?.toggleAttribute("hidden", !hiddenN);
  if ($("#avoid-note")) $("#avoid-note").textContent = `${hiddenN} meal${hiddenN === 1 ? "" : "s"} hidden by your avoid list (Settings › Ingredients)`;

  if (!state.meals.length){ grid.appendChild(firstRunPanel()); return; }
  if (!items.length){
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "No meals match your filters.";
    grid.appendChild(d);
    return;
  }

  const frag = document.createDocumentFragment();
  items.forEach(meal => frag.appendChild(buildCard(meal)));
  grid.appendChild(frag);
  queueThumbs();
}

/* ============== First run (no meals on this device yet) ============== */
function firstRunPanel(){
  const d = document.createElement("div");
  d.className = "first-run";
  d.innerHTML = `
    <h3 class="h3">Welcome 👋</h3>
    <p>Your meals are stored in this browser on this device. If you use Meal Planner on another device,
       export a backup there (Settings › Data) and import it here to bring everything across.</p>
    <div class="group">
      <button type="button" class="btn primary" data-fr="import">${icon("save", 18)}Import a backup</button>
      <button type="button" class="btn" data-fr="scan">${icon("camera", 18)}Scan a recipe card</button>
      <button type="button" class="btn" data-fr="add">＋ Add a meal</button>
    </div>`;
  d.querySelector('[data-fr="import"]').addEventListener("click", () => $("#import")?.click());
  d.querySelector('[data-fr="scan"]').addEventListener("click", () => { openAddSheet(); $("#scan-card-btn")?.click(); });
  d.querySelector('[data-fr="add"]').addEventListener("click", openAddSheet);
  return d;
}

/* ============== Avoid ingredients (Settings › Ingredients) ============== */
const avoidEditor = $("#avoid-editor") ? tokenEditor($("#avoid-editor"), $("#avoid-input"), []) : null;
function syncAvoidEditor(){ avoidEditor?.set(state.prefs.avoid || []); }
if (avoidEditor){
  new MutationObserver(async () => {
    const next = avoidEditor.get().map(ingredientKey).filter(Boolean);
    if (JSON.stringify(next) === JSON.stringify(state.prefs.avoid || [])) return;
    state.prefs.avoid = next;
    renderMeals();
    window.renderPlan?.();
    await idbSet(IDB_KEYS.prefs, state.prefs);
  }).observe($("#avoid-editor"), { childList: true });
}

/* ============== Grid thumbnails ==============
   Originals are never modified — the meal page and Export use them. The grid
   shows a copy with a 960px long edge (sharp at 2× on the widest card),
   made in the background and kept in IDB "thumbs" (not exported). */
const THUMB_MAX = 960;
const THUMB_MIME = canvasSupportsType("image/webp") ? "image/webp" : "image/jpeg";
const thumbFingerprint = src => `${src.length}:${src.slice(-48)}`;
function gridImageSrc(meal){
  const src = meal.image?.src;
  if (!src) return placeholderSvg(meal.title);
  const t = state.thumbs[meal.id];
  return (t && t.of === thumbFingerprint(src) && t.src) ? t.src : src;
}
const needsThumb = m => !!m.image?.src && state.thumbs[m.id]?.of !== thumbFingerprint(m.image.src);
let thumbBusy = false, thumbSaveTimer = null;
function queueThumbs(){
  if (thumbBusy) return;
  const next = state.meals.find(needsThumb);
  if (!next) return;
  thumbBusy = true;
  const idle = window.requestIdleCallback || (cb => setTimeout(cb, 150));
  idle(async () => {
    try { await makeThumb(next); }
    catch (e){
      console.warn("Thumbnail failed:", e);
      state.thumbs[next.id] = { src: null, of: thumbFingerprint(next.image.src) };   // use the original
    }
    thumbBusy = false;
    clearTimeout(thumbSaveTimer);
    thumbSaveTimer = setTimeout(() => idbSet(IDB_KEYS.thumbs, state.thumbs).catch(() => {}), 800);
    queueThumbs();
  }, { timeout: 2000 });
}
async function makeThumb(meal){
  const src = meal.image.src, of = thumbFingerprint(src);
  const img = new Image();
  img.src = src;
  await img.decode();
  let thumb = null;
  // Only worth it when it's meaningfully smaller than the original
  if (Math.max(img.naturalWidth, img.naturalHeight) > THUMB_MAX * 1.1){
    const data = await drawToDataURL(img, THUMB_MAX, THUMB_MAX, THUMB_MIME, 0.88);
    if (data && data.length < src.length * 0.85) thumb = data;
  }
  state.thumbs[meal.id] = { src: thumb, of };
  if (thumb){
    const el = grid.querySelector(`.card[data-id="${CSS.escape(meal.id)}"] img`);
    if (el) el.src = thumb;
  }
}

/* ============== Grid / list view ============== */
function effectiveMealView(){ return state.prefs.mealView || (isMobile() ? "list" : "grid"); }
function syncViewToggle(){
  const list = effectiveMealView() === "list";
  const b = $("#view-toggle");
  if (b){
    b.innerHTML = icon(list ? "grid" : "list");
    b.title = list ? "Show as grid" : "Show as list";
    b.setAttribute("aria-label", b.title);
  }
  const sel = $("#pref-meal-view");
  if (sel) sel.value = state.prefs.mealView || "";
}
async function setMealView(v){
  state.prefs.mealView = v;
  syncViewToggle();
  renderMeals();
  await idbSet(IDB_KEYS.prefs, state.prefs);
}
$("#view-toggle")?.addEventListener("click", () => setMealView(effectiveMealView() === "list" ? "grid" : "list"));
$("#pref-meal-view")?.addEventListener("change", e => setMealView(e.target.value));
window.matchMedia(`(max-width:${SPLIT_MIN_PX - 1}px)`).addEventListener?.("change", () => {
  if (!state.prefs.mealView){ syncViewToggle(); renderMeals(); }
});

/* ============== Text size ============== */
function applyTextSize(){
  const v = state.prefs.textSize || "normal";
  document.documentElement.dataset.textSize = v;
  $$("[data-text-size-set]").forEach(b => b.classList.toggle("active", b.dataset.textSizeSet === v));
  syncHeaderHeight();
}
$$("[data-text-size-set]").forEach(b => b.addEventListener("click", async () => {
  state.prefs.textSize = b.dataset.textSizeSet;
  applyTextSize();
  await idbSet(IDB_KEYS.prefs, state.prefs);
}));

/* ============== Backup reminder ==============
   Per device on purpose: each device has its own data. */
const BACKUP_LAST_KEY = "backup-last-v14";
const BACKUP_SNOOZE_KEY = "backup-snooze-v14";
const BACKUP_DUE_DAYS = 30;
const local = {
  get(k){ try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v){ try { localStorage.setItem(k, v); } catch { /* private mode */ } }
};
function lastBackupDate(){ const v = local.get(BACKUP_LAST_KEY); return v ? new Date(v) : null; }
function renderBackupBanner(){
  const last = lastBackupDate();
  const info = $("#backup-last");
  if (info) info.textContent = last
    ? `Last backup on this device: ${last.toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" })}`
    : "No backup made on this device yet.";
  const el = $("#backup-banner");
  if (!el) return;
  const days = last ? Math.floor((Date.now() - last) / 864e5) : null;
  const snoozed = Date.now() < Number(local.get(BACKUP_SNOOZE_KEY) || 0);
  const due = state.meals.length > 0 && (days === null || days > BACKUP_DUE_DAYS) && !snoozed;
  el.hidden = !due;
  if (due) $(".backup-text", el).textContent = days === null
    ? "No backup on this device yet."
    : `Last backup on this device: ${days} days ago.`;
}
$("#backup-now")?.addEventListener("click", () => $("#export")?.click());
$("#backup-later")?.addEventListener("click", () => {
  local.set(BACKUP_SNOOZE_KEY, String(Date.now() + 7 * 864e5));
  renderBackupBanner();
});

/* ============== Meal page (tap a card) ============== */
const mealViewModal = $("#meal-view");
let viewingId = null;
function openMealView(id){
  if (viewingId !== id) mvTab = "ingredients";
  viewingId = id;
  renderMealView();
  mealViewModal.classList.add("open");
  mealViewModal.setAttribute("aria-hidden", "false");
  lockBodyScroll(true);
  $("#mv-body").scrollTop = 0;
  mealViewModal.querySelector(".dialog").scrollTop = 0;
}
function closeMealView(){
  if (!viewingId) return;
  viewingId = null;
  mealViewModal.classList.remove("open");
  mealViewModal.setAttribute("aria-hidden", "true");
  lockBodyScroll(false);
}
function refreshMealView(){ if (viewingId) renderMealView(); }
$("#mv-close")?.addEventListener("click", closeMealView);
mealViewModal?.addEventListener("click", (e) => { if (e.target === mealViewModal) closeMealView(); });
$("#mv-more")?.addEventListener("click", (e) => { e.stopPropagation(); if (viewingId) openMenu(e.currentTarget, mealMenuItems(viewingId, e.currentTarget)); });
$("#mv-star")?.addEventListener("click", () => { if (viewingId){ haptic(); toggleFav(viewingId); } });

/* Meal page: big photo with the title over it, a meta line, Ingredients /
   Method / Notes (tabs on phones, side by side on tablets) and an action bar
   that stays at the bottom: Add to shop (+ ×2), Plan, Cook. */
let mvTab = "ingredients";
function renderMealView(){
  const meal = state.meals.find(m => m.id === viewingId);
  if (!meal){ closeMealView(); return; }
  const sel = state.selected.has(meal.id), dbl = state.doubled.has(meal.id);
  const amount = i => window.cookHelpers ? window.cookHelpers.ingAmount(i) : `${formatNumber(i.amount)} ${i.unit || i.type}`;
  const steps = meal.steps || [];
  const ings = meal.ingredients || [];
  const log = (state.cooklog[meal.id] || []).slice().reverse();
  const cs = cookStats(meal.id), hist = state.history[meal.id];
  const meta = [
    typeof meal.cookMins === "number" ? `<span>${icon("clock", 15)}${meal.cookMins} min</span>` : "",
    steps.length ? `<span>${icon("steps", 15)}${steps.length} steps</span>` : "",
    cs.count ? `<span>${icon("star-filled", 15, "gold")}${cs.avg != null ? formatNumber(Math.round(cs.avg * 10) / 10) + " · " : ""}cooked ${cs.count}×</span>` : "",
    hist?.count ? `<span>${icon("cart", 15)}shopped ${hist.count}×</span>` : ""
  ].filter(Boolean).join("");
  const tab = (key, label) => `<button type="button" role="tab" class="mv-tab ${mvTab === key ? "on" : ""}" aria-selected="${mvTab === key}" data-mvtab="${key}">${label}</button>`;
  $("#mv-star").innerHTML = icon(meal.fav ? "star-filled" : "star", 20);
  $("#mv-star").classList.toggle("on", !!meal.fav);
  $("#mv-star").setAttribute("aria-label", meal.fav ? "Unfavourite" : "Favourite");
  $("#mv-body").innerHTML = `
    <div class="mv-hero">
      <img alt="" />
      <div class="mv-hero-scrim"></div>
      <div class="mv-hero-text">
        ${sel ? `<span class="mag-pill">In this shop${dbl ? " · ×2" : ""}</span>` : ""}
        <h2 id="mv-title" class="mv-title">${escapeHtml(meal.title)}</h2>
        ${meta ? `<div class="mv-meta">${meta}</div>` : ""}
      </div>
    </div>
    <div class="mv-tabs" role="tablist" aria-label="Recipe sections">
      ${tab("ingredients", "Ingredients")}${tab("method", "Method")}${tab("notes", "Notes")}
    </div>
    <div class="mv-panels" data-tab="${mvTab}">
      <section class="mv-panel" data-panel="ingredients">
        <h4 class="h4 mv-panel-head">${ings.length} ingredient${ings.length === 1 ? "" : "s"}</h4>
        <ul class="ov-ings mv-ings">${ings.map(i => `<li><span>${escapeHtml(titleCase(i.name))}</span><span class="muted">${escapeHtml(amount(i))}</span></li>`).join("")}</ul>
      </section>
      <section class="mv-panel" data-panel="method">
        <h4 class="h4 mv-panel-head">Method</h4>
        ${steps.length
          ? `<ol class="ov-steps mv-steps">${steps.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ol>`
          : `<div class="no-steps"><p>No steps yet.</p><button type="button" class="btn" id="mv-scan">${icon("camera", 18)}Scan back of card</button></div>`}
      </section>
      <section class="mv-panel" data-panel="notes">
        <h4 class="h4 mv-panel-head">Notes</h4>
        ${meal.notes ? `<p class="mv-notes">${escapeHtml(meal.notes)}</p>` : `<p class="muted small">No notes.</p>`}
        ${meal.tags?.length ? `<h4 class="h4">Tags</h4><div class="token-list">${meal.tags.map(t => `<span class="chip">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
        <h4 class="h4">Cook log</h4>
        ${log.length
          ? `<ul class="mv-log">${log.map(e => `<li><span class="muted">${escapeHtml(formatShortDate(e.date))}</span> ${e.rating ? `<span class="mv-stars">${"★".repeat(e.rating)}</span>` : ""} ${e.note ? escapeHtml(e.note) : ""}</li>`).join("")}</ul>`
          : `<p class="muted small">Not cooked in cook mode yet.</p>`}
      </section>
    </div>`;
  $("#mv-body .mv-hero img").src = meal.image?.src || placeholderSvg(meal.title);   // full-size original
  $("#mv-bar").innerHTML = `
    <button type="button" id="mv-pick" class="btn ${sel ? "in-shop" : "primary"} mv-main" aria-pressed="${sel}">${icon(sel ? "check" : "plus", 18)}${sel ? "In this shop" : "Add to shop"}</button>
    ${sel ? `<button type="button" id="mv-x2" class="btn x2 ${dbl ? "on" : ""}" aria-pressed="${dbl}" title="Cook once, eat twice: buy double for leftovers">×2</button>` : ""}
    <button type="button" id="mv-plan" class="btn">${icon("plan", 18)}Plan</button>
    <button type="button" id="mv-cook" class="btn">${icon("play", 16)}Cook</button>`;
  $$("[data-mvtab]", $("#mv-body")).forEach(b => b.addEventListener("click", () => { mvTab = b.dataset.mvtab; renderMealView(); }));
  $("#mv-pick")?.addEventListener("click", () => { haptic(); setSelected(meal.id, !state.selected.has(meal.id)); });
  $("#mv-x2")?.addEventListener("click", () => { haptic(); toggleDoubled(meal.id); });
  $("#mv-plan")?.addEventListener("click", (e) => openMenu(e.currentTarget, window.planMenuItems?.(meal.id) || []));
  $("#mv-cook")?.addEventListener("click", () => { closeMealView(); window.openGuided?.(meal.id); });
  $("#mv-scan")?.addEventListener("click", () => window.scanStepsFor?.(meal.id));
}

/* Density buttons */
function applyDensity(){
  const mode = state.prefs.gridMin;
  document.documentElement.style.setProperty(
    "--card-min",
    mode === "compact" ? "200px" : mode === "cozy" ? "260px" : "320px"
  );
  $$("[data-density]").forEach(b => b.classList.toggle("active", b.dataset.density === mode));
}
$$("[data-density]").forEach(btn => btn.addEventListener("click", async () => {
  state.prefs.gridMin = btn.dataset.density;
  applyDensity();
  await idbSet(IDB_KEYS.prefs, state.prefs);
}));
function syncSortUI(){
  const s = $("#meal-sort");
  if (s) s.value = state.prefs.mealSort || "az";
}
/* Forget the current shop entirely (import / clear all). */
function clearShopState(){
  state.selected.clear(); state.haveIt.clear(); state.pantryUse.clear(); state.countedIds.clear(); state.doubled.clear();
}

/* ===== Contains filter (search by ingredient) ===== */
/* Contains: lives in the Filter & sort sheet */
const containsEditor = $("#contains-editor") ? tokenEditor($("#contains-editor"), $("#contains-input"), []) : null;
if (containsEditor){
  new MutationObserver(() => {
    const next = new Set(containsEditor.get());
    if ([...next].join("|") === [...state.containsFilter].join("|")) return;
    state.containsFilter = next;
    renderMeals();
  }).observe($("#contains-editor"), { childList: true, subtree: true });
}
$("#contains-clear")?.addEventListener("click", () => {
  state.containsFilter.clear();
  containsEditor?.set([]);
  renderMeals();
});
/* "What can I make?" opens from the sheet: close the sheet first (plan.js opens it) */
$("#wcim-open")?.addEventListener("click", () => closeFilters());

/* ============== Search (header 🔍 → full-screen search) ============== */
const SEARCH_RECENT_KEY = "search-recent-v18";
const searchSheet = $("#search-sheet");
function recentSearches(){ try { return JSON.parse(localStorage.getItem(SEARCH_RECENT_KEY) || "[]"); } catch { return []; } }
function rememberSearch(q){
  q = (q || "").trim().toLowerCase();
  if (!q) return;
  const list = [q, ...recentSearches().filter(x => x !== q)].slice(0, 6);
  try { localStorage.setItem(SEARCH_RECENT_KEY, JSON.stringify(list)); } catch { /* ok */ }
}
function openSearch(){
  searchSheet.classList.add("open");
  searchSheet.setAttribute("aria-hidden", "false");
  lockBodyScroll(true);
  renderSearch();
  setTimeout(() => $("#search")?.focus(), 60);
}
function closeSearch(){
  rememberSearch(state.search);
  searchSheet.classList.remove("open");
  searchSheet.setAttribute("aria-hidden", "true");
  lockBodyScroll(false);
}
function renderSearch(){
  const q = state.search;
  const rec = recentSearches();
  $("#search-recent").innerHTML = !q && rec.length
    ? `<span class="muted small">Recent</span>` + rec.map(r => `<button type="button" class="filter-chip" data-recent="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join("")
    : "";
  $$("[data-recent]", $("#search-recent")).forEach(b => b.addEventListener("click", () => {
    $("#search").value = b.dataset.recent;
    $("#search").dispatchEvent(new Event("input"));
  }));
  const out = $("#search-results");
  if (!q){ out.innerHTML = `<p class="muted small">Search by meal name or ingredient, e.g. "chicken", "couscous".</p>`; return; }
  const hits = visibleMeals().slice(0, 40);
  out.innerHTML = hits.map(m => `
    <button type="button" class="pp-item" data-open="${escapeHtml(m.id)}">
      <img alt="" data-img="${escapeHtml(m.id)}" />
      <span class="pp-name">${escapeHtml(m.title)}<span class="muted small">${typeof m.cookMins === "number" ? `${m.cookMins} min` : ""}</span></span>
      ${icon("next", 18)}
    </button>`).join("") || `<div class="empty">No meals match “${escapeHtml(q)}”.</div>`;
  $$("img[data-img]", out).forEach(img => { img.loading = "lazy"; img.src = gridImageSrc(state.meals.find(m => m.id === img.dataset.img)); });
  $$("[data-open]", out).forEach(b => b.addEventListener("click", () => { rememberSearch(q); closeSearch(); openMealView(b.dataset.open); }));
}
$("#search-open")?.addEventListener("click", openSearch);
$("#search-close")?.addEventListener("click", () => { closeSearch(); if (state.search) setView("meals"); });
$("#search")?.addEventListener("input", (e) => {
  state.search = (e.target.value || "").trim().toLowerCase();
  renderMeals();
  if (searchSheet?.classList.contains("open")) renderSearch();
});
$("#search")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter"){ e.preventDefault(); closeSearch(); setView("meals"); }
});

/* Sort */
$("#meal-sort")?.addEventListener("change", async (e) => {
  state.prefs.mealSort = e.target.value;
  renderMeals();
  await idbSet(IDB_KEYS.prefs, state.prefs);
});

/* Clear selection = start a new shop: ticks, pulled-back staples and the
   "already counted" set all reset. Undo restores the lot. */
$("#clear-selection")?.addEventListener("click", () => {
  if (!state.selected.size) return;
  const before = {
    selected: new Set(state.selected), haveIt: new Set(state.haveIt),
    pantryUse: new Set(state.pantryUse), countedIds: new Set(state.countedIds), doubled: new Set(state.doubled)
  };
  state.selected.clear(); state.haveIt.clear(); state.pantryUse.clear(); state.countedIds.clear(); state.doubled.clear();
  saveSession(); renderMeals(); renderShopping();
  showUndoToast("Selection cleared — new shop", () => {
    Object.assign(state, before);
    saveSession(); renderMeals(); renderShopping();
  });
});

/* =====================================================
   SHOPPING LIST
   One row per ingredient (by ingredientKey of its canonical name), so
   "cashew nut" + "cashew nuts" merge. tsp and tbsp combine (1 tbsp = 3 tsp);
   other unit types stay as parts of the same row: "400 g + 1 piece".
   ===================================================== */
const shoppingWrap = $("#shopping");
const SPOON_TSP = { tsp:1, tbsp:3 };
const PART_ORDER = ["g", "ml", "spoon", "cup"];

function partKey(i){
  if (i.type === "grams") return "g";
  if (i.type === "ml") return "ml";
  if (i.type === "tsp" || i.type === "tbsp") return "spoon";
  if (i.type === "cup") return "cup";
  return "qty|" + (normaliseUnitLabel(i.unit) || "piece");
}
/* Plural unit label for display ("3 cloves"); stored labels stay singular. */
const UNIT_LABEL_PLURAL_OF = Object.fromEntries(Object.entries(UNIT_LABEL_PLURALS).map(([p, s]) => [s, p]));
function displayUnit(unit, value){
  return value === 1 ? unit : (UNIT_LABEL_PLURAL_OF[unit] || unit);
}
/* One aggregated amount -> display parts. Spoons split into whole tbsp + tsp
   (5 tsp -> "1 tbsp + 2 tsp") rather than "1.67 tbsp". */
function formatPart(pk, total){
  if (pk === "g")  return [total >= 1000 ? { value:total / 1000, unit:"kg" } : { value:total, unit:"g" }];
  if (pk === "ml") return [total >= 1000 ? { value:total / 1000, unit:"L" }  : { value:total, unit:"ml" }];
  if (pk === "spoon"){
    const tbsp = Math.floor(total / 3 + 1e-9);
    const tsp = Math.round((total - tbsp * 3) * 100) / 100;
    if (!tbsp) return [{ value:tsp, unit:"tsp" }];
    return tsp ? [{ value:tbsp, unit:"tbsp" }, { value:tsp, unit:"tsp" }] : [{ value:tbsp, unit:"tbsp" }];
  }
  if (pk === "cup") return [{ value:total, unit: total === 1 ? "cup" : "cups" }];
  const unit = pk.slice(4);
  return [{ value:total, unit: displayUnit(unit, total) }];
}
function aggregate(){
  const map = new Map();
  for (const m of state.meals){
    if (!state.selected.has(m.id)) continue;
    const mult = state.doubled.has(m.id) ? 2 : 1;   // cook once, eat twice
    for (const i of (m.ingredients || [])){
      const name = canonicalName(i.name);
      const key = ingredientKey(name);
      if (!key) continue;
      let row = map.get(key);
      if (!row){ row = { key, spellings:new Map(), parts:new Map() }; map.set(key, row); }
      row.spellings.set(name, (row.spellings.get(name) || 0) + 1);
      const pk = partKey(i);
      const amt = (Number(i.amount) || 0) * (pk === "spoon" ? SPOON_TSP[i.type] : 1) * mult;
      row.parts.set(pk, (row.parts.get(pk) || 0) + amt);
    }
  }
  const rank = pk => { const i = PART_ORDER.indexOf(pk); return i === -1 ? PART_ORDER.length : i; };
  return Array.from(map.values()).map(r => {
    const parts = Array.from(r.parts.entries())
      .filter(([, total]) => total > 0)
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
      .flatMap(([pk, total]) => formatPart(pk, total));
    return {
      key: r.key,
      name: mostCommon(r.spellings),
      names: Array.from(r.spellings.keys()),
      parts,
      amount: parts.map(p => `${formatNumber(p.value)} ${p.unit}`).join(" + ") || "—"
    };
  }).sort((a, b) => a.name.localeCompare(b.name, "en-GB", { sensitivity:"base" }));
}

/* ============== Shopping list categories (optional grouping) ==============
   Keyword rules, checked in order (first match wins), so "rice vinegar" is
   Cupboard not Rice, "egg noodles" is Pasta not Dairy, "ground coriander"
   is Spices not Fruit & veg. Unmatched names go to "Other". */
const SHOP_CATEGORIES = [
  ["Fruit & veg", /\b(apples?|salad|spinach|leaf|broccoli|onions?|shallots?|carrots?|tomato(es)?|mushrooms?|courgettes?|cucumbers?|garlic|ginger|chill(i|ies)|lettuce|kale|lemons?|limes?|oranges?|mangetout|pak choi|parsnips?|peas?|peppers?|potato(es)?|radish(es)?|rocket|spring greens?|sweetcorn|beans?|edamame|avocados?|aubergines?|leeks?|celery|cabbage|cauliflower|squash|bananas?|berries|basil|coriander|parsley|mint|chives?|thyme|sage|rosemary|dill|lemongrass|oregano)\b/],
  ["Meat & fish", /\b(chicken|beef|pork|lamb|mince|steaks?|bacon|sausages?|chorizo|nduja|pepperoni|ham|turkey|duck|fillets?|salmon|cod|basa|haddock|prawns?|tuna|fish|belly)\b/],
  ["Dairy, eggs & chilled", /\b(cheese|cheddar|parmesan|mozzarella|feta|halloumi|cream|cr[eè]me|fra[iî]che|yogh?urt|milk|butter|eggs?|pastry)\b/],
  ["Bakery", /\b(buns?|bread|naan|ciabatta|rolls?|wraps?|tortillas?|pitta|bagels?|brioche|baguettes?)\b/],
  ["Pasta, rice & grains", /\b(rice|pasta|spaghetti|linguine|conchiglie|tortiglioni|orzo|lasagne|noodles?|couscous|bulgar|bulgur|quinoa|penne|fusilli|macaroni|oats)\b/],
  ["Cupboard", /\b(stock|paste|sauce|pur[ée]e|ketchup|mayonnaise|relish|jam|vinegar|oil|honey|tahini|mustard|capers|sriracha|mirin|wine|frito|chopped tomato(es)?|tinned|coconut|crispy onions?|breadcrumbs?|sultanas?|raisins?|apricots?|almonds?|cashews?|nuts?|seeds?|cornflour|flour|sugar|lentils?|chickpeas?)\b/],
  ["Spices", /^(dried|ground)\b|\b(paprika|cumin|turmeric|garam masala|curry powder|cayenne|allspice|cardamom|nigella|mustard seeds?|five-spice|ras el hanout|chilli flakes?|seasoning|cinnamon|nutmeg|salt|black pepper|peppercorns?)\b/]
];
/* Checked first → last; display order is SHOP_CATEGORY_ORDER */
const SHOP_RULE_ORDER = ["Spices", "Cupboard", "Pasta, rice & grains", "Bakery", "Meat & fish", "Dairy, eggs & chilled", "Fruit & veg"];
const SHOP_CATEGORY_ORDER = ["Fruit & veg", "Meat & fish", "Dairy, eggs & chilled", "Bakery", "Pasta, rice & grains", "Cupboard", "Spices", "Other"];
function shopCategory(name){
  const n = String(name || "").toLowerCase();
  if (/\bsugar snap/.test(n)) return "Fruit & veg";
  for (const cat of SHOP_RULE_ORDER){
    const re = SHOP_CATEGORIES.find(c => c[0] === cat)[1];
    if (re.test(n)) return cat;
  }
  return "Other";
}

function isStapleRow(r){ return state.pantry.has(r.key) && !state.pantryUse.has(r.key); }

/* Rows to buy: not ticked as "have it", not a cupboard staple. */
function rowsToBuy(){
  return aggregate().filter(r => !state.haveIt.has(r.key) && !isStapleRow(r));
}

async function togglePantry(key, on){
  if (on) state.pantry.add(key); else state.pantry.delete(key);
  state.pantryUse.delete(key);
  await Promise.all([idbSet(IDB_KEYS.pantry, Array.from(state.pantry)), saveSession()]);
  renderShopping();
}

/* Tick = "got it / have it". Ticked rows sink into the "✓ Got" group. */
let justGot = null;   // the row just ticked gets a small pop
function setGot(key, on){
  haptic(on ? 15 : 8);
  justGot = on ? key : null;
  if (on) state.haveIt.add(key); else state.haveIt.delete(key);
  if (on && !state.prefs.swipeHintSeen){ state.prefs.swipeHintSeen = true; idbSet(IDB_KEYS.prefs, state.prefs); }
  saveSession();
  renderShopping();
}
/* Swipe a row right to tick, left to untick. Horizontal only, so vertical
   scrolling still works (rows use touch-action: pan-y). */
function attachRowSwipe(tr, key){
  let start = null;
  tr.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || e.target.closest("button, input")) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, swiping: false };
  });
  tr.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!start.swiping){
      if (Math.abs(dy) > 12){ start = null; return; }          // a scroll, not a swipe
      if (Math.abs(dx) > 12){ start.swiping = true; try { tr.setPointerCapture(e.pointerId); } catch { /* ok */ } }
    }
    if (start?.swiping){
      tr.style.transform = `translateX(${Math.max(-90, Math.min(90, dx))}px)`;
      tr.classList.toggle("swipe-got", dx > 60);
      tr.classList.toggle("swipe-undo", dx < -60);
    }
  });
  const end = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y, was = start.swiping;
    start = null;
    tr.style.transform = "";
    tr.classList.remove("swipe-got", "swipe-undo");
    if (!was || Math.abs(dy) > 30) return;
    if (dx > 60 && !state.haveIt.has(key)) setGot(key, true);
    else if (dx < -60 && state.haveIt.has(key)) setGot(key, false);
  };
  tr.addEventListener("pointerup", end);
  tr.addEventListener("pointercancel", () => { start = null; tr.style.transform = ""; tr.classList.remove("swipe-got", "swipe-undo"); });
}

function shoppingRow(r, opts){
  const tr = document.createElement("tr");
  const ticked = state.haveIt.has(r.key);
  tr.classList.toggle("ticked", ticked && !opts.staple);
  tr.classList.toggle("just-got", ticked && r.key === justGot);

  const tdTick = document.createElement("td");
  tdTick.className = "col-tick";
  if (!opts.staple){
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = ticked;
    cb.setAttribute("aria-label", `I have ${r.name}`);
    cb.addEventListener("change", () => setGot(r.key, cb.checked));
    tdTick.appendChild(cb);
    attachRowSwipe(tr, r.key);
  }

  const tdName = document.createElement("td");
  tdName.className = "col-name";
  tdName.textContent = titleCase(r.name);
  if (r.names.length > 1) tdName.title = `Merged: ${r.names.join(", ")}`;

  const tdAmt = document.createElement("td");
  tdAmt.className = "col-amount";
  tdAmt.textContent = r.amount;

  const tdAct = document.createElement("td");
  tdAct.className = "col-actions";
  const mk = (text, title, onClick, cls = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn mini row-btn ${cls}`.trim();
    if (ICON_PATHS[text]) b.innerHTML = icon(text, 18); else b.textContent = text;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", onClick);
    tdAct.appendChild(b);
  };
  if (opts.staple){
    mk("Need it", `Add ${r.name} to this shop`, () => {
      state.pantryUse.add(r.key); saveSession(); renderShopping();
    }, "need-btn");
    mk("x", `${r.name} is not a staple`, () => togglePantry(r.key, false));
  } else if (state.pantry.has(r.key)){
    mk("home", `Back to the cupboard (staple)`, () => {
      state.pantryUse.delete(r.key); saveSession(); renderShopping();
    }, "on");
  } else {
    mk("home", `Always have ${r.name} (staple)`, () => togglePantry(r.key, true));
  }
  if (!opts.staple) mk("swap", `Merge "${r.name}" into another name`, () => openMergeDialog(r.names));

  tr.append(tdTick, tdName, tdAmt, tdAct);
  return tr;
}

function renderShopping(){
  shoppingWrap.innerHTML = "";
  const rows = aggregate();
  updateSelectedCount();
  if (!rows.length){
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "Tick meals to build your shopping list.";
    shoppingWrap.appendChild(d);
    updateShoppingActions();
    return;
  }

  // Prune per-shop state for rows that no longer exist
  const live = new Set(rows.map(r => r.key));
  for (const k of Array.from(state.haveIt)) if (!live.has(k)) state.haveIt.delete(k);
  for (const k of Array.from(state.pantryUse)) if (!live.has(k)) state.pantryUse.delete(k);

  const listed = rows.filter(r => !isStapleRow(r));
  const main = listed.filter(r => !state.haveIt.has(r.key));
  const got = listed.filter(r => state.haveIt.has(r.key));
  const staples = rows.filter(isStapleRow);
  const table = (items) => {
    const t = document.createElement("table");
    t.className = "table shopping-table";
    const tbody = document.createElement("tbody");
    items.forEach(r => tbody.appendChild(shoppingRow(r, { staple:false })));
    t.appendChild(tbody);
    return t;
  };

  if (main.length && state.prefs.shopGroup){
    const groups = new Map(SHOP_CATEGORY_ORDER.map(c => [c, []]));
    main.forEach(r => groups.get(shopCategory(r.name)).push(r));
    for (const [cat, items] of groups){
      if (!items.length) continue;
      const h = document.createElement("div");
      h.className = "cat-head";
      h.textContent = `${cat} (${items.length})`;
      shoppingWrap.append(h, table(items));
    }
  } else if (main.length) shoppingWrap.appendChild(table(main));
  else {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = listed.length ? "All got! ✓" : "Everything here is a cupboard staple.";
    shoppingWrap.appendChild(d);
  }
  if (got.length){
    const h = document.createElement("div");
    h.className = "got-head";
    h.innerHTML = `${icon("check", 16)}Got (${got.length})`;
    shoppingWrap.append(h, table(got));
  }
  if (main.length && !got.length && !state.prefs.swipeHintSeen){
    const tip = document.createElement("p");
    tip.className = "muted small swipe-tip";
    tip.textContent = "Tip: swipe an item right to tick it off, left to undo.";
    shoppingWrap.appendChild(tip);
  }

  if (staples.length){
    const det = document.createElement("details");
    det.className = "staples";
    const sum = document.createElement("summary");
    sum.innerHTML = `${icon("home", 16)}Usually in the cupboard (${staples.length})`;
    const table = document.createElement("table");
    table.className = "table shopping-table";
    const tbody = document.createElement("tbody");
    staples.forEach(r => tbody.appendChild(shoppingRow(r, { staple:true })));
    table.appendChild(tbody);
    det.append(sum, table);
    shoppingWrap.appendChild(det);
  }
  justGot = null;
  updateShoppingActions();
}

function syncGroupToggle(){
  const l = $("#group-toggle-label");
  if (l) l.textContent = state.prefs.shopGroup ? "Show A–Z" : "Group by category";
}
$("#group-toggle")?.addEventListener("click", async () => {
  state.prefs.shopGroup = !state.prefs.shopGroup;
  syncGroupToggle();
  $("#shop-menu")?.removeAttribute("open");
  renderShopping();
  await idbSet(IDB_KEYS.prefs, state.prefs);
});

function updateSelectedCount(){
  const n = state.selected.size;
  const d = Array.from(state.doubled).filter(id => state.selected.has(id)).length;
  const txt = n ? `${n} meal${n === 1 ? "" : "s"} selected${d ? ` · ${d} doubled` : ""}` : "No meals selected";
  $("#selected-count") && ($("#selected-count").textContent = txt);
  $("#sel-count") && ($("#sel-count").textContent = txt);
  $("#sel-bar")?.toggleAttribute("hidden", !n);
  const badge = $("#nav-shop-count");
  if (badge){ badge.textContent = n ? String(n) : ""; badge.hidden = !n; }
}

function updateShoppingActions(){
  const tickedN = state.haveIt.size;
  const reset = $("#reset-ticks");
  if (reset){
    reset.disabled = tickedN === 0;
    reset.innerHTML = icon("refresh", 16) + (tickedN ? `Reset ticks (${tickedN})` : "Reset ticks");
  }
  window.renderTodayShop?.();   // cook.js
}

function resetHaveItTicks(){
  state.haveIt.clear();
  saveSession();
  renderShopping();
}

/* Add aliases to a normaliser entry, creating it if needed. */
function addNormaliserAliases(canonical, aliases){
  canonical = normaliseRaw(canonical);
  const ck = ingredientKey(canonical);
  let entry = state.normaliser.find(e => ingredientKey(e.canonical) === ck);
  if (!entry){
    entry = { canonical, aliases: [] };
    state.normaliser.push(entry);
  }
  entry.aliases = entry.aliases || [];
  for (const a of aliases.map(normaliseRaw)){
    if (!a || a === normaliseRaw(entry.canonical) || entry.aliases.map(normaliseRaw).includes(a)) continue;
    entry.aliases.push(a);
  }
  return entry;
}

/* ===== Merge dialog: map one shopping row's spellings onto another name ===== */
function openMergeDialog(names){
  names = (Array.isArray(names) ? names : [names]).map(normaliseRaw).filter(Boolean);
  const label = names.join(" / ");
  const wrap = document.createElement("div");
  wrap.className = "modal open";
  wrap.innerHTML = `
    <div class="dialog merge-dialog" style="max-width:520px">
      <div class="stickybar group space-between">
        <h3 class="h3">Merge "${escapeHtml(label)}"</h3>
        <button class="btn" data-close aria-label="Close">✕</button>
      </div>
      <p class="muted small" style="margin:0 0 10px;">
        Pick the name this should become. Every meal using
        "<strong>${escapeHtml(label)}</strong>" is updated, and future meals map the same way.
      </p>
      <div class="form-row">
        <label for="merge-into">Merge into</label>
        <input id="merge-into" type="text" list="ingredient-suggestions" value="${escapeHtml(names[0])}" />
      </div>
      <div class="group" style="justify-content:flex-end;">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" id="merge-confirm">Merge</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  lockBodyScroll(true);
  const input = $("#merge-into", wrap);
  setTimeout(() => { input.focus(); input.select(); }, 30);

  const close = () => { wrap.remove(); lockBodyScroll(false); };
  wrap.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", close));
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });

  $("#merge-confirm", wrap).addEventListener("click", async () => {
    const canonical = normaliseRaw(input.value);
    if (!canonical){ alert("Please enter a name to merge into."); return; }
    addNormaliserAliases(canonical, names);
    const changed = applyNormaliserAcrossMeals();
    await saveAll();
    renderMeals(); renderShopping();
    updateIngredientSuggestions(); refreshTagSuggestions();
    close();
    status(changed
      ? `Merged "${label}" → "${canonical}" (${changed} meal${changed === 1 ? "" : "s"})`
      : `Merged "${label}" → "${canonical}"`);
  });
}

/* Manual-copy fallback (select-all in a textarea) for when the clipboard API
   is unavailable or refused. */
function showCopyFallback(text, title = "Copy shopping list"){
  const wrap = document.createElement("div");
  wrap.className = "modal open";
  wrap.innerHTML = `
    <div class="dialog" style="max-width:680px">
      <div class="stickybar group space-between">
        <h3 class="h3">${escapeHtml(title)}</h3>
        <button class="btn" data-close aria-label="Close">✕</button>
      </div>
      <p class="muted">Long-press / select-all and copy.</p>
      <textarea readonly style="height:240px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;"></textarea>
    </div>
  `;
  document.body.appendChild(wrap);
  lockBodyScroll(true);
  const ta = wrap.querySelector("textarea");
  ta.value = text;
  ta.focus(); ta.select();
  const close = () => { wrap.remove(); lockBodyScroll(false); };
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.querySelector("[data-close]").addEventListener("click", close);
}
async function copyText(text, fallbackTitle){
  try {
    if (navigator.clipboard && window.isSecureContext){
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  showCopyFallback(text, fallbackTitle);
  return false;   // true only when copied straight to the clipboard
}
function closeShopMenu(){ const m = $("#shop-menu"); if (m) m.open = false; }
function nothingToExport(){
  if (!state.selected.size){ status("Tick some meals first."); return true; }
  return false;
}

/* Ocado's "Find a list of products" takes one product name per line and
   can't use quantities, so this copies names only. */
const OCADO_URL = "https://www.ocado.com/";
$("#ocado")?.addEventListener("click", async () => {
  if (nothingToExport()) return;
  const rows = rowsToBuy();
  if (!rows.length){ status("Everything is ticked or a staple — nothing to copy."); return; }
  const text = rows.map(r => titleCase(r.name)).join("\n");
  const copied = await copyText(text, "Copy for Ocado");
  await recordShopUse();
  if (copied){
    showActionToast(
      `Copied ${rows.length} items — paste into Ocado's "Find a list of products"`,
      "Open Ocado",
      () => window.open(OCADO_URL, "_blank", "noopener"),
      9000
    );
  }
});

$("#share")?.addEventListener("click", async () => {
  if (nothingToExport()) return;
  const rows = rowsToBuy();
  if (!rows.length){ status("Everything is ticked or a staple — nothing to share."); return; }
  const n = state.selected.size;
  const text = [`Shopping list (${n} meal${n === 1 ? "" : "s"})`, "",
    ...rows.map(r => `• ${titleCase(r.name)} — ${r.amount}`)].join("\n");
  if (navigator.share){
    try {
      await navigator.share({ title: "Shopping list", text });
      await recordShopUse();
    } catch (err){
      if (err?.name === "AbortError") return;   // user closed the share sheet
      console.warn("Share failed:", err);
      if (await copyText(text)) status("Sharing failed — copied instead.");
      await recordShopUse();
    }
    return;
  }
  if (await copyText(text)) status("Sharing isn't available here — copied instead.");
  await recordShopUse();
});

$("#copy-tsv")?.addEventListener("click", async () => {
  closeShopMenu();
  if (nothingToExport()) return;
  const allRows = aggregate();
  const rows = rowsToBuy();
  if (!rows.length){ status("Everything is ticked or a staple — nothing to copy."); return; }
  const skipped = allRows.length - rows.length;
  const body = rows.map(r => r.parts.length === 1
    ? [titleCase(r.name), formatNumber(r.parts[0].value), r.parts[0].unit]
    : [titleCase(r.name), r.amount, ""]);
  const top = [["Meals selected", String(state.selected.size), ""]];
  if (skipped) top.push(["Skipped (have it / staples)", String(skipped), ""]);
  top.push(["", "", ""], ["Ingredient", "Total", "Unit"]);
  const tsv = [...top, ...body]
    .map(cols => cols.map(v => String(v).replaceAll("\t", " ")).join("\t"))
    .join("\n");
  if (await copyText(tsv)){
    status(skipped ? `Copied ${rows.length} items (${skipped} skipped).` : `Copied ${rows.length} items.`);
  }
  await recordShopUse();
});
$("#print")?.addEventListener("click", async () => {
  closeShopMenu();
  if (nothingToExport()) return;
  await recordShopUse();
  window.print();
});
$("#reset-ticks")?.addEventListener("click", () => { closeShopMenu(); resetHaveItTicks(); });
$("#shop-help-toggle")?.addEventListener("click", () => {
  const help = $("#shop-help");
  if (help) help.hidden = !help.hidden;
});
/* ⋯ menus (shopping list, plan) close on a tap elsewhere */
document.addEventListener("click", (e) => {
  $$("details.menu[open]").forEach(m => { if (!m.contains(e.target)) m.open = false; });
});

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
    prefs: state.prefs,
    pantry: Array.from(state.pantry),
    history: state.history,
    cooklog: state.cooklog,
    plan: state.plan,
    pins: state.pins
  }, null, 2);

  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `meal-planner-export-${stamp}-schema${EXPORT_SCHEMA_VERSION}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  local.set(BACKUP_LAST_KEY, new Date().toISOString());
  renderBackupBanner();
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
    prefs: (json.prefs && typeof json.prefs === "object") ? json.prefs : state.prefs,
    // schema 11+: absent in older exports
    pantry: Array.isArray(json.pantry) ? json.pantry.map(String) : [],
    history: (json.history && typeof json.history === "object") ? json.history : {},
    // schema 12+
    cooklog: (json.cooklog && typeof json.cooklog === "object") ? json.cooklog : {},
    // schema 13+
    plan: (json.plan && typeof json.plan === "object") ? json.plan : {},
    // schema 14+
    pins: (json.pins && typeof json.pins === "object") ? json.pins : {}
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
    state.pantry = new Set(migrated.pantry);
    state.history = migrated.history;
    state.cooklog = migrated.cooklog;
    const ids = new Set(state.meals.map(m => m.id));
    state.plan = cleanPlan(migrated.plan, ids);
    state.pins = cleanPins(migrated.pins, ids);
    state.cookQueue = state.cookQueue.filter(q => ids.has(q.mealId));
    clearShopState();

    await saveAll();
    applyTheme(); applyDensity(); syncSortUI();
    renderMeals(); renderShopping(); populateCookSelect();
    updateIngredientSuggestions(); refreshTagSuggestions();
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
  state.history = {};
  state.cooklog = {};
  state.cookQueue = [];
  state.plan = {};
  state.pins = {};
  clearShopState();
  await saveAll();
  renderMeals(); renderShopping(); populateCookSelect();
  updateIngredientSuggestions(); refreshTagSuggestions();
  status("All meals cleared.");
});

/* =====================================================
   SETTINGS MODAL
   ===================================================== */
const settingsModal = $("#settings-modal");
function openSettings(){
  renderSettings();
  showSettingsTab(state.prefs.settingsTab || "appearance");
  syncAvoidEditor();
  renderBackupBanner();   // fills the Data tab's "last backup" line
  settingsModal.classList.add("open");
  settingsModal.setAttribute("aria-hidden", "false");
  lockBodyScroll(true);
}
/* Settings tabs: Appearance | Ingredients | Pantry | History | Data (last one remembered) */
function showSettingsTab(tab){
  if (!$(`[data-spanel="${tab}"]`)) tab = "appearance";
  $$("[data-stab]").forEach(b => {
    const on = b.dataset.stab === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  $$("[data-spanel]").forEach(p => { p.hidden = p.dataset.spanel !== tab; });
  settingsModal.querySelector(".dialog").scrollTop = 0;
}
$$("[data-stab]").forEach(b => b.addEventListener("click", () => {
  state.prefs.settingsTab = b.dataset.stab;
  showSettingsTab(b.dataset.stab);
  idbSet(IDB_KEYS.prefs, state.prefs);
}));
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

  renderPantry();
  renderHistory();
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

/* ===== Tidy ingredients review ===== */
const TIDY_GROUPS = {
  merge:    "Merge spellings (also added to the normaliser for future meals)",
  singular: "Singular names (ticked where both forms are in use)",
  units:    "Units",
  defaults: "Unit defaults"
};
let tidyItems = [];
$("#tidy-preview")?.addEventListener("click", () => {
  const results = $("#tidy-results");
  const applyBtn = $("#tidy-apply");
  tidyItems = state.meals.length ? planTidy() : [];
  results.hidden = false;
  if (!tidyItems.length){
    results.innerHTML = "<em>Nothing to tidy — your ingredients already look consistent. ✓</em>";
    applyBtn.disabled = true;
    return;
  }
  results.innerHTML = Object.entries(TIDY_GROUPS).map(([g, title]) => {
    const rows = tidyItems.filter(x => x.group === g);
    if (!rows.length) return "";
    return `<h5 class="tidy-h">${escapeHtml(title)}</h5>` + rows.map(x => `
      <label class="tidy-row">
        <input type="checkbox" data-tidy="${escapeHtml(x.id)}" ${x.checked ? "checked" : ""}/>
        <span>${escapeHtml(x.label)} <span class="muted">(${x.uses})</span>
        ${x.note ? `<br><span class="tidy-note">⚠ ${escapeHtml(x.note)}</span>` : ""}</span>
      </label>`).join("");
  }).join("");
  applyBtn.disabled = false;
});
$("#tidy-apply")?.addEventListener("click", async () => {
  const on = new Set($$("[data-tidy]:checked", $("#tidy-results")).map(cb => cb.dataset.tidy));
  const chosen = tidyItems.filter(x => on.has(x.id));
  if (!chosen.length){ status("Nothing ticked."); return; }
  const snapshot = applyTidy(chosen);
  const refresh = async () => {
    await saveAll();
    renderSettings(); renderMeals(); renderShopping(); populateCookSelect();
    updateIngredientSuggestions(); refreshTagSuggestions();
  };
  await refresh();
  tidyItems = [];
  $("#tidy-results").innerHTML = `<em>✓ Applied ${chosen.length} change${chosen.length === 1 ? "" : "s"}.</em>`;
  $("#tidy-apply").disabled = true;
  showUndoToast(`Tidied ${chosen.length} item${chosen.length === 1 ? "" : "s"}`, async () => {
    restoreTidy(snapshot);
    await refresh();
    status("Tidy undone.");
  }, 10000);
});

/* ===== Pantry staples ===== */
function renderPantry(){
  const wrap = $("#pantry-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!state.pantry.size){
    wrap.innerHTML = `<span class="muted small">None yet — tap the house button on a shopping-list row.</span>`;
    return;
  }
  Array.from(state.pantry).sort().forEach(k => {
    const tok = document.createElement("span");
    tok.className = "token";
    const t = document.createElement("span");
    t.textContent = k;
    const x = document.createElement("button");
    x.type = "button"; x.className = "x"; x.textContent = "×";
    x.setAttribute("aria-label", `Remove ${k} from staples`);
    x.addEventListener("click", async () => { await togglePantry(k, false); renderPantry(); });
    tok.append(t, x);
    wrap.appendChild(tok);
  });
}

/* ===== Meal history ===== */
const HISTORY_STALE_DAYS = 60;
function renderHistory(){
  const wrap = $("#history-wrap");
  if (!wrap) return;
  const meals = state.meals.map(m => ({ m, h: state.history[m.id], last: lastChosen(m.id) }));
  const chosen = meals.filter(x => x.h?.count).sort((a, b) => b.h.count - a.h.count || a.m.title.localeCompare(b.m.title));
  const never = meals.filter(x => !x.h?.count).sort((a, b) => a.m.title.localeCompare(b.m.title));
  const cutoff = new Date(Date.now() - HISTORY_STALE_DAYS * 864e5).toISOString().slice(0, 10);
  const stale = chosen.filter(x => x.last < cutoff).sort((a, b) => a.last.localeCompare(b.last));

  // Cook log (times actually cooked, ratings)
  const cooked = state.meals.map(m => ({ m, c: cookStats(m.id) })).filter(x => x.c.count);
  const cookRow = x => `<li><span>${escapeHtml(x.m.title)}</span> <span class="muted">cooked ×${x.c.count}${x.c.avg != null ? ` · ★${formatNumber(Math.round(x.c.avg * 10) / 10)}` : ""}</span></li>`;
  const mostCooked = cooked.slice().sort((a, b) => b.c.count - a.c.count || a.m.title.localeCompare(b.m.title)).slice(0, 5);
  const topRated = cooked.filter(x => x.c.avg != null).sort((a, b) => b.c.avg - a.c.avg || b.c.count - a.c.count).slice(0, 5);
  const cookHtml = cooked.length ? `
    <h5 class="tidy-h">Most cooked</h5><ol class="hist-list">${mostCooked.map(cookRow).join("")}</ol>
    ${topRated.length ? `<h5 class="tidy-h">Top rated</h5><ol class="hist-list">${topRated.map(cookRow).join("")}</ol>` : ""}`
    : `<p class="muted small">Nothing cooked yet — finish a meal in cook mode and tap "Mark as cooked".</p>`;

  if (!chosen.length){
    wrap.innerHTML = `<p class="muted small">No shop history yet. A meal counts once per shop when you use Ocado, Share, Copy as TSV or Print.</p>${cookHtml}`;
    return;
  }
  const row = x => `<li><span>${escapeHtml(x.m.title)}</span>
    <span class="muted">×${x.h.count} · ${escapeHtml(formatShortDate(x.last))}</span>
    <button class="btn mini" data-hist-dec="${escapeHtml(x.m.id)}" title="Remove one count" aria-label="Remove one count from ${escapeHtml(x.m.title)}">−1</button></li>`;
  wrap.innerHTML = `
    <h5 class="tidy-h">Most chosen</h5>
    <ol class="hist-list">${chosen.slice(0, 10).map(row).join("")}</ol>
    <h5 class="tidy-h">Not chosen in ${HISTORY_STALE_DAYS}+ days (${stale.length})</h5>
    ${stale.length ? `<ul class="hist-list">${stale.map(row).join("")}</ul>` : `<p class="muted small">None.</p>`}
    <h5 class="tidy-h">Never chosen (${never.length})</h5>
    <p class="small">${never.map(x => escapeHtml(x.m.title)).join(" · ") || "<span class='muted'>None.</span>"}</p>
    ${cookHtml}
    <button class="btn mini danger" id="history-reset">Reset shop history</button>`;
  $$("[data-hist-dec]", wrap).forEach(b => b.addEventListener("click", async () => {
    const id = b.dataset.histDec;
    const h = state.history[id];
    if (!h) return;
    h.count -= 1;
    h.dates = (h.dates || []).slice(0, -1);
    if (h.count <= 0) delete state.history[id];
    await idbSet(IDB_KEYS.history, state.history);
    renderHistory(); renderMeals();
  }));
  $("#history-reset", wrap)?.addEventListener("click", async () => {
    if (!confirm("Reset the chosen-for-a-shop history for every meal?")) return;
    state.history = {};
    state.countedIds.clear();
    await Promise.all([idbSet(IDB_KEYS.history, state.history), saveSession()]);
    renderHistory(); renderMeals();
  });
}

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
  const key = ingredientKey(canonicalName(n));
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
  applyDensity();
  applyTextSize();
  syncViewToggle();
  syncSortUI();
  syncHeaderHeight();

  updateIngredientSuggestions();
  refreshTagSuggestions();
  syncGroupToggle();
  $("#about-version") && ($("#about-version").textContent = `v${APP_VERSION}`);
  setView("today");
  syncFiltersUI();

  renderMeals();
  renderShopping();

  // cook.js renders the Today tab once data is loaded (see its init)
  window.appReady = true;
  document.dispatchEvent(new Event("app:ready"));
  setTimeout(maybeShowWhatsNew, 700);
})();
