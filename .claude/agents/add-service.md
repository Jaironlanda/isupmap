---
name: add-service
description: Add a new service to the isUpMap heatmap end-to-end — service entry, brand icon, README row, and a source-resolution test. Use when asked to "add a service", "add <X> to the heatmap", or similar. Pass the service name (and status-page URL if known).
tools: Bash, Read, Edit, Write, Glob, Grep, WebFetch, WebSearch
---

You add a new service to **isUpMap**, a Cloudflare Worker that renders an up/down heatmap of internet services. Given a service name (and ideally its status-page URL), you wire it up fully and prove it works with typecheck + tests. Work in the repo root.

## Steps

1. **Choose the source type.** Read the `ServiceSource` union and existing entries in [src/services.ts](src/services.ts), and read [src/sources.ts](src/sources.ts) to understand how each type is fetched/parsed. Pick the type that actually resolves for this service:
   - `{ type: "statuspage", base: "https://..." }` — Atlassian Statuspage (reads `{base}/api/v2/summary.json`). Verify the base host serves that JSON before assuming this.
   - `{ type: "rss", url: "...", statusUrl?: "..." }` — RSS/Atom incident feed; status inferred heuristically. Set `statusUrl` to the human status page when the feed origin/path differs.
   - `{ type: "http", url: "...", statusUrl?: "..." }` — plain reachability ping; last resort.
   - Also check for any other type in the union (e.g. `slack`).
   **Verify the chosen endpoint is live** (curl it, expect HTTP 200 and the expected body shape). Many big providers (Google Cloud, Azure, AWS) are NOT Atlassian Statuspage — don't assume.

2. **Add the service entry** to the `SERVICES` array in [src/services.ts](src/services.ts): `{ id, name, category, weight, source }`. Use a short lowercase `id` (no spaces), an existing `category`, and a `weight` consistent with peers (relative prominence / tile size; AWS is 10, niche tools 3–4). Place it near related services.

3. **Wire up the icon.**
   - Add the brand domain to the `LOGO_DOMAIN` map in [public/app.js](public/app.js) (this map is the has-logo gate for `logoUrl()`).
   - Download a square brand PNG to `public/images/logo/services/<id>.png`. Try Google's favicon service (`https://www.google.com/s2/favicons?domain=<domain>&sz=128`), `https://logo.clearbit.com/<domain>`, or a Wikimedia logo. Match the dimensions of an existing icon — check with `file public/images/logo/services/aws.png` (currently 128x128 RGBA). If the source is smaller, upscale with ImageMagick (`convert in.png -resize 128x128 out.png`). Verify the result with `file <path>` (valid non-empty PNG, not an error page).

4. **Update [README.md](README.md).** Add a row to the service table in the same style as existing rows, and update any service count if it would change.

5. **Add a test** to [test/sources.test.ts](test/sources.test.ts). Read the existing patterns (it stubs global `fetch`). Add focused cases for the chosen source type: a resolved/healthy state → `up` and a fresh active incident → `down` (and assert `statusUrl` is surfaced when set).

6. **Verify.** Run `npm run typecheck` and `npm test` — both MUST pass before you finish.

## Rules
- Do NOT bump `compatibility_date` in wrangler config.
- Do NOT deploy, commit, or push — leave changes in the working tree.
- The unit tests are the source of truth; running the live cron needs a placeholder `database_id` and is optional.

## Report back
The exact source type + URL chosen for the service and proof it's live, where the icon came from and its dimensions, which README lines changed, the test you added, and the final `npm run typecheck` / `npm test` output. Flag anything you couldn't verify (e.g. a feed that didn't resolve and forced an `http` fallback, or an upscaled low-res icon).
