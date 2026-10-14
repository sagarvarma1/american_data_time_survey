# American Minute

A time-use explorer built from **every American Time Use Survey diary from 2003 to 2025**:
**258,954 diaries** and **4,994,172 activity records**. Pick any minute of the day and see what
people are doing, across all 23 years, by day type and any combination of filters.

## Open

Double-click `dist/index.html`, or open the self-contained `../american-minute.html`. No server,
network, external fonts, or package installation is required. It needs a current browser (gzip
`DecompressionStream`: Chrome/Edge 80+, Firefox 113+, Safari 16.4+). Optional HTTP preview:

```sh
python3 -m http.server 8080 --directory dist
```

## Interface

- A clock and timeline, with playback; sleeping, awake, and driving counts.
- All 23 survey years pooled (2003–2025), by **day type** (all days, weekdays, weekends).
- **People filters**: sex, age (seven bands), work status (full time, part time, unemployed, not in
  the labor force), and children at home (none, youngest under 6, youngest 6–17).
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

The browser does the arithmetic. `dist/data.js` holds the de-identified diaries in a compact,
gzip-compressed binary (about 16 MB). On load, the app groups episodes by activity, and each
filter change recomputes every curve in a single pass (about 50–70 ms on a laptop).

## Data

Download these from the [BLS 2003–2025 multi-year files page](https://www.bls.gov/tus/data/datafiles-0325.htm)
in a browser (bls.gov rejects command-line downloads) and put them, zipped or unzipped, in
`data/raw/bls-0325/`:

| File | Used for |
|---|---|
| `atusact-0325.zip` | Activities, durations, pooled codes, locations |
| `atussum-0325.zip` | Weights, year, day, age, sex, work status, children |
| `atuswho-0325.zip` | Who was present during each activity |
| `atusresp-0325.zip`, `atusrost-0325.zip` | Reference only (not needed by the build) |

If the downloads are still zipped, unzip each one into a folder of the same name, for example
`data/raw/bls-0325/atusact-0325/atusact_0325.dat`.

Activity names come from `data/activity-labels.csv` for 400 codes and
`data/harmonized-labels.csv` for 26 pooled codes that BLS created to keep categories consistent
across years (for example, `180782` combines the travel-for-shopping codes). The detail panel lists
what each harmonized code combines. Provenance and file hashes are in `data/PROVENANCE.json`.

## Reproduce and check

Python uses only the standard library. No npm dependencies.

```sh
python3 scripts/build_data.py     # ~1 min: writes dist/data.js and data/validation.json
python3 scripts/check_data.py     # ~1 min: independent checks; writes data/test-expectations.json
node --check dist/app.js
node scripts/check_app.cjs        # browser engine + UI flows, against those expectations
python3 scripts/package_local.py  # ../american-minute.html and ../american-minute-source.zip
```

What the checks cover:

- Every diary covers exactly 1,440 contiguous minutes, and every episode has a who-with record.
- All **96 hourly sleeping percentages** in BLS Table A-3 for 2021–2024 match to the published
  precision, and the published **2025 average of 9.03 hours of sleep** is reproduced.
- For eight filter scenarios (all years; 2020 weekends; 2003–05 weekday women; 2025 young full-time
  workers; parents of young children at home; weekends with friends; older adults alone; 2021–24),
  288 weighted snapshots are computed three ways and must agree: directly from the raw CSVs
  (start-time fields, raw location and companion codes, raw demographics), from the decoded binary
  in Python, and from the browser engine in `app.js`.
- Overview categories partition the selected population at every minute; detailed rows sum to their
  parents.
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

- **People filters** use the respondent’s answers for their diary day.
- **Work status:** one employed 2010 respondent has no full/part-time status and is counted as full
  time.
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

The existing private Site identity is retained in `.openai/hosting.json`. It has not been published,
and no deployment URL is claimed as live.
