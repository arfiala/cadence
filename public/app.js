// Cadence app shell — vanilla JS, zero dependencies, zero external requests.
// This file is the entire client-side "framework": it toggles between the
// login view and the app view based on whether the authenticated API call
// succeeds, renders the dashboard/activities/trends/sync views, and talks
// to the API using the browser's own session cookie (no token handling
// needed client-side — that's the MCP server's job).

(function () {
  "use strict";

  const SPORT_ICONS = {
    cycling: "\u{1F6B4}",
    virtual_cycling: "\u{1F3AE}",
    swimming: "\u{1F30A}",
    running: "\u{1F3C3}",
    strength: "\u{1F3CB}",
    other: "★",
  };
  const SPORT_LABELS = {
    cycling: "Cycling",
    virtual_cycling: "Virtual ride",
    swimming: "Swimming",
    running: "Running",
    strength: "Strength",
    other: "Other",
  };

  // Escapes user-controlled text before it is ever interpolated into
  // innerHTML (ISC-54). Every render function below routes activity
  // title/notes through this.
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function api(path, options) {
    const res = await fetch(path, Object.assign({ credentials: "same-origin" }, options));
    if (res.status === 401) {
      showLogin("Your session expired. Please log in again.");
      throw new Error("unauthenticated");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    return body;
  }

  // --- View toggling -----------------------------------------------------

  const loginView = document.getElementById("login-view");
  const appView = document.getElementById("app-view");

  function showLogin(message) {
    loginView.hidden = false;
    appView.hidden = true;
    if (message) document.getElementById("login-error").textContent = message;
  }

  function showApp() {
    loginView.hidden = true;
    appView.hidden = false;
  }

  function switchTab(name) {
    document.querySelectorAll(".nav-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === name);
    });
    document.querySelectorAll("main.wrap > section").forEach((section) => {
      section.hidden = section.id !== `view-${name}`;
    });
    if (name === "dashboard") loadDashboard();
    if (name === "activities") loadActivities();
    if (name === "trends") loadTrends();
    if (name === "sync") loadSyncStatus();
  }

  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.view));
  });

  // --- Login ---------------------------------------------------------

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById("login-submit");
    submitBtn.disabled = true; // double-submit guard
    document.getElementById("login-error").textContent = "";
    try {
      const email = document.getElementById("login-email").value;
      const password = document.getElementById("login-password").value;
      const res = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        document.getElementById("login-error").textContent = body.error || "Login failed.";
        return;
      }
      showApp();
      switchTab("dashboard");
    } catch {
      document.getElementById("login-error").textContent = "Login failed.";
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    showLogin("");
  });

  // --- Dashboard -------------------------------------------------------

  async function loadDashboard() {
    let week;
    try {
      week = await api("/api/week");
    } catch {
      return;
    }
    document.getElementById("stat-sessions").textContent = week.sessions;
    document.getElementById("stat-sessions-target").textContent = week.target_sessions;
    document.getElementById("stat-hours").textContent = week.hours_g1;
    document.getElementById("stat-hours-target").textContent = week.target_hours;
    document.getElementById("gap-line").textContent = week.gap_message;

    const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const dotsHtml = week.days
      .map((day, i) => {
        const cls = day.sessions > 0 ? "dot has-session" : "dot";
        return `<div class="day-dot"><div class="${cls}">${day.sessions > 0 ? day.sessions : ""}</div><div class="lbl">${dayLabels[i]}</div></div>`;
      })
      .join("");
    document.getElementById("day-dots").innerHTML = dotsHtml;
  }

  // --- Activities ------------------------------------------------------

  function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  async function loadActivities() {
    let data;
    try {
      data = await api("/api/activities?limit=50");
    } catch {
      return;
    }
    const list = document.getElementById("activity-list");
    list.innerHTML = data.activities
      .map((a) => {
        const icon = SPORT_ICONS[a.sport] || SPORT_ICONS.other;
        const label = SPORT_LABELS[a.sport] || a.sport;
        const sourceBadge = a.source === "garmin" ? "Garmin" : "Manual";
        const title = a.title ? escapeHtml(a.title) : label;
        return `
        <li class="activity-item" data-id="${a.id}" data-source="${a.source}">
          <div class="activity-icon">${icon}</div>
          <div class="activity-main">
            <div class="activity-title">${title}</div>
            <div class="activity-meta">${formatDate(a.start_time)} &middot; ${formatDuration(a.duration_s)}${a.notes ? ` &middot; ${escapeHtml(a.notes)}` : ""}</div>
          </div>
          <span class="badge">${sourceBadge}</span>
          <div class="activity-actions">
            <button class="icon-btn" data-action="delete" data-id="${a.id}" data-source="${a.source}">Delete</button>
          </div>
        </li>`;
      })
      .join("");

    list.querySelectorAll('[data-action="delete"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const source = btn.dataset.source;
        const confirmMsg =
          source === "garmin"
            ? "This activity came from Garmin and will reappear on the next sync unless Garmin also deletes it. Delete anyway?"
            : "Delete this activity?";
        if (!window.confirm(confirmMsg)) return;
        btn.disabled = true;
        try {
          const qs = source === "garmin" ? "?confirm=true" : "";
          await api(`/api/activities/${id}${qs}`, { method: "DELETE" });
          loadActivities();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });
  }

  let addInFlight = false; // double-submit guard (ISC-50)
  document.getElementById("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (addInFlight) return;
    const submitBtn = document.getElementById("add-submit");
    addInFlight = true;
    submitBtn.disabled = true;
    try {
      const sport = document.getElementById("add-sport").value;
      const dateVal = document.getElementById("add-date").value;
      const durationMin = Number(document.getElementById("add-duration").value);
      const distanceKm = document.getElementById("add-distance").value;
      const notes = document.getElementById("add-notes").value;

      if (!dateVal) throw new Error("Date is required");
      const startTime = new Date(dateVal).toISOString();

      await api("/api/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sport,
          start_time: startTime,
          duration_s: Math.round(durationMin * 60),
          distance_m: distanceKm ? Number(distanceKm) * 1000 : null,
          notes: notes || null,
        }),
      });
      document.getElementById("add-form").reset();
      loadActivities();
      loadDashboard();
    } catch (err) {
      alert(err.message);
    } finally {
      addInFlight = false;
      submitBtn.disabled = false;
    }
  });

  // --- Trends ------------------------------------------------------

  async function loadTrends() {
    let data;
    try {
      data = await api("/api/trends?weeks=8");
    } catch {
      return;
    }
    renderTrendChart(data.weeks);
  }

  function renderTrendChart(weeks) {
    const svg = document.getElementById("trend-svg");
    const width = 640;
    const height = 220;
    const padding = { top: 10, right: 10, bottom: 30, left: 10 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;
    const n = weeks.length;
    const barGroupW = chartW / n;
    const barW = barGroupW * 0.32;

    const maxHours = Math.max(8, ...weeks.map((w) => w.hours_g1), ...weeks.map((w) => w.target_hours));
    const maxSessions = Math.max(5, ...weeks.map((w) => w.sessions), ...weeks.map((w) => w.target_sessions));

    let bars = "";
    weeks.forEach((w, i) => {
      const groupX = padding.left + i * barGroupW;
      const hoursH = (w.hours_g1 / maxHours) * chartH;
      const sessionsH = (w.sessions / maxSessions) * chartH;

      bars += `<rect x="${groupX + barGroupW * 0.15}" y="${padding.top + chartH - hoursH}" width="${barW}" height="${hoursH}" fill="#2BB673" rx="2"></rect>`;
      bars += `<rect x="${groupX + barGroupW * 0.53}" y="${padding.top + chartH - sessionsH}" width="${barW}" height="${sessionsH}" fill="#0B3D2E" rx="2"></rect>`;
      bars += `<text x="${groupX + barGroupW / 2}" y="${height - 8}" font-size="10" text-anchor="middle" fill="#4a544f">${escapeHtml(w.week_start.slice(5))}</text>`;
    });

    const targetHoursY = padding.top + chartH - (weeks[0].target_hours / maxHours) * chartH;
    const targetLine = `<line x1="${padding.left}" y1="${targetHoursY}" x2="${width - padding.right}" y2="${targetHoursY}" stroke="#1E7A50" stroke-width="1" stroke-dasharray="4 3"></line>`;

    svg.innerHTML = targetLine + bars;
  }

  // --- Sync ------------------------------------------------------

  async function loadSyncStatus() {
    let data;
    try {
      data = await api("/api/sync/status");
    } catch {
      return;
    }
    const runs = data.runs || [];
    const statusEl = document.getElementById("sync-status");
    if (runs.length === 0) {
      statusEl.textContent = "No syncs yet.";
    } else {
      const last = runs[0];
      statusEl.textContent = `Last sync: ${last.status} at ${new Date(last.started_at).toLocaleString()} (${last.activities_new} new / ${last.activities_seen} seen)`;
    }
    document.getElementById("sync-history").innerHTML = runs
      .slice(0, 5)
      .map(
        (r) =>
          `<div class="muted">${escapeHtml(r.status)} &middot; ${escapeHtml(new Date(r.started_at).toLocaleString())}${r.error ? ` &middot; ${escapeHtml(r.error)}` : ""}</div>`,
      )
      .join("");
  }

  let syncInFlight = false; // double-submit guard, same pattern as add-activity
  document.getElementById("sync-now-btn").addEventListener("click", async () => {
    if (syncInFlight) return;
    const btn = document.getElementById("sync-now-btn");
    syncInFlight = true;
    btn.disabled = true;
    btn.textContent = "Syncing...";
    try {
      await api("/api/sync", { method: "POST" });
      await loadSyncStatus();
    } catch (err) {
      alert(err.message);
    } finally {
      syncInFlight = false;
      btn.disabled = false;
      btn.textContent = "Sync now";
    }
  });

  document.getElementById("csv-import-btn").addEventListener("click", async () => {
    const fileInput = document.getElementById("csv-file");
    const resultEl = document.getElementById("csv-result");
    if (!fileInput.files || fileInput.files.length === 0) {
      resultEl.textContent = "Choose a CSV file first.";
      return;
    }
    const form = new FormData();
    form.append("file", fileInput.files[0]);
    try {
      const res = await fetch("/api/import/csv", {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Import failed");
      resultEl.textContent = `Imported ${body.imported} of ${body.total_rows} rows (${body.skipped_count} skipped).`;
      loadActivities();
      loadDashboard();
    } catch (err) {
      resultEl.textContent = err.message;
    }
  });

  // --- Boot ------------------------------------------------------

  async function boot() {
    try {
      await api("/api/week");
      showApp();
      switchTab("dashboard");
    } catch {
      showLogin("");
    }
  }

  boot();
})();
