/**
 * Community report widget + Protomaps world map — ES module, same-origin only.
 *
 * Two responsibilities:
 *   1. `initMap()` — initialises the MapLibre GL / Protomaps world map in
 *      #sp-map and adds circle markers sized by community report count.
 *   2. `mount()` — mounts the vote-picker + compact breakdown widget into any
 *      [data-report-widget] element.
 *
 * Both read from GET /api/report/:id. To avoid a duplicate network request the
 * fetch is shared via a module-level Promise stored in `reportFetch`.
 */

import { layers, namedFlavor } from "/lib/protomaps-basemaps.esm.js";

const REASONS = [
  { code: "unreachable", label: "Can't connect",   color: "#f85149" },
  { code: "errors",      label: "Errors",          color: "#db61a2" },
  { code: "login",       label: "Can't log in",    color: "#a371f7" },
  { code: "slow",        label: "Slow",            color: "#d29922" },
  { code: "other",       label: "Something else",  color: "#58a6ff" },
];

const REASON_BY_CODE = Object.fromEntries(REASONS.map((r) => [r.code, r]));

// Country centroids [lon, lat] in degrees — used for circle marker positions.
const CC = {
  AF:[ 67.7, 33.9],AL:[ 20.2, 41.2],DZ:[  1.7, 28.0],AO:[ 17.9,-11.2],
  AR:[-63.6,-38.4],AM:[ 44.9, 40.1],AU:[133.8,-25.3],AT:[ 14.6, 47.2],
  AZ:[ 47.6, 40.1],BD:[ 90.4, 23.7],BE:[  4.5, 50.5],BY:[ 28.0, 53.5],
  BJ:[  2.3,  9.3],BO:[-64.7,-16.3],BA:[ 17.6, 44.2],BR:[-51.9,-14.2],
  BN:[114.7,  4.5],BG:[ 25.5, 42.7],BF:[ -1.6, 12.4],KH:[105.0, 12.6],
  CM:[ 12.4,  3.9],CA:[-96.8, 56.1],CF:[ 20.9,  6.6],TD:[ 18.7, 15.5],
  CL:[-71.5,-35.7],CN:[104.2, 35.9],CO:[-74.3,  4.1],CR:[-84.1,  9.7],
  HR:[ 15.2, 45.1],CU:[-79.5, 21.5],CY:[ 33.0, 35.1],CZ:[ 15.5, 49.8],
  DK:[  9.5, 56.3],DO:[-70.2, 18.7],EC:[-78.2, -1.8],EG:[ 30.8, 26.8],
  SV:[-88.9, 13.8],ER:[ 39.8, 15.2],EE:[ 25.0, 58.7],ET:[ 40.5,  9.1],
  FI:[ 26.3, 64.0],FR:[  2.2, 46.2],GA:[ 11.6, -0.8],GE:[ 43.4, 42.3],
  DE:[ 10.5, 51.2],GH:[ -1.0,  7.9],GR:[ 22.0, 39.1],GT:[-90.2, 15.8],
  GN:[-11.8, 10.9],HT:[-72.3, 18.9],HN:[-86.2, 14.8],HU:[ 19.5, 47.2],
  IS:[-18.8, 65.0],IN:[ 78.7, 20.6],ID:[113.9, -0.8],IR:[ 53.7, 32.4],
  IQ:[ 43.7, 33.2],IE:[ -8.1, 53.2],IL:[ 35.0, 31.5],IT:[ 12.6, 42.8],
  JM:[-77.3, 18.1],JP:[138.3, 36.6],JO:[ 36.1, 30.6],KZ:[ 67.9, 48.0],
  KE:[ 37.9,  0.0],KP:[127.5, 40.3],KR:[127.8, 36.2],KG:[ 74.8, 41.2],
  LA:[102.5, 17.4],LV:[ 25.0, 56.9],LB:[ 35.9, 33.9],LY:[ 17.2, 25.1],
  LT:[ 23.9, 55.3],LU:[  6.1, 49.8],MG:[ 46.9,-18.8],MW:[ 34.3,-13.2],
  MY:[109.7,  4.2],ML:[ -1.9, 17.6],MR:[-10.9, 20.3],MX:[-102.6, 24.0],
  MD:[ 29.0, 47.4],MN:[103.8, 46.9],ME:[ 19.4, 42.7],MA:[ -7.1, 31.8],
  MZ:[ 35.0,-18.7],MM:[ 96.7, 16.9],NA:[ 18.5,-22.0],NP:[ 84.1, 28.4],
  NL:[  5.3, 52.1],NZ:[172.5,-42.0],NI:[-85.1, 12.9],NE:[  8.1, 17.6],
  NG:[  8.1, 10.4],MK:[ 21.7, 41.6],NO:[  8.5, 60.5],OM:[ 56.8, 22.3],
  PK:[ 69.3, 30.4],PS:[ 35.2, 31.9],PA:[-80.1,  8.5],PG:[143.9, -6.3],
  PY:[-58.0,-23.4],PE:[-75.0, -9.2],PH:[121.8, 12.9],PL:[ 20.0, 52.0],
  PT:[ -8.2, 39.4],QA:[ 51.2, 25.4],RO:[ 25.0, 45.9],RU:[ 96.7, 61.5],
  RW:[ 29.9, -1.9],SA:[ 44.7, 24.0],SN:[-14.5, 14.5],RS:[ 21.1, 44.0],
  SL:[-11.8,  8.5],SG:[103.8,  1.4],SK:[ 19.7, 48.7],SI:[ 14.8, 46.1],
  SO:[ 46.2,  5.2],ZA:[ 25.1,-29.0],SS:[ 31.3,  7.9],ES:[ -3.7, 40.2],
  LK:[ 80.8,  7.7],SD:[ 30.2, 15.9],SR:[-56.0,  4.0],SE:[ 18.6, 62.2],
  CH:[  8.2, 46.8],SY:[ 38.3, 34.8],TW:[120.9, 23.7],TJ:[ 71.3, 38.9],
  TZ:[ 34.9, -6.4],TH:[101.0, 15.9],TG:[  0.8,  8.6],TT:[-61.2, 10.7],
  TN:[  9.5, 34.0],TR:[ 35.2, 39.1],TM:[ 59.6, 40.0],UG:[ 32.4,  1.4],
  UA:[ 31.2, 48.4],AE:[ 53.8, 24.0],GB:[ -3.4, 55.4],US:[-98.6, 38.0],
  UY:[-56.0,-32.5],UZ:[ 63.8, 41.4],VE:[-66.6,  8.0],VN:[108.3, 14.1],
  YE:[ 48.5, 15.6],ZM:[ 27.8,-13.1],ZW:[ 29.9,-19.0],
};

const CN_NAMES = {
  AF:"Afghanistan",AL:"Albania",DZ:"Algeria",AO:"Angola",AR:"Argentina",
  AM:"Armenia",AU:"Australia",AT:"Austria",AZ:"Azerbaijan",BD:"Bangladesh",
  BE:"Belgium",BY:"Belarus",BJ:"Benin",BO:"Bolivia",BA:"Bosnia",BR:"Brazil",
  BN:"Brunei",BG:"Bulgaria",BF:"Burkina Faso",KH:"Cambodia",CM:"Cameroon",
  CA:"Canada",CF:"C. African Rep.",TD:"Chad",CL:"Chile",CN:"China",
  CO:"Colombia",CR:"Costa Rica",HR:"Croatia",CU:"Cuba",CY:"Cyprus",
  CZ:"Czech Republic",DK:"Denmark",DO:"Dominican Rep.",EC:"Ecuador",EG:"Egypt",
  SV:"El Salvador",ER:"Eritrea",EE:"Estonia",ET:"Ethiopia",FI:"Finland",
  FR:"France",GA:"Gabon",GE:"Georgia",DE:"Germany",GH:"Ghana",GR:"Greece",
  GT:"Guatemala",GN:"Guinea",HT:"Haiti",HN:"Honduras",HU:"Hungary",
  IS:"Iceland",IN:"India",ID:"Indonesia",IR:"Iran",IQ:"Iraq",IE:"Ireland",
  IL:"Israel",IT:"Italy",JM:"Jamaica",JP:"Japan",JO:"Jordan",KZ:"Kazakhstan",
  KE:"Kenya",KP:"North Korea",KR:"South Korea",KG:"Kyrgyzstan",LA:"Laos",
  LV:"Latvia",LB:"Lebanon",LY:"Libya",LT:"Lithuania",LU:"Luxembourg",
  MG:"Madagascar",MW:"Malawi",MY:"Malaysia",ML:"Mali",MR:"Mauritania",
  MX:"Mexico",MD:"Moldova",MN:"Mongolia",ME:"Montenegro",MA:"Morocco",
  MZ:"Mozambique",MM:"Myanmar",NA:"Namibia",NP:"Nepal",NL:"Netherlands",
  NZ:"New Zealand",NI:"Nicaragua",NE:"Niger",NG:"Nigeria",MK:"N. Macedonia",
  NO:"Norway",OM:"Oman",PK:"Pakistan",PS:"Palestine",PA:"Panama",
  PG:"Papua New Guinea",PY:"Paraguay",PE:"Peru",PH:"Philippines",
  PL:"Poland",PT:"Portugal",QA:"Qatar",RO:"Romania",RU:"Russia",RW:"Rwanda",
  SA:"Saudi Arabia",SN:"Senegal",RS:"Serbia",SL:"Sierra Leone",
  SG:"Singapore",SK:"Slovakia",SI:"Slovenia",SO:"Somalia",ZA:"South Africa",
  SS:"South Sudan",ES:"Spain",LK:"Sri Lanka",SD:"Sudan",SR:"Suriname",
  SE:"Sweden",CH:"Switzerland",SY:"Syria",TW:"Taiwan",TJ:"Tajikistan",
  TZ:"Tanzania",TH:"Thailand",TG:"Togo",TT:"Trinidad & Tobago",TN:"Tunisia",
  TR:"Turkey",TM:"Turkmenistan",UG:"Uganda",UA:"Ukraine",AE:"UAE",
  GB:"United Kingdom",US:"United States",UY:"Uruguay",UZ:"Uzbekistan",
  VE:"Venezuela",VN:"Vietnam",YE:"Yemen",ZM:"Zambia",ZW:"Zimbabwe",
};

// ---- Shared fetch -----------------------------------------------------------

/**
 * Shared report data fetch — both initMap and mount use this so the API is
 * called only once per page load regardless of render order.
 */
const reportFetches = new Map(); // serviceId → Promise<Report|null>

function fetchReport(serviceId) {
  if (!reportFetches.has(serviceId)) {
    const p = fetch(`/api/report/${encodeURIComponent(serviceId)}`, {
      headers: { accept: "application/json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    reportFetches.set(serviceId, p);
  }
  return reportFetches.get(serviceId);
}

// ---- World map (MapLibre GL + Protomaps) ------------------------------------

function buildMapStyle(apiKey) {
  return {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sprite: "https://protomaps.github.io/basemaps-assets/sprites/v4/dark",
    sources: {
      protomaps: {
        type: "vector",
        tiles: [`https://api.protomaps.com/tiles/v4/{z}/{x}/{y}.mvt?key=${apiKey}`],
        maxzoom: 15,
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: layers("protomaps", namedFlavor("dark"), { lang: "en" }),
  };
}

/**
 * Build a GeoJSON FeatureCollection of country centroid points annotated with
 * report count so MapLibre can data-drive circle radius and colour.
 */
function buildGeoJSON(reportCountries) {
  const countByCode = new Map(
    (reportCountries || [])
      .filter((c) => c.country !== "Unknown" && CC[c.country])
      .map((c) => [c.country, c.count]),
  );
  let maxCount = 1;
  for (const v of countByCode.values()) if (v > maxCount) maxCount = v;

  return {
    type: "FeatureCollection",
    features: Object.entries(CC).map(([code, [lon, lat]]) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        code,
        name: CN_NAMES[code] || code,
        count: countByCode.get(code) || 0,
        // Pre-compute log-scaled intensity so the MapLibre expression stays simple.
        intensity: countByCode.has(code)
          ? Math.log1p(countByCode.get(code)) / Math.log1p(maxCount)
          : 0,
      },
    })),
  };
}

function addReportLayers(map, reportCountries) {
  const geojson = buildGeoJSON(reportCountries);

  if (map.getSource("reports")) {
    map.getSource("reports").setData(geojson);
    return;
  }

  map.addSource("reports", { type: "geojson", data: geojson });

  // Dim dots — all countries without reports (land presence indicator).
  map.addLayer({
    id: "report-bg",
    type: "circle",
    source: "reports",
    filter: ["==", ["get", "count"], 0],
    paint: {
      "circle-radius": 2.5,
      "circle-color": "rgba(139,148,158,0.28)",
      "circle-stroke-width": 0,
    },
  });

  // Glowing pulse ring — reporting countries only.
  map.addLayer({
    id: "report-pulse",
    type: "circle",
    source: "reports",
    filter: [">", ["get", "count"], 0],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "intensity"], 0, 10, 1, 28],
      "circle-color": ["interpolate", ["linear"], ["get", "intensity"],
        0, "hsla(25,90%,65%,0.18)",
        1, "hsla(10,90%,55%,0.18)",
      ],
      "circle-stroke-width": 0,
    },
  });

  // Solid core — reporting countries.
  map.addLayer({
    id: "report-dot",
    type: "circle",
    source: "reports",
    filter: [">", ["get", "count"], 0],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "intensity"], 0, 5, 1, 16],
      "circle-color": ["interpolate", ["linear"], ["get", "intensity"],
        0, "hsl(25,90%,62%)",
        1, "hsl(10,90%,50%)",
      ],
      "circle-opacity": 0.9,
    },
  });

  // Popup on hover over reporting dots.
  const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: "report-popup",
  });

  map.on("mouseenter", "report-dot", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const { name, count } = e.features[0].properties;
    popup
      .setLngLat(e.features[0].geometry.coordinates.slice())
      .setHTML(`<strong>${name}</strong><br>${count} report${count === 1 ? "" : "s"}`)
      .addTo(map);
  });

  map.on("mouseleave", "report-dot", () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
  });
}

async function initMap(el) {
  const apiKey = el.dataset.mapKey || "";
  const serviceId = el.dataset.serviceId || "";

  if (!apiKey) {
    el.innerHTML =
      `<div class="sp-map-placeholder">
        <p>Map unavailable.</p>
        <p class="sp-map-hint">Set <code>PROTOMAPS_KEY</code> in your Worker env to enable the world map.<br>
        Get a free key at <a href="https://app.protomaps.com" target="_blank" rel="noopener">app.protomaps.com</a>.</p>
      </div>`;
    return;
  }

  const map = new maplibregl.Map({
    container: el,
    style: buildMapStyle(apiKey),
    center: [10, 20],
    zoom: 1.4,
    minZoom: 0.5,
    maxZoom: 8,
    attributionControl: { compact: true },
  });

  // Store for updateMapWithReport() to reach.
  el._mlMap = map;

  // Fetch report data (shared with mount()).
  const report = await fetchReport(serviceId);
  const countries = report?.countries ?? [];

  if (map.loaded()) {
    addReportLayers(map, countries);
  } else {
    map.on("load", () => addReportLayers(map, countries));
  }
}

// ---- Helpers ----------------------------------------------------------------

/** ISO-3166 alpha-2 → flag emoji. */
function flagEmoji(code) {
  if (!code || code === "Unknown" || code.length !== 2) return "🌐";
  const offset = 0x1F1E6 - 65;
  return String.fromCodePoint(code.toUpperCase().charCodeAt(0) + offset) +
         String.fromCodePoint(code.toUpperCase().charCodeAt(1) + offset);
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Compact relative time, e.g. "just now", "4m", "3h", "2d". */
function relTime(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Build an SVG donut from the per-reason breakdown. */
function donutSvg(reasons, total) {
  const present = reasons.filter((r) => r.count > 0);
  let cumulative = 0;
  const segs = present.map((r) => {
    const pct = (r.count / total) * 100;
    const color = REASON_BY_CODE[r.reason]?.color ?? "#8b949e";
    // stroke-dashoffset 25 starts the arc at 12 o'clock; subtract cumulative to chain.
    const seg = `<circle class="report-donut__seg" cx="21" cy="21" r="15.91549431"
      fill="transparent" stroke="${color}" stroke-width="5.5"
      stroke-dasharray="${pct.toFixed(3)} ${(100 - pct).toFixed(3)}"
      stroke-dashoffset="${(25 - cumulative).toFixed(3)}"><title>${esc(REASON_BY_CODE[r.reason]?.label ?? r.reason)}: ${r.count}</title></circle>`;
    cumulative += pct;
    return seg;
  }).join("");

  return `<svg class="report-donut__svg" viewBox="0 0 42 42" role="img" aria-label="Report breakdown by reason">
    <circle class="report-donut__track" cx="21" cy="21" r="15.91549431" fill="transparent" stroke-width="5.5"></circle>
    ${segs}
    <text x="21" y="20.2" class="report-donut__num">${total}</text>
    <text x="21" y="25.6" class="report-donut__cap">report${total === 1 ? "" : "s"}</text>
  </svg>`;
}

function votedKey(serviceId) { return `isupmap_voted_${serviceId}`; }

function hasVoted(serviceId) {
  try {
    const raw = localStorage.getItem(votedKey(serviceId));
    if (!raw) return false;
    const { until } = JSON.parse(raw);
    return Date.now() < until;
  } catch { return false; }
}

function markVoted(serviceId, reason) {
  try {
    const until = Date.now() + 24 * 60 * 60 * 1000;
    localStorage.setItem(votedKey(serviceId), JSON.stringify({ reason, until }));
  } catch { /* unavailable */ }
}

function getVotedReason(serviceId) {
  try {
    const raw = localStorage.getItem(votedKey(serviceId));
    return raw ? JSON.parse(raw).reason : null;
  } catch { return null; }
}

/** Short date label for a day-bucket timestamp, e.g. "Jun 7". */
function dayLabel(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** 7-day report-volume bar chart from the daily timeline. */
function volumeChart(timeline) {
  const total7 = timeline.reduce((s, p) => s + p.count, 0);
  if (total7 === 0) {
    return `<p class="report-section__empty">No reports in the last 7 days.</p>`;
  }
  const max = Math.max(...timeline.map((p) => p.count), 1);
  const bars = timeline.map((p) => {
    const h = p.count === 0 ? 0 : Math.max(8, Math.round((p.count / max) * 100));
    const tip = `${p.count} report${p.count === 1 ? "" : "s"} · ${dayLabel(p.t)}`;
    // Full-height column is the hover/focus target so the whole bar slot is reachable.
    return `<span class="report-spark__col" data-tip="${esc(tip)}" tabindex="0" role="img" aria-label="${esc(tip)}">
      <span class="report-spark__bar${p.count ? "" : " is-empty"}" style="height:${h}%"></span>
    </span>`;
  }).join("");
  return `<div class="report-spark" role="group" aria-label="Report volume over the last 7 days">${bars}</div>
    <div class="report-spark__axis"><span>7d ago</span><span>today</span></div>`;
}

/** Top-5 countries by total reports, as labelled proportional bars. */
function topCountries(countries) {
  const list = countries.filter((c) => c.country && c.country !== "Unknown").slice(0, 5);
  if (!list.length) {
    return `<p class="report-section__empty">No country reports yet.</p>`;
  }
  const max = Math.max(...list.map((c) => c.count), 1);
  return `<ul class="report-topc">${list.map((c) => {
    const name = CN_NAMES[c.country] || c.country;
    const w = Math.max(6, Math.round((c.count / max) * 100));
    return `<li class="report-topc__row">
      <span class="report-topc__flag" aria-hidden="true">${flagEmoji(c.country)}</span>
      <span class="report-topc__name">${esc(name)}</span>
      <span class="report-topc__count">${c.count}</span>
      <span class="report-topc__track"><span class="report-topc__fill" style="width:${w}%"></span></span>
    </li>`;
  }).join("")}</ul>`;
}

// ---- Breakdown --------------------------------------------------------------

function renderBreakdown(container, report) {
  if (!report) {
    container.innerHTML = `<p class="report-widget__empty" aria-live="polite">Loading…</p>`;
    return;
  }

  const { total = 0, reasons = [], recent = [], timeline = [], countries = [] } = report;

  if (total === 0) {
    container.innerHTML = `<p class="report-widget__empty">No reports in the last 7 days.</p>`;
    return;
  }

  // Donut + legend, ordered by count desc.
  const ordered = [...reasons].filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
  const legendHtml = ordered.map((r) => {
    const meta = REASON_BY_CODE[r.reason];
    const pct = Math.round((r.count / total) * 100);
    return `<li class="report-legend__row">
      <span class="report-legend__swatch" style="background:${meta?.color ?? "#8b949e"}"></span>
      <span class="report-legend__label">${esc(meta?.label ?? r.reason)}</span>
      <span class="report-legend__val">${r.count} · ${pct}%</span>
    </li>`;
  }).join("");

  // Latest individual reports (max 10).
  const latestHtml = recent.slice(0, 10).map((r) => {
    const label = REASON_BY_CODE[r.reason]?.label ?? r.reason;
    const color = REASON_BY_CODE[r.reason]?.color ?? "#8b949e";
    const known = r.country && r.country !== "Unknown";
    const name = known ? (CN_NAMES[r.country] || r.country) : "Unknown";
    return `<li class="report-latest__row">
      <span class="report-latest__flag" aria-hidden="true">${flagEmoji(r.country)}</span>
      <span class="report-latest__country">${esc(name)}</span>
      <span class="report-latest__reason" style="color:${color}">${esc(label)}</span>
      <span class="report-latest__time">${esc(relTime(r.ts))}</span>
    </li>`;
  }).join("");

  container.innerHTML = `
    <div class="report-donut">
      ${donutSvg(reasons, total)}
      <ul class="report-legend">${legendHtml}</ul>
    </div>
    <p class="report-widget__total"><strong>${total}</strong> report${total === 1 ? "" : "s"} in the last 7 days</p>

    <hr class="report-rule" />
    <p class="report-section__head">Report volume <span class="report-section__sub">7d</span></p>
    ${volumeChart(timeline)}

    <hr class="report-rule" />
    <p class="report-section__head">Top countries <span class="report-section__sub">7d</span></p>
    ${topCountries(countries)}
    ${latestHtml ? `<hr class="report-rule" />
    <p class="report-latest__head">Latest reports</p>
    <ul class="report-latest">${latestHtml}</ul>` : ""}`;
}

// ---- Mount (vote widget) ----------------------------------------------------

async function mount(el, serviceId) {
  el.classList.add("report-widget");

  const alreadyVoted = hasVoted(serviceId);
  const votedReason  = getVotedReason(serviceId);

  const HELP = "Community-submitted reports from visitors over the last 7 days. A crowd signal, not an official status check.";
  const head = `<div class="report-widget__head">
      <span>Community Reports</span>
      <span class="report-widget__help" tabindex="0" role="img" aria-label="${esc(HELP)}" title="${esc(HELP)}">?</span>
    </div>`;

  if (alreadyVoted) {
    const reasonLabel = REASONS.find((r) => r.code === votedReason)?.label ?? votedReason ?? "it";
    el.innerHTML = `
      ${head}
      <p class="report-widget__thanks">Thanks — reported as "${esc(reasonLabel)}"</p>
      <div class="report-breakdown"></div>`;
  } else {
    el.innerHTML = `
      ${head}
      <p class="report-widget__prompt">Experiencing issues? Let others know.</p>
      <div class="report-reasons">${REASONS.map((r) => `
        <button class="report-reason-btn" data-reason="${esc(r.code)}" type="button">${esc(r.label)}</button>`).join("")}
      </div>
      <div class="report-breakdown"></div>`;

    el.querySelectorAll(".report-reason-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const reason = btn.dataset.reason;
        markVoted(serviceId, reason);
        const reasonLabel = REASONS.find((r) => r.code === reason)?.label ?? reason;

        el.querySelector(".report-reasons")?.remove();
        el.querySelector(".report-widget__prompt")?.remove();

        const thanks = document.createElement("p");
        thanks.className = "report-widget__thanks";
        thanks.textContent = `Thanks — reported as "${reasonLabel}"`;
        el.insertBefore(thanks, el.querySelector(".report-breakdown"));

        try {
          const res = await fetch(`/api/report/${encodeURIComponent(serviceId)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason }),
          });
          if (res.ok) {
            const { report } = await res.json();
            if (report && typeof report.total === "number") {
              // Optimistically fold this vote in so the donut + total stay consistent.
              report.total += 1;
              report.reasons = Array.isArray(report.reasons) ? [...report.reasons] : [];
              const existing = report.reasons.find((x) => x.reason === reason);
              if (existing) existing.count += 1;
              else report.reasons.push({ reason, count: 1 });
            }
            renderBreakdown(el.querySelector(".report-breakdown"), report);
            // Refresh map markers with updated data.
            updateMapWithReport(report);
          }
        } catch { /* optimistic collapse already shown */ }
      });
    });
  }

  const breakdownEl = el.querySelector(".report-breakdown");
  renderBreakdown(breakdownEl, null); // loading state

  const report = await fetchReport(serviceId);
  renderBreakdown(breakdownEl, report);
  if (report) updateMapWithReport(report);
}

/** Push fresh country data to the map if it has already loaded. */
function updateMapWithReport(report) {
  const mapEl = document.getElementById("sp-map");
  if (!mapEl?._mlMap) return;
  const map = mapEl._mlMap;
  if (map.loaded()) addReportLayers(map, report.countries ?? []);
}

// ---- Bootstrap --------------------------------------------------------------

// Hide a broken service logo. The inline onerror on the <img> is blocked by the
// page CSP (script-src 'self'), so handle the fallback here in this same-origin
// module — covering images that have already failed by the time this runs.
document.querySelectorAll(".sp-logo").forEach((img) => {
  const hide = () => { img.style.display = "none"; };
  if (img.complete && img.naturalWidth === 0) hide();
  else img.addEventListener("error", hide, { once: true });
});

// Initialise the world map first (doesn't block the widget).
const mapEl = document.getElementById("sp-map");
if (mapEl) initMap(mapEl);

// Auto-mount all declarative vote widgets.
document.querySelectorAll("[data-report-widget][data-service-id]").forEach((el) => {
  mount(el, el.dataset.serviceId);
});

window.isupReport = { mount };
