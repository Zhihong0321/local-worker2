LOCAL GMAP WORKER
=================

Turns this Windows PC into a Google Maps scan worker for your Local Gmap
Worker API service. The service hands it a Maps job (for example "factory in
Taman Daya"), the PC reads the businesses from Google Maps on its own internet
line, and posts them back.

It also reads web pages and PDFs, and runs SEO and GEO audits of websites.

START
  1. Unzip this folder somewhere it can stay (for example C:\LocalGmapWorker).
  2. Double-click "Start Local Gmap Worker.cmd". On first start it downloads
     and installs the required components. Keep the worker window open. If Windows
     asks whether to run the file, choose Run. A desktop shortcut is created.
  3. The worker starts automatically when you sign in to Windows. Use
     "Disable autostart.cmd" to turn this off, or "Enable autostart.cmd" to
     turn it back on.

NEEDS
  Windows 10 or 11 and an internet connection. The first start downloads Python
  and the PDF reader automatically. Allow a few minutes for the downloads.

HOW IT WORKS
  Google Maps fills its result list from pages of 20 businesses, each with its
  phone, website, address, rating, category and Google place id. The worker
  reads those pages directly, one after another, half a second apart. The
  field positions come from gosom/google-maps-scraper (MIT licence).

  For each job it runs the service's sweep: "<word> in <place>" for each word
  of the keyword's family (business, factory, shop), pinned to the place on the
  map, then, for a Business scan, "shop in <street>" and "company in <street>"
  for the streets it found. Any other keyword is one plain search. It stops at
  the job's deadline and posts what it has.

  If Google refuses this line, the worker posts what it found, rests for 30
  minutes, and the service gives its jobs to other workers meanwhile. It keeps
  the PC awake only while a job runs. It still reads web pages while resting.

  A screenshot job opens one page in Microsoft Edge, headless (no window),
  on a throwaway profile, and sends back a picture of it. A page that shows a
  bot check (a CAPTCHA or "Just a moment...") is reported, never answered.

  An ads research job reads who advertises in one country and industry from
  Google's Ads Transparency Center (no browser) and Meta's Ad Library (opened in the
  same browser the screenshots use). If Google limits this line it is waited out,
  not worked around; the result says so and still carries Meta's side.

  A web page job is one page, no browser. The worker refuses links to this
  PC's own network (router, other PCs, localhost).

SETTINGS (worker.env)
  HUB_URL            the API service
  WORKER_KEY         this worker's key. It can only take and answer jobs.
  WORKER_NAME        optional; default pc-<computer name>
  GMAP_PACE_MS       optional; pause between Google requests, default 500
  WEB_FETCH          optional; off = Maps jobs only, no web pages
  WEB_SHOT           optional; off = no screenshots
  SHOT_BROWSER       optional; another Chromium browser for screenshots
                     (default: Microsoft Edge, which Windows already has)

FILES ON THIS PC
  %LOCALAPPDATA%\LocalGmapWorker\worker.log   what the worker did
  %LOCALAPPDATA%\LocalGmapWorker\unsaved\     results the service could not take
  %LOCALAPPDATA%\LocalGmapWorker\python\      Python for web pages and PDFs
