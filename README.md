# Meal Planner & Shopping List — v10

A self-contained Progressive Web App for building a meal library, planning shops, and auto-generating aggregated shopping lists. Works fully offline. All data stored locally in IndexedDB.

## File structure

```
meal-planner/
├── index.html              # markup, modals, templates, datalists
├── manifest.webmanifest    # PWA manifest
├── sw.js                   # service worker (offline cache)
├── assets/
│   ├── app.js              # all app logic
│   ├── styles.css          # styling, mobile polish
│   └── pwa.js              # service worker registration
└── icons/
    ├── favicon.ico
    ├── icon-180.png        # iOS apple-touch-icon
    ├── icon-192.png        # PWA standard
    ├── icon-512.png        # PWA standard
    └── icon-maskable-512.png
```

## How to run

### Local (recommended for testing)
A service worker requires `http://` not `file://`, so use any static server:

```bash
cd meal-planner
python3 -m http.server 8000
# open http://localhost:8000
```

Or use any of: `npx serve`, `live-server`, VS Code "Live Server" extension, etc.

### GitHub Pages
1. Push the contents of `meal-planner/` to a repo
2. Settings → Pages → Source: main branch, root
3. Visit `https://YOUR_USER.github.io/REPO/` — install to home screen on iOS/Android

### Install to home screen
- **iOS Safari:** Share → Add to Home Screen
- **Android Chrome:** menu (⋮) → Install app
- **Desktop Chrome/Edge:** address bar install icon

## Path to APK / Google Play Store

The app is a fully compliant PWA, so wrapping as an APK is straightforward when you're ready:

1. **PWABuilder (easiest):** https://www.pwabuilder.com — paste your hosted PWA URL, it generates a signed APK / AAB with a Trusted Web Activity wrapper
2. **Bubblewrap CLI** (Google's official tool): `npm i -g @bubblewrap/cli && bubblewrap init --manifest=https://your-url/manifest.webmanifest`
3. **Capacitor** if you want richer native features later

The PWA needs to be hosted over HTTPS for Play Store wrapping. GitHub Pages works fine for that.

## What changed vs your previous v9.4

**Priority fixes you asked for:**
- **Mobile layout polish** — list-row cards, no horizontal overflow, safe-area insets, buttons always fit, image thumbnail sized cleanly, ingredient row reflows nicely on narrow screens, bottom nav stays in place over content
- **Ingredient normaliser actually merges across meals** — when you add a normaliser entry in Settings (with the "Also rename matches in existing meals" checkbox ticked, which is the default), it walks every saved meal and rewrites both ingredient names and tags to the canonical. Previously the normaliser dictionary existed but it didn't propagate.

**Other cleanups while I was in there:**
- Empty cook-time field now correctly stores `null` instead of showing "0 min" chip
- Shopping list converts grams ≥ 1000 to kg (parallel to ml → L)
- Clipboard fallback: if copy-to-clipboard fails (common on iOS file:// or older Safari), shows a textarea overlay so you can manually copy
- Theme picker in Settings: explicit Auto / Light / Dark buttons
- Import asks for confirmation before replacing data
- Schema version bumped to 10 (still imports v6/v7/v8/v9 exports)

## Data model (unchanged)

Existing exports (v6, v7, v8, v9) import cleanly. Old `imageDataUrl` field is migrated to `image: { type: "data", src }`.

## Known mobile caveats (unchanged)
- iOS Safari may open exported JSON in a new tab rather than downloading; long-press → "Download Linked File" if needed
- Clipboard requires HTTPS or localhost; fallback textarea handles file:// case
