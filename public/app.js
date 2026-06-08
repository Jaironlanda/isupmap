// isUpMap frontend: poll /api/status, render a stock-map style treemap, toast on flips.

const POLL_INTERVAL_MS = 45_000;
const TOAST_TIMEOUT_MS = 8_000;
const TILE_GAP = 2; // px gap between tiles, for the grid-line look
const SECTOR_HEADER = 22; // px reserved for a sector label band

const STATUS_LABEL = {
	up: "Operational",
	degraded: "Degraded",
	down: "Down",
	unknown: "Unknown",
};

// Brand domain per service id. Logos are self-hosted (see logoUrl); this map
// doubles as the "has a logo" gate and a record of each service's domain.
const LOGO_DOMAIN = {
	github: "github.com", cloudflare: "cloudflare.com", npm: "npmjs.com", digitalocean: "digitalocean.com",
	vercel: "vercel.com", netlify: "netlify.com", mongodb: "mongodb.com", sentry: "sentry.io",
	circleci: "circleci.com", linode: "linode.com", render: "render.com", aws: "aws.amazon.com",
	gcp: "cloud.google.com", azure: "azure.microsoft.com",
	supabase: "supabase.com", flyio: "fly.io", railway: "railway.app", neon: "neon.tech",
	planetscale: "planetscale.com", bunny: "bunny.net", auth0: "auth0.com", clerk: "clerk.com",
	hashicorp: "hashicorp.com", snowflake: "snowflake.com", elastic: "elastic.co", newrelic: "newrelic.com",
	grafana: "grafana.com", pagerduty: "pagerduty.com", algolia: "algolia.com", gitlab: "gitlab.com",
	docker: "docker.com", appwrite: "appwrite.io", firebase: "firebase.google.com",
	openai: "openai.com", anthropic: "anthropic.com", xai: "x.ai", groq: "groq.com",
	elevenlabs: "elevenlabs.io", cohere: "cohere.com", replicate: "replicate.com", pinecone: "pinecone.io",
	runway: "runwayml.com", huggingface: "huggingface.co", togetherai: "together.ai",
	perplexity: "perplexity.ai", stability: "stability.ai", deepgram: "deepgram.com", assemblyai: "assemblyai.com",
	cursor: "cursor.com",
	stripe: "stripe.com", coinbase: "coinbase.com", shopify: "shopify.com",
	plaid: "plaid.com", paddle: "paddle.com", lemonsqueezy: "lemonsqueezy.com",
	square: "squareup.com", klarna: "klarna.com", paypal: "paypal.com",
	discord: "discord.com", slack: "slack.com", zoom: "zoom.us",
	twilio: "twilio.com", sendgrid: "sendgrid.com", resend: "resend.com", mailgun: "mailgun.com",
	intercom: "intercom.com", hubspot: "hubspot.com",
	atlassian: "atlassian.com", dropbox: "dropbox.com",
	datadog: "datadoghq.com", reddit: "reddit.com", figma: "figma.com", box: "box.com",
	squarespace: "squarespace.com", wikipedia: "wikipedia.org", linear: "linear.app",
	notion: "notion.so", cloudinary: "cloudinary.com",
	asana: "asana.com", airtable: "airtable.com", miro: "miro.com", canva: "canva.com",
	webflow: "webflow.com", docusign: "docusign.com",
	twitch: "twitch.tv", epicgames: "epicgames.com", netflix: "netflix.com", roblox: "roblox.com",
	steam: "steampowered.com", playstation: "playstation.com", riot: "riotgames.com", spotify: "spotify.com",
};

/** Logo URL for a service id, or null if unknown. Self-hosted under /images. */
function logoUrl(id) {
	return LOGO_DOMAIN[id] ? `/images/logo/services/${id}.png` : null;
}

const gridEl = document.getElementById("grid");
const updatedEl = document.getElementById("updatedText");
const updatedBoxEl = document.getElementById("updated");
const toastsEl = document.getElementById("toasts");
const tooltipEl = document.getElementById("tooltip");

/** Previous status per service id, used to detect changes. Null until first load. */
let previous = null;
/** Latest snapshot, kept so we can re-layout on window resize. */
let latest = null;
/** Service id to briefly highlight (e.g. after picking it in the palette). */
let highlightId = null;
let highlightTimer = null;

// --- Local preferences (browser-only, no server state) --------------------

const PREFS_KEY = "isupmap:prefs";

function loadPrefs() {
	try {
		const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
		return {
			hidden: new Set(Array.isArray(raw.hidden) ? raw.hidden : []),
			problemsOnly: !!raw.problemsOnly,
			theme: raw.theme === "light" ? "light" : "dark",
			notify: !!raw.notify,
		};
	} catch {
		return { hidden: new Set(), problemsOnly: false, theme: "dark", notify: false };
	}
}

function savePrefs() {
	try {
		localStorage.setItem(
			PREFS_KEY,
			JSON.stringify({ hidden: [...prefs.hidden], problemsOnly: prefs.problemsOnly, theme: prefs.theme, notify: prefs.notify }),
		);
	} catch {
		/* storage unavailable (private mode); prefs simply won't persist */
	}
}

const prefs = loadPrefs();

/** The services to actually render, after applying hide + problems-only prefs. */
function visibleServices() {
	if (!latest) return [];
	// Disabled services (unreliable source) are never tiled — they only appear,
	// locked, in the Customize panel.
	let v = latest.filter((s) => !s.disabled && !prefs.hidden.has(s.id));
	if (prefs.problemsOnly) v = v.filter((s) => s.status !== "up");
	return v;
}

/** Filter the latest snapshot through prefs, then render (or show an empty state). */
function renderView() {
	if (!latest) return;
	const v = visibleServices();
	if (v.length === 0) {
		const anyVisible = latest.some((s) => !s.disabled && !prefs.hidden.has(s.id));
		const msg =
			prefs.problemsOnly && anyVisible
				? "✓ All selected services are operational"
				: "No services selected — open Customize to add some.";
		gridEl.innerHTML = `<p class="grid__empty">${escapeHtml(msg)}</p>`;
		gridEl.classList.remove("grid--focus");
		return;
	}
	render(v);
}

let warmRetry = null;

async function poll() {
	try {
		// `no-store` bypasses the browser HTTP cache so the 45s poll always gets a
		// fresh snapshot. Cloudflare's edge cache still serves (and shields D1) —
		// `no-store` is a browser-only directive and doesn't bust the edge cache.
		const res = await fetch("/api/status", { cache: "no-store", headers: { accept: "application/json" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		latest = data.services;
		renderView();
		updateTimestamp(data.updatedAt, data.stale, data.ageMs);
		updateChrome(latest);
		detectChanges(latest);
		handleDeepLinkOnce();
		// Before the first cron run the snapshot is still "warming" (no updatedAt):
		// poll again shortly instead of waiting the full 45s so the grid fills in fast.
		clearTimeout(warmRetry);
		if (data.updatedAt == null) warmRetry = setTimeout(poll, 4000);
	} catch (err) {
		if (!latest) {
			gridEl.innerHTML = `<p class="grid__error">Couldn't load status (${escapeHtml(String(err.message ?? err))}). Retrying…</p>`;
		}
		// On transient errors after a successful load, keep the last view visible.
	}
}

function updateTimestamp(updatedAt, stale = false, ageMs = null) {
	const when = updatedAt ? new Date(updatedAt) : new Date();
	// When the snapshot is stale (the cron hasn't refreshed in a while), warn
	// instead of implying the status is live. Otherwise show the refresh time.
	if (stale) {
		const ago = ageMs != null ? ` (${formatAge(ageMs)} ago)` : "";
		updatedEl.textContent = `Data may be outdated${ago}`;
	} else {
		updatedEl.textContent = `Updated ${when.toLocaleTimeString()}`;
	}
	updatedBoxEl?.classList.toggle("is-stale", Boolean(stale));
	if (updatedBoxEl) updatedBoxEl.title = stale ? `Last refreshed ${when.toLocaleString()}` : "";
}

/** Compact "5m" / "2h" / "1d" age from a millisecond duration. */
function formatAge(ms) {
	const mins = Math.round(ms / 60000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

// --- Squarified treemap ---------------------------------------------------
// Bruls/Huizing/van Wijk squarified treemap. Packs weighted items into a rect
// while keeping tile aspect ratios close to square.

function worstRatio(row, side) {
	let sum = 0;
	let max = -Infinity;
	let min = Infinity;
	for (const a of row) {
		sum += a;
		if (a > max) max = a;
		if (a < min) min = a;
	}
	const s2 = sum * sum;
	const l2 = side * side;
	return Math.max((l2 * max) / s2, s2 / (l2 * min));
}

/** Lay weighted `items` ({ value, ... }) into rect {x,y,w,h}. Returns rects with x,y,w,h. */
function squarify(items, rect) {
	const out = [];
	const positive = items.filter((d) => d.value > 0);
	if (positive.length === 0 || rect.w <= 0 || rect.h <= 0) return out;

	const total = positive.reduce((s, d) => s + d.value, 0);
	const scale = (rect.w * rect.h) / total;
	const nodes = positive
		.map((d) => ({ data: d, area: d.value * scale }))
		.sort((a, b) => b.area - a.area);

	let free = { ...rect };
	let row = [];
	let rowAreas = [];

	const placeRow = () => {
		const rowArea = rowAreas.reduce((a, b) => a + b, 0);
		const horizontal = free.w < free.h; // lay row along the shorter side
		if (horizontal) {
			const thickness = rowArea / free.w;
			let x = free.x;
			for (const n of row) {
				const w = n.area / thickness;
				out.push({ data: n.data, x, y: free.y, w, h: thickness });
				x += w;
			}
			free = { x: free.x, y: free.y + thickness, w: free.w, h: free.h - thickness };
		} else {
			const thickness = rowArea / free.h;
			let y = free.y;
			for (const n of row) {
				const h = n.area / thickness;
				out.push({ data: n.data, x: free.x, y, w: thickness, h });
				y += h;
			}
			free = { x: free.x + thickness, y: free.y, w: free.w - thickness, h: free.h };
		}
		row = [];
		rowAreas = [];
	};

	for (const node of nodes) {
		const side = Math.min(free.w, free.h);
		const candidate = rowAreas.concat(node.area);
		if (row.length === 0 || worstRatio(candidate, side) <= worstRatio(rowAreas, side)) {
			row.push(node);
			rowAreas.push(node.area);
		} else {
			placeRow();
			row.push(node);
			rowAreas.push(node.area);
		}
	}
	if (row.length) placeRow();
	return out;
}

// --- Rendering ------------------------------------------------------------

function render(services) {
	const W = gridEl.clientWidth;
	const H = gridEl.clientHeight;
	if (W === 0 || H === 0) return; // not laid out yet

	// Group into sectors (categories), preserving first-seen order.
	const byCategory = new Map();
	for (const svc of services) {
		if (!byCategory.has(svc.category)) byCategory.set(svc.category, []);
		byCategory.get(svc.category).push(svc);
	}

	const sectors = [...byCategory.entries()].map(([name, items]) => ({
		name,
		items,
		value: items.reduce((s, x) => s + (x.weight || 1), 0),
	}));

	const sectorRects = squarify(sectors, { x: 0, y: 0, w: W, h: H });

	const frag = document.createDocumentFragment();
	for (const rect of sectorRects) {
		frag.appendChild(renderSector(rect));
	}
	gridEl.replaceChildren(frag);
	// Spotlight mode: dim/blur everything but the picked tile while a focus is active.
	gridEl.classList.toggle("grid--focus", highlightId != null);
}

function renderSector(rect) {
	const { name, items } = rect.data;
	const sector = document.createElement("section");
	sector.className = "sector";
	setBox(sector, rect.x, rect.y, rect.w, rect.h, TILE_GAP / 2);

	const label = document.createElement("div");
	label.className = "sector__label";
	label.textContent = name;
	sector.appendChild(label);

	const showHeader = rect.h > SECTOR_HEADER + 24;
	const headerH = showHeader ? SECTOR_HEADER : 0;
	if (!showHeader) label.style.display = "none";

	// Lay tiles into the sector's content box (relative to the sector element).
	const content = { x: 0, y: headerH, w: rect.w - TILE_GAP, h: rect.h - headerH - TILE_GAP / 2 };
	const tileRects = squarify(
		items.map((svc) => ({ ...svc, value: svc.weight || 1 })),
		content,
	);
	for (const t of tileRects) {
		sector.appendChild(renderTile(t));
	}
	return sector;
}

function renderTile(rect) {
	const svc = rect.data;
	const tile = document.createElement("article");
	tile.className = `tile is-${svc.status}${svc.id === highlightId ? " tile--flash" : ""}`;
	setBox(tile, rect.x, rect.y, rect.w, rect.h, TILE_GAP / 2);
	tile._svc = svc; // stash data for the hover card

	// Scale typography to tile size, like a stock-map ticker block.
	const minSide = Math.min(rect.w, rect.h);
	const nameSize = clamp(minSide * 0.22, 11, 30);
	const showStatus = rect.h > 46 && rect.w > 60;

	// Brand logo on a white chip (legible on any tile color), when there's room.
	const url = logoUrl(svc.id);
	if (url && minSide > 52) {
		const logo = document.createElement("div");
		logo.className = "tile__logo";
		const sz = clamp(minSide * 0.32, 18, 48);
		logo.style.width = `${sz}px`;
		logo.style.height = `${sz}px`;
		logo.style.backgroundImage = `url("${url}")`;
		tile.appendChild(logo);
	}

	const name = document.createElement("div");
	name.className = "tile__name";
	name.style.fontSize = `${nameSize}px`;
	name.textContent = svc.name;
	tile.appendChild(name);

	if (showStatus) {
		const status = document.createElement("div");
		status.className = "tile__status";
		status.style.fontSize = `${clamp(nameSize * 0.55, 9, 14)}px`;
		status.textContent = STATUS_LABEL[svc.status] ?? svc.status;
		tile.appendChild(status);
	}
	return tile;
}

/** Position an absolutely-placed box, inset by `inset` px on every side for the gap. */
function setBox(el, x, y, w, h, inset) {
	el.style.left = `${x + inset}px`;
	el.style.top = `${y + inset}px`;
	el.style.width = `${Math.max(0, w - inset * 2)}px`;
	el.style.height = `${Math.max(0, h - inset * 2)}px`;
}

function clamp(v, lo, hi) {
	return Math.min(hi, Math.max(lo, v));
}

// --- Hover card -----------------------------------------------------------

function formatPct(frac) {
	if (typeof frac !== "number") return "—";
	const pct = frac * 100;
	// Avoid rounding 99.97% up to a misleading "100%".
	if (pct >= 99.995) return "100%";
	return `${pct.toFixed(pct >= 99.9 ? 2 : 1)}%`;
}

function relativeTime(iso) {
	if (!iso) return "";
	const then = typeof iso === "number" ? iso : Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const diff = Date.now() - then;
	const mins = Math.round(diff / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.round(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	return `${Math.round(hrs / 24)}d ago`;
}

function buildTooltip(svc) {
	const d = svc.details ?? {};
	const rows = [];

	rows.push(`<div class="tooltip__head">
		<span class="dot is-${svc.status}"></span>
		<span class="tooltip__name">${escapeHtml(svc.name)}</span>
		<span class="tooltip__badge is-${svc.status}">${STATUS_LABEL[svc.status]}</span>
	</div>`);

	if (svc.description) rows.push(`<div class="tooltip__desc">${escapeHtml(svc.description)}</div>`);

	if (svc.uptime) {
		rows.push(`<div class="tooltip__row"><span>Uptime</span><strong>24h ${formatPct(svc.uptime.day)} · 7d ${formatPct(svc.uptime.week)}</strong></div>`);
	}

	if (d.components && d.components.total > 0) {
		const c = d.components;
		rows.push(`<div class="tooltip__row"><span>Components</span><strong>${c.operational}/${c.total} operational</strong></div>`);
		if (c.impacted.length) {
			rows.push(`<div class="tooltip__impacted">${c.impacted.slice(0, 6).map(escapeHtml).join(" · ")}${c.impacted.length > 6 ? " …" : ""}</div>`);
		}
	}

	if (d.incident) {
		const rel = relativeTime(d.incident.updatedAt);
		rows.push(`<div class="tooltip__incident">
			⚠ ${escapeHtml(d.incident.name)}${d.incident.impact ? ` <em>(${escapeHtml(d.incident.impact)})</em>` : ""}${rel ? ` · ${rel}` : ""}
		</div>`);
	}

	if (d.note) rows.push(`<div class="tooltip__row tooltip__note">${escapeHtml(d.note)}</div>`);

	if (d.updatedAt && !d.incident) {
		const rel = relativeTime(d.updatedAt);
		if (rel) rows.push(`<div class="tooltip__row"><span>Updated</span><strong>${rel}</strong></div>`);
	}

	if (d.url) {
		try {
			rows.push(`<div class="tooltip__link">${escapeHtml(new URL(d.url).host)}</div>`);
		} catch {
			/* ignore malformed url */
		}
	}

	return rows.join("");
}

function showTooltip(svc, clientX, clientY) {
	tooltipEl.innerHTML = buildTooltip(svc);
	tooltipEl.hidden = false;
	positionTooltip(clientX, clientY);
}

function positionTooltip(clientX, clientY) {
	const pad = 14;
	const rect = tooltipEl.getBoundingClientRect();
	let x = clientX + pad;
	let y = clientY + pad;
	if (x + rect.width > window.innerWidth - 8) x = clientX - rect.width - pad;
	if (y + rect.height > window.innerHeight - 8) y = clientY - rect.height - pad;
	tooltipEl.style.left = `${Math.max(8, x)}px`;
	tooltipEl.style.top = `${Math.max(8, y)}px`;
}

function hideTooltip() {
	tooltipEl.hidden = true;
}

// Hover tooltips only on hover-capable devices; touch devices tap a tile to
// open the detail sheet instead (no hover state to rely on).
const canHover = window.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? true;

// Delegated hover handling on the grid (tiles are recreated every poll).
gridEl.addEventListener("mousemove", (e) => {
	if (!canHover) return;
	const tile = e.target.closest(".tile");
	if (tile && tile._svc) {
		if (tooltipEl.hidden || tooltipEl._for !== tile._svc.id) {
			showTooltip(tile._svc, e.clientX, e.clientY);
			tooltipEl._for = tile._svc.id;
		} else {
			positionTooltip(e.clientX, e.clientY);
		}
	} else {
		hideTooltip();
		tooltipEl._for = null;
	}
});
gridEl.addEventListener("mouseleave", () => {
	hideTooltip();
	tooltipEl._for = null;
});

// --- Change detection / toasts -------------------------------------------

function detectChanges(services) {
	const current = new Map(services.map((s) => [s.id, s]));
	if (previous) {
		for (const [id, svc] of current) {
			const prev = previous.get(id);
			if (!prev || prev.status === svc.status) continue;
			// Don't toast for services the user has hidden.
			if (prefs.hidden.has(id)) continue;
			// Only toast on meaningful operational transitions, not unknown<->x noise.
			if (prev.status === "unknown" || svc.status === "unknown") continue;
			showToast(svc, prev.status);
			maybeNotify(svc, prev.status);
		}
	}
	previous = current;
}

function showToast(svc, prevStatus) {
	const recovered = svc.status === "up";
	const variant = recovered ? "up" : svc.status === "down" ? "down" : "degraded";

	const toast = document.createElement("div");
	toast.className = `toast toast--${variant}`;
	toast.setAttribute("role", "status");

	const title = document.createElement("div");
	title.className = "toast__title";
	title.textContent = recovered
		? `✅ ${svc.name} is back up`
		: `⚠️ ${svc.name} is ${STATUS_LABEL[svc.status].toLowerCase()}`;

	const body = document.createElement("div");
	body.className = "toast__body";
	body.textContent = `${STATUS_LABEL[prevStatus]} → ${STATUS_LABEL[svc.status]}${svc.description ? ` · ${svc.description}` : ""}`;

	toast.append(title, body);
	toastsEl.appendChild(toast);
	setTimeout(() => toast.remove(), TOAST_TIMEOUT_MS);
}

function escapeHtml(str) {
	const div = document.createElement("div");
	div.textContent = str;
	return div.innerHTML;
}

// --- Incidents panel ------------------------------------------------------

const incidentsBtn = document.getElementById("incidentsBtn");
const incidentsClose = document.getElementById("incidentsClose");
const incidentsPanel = document.getElementById("incidentsPanel");
const incidentsList = document.getElementById("incidentsList");

function formatDuration(ms) {
	const mins = Math.round(ms / 60000);
	if (mins < 60) return `${mins}m`;
	const hrs = Math.floor(mins / 60);
	const rem = mins % 60;
	if (hrs < 24) return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
	return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

async function loadIncidents() {
	incidentsList.innerHTML = `<p class="panel__empty">Loading…</p>`;
	try {
		const res = await fetch("/api/incidents?limit=40", { cache: "no-store", headers: { accept: "application/json" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const { incidents } = await res.json();
		renderIncidents(incidents);
	} catch (err) {
		incidentsList.innerHTML = `<p class="panel__empty">Couldn't load incidents (${escapeHtml(String(err.message ?? err))}).</p>`;
	}
}

function renderIncidents(incidents) {
	if (!incidents || incidents.length === 0) {
		incidentsList.innerHTML = `<p class="panel__empty">No incidents recorded yet. 🎉</p>`;
		return;
	}
	incidentsList.innerHTML = incidents
		.map((i) => {
			const ongoing = i.endedAt == null;
			const duration = formatDuration((ongoing ? Date.now() : i.endedAt) - i.startedAt);
			const when = new Date(i.startedAt).toLocaleString();
			return `<div class="incident is-${i.status}">
				<div class="incident__top">
					<span class="incident__name">${escapeHtml(i.serviceName ?? i.serviceId)}</span>
					<span class="incident__badge is-${i.status}">${STATUS_LABEL[i.status] ?? i.status}</span>
				</div>
				${i.description ? `<div class="incident__desc">${escapeHtml(i.description)}</div>` : ""}
				<div class="incident__meta">
					<span>${escapeHtml(when)}</span>
					<span>${ongoing ? `ongoing · ${duration}` : `lasted ${duration}`}</span>
				</div>
			</div>`;
		})
		.join("");
}

function toggleIncidents(open) {
	const show = open ?? incidentsPanel.hidden;
	if (show) closePanels({ except: "incidents" });
	incidentsPanel.hidden = !show;
	incidentsBtn.setAttribute("aria-expanded", String(show));
	if (show) loadIncidents();
}

incidentsBtn.addEventListener("click", () => toggleIncidents());
incidentsClose.addEventListener("click", () => toggleIncidents(false));

// --- Customize panel (show/hide services, persisted locally) --------------

const customizeBtn = document.getElementById("customizeBtn");
const customizeClose = document.getElementById("customizeClose");
const customizePanel = document.getElementById("customizePanel");
const customizeList = document.getElementById("customizeList");
const customizeReset = document.getElementById("customizeReset");
const customizeSearch = document.getElementById("customizeSearch");
const customizeSearchClear = document.getElementById("customizeSearchClear");
const customizeCollapse = document.getElementById("customizeCollapse");

// Local-only UI state for the panel (not persisted).
let czQuery = "";
const czCollapsed = new Set();

function toggleCustomize(open) {
	const show = open ?? customizePanel.hidden;
	if (show) closePanels({ except: "customize" });
	customizePanel.hidden = !show;
	customizeBtn.setAttribute("aria-expanded", String(show));
	if (show) {
		renderCustomize();
		// Defer focus so the panel is visible before we grab the caret.
		requestAnimationFrame(() => customizeSearch.focus());
	}
}

function renderCustomize() {
	if (!latest) {
		customizeList.innerHTML = `<p class="panel__empty">Loading…</p>`;
		return;
	}
	const byCategory = new Map();
	for (const svc of latest) {
		if (!byCategory.has(svc.category)) byCategory.set(svc.category, []);
		byCategory.get(svc.category).push(svc);
	}

	// Disabled services can't be selected, so they're excluded from the
	// shown/total tallies (which describe the selectable set).
	const selectableTotal = latest.filter((s) => !s.disabled).length;
	const shown = latest.filter((s) => !s.disabled && !prefs.hidden.has(s.id)).length;
	const countEl = document.getElementById("customizeCount");
	const searching = czQuery.length > 0;

	let matchCount = 0;
	let html = "";
	for (const [category, items] of byCategory) {
		// While searching, keep services whose name OR category matches.
		const matches = searching
			? items.filter((s) => fuzzyMatch(czQuery, `${s.name} ${s.category}`))
			: items;
		if (matches.length === 0) continue;
		matchCount += matches.length;

		// Category toggle + counts only consider selectable (non-disabled) services.
		const selectable = items.filter((s) => !s.disabled);
		const allShown = selectable.length > 0 && selectable.every((s) => !prefs.hidden.has(s.id));
		const shownInCat = selectable.filter((s) => !prefs.hidden.has(s.id)).length;
		// Searching force-expands so matches are always visible.
		const collapsed = !searching && czCollapsed.has(category);

		html += `<div class="cz-group${collapsed ? " is-collapsed" : ""}">
			<div class="cz-group__head" data-category-head="${escapeHtml(category)}" role="button" tabindex="0" aria-expanded="${collapsed ? "false" : "true"}">
				<i data-lucide="chevron-down" class="cz-group__chevron" aria-hidden="true"></i>
				<input class="cz-group__check" type="checkbox" data-category="${escapeHtml(category)}" ${allShown ? "checked" : ""} aria-label="Toggle all ${escapeHtml(category)}" />
				<span class="cz-group__name">${escapeHtml(category)}</span>
				<span class="cz-group__count">${shownInCat}/${selectable.length}</span>
			</div>
			<div class="cz-group__body">`;
		for (const svc of matches) {
			if (svc.disabled) {
				// Locked row: can't be toggled; explains why on hover.
				html += `<div class="cz-row is-disabled" title="${escapeHtml(svc.disabled)}">
					<input type="checkbox" disabled />
					<span class="dot is-unknown"></span>
					<span class="cz-row__name">${escapeHtml(svc.name)}</span>
					<span class="cz-badge">disabled</span>
				</div>`;
				continue;
			}
			html += `<label class="cz-row">
				<input type="checkbox" data-id="${escapeHtml(svc.id)}" ${prefs.hidden.has(svc.id) ? "" : "checked"} />
				<span class="dot is-${svc.status}"></span>
				<span class="cz-row__name">${escapeHtml(svc.name)}</span>
			</label>`;
		}
		html += `</div></div>`;
	}

	if (searching && matchCount === 0) {
		html = `<p class="panel__empty">No services match “${escapeHtml(czQuery)}”.</p>`;
		countEl.textContent = `0 matches`;
	} else {
		countEl.textContent = searching
			? `${matchCount} match${matchCount === 1 ? "" : "es"}`
			: `${shown} of ${selectableTotal} shown`;
	}

	customizeList.innerHTML = html;
	const icons = [...customizeList.querySelectorAll("i[data-lucide]")];
	if (icons.length) lucide.createIcons({ nodes: icons });
	syncCollapseBtn();
}

// Reflect whether every category is currently collapsed in the toggle label.
function syncCollapseBtn() {
	if (!latest) return;
	const categories = [...new Set(latest.map((s) => s.category))];
	const allCollapsed = categories.length > 0 && categories.every((c) => czCollapsed.has(c));
	customizeCollapse.textContent = allCollapsed ? "Expand all" : "Collapse all";
	customizeCollapse.setAttribute("aria-expanded", String(!allCollapsed));
}

// Delegated change handler for the customize checkboxes.
customizeList.addEventListener("change", (e) => {
	const cb = e.target;
	if (!(cb instanceof HTMLInputElement)) return;
	if (cb.dataset.id) {
		if (cb.checked) prefs.hidden.delete(cb.dataset.id);
		else prefs.hidden.add(cb.dataset.id);
	} else if (cb.dataset.category) {
		for (const svc of latest.filter((s) => s.category === cb.dataset.category && !s.disabled)) {
			if (cb.checked) prefs.hidden.delete(svc.id);
			else prefs.hidden.add(svc.id);
		}
	}
	savePrefs();
	renderView();
	renderCustomize();
});

// Click/keyboard on a category header (but not its checkbox) collapses it.
function toggleCategory(category) {
	if (czCollapsed.has(category)) czCollapsed.delete(category);
	else czCollapsed.add(category);
	renderCustomize();
}
customizeList.addEventListener("click", (e) => {
	const head = e.target.closest(".cz-group__head");
	if (!head || e.target.closest(".cz-group__check")) return;
	if (czQuery) return; // headers are non-collapsible while searching
	toggleCategory(head.dataset.categoryHead);
});
customizeList.addEventListener("keydown", (e) => {
	if (e.key !== "Enter" && e.key !== " ") return;
	const head = e.target.closest(".cz-group__head");
	if (!head || e.target.closest(".cz-group__check") || czQuery) return;
	e.preventDefault();
	toggleCategory(head.dataset.categoryHead);
});

// Search box: filter the list as the user types.
customizeSearch.addEventListener("input", () => {
	czQuery = customizeSearch.value.trim();
	customizeSearchClear.hidden = czQuery.length === 0;
	renderCustomize();
});
customizeSearchClear.addEventListener("click", () => {
	customizeSearch.value = "";
	czQuery = "";
	customizeSearchClear.hidden = true;
	renderCustomize();
	customizeSearch.focus();
});

// Collapse-all / expand-all toggle.
customizeCollapse.addEventListener("click", () => {
	const categories = [...new Set((latest ?? []).map((s) => s.category))];
	const allCollapsed = categories.length > 0 && categories.every((c) => czCollapsed.has(c));
	if (allCollapsed) czCollapsed.clear();
	else for (const c of categories) czCollapsed.add(c);
	renderCustomize();
});

customizeReset.addEventListener("click", () => {
	prefs.hidden.clear();
	prefs.problemsOnly = false;
	savePrefs();
	syncProblemsBtn();
	renderView();
	renderCustomize();
});

customizeBtn.addEventListener("click", () => toggleCustomize());
customizeClose.addEventListener("click", () => toggleCustomize(false));

function closePanels({ except } = {}) {
	if (except !== "incidents") toggleIncidentsClosed();
	if (except !== "customize") customizePanel.hidden = true;
	if (except !== "sidebar") closeSidebar();
	closeDetail();
}
// Avoid recursion: close incidents without re-triggering closePanels.
function toggleIncidentsClosed() {
	incidentsPanel.hidden = true;
	incidentsBtn.setAttribute("aria-expanded", "false");
}

// --- Phone sidebar (hamburger menu) ---------------------------------------
// On phones the toolbar + statusbar are relocated into an off-canvas drawer,
// leaving only brand + search in the header. On tablet/desktop they stay put.

const menuBtn = document.getElementById("menuBtn");
const sidebar = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebarOverlay");
const sidebarClose = document.getElementById("sidebarClose");
const sidebarBody = document.getElementById("sidebarBody");
const toolbarEl = document.querySelector(".toolbar");
const statusbarEl = document.querySelector(".statusbar");
const phoneMq = window.matchMedia("(max-width: 640px)");

// Remember each relocatable node's original home so we can restore it.
const chromeHomes = [toolbarEl, statusbarEl]
	.filter(Boolean)
	.map((node) => ({ node, parent: node.parentNode, next: node.nextSibling }));

/** Move chrome into the drawer on phones, or back to its original spot otherwise. */
function relocateChrome() {
	if (phoneMq.matches) {
		for (const { node } of chromeHomes) {
			if (node.parentNode !== sidebarBody) sidebarBody.appendChild(node);
		}
	} else {
		for (const { node, parent, next } of chromeHomes) {
			if (node.parentNode !== parent) parent.insertBefore(node, next);
		}
		closeSidebar();
	}
}

function openSidebar() {
	closePanels({ except: "sidebar" });
	sidebar.hidden = false;
	sidebarOverlay.hidden = false;
	// Next frame so the transition runs from the off-canvas state.
	requestAnimationFrame(() => {
		sidebar.classList.add("is-open");
		sidebarOverlay.classList.add("is-open");
	});
	menuBtn.setAttribute("aria-expanded", "true");
}

let sidebarHideTimer = null;
function closeSidebar() {
	if (!sidebar || sidebar.hidden) return;
	sidebar.classList.remove("is-open");
	sidebarOverlay.classList.remove("is-open");
	menuBtn.setAttribute("aria-expanded", "false");
	// Hide once the slide-out finishes; fall back to a timer if the
	// transition never fires (e.g. tab hidden, motion disabled).
	let done = false;
	const finish = () => {
		if (done) return;
		done = true;
		clearTimeout(sidebarHideTimer);
		sidebar.removeEventListener("transitionend", finish);
		sidebar.hidden = true;
		sidebarOverlay.hidden = true;
	};
	sidebar.addEventListener("transitionend", finish);
	sidebarHideTimer = setTimeout(finish, 300);
}

menuBtn.addEventListener("click", () => {
	sidebar.hidden ? openSidebar() : closeSidebar();
});
sidebarClose.addEventListener("click", () => closeSidebar());
sidebarOverlay.addEventListener("click", () => closeSidebar());
phoneMq.addEventListener("change", relocateChrome);

// --- Problems-only filter -------------------------------------------------

const problemsBtn = document.getElementById("problemsBtn");

function syncProblemsBtn() {
	problemsBtn.classList.toggle("is-active", prefs.problemsOnly);
	problemsBtn.setAttribute("aria-pressed", String(prefs.problemsOnly));
}

problemsBtn.addEventListener("click", () => {
	prefs.problemsOnly = !prefs.problemsOnly;
	savePrefs();
	syncProblemsBtn();
	renderView();
});

// --- Command palette (⌘K) -------------------------------------------------

const paletteEl = document.getElementById("palette");
const paletteInput = document.getElementById("paletteInput");
const paletteResults = document.getElementById("paletteResults");
let paletteItems = [];
let paletteActive = 0;

/** Loose subsequence match: do the query chars appear in order in the text? */
function fuzzyMatch(query, text) {
	if (!query) return true;
	const t = text.toLowerCase();
	let i = 0;
	for (const ch of query.toLowerCase()) {
		i = t.indexOf(ch, i);
		if (i === -1) return false;
		i++;
	}
	return true;
}

function commandItems() {
	return [
		{
			label: prefs.problemsOnly ? "Show all statuses" : "Filter: problems only",
			hint: "filter",
			run: () => problemsBtn.click(),
		},
		{ label: "Customize services", hint: "view", run: () => toggleCustomize(true) },
		{ label: "Recent incidents", hint: "view", run: () => toggleIncidents(true) },
		{ label: prefs.theme === "light" ? "Switch to dark theme" : "Switch to light theme", hint: "theme", run: toggleTheme },
		{ label: prefs.notify ? "Disable desktop notifications" : "Enable desktop notifications", hint: "alerts", run: () => setNotify(!prefs.notify) },
		{ label: "Show all services", hint: "reset", run: () => customizeReset.click() },
	];
}

function buildPaletteItems(query) {
	const commands = commandItems()
		.filter((c) => fuzzyMatch(query, c.label))
		.map((c) => ({ ...c, kind: "command" }));
	const services = (latest ?? [])
		.filter((s) => fuzzyMatch(query, `${s.name} ${s.category}`))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((s) => ({
			label: s.name,
			hint: `${s.category} · ${STATUS_LABEL[s.status]}`,
			status: s.status,
			kind: "service",
			run: () => focusService(s.id),
		}));
	return [...commands, ...services];
}

function renderPalette(query) {
	paletteItems = buildPaletteItems(query);
	paletteActive = 0;
	if (paletteItems.length === 0) {
		paletteResults.innerHTML = `<li class="palette__empty">No matches</li>`;
		return;
	}
	paletteResults.innerHTML = paletteItems
		.map(
			(it, i) => `<li class="palette__item${i === 0 ? " is-active" : ""}" data-i="${i}" role="option">
			${it.kind === "service" ? `<span class="dot is-${it.status}"></span>` : `<span class="palette__cmd">›</span>`}
			<span class="palette__label">${escapeHtml(it.label)}</span>
			<span class="palette__hint">${escapeHtml(it.hint)}</span>
		</li>`,
		)
		.join("");
}

function setPaletteActive(idx) {
	const items = paletteResults.querySelectorAll(".palette__item");
	if (items.length === 0) return;
	paletteActive = (idx + items.length) % items.length;
	items.forEach((el, i) => el.classList.toggle("is-active", i === paletteActive));
	items[paletteActive].scrollIntoView({ block: "nearest" });
}

function openPalette() {
	closePanels();
	paletteEl.hidden = false;
	paletteInput.value = "";
	renderPalette("");
	paletteInput.focus();
}

function closePalette() {
	paletteEl.hidden = true;
}

function runPaletteItem(i) {
	const it = paletteItems[i];
	if (!it) return;
	closePalette();
	it.run();
}

paletteInput.addEventListener("input", () => renderPalette(paletteInput.value.trim()));
paletteInput.addEventListener("keydown", (e) => {
	if (e.key === "ArrowDown") {
		e.preventDefault();
		setPaletteActive(paletteActive + 1);
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		setPaletteActive(paletteActive - 1);
	} else if (e.key === "Enter") {
		e.preventDefault();
		runPaletteItem(paletteActive);
	}
});
paletteResults.addEventListener("click", (e) => {
	const li = e.target.closest(".palette__item");
	if (li) runPaletteItem(Number(li.dataset.i));
});
paletteEl.addEventListener("click", (e) => {
	if (e.target === paletteEl) closePalette(); // click backdrop
});
document.getElementById("searchBtn").addEventListener("click", openPalette);

/** End spotlight mode: drop the highlight, timer, and outside-click listener. */
function clearSpotlight() {
	if (highlightId == null) return;
	highlightId = null;
	clearTimeout(highlightTimer);
	document.removeEventListener("pointerdown", onSpotlightOutside, true);
	renderView();
}

/** Cancel the spotlight when the user clicks anywhere but the focused tile. */
function onSpotlightOutside(e) {
	if (!e.target.closest?.(".tile--flash")) clearSpotlight();
}

/** Bring a service into view and flash it (used by the palette). */
function focusService(id) {
	prefs.hidden.delete(id);
	const svc = latest?.find((s) => s.id === id);
	if (prefs.problemsOnly && svc && svc.status === "up") prefs.problemsOnly = false;
	savePrefs();
	syncProblemsBtn();
	highlightId = id;
	renderView();
	clearTimeout(highlightTimer);
	highlightTimer = setTimeout(clearSpotlight, 30_000);
	// Dismiss on any click outside the spotlighted tile. Deferred so the click
	// that opened the spotlight (the palette pick) doesn't immediately cancel it.
	document.removeEventListener("pointerdown", onSpotlightOutside, true);
	setTimeout(() => document.addEventListener("pointerdown", onSpotlightOutside, true), 0);
}

// --- Theme ----------------------------------------------------------------

const themeBtn = document.getElementById("themeBtn");

function applyTheme() {
	document.documentElement.dataset.theme = prefs.theme;
	// Rebuild the placeholder each time: lucide.createIcons() swaps <i> for <svg>,
	// so we re-insert a fresh <i> and let lucide render the new glyph.
	const icon = prefs.theme === "light" ? "moon" : "sun";
	// Keep the sidebar label alongside the icon when rebuilding the glyph.
	themeBtn.innerHTML = `<i data-lucide="${icon}"></i><span class="tbar-btn__label">Toggle theme</span>`;
	lucide.createIcons({ nodes: [themeBtn.querySelector("i[data-lucide]")] });
	themeBtn.title = prefs.theme === "light" ? "Switch to dark theme" : "Switch to light theme";
}

function toggleTheme() {
	prefs.theme = prefs.theme === "light" ? "dark" : "light";
	savePrefs();
	applyTheme();
}

themeBtn.addEventListener("click", toggleTheme);

// --- Favicon + document title reflect overall state -----------------------

const faviconEl = document.getElementById("favicon");

function worstStatus(services) {
	if (services.some((s) => s.status === "down")) return "down";
	if (services.some((s) => s.status === "degraded")) return "degraded";
	return "up";
}

function updateChrome(services) {
	const issues = services.filter((s) => s.status === "down" || s.status === "degraded").length;
	document.title = issues > 0 ? `(${issues}) isUpMap — issues` : "isUpMap — Service Status";
	const countEl = document.getElementById("problemsCount");
	if (countEl) {
		countEl.textContent = issues;
		countEl.hidden = issues === 0;
	}

	updateStatusbar(services);

	const color = { up: "#40c057", degraded: "#f0b429", down: "#fa5252" }[worstStatus(services)];
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 32;
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.arc(16, 16, 14, 0, Math.PI * 2);
	ctx.fill();
	faviconEl.href = canvas.toDataURL("image/png");
}

// --- Statusbar: overall summary + live per-status counts ------------------

const statusSummaryEl = document.getElementById("statusSummary");
const statusSummaryDot = statusSummaryEl?.querySelector(".statusbar__dot");
const statusSummaryText = document.getElementById("statusSummaryText");
const legendCountEls = {
	up: document.querySelector('[data-count="up"]'),
	degraded: document.querySelector('[data-count="degraded"]'),
	down: document.querySelector('[data-count="down"]'),
	unknown: document.querySelector('[data-count="unknown"]'),
};

function updateStatusbar(services) {
	const counts = { up: 0, degraded: 0, down: 0, unknown: 0 };
	for (const s of services) {
		counts[s.status] = (counts[s.status] ?? 0) + 1;
	}

	for (const [status, el] of Object.entries(legendCountEls)) {
		if (!el) continue;
		el.textContent = counts[status];
		el.closest(".legend__item")?.classList.toggle("is-empty", counts[status] === 0);
	}

	// Overall pill mirrors the worst live status with a plain-language summary.
	const worst = worstStatus(services);
	if (statusSummaryDot) {
		statusSummaryDot.className = `statusbar__dot is-${worst}`;
	}
	if (statusSummaryText) {
		const issues = counts.down + counts.degraded;
		if (services.length === 0) {
			statusSummaryText.textContent = "No services selected";
		} else if (issues === 0) {
			statusSummaryText.textContent = "All systems operational";
		} else {
			const parts = [];
			if (counts.down) parts.push(`${counts.down} down`);
			if (counts.degraded) parts.push(`${counts.degraded} degraded`);
			statusSummaryText.textContent = parts.join(" · ");
		}
	}

	// When there are issues, the pill toggles the Problems-only filter; otherwise
	// it's purely informational.
	const hasIssues = counts.down + counts.degraded > 0;
	statusSummaryEl.disabled = !hasIssues && !prefs.problemsOnly;
	statusSummaryEl.classList.toggle("is-active", prefs.problemsOnly);
}

statusSummaryEl?.addEventListener("click", () => {
	prefs.problemsOnly = !prefs.problemsOnly;
	savePrefs();
	syncProblemsBtn();
	statusSummaryEl.classList.toggle("is-active", prefs.problemsOnly);
	renderView();
});

// --- Browser notifications ------------------------------------------------

const notifyToggle = document.getElementById("notifyToggle");

function syncNotifyToggle() {
	notifyToggle.checked = prefs.notify && Notification?.permission === "granted";
}

async function setNotify(on) {
	if (on) {
		if (!("Notification" in window)) {
			alert("This browser doesn't support notifications.");
			return;
		}
		let perm = Notification.permission;
		if (perm === "default") perm = await Notification.requestPermission();
		if (perm !== "granted") {
			prefs.notify = false;
			savePrefs();
			syncNotifyToggle();
			return;
		}
	}
	prefs.notify = on;
	savePrefs();
	syncNotifyToggle();
}

notifyToggle.addEventListener("change", () => setNotify(notifyToggle.checked));

function maybeNotify(svc, prevStatus) {
	if (!prefs.notify || !("Notification" in window) || Notification.permission !== "granted") return;
	const recovered = svc.status === "up";
	const title = recovered ? `✅ ${svc.name} is back up` : `⚠️ ${svc.name} is ${STATUS_LABEL[svc.status].toLowerCase()}`;
	const body = `${STATUS_LABEL[prevStatus]} → ${STATUS_LABEL[svc.status]}${svc.description ? ` · ${svc.description}` : ""}`;
	try {
		new Notification(title, { body, icon: faviconEl.href, tag: `isupmap-${svc.id}` });
	} catch {
		/* notifications can throw on some platforms; ignore */
	}
}

// --- Service detail modal -------------------------------------------------

const detailEl = document.getElementById("detail");
const detailBody = document.getElementById("detailBody");
let detailId = null;

async function openDetail(svc) {
	if (!svc) return;
	detailId = svc.id;
	closePanels({ except: "detail" });
	closePalette();
	detailEl.hidden = false;
	setUrlParam("service", svc.id);
	renderDetailHeader(svc);
	// Mount the report widget if the module has loaded.
	const widgetEl = detailBody.querySelector("[data-report-widget]");
	if (widgetEl && window.isupReport) {
		window.isupReport.mount(widgetEl, svc.id, { status: svc.status });
	}
	// Incident history for this service: the 2 most recent, queried per-service.
	// The whole section stays hidden unless there's at least one incident (no
	// flash while loading, no empty-state filler).
	const historyEl = detailBody.querySelector(".detail__history");
	try {
		const res = await fetch(`/api/incidents?service=${encodeURIComponent(svc.id)}&limit=2`, { cache: "no-store", headers: { accept: "application/json" } });
		const { incidents } = await res.json();
		// Guard against a slow response after the user reopened a different service.
		if (detailId !== svc.id) return;
		if (incidents && incidents.length) {
			renderDetailIncidents(incidents);
			historyEl.hidden = false;
		}
	} catch {
		/* leave the section hidden on error — nothing to show */
	}
}

// CSS variable name per status — used for the tinted service card (--ds).
const DETAIL_STATUS_VAR = {
	up: "var(--up-hi)",
	degraded: "var(--degraded-hi)",
	down: "var(--down-hi)",
	unknown: "var(--muted)",
};

function renderDetailHeader(svc) {
	const d = svc.details ?? {};
	const statusVar = DETAIL_STATUS_VAR[svc.status] ?? "var(--muted)";

	// Note shown inside the card: prefer the active incident name, fall back to description.
	const noteText = d.incident
		? `⚠ ${d.incident.name}${d.incident.impact ? ` · ${d.incident.impact}` : ""}`
		: svc.description ?? "";
	const noteHtml = noteText ? `<p class="detail__svc-note">${escapeHtml(noteText)}</p>` : "";

	// Official status page link inside the card, with the host shown muted below.
	let host = "";
	try {
		if (d.url) host = new URL(d.url).host;
	} catch {
		/* ignore malformed url */
	}
	const extLinkHtml = d.url
		? `<hr class="detail__rule" /><a class="detail__svc-ext" href="${encodeURI(d.url)}" target="_blank" rel="noopener noreferrer">
			<span class="detail__svc-ext-main">
				<span>Official ${escapeHtml(svc.name)} status page</span>
				${host ? `<span class="detail__svc-ext-host">${escapeHtml(host)}</span>` : ""}
			</span>
			<span class="detail__svc-ext-arrow" aria-hidden="true">↗</span>
		</a>`
		: "";

	detailBody.innerHTML = `
		<p class="detail__question">Is ${escapeHtml(svc.name)} down?</p>
		<div class="detail__svc-card" style="--ds:${statusVar}">
			<div class="detail__svc">
				<span class="detail__logo" id="detailLogo"></span>
				<div class="detail__svc-main">
					<div class="detail__svc-top">
						<span class="detail__svc-name">${escapeHtml(svc.name)}</span>
						<span class="detail__beat detail__beat--${svc.status}">
							<span class="detail__beat-label">${STATUS_LABEL[svc.status]}</span>
							<span class="detail__beat-dot" aria-hidden="true"></span>
						</span>
					</div>
					<div class="detail__svc-cat">${escapeHtml(svc.category)}</div>
				</div>
			</div>
			${noteHtml}
			${extLinkHtml}
		</div>
		<div class="detail__report-card">
			<div data-report-widget data-service-id="${escapeHtml(svc.id)}"></div>
		</div>
		<section class="detail__history" hidden>
			<div class="detail__section-head">
				<h3 class="detail__subhead">Incident history</h3>
			</div>
			<div class="detail__incidents"></div>
		</section>`;

	// Set logo via CSSOM (avoids inline style= under our CSP).
	const logoEl = detailBody.querySelector("#detailLogo");
	const lurl = logoUrl(svc.id);
	if (lurl) logoEl.style.backgroundImage = `url("${lurl}")`;
	else logoEl.remove();

	// Tint the modal top border to reflect service status.
	detailEl.querySelector(".modal__box").className = `modal__box is-${svc.status}`;

	// Render Lucide icons injected by the template.
	const newIcons = [...detailBody.querySelectorAll("i[data-lucide]")];
	if (newIcons.length) lucide.createIcons({ nodes: newIcons });
}

function renderDetailIncidents(incidents) {
	const host = detailBody.querySelector(".detail__incidents");
	if (!incidents || incidents.length === 0) {
		host.innerHTML = `<p class="panel__empty">No incidents recorded. 🎉</p>`;
		return;
	}
	host.innerHTML = incidents
		.map((i) => {
			const ongoing = i.endedAt == null;
			const duration = formatDuration((ongoing ? Date.now() : i.endedAt) - i.startedAt);
			return `<div class="detail-inc is-${i.status}">
				<div class="detail-inc__top">
					<span class="detail-inc__badge is-${i.status}">${STATUS_LABEL[i.status] ?? i.status}</span>
					<span class="detail-inc__dur">${duration}</span>
					<span class="detail-inc__state${ongoing ? " detail-inc__state--live" : ""}">${ongoing ? "Ongoing" : "Resolved"}</span>
				</div>
				${i.description ? `<p class="detail-inc__desc">${escapeHtml(i.description)}</p>` : ""}
				<div class="detail-inc__date">${escapeHtml(new Date(i.startedAt).toLocaleString())}</div>
			</div>`;
		})
		.join("");
}

function closeDetail() {
	if (!detailEl || detailEl.hidden) return;
	detailEl.hidden = true;
	detailId = null;
	setUrlParam("service", null);
}

detailEl.addEventListener("click", (e) => {
	if (e.target === detailEl || e.target.closest("[data-close]")) closeDetail();
});

// Open the detail modal when a tile is clicked.
gridEl.addEventListener("click", (e) => {
	const tile = e.target.closest(".tile");
	if (tile && tile._svc) openDetail(tile._svc);
});

// --- Deep links (?service= / ?filter=) ------------------------------------

function setUrlParam(key, value) {
	const url = new URL(location.href);
	if (value == null) url.searchParams.delete(key);
	else url.searchParams.set(key, value);
	history.replaceState(null, "", url);
}

let deepLinkDone = false;
function handleDeepLinkOnce() {
	if (deepLinkDone || !latest) return;
	deepLinkDone = true;
	const params = new URLSearchParams(location.search);
	const filter = params.get("filter");
	if (filter === "problems" || filter === "down") {
		prefs.problemsOnly = true; // view-only; not persisted (shared-link driven)
		syncProblemsBtn();
		renderView();
	}
	const serviceId = params.get("service");
	if (serviceId) {
		const svc = latest.find((s) => s.id === serviceId);
		if (svc) openDetail(svc);
	}
}

// Keep ?filter= in sync when the user toggles problems-only.
problemsBtn.addEventListener("click", () => setUrlParam("filter", prefs.problemsOnly ? "problems" : null));

// --- Global keyboard shortcuts --------------------------------------------

document.addEventListener("keydown", (e) => {
	if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
		e.preventDefault();
		paletteEl.hidden ? openPalette() : closePalette();
		return;
	}
	if (e.key === "Escape") {
		if (!paletteEl.hidden) closePalette();
		else if (!detailEl.hidden) closeDetail();
		else closePanels();
	}
});

// --- Bootstrap ------------------------------------------------------------

// Re-layout on resize (debounced) using the latest snapshot.
let resizeTimer = null;
window.addEventListener("resize", () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(renderView, 150);
});

lucide.createIcons();
relocateChrome();
applyTheme();
syncProblemsBtn();
syncNotifyToggle();
poll();
setInterval(poll, POLL_INTERVAL_MS);
