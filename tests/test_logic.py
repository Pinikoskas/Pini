import unittest
from datetime import datetime, timedelta

from fb_dj_agent.agent import canonical_post_url, canonical_profile_url, fill_template
from fb_dj_agent.matcher import PostMatcher
from fb_dj_agent.post_age import is_recent, parse_post_age

NOW = datetime(2026, 10, 5, 12, 0)  # Monday


class PostAgeTests(unittest.TestCase):
    def age(self, text):
        return parse_post_age(text, NOW)

    def test_relative_hebrew(self):
        self.assertEqual(self.age("עכשיו"), timedelta(0))
        self.assertEqual(self.age("5 דק'"), timedelta(minutes=5))
        self.assertEqual(self.age("3 ש׳"), timedelta(hours=3))
        self.assertEqual(self.age("2 י'"), timedelta(days=2))
        self.assertEqual(self.age("1 שב'"), timedelta(weeks=1))
        self.assertEqual(self.age("לפני 4 שעות"), timedelta(hours=4))
        self.assertEqual(self.age("יומיים"), timedelta(days=2))
        self.assertEqual(self.age("אתמול בשעה 14:00"), timedelta(days=1))
        self.assertEqual(self.age("3 ימים"), timedelta(days=3))

    def test_relative_english(self):
        self.assertEqual(self.age("5m"), timedelta(minutes=5))
        self.assertEqual(self.age("3h"), timedelta(hours=3))
        self.assertEqual(self.age("6d"), timedelta(days=6))
        self.assertEqual(self.age("2w"), timedelta(weeks=2))
        self.assertEqual(self.age("Yesterday at 2:00 PM"), timedelta(days=1))
        self.assertEqual(self.age("3 hours ago"), timedelta(hours=3))

    def test_weekday(self):
        self.assertEqual(self.age("יום שישי בשעה 10:00"), timedelta(days=3))
        self.assertEqual(self.age("Friday at 10:00"), timedelta(days=3))

    def test_dates(self):
        self.assertEqual(self.age("1 באוקטובר").days, 4)
        self.assertEqual(self.age("יום ראשון, 28 בספטמבר 2026 בשעה 10:00").days, 7)
        self.assertEqual(self.age("September 30").days, 5)
        self.assertGreater(self.age("28 בדצמבר").days, 200)  # last year
        self.assertGreater(self.age("12 March 2024").days, 365)

    def test_unknown(self):
        self.assertIsNone(self.age(""))
        self.assertIsNone(self.age("ממומן"))
        self.assertIsNone(self.age("פיני כהן"))

    def test_is_recent_week_limit(self):
        self.assertTrue(is_recent("6 י'", 7, NOW))
        self.assertTrue(is_recent("3 ש'", 7, NOW))
        self.assertFalse(is_recent("1 שב'", 7, NOW))
        self.assertFalse(is_recent("2 שבועות", 7, NOW))
        self.assertFalse(is_recent("15 בספטמבר", 7, NOW))
        self.assertFalse(is_recent("לא ידוע", 7, NOW))


class MatcherTests(unittest.TestCase):
    def setUp(self):
        self.m = PostMatcher()

    def test_matches_requests(self):
        for text in [
            "מחפש דיג'יי לחתונה באוגוסט, המלצות?",
            "מחפשת די ג'יי טוב לבת מצווה",
            "צריכים DJ לאירוע חברה בתל אביב",
            "מישהו מכיר דיג׳יי טוב באזור הצפון?",
            "ממליצים על תקליטן לחינה?",
            "Looking for a DJ for my wedding",
            "dj לבר מצווה במרכז, מישהו?",
        ]:
            self.assertIsNotNone(self.m.match(text), text)

    def test_ignores_unrelated_and_ads(self):
        for text in [
            "איזה ערב מדהים היה אתמול",
            "אני דיג'יי עם 10 שנות ניסיון, פנוי לאירועים",
            "מחפש עבודה כדיג'יי",
            "מחפש צלם לחתונה",
        ]:
            self.assertIsNone(self.m.match(text), text)


class HelperTests(unittest.TestCase):
    def test_profile_url(self):
        self.assertEqual(
            canonical_profile_url("https://www.facebook.com/groups/555/user/123456/?__cft__=x"),
            "https://www.facebook.com/profile.php?id=123456",
        )
        self.assertEqual(canonical_profile_url("https://www.facebook.com/dana.levi?__tn__=R"), "https://www.facebook.com/dana.levi")
        self.assertEqual(canonical_profile_url("https://www.facebook.com/groups/555/"), "")

    def test_post_url(self):
        self.assertEqual(
            canonical_post_url("https://www.facebook.com/groups/555/posts/777/?__cft__[0]=abc&__tn__=R"),
            "https://www.facebook.com/groups/555/posts/777",
        )
        self.assertEqual(
            canonical_post_url("https://www.facebook.com/permalink.php?story_fbid=9&id=8&__cft__=x"),
            "https://www.facebook.com/permalink.php?story_fbid=9&id=8",
        )

    def test_template(self):
        self.assertEqual(fill_template("היי {name}! מה נשמע", "דנה לוי"), "היי דנה! מה נשמע")
        self.assertEqual(fill_template("היי {name}! מה נשמע", ""), "היי! מה נשמע")


if __name__ == "__main__":
    unittest.main()
