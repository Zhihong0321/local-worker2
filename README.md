# Local Gmap Worker

Google Maps scans and web page reads as an API. The service is a small job
queue (one Node file, no dependencies) that runs on Railway. Windows PCs running
the worker claim each job and run it on the PC's own internet line: a scan reads
the businesses from Google Maps' own result-list pages (no browser, almost no
RAM); a fetch reads one page and returns it as markdown, in place of Jina Reader
or Tavily extract.

Forked on 2026-11-03 from `agy-lab/local-worker` + `agy-lab/src/gmap-worker.ts`
in automation-tools (the EE Auto hub's Gmap Local Worker).

```
caller ──POST /api/scan──▶  service (Railway)  ◀──GET /api/jobs/next── worker.ps1 (Windows PC)
       ◀──── result ──────                     ◀──POST /api/jobs/:id/result──  └─▶ google.com/search?tbm=map
```

## Files

| File | What |
|---|---|
| `server.mjs` | The API service and job queue (in memory) |
| `strategy.mjs` | The sweep words each worker reads per job (business / factory / shop families, street forms) |
| `package.mjs` | Builds `LocalGmapWorker.zip` with a ready `worker.env` |
| `worker/worker.ps1` | The PC worker, Windows PowerShell 5.1, nothing to install |
| `worker/fetch.py` | One page fetch: curl_cffi (Chrome's TLS fingerprint) + Scrapling's parser and markdown, no browser |
| `adsearch.mjs` | The countries (Meta code, Google region id) and industry words an ads research searches |
| `worker/ads.mjs` | One `ads.research` job: advertisers in a country and industry, from Google's Ads Transparency Center and Meta's Ad Library |
| `worker/chat.mjs` | Forwards `chat.ask` jobs to the local ChatGPT bridge |
| `worker/chat_bridge.mjs` | Local WebSocket bridge server (port 8765) between worker and Chrome extension |
| `worker/extension/` | Chrome extension (Manifest V3) bridging web ChatGPT directly to worker |
| `worker/*.cmd` | Start, enable / disable autostart |
| `form-worker/` | Form Worker (Windows and macOS): checks lead websites for a contact form and sends contact-form messages, for the hub's form routes. Own `package.json`; see its README |
| `test/server.test.mjs` | Round trip over HTTP with a pretend worker (`npm test`) |

## Deploy on Railway

1. New service from this repo. Railway runs `npm start` (Node 22.2+).
2. Set one variable: `API_KEY`, 16+ random characters. Optional: `PUBLIC_URL`
   (the address baked into worker packages; default is the address you call),
   `QUEUE_TIMEOUT_MS` (fail a scan no worker took, default 30 min).
3. Health check path: `/health`.
4. Optional, for AI advice on audits (`advise.mjs`): `AGY_URL` and `AGY_TOKEN`
   (the cloud agy hub, Gemini Flash; `AGY_ACCOUNTS` lists its accounts to run
   pages in parallel), and a backup OpenAI-compatible model: `ADVICE_BACKUP_URL`,
   `ADVICE_BACKUP_KEY`, `ADVICE_BACKUP_MODEL` (default `YL-DeepSeek-V4.1-Flash`,
   on YuanFlow `https://yuanchengqu.com/v1`). Either one is enough.

## Set up a worker PC

```bash
curl -H "Authorization: Bearer $API_KEY" -o LocalGmapWorker.zip https://<service>/api/worker/package
```

Unzip on the PC and double-click `Start Local Gmap Worker.cmd`. On first start,
it installs dependencies and enables startup at Windows sign-in. The zip holds `WORKER_KEY`, an HMAC of `API_KEY`: it
only reaches the worker routes. Rotating `API_KEY` means downloading a fresh
package.

## Site lookup

`POST /api/lookup {"handler":"MY-lpeph.gov.my/w1","keyword":"..."}` runs one
handler from `handlers/` (listed in `handlers/index.json`) on a worker PC and
returns its answer unchanged: `status` is `found`, `not_found`,
`couldnt_check` or `layout_changed`, with `records`. The hub puts the handler's
source in the job; the worker runs it with its own portable Node 24
(`%LOCALAPPDATA%\LocalGmapWorker\node`, set up on first start) under
`--permission` and `--use-system-ca`, one process per job, with an empty
environment. The hub runs one lookup per host at a time. `GET /api/handlers`
shows each handler's health; the hub checks every handler's canary keywords
60 s after it starts (`HANDLER_CHECK_START_DELAY_MS`) and then daily
(`HANDLER_CHECK_INTERVAL_MS`, `0` turns both off). Full routes on the API page
(`/`, `docs/index.html`).

## Ads research (`ads.research`)

`POST /api/ads {"country":"Malaysia","industry":"solar","wait":300}` lists who advertises in a
country and industry, read by a worker PC on its own line from two libraries:

- **Google Ads Transparency Center**: the Transparency Center's own calls
  (`adstransparency.google.com/anji/_/rpc/SearchService/*`), no browser. Advertisers and
  websites matching the industry words, then the ads each shows in the country (Google's region id
  is 2000 plus the ISO 3166 number: Malaysia 2458; the filter is field 8 of the search).
- **Meta Ad Library**: the library page opened in the PC's Edge or Chrome, headless, driven over
  DevTools like `shot.mjs`. The first ads are in the page; scrolling makes it ask for the rest,
  which are read off the wire. No login.

The service works out the words (`adsearch.mjs`) and the PC does the reading, so `worker/ads.mjs`
is shared by the Windows and macOS workers (the macOS one runs it from `worker/`). A source that
fails, is rate-limited (Google answers HTTP 429 to a line that asks too often: the worker waits twice,
then stops asking) or has no browser comes back labelled in `google.status` / `meta.status` and the
other source is still returned. Routes and fields are on the API page.

## ChatGPT Web Bridge (`chat.ask`)

`POST /api/chat {"prompt":"Malaysia Top News today","wait":60}` routes questions
to an active web ChatGPT session in a worker PC's browser and returns the live generated
answer.

### How it works:
1. The PC worker runs a zero-dependency WebSocket bridge server (`chat_bridge.mjs`) on `127.0.0.1:8765`.
2. The user loads the Chrome extension from `worker/extension/` (via `chrome://extensions` -> "Load unpacked").
3. When `POST /api/chat` is called on the Hub, the worker receives the job, forwards it over WebSocket to the extension, which types the prompt into ChatGPT (`chatgpt.com`), clicks send, extracts the generated response stream, and returns it back through the Hub as the API answer.

```bash
curl -X POST https://<service>/api/chat \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Malaysia Top News today","wait":60}'
```

## Run a test hub and worker on Windows

This runs beside the PC's real worker without touching it: the test worker gets
its own data folder and lock from `LOCAL_GMAP_WORKER_DATA`, and with that set it
makes no Startup or desktop shortcut. Run it from a checkout of this repo, not
from the real worker's folder. PowerShell, from the repo root.

1. Start a local hub (window 1). `HANDLER_CHECK_INTERVAL_MS=0` keeps it from
   sending every handler's canary to your test worker at start.

   ```powershell
   $env:API_KEY = 'test-api-key-0123456789'; $env:PORT = '18080'; $env:HANDLER_CHECK_INTERVAL_MS = '0'
   node server.mjs
   ```

2. Write `worker.env` in the repo root (git ignores it). `WEB_FETCH=off` skips
   the Python setup; site lookup needs only Node.

   ```powershell
   $env:API_KEY = 'test-api-key-0123456789'
   $key = node -e "import('./server.mjs').then(m=>{console.log(m.workerKey());process.exit(0)})"
   "HUB_URL=http://localhost:18080`nWORKER_KEY=$key`nWORKER_NAME=test-pc`nWEB_FETCH=off" | Set-Content -Encoding ascii worker.env
   ```

3. Start the test worker (window 2). Its first start downloads Node (about
   30 MB) into the test data folder; wait for `site lookup is ready` in the log.

   ```powershell
   $env:LOCAL_GMAP_WORKER_DATA = "$env:TEMP\LocalGmapWorker-test"
   powershell -NoProfile -ExecutionPolicy Bypass -File worker\worker.ps1
   ```

4. Post a lookup pinned to it (window 3), or check one handler's canaries:

   ```powershell
   $h = @{ Authorization = 'Bearer test-api-key-0123456789' }
   $body = '{"handler":"MY-lpeph.gov.my/w1","keyword":"CHESTER PROPERTIES SDN BHD","worker":"test-pc"}'
   (Invoke-RestMethod -Method Post http://localhost:18080/api/lookup -Headers $h -ContentType 'application/json' -Body $body).job.result | ConvertTo-Json -Depth 6
   Invoke-RestMethod -Method Post http://localhost:18080/api/handlers/check -Headers $h -ContentType 'application/json' -Body '{"handler":"MY-apps.span.gov.my/w1"}' | Out-Null
   (Invoke-RestMethod http://localhost:18080/api/handlers/check -Headers $h).run.handlers | ConvertTo-Json -Depth 4
   ```

5. Stop with Ctrl+C in windows 1 and 2, then
   `Remove-Item worker.env; Remove-Item -Recurse "$env:TEMP\LocalGmapWorker-test"`.

## API

All routes take `Authorization: Bearer <API_KEY>` (or `x-api-key`).

**`POST /api/scan`** — queue a scan.

```json
{ "keyword": "factory", "place": "Taman Daya", "max": 200, "wait": 600 }
```

- `keyword`, `place`: at least one. `keyword` `business`, `factory` or `shop`
  with a `place` runs a sweep over that family's words (plus a street sweep
  for `business`); any other keyword is one plain search, up to 300 results.
- `max`: 1–500, default 200.
- `wait`: seconds to hold the request open for the result (max 900). Without
  it the answer is `202` with the job id at once.
- `timeoutMs`: the scan's deadline, 120000–1800000, default 600000. The worker
  posts what it has at the deadline.
- `searchMode: "location_only"`: search the place alone.
- `worker`: pin the scan to one worker by name.

Answer: `{ job }` with `id`, `status` (`pending`, `running`, `done`,
`failed`), `worker`, `error`, and `result` once done:

```json
{ "query": "factory in Taman Daya", "found": 374, "capped": false,
  "businesses": [{ "name": "...", "phone": "...", "website": "...", "address": "...",
    "rating": 4.5, "reviews": 12, "category": "...", "place_id": "...", "mapsUrl": "..." }],
  "googleRequests": 128, "stoppedEarly": null, "tookMs": 162000, "worker": "pc-office-1" }
```

**`POST /api/fetch`** — read one page on a worker PC. Answers with the page in
the same call unless `wait` says otherwise.

```json
{ "url": "https://example.com/article", "format": "markdown" }
```

- `format`: `markdown` (default), `text` or `html`.
- `mainContent`: default `true`: the page's `<main>`/`<article>` when it holds
  most of the text, without nav, header, footer, scripts and hidden elements.
- `wait`: seconds to hold the request; default the timeout + 30 s; `0` answers
  `202` at once.
- `timeoutMs`: 10000–300000, default 60000. A fetch no worker claims in that
  time fails.
- `worker`: pin it to one worker.

`result`: `{ url, finalUrl, status, contentType, title, format, content,
length, truncated, provider: "scrapling-local", tookMs, worker }`. PDFs come
back as markdown with tables (pymupdf4llm), about 0.4 s a page; past the
deadline the pages read so far, `truncated: true`. Limits 30 MB, 300 pages, no
OCR. HTTP 400+, another kind of file or a private address fails the job. No browser, so content
only JavaScript draws is missing.

**`POST /api/audit`** queues an SEO + GEO benchmark on a worker that opts into
`site.audit`: send `{ "url": "https://example.com/" }`, optionally `maxPages`
(1–25 besides the home page, default 5), `botTest` (boolean, default true),
`worker`, and `timeoutMs` (30000–600000, default 180000). It waits for the report
by default; `wait` overrides the wait in seconds and `wait: 0` returns `202`
with the job id immediately. Poll `GET /api/jobs/:id`; a completed call returns
`200` and the worker's result unchanged, including `scores`, `checks`, `pages`
and `tookMs`. An unclaimed audit fails after its own timeout.

**`POST /api/audit/:id/advice`** asks an AI model for page-by-page suggestions
on a finished audit: rewrites that quote the page, questions buyers ask that
the page does not answer, and the top 5 actions for the site. The cloud agy hub
answers first (sandboxed, since page text is untrusted); the backup model
answers when agy fails or does not return the JSON asked for. A suggestion that
quotes text the page does not have is dropped. It runs once per audit and takes
a minute or two: the call waits 20 s by default (`wait`, up to 240), answers `202`
while running, and `GET /api/audit/:id/advice?wait=60` picks it up. `503` when no
model is set up, `409` before the audit is done. The scores never come from the AI.

**`GET /api/scan/:id?wait=60`** — the job; `wait` holds until it finishes
(`/api/fetch/:id` is the same route).
**`DELETE /api/scan/:id`** — cancel.
**`GET /api/scans?status=running&type=web.fetch`** — recent jobs, without results.
**`GET /api/workers`** — every worker seen: `live`, current `job`, `coolUntil`.
**`GET /api/worker/package`** — the worker zip.

## Behaviour worth knowing

- **Google refusal.** On 429 / 403 / captcha the worker posts what it has and
  sends `retryAfterMs` (30 min); the service gives that worker no scans
  meanwhile, but it still takes fetches.
- **Lost workers.** A running job whose lease (deadline + 3 min) runs out goes
  back to the queue; after 3 lost workers it fails.
- **Restarts.** The queue is in memory, so a redeploy drops pending scans. A
  scan in progress survives: the worker posts its payload with the result, and
  the service files it again under the same id. A result the service never
  takes stays on the PC in `%LOCALAPPDATA%\LocalGmapWorker\unsaved\` and is
  offered again on the worker's next start.
- **Fetches.** The worker sets up its own Python 3.12 (embeddable build) and
  `scrapling`, `curl_cffi`, `markdownify` under `%LOCALAPPDATA%\LocalGmapWorker\python`
  on first start, about 60 MB from python.org and PyPI (40 s on 2026-11-04),
  then the PDF reader (`pymupdf4llm` without its layout model, about 160 MB) as its own step: if
  only that fails, web pages still work and PDF jobs fail until it is retried.
  pymupdf4llm is AGPL-3.0 (Artifex sells a commercial licence).
  Until that works (retried hourly) it takes scans only. Each hop of a fetch,
  redirects included, must resolve to a public address, so a caller cannot
  reach the PC's LAN. `WEB_FETCH=off` in `worker.env` keeps a PC to scans.
- **Screenshots.** `web.shot` runs `worker/shot.mjs` on the worker's portable
  Node and drives the browser the PC already has over the DevTools protocol:
  Microsoft Edge on Windows, Google Chrome on a Mac (`SHOT_BROWSER` names
  another), headless on a throwaway profile. Nothing is downloaded. A worker
  without that browser, or with `WEB_SHOT=off`, does not poll `web.shot`. Every
  request the page makes must go to a public address. A Cloudflare challenge or
  another bot check is reported as `blocked` and never answered: the shot stops
  at the challenge page and sends no image.
- **Pace.** 500 ms between Google requests (`GMAP_PACE_MS` in `worker.env`),
  up to 15 pages of 20 per search. Measured 2026-10-29: factory sweep of Taman
  Daya, 818 businesses in 2.7 min from 128 requests.
