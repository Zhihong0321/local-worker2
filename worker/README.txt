LOCAL GMAP WORKER
=================

Turns this Windows PC into a Google Maps scan worker for your Local Gmap
Worker API service. The service hands it a Maps job (for example "factory in
Taman Daya"), the PC reads the businesses from Google Maps on its own internet
line, and posts them back.

It also reads web pages for the service: given a link, it fetches the page on
this PC's line and posts back its text as markdown.

START
  1. Unzip this folder somewhere it can stay (for example C:\LocalGmapWorker).
  2. Double-click "Start Local Gmap Worker.cmd". A window opens and shows what
     the worker is doing. If Windows asks whether to run the file, choose Run.
     It also puts a "Local Worker v2" shortcut on the desktop to start it again.
  3. Double-click "Enable autostart.cmd" so the worker starts by itself each
     time you sign in to Windows. "Disable autostart.cmd" undoes it.

NEEDS
  Windows 10 or 11. Nothing to install and no browser: it uses Windows
  PowerShell, which Windows already has, and almost no memory. For web pages
  and PDFs it downloads its own copy of Python on first start (about 300 MB, into
  %LOCALAPPDATA%\LocalGmapWorker\python). That changes nothing else on the PC.

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

  A web page job is one page, no browser. The worker refuses links to this
  PC's own network (router, other PCs, localhost).

SETTINGS (worker.env)
  HUB_URL            the API service
  WORKER_KEY         this worker's key. It can only take and answer jobs.
  WORKER_NAME        optional; default pc-<computer name>
  GMAP_PACE_MS       optional; pause between Google requests, default 500
  WEB_FETCH          optional; off = Maps jobs only, no web pages

FILES ON THIS PC
  %LOCALAPPDATA%\LocalGmapWorker\worker.log   what the worker did
  %LOCALAPPDATA%\LocalGmapWorker\unsaved\     results the service could not take
  %LOCALAPPDATA%\LocalGmapWorker\python\      Python for web pages and PDFs
