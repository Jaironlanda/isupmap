# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Freshly scaffolded Cloudflare Worker (`create-cloudflare` CLI). Currently a **static-assets-only Worker** — no Worker script exists yet. The only served content is [public/index.html](public/index.html), mapped to `/` via the `assets` binding in [wrangler.jsonc](wrangler.jsonc). There is no `src/` directory and no `main` entry in the config; adding server-side logic means creating a Worker entrypoint (e.g. `src/index.ts`) and pointing `main` at it.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` (or `npx wrangler dev`) | Local development server |
| `npm run deploy` (or `npx wrangler deploy`) | Deploy to Cloudflare |
| `npx wrangler types` | Regenerate TypeScript types — **run after any binding change in wrangler.jsonc** |

No test or lint tooling is configured yet.

## Cloudflare Workers guidance

Per [AGENTS.md](AGENTS.md): your knowledge of Workers APIs and limits may be outdated — retrieve current docs before any Workers/KV/R2/D1/Durable Objects/Queues/Vectorize/AI/Agents task. Use the Cloudflare MCP (`https://docs.mcp.cloudflare.com/mcp`) or the relevant skill (`cloudflare`, `wrangler`, `workers-best-practices`, `durable-objects`, etc.). Limits live at each product's `/platform/limits/` page.

## Conventions

- Config is `wrangler.jsonc` (JSONC, comments allowed). `.vscode/settings.json` associates `wrangler.json` with the JSONC language.
- `compatibility_flags` includes `nodejs_compat`; observability and source-map upload are enabled.
- `compatibility_date` is pinned in [wrangler.jsonc](wrangler.jsonc) — bump deliberately, not casually.
