"""Open LinkedIn for manual login and save the session locally."""
import asyncio
import sys
from linkedin_scraper import BrowserManager, wait_for_manual_login


async def main():
    async with BrowserManager(headless=False) as browser:
        await browser.page.goto('https://www.linkedin.com/login')
        await wait_for_manual_login(browser.page, timeout=300000)
        await browser.save_session(sys.argv[1])
        print('Session saved.')


asyncio.run(main())
