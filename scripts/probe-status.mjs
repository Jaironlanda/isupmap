/**
 * Probe live upstream status for a category and dump the raw classification
 * signal, so we can see how each provider reports state — and where the
 * top-level indicator disagrees with the component-level reality.
 *
 *   node scripts/probe-status.mjs                       # Developer & Cloud
 *   node scripts/probe-status.mjs "AI"                  # another category
 *   node scripts/probe-status.mjs --all                 # every category
 *
 * Read-only: only GETs upstream status endpoints. Node 24 strips the TS types,
 * so we import the real SERVICES list instead of duplicating it.
 */

import { SERVICES } from "../src/services.ts";

const UA = "isUpMap-StatusMonitor/1.0 (+https://github.com)";
const TIMEOUT_MS = 15000;

async function get(url, init = {}) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { "user-agent": UA, ...(init.headers ?? {}) } });
		return res;
	} finally {
		clearTimeout(timer);
	}
}

/** Prod indicator → status mapping (mirrors statuspageStatus in src/sources.ts):
 *  a major/critical indicator only reads as `down` when the major outage is
 *  broad; a localized one (few components affected) is tempered to `degraded`. */
const MIN_COMPONENTS = 4;
const BROAD_MAJOR_FRACTION = 0.5;
function indicatorToStatus(indicator, total, majorOutages) {
	switch (indicator) {
		case "none": return "up";
		case "minor": case "maintenance": return "degraded";
		case "major": case "critical":
			if (total < MIN_COMPONENTS) return "down";
			return majorOutages / total >= BROAD_MAJOR_FRACTION ? "down" : "degraded";
		default: return "unknown";
	}
}

async function probeStatuspage(svc, base) {
	const res = await get(`${base.replace(/\/$/, "")}/api/v2/summary.json`);
	if (!res.ok) return { verdict: "unknown", note: `HTTP ${res.status}` };
	const data = await res.json();
	const indicator = data.status?.indicator ?? "none";

	// Per-component status histogram (skip group containers — they roll up children).
	const comps = (data.components ?? []).filter((c) => c.group !== true);
	const hist = {};
	for (const c of comps) hist[c.status ?? "?"] = (hist[c.status ?? "?"] ?? 0) + 1;
	const impacted = comps.filter((c) => c.status && c.status !== "operational");
	const majorOutages = comps.filter((c) => c.status === "major_outage").length;

	return {
		verdict: indicatorToStatus(indicator, comps.length, majorOutages),
		indicator,
		desc: data.status?.description ?? "",
		components: `${comps.length - impacted.length}/${comps.length} ok`,
		hist,
		impacted: impacted.map((c) => `${c.name}=${c.status}`),
		incidents: (data.incidents ?? []).length,
	};
}

async function probeRss(svc, url) {
	const res = await get(url);
	if (!res.ok) return { verdict: "unknown", note: `HTTP ${res.status}` };
	const xml = await res.text();
	// Cheap latest-entry peek (no XML lib needed for a probe).
	const item = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/i)?.[0] ?? "";
	const title = (item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
		.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
	const date = item.match(/<(?:pubDate|updated|published)[^>]*>([\s\S]*?)<\/(?:pubDate|updated|published)>/i)?.[1]?.trim();
	const body = (item.match(/<(?:description|summary|content)[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/i)?.[1] ?? "")
		.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
	return { verdict: "(rss)", title: title || "(no items)", date, bodyLead: body.slice(0, 160) };
}

async function probeHttp(svc, url) {
	const start = Date.now();
	const res = await get(url, { redirect: "follow" });
	return { verdict: res.ok || (res.status >= 300 && res.status < 400) ? "up" : `HTTP ${res.status}`, ms: Date.now() - start, status: res.status };
}

async function probe(svc) {
	try {
		switch (svc.source.type) {
			case "statuspage": return await probeStatuspage(svc, svc.source.base);
			case "rss": return await probeRss(svc, svc.source.url);
			case "http": return await probeHttp(svc, svc.source.url);
		}
	} catch (err) {
		return { verdict: "ERROR", note: err?.name === "AbortError" ? "timeout" : String(err?.message ?? err) };
	}
}

const arg = process.argv[2];
const category = arg && arg !== "--all" ? arg : "Developer & Cloud";
const list = arg === "--all" ? SERVICES : SERVICES.filter((s) => s.category === category);

console.log(`\nProbing ${list.length} services${arg === "--all" ? " (all)" : ` in "${category}"`}\n${"=".repeat(72)}`);

for (const svc of list) {
	const r = await probe(svc);
	const tag = `${svc.name} [${svc.source.type}]`.padEnd(28);
	if (svc.source.type === "statuspage") {
		console.log(`${tag} → ${String(r.verdict).toUpperCase().padEnd(9)} indicator=${r.indicator ?? "?"}  ${r.components ?? ""}`);
		if (r.hist) console.log(`${" ".repeat(30)}hist=${JSON.stringify(r.hist)}  incidents=${r.incidents}`);
		if (r.impacted?.length) console.log(`${" ".repeat(30)}impacted: ${r.impacted.join(", ")}`);
		if (r.note) console.log(`${" ".repeat(30)}${r.note}`);
	} else if (svc.source.type === "rss") {
		console.log(`${tag} → ${r.title ?? r.note ?? ""}  ${r.date ? `(${r.date})` : ""}`);
		if (r.bodyLead) console.log(`${" ".repeat(30)}body: ${r.bodyLead}`);
	} else {
		console.log(`${tag} → ${String(r.verdict).toUpperCase()}  ${r.ms != null ? `${r.ms}ms` : ""}  ${r.note ?? ""}`);
	}
}
console.log("");
