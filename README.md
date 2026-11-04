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
| `worker/*.cmd` | Start, enable / disable autostart |
| `test/server.test.mjs` | Round trip over HTTP with a pretend worker (`npm test`) |

## Deploy on Railway

1. New service from this repo. Railway runs `npm start` (Node 22.2+).
2. Set one variable: `API_KEY`, 16+ random characters. Optional: `PUBLIC_URL`
   (the address baked into worker packages; default is the address you call),
   `QUEUE_TIMEOUT_MS` (fail a scan no worker took, default 30 min).
3. Health check path: `/health`.

## Set up a worker PC

```bash
curl -H "Authorization: Bearer $API_KEY" -o LocalGmapWorker.zip https://<service>/api/worker/package
```

Unzip on the PC, double-click `Start Local Gmap Worker.cmd`, then
`Enable autostart.cmd`. The zip holds `WORKER_KEY`, an HMAC of `API_KEY`: it
only reaches the worker routes. Rotating `API_KEY` means downloading a fresh
package.

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
length, truncated, provider: "scrapling-local", tookMs, worker }`. HTTP 400+,
a non-page file or a private address fails the job. No browser, so content
only JavaScript draws is missing.

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
  on first start, about 60 MB from python.org and PyPI (40 s on 2026-11-04).
  Until that works (retried hourly) it takes scans only. Each hop of a fetch,
  redirects included, must resolve to a public address, so a caller cannot
  reach the PC's LAN. `WEB_FETCH=off` in `worker.env` keeps a PC to scans.
- **Pace.** 500 ms between Google requests (`GMAP_PACE_MS` in `worker.env`),
  up to 15 pages of 20 per search. Measured 2026-10-29: factory sweep of Taman
  Daya, 818 businesses in 2.7 min from 128 requests.
