"""Parse Facebook post timestamps (Hebrew + English) into an age.

Facebook shows timestamps in many forms:
    "עכשיו", "5 דק'", "3 ש'", "2 י'", "שבוע", "אתמול בשעה 14:00",
    "28 בספטמבר", "יום ראשון, 28 בספטמבר 2025 בשעה 10:00",
    "Just now", "5m", "3h", "2d", "1w", "Yesterday at 2:00 PM", "September 28".

parse_post_age() returns a timedelta, or None when the text can't be understood.
Callers should treat None as "unknown age" and skip the post (safe default).
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

HEB_MONTHS = {
    "ינואר": 1, "פברואר": 2, "מרץ": 3, "מרס": 3, "אפריל": 4, "מאי": 5, "יוני": 6,
    "יולי": 7, "אוגוסט": 8, "ספטמבר": 9, "אוקטובר": 10, "נובמבר": 11, "דצמבר": 12,
}
EN_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}

# Python weekday numbers: Monday=0 .. Sunday=6
_WEEKDAYS = {
    "שני": 0, "שלישי": 1, "רביעי": 2, "חמישי": 3, "שישי": 4, "שבת": 5, "ראשון": 6,
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}

_NUM = r"(\d+)\s*"

# (regex, unit) — order matters: weeks ("שב'") must be checked before hours ("ש'").
_RELATIVE = [
    (re.compile(r"^(עכשיו|ממש עכשיו|just now|now)$"), "zero"),
    (re.compile(_NUM + r"(שב'|שבוע|שבועות|w|wk|wks|week|weeks)$"), "weeks"),
    (re.compile(_NUM + r"(ד'|דק'|דקה|דקות|m|min|mins|minute|minutes)$"), "minutes"),
    (re.compile(_NUM + r"(ש'|שעה|שעות|h|hr|hrs|hour|hours)$"), "hours"),
    (re.compile(_NUM + r"(י'|יום|ימים|d|day|days)$"), "days"),
    (re.compile(_NUM + r"(ח'|חודש|חודשים|mo|mos|month|months)$"), "months"),
    (re.compile(_NUM + r"(שנה|שנים|y|yr|yrs|year|years)$"), "years"),
]
_WORDS = {
    "דקה": timedelta(minutes=1), "שעה": timedelta(hours=1), "שעתיים": timedelta(hours=2),
    "יום": timedelta(days=1), "יומיים": timedelta(days=2),
    "שבוע": timedelta(weeks=1), "שבועיים": timedelta(weeks=2),
    "חודש": timedelta(days=30), "חודשיים": timedelta(days=60), "שנה": timedelta(days=365),
    "a minute": timedelta(minutes=1), "an hour": timedelta(hours=1),
    "a day": timedelta(days=1), "a week": timedelta(weeks=1),
}
_UNIT = {
    "zero": timedelta(0), "minutes": timedelta(minutes=1), "hours": timedelta(hours=1),
    "days": timedelta(days=1), "weeks": timedelta(weeks=1),
    "months": timedelta(days=30), "years": timedelta(days=365),
}

_HEB_DATE = re.compile(r"(\d{1,2})\s*ב?(" + "|".join(HEB_MONTHS) + r")(?:\s*,?\s*(\d{4}))?")
_EN_DATE_MD = re.compile(r"(" + "|".join(EN_MONTHS) + r")\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\b")
_EN_DATE_DM = re.compile(r"\b(\d{1,2})\s+(" + "|".join(EN_MONTHS) + r")\.?(?:\s*,?\s*(\d{4}))?\b")
_NUMERIC_DATE = re.compile(r"\b(\d{1,2})[./](\d{1,2})[./](\d{2,4})\b")
_TIME_SUFFIX = re.compile(r"\s*(בשעה|at|ב-?)\s*\d{1,2}:\d{2}.*$")


def _normalize(text: str) -> str:
    text = text.strip().lower()
    # Unify geresh / apostrophe variants and strip direction marks.
    text = re.sub(r"[׳’`´]", "'", text)
    text = re.sub(r"[‎‏‪-‮⁦-⁩]", "", text)
    text = re.sub(r"\s+", " ", text)
    # "לפני 3 שעות" / "3 hours ago" -> "3 שעות"
    text = re.sub(r"^לפני\s+", "", text)
    text = re.sub(r"\s+ago$", "", text)
    return text.strip(" ·.")


def _from_date(day: int, month: int, year: int | None, now: datetime) -> timedelta | None:
    try:
        when = datetime(year or now.year, month, day)
    except ValueError:
        return None
    if year is None and when > now + timedelta(days=1):
        # "28 בדצמבר" seen in January means last year.
        when = when.replace(year=now.year - 1)
    return max(now - when, timedelta(0))


def parse_post_age(text: str | None, now: datetime | None = None) -> timedelta | None:
    if not text:
        return None
    now = now or datetime.now()
    t = _normalize(text)
    if not t:
        return None

    short = _TIME_SUFFIX.sub("", t).strip()

    if short in ("אתמול", "yesterday"):
        return timedelta(days=1)
    if short in ("היום", "today"):
        return timedelta(0)
    if short in _WORDS:
        return _WORDS[short]

    for regex, unit in _RELATIVE:
        m = regex.match(short)
        if m:
            if unit == "zero":
                return timedelta(0)
            return int(m.group(1)) * _UNIT[unit]

    # Weekday only ("יום שלישי בשעה 10:00" / "Tuesday at 10:00") = within the last week.
    weekday = _WEEKDAYS.get(short.removeprefix("יום "))
    if weekday is not None:
        days_back = (now.weekday() - weekday) % 7 or 7
        return timedelta(days=days_back)

    m = _HEB_DATE.search(t)
    if m:
        return _from_date(int(m.group(1)), HEB_MONTHS[m.group(2)], int(m.group(3)) if m.group(3) else None, now)
    m = _EN_DATE_MD.search(t)
    if m:
        return _from_date(int(m.group(2)), EN_MONTHS[m.group(1)], int(m.group(3)) if m.group(3) else None, now)
    m = _EN_DATE_DM.search(t)
    if m:
        return _from_date(int(m.group(1)), EN_MONTHS[m.group(2)], int(m.group(3)) if m.group(3) else None, now)
    m = _NUMERIC_DATE.search(t)
    if m:
        year = int(m.group(3))
        year += 2000 if year < 100 else 0
        # Israeli format: day/month/year.
        return _from_date(int(m.group(1)), int(m.group(2)), year, now)

    return None


def is_recent(text: str | None, max_days: float = 7, now: datetime | None = None) -> bool:
    """True only when the age is known AND younger than max_days."""
    age = parse_post_age(text, now)
    return age is not None and age < timedelta(days=max_days)
