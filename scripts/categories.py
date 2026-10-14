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
# Each filter is (id, label, [option labels]); the classifier returns an option index.

SEX = ("sex", "Sex", ["Men", "Women"])
AGE = ("age", "Age", ["15–24", "25–34", "35–44", "45–54", "55–64", "65–74", "75+"])
EMPLOYMENT = (
    "employment",
    "Work status",
    ["Employed full time", "Employed part time", "Unemployed", "Not in labor force"],
)
KIDS = (
    "kids",
    "Children at home",
    ["No children under 18", "Youngest child under 6", "Youngest child 6–17"],
)
PERSON_FILTERS = [SEX, AGE, EMPLOYMENT, KIDS]


def sex_group(tesex):
    return {1: 0, 2: 1}[tesex]


def age_group(teage):
    assert 15 <= teage <= 85, teage
    return min((teage - 15) // 10, 6)


def employment_group(telfs, trdpftpt):
    if telfs in (1, 2):
        # One 2010 diary (employed, absent from work) has no full/part-time status;
        # it is counted as full time. build_data.py asserts there is only one.
        return 1 if trdpftpt == 2 else 0
    if telfs in (3, 4):
        return 2
    assert telfs == 5, telfs
    return 3


def kids_group(trchildnum, tryhhchild):
    if trchildnum == 0:
        return 0
    return 1 if tryhhchild < 6 else 2


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
