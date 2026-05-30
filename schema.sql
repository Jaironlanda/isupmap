-- IsUp persistence schema (Cloudflare D1 / SQLite).
-- Applied locally with:  npm run db:schema:local
-- Applied remotely with: npm run db:schema:remote

-- Latest snapshot, one row per service. Upserted by the cron each run.
CREATE TABLE IF NOT EXISTS current (
	service_id   TEXT PRIMARY KEY,
	name         TEXT NOT NULL,
	category     TEXT NOT NULL,
	weight       INTEGER NOT NULL,
	status       TEXT NOT NULL,
	description  TEXT,
	details_json TEXT,
	updated_at   INTEGER NOT NULL -- epoch ms
);

-- One row per non-"up" episode. `ended_at` is NULL while the incident is ongoing.
CREATE TABLE IF NOT EXISTS incidents (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	service_id  TEXT NOT NULL,
	status      TEXT NOT NULL,   -- the non-up status: degraded | down | unknown
	description TEXT,
	started_at  INTEGER NOT NULL, -- epoch ms
	ended_at    INTEGER           -- epoch ms, NULL while ongoing
);

CREATE INDEX IF NOT EXISTS idx_incidents_service ON incidents (service_id, started_at);
-- Fast lookup of the open incident per service.
CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents (service_id) WHERE ended_at IS NULL;

-- Small key/value store (e.g. last cron run timestamp).
CREATE TABLE IF NOT EXISTS meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
