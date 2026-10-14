"use strict";

// ---- State and DOM helpers ----
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const DAY = 1440,
  STRIDE = DAY + 1; // one extra slot per curve for wrap-around differences
let data,
  engine,
  byId,
  playTimer = null;
let state = {
  minute: 720,
  day: "all",
  from: 2003,
  to: 2025,
  filters: {},
  mode: "overview",
  parent: "all",
  query: "",
  unit: "people",
  selected: "drive",
  limit: 40,
  following: false,
};
const dayNames = { all: "all days", weekday: "weekdays", weekend: "weekends" };
const anyLabels = {
  sex: "Any sex",
  age: "Any age",
  employment: "Any work status",
  kids: "With or without kids",
  where: "Anywhere",
  who: "With anyone or alone",
};
const SMALL_SAMPLE = 30;

function allFilters() {
  return [...data.personFilters, ...data.episodeFilters];
}

function yearsLabel() {
  return state.from === state.to ? String(state.from) : `${state.from}–${state.to}`;
}

// ---- Diary engine: decode once, then recompute curves when filters change ----
async function inflate(base64) {
  let compressed;
  try {
    compressed = await (await fetch("data:application/octet-stream;base64," + base64)).blob();
  } catch {
    compressed = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))]);
  }
  const stream = compressed.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

// Decode the packed columns, then regroup episodes by activity so each activity's curve is
// built from one contiguous run of episodes (cache-friendly and easy to subset).
function buildEngine(buffer) {
  const types = { f: Float32Array, B: Uint8Array, H: Uint16Array };
  const cols = {};
  for (const s of data.layout) cols[s.name] = new types[s.type](buffer, s.offset, s.length);

  const keys = [...data.categories.map((c) => c.id), ...data.details.map((d) => d.id)];
  const keyIndex = Object.fromEntries(keys.map((k, i) => [k, i]));
  keyIndex.context = keys.length;
  const nCategories = data.categories.length;
  const children = data.categories.map((c) =>
    data.details.filter((d) => d.parent === c.id).map((d) => keyIndex[d.id]),
  );

  // Each code maps to a detail key, or to the "Driving · …" key when the person was driving.
  const driving = data.episodeFilters[0].options.indexOf("Driving");
  const codeKey = data.codes.map((c) => [`${c.parent}_${c.code}`, `drive_${c.code}`]);
  const nEpisodes = cols.duration.length;
  const episodeKey = new Uint16Array(nEpisodes);
  const keyStart = new Uint32Array(keys.length + 1);
  for (let e = 0; e < nEpisodes; e++) {
    const k = keyIndex[codeKey[cols.code[e]][cols.where[e] === driving ? 1 : 0]];
    episodeKey[e] = k;
    keyStart[k + 1]++;
  }
  for (let k = 0; k < keys.length; k++) keyStart[k + 1] += keyStart[k];

  const sorted = {
    diary: new Uint32Array(nEpisodes),
    start: new Uint16Array(nEpisodes),
    duration: new Uint16Array(nEpisodes),
    where: new Uint8Array(nEpisodes),
    who: new Uint8Array(nEpisodes),
  };
  const cursor = keyStart.slice(0, keys.length);
  for (let i = 0, e = 0; i < cols.weight.length; i++) {
    let start = 240; // diaries begin at 4 AM
    for (let n = 0; n < cols.episodeCount[i]; n++, e++) {
      const j = cursor[episodeKey[e]]++;
      sorted.diary[j] = i;
      sorted.start[j] = start;
      sorted.duration[j] = cols.duration[e];
      sorted.where[j] = cols.where[e];
      sorted.who[j] = cols.who[e];
      start = (start + cols.duration[e]) % DAY;
    }
  }

  const nYears = data.years.length,
    nWhere = data.episodeFilters[0].options.length,
    nWho = data.episodeFilters[1].options.length;
  return {
    weight: Float64Array.from(cols.weight),
    year: cols.year.slice(),
    attrs: cols.attrs.slice(),
    ...sorted,
    keys,
    keyIndex,
    nCategories,
    children,
    keyStart,
    nWhere,
    nWho,
    diaryState: new Uint8Array(cols.weight.length), // 0 excluded, 1 other years, 2 selected years
    // One row per activity key, plus a last row for "everyone in this context" (all activities
    // that match the location/company filters).
    weights: new Float64Array((keys.length + 1) * STRIDE),
    counts: new Int32Array((keys.length + 1) * STRIDE),
    whereWeights: new Float64Array(nWhere * STRIDE),
    whoWeights: new Float64Array((nWho + 1) * STRIDE), // last row: company not recorded
    yearWeights: new Float64Array(nYears * STRIDE),
    yearCounts: new Int32Array(nYears * STRIDE),
    yearPopulation: new Float64Array(nYears),
    yearSample: new Int32Array(nYears),
    population: 0,
    sample: 0,
    days: 0,
  };
}

// Difference-array updates for an episode covering [start, end) minutes, where end may pass
// midnight. Separate float and integer versions keep each one monomorphic, and therefore fast.
// These hot helpers are const bindings rather than global functions, which is faster in
// sandboxes (such as the Node test harness) that intercept global-object lookups.
const addWeight = (arr, base, start, end, w) => {
  arr[base + start] += w;
  if (end <= DAY) {
    arr[base + end] -= w;
  } else {
    arr[base + DAY] -= w;
    arr[base] += w;
    arr[base + end - DAY] -= w;
  }
};

const addCount = (arr, base, start, end) => {
  arr[base + start]++;
  if (end <= DAY) {
    arr[base + end]--;
  } else {
    arr[base + DAY]--;
    arr[base]++;
    arr[base + end - DAY]--;
  }
};

const accumulate = (arr, rows) => {
  for (let r = 0; r < rows; r++) {
    let running = 0;
    for (let m = 0, base = r * STRIDE; m < DAY; m++) {
      running += arr[base + m];
      arr[base + m] = running;
    }
  }
};

const addRow = (arr, target, source) => {
  for (let m = 0; m < STRIDE; m++) arr[target * STRIDE + m] += arr[source * STRIDE + m];
};

// Location/company filters apply to activities, not people, so the summary changes with them:
// without them it shows Sleeping, Awake, and Driving; with them, everyone in that context
// (for example, everyone at a restaurant) and Driving. Every number follows the same filters.
function contextFiltered() {
  return state.filters.where !== undefined || state.filters.who !== undefined;
}

function summaryIds() {
  return contextFiltered() ? ["context", "drive"] : ["sleep", "awake", "drive"];
}

function syncContextSelection() {
  const label = data.episodeFilters
    .filter((f) => state.filters[f.id] !== undefined)
    .map((f) => (f.id === "who" ? "With: " : "") + f.options[state.filters[f.id]])
    .join(" · ");
  byId.context.label = label || "In this context";
  if (contextFiltered() && state.selected === "awake") state.selected = "context";
  if (!contextFiltered() && state.selected === "context") state.selected = "awake";
}

// Recompute every curve for the current years, day type, and filters.
function compute() {
  syncContextSelection();
  const E = engine;
  const { weight, diaryState, diary, start, duration, where, who, keyStart, nWho } = E;
  const { weights, counts, whereWeights, whoWeights } = E;
  const { yearWeights, yearCounts, yearPopulation, yearSample } = E;
  for (const arr of [
    weights,
    counts,
    whereWeights,
    whoWeights,
    yearWeights,
    yearCounts,
    yearPopulation,
    yearSample,
  ])
    arr.fill(0);

  // 1. Which diaries match the day type and person filters (one mask test on packed bits).
  const from = state.from - data.firstYear,
    to = state.to - data.firstYear;
  let mask = 0,
    match = 0;
  for (const f of data.personFilters)
    if (state.filters[f.id] !== undefined) {
      mask |= ((1 << f.bits) - 1) << f.shift;
      match |= state.filters[f.id] << f.shift;
    }
  if (state.day !== "all") {
    mask |= 1;
    match |= state.day === "weekend" ? 1 : 0;
  }
  let population = 0,
    sample = 0;
  for (let i = 0; i < weight.length; i++) {
    if ((E.attrs[i] & mask) !== match) {
      diaryState[i] = 0;
      continue;
    }
    const y = E.year[i],
      inRange = y >= from && y <= to;
    diaryState[i] = inRange ? 2 : 1;
    yearPopulation[y] += weight[i];
    yearSample[y]++;
    if (inRange) {
      population += weight[i];
      sample++;
    }
  }

  // 2. Detailed activity curves, then categories as the sum of their detailed rows.
  const whereOnly = state.filters.where ?? -1;
  const whoBit = state.filters.who === undefined ? 0 : 1 << state.filters.who;
  const passes = (e) => (whereOnly < 0 || where[e] === whereOnly) && (!whoBit || who[e] & whoBit);
  const filtered = contextFiltered();
  for (let k = E.nCategories; k < E.keys.length; k++) {
    const base = k * STRIDE;
    for (let e = keyStart[k]; e < keyStart[k + 1]; e++) {
      const i = diary[e];
      if (diaryState[i] !== 2 || (filtered && !passes(e))) continue;
      const end = start[e] + duration[e];
      addWeight(weights, base, start[e], end, weight[i]);
      addCount(counts, base, start[e], end);
    }
  }
  E.children.forEach((rows, p) => {
    for (const k of rows) {
      addRow(weights, p, k);
      addRow(counts, p, k);
    }
  });

  // 3. With location/company filters, "context" is everyone doing anything in that context.
  const context = E.keyIndex.context;
  if (filtered)
    for (let p = 0; p < E.nCategories; p++) {
      addRow(weights, context, p);
      addRow(counts, context, p);
    }

  // 4. The selected activity: where, with whom, and its curve in every survey year.
  // "Awake" uses sleep's episodes (it is only offered without context filters).
  const selected = E.keyIndex[state.selected === "awake" ? "sleep" : state.selected];
  let rows = [selected];
  if (selected === context) rows = E.keys.map((_, k) => k).slice(E.nCategories);
  else if (selected < E.nCategories) rows = E.children[selected];
  for (const k of rows)
    for (let e = keyStart[k]; e < keyStart[k + 1]; e++) {
      const i = diary[e];
      if (!diaryState[i]) continue;
      const ok = !filtered || passes(e);
      if (!ok) continue;
      const end = start[e] + duration[e],
        w = weight[i],
        y = E.year[i];
      addWeight(yearWeights, y * STRIDE, start[e], end, w);
      addCount(yearCounts, y * STRIDE, start[e], end);
      if (diaryState[i] !== 2) continue;
      addWeight(whereWeights, where[e] * STRIDE, start[e], end, w);
      const company = who[e];
      if (!company) addWeight(whoWeights, nWho * STRIDE, start[e], end, w);
      for (let b = 0; b < nWho; b++)
        if (company & (1 << b)) addWeight(whoWeights, b * STRIDE, start[e], end, w);
    }

  accumulate(weights, E.keys.length + 1);
  accumulate(counts, E.keys.length + 1);
  accumulate(whereWeights, E.nWhere);
  accumulate(whoWeights, nWho + 1);
  accumulate(yearWeights, data.years.length);
  accumulate(yearCounts, data.years.length);

  E.days = 0;
  for (let y = from; y <= to; y++) E.days += data.years[y].days[state.day];
  E.population = population / E.days;
  E.sample = sample;
}

// ---- Data lookup ----
function value(id, m = state.minute) {
  const E = engine;
  if (id === "awake") {
    const sleep = value("sleep", m);
    return { count: Math.max(0, E.population - sleep.count), n: E.sample - sleep.n };
  }
  const base = E.keyIndex[id] * STRIDE + m;
  return { count: Math.max(0, E.weights[base]) / E.days, n: E.counts[base] };
}

// ---- Formatting ----
function compact(n) {
  n = Math.round(n);
  if (n === 0) return "0";
  if (n < 1000) return "<1K";
  if (n < 1e6) return Math.round(n / 1000).toLocaleString() + "K";
  return (n / 1e6).toFixed(1) + "M";
}

function percent(n) {
  return engine.population ? (n / engine.population) * 100 : 0;
}

function pct(n) {
  const p = percent(n);
  return p > 0 && p < 0.1 ? "<0.1%" : p.toFixed(1) + "%";
}

function shareText(p) {
  return p > 0 && p < 0.001 ? "<0.1%" : (p * 100).toFixed(1) + "%";
}

function time(m) {
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function isoTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function escapeHTML(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function filterSummary() {
  return allFilters()
    .filter((f) => state.filters[f.id] !== undefined)
    .map((f) => f.options[state.filters[f.id]])
    .join(" · ");
}

// ---- URL state and time control ----
function saveState() {
  const p = new URLSearchParams({
    time: isoTime(state.minute),
    day: state.day,
    mode: state.mode,
    category: state.parent,
    activity: state.selected,
    unit: state.unit,
  });
  for (const f of allFilters())
    if (state.filters[f.id] !== undefined) p.set(f.id, state.filters[f.id]);
  if (state.query) p.set("q", state.query);
  try {
    history.replaceState(null, "", "#" + p);
  } catch {}
}

function loadState() {
  const p = new URLSearchParams(location.hash.slice(1));
  const clock = p.get("time");
  if (
    /^\d{2}:\d{2}$/.test(clock || "") &&
    Number(clock.slice(0, 2)) < 24 &&
    Number(clock.slice(3)) < 60
  )
    state.minute = Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  else {
    const n = new Date();
    state.minute = n.getHours() * 60 + n.getMinutes();
    state.following = true;
  }
  const first = data.years[0].year,
    last = data.years.at(-1).year;
  state.from = first;
  state.to = last;
  if (dayNames[p.get("day")]) state.day = p.get("day");
  if (["overview", "detail"].includes(p.get("mode"))) state.mode = p.get("mode");
  if (["people", "percent"].includes(p.get("unit"))) state.unit = p.get("unit");
  if (data.categories.some((a) => a.id === p.get("category"))) state.parent = p.get("category");
  if (byId[p.get("activity")]) state.selected = p.get("activity");
  for (const f of allFilters()) {
    const v = p.get(f.id);
    const valid = /^\d+$/.test(v || "") && +v < f.options.length;
    if (valid && !(f.id === "where" && +v === 0)) state.filters[f.id] = +v;
  }
  state.query = p.get("q") || "";
}

function stop() {
  if (playTimer !== null) clearInterval(playTimer);
  playTimer = null;
  $("#play").textContent = "▶";
  $("#play").setAttribute("aria-pressed", "false");
  $("#play").setAttribute("aria-label", "Play the day");
}

function changeMinute(m, following = false, persist = true) {
  state.minute = ((Math.round(m) % DAY) + DAY) % DAY;
  state.following = following;
  render();
  if (persist) saveState();
}

function now() {
  stop();
  const d = new Date();
  changeMinute(d.getHours() * 60 + d.getMinutes(), true);
}

// Filters, years, day type, and the selected activity all need a new pass over the diaries.
function recompute() {
  compute();
  render();
  saveState();
}

// ---- Rendering ----
function renderClock() {
  const [clock, meridiem] = time(state.minute).split(" ");
  $("#clock").textContent = clock;
  $("#meridiem").textContent = meridiem;
  $("#time-input").value = isoTime(state.minute);
  $("#timeline").value = state.minute;
  $("#timeline").setAttribute("aria-valuetext", time(state.minute));
  $("#clock-note").textContent = state.following ? "Your clock · typical day" : "Local time of day";
  $("#data-badge").textContent = `${engine.sample.toLocaleString()} diaries · ${yearsLabel()}`;
  $$("[data-day]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.day === state.day));
}

function renderFilters() {
  for (const f of allFilters()) $(`[data-filter="${f.id}"]`).value = state.filters[f.id] ?? "";
  $("#reset-filters").hidden = !Object.keys(state.filters).length;
}

function renderSummary() {
  const ids = summaryIds();
  $("#summary").classList.toggle("two", ids.length === 2);
  $("#summary").innerHTML = ids
    .map((id) => {
      const a = byId[id],
        v = value(id);
      return `
        <button class="summary-card" data-activity="${id}" aria-pressed="${state.selected === id}" style="--color:${a.color}">
          <span class="summary-label"><i class="dot"></i>${a.label}</span>
          <span class="summary-value">${compact(v.count)}</span>
          <span class="summary-percent">${pct(v.count)} of these people</span>
        </button>`;
    })
    .join("");
}

function keywords(a) {
  const extra = {
    sleep: "asleep naps",
    sleep_010101: "asleep naps napping",
    drive: "car driving commute commuting",
    household_020201: "cooking breakfast lunch dinner coffee",
    leisure_120303: "tv television watching",
    leisure_120307: "gaming video games",
    leisure_120308: "internet social media computer",
  };
  return [
    a.label,
    a.parent ? byId[a.parent].label : "",
    a.code || "",
    extra[a.id] || "",
    a.parent === "drive" ? "car commute commuting" : "",
  ]
    .join(" ")
    .toLowerCase();
}

function matching() {
  const detailed = state.mode === "detail" || state.query.trim() || state.parent !== "all";
  let list = (detailed ? data.details : data.categories).filter(
    (a) =>
      (state.parent === "all" || a.parent === state.parent || a.id === state.parent) &&
      keywords(a).includes(state.query.trim().toLowerCase()),
  );
  return list
    .map((a) => ({ ...a, ...value(a.id) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function activityRow(a) {
  const people = compact(a.count),
    percentText = pct(a.count);
  const sampleMark =
    a.n < SMALL_SAMPLE ? '<i class="sample-mark" aria-label="Small sample"></i>' : "";
  return `
    <button class="activity-row" data-activity="${a.id}" aria-pressed="${state.selected === a.id}"
      title="${escapeHTML(a.label)} — ${a.n.toLocaleString()} observed diaries" style="--color:${a.color}">
      <span class="row-name"><i class="dot"></i><span class="row-label">${escapeHTML(a.label)}</span></span>
      <span class="row-count">${state.unit === "people" ? people : percentText}${sampleMark}</span>
      <span class="row-percent">${state.unit === "people" ? percentText : people}</span>
    </button>`;
}

function renderList() {
  const list = matching();
  const detailed = Boolean(state.mode === "detail" || state.query.trim() || state.parent !== "all");
  $$("[data-mode]").forEach((b) =>
    b.setAttribute("aria-pressed", b.dataset.mode === (detailed ? "detail" : "overview")),
  );
  $("#category-filter").value = state.parent;
  $("#result-count").textContent =
    `${list.length} ${detailed ? "detailed activities" : "categories"}`;
  $("#unit").innerHTML =
    (state.unit === "people" ? "EST. PEOPLE" : "EST. SHARE") + ' <span aria-hidden="true">⇄</span>';
  $("#secondary-unit").textContent = state.unit === "people" ? "%" : "PEOPLE";
  const visible = list.slice(0, state.limit);
  $("#activity-list").innerHTML = visible.length
    ? visible.map(activityRow).join("")
    : '<div class="empty">No matching activities. Try a broader term or choose “All activities”.</div>';
  $("#load-more").hidden = list.length <= state.limit;
  $("#load-more").textContent = `Show ${Math.min(40, list.length - state.limit)} more activities ↓`;
  $("#list-note").textContent = detailed
    ? "Detailed rows split driving from other activity contexts. Amber dot = fewer than 30 observed diaries."
    : "17 categories cover these people. Select one to explore its day or see its detailed activities.";
}

function detailDescription(a) {
  if (!a.parent) return a.description;
  const code = data.codes.find((c) => c.code === a.code);
  const base = `ATUS ${a.code}${code.includes ? ` (combines ${code.includes})` : ""}`;
  if (a.parent === "drive")
    return `${base}. Reported as a car, truck, or motorcycle driver during this activity. The code describes the activity’s purpose or context. A subset of Driving.`;
  return `${base}. Reported as the main activity, excluding time recorded as driving. A subset of ${byId[a.parent].label.toLowerCase()}.`;
}

function trend(id) {
  const values = [];
  let max = 0,
    peak = 0;
  for (let m = 0; m < DAY; m++) {
    const n = value(id, m).count;
    if (n > max) {
      max = n;
      peak = m;
    }
    values.push(n);
  }
  const w = 500,
    h = 145;
  const points = [];
  for (let m = 0; m < DAY; m += 4)
    points.push(
      `${((m / 1439) * w).toFixed(2)},${(h - (values[m] / (max || 1)) * (h - 4)).toFixed(2)}`,
    );
  points.push(`${w},${h - (values[1439] / (max || 1)) * (h - 4)}`);
  return {
    max,
    peak,
    points: points.join(" "),
    x: (state.minute / 1439) * w,
    y: h - (values[state.minute] / (max || 1)) * (h - 4),
  };
}

function trendChart(a, t) {
  const label =
    `${a.label} across 24 hours; peak of approximately ${compact(t.max)} at ${time(t.peak)}. ` +
    "Use the time slider to change the selected minute.";
  return `
    <svg id="trend-chart" class="trend-chart" viewBox="0 0 500 150" preserveAspectRatio="none"
      role="img" aria-label="${escapeHTML(label)}">
      <line class="chart-axis" x1="0" x2="500" y1="145" y2="145"/>
      <line class="chart-grid" x1="0" x2="500" y1="72" y2="72" stroke-dasharray="3 4"/>
      <polygon points="0,145 ${t.points} 500,145" fill="${a.color}" opacity=".14"/>
      <polyline points="${t.points}" fill="none" stroke="${a.color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <line class="chart-cursor" x1="${t.x}" x2="${t.x}" y1="0" y2="145" stroke-width="1" stroke-dasharray="3 4"/>
      <circle cx="${t.x}" cy="${t.y}" r="3.5" fill="${a.color}"/>
    </svg>`;
}

// Where people doing the selected activity are, and who they are with, at this minute.
function breakdown(kind) {
  const E = engine,
    m = state.minute;
  const total = Math.max(0, E.weights[E.keyIndex[state.selected] * STRIDE + m]);
  if (!total) return [];
  let rows;
  if (kind === "where") {
    const [missing, ...places] = data.episodeFilters[0].options;
    rows = [...places, missing].map((label, i) => ({
      label: i === places.length ? "Not recorded" : label,
      share: Math.max(0, E.whereWeights[((i + 1) % E.nWhere) * STRIDE + m]) / total,
    }));
  } else {
    rows = [...data.episodeFilters[1].options, "Not recorded"].map((label, i) => ({
      label,
      share: Math.max(0, E.whoWeights[i * STRIDE + m]) / total,
    }));
  }
  const missing = rows.pop();
  const recorded = rows.filter((r) => r.share >= 0.0005).sort((a, b) => b.share - a.share);
  return missing.share >= 0.0005 ? [...recorded, missing] : recorded;
}

function breakdownBlock(kind, a) {
  const rows = breakdown(kind);
  if (!rows.length) return "";
  const title = kind === "where" ? "WHERE THEY ARE" : "WHO THEY’RE WITH";
  const note =
    kind === "who"
      ? '<p class="breakdown-note">People can be with several groups at once.</p>'
      : "";
  const items = rows
    .slice(0, 6)
    .map(
      (r) => `
        <div class="breakdown-row${r.label === "Not recorded" ? " muted" : ""}">
          <span class="breakdown-label">${escapeHTML(r.label)}</span>
          <span class="breakdown-bar"><i style="width:${Math.min(100, r.share * 100).toFixed(1)}%;background:${a.color}"></i></span>
          <span class="breakdown-value">${shareText(r.share)}</span>
        </div>`,
    )
    .join("");
  return `
    <div class="breakdown">
      <div class="trend-heading"><span>${title}</span><span>${time(state.minute)}</span></div>
      ${items}
      ${note}
    </div>`;
}

// Share of these people doing the activity at this minute, in every survey year.
function yearSeries() {
  const E = engine,
    m = state.minute,
    awake = state.selected === "awake";
  return data.years.map((y, i) => {
    const pop = E.yearPopulation[i],
      w = Math.max(0, E.yearWeights[i * STRIDE + m]),
      n = E.yearCounts[i * STRIDE + m];
    const p = pop ? w / pop : 0;
    return {
      year: y.year,
      share: awake ? (pop ? 1 - p : 0) : p,
      n: awake ? E.yearSample[i] - n : n,
      empty: !E.yearSample[i],
    };
  });
}

function yearsChart(a) {
  const series = yearSeries();
  const peak = Math.max(...series.map((s) => s.share)),
    max = peak || 1;
  const w = 500,
    h = 90,
    gap = 3,
    bar = (w - gap * (series.length - 1)) / series.length;
  const bars = series
    .map((s, i) => {
      const height = s.empty ? 0 : Math.max(1, (s.share / max) * (h - 4));
      const cls = `year-bar${s.n < SMALL_SAMPLE ? " small" : ""}`;
      const label = s.empty
        ? `${s.year}: no diaries match these filters`
        : `${s.year}: ${shareText(s.share)} (${s.n.toLocaleString()} diaries)${s.year === 2020 ? " · partial year" : ""}`;
      return `<rect class="${cls}" data-year="${s.year}" x="${(i * (bar + gap)).toFixed(1)}" y="${(h - height).toFixed(1)}" width="${bar.toFixed(1)}" height="${height.toFixed(1)}" fill="${a.color}"><title>${label}</title></rect>`;
    })
    .join("");
  const first = series[0].year,
    last = series.at(-1).year;
  return `
    <div class="years">
      <div class="trend-heading"><span>ACROSS THE YEARS · ${time(state.minute)}</span><span>${peak ? `Peak: ${shareText(peak)} of these people` : "No observations"}</span></div>
      <svg id="years-chart" class="years-chart" viewBox="0 0 500 90" preserveAspectRatio="none" role="img"
        aria-label="${escapeHTML(a.label)}: share of these people at ${time(state.minute)} in each year from ${first} to ${last}.">${bars}</svg>
      <div class="trend-ticks"><span>${first}</span><span>${last}</span></div>
      <p class="breakdown-note">Faded bars have fewer than 30 diaries.</p>
    </div>`;
}

function sampleStatus(v) {
  if (v.n === 0)
    return "No diaries recorded this at this minute. This does not mean nobody was doing it.";
  if (v.n < SMALL_SAMPLE)
    return "Small sample: fewer than 30 observed diaries. Treat this estimate cautiously.";
  return "Weighted survey estimate; no confidence interval calculated.";
}

function renderDetail() {
  const a = byId[state.selected],
    v = value(a.id),
    t = trend(a.id);
  const scope = a.parent ? byId[a.parent].label : "OVERVIEW";
  const group = a.parent || a.id;
  const small = v.n < SMALL_SAMPLE;
  const derived = a.id === "awake" || a.id === "context";
  const action = derived
    ? '<button id="awake-about" class="outline-button">About this estimate ↗</button>'
    : `<button id="drill-down" class="outline-button" data-group="${group}">${a.parent ? "More in this category" : "Explore detailed activities"} ↗</button>`;
  // Skip a breakdown that a filter already fixes (e.g. "At home" is 100% at home).
  const context =
    a.id === "awake"
      ? ""
      : ["where", "who"]
          .filter((kind) => state.filters[kind] === undefined)
          .map((kind) => breakdownBlock(kind, a))
          .join("");
  $("#detail-content").innerHTML = `
    <div class="detail-heading" style="--color:${a.color}"><i class="dot"></i>${escapeHTML(scope)}${a.code ? " · " + a.code : ""}</div>
    <h2>${escapeHTML(a.label)}</h2>
    <div class="detail-value">${compact(v.count)} <small>people, est.</small></div>
    <p class="detail-sub">${pct(v.count)} · ${time(state.minute)} · ${dayNames[state.day]} · ${yearsLabel()}</p>
    <div class="trend-heading"><span>ACROSS THE DAY</span><span>Scale: 0–${compact(t.max)} people</span></div>
    ${trendChart(a, t)}
    <div class="trend-ticks"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>12 AM</span></div>
    <div class="detail-stats">
      <div>
        <span>Highest estimate at</span>
        <strong>${t.max ? time(t.peak) : "No observations"}</strong>
        <span>${t.max ? "≈ " + compact(t.max) + " people" : "in this selection"}</span>
      </div>
      <div>
        <span>Diaries at this minute</span>
        <strong>${v.n.toLocaleString()} <span style="display:inline">/ ${engine.sample.toLocaleString()}</span></strong>
        <span>${yearsLabel()} · ${dayNames[state.day]}</span>
      </div>
    </div>
    <p class="sample-status ${small ? "small-sample" : ""}">${sampleStatus(v)}</p>
    ${context}
    ${yearsChart(a)}
    <p class="detail-definition">${escapeHTML(detailDescription(a))}</p>
    <div class="detail-actions">
      ${action}
      <button id="download-trend" class="text-button">Download day ↓</button>
    </div>`;
  $("#trend-chart").addEventListener("pointerdown", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    stop();
    changeMinute(Math.min(1439, Math.max(0, ((e.clientX - r.left) / r.width) * 1439)));
  });
  if (!derived)
    $("#drill-down").addEventListener("click", () => {
      state.mode = "detail";
      state.parent = group;
      state.query = "";
      state.limit = 40;
      $("#search").value = "";
      renderList();
      saveState();
      $("#activity-browser").scrollIntoView({ block: "start", behavior: "smooth" });
    });
  else $("#awake-about").addEventListener("click", showAbout);
  $("#download-trend").addEventListener("click", () => download("trend"));
}

function render() {
  if (!engine) return;
  renderClock();
  renderFilters();
  renderSummary();
  renderList();
  renderDetail();
}

function selectActivity(id) {
  if (!byId[id]) return;
  stop();
  state.selected = id;
  recompute();
  if (window.matchMedia("(max-width:700px)").matches)
    $("#detail-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- Dialogs, toasts, downloads ----
function showAbout() {
  stop();
  $("#about-dialog").showModal();
}

function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  setTimeout(() => ($("#toast").hidden = true), 3000);
}

function csvCell(s) {
  return '"' + String(s).replaceAll('"', '""') + '"';
}

function download(type) {
  const rows = [
    "survey_years,day_type,filters,local_time,activity_id,activity,estimated_people,percent,unweighted_diaries,category_type",
  ];
  const all = [...data.categories, ...data.details].map((a) => a.id);
  const ids =
    type === "trend"
      ? [state.selected]
      : [...all, summaryIds()[0] === "context" ? "context" : "awake"];
  const minutes = type === "trend" ? Array.from({ length: DAY }, (_, i) => i) : [state.minute];
  const filters = csvCell(filterSummary() || "none");
  for (const m of minutes)
    for (const id of ids) {
      const a = byId[id],
        v = value(id, m);
      rows.push(
        [
          yearsLabel(),
          state.day,
          filters,
          isoTime(m),
          id,
          csvCell(a.label),
          Math.round(v.count),
          percent(v.count).toFixed(6),
          v.n,
          a.id === "awake"
            ? "derived_complement"
            : a.id === "context"
              ? "context_total"
              : a.parent
                ? "detail_subset"
                : "main",
        ].join(","),
      );
    }
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  const suffix = type === "trend" ? state.selected : isoTime(state.minute).replace(":", "");
  a.download = `american-minute-${state.from}-${state.to}-${state.day}-${suffix}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(
    type === "trend"
      ? "Downloaded 1,440 minutes for this activity."
      : "Downloaded this minute, with category and sample details.",
  );
}

// ---- Startup ----
function buildControls() {
  const select = (f) => `
    <label class="filter">
      <span class="sr-only">${escapeHTML(f.label)}</span>
      <select data-filter="${f.id}">
        <option value="">${escapeHTML(anyLabels[f.id] || "Any")}</option>
        ${f.options.map((o, i) => `<option value="${i}">${escapeHTML(o)}</option>`).join("")}
      </select>
    </label>`;
  $("#person-filters").innerHTML = data.personFilters.map(select).join("");
  // "Location not recorded" is not a useful filter choice.
  $("#episode-filters").innerHTML = data.episodeFilters.map(select).join("");
  $('[data-filter="where"] option[value="0"]')?.remove();
  $("#category-filter").innerHTML =
    '<option value="all">All activities</option>' +
    data.categories.map((a) => `<option value="${a.id}">${escapeHTML(a.label)}</option>`).join("");
}

async function init() {
  try {
    data = window.AMERICAN_MINUTE_DATA;
    if (!data || data.schemaVersion !== 3) throw Error("Survey data unavailable");
    $("#loading").textContent = `Unpacking ${data.diaries.toLocaleString()} diaries…`;
    byId = Object.fromEntries(data.categories.map((a) => [a.id, a]));
    for (const a of data.details) {
      a.color = byId[a.parent].color;
      byId[a.id] = a;
    }
    byId.awake = {
      id: "awake",
      label: "Awake",
      color: "#9ca86d",
      description:
        "These people minus those classified as sleeping, including unclassified time. A useful complement, not a direct measurement of wakefulness.",
    };
    byId.context = {
      id: "context",
      label: "In this context",
      color: "#8f9c94",
      description:
        "Everyone doing any activity that matches the location and company filters at this minute. Sleeping, grooming, and private activities are excluded because BLS doesn’t record where or with whom they happen.",
    };
    engine = buildEngine(await inflate(data.diaryData));
    loadState();
    buildControls();
    $("#search").value = state.query;
    compute();
    $("#loading").hidden = true;
    $("#dashboard").hidden = false;
    render();
  } catch (e) {
    $("#loading").textContent =
      "The survey data could not be loaded. Keep data.js with this page, or open the standalone american-minute.html file in a current browser.";
    console.error(e);
  }
}

// ---- Event listeners ----
$("#timeline").addEventListener("input", (e) => {
  stop();
  changeMinute(Number(e.target.value));
});
$("#time-input").addEventListener("change", (e) => {
  if (!e.target.value) return;
  stop();
  const [h, m] = e.target.value.split(":").map(Number);
  changeMinute(h * 60 + m);
});
$("#now").addEventListener("click", now);
$("#play").addEventListener("click", () => {
  if (!engine) return;
  if (playTimer !== null) {
    stop();
    saveState();
    return;
  }
  state.following = false;
  $("#play").textContent = "Ⅱ";
  $("#play").setAttribute("aria-pressed", "true");
  $("#play").setAttribute("aria-label", "Pause the day");
  playTimer = setInterval(() => changeMinute(state.minute + 5, false, false), 250);
});
$$("[data-day]").forEach((b) =>
  b.addEventListener("click", () => {
    if (!engine) return;
    stop();
    state.day = b.dataset.day;
    recompute();
  }),
);
document.addEventListener("change", (e) => {
  const id = e.target.dataset?.filter;
  if (!id || !engine) return;
  stop();
  if (e.target.value === "") delete state.filters[id];
  else state.filters[id] = Number(e.target.value);
  recompute();
});
$("#reset-filters").addEventListener("click", () => {
  stop();
  state.filters = {};
  recompute();
});
$$("[data-mode]").forEach((b) =>
  b.addEventListener("click", () => {
    state.mode = b.dataset.mode;
    state.parent = "all";
    state.query = "";
    state.limit = 40;
    $("#search").value = "";
    renderList();
    saveState();
  }),
);
$("#category-filter").addEventListener("change", (e) => {
  state.parent = e.target.value;
  state.mode = state.parent === "all" ? state.mode : "detail";
  state.limit = 40;
  renderList();
  saveState();
});
$("#search").addEventListener("input", (e) => {
  state.query = e.target.value;
  state.limit = 40;
  renderList();
  saveState();
});
$("#unit").addEventListener("click", () => {
  state.unit = state.unit === "people" ? "percent" : "people";
  renderList();
  saveState();
});
$("#load-more").addEventListener("click", () => {
  state.limit += 40;
  renderList();
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-activity]");
  if (b && engine) selectActivity(b.dataset.activity);
});
document.addEventListener("keydown", (e) => {
  if (
    e.key === "/" &&
    !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName) &&
    !$("#about-dialog").open
  ) {
    e.preventDefault();
    $("#search").focus();
  }
});
$("#about").addEventListener("click", showAbout);
$("#close-about").addEventListener("click", () => $("#about-dialog").close());
$("#about-dialog").addEventListener("click", (e) => {
  if (e.target !== e.currentTarget) return;
  const r = e.currentTarget.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
    e.currentTarget.close();
});
$("#download-snapshot").addEventListener("click", () => {
  if (engine) download("snapshot");
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
});

setInterval(() => {
  if (engine && state.following && !$("#about-dialog").open) {
    const n = new Date(),
      m = n.getHours() * 60 + n.getMinutes();
    if (m !== state.minute) changeMinute(m, true, false);
  }
}, 1000);

const ready = init();
