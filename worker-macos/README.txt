LOCAL GMAP WORKER FOR macOS
===========================

Turns this Mac into a Google Maps scan worker for your Local Gmap Worker API
service. The service hands it a Maps job (for example "factory in Taman Daya"),
the Mac reads the businesses from Google Maps on its own internet line, and
posts them back.

It also reads web pages and PDFs, and runs SEO and GEO audits of websites.

This is the macOS version of the Windows worker in ../worker. It takes the same
jobs from the same service and returns the same results. It runs the Windows
worker's own page and audit scripts (../worker/*.py), so it must stay in the
repository checkout, next to the worker folder.

START
  1. Clone the repository somewhere it can stay (for example ~/local-worker2).
     This folder is worker-macos inside it.
  2. Put worker.env in this folder, next to "Start Local Gmap Worker.command".
     Take it from the Windows package (GET /api/worker/package with your
     API_KEY, unzip, copy LocalGmapWorker/worker.env), or copy
     worker.env.example to worker.env and fill in HUB_URL and WORKER_KEY.
  3. Double-click "Start Local Gmap Worker.command". It opens in Terminal. On
     first start it downloads and installs the required components. Keep the
     Terminal window open. If macOS says the file cannot be opened, right-click it,
     choose Open, then Open again. A "Local Worker v2" shortcut is put on the
     desktop.
  4. The worker starts automatically, in the background, when you sign in to
     this Mac. Use "Disable autostart.command" to turn this off, or "Enable
     autostart.command" to turn it back on. macOS lists it under System
     Settings > General > Login Items & Extensions.

NEEDS
  macOS on Apple silicon or Intel, and an internet connection. No
  admin password, Homebrew or Xcode. The first start downloads Python (through
  uv), the page reader and the PDF reader automatically. Allow a few minutes
  for the downloads.

  The worker keeps the Mac from sleeping while a scan runs (caffeinate). A Mac
  that is asleep or has its lid closed takes no jobs: for a Mac mini or an
  always-on Mac, set System Settings > Energy > "Prevent automatic sleeping
  when the display is off".

WHERE THINGS ARE
  ~/Library/Application Support/LocalGmapWorker
    worker.log          what the worker did
    launchd.log         output of the background (autostart) run
    venv/               the worker's own Python and packages
    unsaved/            results the service did not take yet; offered again
                        on every start
  ~/Library/LaunchAgents/local.gmapworker.plist   autostart

UPDATE
  In the repository folder: git pull. Then stop the worker (Ctrl+C) and start
  it again. A changed package version installs itself on that start.

STOP
  Press Ctrl+C in the Terminal window. A background (autostart) worker stops
  when you sign out, or with:
    launchctl bootout gui/$(id -u)/local.gmapworker

HOW IT WORKS
  Exactly as on Windows (see ../worker/README.txt): it reads Google Maps' list
  pages directly, 20 businesses a page, half a second apart, runs the
  service's sweep for each job, stops at the job's deadline and posts what it
  has. If Google refuses the line it takes no Maps jobs for 30 minutes but
  still reads web pages.

  It also takes ads research jobs: who advertises in one country and industry,
  read from Google's Ads Transparency Center (no browser) and Meta's Ad Library
  (opened in Google Chrome, headless; without Chrome only Google's side is read).

SETTINGS (worker.env)
  HUB_URL            the service, for example https://myworker.up.railway.app
  WORKER_KEY         the worker key from the service package
  WORKER_NAME        name shown by the service (default: mac-<this Mac's name>)
  GMAP_PACE_MS       pause between Google requests (default 500)
  WEB_FETCH=off      Maps scans only
  WEB_SHOT=off       no screenshots (they use Google Chrome, headless)
  SHOT_BROWSER       another Chromium browser for screenshots (default: Chrome)
