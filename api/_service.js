/* The calculation service: computes any view from the diaries with the page's own engine, so a
 * shared link or a filter change needs one small response instead of the 12 MB diary file.
 * Responses never change for a given deployment, so Vercel's CDN caches each one: every distinct
 * view is computed once. (Files starting with "_" are not routes.) */
const fs = require("node:fs"),
  path = require("node:path"),
  zlib = require("node:zlib");
const {
  buildEngine,
  computeEngine,
  exportView,
  exportDetail,
  hasContext,
} = require("../dist/engine.js");

const DIST = path.join(__dirname, "..", "dist");
let data, engine;

// Loaded once per server instance (about half a second), then reused across requests.
function load() {
  if (engine) return;
  const prefix = "window.AMERICAN_MINUTE_DATA=";
  const text = fs.readFileSync(path.join(DIST, "data.js"), "utf8");
  data = JSON.parse(text.slice(prefix.length, -2));
  const packed = zlib.gunzipSync(fs.readFileSync(path.join(DIST, data.diaryFile)));
  engine = buildEngine(
    data,
    packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength),
  );
}

// Strict parsing keeps the cache small: every view has exactly one valid URL shape.
function parse(url, kind) {
  const params = new URL(url, "http://localhost").searchParams;
  const filters = [...data.personFilters, ...data.episodeFilters];
  const allowed = new Set(["v", "day", ...filters.map((f) => f.id)]);
  allowed.add(kind === "detail" ? "activity" : "rows");
  for (const key of params.keys()) if (!allowed.has(key)) throw Error(`unknown parameter ${key}`);
  const state = {
    day: params.get("day"),
    from: data.years[0].year,
    to: data.years.at(-1).year,
    filters: {},
    selected: "sleep",
  };
  if (!["all", "weekday", "weekend"].includes(state.day)) throw Error("bad day");
  for (const f of filters) {
    if (!params.has(f.id)) continue;
    const v = params.get(f.id);
    if (!/^\d+$/.test(v) || +v >= f.options.length || (f.id === "where" && +v === 0))
      throw Error(`bad ${f.id}`);
    state.filters[f.id] = +v;
  }
  if (kind === "view") {
    state.rows = params.get("rows");
    if (!["main", "all"].includes(state.rows)) throw Error("bad rows");
  } else {
    const id = params.get("activity"),
      context = hasContext(state.filters);
    const valid =
      id === (context ? "context" : "awake") ||
      data.categories.some((c) => c.id === id) ||
      data.details.some((d) => d.id === id);
    if (!valid) throw Error("bad activity");
    state.selected = id;
  }
  return state;
}

function respond(kind, url) {
  load();
  const state = parse(url, kind);
  computeEngine(engine, data, state);
  if (kind === "detail") return exportDetail(engine, data, state);
  // "main" covers the overview (categories, Awake, and the context total); "all" adds every
  // detailed activity, for the detailed list and search.
  const ids = [
    ...data.categories.map((c) => c.id),
    "awake",
    ...(hasContext(state.filters) ? ["context"] : []),
    ...(state.rows === "all" ? data.details.map((d) => d.id) : []),
  ];
  return exportView(engine, ids);
}

function handler(kind) {
  return (req, res) => {
    let status = 200,
      body;
    try {
      body = JSON.stringify(respond(kind, req.url));
    } catch (e) {
      status = e instanceof Error && /^(unknown|bad) /.test(e.message) ? 400 : 500;
      body = JSON.stringify({ error: status === 400 ? e.message : "internal error" });
      if (status === 500) console.error(e);
    }
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // The URL carries the data version, so a response can be cached for good.
    res.setHeader(
      "Cache-Control",
      status === 200 ? "public, max-age=31536000, s-maxage=31536000, immutable" : "no-store",
    );
    res.end(body);
  };
}

module.exports = { handler, respond };
