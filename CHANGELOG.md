# Changelog

All notable changes to the Meal Planner app, newest first. The version matches the badge in the app header.
Each entry also records the service-worker cache (`CACHE_NAME` in `sw.js`) and the export schema (`schemaVersion` in exported JSON files).

## v26 — Shopping list and Edit meal redesign (2026-10-06)
Cache `meal-planner-v28` · assets `?v=26` · export schema 15 (unchanged)

### Changed
- **Shopping list redesign** (built for the shop floor):
  - **Round ticks** with big tap targets. Tap an item, or swipe it right, when you've got it; tap again to undo.
  - **"3 of 40 got"** with a progress bar at the top.
  - **Which meal each item is for** under its name (e.g. "Chicken & Chorizo Pie · Curry"). Your "I usually add" extras are marked too.
  - **By aisle · A–Z · By meal** at the top of the list (By aisle replaces "Group by category" in the ⋯ menu). By meal lists what each meal needs, with items shared by several meals first.
  - **Rows stay clean:** "Always have" (staple) and "Same as another ingredient" (merge) moved to a swipe left, or the ⋯ that appears when you hover on a computer.
  - **Got** and **Usually in the cupboard** are folded away at the bottom; they remember whether you left them open.
  - **Copy for Ocado** and **Share** sit at the bottom of the list, always in reach (above the bottom bar on the phone).
  - Plain counts read "3", not "3 pieces".
  - "How this works" moved into the ⋯ menu.
- **Add / Edit meal redesign:**
  - The **photo** across the top, with **Change photo** and **From a card** (take the dish photo from a recipe card) on it. A new photo shows there straight away, with Undo, until you save.
  - **Cancel** and **Save** at the top as well as the bottom.
  - **Time quick-picks:** 10 · 20 · 30 · 40 · 45 · 60 · Other.
  - **Ingredients read like the meal page** ("320 g  Chicken thigh"). Tap one to change it; it folds back when you move on. New rows open straight away.
  - Tags, Source and Notes moved below the steps.

### Fixed
- The Add form now tidies ingredient names (normaliser) exactly like Edit does.
- Tidy-up: the old shopping-table and photo-box styles were removed rather than overridden.

## v25 — Data safety: restore without another device, sync safety brake (2026-10-06)
Cache `meal-planner-v27` · assets `?v=25` · export schema 15 (unchanged) · sync server 1.1

**Why:** on 6 Oct the tablet's app storage was wiped after a normal force-close. Everything was safe on the sync server, but getting it back needed a code from the phone. The cause wasn't found in the app; the most likely explanation is the browser clearing the site's storage.

### Added
- **Restore my meals:** on an empty app, the first button on the Meals tab and in Settings › Sync.
  - It brings everything back from your household using the key saved in your password manager. If none is saved, you can type or paste the key.
  - No other device is needed.
- **Save your household key:** offered straight after turning on sync or joining, and available any time in Settings › Sync.
  - It saves the key in the browser's **password manager** (Brave or Google on Android; iCloud Keychain on iPhone), which survives the app's storage being cleared. Copy is there as a fallback.
- **Sync safety brake.** If a device tries to delete more than 3 meals (or more than 25 other things) in one go, sync pauses and asks.
  - **Cancel** (the default) deletes nothing and puts everything back on that device from the household.
  - **OK** goes ahead.
  - Normal single deletes and clearing the shopping list are unaffected.
- **Protected storage:** the app asks the browser to keep its storage instead of clearing it to free space. Settings › Advanced › Check now shows whether it's protected.
- **Start-up line in the diagnostics log** each time the app opens: version, number of meals, sync on/off, storage protected or not. A wiped device now shows up clearly.
- **Rename devices** (Settings › Sync › Rename). Brave on a tablet often runs in desktop mode, so it was being named "Computer"; it's now recognised as a tablet.

## v24 — "I usually add", add anything to the list, split steps, source, dates (2026-10-06)
Cache `meal-planner-v26` · assets `?v=24` · export schema **15** (adds `source` and `extras` to meals; older backups still import)

### Added
- **"I usually add"** (in Edit): things you always add to a meal that aren't in the recipe, e.g. broccoli with the pie.
  - **Shopping list:** they're added with the meal, marked "your extra · Chicken & Chorizo Pie". ×2 doubles them too.
  - **Meal page:** shown under the ingredients.
  - **Cook mode:** **"You usually add"** appears on the Get ready page, because they sometimes need prep. They're on the ingredient checklist too, and a small reminder stays on each step until they're ticked off.
  - Kept apart from the recipe, so re-scanning a card never removes them.
- **Add anything to the shopping list:**
  - Type in the box under the list, e.g. milk, bin bags or "2 loaves bread".
  - These items are labelled "added by hand", can be removed with ×, are included in Ocado/Share/Copy, sync to the household, and are cleared by Clear selection (with Undo).
- **Split long steps** (Edit). Imported recipes often have a whole paragraph as one step.
  - A suggestion appears for long steps: **Split sensibly** keeps things that belong together (cook, drain, toss), or **Every sentence**.
  - The ✂ button on a step lets you choose exactly where to split.
- **Source:** where a recipe came from, e.g. "BBC Good Food", with its link.
  - **Where it shows:** next to the title on the meal page; editable in Edit.
  - **Filled in automatically:** on link imports (from the web address); on card scans the scan server reads the brand from the card.
  - **Filter & sort › Source** filters by it.
  - **Existing meals:** "Source: https://…" lines in Notes are moved into the new field automatically.
- **Dates:** Today shows the full date (e.g. "Tuesday 6 October"). The plan calendar shows the date over each day, and the list layout uses full day names.

## v23 — Diagnostics log (2026-10-06)
Cache `meal-planner-v25` · assets `?v=23` · export schema 14 (unchanged)

### Added
- **Settings › Advanced › Diagnostics log.** What happened behind the scenes, newest first; tap a line for the details:
  - **every scan** (card, back of card, dish photo, link import): when it started, how long it took, the photo size, and the result
  - **failed scans:** the exact reason, including each attempt the scan server made with Gemini (which model, and whether it was busy, rate-limited or declined)
  - a scan that **started but never finished**, e.g. because the app was closed mid-scan
  - **sync problems** and recoveries, joining and unlinking
  - **any unexpected app error**
- **Log controls:** an "Errors only" filter, plus Copy, Share and Clear. The log is kept on the device only (the last 300 events).
- **A red dot on the Settings button** when a new error has been logged. It clears when you open Advanced.
- **Check now** (Settings › Advanced): checks whether the scan and sync servers are reachable and which versions they're running.
- **Scan error messages** now end with "details in Settings › Advanced".

### Changed (scan server v2.5)
- When a scan fails, the server sends back the list of Gemini attempts for the log.
- Cloudflare now keeps the scan server's request logs for a few days, so failures can be looked at afterwards.

## v22 — Live search, save while the back of a card scans (2026-10-06)
Cache `meal-planner-v24` · assets `?v=22` · export schema 14 (unchanged)

### Added
- **Search box at the top of Meals** (above the tags) that filters as you type, with no button to press. "r" shows everything with an r; "ru" narrows it to your rump steak.
  - Meals with the text in the title come first; meals that only have it in an ingredient follow under their own heading.
  - The header magnifier jumps to this box.

### Changed
- **The back-of-card scan no longer holds you up:**
  - Press Save (or close Edit) while it's scanning, and the steps are added to the meal when the scan finishes.
  - If the meal already had steps, the scan replaces them, with Undo.
  - If Edit is still open on that meal when the scan finishes, the steps go into the form as before.
- **The search sheet from v18 is gone.** The search box on Meals replaces it.

### Fixed (scan server v2.2)
- **"Gemini declined to answer (RECITATION)"** on cards with a lot of text.
  - The cause: Gemini refuses to copy word for word text that's published online, as recipe-box cards are.
  - The scan server no longer asks for the exact printed wording. If Gemini still refuses, it asks again for the steps in its own words, keeping every quantity, time and temperature.

## v21 — Sync across devices and your household (2026-10-06)
Cache `meal-planner-v23` · assets `?v=21` · export schema 14 (unchanged)

### Added
- **Settings › Sync.** Turn it on on one device, then link your other devices and your household:
  - Tap **Show a code** for a QR code and a short code. A code works once, for 15 minutes.
  - Scan the QR with the other device's camera, or type the code in Settings › Sync › **Join with a code**. Chrome and Brave on Android can also scan inside the app.
- **What syncs:** meals and photos, plan and pins, cook log, shop history, staples, "This week", the ingredient normaliser and unit defaults, the avoid list and cook days.
- **The current shopping list syncs too:** ticked meals, "got it" ticks and ×2. Tick items off on your phone in the shop and the tablet catches up within about 15 seconds.
- **Works offline:** each device keeps its own full copy. Changes wait until you're back online, and survive closing the app.
- **Joining with existing data:** a backup downloads first. Then, for meals on both, the household's version wins, and meals only on that device are added for everyone.
- **Linked devices list:** shows when each was last active, with **Unlink**.
- **Recovery key:** links a device if you ever lose all of yours. Any linked device can show it.
- **Status dot** on the Settings button: green when synced, amber while syncing, grey when offline, red if there's a problem.

### Changed
- **Clear all on a synced device** turns sync off on that device first and only clears that device. Your household keeps everything.
- **Import on a synced device** warns that it replaces the data for everyone.

### Notes
- Stays per device: theme, text size, layout and units.
- Your data is stored in your own Cloudflare account (a sync server separate from the scan server).

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
