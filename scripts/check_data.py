"""Check dist/data.js and the diary file against the raw BLS files and write expectations for the app tests.

1. Decode the packed diary file in Python and validate its contract.
2. Recompute weighted snapshots directly from the raw CSVs (start times, raw TEWHERE and
   TUWHO_CODE values, raw demographics), independent of the packed encoding.
3. Recompute the same snapshots from the decoded diary file and require agreement.
4. Write data/test-expectations.json, which scripts/check_app.cjs compares to the browser engine.
"""

import array
import csv
import gzip
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/bls-0325"
MINUTES = (0, 240, 450, 720, 1125, 1439)
KEYS = ("sleep", "drive", "work", "household_020102", "leisure_120303", "travel_180782")
TYPO_CASE = "20161008161668"  # one start-time typo; positions follow TUCUMDUR24

# Each scenario: years, day type, and filters as lists of option indexes (any matches).
SCENARIOS = {
    "everyone": {"years": [2003, 2025], "day": "all"},
    "covid-2020-weekend": {"years": [2020, 2020], "day": "weekend"},
    "early-weekday-women": {"years": [2003, 2005], "day": "weekday", "sex": [1]},
    "2025-young-full-time": {"years": [2025, 2025], "day": "all", "age": [1], "employment": [0]},
    "2010s-young-kids-at-home": {"years": [2010, 2019], "day": "all", "kids": [1], "where": [1]},
    "weekend-with-friends": {"years": [2003, 2025], "day": "weekend", "who": [4]},
    "retired-age-alone": {"years": [2015, 2025], "day": "weekday", "age": [5], "who": [0]},
    "post-pandemic": {"years": [2021, 2024], "day": "all"},
    # Advanced filters, several options at once, and calendar filters.
    "black-graduates": {"years": [2003, 2025], "day": "all", "race": [1], "education": [4, 5, 6]},
    "hispanic-two-jobs": {
        "years": [2003, 2025],
        "day": "weekday",
        "hispanic": [0],
        "multiplejobs": [0],
    },
    "long-hours-at-work": {"years": [2015, 2025], "day": "all", "hours": [5, 6], "where": [2]},
    "top-earners-young-kids": {
        "years": [2003, 2025],
        "day": "all",
        "earnings": [4],
        "youngest": [1, 2],
        "who": [2],
    },
    "rural-retirees": {
        "years": [2003, 2025],
        "day": "all",
        "metro": [1],
        "laborforce": [4],
        "age5": [10, 11, 12, 13],
    },
    "december-mondays": {"years": [2003, 2025], "day": "all", "weekday": [0], "month": [11]},
    "holiday-eldercare": {"years": [2011, 2025], "day": "all", "holiday": [1], "eldercare": [0]},
    # Filters from the ATUS-CPS file.
    "high-income-west": {"years": [2010, 2025], "day": "all", "income": [6, 7], "region": [3]},
    "texas-california-never-married": {
        "years": [2003, 2025],
        "day": "weekday",
        "state": ["Texas", "California"],
        "marital": [5],
    },
    "immigrants-with-disability": {
        "years": [2009, 2025],
        "day": "all",
        "citizenship": [3, 4],
        "disability": [0],
    },
    "older-veterans-low-income": {
        "years": [2005, 2025],
        "day": "all",
        "veteran": [0],
        "age5": [10, 11, 12, 13],
        "income": [0, 1, 8],
    },
    "public-sector-students": {
        "years": [2003, 2025],
        "day": "weekday",
        "worker": [0, 1, 2],
        "enrolled": [1],
        "industry": [9, 12],
        "occupation": [1],
        "paytype": [1],
    },
    "big-households-partnered": {
        "years": [2003, 2025],
        "day": "weekend",
        "household": [4, 5],
        "children": [3, 4],
        "partner": [1],
        "partnerwork": [0],
    },
}
CALENDAR = {"weekday", "month", "holiday"}
# State options are alphabetical; scenarios name states, converted to indexes below.
STATE_FIPS = {
    "Alabama": 1,
    "Alaska": 2,
    "Arizona": 4,
    "Arkansas": 5,
    "California": 6,
    "Colorado": 8,
    "Connecticut": 9,
    "Delaware": 10,
    "District of Columbia": 11,
    "Florida": 12,
    "Georgia": 13,
    "Hawaii": 15,
    "Idaho": 16,
    "Illinois": 17,
    "Indiana": 18,
    "Iowa": 19,
    "Kansas": 20,
    "Kentucky": 21,
    "Louisiana": 22,
    "Maine": 23,
    "Maryland": 24,
    "Massachusetts": 25,
    "Michigan": 26,
    "Minnesota": 27,
    "Mississippi": 28,
    "Missouri": 29,
    "Montana": 30,
    "Nebraska": 31,
    "Nevada": 32,
    "New Hampshire": 33,
    "New Jersey": 34,
    "New Mexico": 35,
    "New York": 36,
    "North Carolina": 37,
    "North Dakota": 38,
    "Ohio": 39,
    "Oklahoma": 40,
    "Oregon": 41,
    "Pennsylvania": 42,
    "Rhode Island": 44,
    "South Carolina": 45,
    "South Dakota": 46,
    "Tennessee": 47,
    "Texas": 48,
    "Utah": 49,
    "Vermont": 50,
    "Virginia": 51,
    "Washington": 53,
    "West Virginia": 54,
    "Wisconsin": 55,
    "Wyoming": 56,
}
STATE_NAMES = sorted(STATE_FIPS)
for _s in SCENARIOS.values():
    if "state" in _s:
        _s["state"] = sorted(STATE_NAMES.index(name) for name in _s["state"])


def load_data():
    text = (ROOT / "dist/data.js").read_text()
    prefix = "window.AMERICAN_MINUTE_DATA="
    assert text.startswith(prefix) and text.endswith(";\n")
    data = json.loads(text[len(prefix) : -2])
    blob = gzip.decompress((ROOT / "dist" / data["diaryFile"]).read_bytes())
    columns = {}
    for section in data["layout"]:
        values = array.array(section["type"])
        size = values.itemsize * section["length"]
        values.frombytes(blob[section["offset"] : section["offset"] + size])
        columns[section["name"]] = values
    return data, columns


def category(code, where):
    """Independent copy of the category rule; keep in sync with scripts/categories.py."""
    if where == 12:
        return "drive"
    if code in ("010101", "010199"):
        return "sleep"
    tier = code[:2]
    groups = {
        "personal": "01",
        "household": "02",
        "care": "03 04",
        "work": "05",
        "education": "06",
        "shop": "07 08 09",
        "civic": "10",
        "eat": "11",
        "leisure": "12",
        "exercise": "13",
        "religion": "14",
        "volunteer": "15",
        "communication": "16",
        "travel": "18",
    }
    return next((g for g, tiers in groups.items() if tier in tiers.split()), "other")


def raw_person(r):
    """Every filter's option straight from raw columns, written independently of categories.py."""
    age, telfs = int(r["TEAGE"]), int(r["TELFS"])
    working = telfs <= 2
    if working:
        employment = 1 if r["TRDPFTPT"] == "2" else 0
    else:
        employment = 2 if telfs <= 4 else 3
    kids = int(r["TRCHILDNUM"])
    youngest = int(r["TRYHHCHILD"])
    hours = int(r["TEHRUSLT"])
    if not working:
        hours_group = 8
    elif hours == -4:
        hours_group = 7
    elif hours < 0:
        hours_group = 9
    else:
        hours_group = sum(hours >= edge for edge in (20, 35, 40, 41, 50, 60))
    educ = int(r["PEEDUCA"])
    race = int(r["PTDTRACE"])
    metro = r["GTMETSTA"] if r["GTMETSTA"] != "-1" else r["GEMETSTA"]
    if not working:
        earnings = 6
    elif int(r["TRERNWA"]) < 0:
        earnings = 5
    else:
        earnings = r["quintile"]
    return {
        "sex": int(r["TESEX"]) - 1,
        "age": 6 if age >= 75 else (age - 15) // 10,
        "employment": employment,
        "kids": 0 if kids == 0 else (1 if youngest < 6 else 2),
        "age5": 13 if age >= 80 else (age - 15) // 5,
        "race": [None, 0, 1, 3, 2, 4][race] if race <= 5 else 5,
        "hispanic": 0 if r["PEHSPNON"] == "1" else 1,
        "partner": {"1": 0, "2": 1, "3": 2}[r["TRSPPRES"]],
        "education": 0 if educ <= 38 else [1, 2, 3, 3, 4, 5, 6, 6][educ - 39],
        "enrolled": (
            (0 if r["TESCHLVL"] == "1" else 1)
            if r["TESCHENR"] == "1"
            else (2 if r["TESCHENR"] == "2" else 3)
        ),
        "laborforce": telfs - 1,
        "hours": hours_group,
        "multiplejobs": (
            2 if not working else (0 if r["TEMJOT"] == "1" else 1 if r["TEMJOT"] == "2" else 3)
        ),
        "worker": int(r["TEIO1COW"]) - 1 if working else 8,
        "industry": int(r["TRMJIND1"]) - 1 if working else 13,
        "occupation": int(r["TRMJOCC1"]) - 1 if working else 10,
        "earnings": earnings,
        "paytype": 3 if not working else {"1": 0, "2": 1}.get(r["TEERNHRY"], 2),
        "household": min(int(r["TRNUMHOU"]), 6) - 1,
        "children": min(kids, 4),
        "youngest": (
            0
            if kids == 0
            else (1 if youngest < 3 else 2 if youngest < 6 else 3 if youngest < 13 else 4)
        ),
        "partnerwork": 0 if r["TESPEMPNOT"] == "1" else 1 if r["TESPEMPNOT"] == "2" else 2,
        "eldercare": {"1": 0, "2": 1, "-1": 2}.get(r["TUELDER"], 3),
        "metro": int(metro) - 1,
        "weekday": [6, 0, 1, 2, 3, 4, 5][int(r["TUDIARYDAY"]) - 1],
        "month": int(r["TUMONTH"]) - 1,
        "holiday": int(r["TRHOLIDAY"]),
        # ATUS-CPS: HUFAMINC until 2010, HEFAMINC after; 16 bands grouped as in the app.
        "income": raw_income(r),
        "marital": int(r["PEMARITL"]) - 1,
        "citizenship": int(r["PRCITSHP"]) - 1,
        "veteran": 0 if r["PEAFEVER"] == "1" else 1 if r["PEAFEVER"] == "2" else 2,
        "disability": 0 if r["PRDISFLG"] == "1" else 1 if r["PRDISFLG"] == "2" else 2,
        "region": int(r["GEREG"]) - 1,
        "state": STATE_NAMES.index(
            next(name for name, fips in STATE_FIPS.items() if fips == int(r["GESTFIPS"]))
        ),
    }


def raw_income(r):
    code = max(int(r["HEFAMINC"]), int(r["HUFAMINC"]))  # the unused one is -1
    if code < 1:
        return 8
    edges = (6, 8, 10, 12, 14, 15, 16)  # first code of each band after "Under $15,000"
    return sum(code >= e for e in edges)


def raw_quintiles(rows):
    """Weighted earnings quintiles within each year, recomputed from scratch."""
    earners = defaultdict(list)
    for r in rows:
        if int(r["TELFS"]) <= 2 and int(r["TRERNWA"]) >= 0:
            earners[r["TUYEAR"]].append(r)
    for year_rows in earners.values():
        year_rows.sort(key=lambda r: int(r["TRERNWA"]))
        total = sum(r["weight"] for r in year_rows)
        cuts, running = [], 0.0
        for r in year_rows:
            running += r["weight"]
            while len(cuts) < 4 and running >= total * (len(cuts) + 1) / 5:
                cuts.append(int(r["TRERNWA"]))
        for r in year_rows:
            r["quintile"] = len([c for c in cuts if int(r["TRERNWA"]) > c])


WHERE_OPTIONS = {1: {1}, 2: {2}}  # scenario "where" indexes used above -> raw TEWHERE codes
WHO_OPTIONS = {0: {18, 19}, 2: {22, 23, 27, 40}, 4: {54, 56}}  # "who" indexes -> raw TUWHO_CODE


def day_matches(s, weekend):
    return s["day"] == "all" or (s["day"] == "weekend") == weekend


def person_matches(s, year, weekend, groups):
    if not s["years"][0] <= year <= s["years"][1] or not day_matches(s, weekend):
        return False
    return all(groups[k] in s[k] for k in groups if k in s)


def denominators(data, people):
    """Days represented: calendar days of the day type, times the share of each year's weight
    (among diaries of that day type) that the scenario's calendar filters select."""
    days = {y["year"]: y["days"] for y in data["years"]}
    result = {}
    for name, s in SCENARIOS.items():
        total = 0.0
        for y in range(s["years"][0], s["years"][1] + 1):
            share = 1.0
            if CALENDAR & set(s):
                rows = [p for p in people.values() if p[0] == y and day_matches(s, p[2])]
                chosen = [p for p in rows if all(p[3][k] in s[k] for k in CALENDAR & set(s))]
                share = sum(p[1] for p in chosen) / sum(p[1] for p in rows)
            total += days[y][s["day"]] * share
        result[name] = total
    return result


def raw_people():
    fields = ("TRMJIND1", "TRMJOCC1", "TEIO1COW", "TRNUMHOU", "TUELDER", "TEERNHRY", "TUMONTH")
    with (RAW / "atusresp-0325/atusresp_0325.dat").open() as f:
        extra = {r["TUCASEID"]: {k: r[k] for k in fields} for r in csv.DictReader(f)}
    cps = ("HEFAMINC", "HUFAMINC", "GEREG", "GESTFIPS", "PEMARITL", "PRCITSHP", "PEAFEVER")
    with (RAW / "atuscps-0325/atuscps_0325.dat").open() as f:
        for r in csv.DictReader(f):
            if r["TULINENO"] == "1" and r["TUCASEID"] in extra:
                extra[r["TUCASEID"]].update({k: r[k] for k in cps + ("PRDISFLG",)})
    rows = []
    with (RAW / "atussum-0325/atussum_0325.dat").open() as f:
        for r in csv.DictReader(f):
            r.update(extra[r["TUCASEID"]])
            r["weight"] = float(r["TU20FWGT"] if r["TUYEAR"] == "2020" else r["TUFNWGTP"])
            rows.append(r)
    raw_quintiles(rows)
    return {
        r["TUCASEID"]: (int(r["TUYEAR"]), r["weight"], r["TUDIARYDAY"] in ("1", "7"), raw_person(r))
        for r in rows
    }


def raw_snapshots(people):
    who = defaultdict(set)
    with (RAW / "atuswho-0325/atuswho_0325.dat").open() as f:
        for r in csv.DictReader(f):
            who[(r["TUCASEID"], r["TUACTIVITY_N"])].add(int(r["TUWHO_CODE"]))
    result = {
        name: {"weight": 0.0, "sample": 0, "points": defaultdict(lambda: [0.0, 0])}
        for name in SCENARIOS
    }
    for case, (year, weight, weekend, groups) in people.items():
        for name, s in SCENARIOS.items():
            if person_matches(s, year, weekend, groups):
                result[name]["weight"] += weight
                result[name]["sample"] += 1
    with (RAW / "atusact-0325/atusact_0325.dat").open() as f:
        for r in csv.DictReader(f):
            case = r["TUCASEID"]
            year, weight, weekend, groups = people[case]
            h, m, _ = map(int, r["TUSTARTTIM"].split(":"))
            start = (h * 60 + m) % 1440
            if case == TYPO_CASE and r["TUACTIVITY_N"] == "9":
                start += 10  # 14:10 typo; its stop time and duration imply 14:20
            duration = int(r["TUACTDUR24"])
            code = r["TRCODEP"].zfill(6)
            where = int(r["TEWHERE"])
            parent = category(code, where)
            keys = {parent, f"{parent}_{code}"} & set(KEYS)
            if not keys:
                continue
            companions = who[(case, r["TUACTIVITY_N"])]
            for name, s in SCENARIOS.items():
                if not person_matches(s, year, weekend, groups):
                    continue
                if "where" in s and not any(where in WHERE_OPTIONS[o] for o in s["where"]):
                    continue
                if "who" in s and not any(companions & WHO_OPTIONS[o] for o in s["who"]):
                    continue
                for minute in MINUTES:
                    if (minute - start) % 1440 < duration:
                        for key in keys:
                            point = result[name]["points"][(key, minute)]
                            point[0] += weight
                            point[1] += 1
    return result


def packed_snapshots(data, columns):
    """Same snapshots from the decoded diary file, using only the packed fields."""
    first = data["firstYear"]
    codes = [c["code"] for c in data["codes"]]
    filters = [(f["id"], columns[f["column"]]) for f in data["personFilters"]]
    driving = data["episodeFilters"][0]["options"].index("Driving")
    result = {
        name: {"weight": 0.0, "sample": 0, "points": defaultdict(lambda: [0.0, 0])}
        for name in SCENARIOS
    }
    offset = 0
    for i, count in enumerate(columns["episodeCount"]):
        year = columns["year"][i] + first
        weight = columns["weight"][i]
        groups = {k: column[i] for k, column in filters}
        weekend = groups["weekday"] >= 5
        matching = [n for n, s in SCENARIOS.items() if person_matches(s, year, weekend, groups)]
        for name in matching:
            result[name]["weight"] += weight
            result[name]["sample"] += 1
        start = 240
        for e in range(offset, offset + count):
            duration = columns["duration"][e]
            code = codes[columns["code"][e]]
            where = columns["where"][e]
            parent = category(code, 12 if where == driving else 0)
            keys = {parent, f"{parent}_{code}"} & set(KEYS)
            for name in matching if keys else ():
                s = SCENARIOS[name]
                if "where" in s and where not in s["where"]:
                    continue
                if "who" in s and not any(columns["who"][e] >> o & 1 for o in s["who"]):
                    continue
                for minute in MINUTES:
                    if (minute - start) % 1440 < duration:
                        for key in keys:
                            point = result[name]["points"][(key, minute)]
                            point[0] += weight
                            point[1] += 1
            start = (start + duration) % 1440
        offset += count
    return result


def main():
    data, columns = load_data()
    n, total = data["diaries"], data["episodes"]
    assert len(columns["weight"]) == n and len(columns["duration"]) == total
    assert sum(columns["episodeCount"]) == total
    assert all(w > 0 for w in columns["weight"])
    e = 0
    for count in columns["episodeCount"]:
        assert sum(columns["duration"][e : e + count]) == 1440
        e += count
    assert sum(y["diaries"] for y in data["years"]) == n
    assert next(y for y in data["years"] if y["year"] == 2020)["days"]["all"] == 313

    # Every diary's stored filter options match an independent reading of the raw files.
    people = raw_people()
    first = data["firstYear"]
    for f in data["personFilters"]:
        column = columns[f["column"]]
        for i, (case, (year, _, _, groups)) in enumerate(people.items()):
            assert column[i] == groups[f["id"]], (f["id"], case, column[i], groups[f["id"]])
            assert columns["year"][i] + first == year
    days = denominators(data, people)
    raw = raw_snapshots(people)
    packed = packed_snapshots(data, columns)
    expectations = {}
    for name, s in SCENARIOS.items():
        r, p = raw[name], packed[name]
        assert r["sample"] == p["sample"], name
        # Float32 weights in the packed file: allow a relative error of 1e-6.
        assert abs(r["weight"] - p["weight"]) <= 1e-6 * r["weight"], name
        points = []
        for key in KEYS:
            for minute in MINUTES:
                (rw, rn), (pw, pn) = r["points"][(key, minute)], p["points"][(key, minute)]
                assert rn == pn and abs(rw - pw) <= 1e-6 * max(rw, 1), (name, key, minute)
                points.append(
                    {"activity": key, "minute": minute, "people": rw / days[name], "diaries": rn}
                )
        expectations[name] = {
            "filters": s,
            "days": days[name],
            "population": r["weight"] / days[name],
            "sample": r["sample"],
            "points": points,
        }
    (ROOT / "data/test-expectations.json").write_text(json.dumps(expectations, indent=1) + "\n")
    checked = sum(len(v["points"]) for v in expectations.values())
    print(
        f"PASS: packed file contract; {checked} weighted snapshots across {len(SCENARIOS)} "
        "filter scenarios match an independent pass over the raw BLS files."
    )


if __name__ == "__main__":
    main()
