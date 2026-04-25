# Meal Planner Backend (Cloudflare Worker)

A tiny Worker that proxies recipe-card photos to Google Gemini and returns
structured ingredient JSON. Used by the Meal Planner PWA.

## Files

- `src/index.js` — the Worker code
- `wrangler.toml` — Cloudflare config
- `package.json` — placeholder so npm/wrangler are happy

## Deploy

From this folder:

```bash
wrangler deploy
```

That uploads `src/index.js` to your existing Worker (`meal-planner-backend`).

## Secrets

The Gemini API key lives in Cloudflare's secret store, never in code. Set/rotate it:

```bash
wrangler secret put GEMINI_API_KEY
```

Verify:

```bash
wrangler secret list
```

## Endpoints

- `GET /` or `GET /health` — health check, returns `{ ok: true, ... }`
- `POST /scan` — body `{ image: "data:image/...;base64,..." }`, returns extracted recipe JSON

## Test it

After deploy, browse to `https://meal-planner-backend.YOUR-SUBDOMAIN.workers.dev/`
to see the health-check JSON.

The `/scan` endpoint is exercised from the PWA — there's no point hitting it
directly from a terminal because you'd have to base64-encode an image first.

## Cost expectations

At ~100 scans/month you stay inside both:

- Gemini's free tier (250–500 requests/day on Flash models, no card)
- Cloudflare Workers free tier (100,000 requests/day, no card)

So this whole thing costs $0/month indefinitely at your volume.

## Tail logs while debugging

```bash
wrangler tail
```

Streams console output from the Worker live. Useful if `/scan` returns 502.
