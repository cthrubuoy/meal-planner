# Changelog

All notable changes to the Meal Planner app, newest first. The version matches the badge in the app header.
Each entry also records the service-worker cache (`CACHE_NAME` in `sw.js`) and the export schema (`schemaVersion` in exported JSON files).

## v15 — Wave 2: planner, import from links, avoid list (2026-10-06)
Cache `meal-planner-v17` · assets `?v=15` · export schema 13

### Added
- **Weekly planner:** a 📅 Plan tab, next to Meals and Cook on tablet and in the bottom bar on phone.
  - Meals go on Mon–Sun, with ‹ › to change week.
  - Per meal: ×2, ⇄ swap and ✕ remove.
  - "Cook on" day toggles.
- **Auto-fill:** fills the week from your own meals.
  - Favourites and well-rated meals come first.
  - Nothing you've planned or shopped for in the last two weeks, and no repeats within the week.
  - Quicker meals on Mon–Thu, and the main protein varies from day to day.
  - ⇄ **Swap** gives the next suggestion, as many times as you like.
- **Swipe to pick:** go through suggestions one card at a time; swipe right to add to the next free day, left to skip.
- **Add week to list** puts the week's meals, including ×2, on the shopping list.
- **Copy last week** and **Clear week**, both with Undo.
- **"📅 Add to plan…"** in every meal's ⋯ menu.
- **🧺 What can I make?** Enter ingredients you have and see meals ranked by how few you're missing. Pantry staples can count as "have".
- **Avoid ingredients** (Settings → Ingredients): meals containing them are hidden and never suggested; a note shows how many are hidden.
- **Import from a link:** paste a recipe website, TikTok or Instagram link in Add a meal, or share a link to the app from another app.
  - The recipe is filled in for review, with its photo and a "Source:" line in the notes.
  - It needs the updated scan server (Worker v2) and only appears once that's deployed.
  - Recipe websites work best. Social posts depend on the caption being public; if not, take a screenshot and use Scan.
- **📋 Paste list** in Add and Edit: paste one ingredient per line ("200g chicken thigh", "2 tbsp soy sauce", "3 cloves garlic") and the rows are filled in.
- **Drag to reorder** ingredients with the ⋮⋮ handle.
- **First-run screen** on a device with no meals: Import a backup, Scan a recipe card, or Add a meal.
- **Export schema 13:** adds `plan`. Older backups still import.

### Changed
- The **tag bar** shows real tags (cuisine, quick…) first; ingredient-name tags come after, and only if switched on.
- **Light theme contrast:** accent text, the primary button and favourite stars now meet the 4.5:1 minimum.
- **Keyboard focus** is clearly outlined everywhere.

## v14 — Wave 1 UI improvements (2026-10-05)
Cache `meal-planner-v16` · assets `?v=14` · export schema 12 (unchanged)

### Added
- **Meal page:** tap a meal card to open it, showing the full photo, ingredients, steps, notes, tags and cook log.
  - Actions: Add to shop, ×2, ▶ Cook, Edit, and ⋯ (Duplicate, Delete).
- **Cook once, eat twice (×2):** mark a selected meal ×2 to double its shopping amounts for leftovers.
  - Counts once in the shop history.
  - Its "This week" entry is marked ×2, and cook mode shows doubled amounts.
- **List / grid toggle** for meals (☰ / ▦).
  - Automatic: grid on tablet and desktop, list on phone.
  - The phone grid has two columns.
- **Text size setting:** Normal, Large or Extra large (Settings → Appearance).
- **Backup reminder:** a banner appears when this device hasn't been backed up for 30 days, with "Back up now" and "Later" (snoozes for 7 days).
- **Grid thumbnails:**
  - 960px copies made in the background.
  - Original photos are kept untouched, used on the meal page and in exports.
  - Decoded image memory dropped from about 254 MB to 143 MB, with no visible quality loss at 2×.
- **Shopping list, in the shop:**
  - Swipe an item right to tick it, left to untick.
  - Ticked items sink into a "✓ Got" group.
  - Bigger tap targets.
- **Delete meal** button in the Edit form, with Undo.

### Changed
- **Meal cards:**
  - A round **+ / ✓** button adds a meal to the shop; tapping the card itself now opens the meal page.
  - The favourite is now a star only.
  - A **⋯** menu holds Edit, Duplicate and Delete; the Edit button and bin are gone from the cards.
- **Settings** is split into tabs: Appearance, Ingredients, Pantry, History, Data. The last tab you used is remembered.
- In split view, **toasts** appear over the meals pane instead of covering the shopping list.
- Ticking, ×2 and favourites update a single card instead of redrawing the grid, so photos no longer flash blurry.

### Fixed
- Turning on ×2 after the list had already been copied or shared now updates that meal's "This week" entry too.

## v13 — Cooking on the tablet (2026-10-05)
Cache `meal-planner-v15` · assets `?v=13` · export schema 12

### Added
- **Guided cook mode:** full screen, one step at a time.
  - Move with Back/Next, swipe or the arrow keys; the screen stays on.
  - Tablet landscape: the ingredient checklist sits on the left.
- **Per-step ingredients:** each step shows the ingredients it uses, with amounts.
- **Step timers:** "10-12 min" or "30 secs" in a step becomes a tap-to-start timer.
  - Several can run at once and they survive a reload.
  - Beep and vibrate when done, plus a notification if the app is in the background.
- **"This week" cook queue** in the Cook tab: meals you shop for (Ocado, Share, TSV or Print) appear there until you mark them cooked.
- **Cook log and ratings:** "Mark as cooked" with stars and a note.
  - Cards show 🍳 ×N · ★avg.
  - New sorts: Most cooked, Top rated.
  - The note appears next time you cook the meal.
- **Unit conversion** in the Cook tab and cook mode (As written / Metric / US), for amounts and oven temperatures.
- **"Scan back of card"** straight from the Cook tab, for meals with no steps.
- **Export schema 12:** adds `cooklog`. Older backups still import.

### Fixed
- "Chillies" now merges with "chilli" (it was singularised to "chilly").

## v12 — Tablet layout, shopping list fixes, Ocado, staples, history (2026-10-05)
Cache `meal-planner-v14` · assets `?v=12` · export schema 11

### Added
- **Split view on tablet and desktop:** meals on the left, a live shopping list on the right. The phone keeps one view at a time.
- **Ocado button:** copies item names, one per line, for Ocado's "Find a list of products".
- **Share button:** opens the Android share sheet.
- **Pantry staples (🏠):** items you always have are left out of the copied, shared and printed list, under "Usually in the cupboard".
- **Meal history:**
  - How often each meal is chosen for a shop, shown as 🛒 ×N · date on cards.
  - Sorts: Most chosen, Least chosen, Longest since chosen.
  - A breakdown in Settings.
- **Tidy ingredients** (Settings): an optional, undoable clean-up that merges spellings, makes names singular and fixes mixed units.
- **Selected meals and ticks are saved**, so the list survives the app being closed.
- **Export schema 11:** adds `pantry` and `history`.

### Changed
- **Add a meal** is now a full-screen sheet, opened from **＋ Add** or the bottom bar.
- Export, Import and Clear all moved into Settings.
- Copy as TSV, Print and Reset ticks moved into the shopping list's **⋯** menu.
- Filters are one dialog at all sizes; the time filter's top end means "120+ min".
- Cooking times up to 600 minutes.
- On the phone, ingredient rows take 2 lines instead of 3, and the unit label only shows for quantities.
- The installed app can rotate (it was locked to portrait).
- Export files are named `meal-planner-export-YYYY-MM-DD-schemaN.json`.

### Fixed
- **Singular and plural forms now merge** in the shopping list (e.g. "cashew nut" and "cashew nuts"; "tomato purée" and "tomato puree").
- **Teaspoons and tablespoons add up together.** One ingredient in several units shows as one row (e.g. "400 g + 1 piece").
- **Opening a meal in Edit no longer changes its saved units** to the unit defaults.

## v11 — Baseline (last uploaded 2026-04-26)
Cache `meal-planner-v13` · export schema 10

The version in use before these changelog entries began:
- **Meals:** meal library with photos, tags, favourites, cook time, steps and notes.
- **Shopping list** built from ticked meals; tick items you already have; copy as TSV; print.
- **Recipe card scanning** (and "Scan back of card" for steps) via the scan server.
- **Normalisation:** ingredient normaliser (aliases), unit defaults, and a unit-label clean-up.
- **Filters:** tags, "contains ingredient" and cook time.
- **Basic Cook view:** a step checklist.
- **Export/Import** for moving data between devices; works offline as an installed app.
