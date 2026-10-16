/* Runs dist/engine.js and dist/app.js in Node with a minimal DOM, for check_app.cjs. Requests
 * to api/ go straight to the calculation service's handlers; other paths read dist/. */
const fs = require("node:fs"),
  vm = require("node:vm"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const root = path.resolve(__dirname, "..");
const dist = (file) => path.join(root, "dist", file);

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.listeners = {};
    this.attributes = {};
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
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

function loadApp({ hash = "", service = true } = {}) {
  const html = fs.readFileSync(dist("index.html"), "utf8");
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const dynamic = ["trend-chart", "drill-down", "awake-about", "download-trend"];
  const nodes = Object.fromEntries([...ids, ...dynamic].map((id) => ["#" + id, new Element()]));
  const days = ["all", "weekday", "weekend"].map((day) => new Element({ day }));
  const modes = ["overview", "detail"].map((mode) => new Element({ mode }));
  const lazy = (s) => (nodes[s] ??= new Element());
  const listeners = {},
    timers = new Map(),
    out = { downloadBlob: null, lastHash: null, fetched: [], responses: [] };
  let timerId = 0;
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
    TransformStream,
    DecompressionStream,
    fetch: async (url) => {
      out.fetched.push(url);
      if (!url.startsWith("api/")) return new Response(fs.readFileSync(dist(url)));
      if (!service) return new Response("unavailable", { status: 503 });
      const res = {
        setHeader: (k, v) => ((res.headers ??= {})[k] = v),
        end: (b) => (res.body = b),
      };
      require(path.join(root, url.slice(0, url.indexOf("?")) + ".js"))({ url: "/" + url }, res);
      out.responses.push({ url, bytes: res.body.length, headers: res.headers });
      return new Response(res.body, { status: res.statusCode });
    },
    atob,
    Date,
    URL: {
      createObjectURL: (b) => ((out.downloadBlob = b), "blob:test"),
      revokeObjectURL: () => {},
    },
    history: { replaceState: (a, b, c) => (out.lastHash = c) },
    navigator: { clipboard: { writeText: async () => {} } },
    location: { hash, href: "https://example.test/", protocol: "https:" },
    setInterval: (f) => {
      timers.set(++timerId, f);
      return timerId;
    },
    clearInterval: (id) => timers.delete(id),
    setTimeout: (f) => f(),
  };
  vm.createContext(sandbox);
  const dataJs = fs.readFileSync(dist("data.js"), "utf8");
  const prefix = "window.AMERICAN_MINUTE_DATA=";
  assert(dataJs.startsWith(prefix) && dataJs.endsWith(";\n"));
  sandbox.window.AMERICAN_MINUTE_DATA = JSON.parse(dataJs.slice(prefix.length, -2));
  for (const file of ["engine.js", "app.js"])
    vm.runInContext(fs.readFileSync(dist(file), "utf8"), sandbox, { filename: file });
  const run = (s) => vm.runInContext(s, sandbox);
  return { html, ids, nodes, days, modes, listeners, timers, out, sandbox, run };
}

module.exports = { loadApp, root, dist };
