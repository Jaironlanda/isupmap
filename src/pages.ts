/**
 * Server-rendered, crawlable pages for isUpMap.
 *
 * The main dashboard (public/index.html) is a client-rendered SPA — great for
 * users, poor for search engines, which see only a "Fetching…" shell. These
 * Worker-rendered pages give crawlers (and no-JS visitors) real, indexable
 * content for high-intent queries like "is GitHub down?":
 *
 *   - `/status/<id>`  — a single service's live status, uptime, and incident note.
 *   - `/status`       — a directory of every tracked service, grouped by category.
 *   - `/sitemap.xml`  — the homepage plus every service page, generated from
 *                       {@link SERVICES} so it can never drift from the catalog.
 *   - `/feed.xml` and `/status/<id>/feed.xml` — Atom feeds of the incident log,
 *                       so any feed reader (or RSS-to-alert tool) can subscribe
 *                       to outages without polling the JSON API.
 *
 * Pages are pure HTML with inline CSS and no scripts, so they render instantly
 * and need no client runtime. Status/uptime data is passed in by the caller
 * (read from D1), keeping this module free of bindings and easy to unit-test.
 */

import type { ApiService, DailyUptime, IncidentRecord } from "./db";
import { SERVICES, type Service, type StatusLevel } from "./services";

/** Canonical origin for <link rel=canonical>, OG tags, and the sitemap. */
export const CANONICAL_ORIGIN = "https://isupmap.com";

/** Look up a tracked service by id (the `/status/<id>` slug). */
export function findService(id: string): Service | undefined {
	return SERVICES.find((s) => s.id === id);
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

interface StatusCopy {
	/** Short label, e.g. "Operational". */
	label: string;
	/** CSS modifier class suffix, e.g. "up". */
	tone: StatusLevel;
	/** Sentence describing the current state, used in <h1>/description. */
	sentence: (name: string) => string;
}

const STATUS_COPY: Record<StatusLevel, StatusCopy> = {
	up: { label: "Operational", tone: "up", sentence: (n) => `${n} is up and operational right now.` },
	degraded: { label: "Degraded", tone: "degraded", sentence: (n) => `${n} is experiencing degraded performance right now.` },
	down: { label: "Down", tone: "down", sentence: (n) => `${n} is down right now.` },
	unknown: { label: "Unknown", tone: "unknown", sentence: (n) => `${n}'s current status is unavailable.` },
};

/**
 * Display-only status: the authoritative {@link StatusLevel} plus a "reported"
 * state used when the probe is up/unknown but community reports are surging.
 * Mirrors `effectiveStatus()` on the frontend — it colors the page, never the
 * SEO copy or any persisted record.
 */
type DisplayStatus = StatusLevel | "reported";

const STATUS_COLOR: Record<DisplayStatus, string> = {
	up: "#3fb950",
	reported: "#f0883e",
	degraded: "#d29922",
	down: "#f85149",
	unknown: "#8b949e",
};

function formatUpdated(updatedAt: number | null): string {
	if (!updatedAt) return "just now";
	// Readable UTC timestamp without seconds, e.g. "Jun 7, 2026, 16:46 UTC".
	const stamp = new Date(updatedAt).toLocaleString("en-US", {
		timeZone: "UTC",
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	return `${stamp} UTC`;
}

/** Best-effort link to the provider's own status page, derived from the source. */
function statusPageUrl(service: Service): string {
	const src = service.source;
	if (src.type === "statuspage") return src.base;
	if (src.statusUrl) return src.statusUrl;
	try {
		return new URL(src.url).origin;
	} catch {
		return src.url;
	}
}

/**
 * Shared <head> + page chrome so every SSR page looks and behaves the same.
 * `extraHead` injects additional <link>/<meta> tags (e.g. for report.css).
 * `scripts` injects <script> tags at the end of <body> (e.g. for report.js).
 */
function layout(opts: {
	title: string;
	description: string;
	canonical: string;
	jsonLd: unknown;
	body: string;
	extraHead?: string;
	scripts?: string;
	/** When true, skips the .wrap div so the body owns the full viewport. */
	noWrap?: boolean;
}): string {
	const bodyContent = opts.noWrap
		? opts.body
		: `<div class="wrap">
<a class="brand" href="/"><img src="/images/logo/isupmap.png" alt="" width="24" height="24" />isUpMap</a>
${opts.body}
<footer>
isUpMap checks ${SERVICES.length}+ services every few minutes. Status reflects the latest automated probe and may lag the provider's own status page.
&middot; <a href="/">Live status map</a> &middot; <a href="/status">All services</a>
&middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a>
</footer>
</div>`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(opts.title)}</title>
<meta name="description" content="${escapeHtml(opts.description)}" />
<link rel="canonical" href="${escapeHtml(opts.canonical)}" />
<meta name="robots" content="index, follow" />
<meta name="theme-color" content="#0f1117" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${escapeHtml(opts.title)}" />
<meta property="og:description" content="${escapeHtml(opts.description)}" />
<meta property="og:url" content="${escapeHtml(opts.canonical)}" />
<meta property="og:site_name" content="isUpMap" />
<meta property="og:image" content="${CANONICAL_ORIGIN}/images/og-map.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(opts.title)}" />
<meta name="twitter:description" content="${escapeHtml(opts.description)}" />
<meta name="twitter:image" content="${CANONICAL_ORIGIN}/images/og-map.png" />
<link rel="icon" type="image/png" href="/images/logo/icon/favicon-32x32.png" />
<link rel="alternate" type="application/atom+xml" title="isUpMap — service incidents" href="${CANONICAL_ORIGIN}/feed.xml" />
<script type="application/ld+json">${JSON.stringify(opts.jsonLd)}</script>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0f1117; color: #e6edf3; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
a { color: #58a6ff; text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
.brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; color: #e6edf3; }
.brand img { width: 24px; height: 24px; }
.crumbs { margin: 24px 0 8px; font-size: 13px; color: #8b949e; }
h1 { font-size: clamp(22px, 4vw, 30px); line-height: 1.2; margin: 8px 0 12px; }
.badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; font-weight: 600; font-size: 14px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); }
.dot { width: 10px; height: 10px; border-radius: 50%; }
.meta { color: #8b949e; font-size: 14px; margin: 8px 0 20px; }
.note { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 16px 18px; margin: 16px 0; }
.stats { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0; }
.stat { flex: 1 1 120px; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 14px 16px; }
.stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #8b949e; }
.stat .v { font-size: 20px; font-weight: 700; margin-top: 4px; }
.cats { margin: 24px 0; }
.cats h2 { font-size: 16px; margin: 24px 0 8px; color: #c9d1d9; }
.cats ul { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px 16px; }
.cats li { display: flex; align-items: center; gap: 8px; }
footer { margin-top: 32px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,.08); font-size: 12px; color: #8b949e; }
</style>
${opts.extraHead ?? ""}
</head>
<body>
${bodyContent}
${opts.scripts ?? ""}
</body>
</html>`;
}

/** "100%", "99.2%", "97.53%" — up to two decimals, trailing zeros dropped. */
function formatPercent(fraction: number): string {
	return `${Math.round(fraction * 10_000) / 100}%`;
}

/** Short UTC day label for bar tooltips, e.g. "Jul 3". */
function formatDay(date: string): string {
	return new Date(`${date}T00:00:00Z`).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

/**
 * The 90-day uptime card: a strip of per-day bars (colored by the day's worst
 * incident status, uptime in the hover tooltip) plus the window average.
 */
function renderUptimeCard(history: DailyUptime[]): string {
	const avg = history.reduce((sum, d) => sum + d.uptime, 0) / history.length;
	const bars = history
		.map((d) => `<span class="sp-ubar sp-ubar--${d.worst}" title="${formatDay(d.date)} — ${formatPercent(d.uptime)}"></span>`)
		.join("");
	return `
      <section class="sp-card sp-card--uptime">
        <div class="sp-uptime-head">
          <h2 class="sp-uptime-title">${history.length}-day uptime</h2>
          <span class="sp-uptime-agg">${formatPercent(avg)}</span>
        </div>
        <div class="sp-uptime-bars" role="img" aria-label="Daily uptime over the last ${history.length} days: ${formatPercent(avg)} average">${bars}</div>
        <div class="sp-uptime-scale" aria-hidden="true"><span>${history.length} days ago</span><span>Today</span></div>
      </section>`;
}

/**
 * Full HTML for a single service's status page.
 *
 * When `showMap` is true, uses a full-viewport two-column layout: Protomaps
 * world map on the left, service info + community reports panel on the right.
 * When false (e.g. a service with no community reports), the map — and the
 * MapLibre/Protomaps assets it needs — are skipped entirely and the details
 * panel is centered, saving the heavy map download and tile requests.
 * `mapKey` is the Protomaps API key (empty string disables the GL map).
 * `history` (per-UTC-day uptime, oldest first) renders the 90-day bar strip;
 * omit it (or pass an empty array) to skip the card entirely.
 */
export function renderServicePage(service: Service, current: ApiService | null, updatedAt: number | null, mapKey = "", showMap = true, history?: DailyUptime[]): string {
	const status: StatusLevel = current?.status ?? "unknown";
	const copy = STATUS_COPY[status];
	// Display-only: a surging up/unknown service shows as "reported" (orange).
	// SEO copy below stays on the authoritative `status` so meta never claims an
	// unconfirmed, crowd-sourced problem.
	const surging = !!current?.surge && (status === "up" || status === "unknown");
	const display: DisplayStatus = surging ? "reported" : status;
	const beatLabel = surging ? "Reported" : copy.label;
	const color = STATUS_COLOR[display];
	const name = service.name;

	const title = `Is ${name} down? Live ${name} status — isUpMap`;
	const description = `${copy.sentence(name)} Check live ${name} status, 24-hour and 7-day uptime, and recent incidents on isUpMap.`;
	const canonical = `${CANONICAL_ORIGIN}/status/${service.id}`;

	// Incident / status note, shown as a subtle line inside the service card.
	const note = current?.description
		? `<p class="sp-svc-note">${escapeHtml(current.description)}</p>`
		: "";

	// Animated ECG "heartbeat" indicator — stroke colour follows the live status,
	// and the hover tooltip reveals when the probe last ran.
	const checked = formatUpdated(updatedAt);
	// When surging, the indicator's hover tooltip explains the "Reported" state.
	const beatTip = surging
		? "Users are reporting problems — volume is spiking above normal."
		: `Checked ${escapeHtml(checked)}`;
	const heartbeat = `<span class="sp-beat sp-beat--${display}" title="${beatTip}" aria-label="${beatLabel} — checked ${escapeHtml(checked)}">
        <span class="sp-beat-label">${beatLabel}</span>
        <span class="sp-beat-dot" aria-hidden="true"></span>
      </span>`;

	const provider = statusPageUrl(service);
	let providerHost = "";
	try {
		providerHost = new URL(provider).host;
	} catch {
		/* provider isn't a parseable URL; omit the host line */
	}
	const iconUrl = `/images/logo/services/${escapeHtml(service.id)}.png`;

	const jsonLd = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "BreadcrumbList",
				itemListElement: [
					{ "@type": "ListItem", position: 1, name: "isUpMap", item: `${CANONICAL_ORIGIN}/` },
					{ "@type": "ListItem", position: 2, name: "Status", item: `${CANONICAL_ORIGIN}/status` },
					{ "@type": "ListItem", position: 3, name, item: canonical },
				],
			},
			{
				"@type": "WebPage",
				name: title,
				description,
				url: canonical,
				isPartOf: { "@id": `${CANONICAL_ORIGIN}/#website` },
			},
		],
	};

	// Statuspage-style 90-day uptime strip: one class-colored bar per UTC day
	// (pure HTML/CSS — the page CSP allows no scripts beyond the report widget).
	const uptimeCard = history?.length ? renderUptimeCard(history) : "";

	// Scrollable info panel — shared by both the two-column (with map) and the
	// centered solo (no map) layouts.
	const panel = `
  <aside class="sp-panel${showMap ? "" : " sp-panel--solo"}">
    <div class="sp-inner" style="--status:${color}">
      <header class="sp-top">
        <div class="sp-top-left">
          <a class="sp-back-btn" href="/" aria-label="Back to status map" title="Back to status map">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </a>
          <a class="brand" href="/"><img src="/images/logo/isupmap.png" alt="" width="22" height="22" />isUpMap</a>
        </div>
        <nav class="crumbs"><a href="/status">Status</a> / ${escapeHtml(name)}</nav>
      </header>

      <h1 class="sp-q">Is ${escapeHtml(name)} down?</h1>

      <section class="sp-card sp-card--service sp-card--${status}">
        <div class="sp-svc">
          <img class="sp-logo" src="${iconUrl}" alt="" width="40" height="40" loading="lazy" />
          <div class="sp-svc-main">
            <div class="sp-svc-top">
              <div class="sp-svc-name">${escapeHtml(name)}</div>
              ${heartbeat}
            </div>
            <div class="sp-svc-cat">${escapeHtml(service.category)}</div>
          </div>
        </div>
        ${note}
        <hr class="sp-rule" />
        <a class="sp-ext" href="${escapeHtml(provider)}" target="_blank" rel="noopener nofollow">
          <span class="sp-ext-main">
            <span>Official ${escapeHtml(name)} status page</span>
            ${providerHost ? `<span class="sp-ext-host">${escapeHtml(providerHost)}</span>` : ""}
          </span>
          <span class="sp-ext-arrow" aria-hidden="true">↗</span>
        </a>
      </section>
${uptimeCard}
      <section class="sp-card" data-report-widget data-service-id="${escapeHtml(service.id)}"></section>

      <footer>
        isUpMap checks ${SERVICES.length}+ services every few minutes. Status reflects the latest automated probe and may lag the provider's own page.
        &middot; <a href="/status">All services</a>
        &middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a>
      </footer>
    </div>
  </aside>`;

	const body = showMap
		? `
<div class="sp-wrap">
  <div class="sp-map" id="sp-map"
    data-service-id="${escapeHtml(service.id)}"
    data-map-key="${escapeHtml(mapKey)}"></div>${panel}
</div>`
		: `
<div class="sp-wrap sp-wrap--solo">${panel}
</div>`;

	// MapLibre CSS/JS are only shipped when the map actually renders.
	const mapCss = showMap ? `<link rel="stylesheet" href="/lib/maplibre-gl.css" />` : "";
	const mapJs = showMap ? `<script src="/lib/maplibre-gl.js"></script>` : "";

	return layout({
		title,
		description,
		canonical,
		jsonLd,
		body,
		noWrap: true,
		extraHead: `${mapCss}<link rel="stylesheet" href="/report.css" /><link rel="alternate" type="application/atom+xml" title="${escapeHtml(name)} incidents — isUpMap" href="${canonical}/feed.xml" /><style>html,body{height:100%;overflow:hidden}</style>`,
		scripts: `${mapJs}<script src="/report.js" type="module"></script>`,
	});
}

/** Directory of every tracked service, grouped by category, for crawl discovery. */
export function renderStatusIndex(): string {
	const title = "Service status directory — isUpMap";
	const description = `Live up/down status for ${SERVICES.length}+ services across AI, developer & cloud, payments, communication, and more.`;
	const canonical = `${CANONICAL_ORIGIN}/status`;

	const byCategory = new Map<string, Service[]>();
	for (const s of SERVICES) {
		const list = byCategory.get(s.category) ?? [];
		list.push(s);
		byCategory.set(s.category, list);
	}

	const sections = [...byCategory.entries()]
		.map(([category, services]) => {
			const items = services
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((s) => `<li><a href="/status/${s.id}">Is ${escapeHtml(s.name)} down?</a></li>`)
				.join("");
			return `<h2>${escapeHtml(category)}</h2><ul>${items}</ul>`;
		})
		.join("");

	const jsonLd = {
		"@context": "https://schema.org",
		"@type": "CollectionPage",
		name: title,
		description,
		url: canonical,
		isPartOf: { "@id": `${CANONICAL_ORIGIN}/#website` },
	};

	const body = `
<nav class="crumbs"><a href="/">Home</a> / Status</nav>
<h1>Service status directory</h1>
<p class="meta">${escapeHtml(description)}</p>
<div class="cats">${sections}</div>`;

	return layout({ title, description, canonical, jsonLd, body });
}

/** Minimal 404 page for an unknown `/status/<id>` slug. */
export function renderNotFound(): string {
	const body = `
<nav class="crumbs"><a href="/">Home</a> / Status</nav>
<h1>Service not found</h1>
<p class="meta">We don't track that service (yet).</p>
<p><a href="/status">Browse all tracked services →</a></p>`;
	return layout({
		title: "Not found — isUpMap",
		description: "The requested service status page does not exist.",
		canonical: `${CANONICAL_ORIGIN}/status`,
		jsonLd: { "@context": "https://schema.org", "@type": "WebPage", name: "Not found" },
		body,
	});
}

/** XML sitemap: the homepage, the status directory, and every service page. */
export function renderSitemap(): string {
	const urls = [
		{ loc: `${CANONICAL_ORIGIN}/`, changefreq: "hourly", priority: "1.0" },
		{ loc: `${CANONICAL_ORIGIN}/status`, changefreq: "hourly", priority: "0.8" },
		{ loc: `${CANONICAL_ORIGIN}/terms`, changefreq: "monthly", priority: "0.3" },
		{ loc: `${CANONICAL_ORIGIN}/privacy`, changefreq: "monthly", priority: "0.3" },
		{ loc: `${CANONICAL_ORIGIN}/bot`, changefreq: "monthly", priority: "0.3" },
		...SERVICES.map((s) => ({ loc: `${CANONICAL_ORIGIN}/status/${s.id}`, changefreq: "hourly", priority: "0.6" })),
	];
	const body = urls
		.map((u) => `\t<url>\n\t\t<loc>${u.loc}</loc>\n\t\t<changefreq>${u.changefreq}</changefreq>\n\t\t<priority>${u.priority}</priority>\n\t</url>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/** Human-readable duration for feed copy, e.g. "45m", "3h 20m", "2d 5h". */
function formatDuration(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
	const days = Math.floor(hours / 24);
	return `${days}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

/**
 * Atom feed of the incident log — the whole map (`/feed.xml`) or a single
 * service (`/status/<id>/feed.xml` when `service` is given). Atom over RSS 2.0
 * because it has unambiguous timestamps and required entry ids.
 *
 * Entry ids are permanent (`/status/<sid>#incident-<row id>`), and `<updated>`
 * moves when an incident resolves — so readers show recovery as an update to
 * the same item rather than a duplicate. Incidents come from the caller (D1's
 * {@link IncidentRecord}), keeping this module free of bindings.
 */
export function renderIncidentFeed(incidents: IncidentRecord[], service?: Service, now = Date.now()): string {
	const feedUrl = service ? `${CANONICAL_ORIGIN}/status/${service.id}/feed.xml` : `${CANONICAL_ORIGIN}/feed.xml`;
	const htmlUrl = service ? `${CANONICAL_ORIGIN}/status/${service.id}` : `${CANONICAL_ORIGIN}/`;
	const title = service ? `${service.name} incidents — isUpMap` : "isUpMap — service incidents";
	const subtitle = service
		? `Outages and degraded-performance incidents for ${service.name}, detected by isUpMap's automated probes.`
		: `Outages and degraded-performance incidents across the ${SERVICES.length}+ services isUpMap tracks.`;

	// Feed-level <updated>: the newest activity in any entry (resolution counts), or `now` when empty.
	const latest = incidents.reduce((max, i) => Math.max(max, i.endedAt ?? i.startedAt), 0);

	const entries = incidents
		.map((i) => {
			const name = i.serviceName ?? i.serviceId;
			const label = i.status === "down" ? "down" : "degraded";
			const resolved = i.endedAt != null;
			const entryTitle = resolved ? `Resolved: ${name} was ${label} for ${formatDuration(i.endedAt! - i.startedAt)}` : `${name} is ${label}`;
			const when = resolved
				? `Started ${formatUpdated(i.startedAt)}, resolved ${formatUpdated(i.endedAt!)}.`
				: `Started ${formatUpdated(i.startedAt)}; ongoing as of the latest probe.`;
			const summary = `${i.description ? `${i.description} — ` : ""}${when}`;
			return `\t<entry>
\t\t<title>${escapeHtml(entryTitle)}</title>
\t\t<link href="${CANONICAL_ORIGIN}/status/${escapeHtml(i.serviceId)}"/>
\t\t<id>${CANONICAL_ORIGIN}/status/${escapeHtml(i.serviceId)}#incident-${i.id}</id>
\t\t<published>${new Date(i.startedAt).toISOString()}</published>
\t\t<updated>${new Date(i.endedAt ?? i.startedAt).toISOString()}</updated>
\t\t<summary>${escapeHtml(summary)}</summary>
\t</entry>`;
		})
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
\t<title>${escapeHtml(title)}</title>
\t<subtitle>${escapeHtml(subtitle)}</subtitle>
\t<link href="${feedUrl}" rel="self" type="application/atom+xml"/>
\t<link href="${htmlUrl}"/>
\t<id>${feedUrl}</id>
\t<updated>${new Date(latest || now).toISOString()}</updated>
\t<author><name>isUpMap</name></author>
${entries}
</feed>
`;
}
