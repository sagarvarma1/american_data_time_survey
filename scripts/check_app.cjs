/* Functional checks of dist/app.js in a minimal DOM. These do not validate browser layout.
 * Run scripts/check_data.py first: it writes data/test-expectations.json from the raw BLS files. */
const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const { loadApp, root } = require("./app-sandbox.cjs");
const expectations = JSON.parse(
  fs.readFileSync(path.join(root, "data/test-expectations.json"), "utf8"),
);
const { html, ids, nodes, days, modes, listeners, timers, out, sandbox, run } = loadApp({
  hash: "#time=08%3A00&day=all&activity=drive",
});
assert.equal(new Set(ids).size, ids.length, "element ids are unique");
for (const m of html.matchAll(/href="#([^"]+)"/g)) assert(ids.includes(m[1]));
const rows = () => (nodes["#activity-list"].innerHTML.match(/class="activity-row"/g) || []).length;
const change = (filter, value) =>
  listeners.change({ target: { dataset: { filter }, value: String(value) } });

function setScenario(s) {
  run(
    `state.from=${s.years[0]};state.to=${s.years[1]};state.day=${JSON.stringify(s.day)};state.filters={}`,
  );
  for (const k of ["sex", "age", "employment", "kids", "where", "who"])
    if (k in s) run(`state.filters.${k}=${s[k]}`);
  run("compute()");
}

// Geometry may differ by display rounding (at most 0.1 of a 90–150-unit chart, i.e. a fraction of
// a pixel); everything else, including every label, number, and tooltip, must match exactly.
const GEOMETRY = /(\s(?:points|x|y|x1|x2|y1|y2|cx|cy|width|height)=")([^"]*)"|(width:)([\d.]+)%/g;
function samePage(a, b, label) {
  const shapes = [[], []];
  const strip = (h, i) =>
    h.replace(GEOMETRY, (_, attr, v, css, w) => {
      shapes[i].push(...(v ?? w).split(/[ ,]/).map(Number));
      return (attr ?? css) + "#";
    });
  const [x, y] = [strip(a, 0), strip(b, 1)];
  if (x !== y) {
    let i = 0;
    while (x[i] === y[i]) i++;
    assert.fail(
      `${label}\n  service: ${JSON.stringify(x.slice(i - 150, i + 100))}\n  diaries: ${JSON.stringify(y.slice(i - 150, i + 100))}`,
    );
  }
  assert.equal(shapes[0].length, shapes[1].length, label);
  shapes[0].forEach((v, i) =>
    assert(Math.abs(v - shapes[1][i]) <= 0.1000001, `${label}: shape ${v} vs ${shapes[1][i]}`),
  );
}

// Renders the page for a state from the calculation service and from the diaries, at several
// minutes and in both units, and returns both versions.
const comparePaths = (s) =>
  run(`(async () => {
    const diaries = local, pages = [[], []];
    const apply = () => {
      state.day = ${JSON.stringify(s.day)};
      state.filters = ${JSON.stringify(s.filters ?? {})};
      state.selected = ${JSON.stringify(s.selected)};
      state.mode = ${JSON.stringify(s.mode ?? "overview")};
      state.parent = ${JSON.stringify(s.parent ?? "all")};
      state.query = "";
      state.limit = 1000;
    };
    for (const [i, source] of [[0, null], [1, diaries]]) {
      local = source;
      engine = null;
      apply();
      await update();
      for (const m of [0, 237, 480, 731, 1062, 1320])
        for (const unit of ["people", "percent"]) {
          state.minute = m;
          state.unit = unit;
          render();
          pages[i].push(["#summary", "#activity-list", "#detail-content"].map((id) => $(id).innerHTML).join(""));
        }
    }
    local = diaries;
    state.unit = "people";
    return pages;
  })()`);

(async () => {
  // ---- The website: the precomputed first view and the calculation service, never the diaries.
  await run("ready");
  const diaryFile = run("data.diaryFile");
  assert.equal(nodes["#dashboard"].hidden, false, nodes["#loading"].textContent);
  assert.equal(nodes["#loading"].textContent, "", "no loading message");
  assert.equal(run("engine.partial"), true);
  assert.deepEqual(
    out.fetched.map((u) => u.split("?")[0]),
    ["api/detail"],
    "the first view is precomputed; only the selected activity's extras are requested",
  );
  assert.match(out.fetched[0], /^api\/detail\?v=[0-9a-f]{16}&day=all&activity=drive$/);
  const first = nodes["#detail-content"].innerHTML;
  assert(first.includes("ACROSS THE YEARS") && first.includes("WHERE THEY ARE"));
  assert.equal(rows(), 17);

  // Interactions request only what they need, and every response can be cached for good.
  change("sex", 1);
  await run("updating");
  assert.deepEqual(
    out.fetched
      .slice(1)
      .map((u) => u.split("?")[0])
      .sort(),
    ["api/detail", "api/view"],
    "a filter needs one view and the selected activity's extras, requested together",
  );
  assert(out.fetched.some((u) => u.includes("sex=1&rows=main")));
  assert(nodes["#data-badge"].textContent.includes("diaries"));
  days[2].listeners.click();
  await run("updating");
  modes[1].listeners.click(); // the detailed list needs every activity's row
  await run("updating");
  assert(out.fetched.at(-1).includes("rows=all"), out.fetched.at(-1));
  assert.equal(rows(), 40);
  const before = out.fetched.length;
  nodes["#search"].listeners.input({ target: { value: "laundry" } });
  await run("updating");
  assert.equal(out.fetched.length, before, "search uses the rows already loaded");
  assert(run('matching().some((a) => a.id === "household_020102")'));
  run('selectActivity("household_020102")');
  await run("updating");
  assert.match(out.fetched.at(-1), /activity=household_020102$/);
  assert(nodes["#detail-content"].innerHTML.includes("WHERE THEY ARE"));
  nodes["#search"].listeners.input({ target: { value: "" } });
  await nodes["#download-snapshot"].listeners.click();
  const serviceSnapshot = await out.downloadBlob.text();
  assert.equal(serviceSnapshot.split("\n").length, 1 + 17 + 690 + 1);
  assert.equal(run("local"), null);
  assert(!out.fetched.includes(diaryFile), "visitors never download the diaries");
  for (const r of out.responses) assert.match(r.headers["Cache-Control"], /immutable/, r.url);
  const sizes = out.responses.map((r) => r.bytes);

  // Bad requests are refused, so the cache only ever holds valid views.
  const service = require("../api/_service.js");
  for (const url of [
    "/api/view?day=all",
    "/api/view?day=monday&rows=main",
    "/api/view?day=all&rows=main&age=9",
    "/api/view?day=all&rows=main&where=0",
    "/api/view?day=all&rows=main&extra=1",
    "/api/detail?day=all&activity=nope",
    "/api/detail?day=all&where=1&activity=awake",
  ])
    assert.throws(
      () => service.respond(url.includes("detail") ? "detail" : "view", url),
      /bad|unknown/,
      url,
    );

  // A shared link with filters draws from one view and the selected activity's extras.
  const shared = loadApp({ hash: "#time=21%3A15&day=weekend&sex=0&who=4&activity=eat" });
  await shared.run("ready");
  assert.equal(shared.nodes["#dashboard"].hidden, false);
  assert.deepEqual(shared.out.fetched.map((u) => u.split("?")[0]).sort(), [
    "api/detail",
    "api/view",
  ]);
  assert.match(shared.nodes["#summary"].innerHTML, /With: Friends/);

  // If the service can't be reached, the page computes everything from the diaries instead.
  const offline = loadApp({
    hash: "#time=21%3A15&day=weekend&sex=0&who=4&activity=eat",
    service: false,
  });
  const silence = console.error;
  console.error = () => {};
  await offline.run("ready");
  console.error = silence;
  assert.equal(offline.nodes["#dashboard"].hidden, false);
  assert.equal(offline.run("engine === local && !engine.partial"), true);
  assert(offline.out.fetched.includes(diaryFile));
  for (const id of ["#summary", "#activity-list", "#detail-content"])
    assert.equal(offline.nodes[id].innerHTML, shared.nodes[id].innerHTML, `fallback ${id}`);

  // ---- The same page from either source: every number, label, and percentage, in both units.
  await run("useDiaries()");
  for (const s of [
    { day: "all", selected: "drive" },
    { day: "all", selected: "household_020102" },
    { day: "weekday", selected: "awake" },
    { day: "weekend", filters: { sex: 0, who: 4 }, selected: "eat" },
    { day: "weekday", filters: { age: 2, kids: 1, where: 4 }, selected: "context" },
    { day: "all", filters: { employment: 0 }, selected: "work", mode: "detail" },
    { day: "weekend", filters: { where: 1 }, selected: "leisure_120303", parent: "leisure" },
    { day: "all", filters: { age: 6, who: 0 }, selected: "sleep" },
    {
      day: "weekday",
      filters: { sex: 1, employment: 3, kids: 2 },
      selected: "care",
      mode: "detail",
    },
  ]) {
    const [service, diaries] = await comparePaths(s);
    service.forEach((page, i) => samePage(page, diaries[i], `${JSON.stringify(s)} #${i}`));
  }
  // Snapshot downloads match too (after the state the service produced it for).
  run(
    'state.day = "weekend"; state.filters = { sex: 1 }; state.mode = "detail"; state.parent = "all"; state.selected = "household_020102"; state.minute = 480; update()',
  );
  nodes["#download-snapshot"].listeners.click();
  assert.equal(
    await out.downloadBlob.text(),
    serviceSnapshot,
    "service and diaries give the same CSV",
  );

  run(
    "state.minute = 480; state.day = 'all'; state.filters = {}; state.mode = 'overview'; state.selected = 'drive'; state.limit = 40; update()",
  );
  console.log(
    `Service responses: ${sizes.map((b) => Math.round(b / 1024) + " KB").join(", ")} (uncompressed JSON).`,
  );

  assert.equal(nodes["#dashboard"].hidden, false, nodes["#loading"].textContent);
  assert.equal(run("state.minute"), 480);
  assert.equal(nodes["#clock"].textContent, "8:00");
  assert.equal(run("engine.sample"), 258954);
  assert.equal(run("engine.days"), 8348); // 23 years + 6 leap days − 53-day 2020 gap
  assert(nodes["#data-badge"].textContent.includes("258,954"));

  // Engine against independent expectations computed from the raw BLS files.
  let checked = 0;
  const started = Date.now();
  for (const [name, x] of Object.entries(expectations)) {
    setScenario(x.filters);
    assert.equal(run("engine.days"), x.days, name);
    assert.equal(run("engine.sample"), x.sample, name);
    assert(Math.abs(run("engine.population") - x.population) <= 1e-6 * x.population, name);
    for (const p of x.points) {
      const v = run(`value(${JSON.stringify(p.activity)}, ${p.minute})`);
      assert.equal(v.n, p.diaries, `${name} ${p.activity} ${p.minute}`);
      assert(
        Math.abs(v.count - p.people) <= 1e-6 * Math.max(p.people, 1),
        `${name} ${p.activity} ${p.minute}`,
      );
      checked++;
    }
  }
  const perPass = (Date.now() - started) / Object.keys(expectations).length;

  // Partitions: categories cover everyone; detail rows sum to their parent.
  setScenario({ years: [2003, 2025], day: "all" });
  for (const m of [0, 333, 720, 1439]) {
    const total = run(`data.categories.reduce((s,a)=>s+value(a.id,${m}).count,0)`);
    const n = run(`data.categories.reduce((s,a)=>s+value(a.id,${m}).n,0)`);
    assert(Math.abs(total - run("engine.population")) < 1e-3, `partition ${m}`);
    assert.equal(n, 258954);
    for (const c of run("data.categories.map(a=>a.id)")) {
      const sum = run(
        `data.details.filter(d=>d.parent==="${c}").reduce((s,d)=>s+value(d.id,${m}).count,0)`,
      );
      assert(Math.abs(sum - run(`value("${c}",${m}).count`)) < 1e-3, `${c} ${m}`);
    }
  }
  assert(
    Math.abs(run('value("awake").count+value("sleep").count') - run("engine.population")) < 1e-3,
  );

  // UI flows.
  run("render()");
  assert.equal(rows(), 17);
  for (const b of days) {
    b.listeners.click();
    assert.equal(run("state.day"), b.dataset.day);
    assert(nodes["#detail-content"].innerHTML.includes("Diaries at this minute"));
  }
  days[0].listeners.click();
  for (const id of ["share", "year-from", "year-to", "scope-text", "filter-note"])
    assert(!ids.includes(id), `#${id} was removed from the page`);
  assert(!/years=/.test(out.lastHash), "survey years are no longer part of the URL");

  change("sex", 1);
  change("kids", 1);
  assert.deepEqual({ ...run("state.filters") }, { sex: 1, kids: 1 });
  assert(nodes["#data-badge"].textContent.includes("diaries · 2003–2025"));
  assert.equal(nodes["#reset-filters"].hidden, false);
  assert(out.lastHash.includes("sex=1") && out.lastHash.includes("kids=1"));
  change("where", 1);
  assert.equal(run('value("sleep").count'), 0, "sleep has no recorded location");
  change("where", "");

  // Context filters (the reported bug): every number on the page must follow the same filters.
  // At 4:24 PM with "Restaurant or bar", the Driving card used to show 8.8M while its panel said 0.
  run('state.minute=16*60+24;selectActivity("drive")');
  const restaurant = run('data.episodeFilters[0].options.indexOf("Restaurant or bar")');
  change("where", restaurant);
  assert.deepEqual([...run("summaryIds()")], ["context", "drive"]);
  assert.equal(nodes["#summary"].classes.two, true);
  const card = (id) => new RegExp(`data-activity="${id}"[\\s\\S]*?summary-value">([^<]+)<`);
  const driveCard = card("drive").exec(nodes["#summary"].innerHTML)[1];
  const drivePanel = /detail-value">([^ <]+)/.exec(nodes["#detail-content"].innerHTML)[1];
  assert.equal(driveCard, drivePanel, "Driving card and panel agree");
  assert.equal(driveCard, "0", "nobody drives while at a restaurant");
  assert(
    !nodes["#detail-content"].innerHTML.includes("Peak: 100.0%"),
    "an all-zero years chart has no peak",
  );
  const contextCount = run('value("context").count');
  const categorySum = run("data.categories.reduce((s,a)=>s+value(a.id).count,0)");
  assert(
    contextCount > 0 && Math.abs(contextCount - categorySum) < 1e-3,
    "context total = categories",
  );
  assert(nodes["#summary"].innerHTML.includes("Restaurant or bar"));
  run('selectActivity("context")');
  assert(
    card("context").exec(nodes["#summary"].innerHTML)[1] ===
      /detail-value">([^ <]+)/.exec(nodes["#detail-content"].innerHTML)[1],
  );
  assert(
    !nodes["#detail-content"].innerHTML.includes("WHERE THEY ARE"),
    "fixed breakdown is hidden",
  );
  assert(nodes["#detail-content"].innerHTML.includes("WHO THEY’RE WITH"));
  run('selectActivity("awake")');
  change("where", "");
  assert.equal(run("state.selected"), "awake");
  change("where", restaurant);
  assert.equal(run("state.selected"), "context", "awake is replaced while a context filter is on");
  change("where", "");
  assert.equal(run("state.selected"), "awake", "and restored when it is cleared");
  assert.deepEqual([...run("summaryIds()")], ["sleep", "awake", "drive"]);
  for (const id of ["sleep", "awake", "drive"]) {
    run(`selectActivity("${id}")`);
    assert.equal(
      card(id).exec(nodes["#summary"].innerHTML)[1],
      /detail-value">([^ <]+)/.exec(nodes["#detail-content"].innerHTML)[1],
      `${id} card and panel agree`,
    );
  }
  nodes["#reset-filters"].listeners.click();
  assert.deepEqual({ ...run("state.filters") }, {});

  modes[1].listeners.click();
  assert.equal(run("matching().length"), 690);
  assert.equal(rows(), 40);
  nodes["#load-more"].listeners.click();
  assert.equal(rows(), 80);
  nodes["#search"].listeners.input({ target: { value: "laundry" } });
  assert(run('matching().some(a=>a.id==="household_020102")'));
  nodes["#search"].listeners.input({ target: { value: "<script>bad" } });
  assert(nodes["#activity-list"].innerHTML.includes("No matching"));
  assert(!nodes["#activity-list"].innerHTML.includes("<script>"));
  nodes["#search"].listeners.input({ target: { value: "" } });

  run('selectActivity("household_020102")');
  const detail = nodes["#detail-content"].innerHTML;
  assert(detail.includes("Laundry") && detail.includes("020102"));
  assert(detail.includes("WHERE THEY ARE") && detail.includes("At home"));
  assert(detail.includes("WHO THEY’RE WITH") && detail.includes("ACROSS THE YEARS"));
  assert.equal((detail.match(/class="year-bar/g) || []).length, 23);
  assert(!/\[object|undefined|NaN/.test(detail), "no unformatted values in the detail panel");
  assert(/At home<\/span>[\s\S]*?\d+\.\d%/.test(detail), "location shares are formatted");
  run('selectActivity("travel_180782")');
  assert(
    nodes["#detail-content"].innerHTML.includes("combines"),
    "harmonized codes explain themselves",
  );
  run('selectActivity("household_020102")');
  nodes["#drill-down"].listeners.click();
  assert.equal(run("state.parent"), "household");
  assert(run('matching().every(a=>a.parent==="household")'));
  assert(out.lastHash.includes("activity=household_020102"));

  nodes["#unit"].listeners.click();
  assert.equal(run("state.unit"), "percent");
  assert(nodes["#unit"].innerHTML.includes("SHARE"));
  assert.equal(nodes["#secondary-unit"].textContent, "PEOPLE");
  nodes["#timeline"].listeners.input({ target: { value: "1439" } });
  nodes["#play"].listeners.click();
  [...timers.values()].at(-1)();
  assert.equal(run("state.minute"), 4);
  nodes["#play"].listeners.click();
  assert.equal(run("playTimer"), null);
  nodes["#time-input"].listeners.change({ target: { value: "00:00" } });
  assert.equal(run("state.minute"), 0);

  run('selectActivity("awake")');
  assert(nodes["#detail-content"].innerHTML.includes("ACROSS THE YEARS"));
  nodes["#awake-about"].listeners.click();
  assert(nodes["#about-dialog"].open);
  nodes["#close-about"].listeners.click();
  assert.equal(nodes["#about-dialog"].open, false);

  // Following the device clock, links leave the time out; a chosen time is kept.
  run("now()");
  assert.equal(run("state.following"), true);
  assert(!out.lastHash.includes("time="), out.lastHash);
  nodes["#timeline"].listeners.input({ target: { value: "600" } });
  assert(out.lastHash.includes("time=10%3A00"), out.lastHash);

  // Deep links restore the time, day, and filters; old links with years show all years.
  sandbox.location.hash = "#time=21%3A15&day=weekend&years=2010-2019&sex=0&who=4&activity=eat";
  run("state.filters={};loadState();compute()");
  assert.equal(run("state.minute"), 21 * 60 + 15);
  assert.deepEqual([run("state.from"), run("state.to"), run("state.day")], [2003, 2025, "weekend"]);
  assert.deepEqual({ ...run("state.filters") }, { sex: 0, who: 4 });
  sandbox.location.hash = "#years=2025-2003&where=0&age=99";
  run("state.filters={};loadState()");
  assert.deepEqual(
    [run("state.from"), run("state.to")],
    [2003, 2025],
    "years always cover the full range",
  );
  assert.deepEqual({ ...run("state.filters") }, {});
  run("compute()");

  run('state.day="all";selectActivity("household_020102")');
  nodes["#download-trend"].listeners.click();
  const trendBlob = out.downloadBlob;
  nodes["#download-snapshot"].listeners.click();
  const trend = await trendBlob.text(),
    snap = await out.downloadBlob.text();
  assert.equal(trend.split("\n").length, 1441);
  assert.equal(snap.split("\n").length, 1 + 17 + 690 + 1);
  assert(trend.includes('2003–2025,all,"none",00:00,household_020102'));
  assert(snap.includes("derived_complement"));

  console.log(
    `PASS: engine matches ${checked} raw-file snapshots across ${Object.keys(expectations).length} ` +
      `filter scenarios (~${Math.round(perPass)} ms per full recompute); partitions, years, filters, ` +
      "context breakdowns, deep links, search, drill-down, units, playback, dialogs, and both CSV exports.",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
