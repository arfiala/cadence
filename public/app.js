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

  // The ATG daily mobility plan, in order. Slug drives the illustration
  // path (/img/stretch/<slug>.svg). Content is a fixed constant — no user
  // input — but every field is still routed through escapeHtml on render,
  // per the app-wide innerHTML rule.
  const STRETCH_PLAN = [
    { slug: "backward-walk", name: "Backward Walk (warm-up)", dose: "2-3 min easy", target: "Knees, ankles", cue: "Small smooth steps; toes push the floor behind you." },
    { slug: "split-squat", name: "ATG Split Squat", dose: "8 slow reps / side", target: "Knees, hip flexors, quads", cue: "Front knee travels over the toes as far as comfortable; back leg long; 3s down." },
    { slug: "couch-stretch", name: "Couch Stretch", dose: "60s / side", target: "Hip flexors, quads", cue: "Rear shin vertical against the wall, glute squeezed, torso tall. Do it right after split squats." },
    { slug: "elephant-walk", name: "Elephant Walk", dose: "20 alternating reps", target: "Hamstrings", cue: "Hands stay down; straighten one knee at a time." },
    { slug: "pancake", name: "Pancake Good Morning", dose: "15 slow reps + 30s hold", target: "Adductors, low back", cue: "Wide stance, hips back, flat back." },
    { slug: "butterfly", name: "Butterfly", dose: "2 min", target: "Groin, adductors", cue: "Soles together, knees heavy; add light weight on the knees when easy." },
    { slug: "pigeon", name: "Pigeon", dose: "60s / side", target: "Glutes, hips", cue: "Front shin across, chest tall; elevate the hip if it pinches." },
    { slug: "calf-stretch", name: "Calf Stretch (step)", dose: "60s / side", target: "Calves, ankles", cue: "Straight knee, heel drives down off a step or slant." },
  ];

  const STRETCH_LOG_TITLE = "ATG Daily Stretch";

  // One-tap quick-log presets (ISC-156, ISC-157). The stretch preset uses
  // sport=strength, which is NOT G1-qualifying, so a quick stretch never
  // inflates the week's session count (ISC-164).
  const PRESETS = {
    ride: { sport: "virtual_cycling", minutes: 30, title: "Trainer ride", notes: "Quick log" },
    swim: { sport: "swimming", minutes: 45, title: "Swim", notes: "Quick log" },
    stretch: { sport: "strength", minutes: 15, title: STRETCH_LOG_TITLE, notes: "Knees Over Toes daily plan" },
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
    if (name === "nutrition") loadNutrition();
    if (name === "trends") loadTrends();
    if (name === "races") loadRaces();
    if (name === "stretch") loadStretch();
    if (name === "sleep") loadSleep();
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
    loadRecords();
    loadWeight();
  }

  // --- Weight progress (from Zwift ride data) --------------------------

  // Renders a small progress line across the weight points; single-point or
  // flat series still draws a centered line so the widget never looks broken.
  function renderWeightSparkline(points) {
    const svg = document.getElementById("weight-svg");
    const width = 320;
    const height = 64;
    const pad = { x: 6, y: 8 };
    if (points.length === 0) {
      svg.innerHTML = "";
      return;
    }
    const weights = points.map((p) => p.weight_kg);
    const min = Math.min(...weights);
    const max = Math.max(...weights);
    const span = max - min || 1; // flat series -> centered line
    const n = points.length;
    const xAt = (i) => pad.x + (n === 1 ? (width - 2 * pad.x) / 2 : (i * (width - 2 * pad.x)) / (n - 1));
    const yAt = (w) => height - pad.y - ((w - min) / span) * (height - 2 * pad.y);
    const coords = points.map((p, i) => [xAt(i), yAt(p.weight_kg)]);
    const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const dots = coords.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="#3E6FC4"/>`).join("");
    const line = n > 1 ? `<path d="${path}" fill="none" stroke="#3E6FC4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : "";
    svg.innerHTML = `${line}${dots}`;
  }

  async function loadWeight() {
    let data;
    try {
      data = await api("/api/metrics/weight");
    } catch {
      return;
    }
    const section = document.getElementById("view-weight-card");
    const points = data.points || [];
    // Honest empty state: no Zwift weight data yet -> hide the whole widget.
    if (section) section.hidden = data.current == null;
    if (data.current == null) return;

    document.getElementById("weight-current").textContent = `${data.current} ${escapeHtml(data.unit || "kg")}`;

    const deltaEl = document.getElementById("weight-delta");
    if (data.delta == null || data.delta === 0 || points.length < 2) {
      deltaEl.textContent = points.length < 2 ? "First reading from Zwift" : "No change yet";
      deltaEl.className = "weight-delta flat";
    } else {
      const down = data.delta < 0;
      deltaEl.textContent = `${down ? "↓" : "↑"} ${Math.abs(data.delta)} kg since first ride`;
      deltaEl.className = `weight-delta ${down ? "down" : "up"}`;
    }
    renderWeightSparkline(points);
  }

  // --- Quick log presets + toast --------------------------------------

  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => quickLog(btn));
  });

  // A preset tap logs immediately, disables the button in-flight (ISC-158),
  // then shows a toast whose Undo deletes THIS activity by its returned id
  // (ISC-159) — never "most recent", so a fast second tap can't clobber it.
  async function quickLog(btn) {
    if (btn.disabled) return;
    const preset = PRESETS[btn.dataset.preset];
    if (!preset) return;
    btn.disabled = true;
    try {
      const res = await api("/api/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sport: preset.sport,
          start_time: new Date().toISOString(),
          duration_s: preset.minutes * 60,
          title: preset.title,
          notes: preset.notes,
        }),
      });
      const activity = res.activity;
      showToast(`Logged ${preset.title}.`, activity ? activity.id : null);
      loadDashboard(); // refresh week numbers + records without a full reload (ISC-160)
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  }

  function showToast(message, activityId) {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = "toast";
    const msg = document.createElement("span");
    msg.textContent = message;
    toast.appendChild(msg);

    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      toast.remove();
    };

    if (activityId != null) {
      const undo = document.createElement("button");
      undo.className = "toast-undo";
      undo.type = "button";
      undo.textContent = "Undo";
      undo.addEventListener("click", async () => {
        undo.disabled = true;
        try {
          // Delete the exact activity created for this toast (ISC-159).
          await api(`/api/activities/${activityId}`, { method: "DELETE" });
          loadDashboard();
        } catch (err) {
          alert(err.message);
        } finally {
          remove();
        }
      });
      toast.appendChild(undo);
    }

    container.appendChild(toast);
    setTimeout(remove, 6000);
  }

  // --- Personal records board ------------------------------------------

  function fmtDur(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  // Honest empty state: a null record renders "none yet", never a fabricated
  // number (ISC-174).
  function prItem(label, rec, valueFn, metaKey) {
    if (!rec) {
      return `<div class="pr-item"><div class="pr-label">${escapeHtml(label)}</div><div class="pr-value pr-empty">none yet</div></div>`;
    }
    const meta = metaKey && rec[metaKey] ? `<div class="pr-meta">${escapeHtml(String(rec[metaKey]))}</div>` : "";
    return `<div class="pr-item"><div class="pr-label">${escapeHtml(label)}</div><div class="pr-value">${escapeHtml(valueFn(rec))}</div>${meta}</div>`;
  }

  async function loadRecords() {
    let data;
    try {
      data = await api("/api/metrics/records");
    } catch {
      return;
    }
    const r = data.records;
    document.getElementById("pr-board").innerHTML = [
      prItem("Longest ride", r.longest_ride, (x) => fmtDur(x.value_s), "date"),
      prItem("Longest distance", r.longest_distance_ride, (x) => `${(x.distance_m / 1000).toFixed(1)} km`, "date"),
      prItem("Fastest ride", r.fastest_ride, (x) => `${x.speed_kmh.toFixed(1)} km/h`, "date"),
      prItem("Longest swim", r.longest_swim, (x) => fmtDur(x.value_s), "date"),
      prItem("Biggest week", r.biggest_week, (x) => `${x.hours.toFixed(1)} h`, "week_start"),
    ].join("");

    const s = data.streak;
    const ip = s.in_progress;
    document.getElementById("streak-row").innerHTML =
      `<div class="streak-item"><span class="streak-num">${escapeHtml(String(s.current_weeks))}</span> week current G1 streak</div>` +
      `<div class="streak-item"><span class="streak-num">${escapeHtml(String(s.longest_weeks))}</span> week best streak</div>` +
      `<div class="streak-item streak-progress">This week so far: ${escapeHtml(String(ip.sessions))}/${escapeHtml(String(ip.target_sessions))} sessions, ${escapeHtml(String(ip.hours_g1))} h${ip.met ? " (met, still in progress)" : ""}</div>`;
  }

  // --- Consistency heatmap ---------------------------------------------

  async function loadHeatmap() {
    let data;
    try {
      data = await api("/api/metrics/consistency");
    } catch {
      return;
    }
    renderHeatmap(data);
  }

  function renderHeatmap(data) {
    const svg = document.getElementById("heatmap-svg");
    const weeks = data.weeks || [];
    const cols = weeks.length;
    const cell = 12;
    const gap = 2;
    const pad = 4;
    const w = pad * 2 + cols * (cell + gap);
    const h = pad * 2 + 7 * (cell + gap);
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));

    let maxMin = 1;
    weeks.forEach((wk) => wk.days.forEach((d) => { if (d.minutes > maxMin) maxMin = d.minutes; }));

    let out = "";
    weeks.forEach((wk, ci) => {
      wk.days.forEach((d, ri) => {
        const x = pad + ci * (cell + gap);
        const y = pad + ri * (cell + gap);
        let fill;
        if (d.minutes <= 0) {
          fill = "rgba(38,34,27,0.08)"; // rest day, visibly distinct (ISC-167)
        } else {
          const t = Math.min(1, d.minutes / maxMin);
          fill = `rgba(31,138,112,${(0.28 + 0.72 * t).toFixed(2)})`;
        }
        out += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${fill}"><title>${escapeHtml(`${d.date}, ${d.minutes} min`)}</title></rect>`;
      });
      if (wk.g1_met) {
        const x = pad + ci * (cell + gap) - 1;
        const y = pad - 1;
        const bw = cell + 2;
        const bh = 7 * (cell + gap) - gap + 2;
        out += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="3" fill="none" stroke="#E85F41" stroke-width="1.5"></rect>`;
      }
    });
    svg.innerHTML = out;
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

  // --- Nutrition -------------------------------------------------------
  //
  // Describe a meal -> POST /api/nutrition/estimate -> editable itemized rows
  // -> Save. If the user edited the numbers the entry saves as source='manual'
  // (a corrected estimate); an untouched estimate saves as source='estimated'.
  // "Add manually" opens the same editor with one blank row. If the estimate
  // endpoint reports unavailable (no API key on the box during dev), a friendly
  // note tells the user to add macros manually, and the editor opens blank so
  // they still can.

  const nutriState = { rows: [], edited: false, estimated: false };

  function numOrZero(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function blankRow() {
    return { food: "", quantity: "", kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  }

  function renderNutriEditor() {
    const wrap = document.getElementById("nutri-items");
    wrap.innerHTML = nutriState.rows
      .map(
        (r, i) => `
      <div class="nutri-item-row" data-i="${i}">
        <input class="nutri-in nutri-col-food" data-i="${i}" data-k="food" type="text" value="${escapeHtml(r.food)}" placeholder="Food">
        <input class="nutri-in nutri-col-qty" data-i="${i}" data-k="quantity" type="text" value="${escapeHtml(r.quantity == null ? "" : r.quantity)}" placeholder="Qty">
        <input class="nutri-in nutri-col-num" data-i="${i}" data-k="kcal" type="number" min="0" step="1" value="${escapeHtml(String(r.kcal))}">
        <input class="nutri-in nutri-col-num" data-i="${i}" data-k="protein_g" type="number" min="0" step="0.1" value="${escapeHtml(String(r.protein_g))}">
        <input class="nutri-in nutri-col-num" data-i="${i}" data-k="carbs_g" type="number" min="0" step="0.1" value="${escapeHtml(String(r.carbs_g))}">
        <input class="nutri-in nutri-col-num" data-i="${i}" data-k="fat_g" type="number" min="0" step="0.1" value="${escapeHtml(String(r.fat_g))}">
        <button type="button" class="icon-btn nutri-col-x" data-action="nutri-remove" data-i="${i}">&times;</button>
      </div>`,
      )
      .join("");

    wrap.querySelectorAll(".nutri-in").forEach((input) => {
      input.addEventListener("input", () => {
        const i = Number(input.dataset.i);
        const k = input.dataset.k;
        if (!nutriState.rows[i]) return;
        nutriState.rows[i][k] = k === "food" || k === "quantity" ? input.value : numOrZero(input.value);
        // Any manual keystroke means the saved entry is a human-authored/edited
        // one, not a pristine estimate.
        nutriState.edited = true;
      });
    });
    wrap.querySelectorAll('[data-action="nutri-remove"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.dataset.i);
        nutriState.rows.splice(i, 1);
        nutriState.edited = true;
        if (nutriState.rows.length === 0) nutriState.rows.push(blankRow());
        renderNutriEditor();
      });
    });
    document.getElementById("nutri-editor").hidden = false;
  }

  function openNutriEditor(rows, estimated) {
    nutriState.rows = rows.length > 0 ? rows : [blankRow()];
    nutriState.estimated = estimated;
    nutriState.edited = false;
    document.getElementById("nutri-save-status").textContent = "";
    renderNutriEditor();
  }

  document.getElementById("nutri-estimate-btn").addEventListener("click", async () => {
    const btn = document.getElementById("nutri-estimate-btn");
    const statusEl = document.getElementById("nutri-estimate-status");
    const description = document.getElementById("nutri-desc").value.trim();
    if (!description) {
      statusEl.textContent = "Describe what you ate first.";
      return;
    }
    btn.disabled = true;
    statusEl.textContent = "Estimating...";
    try {
      const res = await api("/api/nutrition/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description }),
      });
      if (res.unavailable) {
        statusEl.textContent =
          "Auto-estimate needs the API key set on the server. Add macros manually below.";
        openNutriEditor([], false);
      } else {
        statusEl.textContent = "";
        openNutriEditor(res.items || [], true);
      }
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("nutri-manual-btn").addEventListener("click", () => {
    document.getElementById("nutri-estimate-status").textContent = "";
    openNutriEditor([], false);
  });

  document.getElementById("nutri-add-row-btn").addEventListener("click", () => {
    nutriState.rows.push(blankRow());
    nutriState.edited = true;
    renderNutriEditor();
  });

  let nutriSaveInFlight = false; // double-submit guard, same pattern as add-activity
  document.getElementById("nutri-save-btn").addEventListener("click", async () => {
    if (nutriSaveInFlight) return;
    const btn = document.getElementById("nutri-save-btn");
    const statusEl = document.getElementById("nutri-save-status");
    const rows = nutriState.rows
      .map((r) => ({
        food: (r.food || "").trim(),
        quantity: (r.quantity || "").trim(),
        kcal: numOrZero(r.kcal),
        protein_g: numOrZero(r.protein_g),
        carbs_g: numOrZero(r.carbs_g),
        fat_g: numOrZero(r.fat_g),
      }))
      .filter((r) => r.food.length > 0);
    if (rows.length === 0) {
      statusEl.textContent = "Add at least one food item.";
      return;
    }
    nutriSaveInFlight = true;
    btn.disabled = true;
    try {
      const description = document.getElementById("nutri-desc").value.trim();
      // A pristine, untouched estimate re-runs the server estimate so the entry
      // is stored as source='estimated'. Anything the user typed or corrected
      // saves the explicit rows as source='manual'.
      const payload =
        nutriState.estimated && !nutriState.edited
          ? { description: description || null, estimate: true }
          : { description: description || null, items: rows, source: "manual" };
      await api("/api/nutrition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      document.getElementById("nutri-desc").value = "";
      document.getElementById("nutri-editor").hidden = true;
      document.getElementById("nutri-estimate-status").textContent = "";
      nutriState.rows = [];
      await loadNutritionDay();
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      nutriSaveInFlight = false;
      btn.disabled = false;
    }
  });

  function renderNutriRing(consumed, target) {
    const svg = document.getElementById("nutri-ring");
    const cx = 60;
    const cy = 60;
    const rad = 48;
    const circ = 2 * Math.PI * rad;
    const pct = target > 0 ? Math.min(1, consumed / target) : 0;
    const over = target > 0 && consumed > target;
    const dash = circ * pct;
    const color = over ? "#E85F41" : "#1F8A70";
    svg.innerHTML =
      `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="rgba(38,34,27,0.10)" stroke-width="10"></circle>` +
      `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${(circ - dash).toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"></circle>` +
      `<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="20" font-weight="700" fill="#26221B">${escapeHtml(String(Math.round(consumed)))}</text>` +
      `<text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="10" fill="#6E6657">of ${escapeHtml(String(Math.round(target)))} kcal</text>`;
  }

  async function loadNutritionDay() {
    let data;
    try {
      data = await api("/api/nutrition");
    } catch {
      return;
    }
    const totals = data.totals || { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    renderNutriRing(totals.kcal, data.target_kcal || 0);

    document.getElementById("nutri-macros").innerHTML = [
      ["Protein", `${totals.protein_g} g`, `of ${data.target_protein_g} g`],
      ["Carbs", `${totals.carbs_g} g`, ""],
      ["Fat", `${totals.fat_g} g`, ""],
    ]
      .map(
        (m) =>
          `<div class="load-metric"><div class="load-metric-label">${escapeHtml(m[0])}</div><div class="load-metric-value">${escapeHtml(m[1])}</div><div class="stat-target">${escapeHtml(m[2])}</div></div>`,
      )
      .join("");

    const entries = data.entries || [];
    document.getElementById("nutri-empty").hidden = entries.length > 0;
    const list = document.getElementById("nutri-entries");
    list.innerHTML = entries
      .map((e) => {
        const title = e.description ? escapeHtml(e.description) : "Meal";
        const badge = e.source === "estimated" ? '<span class="badge">estimated</span>' : "";
        const itemLine = (e.items || [])
          .map((it) => escapeHtml(it.quantity ? `${it.food} (${it.quantity})` : it.food))
          .join(", ");
        return `
        <li class="activity-item" data-id="${e.id}">
          <div class="activity-icon">\u{1F37D}</div>
          <div class="activity-main">
            <div class="activity-title">${title}</div>
            <div class="activity-meta">${escapeHtml(String(e.kcal))} kcal &middot; P ${escapeHtml(String(e.protein_g))} / C ${escapeHtml(String(e.carbs_g))} / F ${escapeHtml(String(e.fat_g))}${itemLine ? ` &middot; ${itemLine}` : ""}</div>
          </div>
          ${badge}
          <div class="activity-actions">
            <button class="icon-btn" data-action="nutri-delete" data-id="${e.id}">Delete</button>
          </div>
        </li>`;
      })
      .join("");

    list.querySelectorAll('[data-action="nutri-delete"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!window.confirm("Delete this entry?")) return;
        btn.disabled = true;
        try {
          await api(`/api/nutrition/${btn.dataset.id}`, { method: "DELETE" });
          loadNutritionDay();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });
  }

  async function loadNutrition() {
    document.getElementById("nutri-editor").hidden = true;
    document.getElementById("nutri-estimate-status").textContent = "";
    await loadNutritionDay();
  }

  // --- Trends ------------------------------------------------------

  async function loadTrends() {
    let data;
    try {
      data = await api("/api/trends?weeks=8");
    } catch {
      return;
    }
    renderTrendChart(data.weeks);
    loadHeatmap();
    loadTrainingLoad();
  }

  // --- Training load (fitness / fatigue / form) ------------------------

  async function loadTrainingLoad() {
    let data;
    try {
      data = await api("/api/metrics/training-load");
    } catch {
      return;
    }
    // Populate the threshold form with current values.
    document.getElementById("ftp-input").value = data.ftp_watts != null ? data.ftp_watts : "";
    document.getElementById("lthr-input").value = data.lthr_bpm != null ? data.lthr_bpm : "";
    document.getElementById("load-prompt").hidden = data.thresholds_set;

    const c = data.current || { fitness: 0, fatigue: 0, form: 0 };
    document.getElementById("load-current").innerHTML = [
      ["Fitness", c.fitness],
      ["Fatigue", c.fatigue],
      ["Form", c.form],
      ["This week", data.week_load],
    ]
      .map(
        (m) =>
          `<div class="load-metric"><div class="load-metric-label">${m[0]}</div><div class="load-metric-value">${escapeHtml(String(m[1]))}</div></div>`,
      )
      .join("");

    renderLoadChart(data.series || []);
  }

  function renderLoadChart(series) {
    const svg = document.getElementById("load-svg");
    const empty = document.getElementById("load-empty");
    if (!series.length) {
      svg.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const width = 640;
    const height = 220;
    const padding = { top: 12, right: 10, bottom: 24, left: 10 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;
    const n = series.length;

    const maxVal = Math.max(
      1,
      ...series.map((p) => p.load),
      ...series.map((p) => p.fitness),
      ...series.map((p) => p.fatigue),
    );
    const x = (i) => (n === 1 ? padding.left + chartW / 2 : padding.left + (i / (n - 1)) * chartW);
    const y = (v) => padding.top + chartH - (Math.max(0, v) / maxVal) * chartH;

    // Faint daily-load bars behind the lines.
    const barW = Math.max(1, (chartW / n) * 0.5);
    let bars = "";
    series.forEach((p, i) => {
      const h = (p.load / maxVal) * chartH;
      bars += `<rect x="${(x(i) - barW / 2).toFixed(1)}" y="${(padding.top + chartH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="rgba(38,34,27,0.18)" rx="1"></rect>`;
    });

    const line = (key, color) => {
      const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
      return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>`;
    };

    svg.innerHTML =
      bars +
      line("fitness", "#3E6FC4") +
      line("fatigue", "#E85F41") +
      line("form", "#EFA928");
  }

  document.getElementById("threshold-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById("threshold-submit");
    const statusEl = document.getElementById("threshold-status");
    submitBtn.disabled = true;
    statusEl.textContent = "";
    try {
      const ftpVal = document.getElementById("ftp-input").value;
      const lthrVal = document.getElementById("lthr-input").value;
      const body = {
        ftp_watts: ftpVal ? Number(ftpVal) : null,
        lthr_bpm: lthrVal ? Number(lthrVal) : null,
      };
      await api("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      statusEl.textContent = "Saved.";
      loadTrainingLoad();
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
    }
  });

  // --- Races (ZwiftPower) ---------------------------------------------

  async function loadRaces() {
    let data;
    try {
      data = await api("/api/zwiftpower/results");
    } catch {
      return;
    }
    document.getElementById("races-not-configured").hidden = data.configured;
    document.getElementById("races-configured").hidden = !data.configured;

    const results = data.results || [];
    document.getElementById("races-empty").hidden = !(data.configured && results.length === 0);

    const list = document.getElementById("races-list");
    list.innerHTML = results
      .map((r) => {
        const title = r.title ? escapeHtml(r.title) : "Race";
        const date = r.event_date ? formatDate(r.event_date) : "Date unknown";
        const cat = r.category ? `Cat ${escapeHtml(r.category)}` : "";
        const pos = r.position != null ? `P${escapeHtml(String(r.position))}` : "";
        const meta = [date, cat, pos].filter((s) => s).join(" · ");
        return `
        <li class="activity-item">
          <div class="activity-icon">\u{1F3C1}</div>
          <div class="activity-main">
            <div class="activity-title">${title}</div>
            <div class="activity-meta">${meta}</div>
          </div>
          ${r.category ? `<span class="badge">${escapeHtml(r.category)}</span>` : ""}
        </li>`;
      })
      .join("");

    if (data.configured) loadZpStatus();
  }

  async function loadZpStatus() {
    let data;
    try {
      data = await api("/api/zwiftpower/status");
    } catch {
      return;
    }
    const runs = data.runs || [];
    const statusEl = document.getElementById("zp-status");
    if (runs.length === 0) {
      statusEl.textContent = "No syncs yet.";
    } else {
      const last = runs[0];
      statusEl.textContent = `Last sync: ${last.status} at ${new Date(last.started_at).toLocaleString()} (${last.results_new} new / ${last.results_seen} seen)`;
    }
  }

  let zpSyncInFlight = false;
  document.getElementById("zp-sync-btn").addEventListener("click", async () => {
    if (zpSyncInFlight) return;
    const btn = document.getElementById("zp-sync-btn");
    zpSyncInFlight = true;
    btn.disabled = true;
    btn.textContent = "Syncing...";
    try {
      await api("/api/zwiftpower/sync", { method: "POST" });
      await loadRaces();
    } catch (err) {
      alert(err.message);
    } finally {
      zpSyncInFlight = false;
      btn.disabled = false;
      btn.textContent = "Sync ZwiftPower";
    }
  });

  // --- Sleep -------------------------------------------------------------

  // Seconds -> "7h 05m" (minutes zero-padded). Null/0 -> "--".
  function fmtSleep(seconds) {
    if (seconds == null || seconds <= 0) return "--";
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }

  // ISO instant -> "10:48 PM" local. Null -> "".
  function fmtClock(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  // "2026-07-19" -> "Sun, Jul 19". Parsed as a local calendar day (append
  // T00:00 so it is not shifted a day by UTC interpretation).
  function fmtNightDate(ymd) {
    if (!ymd) return "";
    const d = new Date(`${ymd}T00:00:00`);
    if (Number.isNaN(d.getTime())) return escapeHtml(ymd);
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  const SLEEP_STAGES = [
    { key: "deep_s", label: "Deep", color: "#3E6FC4" },
    { key: "light_s", label: "Light", color: "#5B8DEF" },
    { key: "rem_s", label: "REM", color: "#9B6FE0" },
    { key: "awake_s", label: "Awake", color: "rgba(38,34,27,0.22)" },
  ];

  // Horizontal stacked stage bar for one night. Renders only the stages that
  // have data; a night with no stage breakdown renders nothing (honest).
  function stageBar(night) {
    const total = SLEEP_STAGES.reduce((sum, s) => sum + (night[s.key] || 0), 0);
    if (total <= 0) return "";
    const segs = SLEEP_STAGES.filter((s) => (night[s.key] || 0) > 0)
      .map((s) => `<span class="sleep-seg" style="flex:${night[s.key]};background:${s.color}" title="${s.label} ${fmtSleep(night[s.key])}"></span>`)
      .join("");
    return `<div class="sleep-bar">${segs}</div>`;
  }

  function renderSleepLast(night) {
    const el = document.getElementById("sleep-last");
    if (!night) {
      el.innerHTML = `<p class="muted">No sleep recorded yet.</p>`;
      return;
    }
    const window = night.start_time && night.end_time
      ? `${fmtClock(night.start_time)} &rarr; ${fmtClock(night.end_time)}`
      : "";
    const score = night.score != null
      ? `<span class="sleep-score">Score ${escapeHtml(String(night.score))}</span>`
      : "";
    const stages = SLEEP_STAGES.filter((s) => night[s.key] != null)
      .map((s) => `<div class="sleep-stat"><span class="sleep-stat-label" style="color:${s.color}">${s.label}</span><span class="sleep-stat-val">${fmtSleep(night[s.key])}</span></div>`)
      .join("");
    el.innerHTML = `
      <div class="sleep-last-head">
        <div class="sleep-total">${fmtSleep(night.total_sleep_s)}</div>
        <div class="sleep-last-meta">
          <div class="sleep-date">${escapeHtml(fmtNightDate(night.date))}</div>
          ${window ? `<div class="muted">${window}</div>` : ""}
          ${score}
        </div>
      </div>
      ${stageBar(night)}
      <div class="sleep-stats">${stages}</div>`;
  }

  // Stacked-minutes trend across the recent nights (oldest -> newest).
  function renderSleepTrend(nights) {
    const svg = document.getElementById("sleep-trend");
    const width = 640;
    const height = 200;
    const pad = { top: 10, right: 10, bottom: 26, left: 10 };
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;
    const series = nights.slice(0, 7).reverse();
    if (series.length === 0) {
      svg.innerHTML = "";
      return;
    }
    const maxTotal = Math.max(
      1,
      ...series.map((n) => SLEEP_STAGES.reduce((s, st) => s + (n[st.key] || 0), 0)),
    );
    const groupW = chartW / series.length;
    const barW = Math.min(48, groupW * 0.5);
    let out = "";
    series.forEach((n, i) => {
      const cx = pad.left + groupW * i + groupW / 2;
      const x = cx - barW / 2;
      let yTop = pad.top + chartH;
      SLEEP_STAGES.forEach((st) => {
        const secs = n[st.key] || 0;
        if (secs <= 0) return;
        const h = (secs / maxTotal) * chartH;
        yTop -= h;
        out += `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${st.color}" rx="1"><title>${st.label} ${fmtSleep(secs)}</title></rect>`;
      });
      const label = new Date(`${n.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" });
      out += `<text x="${cx.toFixed(1)}" y="${(height - 8).toFixed(1)}" text-anchor="middle" font-size="11" fill="rgba(38,34,27,0.6)">${escapeHtml(label)}</text>`;
    });
    svg.innerHTML = out;
  }

  function renderSleepList(nights) {
    const list = document.getElementById("sleep-list");
    list.innerHTML = nights
      .map((n) => {
        const window = n.start_time && n.end_time ? `${fmtClock(n.start_time)} &rarr; ${fmtClock(n.end_time)}` : "";
        const score = n.score != null ? `Score ${escapeHtml(String(n.score))}` : "";
        const meta = [escapeHtml(fmtNightDate(n.date)), window, score].filter((s) => s).join(" &middot; ");
        return `
        <li class="activity-item">
          <div class="activity-icon">\u{1F634}</div>
          <div class="activity-main">
            <div class="activity-title">${fmtSleep(n.total_sleep_s)}</div>
            <div class="activity-meta">${meta}</div>
            ${stageBar(n)}
          </div>
        </li>`;
      })
      .join("");
  }

  async function loadSleep() {
    let data;
    try {
      data = await api("/api/sleep");
    } catch {
      return;
    }
    const nights = data.nights || [];
    document.getElementById("sleep-empty").hidden = nights.length > 0;
    renderSleepLast(nights[0] || null);
    renderSleepTrend(nights);
    renderSleepList(nights);
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

      bars += `<rect x="${groupX + barGroupW * 0.15}" y="${padding.top + chartH - hoursH}" width="${barW}" height="${hoursH}" fill="#1F8A70" rx="2"></rect>`;
      bars += `<rect x="${groupX + barGroupW * 0.53}" y="${padding.top + chartH - sessionsH}" width="${barW}" height="${sessionsH}" fill="#26221B" rx="2"></rect>`;
      bars += `<text x="${groupX + barGroupW / 2}" y="${height - 8}" font-size="10" text-anchor="middle" fill="#6E6657">${escapeHtml(w.week_start.slice(5))}</text>`;
    });

    const targetHoursY = padding.top + chartH - (weeks[0].target_hours / maxHours) * chartH;
    const targetLine = `<line x1="${padding.left}" y1="${targetHoursY}" x2="${width - padding.right}" y2="${targetHoursY}" stroke="#E85F41" stroke-width="1" stroke-dasharray="4 3"></line>`;

    svg.innerHTML = targetLine + bars;
  }

  // --- Stretch ------------------------------------------------------

  // The America/New_York calendar day (YYYY-MM-DD) an instant falls on.
  // Mirrors the server's week.ts NY-day logic so the "done today" state is
  // computed against the same timezone the rest of the app anchors to.
  function nyDateKey(iso) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  }

  function renderStretchCards() {
    const list = document.getElementById("stretch-list");
    list.innerHTML = STRETCH_PLAN.map((s, i) => {
      const src = `/img/stretch/${encodeURIComponent(s.slug)}.svg`;
      return `
      <div class="stretch-card">
        <div class="stretch-num">${i + 1}</div>
        <img class="stretch-img" src="${src}" alt="${escapeHtml(s.name)} illustration">
        <div class="stretch-body">
          <div class="stretch-name">${escapeHtml(s.name)}</div>
          <div class="stretch-dose">${escapeHtml(s.dose)}</div>
          <div class="stretch-target"><span class="stretch-tag">Targets</span> ${escapeHtml(s.target)}</div>
          <div class="stretch-cue">${escapeHtml(s.cue)}</div>
        </div>
      </div>`;
    }).join("");
  }

  // Derives the "done today" state from the API (never local state) so it
  // survives a reload: look for a manual "ATG Daily Stretch" activity whose
  // NY calendar day is today.
  async function refreshStretchLogState() {
    const btn = document.getElementById("stretch-log-btn");
    const doneEl = document.getElementById("stretch-done");
    let data;
    try {
      data = await api("/api/activities?limit=50");
    } catch {
      return;
    }
    const todayKey = nyDateKey(new Date().toISOString());
    const loggedToday = data.activities.some(
      (a) => a.title === STRETCH_LOG_TITLE && nyDateKey(a.start_time) === todayKey,
    );
    btn.hidden = loggedToday;
    doneEl.hidden = !loggedToday;
  }

  async function loadStretch() {
    renderStretchCards();
    await refreshStretchLogState();
  }

  let stretchLogInFlight = false; // double-submit guard, same pattern as add-activity
  document.getElementById("stretch-log-btn").addEventListener("click", async () => {
    if (stretchLogInFlight) return;
    const btn = document.getElementById("stretch-log-btn");
    stretchLogInFlight = true;
    btn.disabled = true;
    try {
      await api("/api/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sport: "strength",
          start_time: new Date().toISOString(),
          duration_s: 15 * 60,
          title: STRETCH_LOG_TITLE,
          notes: "Knees Over Toes daily plan",
        }),
      });
      await refreshStretchLogState();
      loadDashboard();
    } catch (err) {
      alert(err.message);
    } finally {
      stretchLogInFlight = false;
      btn.disabled = false;
    }
  });

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

  // Register the no-op service worker purely for Chromium installability
  // (ISC-162). It caches nothing; failure to register is non-fatal.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

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
