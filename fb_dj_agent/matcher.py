"""Decide whether a post's text is someone looking for a DJ."""

from __future__ import annotations

import re

# Spellings of "DJ" people actually write in Hebrew posts.
DJ_WORD = r"(?:די\s?ג'?\s?יי|דיג'?יי|דיגיי|דיג'י|די\.?ג'י|d\.?j\.?|dj'?s?|תקליטן|תקליטנית)"

DEFAULT_INCLUDE = [
    # "מחפש/ת דיג'יי", "צריכים DJ לחתונה", "ממליצים על די ג'יי?"
    r"(?:מחפש|מחפשת|מחפשים|מחפשות|צריך|צריכה|צריכים|דרוש|דרושה|דרושים|"
    r"ממליצים|ממליצות|המלצה|המלצות|תמליצו|מכירים|מכירות|מישהו מכיר|יש למישהו|יש לכם|"
    r"looking for|need|recommend)[^\n.!?]{0,40}?" + DJ_WORD,
    # "DJ לחתונה / לבר מצווה / לאירוע ... ?"
    DJ_WORD + r"\s*(?:טוב\s*)?ל(?:חתונה|בר|בת|אירוע|מסיבה|חינה|ברית|יום הולדת)[^\n]{0,60}\?",
]

# Posts from DJs advertising themselves, not people looking for one.
DEFAULT_EXCLUDE = [
    r"אני\s+" + DJ_WORD,
    r"(?:פנוי|פנויה|זמין|זמינה)\s+ל(?:אירועים|תאריכים)",
    r"מחפש(?:ת)?\s+(?:עבודה|אירועים|הופעות|לקוחות)",
]


def normalize(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[׳’`´\"״]", "'", text)
    text = re.sub(r"[‎‏‪-‮⁦-⁩]", "", text)
    return re.sub(r"[ \t]+", " ", text)


class PostMatcher:
    def __init__(self, include: list[str] | None = None, exclude: list[str] | None = None):
        self.include = [re.compile(p, re.IGNORECASE) for p in (include or DEFAULT_INCLUDE)]
        self.exclude = [re.compile(p, re.IGNORECASE) for p in (exclude or DEFAULT_EXCLUDE)]

    def might_match(self, text: str) -> bool:
        """Cheap pre-check (ignores exclusions) used before reading the post in detail."""
        t = normalize(text)
        return any(rx.search(t) for rx in self.include)

    def match(self, text: str) -> str | None:
        """Return the matched phrase, or None if the post isn't a DJ request."""
        t = normalize(text)
        if any(rx.search(t) for rx in self.exclude):
            return None
        for rx in self.include:
            m = rx.search(t)
            if m:
                return m.group(0)
        return None
