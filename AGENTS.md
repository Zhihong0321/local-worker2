# Agent notes: Local Gmap Worker

Read this before changing anything under `worker/`, `worker-macos/` or `strategy.mjs`.

## Two workers, one service

The service (`server.mjs`, hosted on Railway) hands out jobs. Two workers take them:

| | Windows | macOS |
|---|---|---|
| Folder | `worker/` | `worker-macos/` |
| Main script | `worker/worker.ps1` (PowerShell 5.1) | `worker-macos/app/worker.py` (Python 3.12) |
| Launchers | `*.cmd` | `*.command` |
| Ships as | zip from `GET /api/worker/package` (`package.mjs`) | the repository checkout; updated with `git pull` |
| Data | `%LOCALAPPDATA%\LocalGmapWorker` | `~/Library/Application Support/LocalGmapWorker` |

`worker.py` is a hand port of `worker.ps1`. Both must take the same jobs and post
the same results.

## What is shared, and what is not

- **Shared, change once:** `strategy.mjs` (keyword families, street forms, area-match
  share, default max). Both workers fetch it from the service on every job.
- **Shared, change once:** `worker/fetch.py`, `worker/audit.py` and its rule
  modules (`worker/audit_*.py`). The macOS worker runs these files from `worker/`.
  Do not copy them into `worker-macos/`.
- **Not shared, change both:** everything in `worker.ps1`. That covers the Google
  Maps request (`pb` string, URL, language), the field positions read from Google's
  answer, the sweep and street logic, limits and pacing, retry and rest rules,
  pinned package versions, the job types, and the result fields.

## Rules

1. **A change to `worker/worker.ps1` is not done until it is ported to
   `worker-macos/app/worker.py`**, in the same commit. The reverse also holds.
   Keep the port line for line where you can: same function order, same names
   (`Get-ListPage` and `get_list_page`), same comments.
2. Only the platform parts differ: autostart (Startup shortcut / launchd agent),
   keep-awake (`SetThreadExecutionState` / `caffeinate`), single instance
   (mutex / `flock`), the Python setup (embeddable zip / `app/runtime.sh` with uv),
   and the User-Agent's OS. Do not "port" these.
3. Run `npm test` before you commit. `test/macos-parity.test.mjs` compares the two
   scripts and fails when the Google request, the field positions, a business row,
   the scan result, the limits, the pinned packages or the captcha and street
   patterns differ. If it fails, port the change; do not edit the test to make it pass.
   The parity test covers the risky constants, not the logic. A change to the sweep
   or retry logic still has to be ported by reading both scripts.
4. If a job type or a result field is added in `server.mjs`, add it to both workers.
5. If you change the Windows package files, update `FILES` in `package.mjs`. The macOS
   worker has no package; it runs from the checkout.
6. Windows scripts stay ASCII with CRLF launchers (`.gitattributes`); PowerShell 5.1
   reads a BOM-less script as ANSI. macOS scripts are LF and must stay executable
   (`chmod +x`, which git keeps).

## Testing a worker change

- `npm test` runs the service tests and the parity test.
- To run the macOS worker against a local service without touching this Mac's
  autostart, desktop or data:

  ```bash
  API_KEY=test-api-key-0123456789 PORT=18080 node server.mjs
  ```

  Then put a `worker.env` with `HUB_URL=http://localhost:18080` and the worker key
  (`API_KEY=test-api-key-0123456789 node -e "import('./server.mjs').then(m=>{console.log(m.workerKey());process.exit(0)})"`)
  in a copy of the repository, set `LOCAL_GMAP_WORKER_DATA` to a scratch folder
  (with it set, the worker makes no launchd agent or desktop shortcut), and run
  `Start Local Gmap Worker.command`. Post a small scan with `POST /api/scan`
  (`max` 20) so you send Google only a request or two.
- The Windows worker can only be run on Windows: README.md, "Run a test hub and
  worker on Windows", has the steps, the same `LOCAL_GMAP_WORKER_DATA` override
  included. If you changed it without running it, say so.
