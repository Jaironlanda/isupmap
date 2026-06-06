# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

isUpMap — a service-status heatmap Worker for 80+ services. Architecture:

- **Cron** (`scheduled`, every 5 min in [wrangler.jsonc](wrangler.jsonc)) resolves every service in [src/services.ts](src/services.ts) via [src/sources.ts](src/sources.ts) (Statuspage JSON / RSS-Atom / HTTP ping, each with one transient-failure retry), persists a snapshot + incident transitions to **D1** ([src/db.ts](src/db.ts)), and publishes the finished API snapshot to **KV** (`SNAPSHOT_KEY` in [src/index.ts](src/index.ts)).
- **Detection is flap-dampened**: a non-up status must hold for `CONFIRM_THRESHOLD` (2) consecutive polls before it is committed / opens an incident; `up` and `unknown` never delay (`confirmStatus` + `probe_state` table). This prevents a single glitchy upstream read from creating a false outage.
- **Read path** (`GET /api/status`, `/api/summary`, `/api/incidents`, `/status/:id`) reads the KV snapshot — never D1 on the hot path — fronted by the per-colo Cache API and a per-IP rate limit. Responses carry a `stale`/`ageMs` flag (older than 3 cron cycles) so the UI warns instead of showing frozen data.
- **Frontend** ([public/](public/)) is a vanilla-JS treemap that polls `/api/status` every 45s.

Bindings ([wrangler.jsonc](wrangler.jsonc)): `ASSETS` (static), `DB` (D1), `SNAPSHOT_KV` (KV snapshot cache), `API_RATE_LIMITER` (rate limit). `main` is [src/index.ts](src/index.ts).

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` (or `npx wrangler dev`) | Local development server |
| `npm run deploy` (or `npx wrangler deploy`) | Deploy to Cloudflare |
| `npx wrangler types` | Regenerate TypeScript types — **run after any binding change in wrangler.jsonc** |
| `npm test` (or `npm run test:watch`) | Run the Vitest suite |
| `npm run typecheck` | Type-check without emitting |

Tests use **Vitest** with the Cloudflare Workers pool (`@cloudflare/vitest-pool-workers`),
so they run inside workerd with real bindings. Config is [vitest.config.mts](vitest.config.mts)
(`.mts` because the pool is ESM-only); specs live in [test/](test/). [test/db.test.ts](test/db.test.ts)
exercises the D1 layer against a real local D1 (schema applied from [schema.sql](schema.sql)
in `beforeAll`); [test/sources.test.ts](test/sources.test.ts) stubs the global `fetch`.
No lint tooling is configured yet. CI runs typecheck + tests on PRs via
[.github/workflows/ci.yml](.github/workflows/ci.yml).

## Cloudflare Workers guidance

Per [AGENTS.md](AGENTS.md): your knowledge of Workers APIs and limits may be outdated — retrieve current docs before any Workers/KV/R2/D1/Durable Objects/Queues/Vectorize/AI/Agents task. Use the Cloudflare MCP (`https://docs.mcp.cloudflare.com/mcp`) or the relevant skill (`cloudflare`, `wrangler`, `workers-best-practices`, `durable-objects`, etc.). Limits live at each product's `/platform/limits/` page.

## Conventions

- Config is `wrangler.jsonc` (JSONC, comments allowed). `.vscode/settings.json` associates `wrangler.json` with the JSONC language.
- `compatibility_flags` includes `nodejs_compat`; observability and source-map upload are enabled.
- `compatibility_date` is pinned in [wrangler.jsonc](wrangler.jsonc) — bump deliberately, not casually.
- Schema changes go in [schema.sql](schema.sql) (additive `CREATE TABLE IF NOT EXISTS` so re-running is safe) and are applied with `npm run db:schema:local` / `db:schema:remote`.
- The `SNAPSHOT_KV` binding needs a namespace id: `npx wrangler kv namespace create SNAPSHOT_KV` (local dev and tests simulate KV regardless of the id).
