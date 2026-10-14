/* Functional checks of dist/app.js in a minimal DOM. These do not validate browser layout.
 * Run scripts/check_data.py first: it writes data/test-expectations.json from the raw BLS files. */
const fs = require("node:fs"),
  vm = require("node:vm"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const root = path.resolve(__dirname, "..");
const dataJs = fs.readFileSync(path.join(root, "dist/data.js"), "utf8");
const expectations = JSON.parse(
  fs.readFileSync(path.join(root, "data/test-expectations.json"), "utf8"),
);
const html = fs.readFileSync(path.join(root, "dist/index.html"), "utf8");
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
assert.equal(new Set(ids).size, ids.length, "element ids are unique");
for (const m of html.matchAll(/href="#([^"]+)"/g)) assert(ids.includes(m[1]));

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.listeners = {};
    this.attributes = {};
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.open = false;
    this.tagName = "BUTTON";
  }
  addEventListener(t, f) {
    this.listeners[t] = f;
  }
  setAttribute(k, v) {
    this.attributes[k] = v;
  }
  getBoundingClientRect() {
    return { width: 500, height: 150, left: 0, right: 500, top: 0, bottom: 150 };
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  scrollIntoView() {}
  focus() {
    this.focused = true;
  }
  click() {
    this.clicked = true;
  }
  remove() {
    this.removed = true;
  }
  get classList() {
    const el = this;
    return {
      toggle(name, on) {
        el.classes = { ...el.classes, [name]: Boolean(on) };
      },
    };
  }
}

const dynamic = ["trend-chart", "drill-down", "awake-about", "download-trend"];
const nodes = Object.fromEntries([...ids, ...dynamic].map((id) => ["#" + id, new Element()]));
const days = ["all", "weekday", "weekend"].map((day) => new Element({ day }));
const modes = ["overview", "detail"].map((mode) => new Element({ mode }));
const lazy = (s) => (nodes[s] ??= new Element());
const listeners = {},
  timers = new Map();
let timerId = 0,
  downloadBlob,
  lastHash;
const document = {
  querySelector: (s) => {
    if (s.startsWith("[data-filter=") || s.includes("option[value=")) return lazy(s);
    assert(nodes[s], `Unknown selector ${s}`);
    return nodes[s];
  },
  querySelectorAll: (s) => (s === "[data-day]" ? days : s === "[data-mode]" ? modes : []),
  addEventListener: (t, f) => (listeners[t] = f),
  createElement: () => new Element(),
};
const sandbox = {
  document,
  window: { matchMedia: () => ({ matches: false }) },
  console,
  URLSearchParams,
  Blob,
  Response,
  DecompressionStream,
  fetch,
  atob,
  Date,
  URL: { createObjectURL: (b) => ((downloadBlob = b), "blob:test"), revokeObjectURL: () => {} },
  history: { replaceState: (a, b, c) => (lastHash = c) },
  navigator: { clipboard: { writeText: async () => {} } },
  location: {
    hash: "#time=08%3A00&day=all&activity=drive",
    href: "https://example.test/",
    protocol: "https:",
  },
  setInterval: (f) => {
    timers.set(++timerId, f);
    return timerId;
  },
  clearInterval: (id) => timers.delete(id),
  setTimeout: (f) => f(),
};
vm.createContext(sandbox);
const prefix = "window.AMERICAN_MINUTE_DATA=";
assert(dataJs.startsWith(prefix) && dataJs.endsWith(";\n"));
sandbox.window.AMERICAN_MINUTE_DATA = JSON.parse(dataJs.slice(prefix.length, -2));
vm.runInContext(fs.readFileSync(path.join(root, "dist/app.js"), "utf8"), sandbox);
const run = (s) => vm.runInContext(s, sandbox);
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

(async () => {
  await run("ready");
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
  assert(!/years=/.test(lastHash), "survey years are no longer part of the URL");

  change("sex", 1);
  change("kids", 1);
  assert.deepEqual({ ...run("state.filters") }, { sex: 1, kids: 1 });
  assert(nodes["#data-badge"].textContent.includes("diaries · 2003–2025"));
  assert.equal(nodes["#reset-filters"].hidden, false);
  assert(lastHash.includes("sex=1") && lastHash.includes("kids=1"));
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
  assert(lastHash.includes("activity=household_020102"));

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
  const trendBlob = downloadBlob;
  nodes["#download-snapshot"].listeners.click();
  const trend = await trendBlob.text(),
    snap = await downloadBlob.text();
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
