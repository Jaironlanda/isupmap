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
 *
 * Pages are pure HTML with inline CSS and no scripts, so they render instantly
 * and need no client runtime. Status/uptime data is passed in by the caller
 * (read from D1), keeping this module free of bindings and easy to unit-test.
 */

import type { ApiService } from "./db";
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

const STATUS_COLOR: Record<StatusLevel, string> = {
	up: "#3fb950",
	degraded: "#d29922",
	down: "#f85149",
	unknown: "#8b949e",
};

function pct(fraction: number): string {
	return `${(fraction * 100).toFixed(2)}%`;
}

function formatUpdated(updatedAt: number | null): string {
	if (!updatedAt) return "just now";
	return new Date(updatedAt).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
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

/**
 * Full HTML for a single service's status page.
 * Uses a full-viewport two-column layout: Protomaps world map on the left,
 * service info + community reports panel on the right.
 * `mapKey` is the Protomaps API key (empty string disables the GL map).
 */
export function renderServicePage(service: Service, current: ApiService | null, updatedAt: number | null, mapKey = ""): string {
	const status: StatusLevel = current?.status ?? "unknown";
	const copy = STATUS_COPY[status];
	const color = STATUS_COLOR[status];
	const name = service.name;

	const title = `Is ${name} down? Live ${name} status — isUpMap`;
	const description = `${copy.sentence(name)} Check live ${name} status, 24-hour and 7-day uptime, and recent incidents on isUpMap.`;
	const canonical = `${CANONICAL_ORIGIN}/status/${service.id}`;

	const note = current?.description ? `<div class="note">${escapeHtml(current.description)}</div>` : "";
	const stats =
		current && status !== "unknown"
			? `<div class="stats">
<div class="stat"><div class="k">24-hour uptime</div><div class="v">${pct(current.uptime.day)}</div></div>
<div class="stat"><div class="k">7-day uptime</div><div class="v">${pct(current.uptime.week)}</div></div>
</div>`
			: "";

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

	// Two-column full-viewport body: map div (left) + scrollable info panel (right).
	const body = `
<div class="sp-wrap">
  <div class="sp-map" id="sp-map"
    data-service-id="${escapeHtml(service.id)}"
    data-map-key="${escapeHtml(mapKey)}"></div>
  <aside class="sp-panel">
    <div class="sp-inner">
      <a class="brand" href="/"><img src="/images/logo/isupmap.png" alt="" width="24" height="24" />isUpMap</a>
      <nav class="crumbs"><a href="/">Home</a> / <a href="/status">Status</a> / ${escapeHtml(name)}</nav>
      <h1>Is ${escapeHtml(name)} down?</h1>
      <span class="badge"><span class="dot" style="background:${color}"></span>${copy.label}</span>
      <p class="meta">${escapeHtml(copy.sentence(name))} Category: ${escapeHtml(service.category)}. Last checked ${formatUpdated(updatedAt)}.</p>
      ${stats}
      ${note}
      <div data-report-widget data-service-id="${escapeHtml(service.id)}"></div>
      <p style="margin-top:20px"><a href="/">← Back to live map</a></p>
      <footer>
        isUpMap checks ${SERVICES.length}+ services every few minutes. Data may lag the provider's own status page.
        &middot; <a href="/status">All services</a>
      </footer>
    </div>
  </aside>
</div>`;

	return layout({
		title,
		description,
		canonical,
		jsonLd,
		body,
		noWrap: true,
		extraHead: `<link rel="stylesheet" href="/lib/maplibre-gl.css" /><link rel="stylesheet" href="/report.css" /><style>html,body{height:100%;overflow:hidden}</style>`,
		scripts: `<script src="/lib/maplibre-gl.js"></script><script src="/report.js" type="module"></script>`,
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
		...SERVICES.map((s) => ({ loc: `${CANONICAL_ORIGIN}/status/${s.id}`, changefreq: "hourly", priority: "0.6" })),
	];
	const body = urls
		.map((u) => `\t<url>\n\t\t<loc>${u.loc}</loc>\n\t\t<changefreq>${u.changefreq}</changefreq>\n\t\t<priority>${u.priority}</priority>\n\t</url>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
