-- isUpMap community reports schema (Cloudflare D1 / SQLite).
-- Applies to REPORTS_DB (separate from the status DB).
-- Applied locally with:  npm run db:schema:reports:local
-- Applied remotely with: npm run db:schema:reports:remote

CREATE TABLE IF NOT EXISTS reports (
	service_id TEXT    NOT NULL,
	ip_hash    TEXT    NOT NULL,
	country    TEXT    NOT NULL,
	reason     TEXT    NOT NULL,       -- one of: unreachable|errors|login|slow|other
	bucket     INTEGER NOT NULL,       -- floor(ts / DEDUP_WINDOW_MS): one vote per IP/window
	ts         INTEGER NOT NULL,
	PRIMARY KEY (service_id, ip_hash, bucket)
);

CREATE INDEX IF NOT EXISTS idx_reports_service_ts ON reports(service_id, ts);
