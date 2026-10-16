"use strict";

// ---- State and DOM helpers ----
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
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

// ---- Filters ----
// A filter's value is a sorted list of option indexes (any of them matches); a missing filter
// means any. Survey years are a separate from–to range, offered with the advanced filters.
const fullRange = () => state.from === data.years[0].year && state.to === data.years.at(-1).year;

function setFilter(id, values) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length) state.filters[id] = sorted;
  else delete state.filters[id];
}

function filterParams(p) {
  for (const f of allFilters()) if (state.filters[f.id]) p.set(f.id, state.filters[f.id].join(","));
  if (!fullRange()) {
    p.set("from", state.from);
    p.set("to", state.to);
  }
}

// Identifies the set of diaries a view was computed for.
function viewKey() {
  const p = new URLSearchParams({ day: state.day });
  filterParams(p);
  return String(p);
}

// ---- Where the numbers come from ----
// Fastest first: the precomputed first view in data.js (the unfiltered overview), the
// calculation service (any view, as one small response that Vercel caches), or the diaries
// themselves (the standalone page, or silently if the service can't be reached). The first two
// send curves rounded exactly as the page displays them, and the tests check that all three
// render the same page.
let local = null, // the diary engine, once loaded
  fallback = null,
  request = 0; // the latest update; responses to older ones are dropped
const service = () => !data.diaryData;

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

// The standalone page carries the diaries inline; the website keeps them in a file whose name
// changes whenever the data does, so browsers can cache it permanently.
async function loadDiaries() {
  if (data.diaryData) return inflate(data.diaryData);
  const response = await fetch(data.diaryFile);
  if (!response.ok) throw Error(`${data.diaryFile}: HTTP ${response.status}`);
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

function useDiaries() {
  return (fallback ??= (async () => {
    const full = buildEngine(data, await loadDiaries());
    await new Promise((resolve) => setTimeout(resolve)); // let the page respond between steps
    local = full;
    await update();
  })());
}

async function fetchView(kind, extra) {
  const p = new URLSearchParams({ v: data.diaryFile.match(/([0-9a-f]+)\.bin$/)[1] });
  p.set("day", state.day);
  filterParams(p);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const response = await fetch(`api/${kind}?${p}`);
  if (!response.ok) throw Error(`api/${kind}: HTTP ${response.status}`);
  return response.json();
}

function viewEngine(view, key) {
  const keyIndex = Object.fromEntries(view.ids.map((id, i) => [id, i]));
  return {
    partial: true,
    key,
    keyIndex,
    allRows: data.details.every((d) => d.id in keyIndex),
    weights: unpackCurves(view.people),
    counts: unpackCurves(view.diaries),
    population: view.population,
    sample: view.sample,
    days: 1, // curves already hold people
  };
}

// The selected activity's curve, location, company, and yearly trend.
const DETAIL_FIELDS = ["detail", "whereWeights", "whoWeights", "nWhere", "nWho"].concat([
  "yearWeights",
  "yearCounts",
  "yearPopulation",
  "yearSample",
]);

function addDetail(E, d) {
  E.detail = {
    id: d.id,
    total: unpackCurves([d.total]),
    diaries: unpackCurves([d.diaries]),
  };
  E.whereWeights = unpackCurves(d.where, DETAIL_SCALE);
  E.whoWeights = unpackCurves(d.who, DETAIL_SCALE);
  E.nWhere = d.where.length;
  E.nWho = d.who.length - 1;
  E.yearWeights = unpackCurves(d.years, DETAIL_SCALE);
  E.yearCounts = unpackCurves(d.yearDiaries);
  E.yearPopulation = d.yearPopulation;
  E.yearSample = d.yearSample;
}

// Detailed rows are needed only when the list shows them.
function listsDetails() {
  return state.mode === "detail" || Boolean(state.query.trim()) || state.parent !== "all";
}

// Whether an engine has every number the page is about to show.
function covers(E) {
  if (!E || !E.partial) return Boolean(E);
  if (E.key !== viewKey()) return false;
  const has = (id) => id in E.keyIndex || E.detail?.id === id;
  return summaryIds().every(has) && has(state.selected) && (!listsDetails() || E.allRows);
}

const hasExtras = () => !engine.partial || engine.detail?.id === state.selected;

async function viewFor() {
  const key = viewKey(),
    unfiltered = !Object.keys(state.filters).length && fullRange();
  if (engine?.partial && engine.key === key && (!listsDetails() || engine.allRows)) return engine;
  if (!listsDetails() && unfiltered && data.preview)
    return viewEngine(data.preview[state.day], key);
  if (!service()) throw Error("The standalone page computes everything locally");
  const rows = listsDetails() ? "all" : "main";
  return viewEngine(await fetchView("view", { rows }), key);
}

// Bring the numbers up to date with the state, then render. Interactions that change only the
// minute or the list's presentation render directly. `updating` lets tests wait for the result.
let updating = Promise.resolve();
function update() {
  return (updating = refresh());
}

async function refresh() {
  syncContextSelection();
  saveState();
  if (local) {
    engine = local;
    compute();
    render();
    return;
  }
  const id = ++request;
  const sameView = engine?.partial && engine.key === viewKey();
  // The view and the selected activity's extras don't depend on each other: request both at once.
  const extras =
    service() && !(sameView && engine.detail?.id === state.selected)
      ? fetchView("detail", { activity: state.selected })
      : null;
  extras?.catch(() => {}); // a failure is handled where it is awaited
  try {
    const E = await viewFor();
    if (id !== request) return;
    // A larger view of the same day and filters keeps the extras already loaded.
    if (E !== engine && sameView && engine.detail) for (const k of DETAIL_FIELDS) E[k] = engine[k];
    engine = E;
    if (covers(E)) render();
    if (hasExtras()) return;
    if (!extras) return useDiaries(); // the standalone page
    addDetail(E, await extras);
    if (id === request) render();
  } catch (e) {
    if (service()) console.error(e);
    await useDiaries();
  }
}

// List changes need a fetch only when they reveal rows the current view doesn't have.
function refreshList() {
  if (covers(engine)) {
    renderList();
    saveState();
  } else update();
}

// Location/company filters apply to activities, not people, so the summary changes with them:
// without them it shows Sleeping, Awake, and Driving; with them, everyone in that context
// (for example, everyone at a restaurant) and Driving. Every number follows the same filters.
function contextFiltered() {
  return hasContext(state.filters);
}

function summaryIds() {
  return contextFiltered() ? ["context", "drive"] : ["sleep", "awake", "drive"];
}

function syncContextSelection() {
  const label = data.episodeFilters
    .filter((f) => state.filters[f.id])
    .map((f) => (f.id === "who" ? "With: " : "") + optionList(f))
    .join(" · ");
  byId.context.label = label || "In this context";
  if (contextFiltered() && state.selected === "awake") state.selected = "context";
  if (!contextFiltered() && state.selected === "context") state.selected = "awake";
}

// Recompute every curve for the current day type, filters, and selected activity.
function compute() {
  syncContextSelection();
  computeEngine(engine, data, state);
}

// ---- Data lookup ----
function value(id, m = state.minute) {
  return engineValue(engine, id, m);
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

function optionList(f) {
  return state.filters[f.id].map((v) => f.options[v]).join(" or ");
}

function filterSummary() {
  return allFilters()
    .filter((f) => state.filters[f.id])
    .map((f) => `${f.label}: ${optionList(f)}`)
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
  filterParams(p);
  if (state.query) p.set("q", state.query);
  // While the clock follows the device, links leave the time out, so whoever opens one sees
  // their own local time. A time someone picked is kept.
  if (state.following) p.delete("time");
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
    if (!/^\d+(,\d+)*$/.test(v || "")) continue;
    const values = v.split(",").map(Number);
    setFilter(
      f.id,
      values.filter((i) => i < f.options.length && !(f.id === "where" && i === 0)),
    );
  }
  const from = Number(p.get("from")),
    to = Number(p.get("to"));
  if (from >= first && to <= last && from <= to) [state.from, state.to] = [from, to];
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

function pickerText(f) {
  const values = state.filters[f.id];
  if (!values) return anyLabels[f.id] || "Any";
  return values.length <= 2
    ? values.map((v) => f.options[v]).join(", ")
    : `${values.length} selected`;
}

function renderFilters() {
  for (const f of allFilters()) {
    $(`[data-picker-text="${f.id}"]`).textContent = pickerText(f);
    $(`[data-picker="${f.id}"]`).classList.toggle("active", Boolean(state.filters[f.id]));
    for (const box of $$(`[data-filter="${f.id}"]`))
      box.checked = Boolean(state.filters[f.id]?.includes(Number(box.value)));
  }
  $('[data-range="from"]').value = state.from;
  $('[data-range="to"]').value = state.to;
  const advanced =
    data.personFilters.filter((f) => !f.basic && state.filters[f.id]).length + !fullRange();
  $("#advanced-count").textContent = advanced ? ` · ${advanced}` : "";
  $("#reset-filters").hidden = !Object.keys(state.filters).length && fullRange();
  const n = engine.sample,
    note = $("#sample-note");
  note.hidden = n >= 300;
  note.textContent = n
    ? `Only ${n.toLocaleString()} diaries match these filters. Estimates for a group this small are rough; activities with fewer than 30 diaries are marked.`
    : "No diaries match these filters. Try removing one.";
}

function closePickers() {
  for (const picker of $$(".picker")) {
    const menu = picker.querySelector(".picker-menu");
    if (!menu) continue; // the survey-years control has no menu
    menu.hidden = true;
    picker.querySelector(".picker-button").setAttribute("aria-expanded", "false");
  }
}

function togglePicker(id) {
  const picker = $(`[data-picker="${id}"]`),
    menu = picker.querySelector(".picker-menu"),
    open = menu.hidden;
  closePickers();
  menu.hidden = !open;
  picker.querySelector(".picker-button").setAttribute("aria-expanded", String(open));
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
  return (
    list
      .map((a) => ({ ...a, ...value(a.id) }))
      // Ranked by whole people (as shown), so every data source gives the same order.
      .sort((a, b) => Math.round(b.count) - Math.round(a.count) || a.label.localeCompare(b.label))
  );
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
  $("#load-more").textContent =
    `Show ${Math.max(0, Math.min(40, list.length - state.limit))} more activities ↓`;
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
  points.push(`${w},${(h - (values[1439] / (max || 1)) * (h - 4)).toFixed(2)}`);
  return {
    max,
    peak,
    points: points.join(" "),
    x: ((state.minute / 1439) * w).toFixed(2),
    y: (h - (values[state.minute] / (max || 1)) * (h - 4)).toFixed(2),
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
  const total = value(state.selected).count * E.days; // in the same units as the breakdowns
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
      const outside = s.year < state.from || s.year > state.to; // beyond the chosen survey years
      const cls = `year-bar${s.n < SMALL_SAMPLE ? " small" : ""}${outside ? " outside" : ""}`;
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
  const extras = hasExtras(); // location, company, and yearly trend follow a moment later
  const action = derived
    ? '<button id="awake-about" class="outline-button">About this estimate ↗</button>'
    : `<button id="drill-down" class="outline-button" data-group="${group}">${a.parent ? "More in this category" : "Explore detailed activities"} ↗</button>`;
  // Skip a breakdown that a filter already fixes (e.g. "At home" is 100% at home).
  const context =
    a.id === "awake" || !extras
      ? ""
      : ["where", "who"]
          .filter((kind) => state.filters[kind]?.length !== 1)
          .map((kind) => breakdownBlock(kind, a))
          .join("");
  const years = extras ? yearsChart(a) : "";
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
    ${years}
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
      refreshList();
      $("#activity-browser").scrollIntoView({ block: "start", behavior: "smooth" });
    });
  else $("#awake-about").addEventListener("click", showAbout);
  $("#download-trend").addEventListener("click", () => download("trend"));
}

function render() {
  if (!covers(engine)) return; // a moment before the numbers arrive
  $("#loading").hidden = true;
  $("#dashboard").hidden = false;
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
  update();
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
        v = value(id, m),
        people = Math.round(v.count); // the percentage follows the rounded count it sits beside
      rows.push(
        [
          yearsLabel(),
          state.day,
          filters,
          isoTime(m),
          id,
          csvCell(a.label),
          people,
          percent(people).toFixed(6),
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
  // Every filter is a dropdown of checkboxes: pick any number of options.
  const picker = (f, named) => `
    <div class="picker" data-picker="${f.id}">
      ${named ? `<span class="picker-name" aria-hidden="true">${escapeHTML(f.label)}</span>` : ""}
      <button type="button" class="picker-button" aria-haspopup="true" aria-expanded="false" data-picker-toggle="${f.id}">
        <span class="sr-only">${escapeHTML(f.label)}: </span><span class="picker-text" data-picker-text="${f.id}"></span>
      </button>
      <div class="picker-menu" role="group" aria-label="${escapeHTML(f.label)}" hidden>
        ${f.options
          .map((o, i) =>
            // "Location not recorded" is not a useful filter choice.
            f.id === "where" && i === 0
              ? ""
              : `<label class="picker-option"><input type="checkbox" data-filter="${f.id}" value="${i}" /><span>${escapeHTML(o)}</span></label>`,
          )
          .join("")}
        <button type="button" class="picker-any" data-picker-clear="${f.id}">${escapeHTML(anyLabels[f.id] || "Any")}</button>
      </div>
    </div>`;
  const basic = data.personFilters.filter((f) => f.basic),
    advanced = data.personFilters.filter((f) => !f.basic);
  $("#person-filters").innerHTML = basic.map((f) => picker(f, false)).join("");
  $("#episode-filters").innerHTML = data.episodeFilters.map((f) => picker(f, false)).join("");
  const years = data.years.map((y) => `<option value="${y.year}">${y.year}</option>`).join("");
  const range = `
    <div class="picker">
      <span class="picker-name" aria-hidden="true">Survey years</span>
      <span class="year-range">
        <select data-range="from" aria-label="First survey year">${years}</select>
        <span aria-hidden="true">to</span>
        <select data-range="to" aria-label="Last survey year">${years}</select>
      </span>
    </div>`;
  $("#advanced-filters").innerHTML = [...new Set(advanced.map((f) => f.group))]
    .map(
      (group) => `
      <fieldset class="advanced-group">
        <legend>${escapeHTML(group)}</legend>
        <div class="advanced-row">
          ${advanced
            .filter((f) => f.group === group)
            .map((f) => picker(f, true))
            .join("")}
          ${group === "Diary day" ? range : ""}
        </div>
      </fieldset>`,
    )
    .join("");
  // Open the advanced panel when a link arrives with advanced filters.
  if (advanced.some((f) => state.filters[f.id]) || !fullRange()) toggleAdvanced(true);
  $("#category-filter").innerHTML =
    '<option value="all">All activities</option>' +
    data.categories.map((a) => `<option value="${a.id}">${escapeHTML(a.label)}</option>`).join("");
}

async function init() {
  try {
    data = window.AMERICAN_MINUTE_DATA;
    if (!data || data.schemaVersion !== 5) throw Error("Survey data unavailable");
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
    loadState();
    buildControls();
    $("#search").value = state.query;
    await update();
  } catch (e) {
    $("#loading").textContent =
      "The survey data could not be loaded. Serve the dist folder over HTTP, or open the standalone american-minute.html file in a current browser.";
    $("#loading").hidden = false;
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
    update();
  }),
);
function toggleAdvanced(open) {
  $("#advanced-filters").hidden = !open;
  $("#advanced-toggle").setAttribute("aria-expanded", String(open));
}

document.addEventListener("change", (e) => {
  const t = e.target,
    id = t.dataset?.filter,
    range = t.dataset?.range;
  if (!engine || !(id || range)) return;
  stop();
  if (range) {
    state[range] = Number(t.value);
    // Keep the range in order: moving one end past the other moves both.
    if (state.from > state.to) state[range === "from" ? "to" : "from"] = state[range];
  } else if (t.type === "checkbox") {
    const current = state.filters[id] ?? [],
      v = Number(t.value);
    setFilter(id, t.checked ? [...current, v] : current.filter((x) => x !== v));
  } else setFilter(id, t.value === "" ? [] : [Number(t.value)]);
  update();
});
$("#advanced-toggle").addEventListener("click", () =>
  toggleAdvanced($("#advanced-filters").hidden),
);
$("#reset-filters").addEventListener("click", () => {
  stop();
  state.filters = {};
  state.from = data.years[0].year;
  state.to = data.years.at(-1).year;
  update();
});
$$("[data-mode]").forEach((b) =>
  b.addEventListener("click", () => {
    state.mode = b.dataset.mode;
    state.parent = "all";
    state.query = "";
    state.limit = 40;
    $("#search").value = "";
    refreshList();
  }),
);
$("#category-filter").addEventListener("change", (e) => {
  state.parent = e.target.value;
  state.mode = state.parent === "all" ? state.mode : "detail";
  state.limit = 40;
  refreshList();
});
$("#search").addEventListener("input", (e) => {
  state.query = e.target.value;
  state.limit = 40;
  refreshList();
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
  const toggle = e.target.closest("[data-picker-toggle]");
  if (toggle) return togglePicker(toggle.dataset.pickerToggle);
  if (!e.target.closest(".picker-menu")) closePickers();
  const clear = e.target.closest("[data-picker-clear]");
  if (clear && engine) {
    stop();
    setFilter(clear.dataset.pickerClear, []);
    closePickers();
    return update();
  }
  const b = e.target.closest("[data-activity]");
  if (b && engine) selectActivity(b.dataset.activity);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePickers();
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
$("#download-snapshot").addEventListener("click", async () => {
  if (!covers(engine)) return;
  // The snapshot lists every activity, so a view without the detailed rows fetches them first.
  if (engine.partial && !engine.allRows) {
    const key = viewKey();
    const all = viewEngine(await fetchView("view", { rows: "all" }), key);
    for (const k of DETAIL_FIELDS) all[k] = engine[k];
    engine = all;
  }
  download("snapshot");
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
