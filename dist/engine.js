"use strict";

// ---- Diary engine ----
// Shared by the page (app.js) and the calculation service (api/), so both compute every number
// the same way. In the browser these are globals; in Node, a module.

const DAY = 1440,
  STRIDE = DAY + 1; // one extra slot per curve for wrap-around differences

// Decode the packed columns, then regroup episodes by activity so each activity's curve is
// built from one contiguous run of episodes (cache-friendly and easy to subset).
function buildEngine(data, buffer) {
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

// Location/company filters apply to activities, not people.
function hasContext(filters) {
  return filters.where !== undefined || filters.who !== undefined;
}

// Recompute every curve for the given years, day type, filters, and selected activity.
function computeEngine(E, data, state) {
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
  const filtered = hasContext(state.filters);
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

// People doing an activity at a minute, and the observed diaries behind the estimate. Awake is
// everyone minus those sleeping; precomputed views store it directly, and a view's selected
// activity comes from its more precise detail curve.
function engineValue(E, id, m) {
  if (E.detail?.id === id) return { count: E.detail.total[m], n: E.detail.diaries[m] };
  if (id === "awake" && !E.partial) {
    const sleep = engineValue(E, "sleep", m);
    return { count: Math.max(0, E.population - sleep.count), n: E.sample - sleep.n };
  }
  const base = E.keyIndex[id] * STRIDE + m;
  return { count: Math.max(0, E.weights[base]) / E.days, n: E.counts[base] };
}

// ---- Views: computed curves in compact form ----
// The precomputed first view and the calculation service send finished curves, not diaries.
// Each curve is rounded (to whole people, as the page displays them, or to hundredths of a
// person where shares are computed from it) and stored as minute-to-minute differences, which
// compress well.
const DETAIL_SCALE = 100;

function packCurve(get, scale = 1) {
  const out = new Array(DAY);
  for (let m = 0, last = 0; m < DAY; m++) {
    const v = Math.round(get(m) * scale);
    out[m] = v - last;
    last = v;
  }
  return out;
}

function unpackCurves(curves, scale = 1) {
  const out = new Float64Array(curves.length * STRIDE);
  curves.forEach((curve, r) => {
    for (let m = 0, v = 0; m < DAY; m++) {
      v += curve[m];
      out[r * STRIDE + m] = v / scale;
    }
  });
  return out;
}

// The listed activities' people and observed diaries at every minute, for one day type and set
// of filters, with the population they come from.
function exportView(E, ids) {
  return {
    ids,
    population: E.population,
    sample: E.sample,
    people: ids.map((id) => packCurve((m) => engineValue(E, id, m).count)),
    diaries: ids.map((id) => packCurve((m) => engineValue(E, id, m).n)),
  };
}

// The selected activity's extras, as computed by computeEngine: its curve (which a view may not
// include), where people doing it are and who they're with, and the same minute in every year.
function exportDetail(E, data, state) {
  const yearDays = (y) => data.years[y].days[state.day];
  const curves = (arr, rows, divide, scale) =>
    Array.from({ length: rows }, (_, r) =>
      packCurve((m) => Math.max(0, arr[r * STRIDE + m]) / divide(r), scale),
    );
  return {
    id: state.selected,
    total: packCurve((m) => engineValue(E, state.selected, m).count),
    diaries: packCurve((m) => engineValue(E, state.selected, m).n),
    where: curves(E.whereWeights, E.nWhere, () => E.days, DETAIL_SCALE),
    who: curves(E.whoWeights, E.nWho + 1, () => E.days, DETAIL_SCALE),
    years: curves(E.yearWeights, data.years.length, yearDays, DETAIL_SCALE),
    yearDiaries: curves(E.yearCounts, data.years.length, () => 1, 1),
    yearPopulation: data.years.map((_, y) => E.yearPopulation[y] / yearDays(y)),
    yearSample: [...E.yearSample],
  };
}

if (typeof module === "object")
  module.exports = {
    DAY,
    STRIDE,
    DETAIL_SCALE,
    buildEngine,
    computeEngine,
    engineValue,
    hasContext,
    packCurve,
    unpackCurves,
    exportView,
    exportDetail,
  };
