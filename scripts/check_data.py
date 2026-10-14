"""Check dist/data.js against the raw BLS files and write expectations for the app tests.

1. Decode the packed diary file in Python and validate its contract.
2. Recompute weighted snapshots directly from the raw CSVs (start times, raw TEWHERE and
   TUWHO_CODE values, raw demographics), independent of the packed encoding.
3. Recompute the same snapshots from the decoded diary file and require agreement.
4. Write data/test-expectations.json, which scripts/check_app.cjs compares to the browser engine.
"""

import array
import base64
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

# Each scenario: years, day type, person filters, and episode filters (by option index).
SCENARIOS = {
    "everyone": {"years": [2003, 2025], "day": "all"},
    "covid-2020-weekend": {"years": [2020, 2020], "day": "weekend"},
    "early-weekday-women": {"years": [2003, 2005], "day": "weekday", "sex": 1},
    "2025-young-full-time": {"years": [2025, 2025], "day": "all", "age": 1, "employment": 0},
    "2010s-young-kids-at-home": {"years": [2010, 2019], "day": "all", "kids": 1, "where": 1},
    "weekend-with-friends": {"years": [2003, 2025], "day": "weekend", "who": 4},
    "retired-age-alone": {"years": [2015, 2025], "day": "weekday", "age": 5, "who": 0},
    "post-pandemic": {"years": [2021, 2024], "day": "all"},
}


def load_data():
    text = (ROOT / "dist/data.js").read_text()
    prefix = "window.AMERICAN_MINUTE_DATA="
    assert text.startswith(prefix) and text.endswith(";\n")
    data = json.loads(text[len(prefix) : -2])
    blob = gzip.decompress(base64.b64decode(data.pop("diaryData")))
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
    """Demographic groups straight from raw columns (deliberately not using categories.py)."""
    age = int(r["TEAGE"])
    telfs = int(r["TELFS"])
    if telfs <= 2:
        employment = 1 if r["TRDPFTPT"] == "2" else 0
    else:
        employment = 2 if telfs <= 4 else 3
    kids = 0 if r["TRCHILDNUM"] == "0" else (1 if int(r["TRYHHCHILD"]) < 6 else 2)
    return {
        "sex": int(r["TESEX"]) - 1,
        "age": 6 if age >= 75 else (age - 15) // 10,
        "employment": employment,
        "kids": kids,
    }


WHERE_OPTIONS = {1: {1}}  # scenario "where" indexes used above -> raw TEWHERE codes
WHO_OPTIONS = {0: {18, 19}, 4: {54, 56}}  # scenario "who" indexes -> raw TUWHO_CODE values


def person_matches(s, year, weekend, groups):
    if not s["years"][0] <= year <= s["years"][1]:
        return False
    if s["day"] != "all" and (s["day"] == "weekend") != weekend:
        return False
    return all(groups[k] == s[k] for k in ("sex", "age", "employment", "kids") if k in s)


def denominators(data):
    days = {y["year"]: y["days"] for y in data["years"]}
    return {
        name: sum(days[y][s["day"]] for y in range(s["years"][0], s["years"][1] + 1))
        for name, s in SCENARIOS.items()
    }


def raw_snapshots(data):
    people = {}
    with (RAW / "atussum-0325/atussum_0325.dat").open() as f:
        for r in csv.DictReader(f):
            year = int(r["TUYEAR"])
            weight = float(r["TU20FWGT"] if year == 2020 else r["TUFNWGTP"])
            people[r["TUCASEID"]] = (year, weight, r["TUDIARYDAY"] in ("1", "7"), raw_person(r))
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
                if "where" in s and where not in WHERE_OPTIONS[s["where"]]:
                    continue
                if "who" in s and not companions & WHO_OPTIONS[s["who"]]:
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
    shifts = {f["id"]: (f["shift"], (1 << f["bits"]) - 1) for f in data["personFilters"]}
    driving = data["episodeFilters"][0]["options"].index("Driving")
    result = {
        name: {"weight": 0.0, "sample": 0, "points": defaultdict(lambda: [0.0, 0])}
        for name in SCENARIOS
    }
    offset = 0
    for i, count in enumerate(columns["episodeCount"]):
        year = columns["year"][i] + first
        attrs = columns["attrs"][i]
        weight = columns["weight"][i]
        groups = {k: (attrs >> s) & mask for k, (s, mask) in shifts.items()}
        matching = [
            n for n, s in SCENARIOS.items() if person_matches(s, year, bool(attrs & 1), groups)
        ]
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
                if "where" in s and where != s["where"]:
                    continue
                if "who" in s and not columns["who"][e] >> s["who"] & 1:
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

    days = denominators(data)
    raw = raw_snapshots(data)
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
