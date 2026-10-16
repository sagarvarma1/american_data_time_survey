GROUPS = [
    ("sleep", "Sleeping", "#7885b5", "Sleep and naps; excludes reported sleeplessness."),
    ("work", "Working", "#d78a55", "Work and work-related activities, excluding driving."),
    (
        "leisure",
        "Leisure & socializing",
        "#72a399",
        "Socializing, television, reading, games, and other leisure.",
    ),
    (
        "household",
        "Household tasks",
        "#c7ac64",
        "Cleaning, cooking, repairs, gardening, and caring for pets.",
    ),
    (
        "eat",
        "Eating & drinking",
        "#d8a091",
        "Eating and drinking as the main activity; excludes related travel.",
    ),
    (
        "drive",
        "Driving",
        "#dd6947",
        "Reported location: car, truck, or motorcycle, as the driver. Includes driving for work; excludes passengers.",
    ),
    (
        "care",
        "Caring for others",
        "#b595b5",
        "Primary care and help for household and nonhousehold members. Excludes secondary childcare.",
    ),
    (
        "personal",
        "Personal care",
        "#aaa4c8",
        "Grooming, health-related self care, sleeplessness, and other personal care.",
    ),
    (
        "education",
        "Learning",
        "#85a9c4",
        "Classes, homework, research, and other education activities.",
    ),
    (
        "shop",
        "Shopping & services",
        "#b8b66f",
        "Shopping and using professional, household, and government services.",
    ),
    (
        "exercise",
        "Sports & exercise",
        "#92b385",
        "Exercise, sports participation, spectating, and sports-related activities.",
    ),
    (
        "travel",
        "Other travel",
        "#a8b9c5",
        "Travel excluding reported driving, including passengers, walking, and transit.",
    ),
    ("religion", "Religious activities", "#bb9f79", "Religious and spiritual activities."),
    ("volunteer", "Volunteering", "#b5a18c", "Volunteer activities through organizations."),
    ("civic", "Civic activities", "#9bada1", "Civic obligations and participation."),
    (
        "communication",
        "Calls & messages",
        "#bc9b9b",
        "Telephone calls, mail, and e-mail classified in ATUS category 16.",
    ),
    (
        "other",
        "Other & unclassified",
        "#c5c4be",
        "Unclassified activities and any remaining activity codes.",
    ),
]


def category(code, where):
    if where == 12:
        return "drive"
    if code in ("010101", "010199"):
        return "sleep"
    return {
        "01": "personal",
        "02": "household",
        "03": "care",
        "04": "care",
        "05": "work",
        "06": "education",
        "07": "shop",
        "08": "shop",
        "09": "shop",
        "10": "civic",
        "11": "eat",
        "12": "leisure",
        "13": "exercise",
        "14": "religion",
        "15": "volunteer",
        "16": "communication",
        "18": "travel",
    }.get(code[:2], "other")


def minute(value):
    h, m, _ = map(int, value.split(":"))
    return (60 * h + m) % 1440


# ---- Person filters (one value per diary) ----
# Each filter maps a diary's raw fields (atussum, atusresp, and atuscps, merged into one dict of
# strings) to an option index. "basic" filters appear on the main page; the rest are advanced.
# "calendar" filters describe the diary day rather than the person (see engine.js on days).


def num(r, key):
    return int(r[key])


def employed(r):
    return r["TELFS"] in ("1", "2")


def employment_group(telfs, trdpftpt):
    if telfs in (1, 2):
        # One 2010 diary (employed, absent from work) has no full/part-time status;
        # it is counted as full time. build_data.py asserts there is only one.
        return 1 if trdpftpt == 2 else 0
    if telfs in (3, 4):
        return 2
    assert telfs == 5, telfs
    return 3


def bands(value, edges):
    """Index of the first band whose upper edge exceeds value (edges are exclusive tops)."""
    return next((i for i, top in enumerate(edges) if value < top), len(edges))


def hours_group(r):
    if not employed(r):
        return 8
    hours = num(r, "TEHRUSLT")
    if hours == -4:
        return 7
    if hours < 0:
        return 9  # the same 2010 diary as in employment_group()
    return bands(hours, [20, 35, 40, 41, 50, 60, 1000])


def earnings_group(r):
    if not employed(r):
        return 6
    if num(r, "TRERNWA") < 0:
        return 5  # self-employed or without pay: BLS does not collect their earnings
    return r["earnings_quintile"]  # set by build_data.py from weighted cutoffs per year


def eldercare_group(r):
    return {"1": 0, "2": 1, "-1": 2}.get(r["TUELDER"], 3)


def youngest_group(r):
    if num(r, "TRCHILDNUM") == 0:
        return 0
    return 1 + bands(num(r, "TRYHHCHILD"), [3, 6, 13])


def metro_group(r):
    value = r["GTMETSTA"] if r["GTMETSTA"] != "-1" else r["GEMETSTA"]
    return {"1": 0, "2": 1, "3": 2}[value]


def education_group(r):
    code = num(r, "PEEDUCA")
    return {39: 1, 40: 2, 41: 3, 42: 3, 43: 4, 44: 5, 45: 6, 46: 6}.get(
        code, 0 if code <= 38 else None
    )


def enrollment_group(r):
    return {("1", "1"): 0, ("1", "2"): 1}.get(
        (r["TESCHENR"], r["TESCHLVL"]), 2 if r["TESCHENR"] == "2" else 3
    )


def not_employed_or(r, key, options):
    return options if not employed(r) else num(r, key) - 1


# From the ATUS-CPS file: the respondent's answers in their household's final CPS interview,
# two to five months before the diary day.
STATES = {
    1: "Alabama",
    2: "Alaska",
    4: "Arizona",
    5: "Arkansas",
    6: "California",
    8: "Colorado",
    9: "Connecticut",
    10: "Delaware",
    11: "District of Columbia",
    12: "Florida",
    13: "Georgia",
    15: "Hawaii",
    16: "Idaho",
    17: "Illinois",
    18: "Indiana",
    19: "Iowa",
    20: "Kansas",
    21: "Kentucky",
    22: "Louisiana",
    23: "Maine",
    24: "Maryland",
    25: "Massachusetts",
    26: "Michigan",
    27: "Minnesota",
    28: "Mississippi",
    29: "Missouri",
    30: "Montana",
    31: "Nebraska",
    32: "Nevada",
    33: "New Hampshire",
    34: "New Jersey",
    35: "New Mexico",
    36: "New York",
    37: "North Carolina",
    38: "North Dakota",
    39: "Ohio",
    40: "Oklahoma",
    41: "Oregon",
    42: "Pennsylvania",
    44: "Rhode Island",
    45: "South Carolina",
    46: "South Dakota",
    47: "Tennessee",
    48: "Texas",
    49: "Utah",
    50: "Vermont",
    51: "Virginia",
    53: "Washington",
    54: "West Virginia",
    55: "Wisconsin",
    56: "Wyoming",
}
STATE_CODES = sorted(STATES, key=STATES.get)  # options in alphabetical order


def income_group(r):
    # BLS moved family income from HUFAMINC to HEFAMINC during 2010; both use the same 16
    # bands. HEFAMINC is fully edited; HUFAMINC has refusals and don't-knows.
    code = num(r, "HEFAMINC") if num(r, "HEFAMINC") > 0 else num(r, "HUFAMINC")
    if code <= 0:
        return 8
    return [0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 6, 7][code - 1]


def yes_no_asked(r, key):
    return {"1": 0, "2": 1}.get(r[key], 2)


FILTERS = [
    # Basic (main page)
    dict(
        id="sex",
        label="Sex",
        group="People",
        basic=True,
        options=["Men", "Women"],
        classify=lambda r: {1: 0, 2: 1}[num(r, "TESEX")],
    ),
    dict(
        id="age",
        label="Age",
        group="People",
        basic=True,
        options=["15–24", "25–34", "35–44", "45–54", "55–64", "65–74", "75+"],
        classify=lambda r: min((num(r, "TEAGE") - 15) // 10, 6),
    ),
    dict(
        id="employment",
        label="Work status",
        group="People",
        basic=True,
        options=["Employed full time", "Employed part time", "Unemployed", "Not in labor force"],
        classify=lambda r: employment_group(num(r, "TELFS"), num(r, "TRDPFTPT")),
    ),
    dict(
        id="kids",
        label="Children at home",
        group="People",
        basic=True,
        options=["No children under 18", "Youngest child under 6", "Youngest child 6–17"],
        classify=lambda r: 0 if r["TRCHILDNUM"] == "0" else (1 if num(r, "TRYHHCHILD") < 6 else 2),
    ),
    # Demographics
    dict(
        id="age5",
        label="Age (5-year groups)",
        group="Demographics",
        options=[
            "15–19",
            "20–24",
            "25–29",
            "30–34",
            "35–39",
            "40–44",
            "45–49",
            "50–54",
            "55–59",
            "60–64",
            "65–69",
            "70–74",
            "75–79",
            "80+",
        ],
        classify=lambda r: min((num(r, "TEAGE") - 15) // 5, 13),
    ),
    dict(
        id="race",
        label="Race",
        group="Demographics",
        options=[
            "White alone",
            "Black alone",
            "Asian alone",
            "American Indian or Alaska Native alone",
            "Native Hawaiian or Pacific Islander alone",
            "Two or more races",
        ],
        classify=lambda r: {1: 0, 2: 1, 4: 2, 3: 3, 5: 4}.get(num(r, "PTDTRACE"), 5),
    ),
    dict(
        id="hispanic",
        label="Hispanic or Latino",
        group="Demographics",
        options=["Hispanic or Latino", "Not Hispanic or Latino"],
        classify=lambda r: {1: 0, 2: 1}[num(r, "PEHSPNON")],
    ),
    dict(
        id="partner",
        label="Spouse or partner",
        group="Demographics",
        options=["Spouse in household", "Unmarried partner in household", "Neither in household"],
        classify=lambda r: num(r, "TRSPPRES") - 1,
    ),
    dict(
        id="marital",
        label="Marital status",
        group="Demographics",
        options=[
            "Married, spouse present",
            "Married, spouse absent",
            "Widowed",
            "Divorced",
            "Separated",
            "Never married",
        ],
        classify=lambda r: num(r, "PEMARITL") - 1,
    ),
    dict(
        id="citizenship",
        label="Citizenship",
        group="Demographics",
        options=[
            "Born in the U.S.",
            "Born in Puerto Rico or a U.S. territory",
            "Born abroad to American parents",
            "Naturalized U.S. citizen",
            "Not a U.S. citizen",
        ],
        classify=lambda r: num(r, "PRCITSHP") - 1,
    ),
    dict(
        id="veteran",
        label="Veteran",
        group="Demographics",
        options=["Served in the armed forces", "Never served", "Not asked"],
        classify=lambda r: yes_no_asked(r, "PEAFEVER"),
    ),
    dict(
        id="disability",
        label="Disability",
        group="Demographics",
        options=["Has a disability", "No disability", "Not asked"],
        classify=lambda r: yes_no_asked(r, "PRDISFLG"),
    ),
    # Education
    dict(
        id="education",
        label="Education",
        group="Education",
        options=[
            "Less than high school",
            "High school diploma",
            "Some college, no degree",
            "Associate degree",
            "Bachelor’s degree",
            "Master’s degree",
            "Professional or doctoral degree",
        ],
        classify=education_group,
    ),
    dict(
        id="enrolled",
        label="Enrolled in school",
        group="Education",
        options=[
            "High school student",
            "College or university student",
            "Not enrolled",
            "Not asked (age 50+)",
        ],
        classify=enrollment_group,
    ),
    # Work
    dict(
        id="laborforce",
        label="Labor force status",
        group="Work",
        options=[
            "Employed, at work",
            "Employed, absent from work",
            "Unemployed, on layoff",
            "Unemployed, looking for work",
            "Not in labor force",
        ],
        classify=lambda r: num(r, "TELFS") - 1,
    ),
    dict(
        id="hours",
        label="Usual weekly hours",
        group="Work",
        options=[
            "Under 20",
            "20–34",
            "35–39",
            "40",
            "41–49",
            "50–59",
            "60 or more",
            "Hours vary",
            "Not employed",
            "Not reported",
        ],
        classify=hours_group,
    ),
    dict(
        id="multiplejobs",
        label="Number of jobs",
        group="Work",
        options=["More than one job", "One job", "Not employed", "Not reported"],
        classify=lambda r: 2 if not employed(r) else {"1": 0, "2": 1}.get(r["TEMJOT"], 3),
    ),
    dict(
        id="worker",
        label="Class of worker",
        group="Work",
        options=[
            "Federal government",
            "State government",
            "Local government",
            "Private, for profit",
            "Private, nonprofit",
            "Self-employed, incorporated",
            "Self-employed, unincorporated",
            "Without pay (family business)",
            "Not employed",
        ],
        classify=lambda r: not_employed_or(r, "TEIO1COW", 8),
    ),
    dict(
        id="industry",
        label="Industry",
        group="Work",
        options=[
            "Agriculture, forestry, fishing, and hunting",
            "Mining",
            "Construction",
            "Manufacturing",
            "Wholesale and retail trade",
            "Transportation and utilities",
            "Information",
            "Financial activities",
            "Professional and business services",
            "Educational and health services",
            "Leisure and hospitality",
            "Other services",
            "Public administration",
            "Not employed",
        ],
        classify=lambda r: not_employed_or(r, "TRMJIND1", 13),
    ),
    dict(
        id="occupation",
        label="Occupation",
        group="Work",
        options=[
            "Management, business, and financial",
            "Professional and related",
            "Service",
            "Sales and related",
            "Office and administrative support",
            "Farming, fishing, and forestry",
            "Construction and extraction",
            "Installation, maintenance, and repair",
            "Production",
            "Transportation and material moving",
            "Not employed",
        ],
        classify=lambda r: not_employed_or(r, "TRMJOCC1", 10),
    ),
    dict(
        id="earnings",
        label="Weekly earnings (within each year)",
        group="Work",
        options=[
            "Bottom 20% of earners",
            "20–40%",
            "40–60%",
            "60–80%",
            "Top 20% of earners",
            "Self-employed or without pay",
            "Not employed",
        ],
        classify=earnings_group,
    ),
    dict(
        id="paytype",
        label="Pay",
        group="Work",
        options=["Paid hourly", "Not paid hourly", "Self-employed or without pay", "Not employed"],
        classify=lambda r: 3 if not employed(r) else {"1": 0, "2": 1}.get(r["TEERNHRY"], 2),
    ),
    # Household
    dict(
        id="income",
        label="Family income (that year’s dollars)",
        group="Household",
        options=[
            "Under $15,000",
            "$15,000–24,999",
            "$25,000–34,999",
            "$35,000–49,999",
            "$50,000–74,999",
            "$75,000–99,999",
            "$100,000–149,999",
            "$150,000 or more",
            "Not reported",
        ],
        classify=income_group,
    ),
    dict(
        id="household",
        label="Household size",
        group="Household",
        options=["Lives alone", "2 people", "3 people", "4 people", "5 people", "6 or more"],
        classify=lambda r: min(num(r, "TRNUMHOU"), 6) - 1,
    ),
    dict(
        id="children",
        label="Children under 18 in household",
        group="Household",
        options=["None", "1", "2", "3", "4 or more"],
        classify=lambda r: min(num(r, "TRCHILDNUM"), 4),
    ),
    dict(
        id="youngest",
        label="Youngest child",
        group="Household",
        options=["No children under 18", "Under 3", "3–5", "6–12", "13–17"],
        classify=youngest_group,
    ),
    dict(
        id="partnerwork",
        label="Spouse or partner’s work",
        group="Household",
        options=[
            "Spouse or partner employed",
            "Spouse or partner not employed",
            "No spouse or partner in household",
        ],
        classify=lambda r: {"1": 0, "2": 1}.get(r["TESPEMPNOT"], 2),
    ),
    dict(
        id="eldercare",
        label="Cares for an older adult",
        group="Household",
        options=[
            "Provided eldercare in past 3–4 months",
            "Did not",
            "Not asked",
            "Don’t know or refused",
        ],
        classify=eldercare_group,
    ),
    # Place
    dict(
        id="metro",
        label="Metropolitan area",
        group="Place",
        options=["Metropolitan", "Nonmetropolitan", "Not identified"],
        classify=metro_group,
    ),
    dict(
        id="region",
        label="Region",
        group="Place",
        options=["Northeast", "Midwest", "South", "West"],
        classify=lambda r: num(r, "GEREG") - 1,
    ),
    dict(
        id="state",
        label="State",
        group="Place",
        options=[STATES[c] for c in STATE_CODES],
        classify=lambda r: STATE_CODES.index(num(r, "GESTFIPS")),
    ),
    # Diary day
    dict(
        id="weekday",
        label="Day of the week",
        group="Diary day",
        calendar=True,
        options=["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
        classify=lambda r: (num(r, "TUDIARYDAY") + 5) % 7,
    ),
    dict(
        id="month",
        label="Month",
        group="Diary day",
        calendar=True,
        options=[
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December",
        ],
        classify=lambda r: num(r, "TUMONTH") - 1,
    ),
    dict(
        id="holiday",
        label="Holiday",
        group="Diary day",
        calendar=True,
        options=["Not a holiday", "Holiday"],
        classify=lambda r: num(r, "TRHOLIDAY"),
    ),
]


# ---- Episode filters (one value per activity) ----

# Location (TEWHERE). "Not recorded" covers activities where BLS does not ask
# (sleep, grooming, personal/private activities) plus refusals and don't-knows.
WHERE = (
    "where",
    "Where",
    [
        "Location not recorded",
        "At home",
        "At work",
        "Someone else’s home",
        "Restaurant or bar",
        "Store, bank, or post office",
        "School",
        "Place of worship",
        "Gym or outdoors",
        "Other place",
        "Driving",
        "Passenger in a car",
        "Walking or biking",
        "Public transit, taxi, or plane",
    ],
)
WHERE_CODES = {
    1: 1,
    2: 2,
    3: 3,
    4: 4,
    6: 5,
    7: 5,
    30: 5,
    32: 5,
    8: 6,
    5: 7,
    9: 8,
    31: 8,
    10: 9,
    11: 9,
    89: 9,
    12: 10,
    13: 11,
    14: 12,
    17: 12,
    15: 13,
    16: 13,
    18: 13,
    19: 13,
    20: 13,
    21: 13,
    99: 13,
}


def where_group(tewhere):
    return WHERE_CODES.get(tewhere, 0)


# Company (TUWHO_CODE), stored as a bitmask: one episode can involve several groups.
WHO = (
    "who",
    "With",
    [
        "Alone",
        "Spouse or partner",
        "Children",
        "Other family",
        "Friends or neighbors",
        "Coworkers or customers",
        "Other people",
    ],
)
WHO_CODES = {
    18: 0,
    19: 0,
    20: 1,
    21: 1,
    22: 2,
    23: 2,
    27: 2,
    40: 2,
    24: 3,
    25: 3,
    26: 3,
    51: 3,
    52: 3,
    53: 3,
    54: 4,
    56: 4,
    55: 5,
    59: 5,
    60: 5,
    61: 5,
    62: 5,
    28: 6,
    29: 6,
    30: 6,
    57: 6,
    58: 6,
}


def who_bit(tuwho_code):
    group = WHO_CODES.get(tuwho_code)
    return 0 if group is None else 1 << group
