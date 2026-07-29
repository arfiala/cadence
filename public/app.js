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
    golf: "\u{26F3}",
  };
  const SPORT_LABELS = {
    golf: "Golf",
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
    // Upper body block, added 2026-07-29. Movements from Ben Patrick's ATG
    // upper-body work (hanging is the staple); hold doses follow the Huberman
    // Lab flexibility protocol: 30s static holds, 2 to 4 sets, low intensity
    // (30 to 40 percent of the point of discomfort), warm before stretching.
    { slug: "dead-hang", name: "Dead Hang", dose: "30s x 2, build to 60s", target: "Shoulders, lats, grip, spine", cue: "Full grip, arms straight, let the shoulders shrug up to the ears and breathe slow. Any sturdy overhead bar works; no bar, do the t-spine reach twice instead." },
    { slug: "doorway-pec", name: "Doorway Pec Stretch", dose: "30s / side x 2", target: "Chest, front shoulder", cue: "Forearm on the frame, elbow at shoulder height, step through gently. Stay near 30 to 40 percent intensity." },
    { slug: "t-spine-reach", name: "T-Spine Reach (bench)", dose: "45s x 2", target: "Upper back, lats, triceps", cue: "Elbows on a bench or chair, hands together overhead, let the chest sink toward the floor." },
    { slug: "cross-body-shoulder", name: "Cross-Body Shoulder Stretch", dose: "30s / side x 2", target: "Rear shoulder", cue: "Pull the arm across at chest height with the other forearm; keep the shoulder pulled down away from the ear." },
    { slug: "wrist-stretch", name: "Wrist Stretch (floor)", dose: "30s each direction", target: "Wrists, forearms", cue: "Palms flat on the floor, fingers forward then fingers back toward you, lean gently. Preps pressing and hanging." },
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

  // Hand-authored swim sets (ISC-361..365). Static reference content, no
  // adaptive logic: six workouts across 30/45/60 minutes, each built on the
  // four-phase structure (warmup, drill block, main set, cooldown). Strokes and
  // drills vary sensibly for an intermediate fitness swimmer. Distances in
  // metres; the stated total equals the sum of its phases. Zero dashes in copy.
  // Sources cited in the HTML comment above the swim list in index.html.
  const SWIM_SETS = [
    {
      name: "Steady Aerobic Base",
      minutes: 30,
      distance_m: 1500,
      intensity: "Easy",
      warmup: "400 m easy freestyle, breathe every three strokes",
      drills: "4 x 50 m catch up drill, 15 seconds rest",
      main: "8 x 100 m freestyle at a steady pace, 20 seconds rest",
      cooldown: "100 m relaxed backstroke",
    },
    {
      name: "Mixed Stroke Cruise",
      minutes: 30,
      distance_m: 1700,
      intensity: "Moderate",
      warmup: "400 m as 200 freestyle then 200 backstroke",
      drills: "6 x 50 m fingertip drag drill, 15 seconds rest",
      main: "6 x 100 m as 75 freestyle plus 25 backstroke, 20 seconds rest, then 4 x 50 m freestyle build, 15 seconds rest",
      cooldown: "200 m easy choice",
    },
    {
      name: "Threshold Hundreds",
      minutes: 45,
      distance_m: 2300,
      intensity: "Moderate",
      warmup: "500 m as 300 freestyle then 200 kick with a board",
      drills: "6 x 50 m single arm drill, 20 seconds rest",
      main: "10 x 100 m freestyle at a firm effort, 20 seconds rest, then 6 x 50 m descending one to three, 15 seconds rest",
      cooldown: "200 m easy backstroke",
    },
    {
      name: "Pyramid Builder",
      minutes: 45,
      distance_m: 2400,
      intensity: "Moderate",
      warmup: "500 m easy freestyle with every fourth length backstroke",
      drills: "4 x 75 m catch up drill, 20 seconds rest",
      main: "100, 200, 300, 200, 100 m freestyle steady, 25 seconds rest, then 8 x 50 m freestyle fast, 20 seconds rest",
      cooldown: "300 m relaxed mixed strokes",
    },
    {
      name: "Long Aerobic Distance",
      minutes: 60,
      distance_m: 3000,
      intensity: "Endurance",
      warmup: "600 m as 400 freestyle then 200 kick",
      drills: "6 x 50 m fingertip drag drill, 15 seconds rest",
      main: "3 x 500 m freestyle at a relaxed endurance pace, 40 seconds rest, then 6 x 50 m freestyle build, 15 seconds rest",
      cooldown: "300 m easy backstroke",
    },
    {
      name: "Broken Distance Intervals",
      minutes: 60,
      distance_m: 3200,
      intensity: "Hard",
      warmup: "600 m as 300 freestyle, 200 backstroke, 100 kick",
      drills: "8 x 50 m single arm and catch up mixed, 20 seconds rest",
      main: "4 x 300 m freestyle firm, 30 seconds rest, then 8 x 75 m freestyle fast, 20 seconds rest",
      cooldown: "400 m easy choice",
    },
  ];

  // Dumbbell-only strength routines (ISC-473..480). Static reference content
  // like SWIM_SETS: no adaptive logic, dumbbells and bodyweight only. Movement
  // selection leans on Ben Patrick's ATG standards (split squat, RDL, external
  // rotation, cross bench pullover, trap 3 raise); set and rep schemes follow
  // the Huberman Lab guidance: the 3x5 protocol for strength days (3 to 5
  // reps, 3 to 5 sets, 2 to 4 min rest) and 8 to 15 reps with 60 to 90s rest
  // for hypertrophy days, alternating focus across the week. Sources cited in
  // the HTML comment above the dumbbell list in index.html.
  const DUMBBELL_WORKOUTS = [
    {
      name: "Full Body Strength A",
      minutes: 35,
      focus: "Strength",
      scheme: "Heavier, 3 to 5 sets, rest 2 to 3 min between sets",
      exercises: [
        { name: "ATG Split Squat", dose: "3 x 5 to 8 / side", cue: "Dumbbells at your sides, front knee travels over the toes, 3s down. ATG target: 25 percent bodyweight per hand." },
        { name: "Floor or Incline Press", dose: "4 x 5", cue: "Elbows about 45 degrees from the ribs, pause light at the bottom, press hard." },
        { name: "One-Arm Row", dose: "3 x 6 / side", cue: "Hand braced on a bench or knee, flat back, pull the dumbbell to the hip." },
        { name: "Dumbbell RDL", dose: "3 x 8", cue: "Soft knees, hips back until the hamstrings load, flat back the whole way. ATG works up to 20 reps at 25 percent bodyweight per hand." },
        { name: "External Rotation", dose: "2 x 10 / side", cue: "Light dumbbell, elbow pinned at the side or on the knee, rotate out slow. ATG standard is 5 to 10 percent bodyweight." },
      ],
    },
    {
      name: "Full Body Hypertrophy B",
      minutes: 35,
      focus: "Muscle",
      scheme: "Moderate, 3 sets of 8 to 15, rest 60 to 90s, close to failure",
      exercises: [
        { name: "Goblet Squat", dose: "3 x 10 to 15", cue: "One dumbbell held at the chest, sit deep between the heels, chest tall." },
        { name: "Shoulder Press", dose: "3 x 8 to 12", cue: "Standing or seated, dumbbells start at the collarbones, finish with biceps by the ears." },
        { name: "Cross-Bench Pullover", dose: "3 x 10 to 15", cue: "Shoulders on a bench, one dumbbell over the chest, lower behind the head for a big lat and chest stretch. An ATG staple." },
        { name: "Trap 3 Raise", dose: "2 x 10 to 12 / side", cue: "Light dumbbell, arm raised at 45 degrees from overhead, thumb up. ATG standard is 10 percent bodyweight per hand." },
        { name: "Hammer Curl + Overhead Triceps", dose: "2 x 10 to 15 each", cue: "Superset: curl with palms facing, then press one dumbbell overhead with both hands and lower behind the head." },
      ],
    },
    {
      name: "Express 20",
      minutes: 20,
      focus: "Circuit",
      scheme: "3 rounds, 8 to 12 reps each, minimal rest between moves",
      exercises: [
        { name: "Goblet Squat", dose: "8 to 12", cue: "Smooth tempo, full depth, no bounce." },
        { name: "Push-Up or Floor Press", dose: "8 to 12", cue: "Pick the one that leaves 2 reps in the tank." },
        { name: "One-Arm Row", dose: "8 to 12 / side", cue: "Brace on anything sturdy, no torso twist." },
        { name: "Dumbbell RDL", dose: "8 to 12", cue: "Hips back, hamstrings load, stand tall." },
        { name: "External Rotation", dose: "10 / side", cue: "Light and strict, the nap-window shoulder insurance." },
      ],
    },
  ];

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

  let currentView = "dashboard";

  function switchTab(name) {
    // Leaving a detail deep-link: strip the hash without firing hashchange so we
    // do not loop back into the detail router (ISC-356 deep-link cleanup).
    if (/^#activity\//.test(location.hash)) {
      history.replaceState(null, "", location.pathname + location.search);
    }
    currentView = name;
    document.querySelectorAll(".nav-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === name);
    });
    document.querySelectorAll("main.wrap > section").forEach((section) => {
      section.hidden = section.id !== `view-${name}`;
    });
    if (name === "dashboard") loadDashboard();
    if (name === "plan") loadPlan();
    if (name === "activities") loadActivities();
    if (name === "nutrition") loadNutrition();
    if (name === "trends") loadTrends();
    if (name === "races") loadRaces();
    if (name === "stretch") loadStretch();
    if (name === "sleep") loadSleep();
    if (name === "golf") loadGolf();
    if (name === "sync") loadSyncStatus();
  }

  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.view));
  });

  // --- Training plan ---------------------------------------------------

  let planMonday = null; // ISO Monday of the viewed week; null = current week

  function planAddDays(iso, n) {
    const p = iso.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }

  function planMinutesLabel(min) {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return `${h}:${String(m).padStart(2, "0")}`;
  }

  const PLAN_DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const PLAN_SPORT_LABEL = { bike: "Bike", run: "Run", strength: "Strength", mobility: "Mobility", rest: "Rest" };

  function renderPlanSession(s) {
    const done = s.status === "done";
    const skipped = s.status === "skipped";
    const meta = [
      PLAN_SPORT_LABEL[s.sport] || s.sport,
      s.duration_min > 0 ? `${s.duration_min} min` : null,
      s.distance_m ? `${(s.distance_m / 1000).toFixed(1)} km` : null,
      s.tss_planned ? `${s.tss_planned} TSS` : null,
    ].filter(Boolean).join(" · ");
    return `
    <div class="plan-card${done ? " plan-done" : ""}${skipped ? " plan-skipped" : ""}" data-plan-id="${s.id}">
      <div class="plan-card-top">
        <div>
          <div class="plan-card-title">${escapeHtml(s.title)}</div>
          <div class="plan-card-meta">${escapeHtml(meta)}${s.target ? ` · ${escapeHtml(s.target)}` : ""}</div>
        </div>
        <div class="plan-card-actions">
          <button type="button" class="plan-toggle" data-plan-action="${done ? "planned" : "done"}">${done ? "Done ✓" : "Mark done"}</button>
          ${s.sport !== "rest" && !done ? `<button type="button" class="plan-skip" data-plan-action="skipped" ${skipped ? "disabled" : ""}>${skipped ? "Skipped" : "Skip"}</button>` : ""}
        </div>
      </div>
      ${s.detail ? `<details class="plan-card-detail"><summary>Details</summary><pre class="plan-detail-text">${escapeHtml(s.detail)}</pre></details>` : ""}
    </div>`;
  }

  async function loadPlan() {
    let summary, week;
    try {
      summary = await api("/api/plan/summary");
      const dateParam = planMonday ? `?date=${planMonday}` : "";
      week = await api(`/api/plan/week${dateParam}`);
    } catch {
      return;
    }
    // First open before the block begins: jump to week 1 instead of showing
    // an empty pre-plan week (plan_start is always a Monday).
    if (
      planMonday === null &&
      summary.totalSessions > 0 &&
      week.sessions.length === 0 &&
      week.weekStart < summary.planStart
    ) {
      planMonday = summary.planStart;
      loadPlan();
      return;
    }
    const empty = summary.totalSessions === 0;
    document.getElementById("plan-empty").hidden = !empty;
    document.getElementById("plan-days").innerHTML = "";
    document.getElementById("plan-phase-title").textContent = `${summary.phase} training plan`;
    if (empty) {
      document.getElementById("plan-week-label").textContent = "";
      document.getElementById("plan-week-summary").textContent = "";
      return;
    }
    planMonday = week.weekStart;

    const weekNo = Math.floor((Date.parse(week.weekStart) - Date.parse(summary.planStart)) / 604800000) + 1;
    const inBlock = weekNo >= 1 && weekNo <= summary.totalWeeks;
    const cutback = week.sessions.some((s) => s.title.includes("(cutback week)"));
    const consolidation = week.sessions.some((s) => s.title.includes("(consolidation week)"));
    const tag = cutback ? " · cutback week" : consolidation ? " · consolidation week" : "";
    document.getElementById("plan-week-label").textContent = inBlock
      ? `Week ${weekNo} of ${summary.totalWeeks} · ${week.weekStart}${tag}`
      : `${week.weekStart} · outside the current block`;

    const planned = week.sessions.reduce((t, s) => t + s.duration_min, 0);
    const doneMin = week.sessions.filter((s) => s.status === "done").reduce((t, s) => t + s.duration_min, 0);
    document.getElementById("plan-week-summary").textContent = week.sessions.length
      ? `This week: ${planMinutesLabel(planned)} planned, ${planMinutesLabel(doneMin)} done · whole plan ${summary.completionPercent}% complete so far`
      : "Nothing planned this week.";

    const byDay = new Map();
    for (const s of week.sessions) {
      if (!byDay.has(s.plan_day)) byDay.set(s.plan_day, []);
      byDay.get(s.plan_day).push(s);
    }
    const html = week.days.map((day, i) => {
      const sessions = byDay.get(day) || [];
      if (sessions.length === 0) return "";
      return `
      <div class="plan-day">
        <div class="plan-day-head">${PLAN_DOW[i]} <span class="plan-day-date">${day}</span></div>
        ${sessions.map(renderPlanSession).join("")}
      </div>`;
    }).join("");
    document.getElementById("plan-days").innerHTML = html;

    document.getElementById("plan-roadmap").innerHTML =
      "<h3>Road to fall 2027</h3>" +
      summary.macroRoadmap.map((p) => `<div class="plan-road-row"><strong>${escapeHtml(p.phase)}</strong> (${escapeHtml(p.span)}): ${escapeHtml(p.focus)}</div>`).join("");
    document.getElementById("plan-zones-power").innerHTML =
      "<h3>Bike power (FTP 169 W)</h3>" +
      summary.zonesPower.map((z) => `<div class="plan-zone-row"><span>${escapeHtml(z.zone)}</span><span>${escapeHtml(z.range)}</span></div>`).join("");
    document.getElementById("plan-zones-hr").innerHTML =
      "<h3>Heart rate (LTHR 185)</h3>" +
      summary.zonesHr.map((z) => `<div class="plan-zone-row"><span>${escapeHtml(z.zone)}</span><span>${escapeHtml(z.range)}</span></div>`).join("");
    document.getElementById("plan-priority-note").textContent = summary.priorityNote;
  }

  document.getElementById("plan-prev-week").addEventListener("click", () => {
    if (planMonday) { planMonday = planAddDays(planMonday, -7); loadPlan(); }
  });
  document.getElementById("plan-next-week").addEventListener("click", () => {
    if (planMonday) { planMonday = planAddDays(planMonday, 7); loadPlan(); }
  });

  // Status toggles via delegation so re-renders never re-bind.
  document.getElementById("plan-days").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-plan-action]");
    if (!btn) return;
    const card = btn.closest("[data-plan-id]");
    if (!card) return;
    btn.disabled = true;
    try {
      await api(`/api/plan/${card.dataset.planId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: btn.dataset.planAction }),
      });
      loadPlan();
    } catch {
      btn.disabled = false;
    }
  });

  async function loadPlanChip() {
    const chip = document.getElementById("today-plan-chip");
    try {
      const summary = await api("/api/plan/summary");
      if (!summary.nextSession) { chip.hidden = true; return; }
      document.getElementById("today-plan").textContent = summary.nextSession.title;
      document.getElementById("today-plan-sub").textContent =
        `${summary.nextSession.plan_day} · ${summary.nextSession.duration_min} min`;
      chip.hidden = false;
    } catch {
      chip.hidden = true;
    }
  }

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
    loadPlanChip();
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
    renderTodayWeekChip(week);
    loadPacing(week);
    loadTodayForm();
    loadTodaySleep();
    loadRecords();
    loadWeight();
    loadRace();
  }

  // --- Race countdown (dashboard side column) --------------------------
  //
  // When a race date is set, a countdown card shows in the right column with a
  // static taper checklist inside the final week (ISC-366). A past date shows a
  // graceful "raced N days ago" with a clear control (ISC-367). With nothing
  // set there is no card at all, only a quiet "Set a race goal" link at the
  // bottom of the column that expands an inline form (ISC-368, ISC-369).

  const TAPER_CHECKLIST = [
    "Cut your training volume, keep a little intensity",
    "Sleep well and stay hydrated all week",
    "Eat familiar meals, nothing new the day before",
    "Lay out your gear and bottles the night before",
    "Arrive early and warm up easy",
    "Trust the work you already did and stay relaxed",
  ];

  // Whole days from today (local midnight) to the race date (a YYYY-MM-DD
  // calendar day). Positive is future, zero is today, negative is past.
  function daysUntil(ymd) {
    const parts = ymd.split("-").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    const race = new Date(parts[0], parts[1] - 1, parts[2]);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((race.getTime() - today.getTime()) / 86400000);
  }

  async function loadRace() {
    let s;
    try {
      s = await api("/api/settings");
    } catch {
      return;
    }
    renderRace(s.race_name, s.race_date);
  }

  function renderRace(name, date) {
    const cardWrap = document.getElementById("view-race-card");
    const cardBody = document.getElementById("race-card-body");
    const setSlot = document.getElementById("race-goal-set");
    if (!cardWrap || !cardBody || !setSlot) return;

    if (date) {
      cardWrap.hidden = false;
      renderRaceCard(cardBody, name, date);
      setSlot.hidden = true;
      setSlot.innerHTML = "";
    } else {
      cardWrap.hidden = true;
      cardBody.innerHTML = "";
      setSlot.hidden = false;
      renderRaceGoalLink(setSlot);
    }
  }

  function renderRaceCard(el, name, date) {
    const d = daysUntil(date);
    const displayName = escapeHtml(name || "Your race");
    let inner = `<div class="race-name">${displayName}</div>`;

    if (d == null) {
      inner += `<div class="race-days-label">Date unavailable</div>`;
    } else if (d < 0) {
      const n = Math.abs(d);
      inner += `<div class="race-past">Raced ${n} day${n === 1 ? "" : "s"} ago</div>`;
    } else if (d === 0) {
      inner += `<div class="race-past">Race day is today</div>`;
    } else {
      inner += `<div class="race-days">${d}</div><div class="race-days-label">day${d === 1 ? "" : "s"} to go</div>`;
    }

    if (d != null && d >= 0 && d <= 7) {
      inner +=
        `<div class="race-taper-title">Taper week checklist</div><ul class="race-taper">` +
        TAPER_CHECKLIST.map((t) => `<li>${escapeHtml(t)}</li>`).join("") +
        `</ul>`;
    }

    inner += `<div class="race-card-actions">
      <button type="button" class="race-mini-btn" id="race-edit">Edit</button>
      <button type="button" class="race-mini-btn" id="race-clear">Clear</button>
    </div>`;
    el.innerHTML = inner;
    document.getElementById("race-edit").addEventListener("click", () => showRaceForm(name || "", date || ""));
    document.getElementById("race-clear").addEventListener("click", clearRace);
  }

  function renderRaceGoalLink(el) {
    el.innerHTML = `<button type="button" class="race-goal-link" id="race-goal-open">+ Set a race goal</button>`;
    document.getElementById("race-goal-open").addEventListener("click", () => renderRaceForm(el, "", ""));
  }

  function showRaceForm(name, date) {
    const setSlot = document.getElementById("race-goal-set");
    setSlot.hidden = false;
    renderRaceForm(setSlot, name, date);
  }

  function renderRaceForm(el, name, date) {
    el.innerHTML = `
      <div class="race-goal-form">
        <div class="field"><label for="race-name-input">Race name</label><input type="text" id="race-name-input" value="${escapeHtml(name)}" placeholder="e.g. Spring Gran Fondo"></div>
        <div class="field"><label for="race-date-input">Race date</label><input type="date" id="race-date-input" value="${escapeHtml(date)}"></div>
        <div class="form-actions">
          <button type="button" class="btn" id="race-save">Save</button>
          <button type="button" class="btn btn-secondary" id="race-cancel">Cancel</button>
          <span class="race-form-status" id="race-form-status"></span>
        </div>
      </div>`;
    document.getElementById("race-save").addEventListener("click", saveRace);
    document.getElementById("race-cancel").addEventListener("click", () => loadRace());
  }

  async function saveRace() {
    const name = document.getElementById("race-name-input").value.trim();
    const date = document.getElementById("race-date-input").value;
    const statusEl = document.getElementById("race-form-status");
    if (!date) {
      statusEl.textContent = "Pick a race date.";
      return;
    }
    const btn = document.getElementById("race-save");
    btn.disabled = true;
    try {
      await api("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ race_name: name || null, race_date: date }),
      });
      await loadRace();
    } catch (err) {
      statusEl.textContent = err.message;
      btn.disabled = false;
    }
  }

  async function clearRace() {
    if (!window.confirm("Clear this race goal?")) return;
    try {
      await api("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ race_name: null, race_date: null }),
      });
      await loadRace();
    } catch (err) {
      alert(err.message);
    }
  }

  // --- Today strip (dashboard glance band) -----------------------------
  //
  // Three compact chips above Quick log. The week chip reuses the /api/week
  // data the dashboard already fetched; Form and Last sleep each do one extra
  // read, filled independently so a slow or empty response never blocks the
  // rest of the dashboard. Every chip shows a quiet placeholder rather than
  // NaN or undefined when its data is missing.

  function renderTodayWeekChip(week) {
    const val = document.getElementById("today-week");
    const sub = document.getElementById("today-week-sub");
    if (val) val.textContent = `${week.sessions} sess, ${week.hours_g1} h`;
    if (sub) {
      const noGap = week.gap_sessions === 0 && week.gap_hours === 0;
      sub.textContent = noGap
        ? "G1 target met"
        : `${week.gap_sessions} sess, ${week.gap_hours} h to go`;
    }
  }

  async function loadTodayForm() {
    const el = document.getElementById("today-form");
    if (!el) return;
    try {
      const data = await api("/api/metrics/training-load?days=1");
      const form = data && data.current ? data.current.form : null;
      el.textContent = form == null ? "--" : String(form);
    } catch {
      el.textContent = "--";
    }
  }

  async function loadTodaySleep() {
    const el = document.getElementById("today-sleep");
    if (!el) return;
    try {
      const data = await api("/api/sleep?limit=1");
      const night = data && data.nights && data.nights[0] ? data.nights[0] : null;
      el.textContent = night ? fmtSleep(night.total_sleep_s) : "--";
    } catch {
      el.textContent = "--";
    }
  }

  // --- Pacing line + G1 risk flag (dashboard) --------------------------
  //
  // Both read plain sessions/hours arithmetic endpoints, never the load
  // series. The pacing line hides entirely on insufficient history
  // (ISC-376); the risk flag only appears when the week projects short
  // (ISC-380), so on-track weeks stay quiet.
  async function loadPacing(week) {
    const line = document.getElementById("pacing-line");
    if (!line) return;
    try {
      const [risk, pacing] = await Promise.all([
        api("/api/metrics/g1-risk"),
        api("/api/metrics/pacing"),
      ]);
      if (activitiesCache.length === 0) {
        try {
          const d = await api("/api/activities");
          activitiesCache = d.activities || [];
        } catch {}
      }
      if (!pacing || pacing.insufficient_history) {
        line.hidden = true;
      } else {
        let text = (() => { const n = Math.round(risk.projectedSessions); return `Usual rhythm lands you at ${n} ${n === 1 ? "session" : "sessions"}, ${Number(risk.projectedHours).toFixed(1)} h by Sunday.`; })();
        if (risk.verdict !== "met" && week.gap_sessions > 0) {
          text += ` ${suggestClose(week)}`;
        }
        line.textContent = text;
        line.hidden = false;
      }
      const sub = document.getElementById("today-week-sub");
      if (sub && !sub.querySelector(".risk-flag") && risk.verdict === "at_risk") {
        sub.insertAdjacentHTML("beforeend", `<span class="risk-flag"> at risk</span>`);
      }
    } catch {
      line.hidden = true;
    }
  }

  // Concrete close suggestion from this week's swim/ride mix (ISC-375).
  function suggestClose(week) {
    const one = week.gap_sessions === 1;
    const acts = activitiesCache.filter(
      (a) => a.start_time >= `${week.week_start}T00:00:00`,
    );
    const swims = acts.filter((a) => a.sport === "swimming").length;
    const rides = acts.filter(
      (a) => a.sport === "cycling" || a.sport === "virtual_cycling",
    ).length;
    if (swims < rides) {
      return one ? "One more swim closes it." : "A swim would balance the week.";
    }
    if (rides < swims) {
      return one ? "One more ride closes it." : "A ride would balance the week.";
    }
    return one ? "One more swim or ride closes it." : "Any mix of swims and rides closes it.";
  }

  // --- Weight progress (from Zwift ride data) --------------------------

  // Renders a small progress line across the weight points; single-point or
  // flat series still draws a centered line so the widget never looks broken.
  function renderWeightSparkline(points, svgId) {
    const svg = document.getElementById(svgId);
    if (!svg) return;
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

  // A dated list of readings, newest first, each with its kg value and the
  // change from the previous (older) reading. `points` are oldest-first. Caps
  // at the newest MAX_WEIGHT_READINGS so a long ride history never floods the
  // card; the stats line still reports the true total count.
  const MAX_WEIGHT_READINGS = 12;
  function weightReadingsHtml(points, unit) {
    const rows = [];
    const stop = Math.max(0, points.length - MAX_WEIGHT_READINGS);
    for (let i = points.length - 1; i >= stop; i--) {
      const p = points[i];
      const prev = i > 0 ? points[i - 1] : null;
      const change = prev ? Math.round((p.weight_kg - prev.weight_kg) * 10) / 10 : null;
      let chip = "";
      if (change !== null && change !== 0) {
        const down = change < 0;
        chip = `<span class="wr-chip ${down ? "down" : "up"}">${down ? "↓" : "↑"} ${Math.abs(change)}</span>`;
      } else if (change === 0) {
        chip = `<span class="wr-chip flat">±0</span>`;
      }
      rows.push(
        `<li class="wr-row"><span class="wr-date">${escapeHtml(fmtNightDate(p.date))}</span><span class="wr-kg">${p.weight_kg} ${unit}</span>${chip}</li>`,
      );
    }
    return rows.join("");
  }

  async function fetchWeightData() {
    try {
      return await api("/api/metrics/weight");
    } catch {
      return null;
    }
  }

  // Fills a weight widget from the shared /api/metrics/weight data. `els` maps
  // roles to element ids so the same renderer drives both the dashboard card
  // and the nutrition-tab card; any id may be absent on a given surface.
  function renderWeightWidget(els, data) {
    const points = data.points || [];
    const unit = escapeHtml(data.unit || "kg");
    const section = els.section ? document.getElementById(els.section) : null;
    // Honest empty state: no Zwift weight data yet -> hide the whole widget.
    if (section) section.hidden = data.current == null;
    if (data.current == null) return;

    const cur = els.current ? document.getElementById(els.current) : null;
    if (cur) cur.textContent = `${data.current} ${unit}`;

    const deltaEl = els.delta ? document.getElementById(els.delta) : null;
    if (deltaEl) {
      if (data.delta == null || data.delta === 0 || points.length < 2) {
        deltaEl.textContent = points.length < 2 ? "First reading from Zwift" : "No change yet";
        deltaEl.className = "weight-delta flat";
      } else {
        const down = data.delta < 0;
        deltaEl.textContent = `${down ? "↓" : "↑"} ${Math.abs(data.delta)} kg since first ride`;
        deltaEl.className = `weight-delta ${down ? "down" : "up"}`;
      }
    }

    // Weight goal (ISC-440/442): a goal line with kg-to-goal, plus an inline
    // set/edit/clear affordance. Renders only on the dashboard card (els.goal
    // present); absent goal keeps the widget byte-identical (ISC-441).
    const goalEl = els.goal ? document.getElementById(els.goal) : null;
    if (goalEl) {
      const g = data.weight_goal_kg;
      if (g != null && data.current != null) {
        const diff = Math.round((data.current - g) * 10) / 10;
        const dir = diff > 0 ? `${diff} ${unit} above goal` : diff < 0 ? `${Math.abs(diff)} ${unit} below goal` : "at goal";
        goalEl.innerHTML = `Goal ${g} ${unit} &middot; ${dir} <button type="button" class="weight-goal-edit" id="${els.goal}-edit">Edit</button>`;
        goalEl.hidden = false;
      } else {
        goalEl.innerHTML = `<button type="button" class="weight-goal-edit" id="${els.goal}-edit">Set a weight goal</button>`;
        goalEl.hidden = false;
      }
      const editBtn = document.getElementById(`${els.goal}-edit`);
      if (editBtn) {
        editBtn.addEventListener("click", () => {
          goalEl.innerHTML = `<input type="number" step="0.1" min="30" max="200" class="weight-goal-input" id="${els.goal}-input" placeholder="kg" value="${data.weight_goal_kg ?? ""}"> <button type="button" class="weight-goal-edit" id="${els.goal}-save">Save</button> <button type="button" class="weight-goal-edit" id="${els.goal}-clear">Clear</button>`;
          const save = async (value) => {
            try {
              await api("/api/settings", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ weight_goal_kg: value }),
              });
            } catch (err) {
              showToast(err && err.message ? err.message : "Could not save goal");
            }
            loadWeight();
            if (typeof loadNutrition === "function") loadNutrition();
          };
          document.getElementById(`${els.goal}-save`).addEventListener("click", () => {
            const v = document.getElementById(`${els.goal}-input`).value.trim();
            save(v === "" ? null : Number(v));
          });
          document.getElementById(`${els.goal}-clear`).addEventListener("click", () => save(null));
        });
      }
    }

    if (els.svg) renderWeightSparkline(points, els.svg);

    const statsEl = els.stats ? document.getElementById(els.stats) : null;
    if (statsEl) {
      const count = data.count != null ? data.count : points.length;
      if (count > 0 && data.min != null && data.max != null) {
        // count/min/max are all-time (server-side over every reading); the list
        // below is capped, so say so when it is truncated to avoid implying the
        // shown rows are all of them.
        const truncated = count > MAX_WEIGHT_READINGS ? ` · newest ${MAX_WEIGHT_READINGS} shown` : "";
        statsEl.textContent = `${count} reading${count === 1 ? "" : "s"} · range ${data.min} to ${data.max} ${unit}${truncated}`;
      } else {
        statsEl.textContent = "";
      }
    }

    const readingsEl = els.readings ? document.getElementById(els.readings) : null;
    if (readingsEl) readingsEl.innerHTML = weightReadingsHtml(points, unit);
  }

  const DASHBOARD_WEIGHT_ELS = {
    section: "view-weight-card",
    current: "weight-current",
    delta: "weight-delta",
    svg: "weight-svg",
    stats: "weight-stats",
    readings: "weight-readings",
    goal: "weight-goal",
  };
  const NUTRITION_WEIGHT_ELS = {
    section: "nutri-weight-card",
    current: "nutri-weight-current",
    delta: "nutri-weight-delta",
    svg: "nutri-weight-svg",
    stats: "nutri-weight-stats",
    readings: "nutri-weight-readings",
  };

  async function loadWeight() {
    const data = await fetchWeightData();
    if (data) renderWeightWidget(DASHBOARD_WEIGHT_ELS, data);
  }

  async function loadNutritionWeight() {
    const data = await fetchWeightData();
    if (data) renderWeightWidget(NUTRITION_WEIGHT_ELS, data);
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

  // The most recent activities payload, kept so the detail view can render a
  // manual activity's local fields instantly (no fetch, ISC-354) and so
  // returning from a detail never needs a refetch (scroll is preserved).
  let activitiesCache = [];

  async function loadActivities() {
    let data;
    try {
      data = await api("/api/activities?limit=50");
    } catch {
      return;
    }
    activitiesCache = data.activities || [];
    const list = document.getElementById("activity-list");
    list.innerHTML = activitiesCache
      .map((a) => {
        const icon = SPORT_ICONS[a.sport] || SPORT_ICONS.other;
        const label = SPORT_LABELS[a.sport] || a.sport;
        const sourceBadge = a.source === "garmin" ? "Garmin" : "Manual";
        const title = a.title ? escapeHtml(a.title) : label;
        return `
        <li class="activity-item clickable" data-id="${a.id}" data-source="${a.source}" tabindex="0" role="button" aria-label="Open activity detail">
          <div class="activity-icon">${icon}</div>
          <div class="activity-main">
            <div class="activity-title">${title}</div>
            <div class="activity-meta">${formatDate(a.start_time)} &middot; ${formatDuration(a.duration_s)}${a.notes ? ` &middot; ${escapeHtml(a.notes)}` : ""}</div>
          </div>
          <span class="badge">${sourceBadge}</span>
          <div class="activity-actions">
            <button class="icon-btn" data-action="delete" data-id="${a.id}" data-source="${a.source}">Delete</button>
          </div>
          <span class="activity-chevron" aria-hidden="true">&rsaquo;</span>
        </li>`;
      })
      .join("");

    // Whole row clicks in to the detail view (ISC-349), except taps that land on
    // the delete control. Keyboard: Enter/Space opens too (ISC-349 focusable).
    list.querySelectorAll(".activity-item.clickable").forEach((li) => {
      const open = (e) => {
        if (e.target.closest(".activity-actions")) return;
        goToDetail(Number(li.dataset.id));
      };
      li.addEventListener("click", open);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          goToDetail(Number(li.dataset.id));
        }
      });
    });

    list.querySelectorAll('[data-action="delete"]').forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
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

    loadDuplicates();
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

  // --- Workout detail view (hash-routed #activity/ID) ------------------
  //
  // The detail view is its own section that hash routing shows in place of the
  // eight tabbed views. Opening captures where we came from (view + scroll) so
  // the back affordance and the browser back button both restore the exact list
  // scroll (ISC-355). A direct load of #activity/ID after reload fetches and
  // renders straight into the detail (ISC-356). Manual activities render local
  // fields from the cached list row with zero fetch (ISC-354); Garmin rows show
  // a brief loading state then the cached lap/GPS detail.

  let preDetail = null; // {view, scrollY} when opened from within the app, else null
  let detailActivity = null;

  function goToDetail(id) {
    preDetail = { view: currentView, scrollY: window.scrollY };
    location.hash = "activity/" + id;
  }

  function backFromDetail() {
    if (preDetail) history.back();
    else location.hash = "";
  }

  function showDetailSection() {
    document.querySelectorAll("main.wrap > section").forEach((s) => {
      s.hidden = s.id !== "view-activity-detail";
    });
    document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("active"));
    window.scrollTo(0, 0);
  }

  function setActiveSection(view) {
    currentView = view;
    document.querySelectorAll(".nav-tab").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    document.querySelectorAll("main.wrap > section").forEach((s) => {
      s.hidden = s.id !== `view-${view}`;
    });
  }

  function closeActivityDetail() {
    const detail = document.getElementById("view-activity-detail");
    if (!detail || detail.hidden) return;
    if (preDetail) {
      const view = preDetail.view;
      const scrollY = preDetail.scrollY;
      preDetail = null;
      setActiveSection(view); // no refetch, so the list DOM and scroll survive
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    } else {
      switchTab("activities"); // deep-loaded straight into detail: fresh list
    }
  }

  function backButtonHtml() {
    return `<button type="button" class="detail-back" id="detail-back">&lsaquo; Back to activities</button>`;
  }
  function wireBack() {
    const btn = document.getElementById("detail-back");
    if (btn) btn.addEventListener("click", backFromDetail);
  }

  function saveActivityField(id, fields) {
    return api(`/api/activities/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
  }

  function applyDetailUpdate(updated) {
    detailActivity = updated;
    const i = activitiesCache.findIndex((a) => a.id === updated.id);
    if (i >= 0) activitiesCache[i] = updated;
  }

  function renderLapsTable(laps) {
    const rows = laps
      .map((lp) => {
        const t = lp.duration_s != null ? fmtDur(lp.duration_s) : "";
        const d = lp.distance_m != null ? `${(lp.distance_m / 1000).toFixed(2)} km` : "";
        const ahr = lp.avg_hr != null ? String(lp.avg_hr) : "";
        const mhr = lp.max_hr != null ? String(lp.max_hr) : "";
        const ap = lp.avg_power != null ? String(lp.avg_power) : "";
        return `<tr><td>${escapeHtml(String(lp.lap_index))}</td><td>${escapeHtml(t)}</td><td>${escapeHtml(d)}</td><td>${escapeHtml(ahr)}</td><td>${escapeHtml(mhr)}</td><td>${escapeHtml(ap)}</td></tr>`;
      })
      .join("");
    return `<div class="detail-laps-wrap"><table class="detail-laps"><thead><tr><th>Lap</th><th>Time</th><th>Distance</th><th>Avg HR</th><th>Max HR</th><th>Avg W</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // Normalize [lat,lng] points into a fixed viewBox and stroke an inline path.
  // No external tiles. Fewer than two points renders a clean indoor empty state
  // rather than an empty box (ISC-353).
  function renderMiniMap(polyline) {
    if (!polyline || polyline.length < 2) {
      return `<p class="detail-map-empty">Indoor session, no route.</p>`;
    }
    const lats = polyline.map((p) => p[0]);
    const lngs = polyline.map((p) => p[1]);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const W = 320;
    const H = 200;
    const pad = 14;
    const spanLat = maxLat - minLat || 1e-6;
    const spanLng = maxLng - minLng || 1e-6;
    const scale = Math.min((W - 2 * pad) / spanLng, (H - 2 * pad) / spanLat);
    const offX = (W - spanLng * scale) / 2;
    const offY = (H - spanLat * scale) / 2;
    const x = (lng) => offX + (lng - minLng) * scale;
    const y = (lat) => H - (offY + (lat - minLat) * scale);
    const d = polyline.map((p, i) => `${i === 0 ? "M" : "L"}${x(p[1]).toFixed(1)},${y(p[0]).toFixed(1)}`).join(" ");
    return `<svg class="detail-map" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Route map"><path d="${d}" fill="none" stroke="#26221B" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  function renderDetailLoading(cached) {
    const body = document.getElementById("activity-detail-body");
    const title = cached ? escapeHtml(cached.title || SPORT_LABELS[cached.sport] || cached.sport) : "Activity";
    body.innerHTML =
      backButtonHtml() +
      `<div class="detail-head"><div class="detail-title">${title}</div></div>` +
      `<p class="detail-loading">Loading route and laps from Garmin...</p>`;
    wireBack();
  }

  function renderActivityDetail(activity, detail, detailError) {
    detailActivity = activity;
    const body = document.getElementById("activity-detail-body");
    const label = SPORT_LABELS[activity.sport] || activity.sport;
    const title = activity.title ? escapeHtml(activity.title) : escapeHtml(label);
    const icon = SPORT_ICONS[activity.sport] || SPORT_ICONS.other;
    const sourceLabel = activity.source === "garmin" ? "Garmin" : "Manual";
    const clock = fmtClock(activity.start_time);
    const when = `${formatDate(activity.start_time)}${clock ? ` &middot; ${clock}` : ""}`;

    const summary = detail && detail.summary ? detail.summary : null;
    const stats = [];
    stats.push(["Duration", formatDuration(activity.duration_s)]);
    if (activity.distance_m != null) stats.push(["Distance", `${(activity.distance_m / 1000).toFixed(2)} km`]);
    if (activity.avg_hr != null) stats.push(["Avg HR", `${activity.avg_hr} bpm`]);
    if (summary && summary.max_hr != null) stats.push(["Max HR", `${summary.max_hr} bpm`]);
    if (activity.avg_power != null) stats.push(["Avg power", `${activity.avg_power} W`]);
    if (summary && summary.max_power != null) stats.push(["Max power", `${summary.max_power} W`]);
    if (summary && summary.elevation_gain_m != null) stats.push(["Elevation", `${Math.round(summary.elevation_gain_m)} m`]);
    if (activity.calories != null) stats.push(["Calories", `${activity.calories} kcal`]);
    const statsHtml = stats
      .map(([l, v]) => `<div class="detail-stat"><div class="detail-stat-label">${escapeHtml(l)}</div><div class="detail-stat-value">${escapeHtml(v)}</div></div>`)
      .join("");

    let chips = "";
    for (let n = 1; n <= 10; n++) {
      chips += `<button type="button" class="rpe-chip${activity.rpe === n ? " active" : ""}" data-rpe="${n}">${n}</button>`;
    }
    chips += `<button type="button" class="rpe-chip rpe-clear" data-rpe="clear">Clear</button>`;

    let lapsHtml = "";
    if (detail && detail.laps && detail.laps.length > 0) {
      const lapsTitle = activity.sport === "golf" ? "Holes" : "Laps";
      lapsHtml = `<div class="detail-block"><div class="detail-block-title">${lapsTitle}</div>${renderLapsTable(detail.laps)}</div>`;
    }
    let mapHtml = "";
    if (detail) {
      mapHtml = `<div class="detail-block"><div class="detail-block-title">Route</div>${renderMiniMap(detail.polyline)}</div>`;
    }
    const refreshHtml = activity.garmin_sourced
      ? `<div class="detail-block"><button type="button" class="detail-refresh" id="detail-refresh">Refresh from Garmin</button></div>`
      : "";
    const errHtml = detailError
      ? `<p class="detail-error">Garmin detail unavailable right now. Showing the fields we have.</p>`
      : "";

    body.innerHTML =
      backButtonHtml() +
      `<div class="detail-head">
         <div class="detail-title">${icon} ${title}</div>
         <div class="detail-sub"><span>${escapeHtml(label)}</span><span>${when}</span><span class="detail-source-badge">${escapeHtml(sourceLabel)}</span></div>
       </div>` +
      errHtml +
      `<div class="detail-stat-grid">${statsHtml}</div>` +
      `<div class="detail-block">
         <div class="detail-block-title">How hard did it feel?</div>
         <div class="rpe-chips">${chips}</div>
       </div>` +
      `<div class="detail-block">
         <div class="detail-block-title">Notes</div>
         <textarea class="detail-notes" id="detail-notes" rows="3" placeholder="Add a note about this session">${escapeHtml(activity.notes || "")}</textarea>
         <div class="detail-notes-actions"><button type="button" class="btn" id="detail-notes-save">Save notes</button><span class="sync-status" id="detail-notes-status"></span></div>
       </div>` +
      lapsHtml +
      mapHtml +
      refreshHtml;

    wireBack();
    wireDetailEditors(activity);
  }

  function wireDetailEditors(activity) {
    const section = document.getElementById("activity-detail-body");
    section.querySelectorAll(".rpe-chip").forEach((chip) => {
      chip.addEventListener("click", async () => {
        const raw = chip.dataset.rpe;
        const value = raw === "clear" ? null : Number(raw);
        section.querySelectorAll(".rpe-chip").forEach((c) => c.classList.remove("active"));
        if (value != null) chip.classList.add("active");
        try {
          const res = await saveActivityField(activity.id, { rpe: value });
          applyDetailUpdate(res.activity);
        } catch (err) {
          alert(err.message);
        }
      });
    });

    const saveBtn = document.getElementById("detail-notes-save");
    if (saveBtn) {
      // Explicit save button, not a blur handler (ISC-358): blur-only saves are
      // fragile and untestable under automation.
      saveBtn.addEventListener("click", async () => {
        const val = document.getElementById("detail-notes").value;
        const statusEl = document.getElementById("detail-notes-status");
        saveBtn.disabled = true;
        statusEl.textContent = "";
        try {
          const res = await saveActivityField(activity.id, { notes: val.length ? val : null });
          applyDetailUpdate(res.activity);
          statusEl.textContent = "Saved.";
        } catch (err) {
          statusEl.textContent = err.message;
        } finally {
          saveBtn.disabled = false;
        }
      });
    }

    const refreshBtn = document.getElementById("detail-refresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = "Refreshing...";
        try {
          const res = await api(`/api/activities/${activity.id}/detail?refresh=1`);
          renderActivityDetail(res.activity, res.detail, res.detail_error === true);
        } catch (err) {
          refreshBtn.disabled = false;
          refreshBtn.textContent = "Refresh from Garmin";
          alert(err.message);
        }
      });
    }
  }

  async function openActivityDetail(id) {
    showDetailSection();
    const cached = activitiesCache.find((a) => a.id === id);
    // Manual rows carry no Garmin detail: render instantly from the cached list
    // row, zero fetch (ISC-354).
    if (cached && cached.garmin_sourced === false) {
      renderActivityDetail(cached, null, false);
      return;
    }
    renderDetailLoading(cached || null);
    try {
      const res = await api(`/api/activities/${id}/detail`);
      renderActivityDetail(res.activity, res.detail, res.detail_error === true);
    } catch {
      const body = document.getElementById("activity-detail-body");
      body.innerHTML = backButtonHtml() + `<p class="detail-error">Could not load this activity.</p>`;
      wireBack();
    }
  }

  function handleRoute() {
    const m = /^#activity\/(\d+)$/.exec(location.hash);
    if (m) openActivityDetail(Number(m[1]));
    else closeActivityDetail();
  }
  window.addEventListener("hashchange", handleRoute);

  // --- Duplicates review (Activities view) -----------------------------
  //
  // A mustard banner over the list surfaces possible duplicate pairs (ISC-370,
  // ISC-373). Expanding it shows each pair side by side with differing fields
  // highlighted and three actions: keep both (dismiss), or merge keeping the
  // left or the right record. Merge always confirms and names the record that
  // dies, so there is no default destructive action (ISC-371). A disclosure
  // lists dismissed pairs with an undismiss control. Zero candidates and zero
  // dismissed shows nothing at all (ISC-372).

  let dupPanelOpen = false;

  async function loadDuplicates() {
    let data;
    try {
      data = await api("/api/duplicates");
    } catch {
      return;
    }
    renderDuplicates(data.candidates || [], data.dismissed || []);
  }

  function dupFieldVal(sum, key) {
    switch (key) {
      case "sport":
        return SPORT_LABELS[sum.sport] || sum.sport;
      case "date": {
        const clock = fmtClock(sum.start_time);
        return `${formatDate(sum.start_time)}${clock ? ` ${clock}` : ""}`;
      }
      case "duration":
        return formatDuration(sum.duration_s);
      case "distance":
        return sum.distance_m != null ? `${(sum.distance_m / 1000).toFixed(2)} km` : "none";
      case "source":
        return sum.source === "garmin" ? "Garmin" : "Manual";
      case "title":
        return sum.title || "(untitled)";
      default:
        return "";
    }
  }

  function renderDupPair(pair) {
    const fields = [
      ["Sport", "sport"],
      ["Date", "date"],
      ["Duration", "duration"],
      ["Distance", "distance"],
      ["Source", "source"],
      ["Title", "title"],
    ];
    const colA = [];
    const colB = [];
    fields.forEach(([label, key]) => {
      const va = dupFieldVal(pair.a, key);
      const vb = dupFieldVal(pair.b, key);
      const diff = va !== vb ? " diff" : "";
      colA.push(`<div class="dup-field${diff}"><span class="dup-k">${escapeHtml(label)}</span><span class="dup-v">${escapeHtml(va)}</span></div>`);
      colB.push(`<div class="dup-field${diff}"><span class="dup-k">${escapeHtml(label)}</span><span class="dup-v">${escapeHtml(vb)}</span></div>`);
    });
    return `
      <div class="dup-pair" data-a="${pair.a_id}" data-b="${pair.b_id}">
        <div class="dup-cols">
          <div class="dup-col"><div class="dup-col-title">Left, id ${pair.a_id}</div>${colA.join("")}</div>
          <div class="dup-col"><div class="dup-col-title">Right, id ${pair.b_id}</div>${colB.join("")}</div>
        </div>
        <div class="dup-actions">
          <button type="button" class="btn btn-secondary" data-dup="keepboth">Keep both</button>
          <button type="button" class="btn" data-dup="mergeleft">Merge, keep left</button>
          <button type="button" class="btn" data-dup="mergeright">Merge, keep right</button>
        </div>
      </div>`;
  }

  function renderDismissed(dismissed) {
    const rows = dismissed
      .map((p) => {
        const aLabel = p.a ? `${SPORT_LABELS[p.a.sport] || p.a.sport} ${formatDate(p.a.start_time)}` : `id ${p.a_id}`;
        const bLabel = p.b ? `${SPORT_LABELS[p.b.sport] || p.b.sport} ${formatDate(p.b.start_time)}` : `id ${p.b_id}`;
        return `<div class="dup-dismissed-row"><span>${escapeHtml(aLabel)} and ${escapeHtml(bLabel)}</span><button type="button" class="icon-btn dup-undismiss" data-undismiss="${p.a_id},${p.b_id}">Undismiss</button></div>`;
      })
      .join("");
    return `<details class="dup-dismissed"><summary>Dismissed pairs (${dismissed.length})</summary>${rows}</details>`;
  }

  function renderDuplicates(candidates, dismissed) {
    const slot = document.getElementById("dup-slot");
    if (!slot) return;
    if (candidates.length === 0 && dismissed.length === 0) {
      slot.innerHTML = "";
      dupPanelOpen = false;
      return;
    }
    const count = candidates.length;
    // The coral count pill is the badge (ISC-373); the label carries no number so
    // the two do not read as a run-together "11".
    const bannerLabel = count > 0 ? `possible duplicate${count === 1 ? "" : "s"}` : "Duplicate review";
    const countBadge = count > 0 ? `<span class="dup-count">${count}</span>` : "";
    const caret = dupPanelOpen ? "▾" : "▸";

    let html = `<button type="button" class="dup-banner" id="dup-banner">${countBadge}<span>${escapeHtml(bannerLabel)}</span><span class="dup-caret">${caret}</span></button>`;
    if (dupPanelOpen) {
      html += `<div class="dup-panel">`;
      if (count === 0) {
        html += `<p class="dup-allclear">No possible duplicates right now.</p>`;
      } else {
        html += candidates.map(renderDupPair).join("");
      }
      if (dismissed.length > 0) html += renderDismissed(dismissed);
      html += `</div>`;
    }
    slot.innerHTML = html;

    document.getElementById("dup-banner").addEventListener("click", () => {
      dupPanelOpen = !dupPanelOpen;
      renderDuplicates(candidates, dismissed);
    });
    if (dupPanelOpen) wireDupActions();
  }

  function wireDupActions() {
    const slot = document.getElementById("dup-slot");
    slot.querySelectorAll(".dup-pair").forEach((pairEl) => {
      const aId = Number(pairEl.dataset.a);
      const bId = Number(pairEl.dataset.b);
      pairEl.querySelectorAll("[data-dup]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const kind = btn.dataset.dup;
          try {
            if (kind === "keepboth") {
              await api("/api/duplicates/dismiss", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ aId, bId }),
              });
            } else {
              const keepId = kind === "mergeleft" ? aId : bId;
              const deleteId = kind === "mergeleft" ? bId : aId;
              if (!window.confirm(`Merge will permanently delete activity id ${deleteId} and keep id ${keepId}. This cannot be undone. Continue?`)) return;
              await api("/api/duplicates/merge", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ keepId, deleteId }),
              });
            }
            await loadActivities(); // refreshes the list and re-runs the scan
          } catch (err) {
            alert(err.message);
          }
        });
      });
    });

    slot.querySelectorAll("[data-undismiss]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const ids = btn.dataset.undismiss.split(",").map(Number);
        try {
          await api("/api/duplicates/undismiss", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ aId: ids[0], bId: ids[1] }),
          });
          await loadDuplicates();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  }

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

  // Which day the Nutrition tab is showing. null means today; a YYYY-MM-DD
  // string means a specific past/future day the user navigated to (ISC-460).
  let nutriViewDate = null;

  function nyToday() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  }
  function shiftNutriDate(deltaDays) {
    const base = nutriViewDate ?? nyToday();
    const d = new Date(`${base}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    const next = d.toISOString().slice(0, 10);
    // Do not navigate into the future past today.
    nutriViewDate = next >= nyToday() ? null : next;
    loadNutritionDay();
  }

  async function loadNutritionDay() {
    const date = nutriViewDate;
    const titleEl = document.getElementById("nutri-day-title");
    if (titleEl) titleEl.textContent = date == null ? "Today" : formatDate(`${date}T12:00:00Z`);
    const nextBtn = document.getElementById("nutri-next-day");
    if (nextBtn) nextBtn.disabled = date == null;
    let data;
    try {
      data = await api(`/api/nutrition${date == null ? "" : `?date=${date}`}`);
    } catch {
      return;
    }
    const totals = data.totals || { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    renderNutriRing(totals.kcal, data.target_kcal || 0);

    // Protein leads and carries a progress bar (ISC-445): the high-protein
    // goal is the one being chased, so it gets the visual weight. Carbs/fat
    // bars appear only when their targets are set (ISC-446).
    const macroBar = (label, got, target, emphasize) => {
      const pct = target ? Math.min(100, Math.round((got / target) * 100)) : null;
      const cls = pct == null ? "" : pct >= 100 ? " done" : pct >= 70 ? " close" : "";
      const bar =
        target != null
          ? `<div class="macro-bar${emphasize ? " macro-bar-hero" : ""}"><div class="macro-bar-fill${cls}" style="width:${pct}%"></div></div>`
          : "";
      const sub = target != null ? `${got} of ${target} g` : `${got} g`;
      return `<div class="macro-row${emphasize ? " macro-hero" : ""}"><div class="macro-label">${escapeHtml(label)}</div><div class="macro-sub">${escapeHtml(sub)}</div>${bar}</div>`;
    };
    document.getElementById("nutri-macros").innerHTML =
      macroBar("Protein", totals.protein_g, data.target_protein_g, true) +
      macroBar("Carbs", totals.carbs_g, data.target_carbs_g, false) +
      macroBar("Fat", totals.fat_g, data.target_fat_g, false);

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
    loadNutritionWeight();
    loadMacroGoalForm();
    loadNutritionHistory();
  }

  // Quick calorie log (ISC-457/467): a bare number, optionally protein, on the
  // day currently in view. Reuses the normal create path so it edits/deletes
  // like any entry.
  document.getElementById("quick-cal-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = document.getElementById("quick-cal-status");
    const kcalEl = document.getElementById("quick-cal-kcal");
    const proteinEl = document.getElementById("quick-cal-protein");
    const kcal = Number(kcalEl.value.trim());
    if (!Number.isInteger(kcal) || kcal <= 0) {
      status.textContent = "Enter a calorie number.";
      return;
    }
    const body = { quick: true, kcal };
    const p = proteinEl.value.trim();
    if (p !== "") body.protein_g = Number(p);
    if (nutriViewDate != null) body.logged_date = nutriViewDate;
    const btn = document.getElementById("quick-cal-btn");
    btn.disabled = true;
    status.textContent = "Logging...";
    try {
      await api("/api/nutrition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      kcalEl.value = "";
      proteinEl.value = "";
      status.textContent = "Logged.";
      await loadNutritionDay();
      loadNutritionHistory();
    } catch (err) {
      status.textContent = err && err.message ? err.message : "Could not log";
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("nutri-prev-day").addEventListener("click", () => shiftNutriDate(-1));
  document.getElementById("nutri-next-day").addEventListener("click", () => shiftNutriDate(1));

  // Calorie history chart (ISC-464/465): per-day bars against the calorie
  // target line; a bar turns green on days the protein goal was also met.
  async function loadNutritionHistory() {
    const svg = document.getElementById("nutri-history-svg");
    const empty = document.getElementById("nutri-history-empty");
    if (!svg || !empty) return;
    let data;
    try {
      data = await api("/api/nutrition/history?days=30");
    } catch {
      return;
    }
    const hist = data.history || [];
    const anyLogged = hist.some((d) => d.kcal > 0);
    if (!anyLogged) {
      svg.innerHTML = "";
      svg.setAttribute("hidden", "");
      empty.hidden = false;
      return;
    }
    svg.removeAttribute("hidden");
    empty.hidden = true;
    const W = 640;
    const H = 200;
    const padL = 40;
    const padR = 16;
    const padT = 16;
    const padB = 24;
    const targetKcal = data.target_kcal || 0;
    const targetProtein = data.target_protein_g || 0;
    const maxKcal = Math.max(targetKcal, ...hist.map((d) => d.kcal)) * 1.1 || 1;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const y = (v) => padT + plotH - (v / maxKcal) * plotH;
    const bw = plotW / hist.length;
    let out = "";
    // Calorie target line.
    if (targetKcal > 0) {
      const ty = y(targetKcal).toFixed(1);
      out += `<line x1="${padL}" y1="${ty}" x2="${W - padR}" y2="${ty}" stroke="#26221B" stroke-width="1.5" stroke-dasharray="4 3"></line>`;
    }
    hist.forEach((d, i) => {
      if (d.kcal <= 0) return;
      const x = padL + i * bw + bw * 0.15;
      const barW = bw * 0.7;
      const top = y(d.kcal);
      const proteinMet = targetProtein > 0 && d.protein_g >= targetProtein;
      const fill = proteinMet ? "#1F8A70" : "#E85F41";
      out += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${(padT + plotH - top).toFixed(1)}" fill="${fill}" rx="1.5"><title>${d.date}: ${d.kcal} kcal, ${d.protein_g} g protein</title></rect>`;
    });
    // First/last date labels.
    if (hist.length > 0) {
      out += `<text x="${padL}" y="${H - 6}" font-size="11" fill="#6E6657">${hist[0].date.slice(5)}</text>`;
      out += `<text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="11" fill="#6E6657">${hist[hist.length - 1].date.slice(5)}</text>`;
    }
    svg.innerHTML = out;
  }

  // Macro goals form (ISC-447): prefills from settings, saves via PATCH.
  // Carbs/fat empty = cleared (null); kcal/protein always have a value.
  async function loadMacroGoalForm() {
    try {
      const st = await api("/api/settings");
      document.getElementById("goal-kcal").value = st.nutrition_target_kcal ?? "";
      document.getElementById("goal-protein").value = st.nutrition_target_protein_g ?? "";
      document.getElementById("goal-carbs").value = st.nutrition_target_carbs_g ?? "";
      document.getElementById("goal-fat").value = st.nutrition_target_fat_g ?? "";
    } catch {}
  }

  document.getElementById("macro-goal-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = document.getElementById("macro-goal-status");
    const num = (id) => {
      const v = document.getElementById(id).value.trim();
      return v === "" ? null : Number(v);
    };
    const body = {
      nutrition_target_carbs_g: num("goal-carbs"),
      nutrition_target_fat_g: num("goal-fat"),
    };
    const kcal = num("goal-kcal");
    const protein = num("goal-protein");
    if (kcal != null) body.nutrition_target_kcal = kcal;
    if (protein != null) body.nutrition_target_protein_g = protein;
    const btn = document.getElementById("macro-goal-submit");
    btn.disabled = true;
    status.textContent = "Saving...";
    try {
      await api("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      status.textContent = "Saved.";
      loadNutritionDay();
      loadMacroGoalForm();
    } catch (err) {
      status.textContent = err && err.message ? err.message : "Could not save";
    } finally {
      btn.disabled = false;
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
    loadHeatmap();
    loadTrainingLoad();
    loadYoy();
    loadPowerCurve();
  }

  // --- Year over year chips (ISC-377) ----------------------------------
  async function loadYoy() {
    const row = document.getElementById("yoy-row");
    if (!row) return;
    let data;
    try {
      data = await api("/api/metrics/yoy");
    } catch {
      row.innerHTML = "";
      return;
    }
    const chip = (label, m, fmt) => {
      if (!m || m.insufficient_history) {
        return `<div class="yoy-chip"><div class="yoy-label">${label}</div><div class="yoy-na">Not enough history yet</div></div>`;
      }
      const delta = m.current - m.prior;
      const arrow = delta > 0 ? "&#9650;" : delta < 0 ? "&#9660;" : "&#8226;";
      const cls = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
      return `<div class="yoy-chip"><div class="yoy-label">${label}</div><div class="yoy-value">${fmt(m.current)}</div><div class="yoy-delta ${cls}">${arrow} ${fmt(Math.abs(delta))} vs last year (${fmt(m.prior)})</div></div>`;
    };
    row.innerHTML =
      chip("Sessions", data.sessions, (v) => String(Math.round(v))) +
      chip("Hours", data.hours, (v) => v.toFixed(1)) +
      chip("Distance", data.distance, (v) => `${(v / 1000).toFixed(1)} km`);
  }

  // --- Cycling power curve (ISC-378/379) -------------------------------
  async function loadPowerCurve() {
    const svg = document.getElementById("power-curve-svg");
    const empty = document.getElementById("power-curve-empty");
    if (!svg || !empty) return;
    let data;
    try {
      data = await api("/api/metrics/power-curve");
    } catch {
      return;
    }
    const show = (msg) => {
      svg.innerHTML = "";
      svg.setAttribute("hidden", "");
      empty.textContent = msg;
      empty.hidden = false;
    };
    const points = (data.points || []).filter((p) => p.watts != null);
    if (points.length === 0) {
      show(
        data.configured
          ? "No max efforts recorded in the last 90 days yet."
          : "Connect ZwiftPower to see your power curve.",
      );
      return;
    }
    svg.removeAttribute("hidden");
    empty.hidden = true;
    const width = 640;
    const height = 200;
    const padL = 40;
    const padR = 24;
    const padY = 30;
    const labels = { 15: "15s", 60: "1m", 300: "5m", 1200: "20m" };
    const ordered = [...points].sort((a, b) => a.duration_s - b.duration_s);
    const maxW = Math.max(...ordered.map((p) => p.watts));
    const x = (i) => padL + (i * (width - padL - padR)) / Math.max(1, ordered.length - 1);
    const y = (w) => height - padY - (w / maxW) * (height - padY * 2);
    const path = ordered.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.watts).toFixed(1)}`).join(" ");
    let out = `<path d="${path}" fill="none" stroke="#26221B" stroke-width="2.5" stroke-linejoin="round"/>`;
    ordered.forEach((p, i) => {
      const when = p.event_date ? ` on ${formatDate(p.event_date)}` : "";
      out += `<g><title>Best ${labels[p.duration_s] || p.duration_s + "s"}: ${p.watts} W${when}</title>`;
      out += `<circle cx="${x(i).toFixed(1)}" cy="${y(p.watts).toFixed(1)}" r="5" fill="#E85F41" stroke="#26221B" stroke-width="2"/>`;
      out += `<text x="${x(i).toFixed(1)}" y="${(y(p.watts) - 12).toFixed(1)}" text-anchor="middle" class="pc-watts">${p.watts} W</text>`;
      out += `<text x="${x(i).toFixed(1)}" y="${height - 8}" text-anchor="middle" class="pc-label">${labels[p.duration_s] || p.duration_s + "s"}</text></g>`;
    });
    svg.innerHTML = out;
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

  // --- Golf (ISC-411..415) ---------------------------------------------
  //
  // Rounds are plain activities with sport golf, synced from Garmin or added
  // manually. The score is user-entered (the Garmin SDK exposes no golf API,
  // probed 2026-07-23) and edits inline via a number input + PATCH.
  async function loadGolf() {
    const statsEl = document.getElementById("golf-stats");
    const listEl = document.getElementById("golf-rounds");
    const emptyEl = document.getElementById("golf-empty");
    if (!statsEl || !listEl || !emptyEl) return;
    let rounds = [];
    try {
      const data = await api("/api/golf/rounds");
      rounds = data.rounds || [];
    } catch {
      return;
    }
    if (rounds.length === 0) {
      statsEl.innerHTML = "";
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    const year = String(new Date().getFullYear());
    const thisYear = rounds.filter((r) => (r.date || "").startsWith(year));
    // Best/average compare like with like: full 18-hole rounds only. A
    // 2-hole score of 10 is not a "best round", and averaging 9-hole scores
    // into 18-hole ones understates everything.
    const fullRounds = rounds.filter((r) => r.holes_played === 18 && r.display_score != null);
    const scores = fullRounds.map((r) => r.display_score);
    const best = scores.length ? Math.min(...scores) : null;
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const last = rounds[0] && rounds[0].start_time ? formatDate(rounds[0].start_time) : "--";
    const chip = (label, value) =>
      `<div class="golf-chip"><div class="golf-chip-label">${label}</div><div class="golf-chip-value">${value}</div></div>`;
    statsEl.innerHTML =
      chip("Rounds this year", String(thisYear.length)) +
      chip("Best 18-hole", best == null ? "--" : String(best)) +
      chip("Avg 18-hole", avg == null ? "--" : String(avg)) +
      chip("Last round", last);
    listEl.innerHTML = rounds
      .map((r) => {
        const a = r.activity;
        const dur = a ? ` &middot; ${formatDuration(a.duration_s)}` : "";
        const km = a && a.distance_m != null ? ` &middot; ${(a.distance_m / 1000).toFixed(1)} km walked` : "";
        const holes = r.holes_played != null ? ` &middot; ${r.holes_played} holes` : "";
        const title = escapeHtml(r.course_name || (a && a.title) || "Round of golf");
        const when = r.start_time ? formatDate(r.start_time) : (r.date || "");
        let scoreHtml;
        if (r.display_score != null) {
          const src = r.score_source === "garmin" ? " title=\"Synced from Garmin Golf\"" : "";
          const editable = a ? ` data-golf-id="${a.id}"` : "";
          scoreHtml = `<button type="button" class="golf-score-chip"${editable}${src}${a ? "" : " disabled"}>${r.display_score}</button>`;
        } else if (a) {
          scoreHtml = `<button type="button" class="golf-score-chip golf-score-none" data-golf-id="${a.id}">Add score</button>`;
        } else {
          scoreHtml = "";
        }
        const clickable = a ? " clickable" : "";
        const chevron = a ? `<span class="activity-chevron" aria-hidden="true">&rsaquo;</span>` : "";
        return `
        <li class="activity-item golf-row${clickable}"${a ? ` data-activity-id="${a.id}" tabindex="0" role="button" aria-label="Open round detail"` : ""}>
          <div class="activity-icon">\u{26F3}</div>
          <div class="activity-main">
            <div class="activity-title">${title}</div>
            <div class="activity-meta">${when}${holes}${dur}${km}</div>
          </div>
          <div class="activity-actions">${scoreHtml}</div>
          ${chevron}
        </li>`;
      })
      .join("");
    listEl.querySelectorAll(".golf-score-chip[data-golf-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        startGolfScoreEdit(btn);
      });
    });
    listEl.querySelectorAll(".golf-row.clickable").forEach((row) => {
      const open = (e) => {
        if (e.target.closest(".activity-actions")) return;
        location.hash = `#activity/${row.dataset.activityId}`;
      };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") open(e);
      });
    });
  }

  function startGolfScoreEdit(btn) {
    const id = btn.dataset.golfId;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "18";
    input.max = "200";
    input.className = "golf-score-input";
    input.value = /^\d+$/.test(btn.textContent) ? btn.textContent : "";
    btn.replaceWith(input);
    input.focus();
    const save = async () => {
      const v = input.value.trim();
      const score = v === "" ? null : Number(v);
      try {
        await api(`/api/activities/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ golf_score: score }),
        });
      } catch (err) {
        showToast(err && err.message ? err.message : "Could not save score");
      }
      loadGolf();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
      if (e.key === "Escape") loadGolf();
    });
    input.addEventListener("blur", save);
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
    renderDumbbellWorkouts();
    renderStretchCards();
    renderSwimSets();
    await refreshStretchLogState();
  }

  // --- Swim sets -------------------------------------------------------

  function renderSwimSets() {
    const list = document.getElementById("swim-list");
    if (!list) return;
    list.innerHTML = SWIM_SETS.map((s, i) => {
      const phase = (label, text) =>
        `<div class="swim-phase"><span class="swim-phase-label">${escapeHtml(label)}</span>${escapeHtml(text)}</div>`;
      return `
      <div class="swim-card">
        <div class="swim-head">
          <div class="swim-name">${escapeHtml(s.name)}</div>
          <div class="swim-meta">
            <span class="swim-tag">${escapeHtml(String(s.minutes))} min</span>
            <span class="swim-tag">${escapeHtml(String(s.distance_m))} m</span>
            <span class="swim-tag">${escapeHtml(s.intensity)}</span>
          </div>
        </div>
        ${phase("Warmup", s.warmup)}
        ${phase("Drills", s.drills)}
        ${phase("Main set", s.main)}
        ${phase("Cooldown", s.cooldown)}
        <div class="swim-actions">
          <button type="button" class="btn swim-log-btn" data-swim="${i}">Log this set</button>
        </div>
      </div>`;
    }).join("");

    list.querySelectorAll("[data-swim]").forEach((btn) => {
      btn.addEventListener("click", () => logSwimSet(btn));
    });
  }

  // --- Dumbbell workouts ----------------------------------------------

  function renderDumbbellWorkouts() {
    const list = document.getElementById("dumbbell-list");
    if (!list) return;
    list.innerHTML = DUMBBELL_WORKOUTS.map((w, i) => {
      const rows = w.exercises.map((ex) =>
        `<div class="dumbbell-exercise">
          <div class="dumbbell-exercise-head">
            <span class="dumbbell-exercise-name">${escapeHtml(ex.name)}</span>
            <span class="dumbbell-exercise-dose">${escapeHtml(ex.dose)}</span>
          </div>
          <div class="dumbbell-exercise-cue">${escapeHtml(ex.cue)}</div>
        </div>`).join("");
      return `
      <div class="dumbbell-card">
        <div class="swim-head">
          <div class="swim-name">${escapeHtml(w.name)}</div>
          <div class="swim-meta">
            <span class="swim-tag">${escapeHtml(String(w.minutes))} min</span>
            <span class="swim-tag">${escapeHtml(w.focus)}</span>
          </div>
        </div>
        <div class="dumbbell-scheme">${escapeHtml(w.scheme)}</div>
        ${rows}
        <div class="swim-actions">
          <button type="button" class="btn dumbbell-log-btn" data-dumbbell="${i}">Log this workout</button>
        </div>
      </div>`;
    }).join("");

    list.querySelectorAll("[data-dumbbell]").forEach((btn) => {
      btn.addEventListener("click", () => logDumbbellWorkout(btn));
    });
  }

  // Logs a dumbbell workout as a strength activity, same POST + toast path as
  // swim sets. sport=strength is NOT G1-qualifying (ISC-479), so a logged
  // workout never inflates the week's swim/bike session count.
  async function logDumbbellWorkout(btn) {
    if (btn.disabled) return;
    const workout = DUMBBELL_WORKOUTS[Number(btn.dataset.dumbbell)];
    if (!workout) return;
    btn.disabled = true;
    try {
      const res = await api("/api/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sport: "strength",
          start_time: new Date().toISOString(),
          duration_s: workout.minutes * 60,
          title: `Dumbbells: ${workout.name}`,
          notes: `Dumbbell workout: ${workout.name}`,
        }),
      });
      const activity = res.activity;
      showToast(`Logged ${workout.name}.`, activity ? activity.id : null);
      loadDashboard();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // Logs a swim set as a swimming activity with the card's duration, through the
  // same POST + undo-toast path the quick-log presets use (ISC-362, ISC-363).
  async function logSwimSet(btn) {
    if (btn.disabled) return;
    const set = SWIM_SETS[Number(btn.dataset.swim)];
    if (!set) return;
    btn.disabled = true;
    try {
      const res = await api("/api/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sport: "swimming",
          start_time: new Date().toISOString(),
          duration_s: set.minutes * 60,
          distance_m: set.distance_m,
          title: set.name,
          notes: `Swim set: ${set.name}`,
        }),
      });
      const activity = res.activity;
      showToast(`Logged ${set.name}.`, activity ? activity.id : null);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
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
      // A direct load of #activity/ID renders straight into the detail (ISC-356);
      // any other (or no) hash lands on the dashboard.
      if (/^#activity\/\d+$/.test(location.hash)) handleRoute();
      else switchTab("dashboard");
    } catch {
      showLogin("");
    }
  }

  boot();
})();
