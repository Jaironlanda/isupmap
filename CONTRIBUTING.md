# Contributing

## Local setup

```sh
git clone https://github.com/Jaironlanda/isup.git
cd isup
npm install
npm run db:schema:local   # create local D1 tables (run once)
npm run dev               # http://localhost:8787
```

Trigger the cron locally to populate data:

```sh
npm run dev:cron
# in another terminal:
curl http://localhost:8787/__scheduled
curl -s http://localhost:8787/api/status | jq
```

## Adding a service

1. Append an entry to [`src/services.ts`](src/services.ts) with `id`, `name`, `category`, `weight`, and `source`.
2. The logo is fetched automatically from DuckDuckGo's icon CDN using the service's domain — no extra step needed.
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

## Type checking

```sh
npm run typecheck
```

No test suite is configured yet. Manual verification via `wrangler dev` is the current approach.
