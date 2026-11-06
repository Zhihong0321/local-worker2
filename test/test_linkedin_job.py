import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('linkedin_job', Path(__file__).parents[1] / 'worker' / 'linkedin_job.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CompanyAboutTests(unittest.TestCase):
    def test_error_codes_are_not_prefixed_by_exception_type(self):
        for code in ('rate_limited', 'session_expired', 'not_found', 'about_not_read'):
            self.assertEqual(module.error_message(module.ScrapeError(code + ': test')), code + ': test')

    def test_page_classification(self):
        cases = [
            ('https://www.linkedin.com/login', 200, '', 'session_expired:'),
            ('https://www.linkedin.com/checkpoint/challenge', 200, '', 'session_expired:'),
            ('https://www.linkedin.com/company/a/about/', 429, '', 'rate_limited:'),
            ('https://www.linkedin.com/company/a/about/', 200, 'Too many requests', 'rate_limited:'),
            ('https://www.linkedin.com/company/a/about/', 403, 'Sorry, you have been blocked\nYou are unable to access linkedin.com', 'rate_limited:'),
            ('https://www.linkedin.com/company/a/about/', 404, '', 'not_found:'),
            ('https://www.linkedin.com/company/a/about/', 200, "This page doesn't exist", 'not_found:'),
        ]
        for url, status, text, error in cases:
            with self.subTest(error=error), self.assertRaisesRegex(module.ScrapeError, error):
                module.classify_page(url, status, text)
        module.classify_page('https://www.linkedin.com/company/a/about/', 200, 'Try again later in our product', 'a')

    def test_overview_and_company_fields(self):
        text = '''Acme\nOverview\nWe help customers.\nWebsite\nhttps://example.com\nIndustry\nAccounting\nCompany size\n51-200 employees\nHeadquarters\nKuala Lumpur\nType\nPrivately Held\nFounded\n2001\nSpecialties\nTax, Audit\nLocations\nMalaysia'''
        data = module.parse_company_about(text)
        self.assertEqual(data['about_us'], 'We help customers.')
        self.assertEqual(data['website'], 'https://example.com')
        self.assertEqual(data['company_size'], '51-200 employees')
        self.assertEqual(data['headquarters'], 'Kuala Lumpur')
        self.assertEqual(data['company_type'], 'Privately Held')
        self.assertEqual(data['founded'], '2001')
        self.assertEqual(data['specialties'], 'Tax, Audit')

    def test_missing_values_are_not_confused_with_labels(self):
        self.assertEqual(module.parse_company_about('Overview\nWebsite\nIndustry\nAccounting\nLocations'), {'industry': 'Accounting'})


if __name__ == '__main__':
    unittest.main()
