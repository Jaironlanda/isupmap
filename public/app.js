// IsUp frontend: poll /api/status, render a stock-map style treemap, toast on flips.

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

const gridEl = document.getElementById("grid");
const updatedEl = document.getElementById("updated");
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

const PREFS_KEY = "isup:prefs";

function loadPrefs() {
	try {
		const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
		return { hidden: new Set(Array.isArray(raw.hidden) ? raw.hidden : []), problemsOnly: !!raw.problemsOnly };
	} catch {
		return { hidden: new Set(), problemsOnly: false };
	}
}

function savePrefs() {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify({ hidden: [...prefs.hidden], problemsOnly: prefs.problemsOnly }));
	} catch {
		/* storage unavailable (private mode); prefs simply won't persist */
	}
}

const prefs = loadPrefs();

/** The services to actually render, after applying hide + problems-only prefs. */
function visibleServices() {
	if (!latest) return [];
	let v = latest.filter((s) => !prefs.hidden.has(s.id));
	if (prefs.problemsOnly) v = v.filter((s) => s.status !== "up");
	return v;
}

/** Filter the latest snapshot through prefs, then render (or show an empty state). */
function renderView() {
	if (!latest) return;
	const v = visibleServices();
	if (v.length === 0) {
		const anyVisible = latest.some((s) => !prefs.hidden.has(s.id));
		const msg =
			prefs.problemsOnly && anyVisible
				? "✓ All selected services are operational"
				: "No services selected — open Customize to add some.";
		gridEl.innerHTML = `<p class="grid__empty">${escapeHtml(msg)}</p>`;
		return;
	}
	render(v);
}

async function poll() {
	try {
		const res = await fetch("/api/status", { headers: { accept: "application/json" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		latest = data.services;
		renderView();
		updateTimestamp(data.updatedAt);
		detectChanges(latest);
	} catch (err) {
		if (!latest) {
			gridEl.innerHTML = `<p class="grid__error">Couldn't load status (${escapeHtml(String(err.message ?? err))}). Retrying…</p>`;
		}
		// On transient errors after a successful load, keep the last view visible.
	}
}

function updateTimestamp(iso) {
	const when = iso ? new Date(iso) : new Date();
	updatedEl.textContent = `Updated ${when.toLocaleTimeString()}`;
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

// Delegated hover handling on the grid (tiles are recreated every poll).
gridEl.addEventListener("mousemove", (e) => {
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
		const res = await fetch("/api/incidents?limit=40", { headers: { accept: "application/json" } });
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

function toggleCustomize(open) {
	const show = open ?? customizePanel.hidden;
	if (show) closePanels({ except: "customize" });
	customizePanel.hidden = !show;
	customizeBtn.setAttribute("aria-expanded", String(show));
	if (show) renderCustomize();
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

	const shown = latest.filter((s) => !prefs.hidden.has(s.id)).length;
	document.getElementById("customizeCount").textContent = `${shown} of ${latest.length} shown`;

	let html = "";
	for (const [category, items] of byCategory) {
		const allShown = items.every((s) => !prefs.hidden.has(s.id));
		html += `<div class="cz-group">
			<label class="cz-row cz-row--head">
				<input type="checkbox" data-category="${escapeHtml(category)}" ${allShown ? "checked" : ""} />
				<span>${escapeHtml(category)}</span>
			</label>`;
		for (const svc of items) {
			html += `<label class="cz-row">
				<input type="checkbox" data-id="${escapeHtml(svc.id)}" ${prefs.hidden.has(svc.id) ? "" : "checked"} />
				<span class="dot is-${svc.status}"></span>
				<span>${escapeHtml(svc.name)}</span>
			</label>`;
		}
		html += `</div>`;
	}
	customizeList.innerHTML = html;
}

// Delegated change handler for the customize checkboxes.
customizeList.addEventListener("change", (e) => {
	const cb = e.target;
	if (!(cb instanceof HTMLInputElement)) return;
	if (cb.dataset.id) {
		if (cb.checked) prefs.hidden.delete(cb.dataset.id);
		else prefs.hidden.add(cb.dataset.id);
	} else if (cb.dataset.category) {
		for (const svc of latest.filter((s) => s.category === cb.dataset.category)) {
			if (cb.checked) prefs.hidden.delete(svc.id);
			else prefs.hidden.add(svc.id);
		}
	}
	savePrefs();
	renderView();
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
}
// Avoid recursion: close incidents without re-triggering closePanels.
function toggleIncidentsClosed() {
	incidentsPanel.hidden = true;
	incidentsBtn.setAttribute("aria-expanded", "false");
}

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
	highlightTimer = setTimeout(() => {
		highlightId = null;
		renderView();
	}, 2600);
}

// Global keyboard shortcuts.
document.addEventListener("keydown", (e) => {
	if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
		e.preventDefault();
		paletteEl.hidden ? openPalette() : closePalette();
		return;
	}
	if (e.key === "Escape") {
		if (!paletteEl.hidden) closePalette();
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

syncProblemsBtn();
poll();
setInterval(poll, POLL_INTERVAL_MS);
