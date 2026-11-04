"""Run one LinkedIn job using a locally stored Playwright session."""
import asyncio
import json
import os
import sys
import time
from urllib.parse import urlsplit


class ScrapeError(Exception):
    pass


def error_message(exc):
    return str(exc) if isinstance(exc, ScrapeError) else f'{type(exc).__name__}: {exc}'


def classify_page(url, status, text, expected_slug=None):
    path = urlsplit(url).path.lower()
    text = text.casefold().replace('’', "'")
    if status == 429:
        raise ScrapeError('rate_limited: LinkedIn returned HTTP 429')
    if any(part in path for part in ('/login', '/checkpoint', '/authwall', '/uas/login')):
        raise ScrapeError('session_expired: LinkedIn requires sign-in or verification')
    if any(s in text for s in ('too many requests', 'rate limit exceeded', 'you have reached the limit', 'slow down')):
        raise ScrapeError('rate_limited: LinkedIn is limiting requests')
    if status in (404, 410) or any(s in text for s in ("page doesn't exist", "page does not exist", "page isn't available", 'this page is unavailable', 'page not found')):
        raise ScrapeError('not_found: this LinkedIn page does not exist')
    if expected_slug and not path.startswith('/company/' + expected_slug.lower() + '/'):
        raise ScrapeError('not_found: this LinkedIn page does not exist')


def parse_company_about(text):
    """Read the visible Overview fields from LinkedIn's company About tab."""
    labels = {
        'website': 'website', 'phone': 'phone', 'industry': 'industry',
        'company size': 'company_size', 'headquarters': 'headquarters',
        'type': 'company_type', 'company type': 'company_type',
        'founded': 'founded', 'specialties': 'specialties',
    }
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    boundaries = set(labels) | {'overview', 'locations', 'employees at', 'affiliated pages',
                                'similar pages', 'updates', 'report this page'}
    result = {}
    for index, line in enumerate(lines):
        key = line.casefold().rstrip(':')
        if key == 'overview':
            end = index + 1
            while end < len(lines) and lines[end].casefold().rstrip(':') not in boundaries:
                end += 1
            if end > index + 1:
                result['about_us'] = '\n'.join(lines[index + 1:end])
        elif key in labels and index + 1 < len(lines):
            value = lines[index + 1]
            if value.casefold().rstrip(':') not in boundaries:
                result[labels[key]] = value
    return result


async def scrape_company(browser, url, check_rate_limit):
    from linkedin_scraper.models import Company

    page = browser.page
    base = urlsplit(url)
    about_url = f'{base.scheme}://{base.netloc}{base.path.rstrip("/")}/about/'
    start = time.monotonic()
    try:
        response = await page.goto(about_url, wait_until='domcontentloaded', timeout=12000)
    except Exception as exc:
        raise ScrapeError('about_not_read: LinkedIn page did not load in time') from exc
    navigation_ms = int((time.monotonic() - start) * 1000)
    status = response.status if response else None
    slug = base.path.strip('/').split('/')[1]
    await check_rate_limit(type('PageOwner', (), {'page': page})())
    body_text = await page.locator('body').inner_text(timeout=4000)
    classify_page(page.url, status, body_text, slug)
    if status and status >= 400:
        raise ScrapeError(f'about_not_read: LinkedIn returned HTTP {status}')
    main = page.locator('main').first
    try:
        await main.wait_for(state='visible', timeout=4000)
    except Exception as exc:
        raise ScrapeError('about_not_read: company About page did not appear') from exc
    heading = main.locator('[role="heading"], h1').first
    try:
        await heading.wait_for(state='visible', timeout=1500)
        name = (await heading.inner_text()).strip()
    except Exception:
        title = (await page.title()).strip()
        if ': ' not in title or not title.endswith(' | LinkedIn'):
            raise ScrapeError('about_not_read: company name was not found')
        name = title.split(': ', 1)[0]
    text = await main.inner_text()
    fields = parse_company_about(text)
    if not fields:
        raise ScrapeError('about_not_read: LinkedIn company About page returned no readable details')
    return Company(linkedin_url=url, name=name, **fields), navigation_ms


async def run(job):
    from linkedin_scraper import BrowserManager, PersonScraper
    from linkedin_scraper.scrapers.base import BaseScraper
    from linkedin_scraper.core.exceptions import RateLimitError

    # The upstream check uses text_content(), which includes hidden LinkedIn UI
    # templates containing "try again later" even on a normal company page.
    # Check visible text instead, while retaining checkpoint and CAPTCHA checks.
    async def check_rate_limit(scraper):
        page = scraper.page
        classify_page(page.url, None, '')
        captcha = page.locator('iframe[title*="captcha" i], iframe[src*="captcha" i]')
        for index in range(await captcha.count()):
            if await captcha.nth(index).is_visible():
                raise ScrapeError('session_expired: LinkedIn verification required')
        text = (await page.locator('body').inner_text(timeout=10000)).lower()
        classify_page(page.url, None, text)

    BaseScraper.check_rate_limit = check_rate_limit

    started = time.monotonic()
    async with BrowserManager(headless=True) as browser:
        await browser.load_session(os.environ['LINKEDIN_SESSION'])
        if job['kind'] == 'company':
            data, navigation_ms = await scrape_company(browser, job['url'], check_rate_limit)
        else:
            data = await PersonScraper(browser.page).scrape(job['url'])
            navigation_ms = None
        return {'kind': job['kind'], 'url': job['url'], 'data': data.model_dump(mode='json'),
                'navigationMs': navigation_ms,
                'provider': 'linkedin-scraper', 'tookMs': int((time.monotonic() - started) * 1000)}


if __name__ == '__main__':
    try:
        with open(sys.argv[1], encoding='utf-8') as f:
            job = json.load(f)
        print(json.dumps({'ok': True, 'result': asyncio.run(run(job))}, ensure_ascii=True))
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': error_message(exc)}, ensure_ascii=True))
