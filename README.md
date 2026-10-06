# Teatime

A home meal planner that runs in the browser and installs like an app: keep your meals, plan the week's dinners, shop from one list, and cook step by step. Formerly "Meal Planner".

**Open it:** https://cthrubuoy.github.io/meal-planner/. Install it from the browser menu, or on iPhone via Safari › Share › Add to Home Screen.

## What it does
- **Meals:**
  - Scan a recipe card, import a recipe link, or type a meal in.
  - Photos, steps, an "I usually add" list, the recipe's source, and versions (e.g. "swap the chicken for turkey mince").
- **Plan:**
  - The week's dinners, with Auto-fill, Suggest and swaps.
  - Who's cooking, "not cooking" days, leftovers from a ×2 meal, and a new-week review.
- **Shop:** one list from the chosen meals, by aisle, A–Z or by meal, plus anything else you add. Copy it for Ocado, or share it.
- **Cook:** one step at a time in big text, with timers named after what they're timing.
- **Sync:** share meals, the plan and the list between your devices and your household, using a code or QR. It works offline; a device that loses its data restores itself with the household key.

## How it's built
- Plain HTML, CSS and JavaScript with no build step, served by GitHub Pages from this repo's root.
- Data lives in the browser (IndexedDB), and a service worker keeps the app working offline.
- Two small Cloudflare Workers, kept outside this repo:
  - **The scan server** turns card photos, recipe links and ingredient swaps into recipes, using Google Gemini.
  - **The sync server** (D1 database) shares records between linked devices.

What changed in each version is in [CHANGELOG.md](CHANGELOG.md).
