# Contributing

## Local setup

```sh
git clone https://github.com/Jaironlanda/isupmap.git
cd isupmap
npm install
npm run db:schema:local   # create local D1 tables (run once)
npm run dev               # http://localhost:8787
```

> **Note:** `wrangler.jsonc` ships with an empty `database_id` (filled in at
> deploy time). `wrangler dev` won't boot until it has a value, so for local
> work set any placeholder UUID — local D1 ignores the actual id:
>
> ```jsonc
> "database_id": "00000000-0000-0000-0000-000000000000"
> ```
>
> Analytics is off locally by default: the `GA_ID` var is empty in
> `wrangler.jsonc`, so the Worker serves `/analytics.js` as a no-op. A real
> measurement ID is injected only in production (kept in the gitignored
> `wrangler.prod.jsonc`).

Trigger the cron locally to populate data:

```sh
npm run dev:cron
# in another terminal:
curl http://localhost:8787/__scheduled
curl -s http://localhost:8787/api/status | jq
```

## Adding a service

1. Append an entry to [`src/services.ts`](src/services.ts) with `id`, `name`, `category`, `weight`, and `source`.
2. If the service should show a logo, add its brand domain to the `LOGO_DOMAIN` map in [`public/app.js`](public/app.js) and drop a square PNG at `public/images/logo/services/<id>.png` (logos are self-hosted, not fetched from a CDN).
3. Run the cron locally to verify the status resolves correctly.

Source types:
- `statuspage` — Atlassian Statuspage (`/api/v2/summary.json`)
- `slack` — Slack's bespoke status API
- `rss` — RSS/Atom feed (heuristic; see README for caveats)
- `http` — plain HTTP reachability ping

## What makes a good PR

- **New service** — include the source type and why it belongs in one of the existing categories.
- **Bug fix** — describe the before/after behavior.
- **UI change** — include a screenshot.

Keep PRs focused. One service or one fix per PR is ideal.

## Type checking & tests

```sh
npm run typecheck   # tsc --noEmit
npm test            # Vitest suite (runs inside workerd)
```

Tests use Vitest with the Cloudflare Workers pool, so they execute against real
local bindings. CI runs `npm run typecheck` and `npm test` on every PR (see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)), and both must pass
before a PR can merge into `main`. Use `npm run test:watch` while developing.
