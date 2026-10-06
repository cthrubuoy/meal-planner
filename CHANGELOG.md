# Changelog

All notable changes to the Meal Planner app, newest first. The version matches the badge in the app header.
Each entry also records the service-worker cache (`CACHE_NAME` in `sw.js`) and the export schema (`schemaVersion` in exported JSON files).

## v20 — Join steps, edit step text (2026-10-06)
Cache `meal-planner-v22` · assets `?v=20` · export schema 14 (unchanged)

### Added
- **Join steps** (Edit, Add and the scan review):
  - A **Join** button between every two steps makes them one step, for example "Add a knob of butter to a pan." + "Once melted, add the onions."
  - Steps that start with "Once…", "When…" or "Then…" are usually the second half of the step before, so that join is highlighted. **Join suggested** joins all of them at once.
  - These are only suggestions, since cards don't always list steps in order. Check the result, then press Save, or Cancel to undo.
- **Edit a step's text:** tap its words in the steps list.

### Changed (scan server — takes effect when the server is redeployed)
- Scans keep each step **as printed on the card** (all its sentences together) instead of splitting every sentence into its own step.
- **Fixes the "returned non-JSON" scan errors.** The cause: Gemini's hidden "thinking" used up the answer length limit, so long cards were cut off partway through.
  - The server now turns thinking off for scans and allows longer answers.
  - It retries once with more room if an answer is cut off, and once after a temporary Gemini error.
  - If it still fails, it gives a clearer message.

## v19 — Cook mode shows the steps around the current one (2026-10-06)
Cache `meal-planner-v21` · assets `?v=19` · export schema 14 (unchanged)

### Added
- **Cook mode shows the steps around the current one:**
  - the step before, faded, above it
  - **Up next** below it: the next 3 steps on the tablet and desktop, or the next 2 on the phone
  - a small timer or oven mark on steps that have one
  - "Then: rate & mark as cooked" near the end
  - tap any of them to jump to that step
- **"First up"** on the Get ready page previews steps 1–2.
- **On/off switch:** the list button at the top of cook mode. The setting is saved per device; it's on by default.

## v18 — New look: Today tab, photo cards, new meal page (2026-10-06)
Cache `meal-planner-v20` · assets `?v=18` · export schema 14 (unchanged)

### Added
- **Today tab** replaces the Cook tab and opens first:
  - tonight's meal as a big photo, with **Cook** and **Open meal**
  - a strip of this week's days (a dot for planned, a tick for cooked)
  - a shopping-list card with the number of items to buy, **Open list** and **Ocado**
  - below that, the week's menu and "Cook something else", as before
- **Search** has its own button in the header. It opens a search sheet that keeps your recent searches.
- **Filter & sort** is one sheet: sort, favourites, time, tags, ingredients and "What can I make?". Active filters show as chips above the meals; tap a chip to remove it.
- **Week strip on the Plan tab.** Tap a day to jump to it.
- **Drag and drop in the calendar** (tablet and desktop). Drag a meal to another day; on touch, press and hold first. Moves can be undone.
- **Group the shopping list by category**, from its ⋯ menu: Fruit & veg, Meat & fish, Dairy, eggs & chilled, Bakery, Pasta, rice & grains, Cupboard, Spices. It's optional; A–Z is still the default.
- **"What's new"** appears once after each update. It's also in Settings › About, with the version, a link to this changelog and "Show tips again".
- **First-time tips:** one short tip per screen, shown once.
- **Black (OLED) theme** in Settings › Appearance.

### Changed
- **Meal cards (grid view):** the photo fills the card, with the title, time and rating on it. **+** adds the meal to the shop (it turns into a green ✓), and "In this shop · ×2" shows on the photo. List view keeps the chips and ⋯ menu.
- **Meal page:**
  - full-width photo with the title on it, plus time, steps, rating and times cooked
  - **Ingredients / Method / Notes** tabs on phones; side by side on tablets
  - a bar along the bottom with **Add to shop** (and ×2), **Plan** and **Cook**
  - Edit, Duplicate and Delete are in the ⋯ menu at the top
- **One icon set** (line icons) replaces the emoji on buttons, menus and the bottom nav.
- **New fonts** (Bricolage Grotesque for headings, Figtree for text). They're stored in the app, so they work offline.
- **Bottom nav (phone):** Today, Meals, a raised **+ Add** button, Plan and Shop.
- **Header:** Add, Search and Settings. The theme switch moved to Settings.
- **One green main button per screen.** Less-used actions moved into ⋯ menus, e.g. Copy last week and Clear week on the Plan tab.
- **Small animations and vibration** when you tick an item, add a meal or move a meal. They're off when your device is set to reduce motion.
- "Placeholder" pictures for meals without a photo are colour gradients with the meal's initials.

## v17 — Cook tab follows the week's plan (2026-10-06)
Cache `meal-planner-v19` · assets `?v=17` · export schema 14 (unchanged)

### Changed
- **The Cook tab starts with "This week's menu":** the meals planned for this week, Mon–Sun in order.
  - **Today** is highlighted, pinned meals are included (📌), and meals you've cooked are ticked ✓ and dimmed.
  - Meals you bought but didn't plan appear below, under "Also bought this week".
- **The meal picker defaults to today's planned meal.** If that's cooked, it moves to the next uncooked one. It no longer picks the last meal you looked at.
  - The list starts with this week's menu ("Tue 6 · Spaghetti Bolognese"), then all meals.
  - Once you choose a meal yourself, it leaves your choice alone.
- **Cooking a ×2 meal from the week's menu** shows doubled amounts in cook mode.
- When nothing is planned, the Cook tab offers **📅 Plan the week**.

## v16 — Pins, 14-day calendar, dish photos from cards (2026-10-06)
Cache `meal-planner-v18` · assets `?v=16` · export schema 14

### Added
- **📌 Pin a meal to a weekday**, e.g. "fish & chips every Friday".
  - Pinned meals appear on that day every week (from today on), and auto-fill plans around them.
  - Removing a pinned meal for one week only skips it that week; the pin stays.
  - Unpin with 📌 again.
- **7 or 14 days** in the planner (the "7 days / 14 days" switch). Auto-fill, Add to list and Clear work on all the days shown.
- **Calendar layout** (tablet and desktop): a Mon–Sun grid with one row per week. Tap a meal for Open, ×2, Swap, Pin, Remove.
- **Meal photo when scanning a recipe card:** the review screen offers **🍽️ Dish photo** (cropped from the card automatically), **🃏 Whole card**, **No photo** or **📁 Choose…**.
  - The automatic crop needs the updated scan server; until then you can use the whole card or choose a photo.
- **Imported recipes** offer the page's photo, or no photo.
- **"📷 Take dish photo from a recipe card"** in Edit: photograph a card, and the dish photo is cut out and saved when you press Save. It falls back to the whole photo if the dish can't be found.
- **Export schema 14:** adds `pins`. Older backups still import.

### Changed
- **Clear week** keeps pinned meals.
- Swapping a pinned meal skips the pin for that week only.

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
