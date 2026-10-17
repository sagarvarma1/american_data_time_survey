/* Static, crawlable pages with the numbers in the HTML: one per activity category, one per hour,
 * and an FAQ, plus the homepage's "Explore" section, sitemap.xml, and robots.txt.
 *
 * Search and AI crawlers that don't run JavaScript (GPTBot, ClaudeBot, PerplexityBot) only see a
 * page's HTML, and the app draws its numbers with JavaScript. These pages answer common questions
 * directly, from the same engine and views as the app (api/_service.js), so their numbers match
 * it. build_data.py runs this after build_preview.cjs. */
const fs = require("node:fs"),
  path = require("node:path");
const { respond } = require("../api/_service.js");
const { DAY } = require("../dist/engine.js");

const SITE = "https://www.americantimeuse.com";
const DIST = path.join(__dirname, "..", "dist");
const prefix = "window.AMERICAN_MINUTE_DATA=";
const data = JSON.parse(
  fs.readFileSync(path.join(DIST, "data.js"), "utf8").slice(prefix.length, -2),
);
const first = data.years[0].year,
  last = data.years.at(-1).year;
const diaries = data.diaries.toLocaleString("en-US");

// ---- Numbers, from the calculation service's views ----
function unpack(curve) {
  const out = new Array(DAY);
  for (let m = 0, v = 0; m < DAY; m++) out[m] = v += curve[m];
  return out;
}

function view(query) {
  const v = respond("view", `/?${query}`);
  const rows = Object.fromEntries(v.ids.map((id, i) => [id, unpack(v.people[i])]));
  return { population: v.population, sample: v.sample, rows };
}

const days = { weekday: view("day=weekday&rows=all"), weekend: view("day=weekend&rows=all") };
const all = view("day=all&rows=all");
const share = (v, id, m) => v.rows[id][m] / v.population;
const hoursPerDay = (v, id) => v.rows[id].reduce((s, p) => s + p, 0) / v.population / 60;
// Peaks are reported on quarter hours: minute-level peaks (2:59 AM) read as false precision.
const peak = (v, id, from = 0, to = DAY) => {
  let best = Math.ceil(from / 15) * 15;
  for (let m = best; m < to; m += 15) if (v.rows[id][m] > v.rows[id][best]) best = m;
  return best;
};

// ---- Formatting ----
const time = (m) => {
  const h = Math.floor(m / 60) % 24;
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const hourName = (h) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
const hourSlug = (h) => `${h % 12 || 12}-${h < 12 ? "am" : "pm"}`;
const iso = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const pct = (x) => (x > 0 && x < 0.001 ? "<0.1%" : (x * 100).toFixed(1) + "%");
const millions = (n) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)} million`
    : n >= 1000
      ? `${Math.round(n / 1000).toLocaleString("en-US")},000`
      : "fewer than 1,000";
const hours = (h) => {
  const whole = Math.floor(h),
    min = Math.round((h - whole) * 60);
  return whole ? `${whole} hr ${String(min).padStart(2, "0")} min` : `${min} min`;
};
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const app = (params) => `/#${new URLSearchParams(params)}`;

// How each category reads in a sentence ("…are <doing> at 3 PM"), and its question.
const CATEGORY = {
  sleep: ["asleep", "When do Americans sleep?"],
  work: ["working", "When do Americans work?"],
  leisure: ["relaxing or socializing", "When do Americans relax and socialize?"],
  household: ["doing household tasks", "When do Americans do housework and chores?"],
  eat: ["eating or drinking", "When do Americans eat?"],
  drive: ["driving", "When are Americans driving?"],
  care: ["caring for others", "When do Americans care for children and others?"],
  personal: ["on personal care", "When do Americans shower, groom, and get ready?"],
  education: ["in class or studying", "When do Americans study and go to class?"],
  shop: ["shopping or using services", "When do Americans go shopping?"],
  exercise: ["exercising or playing sports", "When do Americans exercise?"],
  travel: ["traveling, other than driving", "When are Americans on the move (not driving)?"],
  religion: ["at religious activities", "When do Americans attend religious services?"],
  volunteer: ["volunteering", "When do Americans volunteer?"],
  civic: ["on civic activities", "When do Americans do civic duties?"],
  communication: ["on calls, mail, or messages", "When do Americans make calls and send messages?"],
};
const categories = data.categories.filter((c) => CATEGORY[c.id]);
const label = Object.fromEntries([...data.categories, ...data.details].map((a) => [a.id, a.label]));

// ---- Page shell ----
const PAGES = []; // [url path, file, lastmod]
function page({ url, title, description, h1, body, crumbs, schema = [] }) {
  const canonical = SITE + url;
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [{ name: "American Minute", url: "/" }, ...crumbs].map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: SITE + c.url,
    })),
  };
  const ld = [breadcrumb, ...schema].map(
    (o) =>
      `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`,
  );
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${canonical}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="American Minute" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:image" content="${SITE}/og.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="stylesheet" href="/styles.css" />
    ${ld.join("\n    ")}
  </head>
  <body>
    <div class="app-shell article">
      <header>
        <a class="brand" href="/"><span class="brand-icon" aria-hidden="true">◷</span>american minute<span>.</span></a>
        <div class="header-actions"><a class="text-button" href="/">Open the explorer ↗</a></div>
      </header>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${crumbs
        .map((c, i) =>
          i === crumbs.length - 1
            ? ` / <span>${esc(c.name)}</span>`
            : ` / <a href="${c.url}">${esc(c.name)}</a>`,
        )
        .join("")}</nav>
      <main>
        <h1>${esc(h1)}</h1>
        ${body}
        <section class="method">
          <h2>About these numbers</h2>
          <p>
            Estimates come from all ${diaries} diaries in the
            <a href="https://www.bls.gov/tus/">American Time Use Survey</a> (Bureau of Labor
            Statistics and Census Bureau), ${first}–${last}, weighted to the U.S. civilian
            population age 15 and older and pooled across years. Times are local clock time. Counts
            are people on an average day of that type, not a live count. Weekdays are Monday–Friday.
            <a href="/faq">How the estimates work</a>.
          </p>
        </section>
      </main>
      <footer><span>Based on the American Time Use Survey · U.S. Census Bureau / BLS</span><a class="text-button" href="/">Explore any minute ↗</a></footer>
    </div>
  </body>
</html>
`;
}

function write(url, html) {
  const file = path.join(DIST, url.slice(1) + ".html");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  PAGES.push(url);
}

// Two curves (weekday solid, weekend dashed) as an inline SVG, so the chart is in the HTML.
function chart(id, color, name) {
  const w = 600,
    h = 160;
  const max = Math.max(...["weekday", "weekend"].map((d) => share(days[d], id, peak(days[d], id))));
  const line = (d) =>
    Array.from({ length: DAY / 5 + 1 }, (_, i) => {
      const m = Math.min(i * 5, DAY - 1);
      return `${((m / (DAY - 1)) * w).toFixed(1)},${(h - (share(days[d], id, m) / max) * (h - 8)).toFixed(1)}`;
    }).join(" ");
  const ticks = [0, 6, 12, 18, 24]
    .map((t) => `<span>${t === 24 ? "12 AM" : hourName(t)}</span>`)
    .join("");
  return `
        <figure class="page-chart">
          <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Share of Americans ${esc(name)} across the day: weekdays (solid) and weekends (dashed); highest ${pct(max)}.">
            <polyline points="${line("weekday")}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
            <polyline points="${line("weekend")}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="5 4" opacity=".7" vector-effect="non-scaling-stroke"/>
          </svg>
          <div class="trend-ticks">${ticks}</div>
          <figcaption>Share of Americans ${esc(name)}, by local time. Solid: weekdays. Dashed: weekends. Scale: 0–${pct(max)}.</figcaption>
        </figure>`;
}

// ---- Activity pages ----
function activityPage(c) {
  const [doing, question] = CATEGORY[c.id];
  const wd = days.weekday,
    we = days.weekend;
  const pw = peak(wd, c.id),
    pe = peak(we, c.id);
  const daily = hoursPerDay(all, c.id);
  const children = data.details
    .filter((d) => d.parent === c.id)
    .map((d) => ({ id: d.id, h: hoursPerDay(wd, d.id) }))
    .filter((d) => d.h >= 1 / 60)
    .sort((a, b) => b.h - a.h)
    .slice(0, 8);
  const lead =
    `On an average weekday, the share of Americans ${doing} peaks at ${time(pw)}, when ` +
    `${pct(share(wd, c.id, pw))} of people age 15 and older (about ${millions(wd.rows[c.id][pw])}) ` +
    `are ${doing}. On weekends it peaks at ${time(pe)} (${pct(share(we, c.id, pe))}). Averaged over ` +
    `all days, Americans spend ${hours(daily)} a day ${doing}.`;
  const rows = Array.from({ length: 24 }, (_, h) => {
    const m = h * 60;
    return `<tr><th scope="row"><a href="/hours/${hourSlug(h)}">${hourName(h)}</a></th><td>${pct(share(wd, c.id, m))}</td><td>${millions(wd.rows[c.id][m])}</td><td>${pct(share(we, c.id, m))}</td><td>${millions(we.rows[c.id][m])}</td></tr>`;
  }).join("\n            ");
  const body = `
        <p class="lead">${lead}</p>
        <p><a class="outline-button" href="${app({ time: iso(pw), day: "weekday", activity: c.id })}">See ${esc(c.label.toLowerCase())} minute by minute ↗</a></p>
        ${chart(c.id, c.color, doing)}
        <section>
          <h2>${esc(c.label)} by hour</h2>
          <p>Share and number of Americans ${doing} at the top of each hour.</p>
          <div class="table-wrap"><table>
            <thead><tr><th scope="col">Time</th><th scope="col">Weekdays</th><th scope="col">People</th><th scope="col">Weekends</th><th scope="col">People</th></tr></thead>
            <tbody>
            ${rows}
            </tbody>
          </table></div>
        </section>
        ${
          children.length > 1
            ? `<section>
          <h2>What it includes</h2>
          <p>Average time per weekday, for the activities in this group that take the most time.</p>
          <ul class="facts">${children
            .map((d) => `<li><strong>${esc(label[d.id])}</strong>: ${hours(d.h)} a day</li>`)
            .join("")}</ul>
        </section>`
            : ""
        }
        <section>
          <h2>More</h2>
          <ul class="link-grid">${categories
            .filter((o) => o.id !== c.id)
            .map((o) => `<li><a href="/activities/${o.id}">${esc(CATEGORY[o.id][1])}</a></li>`)
            .join("")}</ul>
        </section>`;
  write(
    `/activities/${c.id}`,
    page({
      url: `/activities/${c.id}`,
      title: `${question} Hour-by-Hour Data | American Minute`,
      description: lead.slice(0, 155).replace(/\s\S*$/, "") + "…",
      h1: question,
      body,
      crumbs: [
        { name: "Activities", url: "/activities" },
        { name: c.label, url: `/activities/${c.id}` },
      ],
    }),
  );
}

// ---- Hour pages ----
function hourPage(h) {
  const m = h * 60,
    wd = days.weekday,
    we = days.weekend;
  const ranked = categories
    .map((c) => ({ c, w: share(wd, c.id, m), e: share(we, c.id, m) }))
    .sort((a, b) => b.w - a.w);
  const top = data.details
    .map((d) => ({ d, p: wd.rows[d.id][m] }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 10);
  const [a, b, c] = ranked;
  const lead =
    `At ${hourName(h)} on an average weekday, ${pct(a.w)} of Americans age 15 and older are ` +
    `${CATEGORY[a.c.id][0]}, ${pct(b.w)} are ${CATEGORY[b.c.id][0]}, and ${pct(c.w)} are ` +
    `${CATEGORY[c.c.id][0]}. ${pct(share(wd, "drive", m))} (about ${millions(wd.rows.drive[m])}) are driving.`;
  const body = `
        <p class="lead">${lead}</p>
        <p><a class="outline-button" href="${app({ time: iso(m), day: "weekday" })}">Explore ${hourName(h)} by age, work, income, and more ↗</a></p>
        <section>
          <h2>Everything Americans are doing at ${hourName(h)}</h2>
          <div class="table-wrap"><table>
            <thead><tr><th scope="col">Activity</th><th scope="col">Weekdays</th><th scope="col">People</th><th scope="col">Weekends</th></tr></thead>
            <tbody>
            ${ranked
              .map(
                ({ c, w, e }) =>
                  `<tr><th scope="row"><a href="/activities/${c.id}">${esc(c.label)}</a></th><td>${pct(w)}</td><td>${millions(wd.rows[c.id][m])}</td><td>${pct(e)}</td></tr>`,
              )
              .join("\n            ")}
            </tbody>
          </table></div>
        </section>
        <section>
          <h2>The ten most common activities at ${hourName(h)} on weekdays</h2>
          <ol class="facts">${top
            .map(
              ({ d, p }) =>
                `<li><strong>${esc(d.label)}</strong>: about ${millions(p)} people (${pct(p / wd.population)})</li>`,
            )
            .join("")}</ol>
        </section>
        <nav class="hour-nav" aria-label="Other hours">
          <a href="/hours/${hourSlug((h + 23) % 24)}">← ${hourName((h + 23) % 24)}</a>
          <a href="/hours">All hours</a>
          <a href="/hours/${hourSlug((h + 1) % 24)}">${hourName((h + 1) % 24)} →</a>
        </nav>`;
  write(
    `/hours/${hourSlug(h)}`,
    page({
      url: `/hours/${hourSlug(h)}`,
      title: `What Are Americans Doing at ${hourName(h)}? | American Minute`,
      description: lead.slice(0, 155).replace(/\s\S*$/, "") + "…",
      h1: `What are Americans doing at ${hourName(h)}?`,
      body,
      crumbs: [
        { name: "Hours", url: "/hours" },
        { name: hourName(h), url: `/hours/${hourSlug(h)}` },
      ],
    }),
  );
}

// ---- Index pages and FAQ ----
function indexPages() {
  write(
    "/activities",
    page({
      url: "/activities",
      title: "When Do Americans Do Things? Activities by Time of Day | American Minute",
      description: `When Americans sleep, work, eat, drive, exercise, and more, hour by hour, from ${diaries} American Time Use Survey diaries.`,
      h1: "When Americans do things",
      body: `
        <p class="lead">Each page shows when an activity happens across the day, on weekdays and weekends, with hour-by-hour numbers from ${diaries} time diaries (${first}–${last}).</p>
        <ul class="link-grid">${categories
          .map(
            (c) =>
              `<li><a href="/activities/${c.id}">${esc(CATEGORY[c.id][1])}</a> <span>${hours(hoursPerDay(all, c.id))} a day</span></li>`,
          )
          .join("")}</ul>`,
      crumbs: [{ name: "Activities", url: "/activities" }],
    }),
  );
  write(
    "/hours",
    page({
      url: "/hours",
      title: "What Are Americans Doing at Each Hour of the Day? | American Minute",
      description: `What Americans are doing at every hour, from midnight to 11 PM, from ${diaries} American Time Use Survey diaries.`,
      h1: "What Americans are doing at each hour",
      body: `
        <p class="lead">The most common activities at every hour of an average weekday and weekend, from ${diaries} time diaries (${first}–${last}).</p>
        <ul class="link-grid hours">${Array.from({ length: 24 }, (_, h) => {
          const m = h * 60,
            topCat = categories.reduce((b, c) =>
              share(days.weekday, c.id, m) > share(days.weekday, b.id, m) ? c : b,
            );
          return `<li><a href="/hours/${hourSlug(h)}">${hourName(h)}</a> <span>${pct(share(days.weekday, topCat.id, m))} ${CATEGORY[topCat.id][0]}</span></li>`;
        }).join("")}</ul>`,
      crumbs: [{ name: "Hours", url: "/hours" }],
    }),
  );
}

// The minute in a window when a curve first crosses half of the population (bedtime, waking).
function crossing(v, id, from, to, above) {
  for (let i = from; i < to; i++) {
    const m = i % DAY;
    if (share(v, id, m) >= 0.5 === above) return m;
  }
  return null;
}

function faqPage() {
  const wd = days.weekday,
    we = days.weekend;
  const bed = crossing(wd, "sleep", 18 * 60, DAY + 4 * 60, true),
    wake = crossing(wd, "sleep", 4 * 60, 12 * 60, false);
  const bedWe = crossing(we, "sleep", 18 * 60, DAY + 4 * 60, true),
    wakeWe = crossing(we, "sleep", 4 * 60, 12 * 60, false);
  const lunch = peak(wd, "eat", 11 * 60, 14 * 60),
    dinner = peak(wd, "eat", 17 * 60, 21 * 60);
  const rushAm = peak(wd, "drive", 5 * 60, 10 * 60),
    rushPm = peak(wd, "drive", 15 * 60, 19 * 60);
  const tv = "leisure_120303";
  const atWork = peak(wd, "work");
  const qa = [
    [
      "What time do most Americans go to bed?",
      `On weeknights, more than half of Americans age 15 and older are asleep by ${time(bed)}. ${bedWe === bed ? "Weekends are the same." : `On weekends the halfway point comes at ${time(bedWe)}.`}`,
    ],
    [
      "What time do most Americans wake up?",
      `On weekdays, fewer than half are still asleep after ${time(wake)}. On weekends, people sleep in: the halfway point is ${time(wakeWe)}.`,
    ],
    [
      "How much do Americans sleep?",
      `Americans spend ${hours(hoursPerDay(all, "sleep"))} a day asleep on average (${hours(hoursPerDay(wd, "sleep"))} on weekdays and ${hours(hoursPerDay(we, "sleep"))} on weekends), counting naps and excluding time lying awake.`,
    ],
    [
      "How many Americans are asleep at 3 AM?",
      `About ${millions(wd.rows.sleep[180])} people, or ${pct(share(wd, "sleep", 180))} of Americans age 15 and older, on an average weekday at 3 AM.`,
    ],
    [
      "What time do Americans eat lunch and dinner?",
      `Eating peaks at ${time(lunch)} for lunch (${pct(share(wd, "eat", lunch))} of people eating) and at ${time(dinner)} for dinner (${pct(share(wd, "eat", dinner))}) on weekdays.`,
    ],
    [
      "When is rush hour?",
      `The share of Americans driving peaks at ${time(rushAm)} in the morning (${pct(share(wd, "drive", rushAm))}) and at ${time(rushPm)} in the afternoon (${pct(share(wd, "drive", rushPm))}, about ${millions(wd.rows.drive[rushPm])} drivers) on weekdays.`,
    ],
    [
      "When are the most Americans at work?",
      `On weekdays, work peaks at ${time(atWork)}, when ${pct(share(wd, "work", atWork))} of Americans age 15 and older (about ${millions(wd.rows.work[atWork])}) are working.`,
    ],
    [
      "How much TV do Americans watch?",
      `Americans age 15 and older spend ${hours(hoursPerDay(all, tv))} a day watching TV and movies on average, ${hours(hoursPerDay(wd, tv))} on weekdays and ${hours(hoursPerDay(we, tv))} on weekends.`,
    ],
    [
      "How many Americans are driving right now?",
      `It depends on the time: at 8 AM on a weekday, about ${millions(wd.rows.drive[480])}; at 5 PM, about ${millions(wd.rows.drive[1020])}; at 3 AM, about ${millions(wd.rows.drive[180])}. American Minute shows the estimate for your local time.`,
    ],
    [
      "Where do these numbers come from?",
      `From the American Time Use Survey, in which the Census Bureau interviews thousands of Americans each year about everything they did over one day, minute by minute, for the Bureau of Labor Statistics. American Minute pools all ${diaries} diaries from ${first} to ${last}, weighted to represent the U.S. civilian population age 15 and older. Estimates are for an average day, not a live count.`,
    ],
    [
      "Can I filter by age, income, race, or state?",
      `Yes. The explorer filters by sex, age, work status, children, race, Hispanic origin, education, earnings, family income, occupation, industry, marital status, region, state, day of the week, month, and more, and by where people were and who they were with.`,
    ],
  ];
  const faq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: qa.map(([q, a]) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };
  write(
    "/faq",
    page({
      url: "/faq",
      title: "When Do Americans Sleep, Eat, Work, and Drive? FAQ | American Minute",
      description: `What time Americans go to bed, wake up, eat, and drive, and how much they sleep and watch TV, from ${diaries} American Time Use Survey diaries.`,
      h1: "Questions about how Americans spend their day",
      body: `
        ${qa.map(([q, a]) => `<section><h2>${esc(q)}</h2><p>${esc(a)}</p></section>`).join("\n        ")}`,
      crumbs: [{ name: "FAQ", url: "/faq" }],
      schema: [faq],
    }),
  );
}

// ---- Homepage: a crawlable "Explore" section and dataset markup ----
function homepage() {
  const file = path.join(DIST, "index.html");
  let html = fs.readFileSync(file, "utf8");
  const wd = days.weekday;
  const explore = `<!-- explore:start (generated by scripts/build_pages.cjs) -->
      <section class="explore" aria-labelledby="explore-title">
        <h2 id="explore-title">Explore how Americans spend their day</h2>
        <p>
          At 3 PM on an average weekday, ${pct(share(wd, "work", 900))} of Americans age 15 and
          older are working and ${pct(share(wd, "sleep", 900))} are asleep; at 3 AM,
          ${pct(share(wd, "sleep", 180))} are asleep. Americans sleep
          ${hours(hoursPerDay(all, "sleep"))} a day on average. Every number comes from ${diaries}
          American Time Use Survey diaries, ${first}–${last}.
        </p>
        <div class="explore-columns">
          <div>
            <h3>By activity</h3>
            <ul>${categories.map((c) => `<li><a href="/activities/${c.id}">${esc(CATEGORY[c.id][1])}</a></li>`).join("")}</ul>
          </div>
          <div>
            <h3>By time of day</h3>
            <ul class="hours">${Array.from({ length: 24 }, (_, h) => `<li><a href="/hours/${hourSlug(h)}">${hourName(h)}</a></li>`).join("")}</ul>
            <h3>Questions</h3>
            <ul><li><a href="/faq">When do Americans go to bed, eat, and drive?</a></li></ul>
          </div>
        </div>
      </section>
      <!-- explore:end -->`;
  html = html.replace(/<!-- explore:start[\s\S]*?<!-- explore:end -->/, explore);
  const dataset = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        name: "American Minute",
        url: SITE + "/",
        description:
          "An explorer of what Americans do, minute by minute, from the American Time Use Survey.",
      },
      {
        "@type": "Dataset",
        name: `What Americans do, minute by minute (American Time Use Survey, ${first}–${last})`,
        description: `Weighted estimates of how many Americans age 15 and older are doing each of 426 activities at every minute of an average day, from all ${diaries} American Time Use Survey diaries (${first}–${last}), by day type, demographics, work, income, place, and company.`,
        url: SITE + "/",
        isBasedOn: data.source,
        creator: { "@type": "Organization", name: "American Minute", url: SITE + "/" },
        temporalCoverage: `${first}/${last}`,
        spatialCoverage: { "@type": "Place", name: "United States" },
        variableMeasured: ["Activity", "Time of day", "Estimated people", "Share of population"],
        keywords: ["American Time Use Survey", "ATUS", "time use", "daily life", "BLS"],
        isAccessibleForFree: true,
      },
    ],
  };
  html = html.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>|(?=\s*<link rel="icon")/,
    `<script type="application/ld+json">${JSON.stringify(dataset).replace(/</g, "\\u003c")}</script>`,
  );
  if (!html.includes("explore:start"))
    throw Error("index.html needs <!-- explore:start --><!-- explore:end -->");
  fs.writeFileSync(file, html);
}

// ---- Run ----
for (const c of categories) activityPage(c);
for (let h = 0; h < 24; h++) hourPage(h);
indexPages();
faqPage();
homepage();
const today = new Date().toISOString().slice(0, 10);
const urls = ["/", ...PAGES].map(
  (u) => `  <url><loc>${SITE}${u === "/" ? "/" : u}</loc><lastmod>${today}</lastmod></url>`,
);
fs.writeFileSync(
  path.join(DIST, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
);
// Everyone, including AI crawlers, is welcome; the API isn't for crawling.
fs.writeFileSync(
  path.join(DIST, "robots.txt"),
  `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`,
);
console.log(`Pages: ${PAGES.length} static pages, sitemap.xml, robots.txt`);
