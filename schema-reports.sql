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

-- Per-service report-volume baseline for anomaly ("surge") detection. The cron
-- counts reports in the trailing window each run and compares to this rolling
-- baseline (EWMA mean plus variance). A sustained, statistically high count
-- raises the surge flag. This is a supplementary signal only — it never alters
-- the authoritative status pipeline (confirmStatus, incidents, snapshot color).
-- See detectSurges() in src/reports.ts.
CREATE TABLE IF NOT EXISTS report_baseline (
	service_id  TEXT PRIMARY KEY,
	ewma_rate   REAL    NOT NULL,           -- expected reports per detection bucket
	ewma_var    REAL    NOT NULL,           -- variance estimate (for the z-score)
	surge       INTEGER NOT NULL DEFAULT 0, -- 1 while the confirmed surge is open
	streak      INTEGER NOT NULL DEFAULT 0, -- consecutive anomalous buckets (flap-damp)
	surge_since INTEGER,                    -- epoch ms the surge opened, NULL when clear
	updated_at  INTEGER NOT NULL            -- epoch ms of the last detection pass
);
