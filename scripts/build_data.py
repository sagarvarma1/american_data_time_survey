"""Build the American Minute diary file from the BLS 2003–2025 multi-year ATUS files.

The browser computes every view from de-identified diary episodes, so any combination of
years, day type, person filters (sex, age, work status, children) and episode filters
(location, company) is available at one-minute resolution.

Weights: TUFNWGTP (2006 method, comparable across years) for every year except 2020, which
uses TU20FWGT and represents only Jan 1–Mar 17 and May 10–Dec 31 (313 days). Weights are
person-days, so a count is the sum of weights active at a minute divided by the number of
days represented. In 2025, BLS weighted the Nov 12–Dec 30 diaries to represent all of Q4
after the Oct 1–Nov 12 shutdown, so 2025 represents all 365 days.

Episodes are positioned with TUCUMDUR24 (cumulative minutes since 4 AM), which is
consistent with TUACTDUR24 by construction; the start-time field has rare typos.
"""

import array
import csv
import datetime as dt
import gzip
import hashlib
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

from categories import (
    FILTERS,
    GROUPS,
    WHERE,
    WHO,
    category,
    where_group,
    who_bit,
)

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/bls-0325"
FILES = {
    "summary": RAW / "atussum-0325/atussum_0325.dat",
    "activity": RAW / "atusact-0325/atusact_0325.dat",
    "who": RAW / "atuswho-0325/atuswho_0325.dat",
    "respondent": RAW / "atusresp-0325/atusresp_0325.dat",
    "cps": RAW / "atuscps-0325/atuscps_0325.dat",
}
# Respondent-file fields used by filters (the summary file has the rest).
RESPONDENT_FIELDS = (
    "TRMJIND1",
    "TRMJOCC1",
    "TEIO1COW",
    "TRNUMHOU",
    "TUELDER",
    "TEERNHRY",
    "TUMONTH",
)
# ATUS-CPS fields, from the respondent's own row (ATUS line 1). The file also covers every
# household member, and households that didn't complete the ATUS.
CPS_FIELDS = (
    "HEFAMINC",
    "HUFAMINC",
    "GEREG",
    "GESTFIPS",
    "PEMARITL",
    "PRCITSHP",
    "PEAFEVER",
    "PRDISFLG",
)
YEARS = range(2003, 2026)
EXPECTED_DIARIES = 258_954
EXPECTED_EPISODES = 4_994_172
COVID_GAP = (dt.date(2020, 3, 18), dt.date(2020, 5, 9))
SLEEP_CODES = ("010101", "010102", "010199")  # BLS "Sleeping" includes sleeplessness
PUBLISHED_SLEEP_HOURS = {2025: 9.03}  # BLS ATUS home page, "Sleeping: 9.03 in 2025"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def represented_days(year):
    days = Counter()
    date = dt.date(year, 1, 1)
    while date.year == year:
        if not (year == 2020 and COVID_GAP[0] <= date <= COVID_GAP[1]):
            days["all"] += 1
            days["weekend" if date.weekday() >= 5 else "weekday"] += 1
        date += dt.timedelta(days=1)
    return dict(days)


def label_name(text):
    text = text.strip().replace("*", "")
    text = re.sub(r"\bn\.?e\.?c\.?", "other", text, flags=re.I)
    text = re.sub(r"\bnonhh\b", "nonhousehold", text, flags=re.I)
    text = re.sub(r"\bhh\b", "household", text, flags=re.I)
    return text


def load_labels():
    with (ROOT / "data/activity-labels.csv").open() as f:
        labels = {r["code"]: label_name(r["Activity"]) for r in csv.DictReader(f)}
    # BLS renamed these in 2024; the pooled file uses the current names.
    labels["130122"] = "Roller skating, inline skating & skateboarding"
    labels["130220"] = "Watching roller skating, inline skating & skateboarding"
    includes = {}
    with (ROOT / "data/harmonized-labels.csv").open() as f:
        for r in csv.DictReader(f):
            labels[r["code"]] = r["Activity"]
            includes[r["code"]] = r["includes"]
    return labels, includes


def who_masks(path):
    """Yield (case, activity_n, bitmask) in file order, one per episode with who rows."""
    current, mask = None, 0
    with path.open() as f:
        for r in csv.DictReader(f):
            key = (r["TUCASEID"], int(r["TUACTIVITY_N"]))
            if key != current:
                if current is not None:
                    yield current + (mask,)
                current, mask = key, 0
            mask |= who_bit(int(r["TUWHO_CODE"]))
    if current is not None:
        yield current + (mask,)


def earnings_cutoffs(rows):
    """Weighted quintile cutoffs of weekly earnings among wage and salary workers, per year.
    A diary's quintile is the number of cutoffs its earnings exceed (ties go to the lower one)."""
    by_year = {}
    for r in rows:
        if r["TELFS"] in ("1", "2") and int(r["TRERNWA"]) >= 0:
            by_year.setdefault(int(r["TUYEAR"]), []).append((int(r["TRERNWA"]), r["weight"]))
    cutoffs = {}
    for year, values in by_year.items():
        values.sort()
        total, running, cuts = sum(w for _, w in values), 0.0, []
        for value, w in values:
            running += w
            while len(cuts) < 4 and running >= total * (len(cuts) + 1) / 5:
                cuts.append(value)
        cutoffs[year] = cuts
    return cutoffs


def read_respondents():
    extra = {}
    with FILES["respondent"].open() as f:
        for r in csv.DictReader(f):
            extra[r["TUCASEID"]] = {k: r[k] for k in RESPONDENT_FIELDS}
    with FILES["cps"].open() as f:
        for r in csv.DictReader(f):
            if r["TULINENO"] == "1" and r["TUCASEID"] in extra:
                assert "GEREG" not in extra[r["TUCASEID"]], r["TUCASEID"]
                extra[r["TUCASEID"]].update({k: r[k] for k in CPS_FIELDS})
    assert all("GEREG" in e for e in extra.values()), "every respondent has a CPS row"
    rows = []
    with FILES["summary"].open() as f:
        for r in csv.DictReader(f):
            year = int(r["TUYEAR"])
            r["weight"] = float(r["TU20FWGT"] if year == 2020 else r["TUFNWGTP"])
            assert r["weight"] > 0, (r["TUCASEID"], year)
            assert r["TUCASEID"].startswith(str(year))
            assert 15 <= int(r["TEAGE"]) <= 85
            r.update(extra.pop(r["TUCASEID"]))
            rows.append(r)
    assert not extra and len(rows) == EXPECTED_DIARIES, len(rows)
    ids = [r["TUCASEID"] for r in rows]
    assert ids == sorted(ids) and len(set(ids)) == len(ids)
    # One employed 2010 diary lacks full/part-time status, hours, and number of jobs.
    assert sum(r["TELFS"] in ("1", "2") and r["TRDPFTPT"] not in ("1", "2") for r in rows) == 1

    cutoffs = earnings_cutoffs(rows)
    respondents, sleep_minutes = [], Counter()
    for r in rows:
        year = int(r["TUYEAR"])
        if year in cutoffs and int(r["TRERNWA"]) >= 0:
            r["earnings_quintile"] = sum(int(r["TRERNWA"]) > c for c in cutoffs[year])
        groups = []
        for f in FILTERS:
            g = f["classify"](r)
            assert g is not None and 0 <= g < len(f["options"]), (f["id"], r["TUCASEID"])
            groups.append(g)
        respondents.append((r["TUCASEID"], year, r["weight"], groups))
        sleep_minutes[year] += r["weight"] * sum(int(r["t" + c]) for c in SLEEP_CODES)
    return respondents, sleep_minutes, cutoffs


def build():
    labels, includes = load_labels()
    benchmark = json.loads((ROOT / "data/benchmarks.json").read_text())
    respondents, summary_sleep, cutoffs = read_respondents()
    index = {case: i for i, (case, *_) in enumerate(respondents)}

    duration = array.array("H")
    code_index = array.array("H")
    where = array.array("B")
    who = array.array("B")
    episode_count = array.array("B", [0]) * len(respondents)
    codes, details, slots = {}, {}, {}
    start_time_typos = []
    hourly_sleep = {y: [0.0] * 24 for y in benchmark}
    year_weight = Counter()
    for _, year, weight, _ in respondents:
        year_weight[year] += weight

    who_iter = who_masks(FILES["who"])
    next_who = next(who_iter)
    last_case, cumulative = None, 0
    with FILES["activity"].open() as f:
        for r in csv.DictReader(f):
            case, n = r["TUCASEID"], int(r["TUACTIVITY_N"])
            if case != last_case:
                assert last_case is None or (
                    index[case] == index[last_case] + 1 and cumulative == 1440
                )
                last_case, cumulative = case, 0
            i = index[case]
            minutes = int(r["TUACTDUR24"])
            assert int(r["TUCUMDUR24"]) == cumulative + minutes and 0 < minutes <= 1440
            start = (240 + cumulative) % 1440
            h, m, _ = map(int, r["TUSTARTTIM"].split(":"))
            if (60 * h + m) % 1440 != start:
                start_time_typos.append(f"{case} activity {n}")
            cumulative += minutes

            code = r["TRCODEP"].zfill(6)
            assert code in labels, code
            tewhere = int(r["TEWHERE"])
            parent = category(code, tewhere)
            codes.setdefault(
                code, {"code": code, "label": labels[code], "parent": category(code, 0)}
            )
            key = f"{parent}_{code}"
            label = ("Driving · " if parent == "drive" else "") + labels[code]
            details.setdefault(key, {"id": key, "label": label, "parent": parent, "code": code})

            mask = 0
            if next_who and next_who[:2] == (case, n):
                mask = next_who[2]
                next_who = next(who_iter, None)

            duration.append(minutes)
            code_index.append(slots.setdefault(code, len(slots)))
            where.append(where_group(tewhere))
            who.append(mask)
            episode_count[i] += 1
            assert episode_count[i] < 255

            year = respondents[i][1]
            if str(year) in hourly_sleep and code in SLEEP_CODES:
                for hour in range(24):
                    if (hour * 60 - start) % 1440 < minutes:
                        hourly_sleep[str(year)][hour] += respondents[i][2]
    assert cumulative == 1440 and next_who is None
    assert len(duration) == EXPECTED_EPISODES, len(duration)
    assert all(episode_count), "every diary has episodes"

    # Codes were numbered in first-seen order; renumber them in sorted code order.
    ordered = sorted(codes)
    remap = {slot: ordered.index(code) for code, slot in slots.items()}
    code_index = array.array("H", (remap[c] for c in code_index))

    validation = validate(respondents, hourly_sleep, benchmark, summary_sleep, year_weight)
    validation["startTimeTypos"] = start_time_typos

    years = []
    for year in YEARS:
        rows = [r for r in respondents if r[1] == year]
        years.append(
            {
                "year": year,
                "diaries": len(rows),
                "episodes": sum(episode_count[index[r[0]]] for r in rows),
                "days": represented_days(year),
                "weight": "TU20FWGT" if year == 2020 else "TUFNWGTP",
            }
        )

    sections = [
        ("weight", "f", array.array("f", (r[2] for r in respondents))),
        ("year", "B", array.array("B", (r[1] - YEARS[0] for r in respondents))),
        *(
            (f"f_{f['id']}", "B", array.array("B", (r[3][k] for r in respondents)))
            for k, f in enumerate(FILTERS)
        ),
        ("episodeCount", "B", episode_count),
        ("duration", "H", duration),
        ("code", "H", code_index),
        ("where", "B", where),
        ("who", "B", who),
    ]
    assert sys.byteorder == "little"
    blob, layout = bytearray(), []
    for name, kind, values in sections:
        blob.extend(b"\0" * (-len(blob) % 4))
        layout.append({"name": name, "type": kind, "offset": len(blob), "length": len(values)})
        blob.extend(values.tobytes())
    packed = gzip.compress(bytes(blob), compresslevel=9, mtime=0)

    meta = {
        "schemaVersion": 5,
        "populationScope": "U.S. civilian noninstitutional population age 15+",
        "firstYear": YEARS[0],
        "years": years,
        "categories": [dict(zip(["id", "label", "color", "description"], g)) for g in GROUPS],
        "codes": [
            dict(codes[c], **({"includes": includes[c]} if c in includes else {})) for c in ordered
        ],
        "details": sorted(details.values(), key=lambda d: d["id"]),
        "personFilters": [
            {
                "id": f["id"],
                "label": f["label"],
                "group": f["group"],
                "options": f["options"],
                "column": f"f_{f['id']}",
                **({"basic": True} if f.get("basic") else {}),
                **({"calendar": True} if f.get("calendar") else {}),
            }
            for f in FILTERS
        ],
        "earningsCutoffs": {str(y): [c / 100 for c in cuts] for y, cuts in cutoffs.items()},
        "episodeFilters": [
            {"id": WHERE[0], "label": WHERE[1], "options": WHERE[2]},
            {"id": WHO[0], "label": WHO[1], "options": WHO[2]},
        ],
        "layout": layout,
        "diaries": len(respondents),
        "episodes": len(duration),
        "validation": validation,
        "rawSha256": {k: sha256(p) for k, p in FILES.items()},
        "source": "https://www.bls.gov/tus/data/datafiles-0325.htm",
    }
    # The diaries go in a content-addressed file, so browsers can cache it forever. data.js keeps
    # the small metadata; build_preview.cjs then adds the precomputed first view to it.
    diary_dir = ROOT / "dist/diaries"
    diary_dir.mkdir(exist_ok=True)
    for old in diary_dir.glob("*.bin"):
        old.unlink()
    diary_file = f"diaries/{hashlib.sha256(packed).hexdigest()[:16]}.bin"
    (ROOT / "dist" / diary_file).write_bytes(packed)
    payload = dict(meta, diaryFile=diary_file, diaryBytes=len(packed))
    (ROOT / "dist/data.js").write_text(
        "window.AMERICAN_MINUTE_DATA=" + json.dumps(payload, separators=(",", ":")) + ";\n"
    )
    subprocess.run(["node", str(ROOT / "scripts/build_preview.cjs")], check=True)
    (ROOT / "data/validation.json").write_text(json.dumps(validation, indent=2) + "\n")
    print(
        json.dumps(
            {
                "diaries": len(respondents),
                "episodes": len(duration),
                "codes": len(codes),
                "detailRows": len(details),
                "rawBytes": len(blob),
                "gzipBytes": len(packed),
                "dataJsBytes": (ROOT / "dist/data.js").stat().st_size,
                "diaryFile": diary_file,
                "startTimeTypos": start_time_typos,
            },
            indent=2,
        )
    )


def validate(respondents, hourly_sleep, benchmark, summary_sleep, year_weight):
    report = {"benchmarks": {}}
    for year, published in benchmark.items():
        computed = [round(v / year_weight[int(year)] * 100, 1) for v in hourly_sleep[year]]
        assert computed == published, (year, computed, published)
        report["benchmarks"][year] = "All 24 hourly BLS Table A-3 sleeping percentages match."
    for year, hours in PUBLISHED_SLEEP_HOURS.items():
        computed = round(summary_sleep[year] / year_weight[year] / 60, 2)
        assert computed == hours, (year, computed, hours)
        report["benchmarks"][str(year)] = f"Average sleep {computed} hours/day matches BLS."
    report["years"] = {
        y: {
            "diaries": sum(1 for r in respondents if r[1] == y),
            "averagePopulation": round(year_weight[y] / represented_days(y)["all"]),
        }
        for y in YEARS
    }
    return report


if __name__ == "__main__":
    build()
