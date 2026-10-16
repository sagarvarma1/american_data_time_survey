# American Minute

A time-use explorer built from **every American Time Use Survey diary from 2003 to 2025**:
**258,954 diaries** and **4,994,172 activity records**. Pick any minute of the day and see what
people are doing, across all 23 years, by day type and any combination of filters.

## Open

Open the self-contained `../american-minute.html` (double-click; no server or network needed:
it computes everything from the diaries it carries), or deploy the project to Vercel (see
[Hosting](#hosting)). It needs a current browser (gzip `DecompressionStream`: Chrome/Edge 80+,
Firefox 113+, Safari 16.4+). Serving `dist/` with a plain static server also works; without the
calculation service, the page quietly computes from the diary file instead.

```sh
python3 -m http.server 8080 --directory dist
```

## Interface

- A clock and timeline, with playback; sleeping, awake, and driving counts.
- All 23 survey years pooled (2003–2025), by **day type** (all days, weekdays, weekends).
- **People filters**: sex, age (seven bands), work status (full time, part time, unemployed, not in
  the labor force), and children at home (none, youngest under 6, youngest 6–17).
- **Advanced filters** (a panel under the main filters):
  - *Demographics:* age in 5-year groups, race, Hispanic or Latino origin, spouse or partner,
    marital status, citizenship, veteran, disability.
  - *Education:* attainment, school enrollment.
  - *Work:* labor force status, usual hours, number of jobs, class of worker, industry,
    occupation, weekly earnings quintile within each year, hourly pay.
  - *Household:* family income, size, number of children, youngest child, spouse or partner's
    work, eldercare.
  - *Place:* metropolitan area, region, state.
  - *Diary day:* day of the week, month, holiday, and a survey-year range.
- Every filter takes **several options at once** (any of them matches); different filters
  combine (all must match). Small groups get a note, and rows under 30 diaries are marked.
- **Activity-context filters**: where the activity happened (home, work, someone else’s home,
  restaurant, store, school, place of worship, gym/outdoors, driving, passenger, walking/biking,
  transit) and who the person was with (alone, spouse/partner, children, other family, friends,
  coworkers/customers, others).
- A searchable ranked list: 17 overview categories, or **690 detailed rows** covering all 426 pooled
  activity codes, split to separate reported driving from other contexts. Detailed rows partition
  their overview parents.
- For the selected activity: its curve across the day, **where people doing it are**, **who they’re
  with**, and **the same minute in every year from 2003 to 2025**.
- Light and dark themes follow the device setting. Everything is stored in the URL, and two CSV
  downloads export the current minute or the selected activity’s whole day.

## How it computes and loads

`dist/engine.js` turns diaries into curves. `dist/diaries/<hash>.bin` holds the de-identified
diaries in a compact, gzip-compressed binary (12 MB); the engine groups episodes by activity once,
then computes every curve for a day type and set of filters in a single pass (about 40 ms on a
laptop). The same engine runs in three places, fastest first:

1. **Precomputed first view.** `dist/data.js` (about 250 KB compressed) carries the metadata and
   the unfiltered overview for each day type: every category and Awake at every minute. The page
   draws from it immediately.
2. **Calculation service** (`api/`, Vercel functions). Anything else, such as a shared link with
   filters, a filter change, or the detailed list, is one request to `/api/view` (every curve for
   a day type and filters: about 40–80 KB compressed for the overview, 200–800 KB with all 690
   detailed activities, fetched only when the list shows them). The selected activity's location,
   company, and yearly trend come from `/api/detail` (about 110 KB), requested at the same time.
   URLs carry the data version, so responses are cached permanently by browsers and Vercel's CDN:
   each distinct view is computed once. Parameters are validated strictly, so the cache holds only
   valid views.
3. **The diaries themselves.** The standalone page computes locally, and if the service can't be
   reached, the website quietly downloads the diary file and does the same.

Views (1 and 2) send curves rounded to whole people, as the page displays them (breakdowns and
yearly trends to hundredths of a person), stored as minute-to-minute differences. Lists rank by
the rounded counts and CSV percentages follow them, so every source renders the same page; the
tests check this. Visitors never see a loading message.

## Data

Download these from the [BLS 2003–2025 multi-year files page](https://www.bls.gov/tus/data/datafiles-0325.htm)
in a browser (bls.gov rejects command-line downloads) and put them, zipped or unzipped, in
`data/raw/bls-0325/`:

| File | Used for |
|---|---|
| `atusact-0325.zip` | Activities, durations, pooled codes, locations |
| `atussum-0325.zip` | Weights, year, day, age, sex, work status, children |
| `atuswho-0325.zip` | Who was present during each activity |
| `atusresp-0325.zip` | Industry, occupation, class of worker, household size, eldercare, pay, month |
| `atuscps-0325.zip` | Family income, region, state, marital status, citizenship, veteran, disability |
| `atusrost-0325.zip` | Reference only (not needed by the build) |

If the downloads are still zipped, unzip each one into a folder of the same name, for example
`data/raw/bls-0325/atusact-0325/atusact_0325.dat`.

Activity names come from `data/activity-labels.csv` for 400 codes and
`data/harmonized-labels.csv` for 26 pooled codes that BLS created to keep categories consistent
across years (for example, `180782` combines the travel-for-shopping codes). The detail panel lists
what each harmonized code combines. Provenance and file hashes are in `data/PROVENANCE.json`.

## Reproduce and check

Python uses only the standard library. No npm dependencies.

```sh
python3 scripts/build_data.py     # ~1 min: writes the diary file, dist/data.js (runs
                                  # build_preview.cjs for the first view), data/validation.json
python3 scripts/check_data.py     # ~1 min: independent checks; writes data/test-expectations.json
node --check dist/engine.js && node --check dist/app.js
node scripts/check_app.cjs        # engine, service, and UI flows, against those expectations
python3 scripts/package_local.py  # ../american-minute.html and ../american-minute-source.zip
```

What the checks cover:

- Every diary covers exactly 1,440 contiguous minutes, and every episode has a who-with record.
- All **96 hourly sleeping percentages** in BLS Table A-3 for 2021–2024 match to the published
  precision, and the published **2025 average of 9.03 hours of sleep** is reproduced.
- Every diary's stored option for all 34 person filters matches a separate implementation that
  reads the raw BLS fields directly.
- For 21 filter scenarios (all years; 2020 weekends; 2003–05 weekday women; 2025 young full-time
  workers; parents of young children at home; weekends with friends; older adults alone; 2021–24;
  nine with advanced filters, several options at once, calendar filters, and year ranges; and four
  with income, region, state, marital status, citizenship, disability, and veteran status),
  756 weighted snapshots are computed three ways and must agree: directly from the raw CSVs
  (start-time fields, raw location and companion codes, raw demographics), from the decoded binary
  in Python, and from the engine in `engine.js`.
- Overview categories partition the selected population at every minute; detailed rows sum to their
  parents.
- The page renders the same from the calculation service as from the diaries: summary cards, list
  (overview and detailed), and the detail panel with its breakdowns and yearly trend, for 15
  states (every basic filter, and advanced, calendar, CPS, and year-range combinations), at six
  minutes each, in both units. Every label, number,
  percentage, and tooltip matches exactly; chart shapes agree within 0.1 of a 90–150-unit chart
  (a fraction of a pixel). Snapshot CSVs match byte for byte.
- The website never requests the diary file: the first view needs one request (the selected
  activity's extras), a filter or shared link needs a view and extras, and search reuses loaded
  rows. Every response is cacheable, malformed requests are refused, and with the service
  unavailable the page falls back to the diaries and renders identically.
- For 2021–2024, the new pipeline reproduces the previous edition (built from separate annual files)
  at every minute for all 17 categories and three day types: diary counts exactly, and people within
  0.6, which is float32 weight rounding.
- The app tests cover years, day types, all filters, context breakdowns, the years chart, deep links,
  search, pagination, drill-down, units, playback across midnight, dialogs, and both CSV formats.
  They use a minimal DOM in Node, not a real browser. Layout was checked with headless Chrome
  screenshots at desktop and 390 px widths, in light and dark themes.

## Calculations and interpretation

**Weights.** BLS’s pooling guidance and the multi-year data dictionary specify `TUFNWGTP` (the 2006
weighting method, comparable across all years) for every year except 2020, which uses `TU20FWGT`.
Weights are person-days. For each minute, the app sums the weights of matching people active at that
minute and divides by the number of days the 23 years represent, which gives an average
population count for the period. It does not scale results to today’s population.

**Days represented.** Calendar days, split into weekdays and weekend days, except for two years:

- **2020:** data collection stopped from March 18 to May 9, so 2020 represents 313 days.
- **2025:** BLS suspended collection from October 1 to November 12, then weighted the November 12–
  December 30 diaries to represent the whole fourth quarter, so 2025 represents all 365 days. BLS
  notes that the shutdown’s effect on estimates can’t be quantified.

All 23 years together represent 8,348 days.

**Episodes.** Episodes are placed with `TUCUMDUR24` (cumulative minutes since 4 AM). One 2016 diary
has a start-time typo (activity 9 of case 20161008161668 lists 14:10, while its stop time and
duration imply 14:20). The build logs it, and the cumulative position corrects it.

**Driving, sleep, and awake.**

- Driving (`TEWHERE=12`) takes precedence over the activity category.
- Sleep uses 010101 and 010199, excluding sleeplessness. The BLS benchmark checks include
  sleeplessness, matching BLS’s definition.
- Awake is the complement of sleep, including unclassified time.
- Secondary childcare and other multitasking are not included.

**Filters.**

- **People filters** use the respondent’s answers for their diary day (atussum and atusresp).
  Family income, region, state, marital status, citizenship, veteran status, and disability come
  from the ATUS-CPS file: the respondent’s row in their household’s final Current Population
  Survey interview, two to five months before the diary day, so a few may have changed since.
- **Family income** is in each year’s dollars (not adjusted for inflation), grouped from the
  CPS’s 16 bands. BLS moved it from `HUFAMINC` to `HEFAMINC` during 2010; before then about 13% of
  respondents didn’t report it ("Not reported"); afterwards it is fully edited. For comparisons
  across time, pair it with a narrower survey-year range.
- **Disability** questions began in mid-2008 and **veteran status** in 2005; earlier diaries are
  "Not asked". State samples are small for less populous states, even pooled over 23 years.
- **Work status:** one employed 2010 respondent has no full/part-time status and is counted as full
  time; their usual hours and number of jobs are "Not reported".
- **Race** categories other than "Two or more races" mean that race alone. **Occupation** follows
  BLS's major groups, whose census classification changed in 2011 and 2020, so occupations are
  not strictly comparable across all years.
- **Weekly earnings** cover wage and salary workers (BLS doesn't collect earnings for the
  self-employed), in quintiles computed within each survey year with the final weights, so they
  stay comparable without inflation adjustment and are unaffected by topcoding changes.
- **Eldercare** questions began in 2011; earlier diaries (and 148 later ones not asked) are "Not
  asked".
- **Calendar filters** (day of the week, month, holiday) change how many days are averaged over:
  each year's days of the chosen day type, times the share of that year's weight those filters
  select. Counts stay "people on an average such day" (e.g. an average Monday). With all seven
  weekdays selected this is exactly the unfiltered count; Monday–Friday comes within 0.2% of the
  weekday day type, which counts calendar days.
- **Survey years** default to all 23. A range keeps the yearly chart for every year, fading the
  years outside it.
- **Context filters** keep only matching activities. Every number on the page follows them. Sleep
  has no recorded location or company, so while one is on, the Sleeping and Awake cards are
  replaced by **everyone in that context** (e.g. everyone at a restaurant, doing anything), whose
  curve, company, and yearly trend can be explored like any activity.
- **What BLS doesn’t record:** location and company aren’t recorded for sleeping, grooming, or
  private activities, and company wasn’t recorded while working before 2010. Location codes 30–32
  (bank, gym, post office) start in October 2004.
- **Company shares** can add up to more than 100%, because someone can be with several groups at
  once.

**Uncertainty.**

- **Pooling:** combining years gives more observations but blends real changes over time, including
  the pandemic. The years chart shows each year separately.
- **Small samples:** the UI flags fewer than 30 observed diaries. This is a caution rule, not an
  official BLS suppression standard, and narrow filter combinations reach it quickly.
- **No confidence intervals:** replicate-weight uncertainty has not been calculated. BLS publishes a
  293 MB replicate-weights file that would make it possible.
- **Precision:** the one-minute interface does not imply one-minute measurement accuracy in recalled
  diaries.

This is an independent educational visualization, not real-time tracking or an official BLS product.

## Privacy

The deployed data contains public-use diary episodes with no case identifiers, only weights, survey
year, day type, the four demographic groups, and each episode’s duration, activity, location group,
and companion groups. BLS publishes far more detail in the same public-use files.

## Hosting

Deployed on Vercel at [americantimeuse.com](https://americantimeuse.com). `vercel.json` serves
`dist/` with no build step, deploys `api/view.js` and `api/detail.js` as functions (bundling the
diary file, `data.js`, and `engine.js`), and caches `dist/diaries/` permanently. Every push to
`main` redeploys, and Vercel clears its CDN cache for the new deployment. A new server instance
loads the diaries in about half a second; later requests take about 50–150 ms, and cached ones
none.

The link preview (`dist/og.png`, 1200×630 at 2×) uses real numbers for 5:30 PM on a weekday. The
Open Graph and Twitter tags in `dist/index.html` point to it by absolute URL, so update them if the
domain changes. The card is rendered from `scripts/og-card.html` with headless Chrome.
