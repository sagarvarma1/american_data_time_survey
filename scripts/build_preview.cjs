/* Precompute the first view and store it in dist/data.js, so the page draws without waiting for
 * anything else: every category, plus Awake, at every minute for each day type, without filters.
 * It is the same view the calculation service sends (api/_service.js), from the same engine.
 * build_data.py runs this. */
const fs = require("node:fs");
const { respond } = require("../api/_service.js");
const { dist } = require("./app-sandbox.cjs");

const prefix = "window.AMERICAN_MINUTE_DATA=";
const text = fs.readFileSync(dist("data.js"), "utf8");
const data = JSON.parse(text.slice(prefix.length, -2));
data.preview = Object.fromEntries(
  ["all", "weekday", "weekend"].map((day) => [day, respond("view", `/?day=${day}&rows=main`)]),
);
fs.writeFileSync(dist("data.js"), prefix + JSON.stringify(data) + ";\n");
console.log(`Preview: ${fs.statSync(dist("data.js")).size.toLocaleString()} bytes in data.js`);
