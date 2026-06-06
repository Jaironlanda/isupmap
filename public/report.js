/**
 * Community report widget — ES module, same-origin only (script-src 'self').
 *
 * Auto-mounts any [data-report-widget][data-service-id] element found on load
 * and exposes window.isupReport.mount(el, serviceId, opts) for the detail modal.
 */

const REASONS = [
  { code: "unreachable", label: "Can't connect" },
  { code: "errors",      label: "Errors" },
  { code: "login",       label: "Can't log in" },
  { code: "slow",        label: "Slow" },
  { code: "other",       label: "Something else" },
];

/** ISO-3166 alpha-2 → flag emoji (pairs of regional indicator symbols). */
function flagEmoji(code) {
  if (!code || code === "Unknown" || code.length !== 2) return "🌐";
  const offset = 0x1F1E6 - 65; // 'A'
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

/** LocalStorage key for the voted-flag so the dedup window persists across reloads. */
function votedKey(serviceId) {
  return `isupmap_voted_${serviceId}`;
}

function hasVoted(serviceId) {
  try {
    const raw = localStorage.getItem(votedKey(serviceId));
    if (!raw) return false;
    const { until } = JSON.parse(raw);
    return Date.now() < until;
  } catch {
    return false;
  }
}

function markVoted(serviceId, reason) {
  try {
    const until = Date.now() + 24 * 60 * 60 * 1000; // matches DEDUP_WINDOW_MS
    localStorage.setItem(votedKey(serviceId), JSON.stringify({ reason, until }));
  } catch {
    /* storage unavailable — still functional */
  }
}

function getVotedReason(serviceId) {
  try {
    const raw = localStorage.getItem(votedKey(serviceId));
    return raw ? JSON.parse(raw).reason : null;
  } catch {
    return null;
  }
}

function renderBreakdown(container, report) {
  if (!report || report.total === 0) {
    container.innerHTML = `<p class="report-widget__count">No reports yet.</p>`;
    return;
  }

  const countHtml = `<p class="report-widget__count"><strong>${report.total}</strong> report${report.total === 1 ? "" : "s"} in the last 7 days</p>`;

  const maxReason = Math.max(...(report.reasons ?? []).map((r) => r.count), 1);
  const barsHtml = (report.reasons ?? []).map((r) => {
    const label = REASONS.find((x) => x.code === r.reason)?.label ?? r.reason;
    const pct = Math.round((r.count / maxReason) * 100);
    return `<div class="report-bar">
      <span class="report-bar__label">${esc(label)}</span>
      <span class="report-bar__track"><span class="report-bar__fill" style="width:${pct}%"></span></span>
      <span class="report-bar__num">${r.count}</span>
    </div>`;
  }).join("");

  const countriesHtml = (report.countries ?? []).slice(0, 8).map((c) => {
    const flag = flagEmoji(c.country);
    return `<div class="report-country">
      <span class="report-country__flag" aria-hidden="true">${flag}</span>
      <span class="report-country__name">${esc(c.country)}</span>
      <span class="report-country__count">${c.count}</span>
    </div>`;
  }).join("");

  container.innerHTML = countHtml +
    (barsHtml ? `<div class="report-bars">${barsHtml}</div>` : "") +
    (countriesHtml ? `<div class="report-countries"><p class="report-countries__head">By country</p>${countriesHtml}</div>` : "");
}

async function mount(el, serviceId, _opts = {}) {
  el.classList.add("report-widget");

  const alreadyVoted = hasVoted(serviceId);
  const votedReason = getVotedReason(serviceId);

  if (alreadyVoted) {
    const reasonLabel = REASONS.find((r) => r.code === votedReason)?.label ?? votedReason ?? "it";
    el.innerHTML = `
      <p class="report-widget__head">Community reports</p>
      <p class="report-widget__thanks">Thanks — reported as "${esc(reasonLabel)}"</p>
      <div class="report-breakdown"></div>`;
  } else {
    el.innerHTML = `
      <p class="report-widget__head">Community reports</p>
      <p class="report-widget__prompt">Experiencing issues? Let others know.</p>
      <div class="report-reasons">${REASONS.map((r) => `
        <button class="report-reason-btn" data-reason="${esc(r.code)}" type="button">${esc(r.label)}</button>`).join("")}
      </div>
      <div class="report-breakdown"></div>`;

    el.querySelectorAll(".report-reason-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const reason = btn.dataset.reason;
        // Optimistically mark voted and collapse the picker.
        markVoted(serviceId, reason);
        const reasonLabel = REASONS.find((r) => r.code === reason)?.label ?? reason;

        const pickerEl = el.querySelector(".report-reasons");
        const promptEl = el.querySelector(".report-widget__prompt");
        if (pickerEl) pickerEl.remove();
        if (promptEl) promptEl.remove();

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
            // Optimistically bump the total so the count updates immediately.
            if (report && typeof report.total === "number") report.total += 1;
            renderBreakdown(el.querySelector(".report-breakdown"), report);
          }
        } catch {
          /* network error — the optimistic collapse is already shown */
        }
      });
    });
  }

  // Hydrate breakdown from GET regardless of voted state.
  const breakdownEl = el.querySelector(".report-breakdown");
  try {
    const res = await fetch(`/api/report/${encodeURIComponent(serviceId)}`, {
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      renderBreakdown(breakdownEl, await res.json());
    }
  } catch {
    /* non-critical — no breakdown shown */
  }
}

// Auto-mount declarative containers.
document.querySelectorAll("[data-report-widget][data-service-id]").forEach((el) => {
  mount(el, el.dataset.serviceId);
});

window.isupReport = { mount };
