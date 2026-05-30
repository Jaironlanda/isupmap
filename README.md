# IsUp — Service Status Heatmap

A live **up / down heatmap** for popular internet services, rendered as a
stock-map style treemap. Built on a single [Cloudflare Worker](https://developers.cloudflare.com/workers/):
a **Cron Trigger** polls each service's official status every minute and
persists snapshots + an incident log to **D1**, and a static frontend renders
it as a tightly-packed treemap with per-service uptime, an incident history
panel, and toast notifications when a service changes state.

![Heatmap example](./screenshot/example.png)

## How it works

```
Cron (every 1m) ─▶ scheduled() ─▶ resolveStatus() × N      ┌─▶ Statuspage JSON   ({base}/api/v2/status.json)
                       │                                    ├─▶ Slack status API
                       │   (src/sources.ts) ────────────────┼─▶ RSS / Atom feed   (fast-xml-parser)
                       │                                    └─▶ HTTP reachability ping
                       └─▶ persist to D1 (src/db.ts): upsert `current`,
                           open/close `incidents` on state transitions
Browser (public/) ─poll /api/status every 45s─▶ Worker reads D1 (fast)  ─▶ treemap + uptime + toasts
                  └─open Incidents panel ─────▶ GET /api/incidents       ─▶ persistent incident history
```

- A **Cron Trigger** (`* * * * *`) invokes `scheduled()`, which resolves every
  service **concurrently** (`Promise.allSettled`, each upstream guarded by an 8s
  timeout + edge caching) and persists the result to D1. Transitions to/from a
  non-`up` state open and close rows in an `incidents` table.
- `GET /api/status` is a **fast D1 read** of the latest snapshot, with per-service
  **uptime (24h / 7d)** computed from incident intervals. Before the first cron
  run populates D1 it falls back to a live fan-out so the page is never blank.
- `GET /api/incidents` returns the recent incident log (powers the Incidents panel).
- The frontend ([public/app.js](public/app.js)) lays services out with a
  **squarified treemap**: services are grouped into category "sectors", and
  tiles are sized by a per-service `weight` (relative prominence — layout only,
  no other meaning). Hovering a tile shows a card with uptime, component rollup,
  and any active incident.
- **Notifications**: client-side toasts fire when a service flips state between
  polls; the **Incidents panel** shows persisted history that survives reloads.

## Status model

Every service is normalized to one of: `up` · `degraded` · `down` · `unknown`.

| Source type   | How status is derived |
|---------------|-----------------------|
| **Statuspage** | Reads `{base}/api/v2/status.json`. The Atlassian `status.indicator` maps: `none`→`up`, `minor`/`maintenance`→`degraded`, `major`/`critical`→`down`. |
| **Slack**      | Reads Slack's bespoke API. No active incidents → `up`; an incident of type `outage` → `down`; otherwise → `degraded`. |
| **RSS / Atom** | Parses the latest feed entry (via `fast-xml-parser`). Entries older than 48h are treated as resolved (`up`). A fresh entry mentioning *resolved/restored/operational* → `up`; *outage/down/major/critical* → `down`; anything else fresh → `degraded`. Heuristic. |
| **HTTP ping**  | A plain `GET`. `2xx`/`3xx` → `up`; other response → `degraded`; network error or timeout → `down`. |
| *(any)*        | A failed fetch or timeout → `unknown`. |

> Statuspage JSON is authoritative where available. RSS-based status is a
> best-effort heuristic, since incident feeds describe history rather than a
> current-state field.

## Data sources

All data comes from each service's **own public status page / feed**. IsUp is a
read-only aggregator and is not affiliated with any of these services.

| Service | Category | Source type | Endpoint |
|---------|----------|-------------|----------|
| GitHub | Developer & Cloud | Statuspage | `https://www.githubstatus.com/api/v2/status.json` |
| Cloudflare | Developer & Cloud | Statuspage | `https://www.cloudflarestatus.com/api/v2/status.json` |
| npm | Developer & Cloud | Statuspage | `https://status.npmjs.org/api/v2/status.json` |
| DigitalOcean | Developer & Cloud | Statuspage | `https://status.digitalocean.com/api/v2/status.json` |
| Vercel | Developer & Cloud | Statuspage | `https://www.vercel-status.com/api/v2/status.json` |
| AWS | Developer & Cloud | RSS | `https://status.aws.amazon.com/rss/all.rss` |
| OpenAI | AI | Statuspage | `https://status.openai.com/api/v2/status.json` |
| Anthropic | AI | Statuspage | `https://status.claude.com/api/v2/status.json` |
| Stripe | Payments | Statuspage | `https://www.stripestatus.com/api/v2/status.json` |
| Coinbase | Payments | Statuspage | `https://status.coinbase.com/api/v2/status.json` |
| Shopify | Payments | Statuspage | `https://www.shopifystatus.com/api/v2/status.json` |
| Discord | Communication | Statuspage | `https://discordstatus.com/api/v2/status.json` |
| Slack | Communication | Slack API | `https://slack-status.com/api/v2.0.0/current` |
| Zoom | Communication | Statuspage | `https://www.zoomstatus.com/api/v2/status.json` |
| Twilio | Communication | Statuspage | `https://status.twilio.com/api/v2/status.json` |
| Atlassian | Productivity & Media | Statuspage | `https://status.atlassian.com/api/v2/status.json` |
| Dropbox | Productivity & Media | Statuspage | `https://status.dropbox.com/api/v2/status.json` |
| Datadog | Productivity & Media | Statuspage | `https://status.datadoghq.com/api/v2/status.json` |
| Reddit | Productivity & Media | Statuspage | `https://www.redditstatus.com/api/v2/status.json` |
| Wikipedia | Productivity & Media | HTTP ping | `https://www.wikipedia.org` |

The list lives in [src/services.ts](src/services.ts). To add a service, append
an entry with its `category`, a `weight` (tile size), and a `source`. Most
status pages run on Atlassian Statuspage — point `base` at the status host
(omit `/api/v2/status.json`, which is appended automatically).

> **Tip:** Statuspage hosts often `302`-redirect to a canonical domain
> (e.g. `status.zoom.us` → `www.zoomstatus.com`). Use the canonical host in
> `base` to avoid an extra redirect hop.

## Development

| Command | Purpose |
|---------|---------|
| `npm install` | Install dependencies (`fast-xml-parser`, `wrangler`). |
| `npm run db:schema:local` | Apply [`schema.sql`](schema.sql) to the **local** D1 (run once before first dev). |
| `npm run dev` | Local dev server at `http://localhost:8787`. |
| `npm run dev:cron` | Dev server with `--test-scheduled` so the cron can be triggered locally. |
| `npm run types` | Regenerate Worker types (`wrangler types`) after editing `wrangler.jsonc`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run deploy` | Deploy to Cloudflare. |

Trigger the cron and inspect the API locally:

```sh
npm run dev:cron
curl "http://localhost:8787/__scheduled"      # runs scheduled() once → persists a snapshot
curl -s http://localhost:8787/api/status | jq # served from D1, includes per-service uptime
curl -s http://localhost:8787/api/incidents | jq
```

> **Local cron note:** under plain `wrangler dev`, the documented
> `/cdn-cgi/handler/scheduled` test route currently throws a
> `DataCloneError: ... ScheduledController` (a wrangler local-shim bug). Use
> `npm run dev:cron` (`--test-scheduled`) and the `/__scheduled` route instead.
> Production crons invoke `scheduled()` natively and are unaffected.

## Deploying (D1 setup)

```sh
npx wrangler d1 create isup          # paste the printed database_id into wrangler.jsonc
npm run db:schema:remote             # create tables in the remote D1
npm run deploy
```

## Project structure

```
public/            Static frontend (served directly by Cloudflare)
  index.html         Page shell: header, legend, treemap, incidents panel, toasts
  styles.css         Stock-map palette + treemap / hover-card / panel / toast styling
  app.js             Poll loop, squarified treemap, hover card, incidents panel, toasts
src/
  index.ts           Worker entry: scheduled() cron + GET /api/status, /api/incidents
  services.ts        Curated service list + status data sources + shared types
  sources.ts         Per-source-type fetch + normalize (Statuspage/Slack/RSS/HTTP)
  db.ts              D1 persistence: snapshot upserts, incident transitions, uptime
schema.sql           D1 schema (current / incidents / meta tables)
wrangler.jsonc       Worker config (main, static assets, cron trigger, D1 binding)
```

## Notes & limitations

- **Persistence** lives in D1: the `current` snapshot (one row per service),
  an `incidents` log (one row per non-`up` episode), and a `meta` row for the
  last run. Uptime is derived from incident intervals — no high-volume
  per-poll table. `unknown` (a failed/timed-out probe) is treated as "no data":
  it neither opens an incident nor counts as downtime.
- RSS status is heuristic (see the table above).
- `cf: { cacheTtl }` edge caching is a no-op under `wrangler dev`, so local runs
  hit upstreams live on every poll; production caches aggressively.
