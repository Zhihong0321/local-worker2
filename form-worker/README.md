# Form Worker

Two website jobs from the hub, run on a PC or a Mac on its own internet line:

1. **Form check (scan).** The hub hands out Malaysian lead websites. The worker reads the homepage
   and its contact pages and returns a verdict: `bot_can_submit`, `captcha`, `script_form`,
   `no_form`, `unreachable`, `no_website` or `not_own_site`. Only the verdict goes back.
2. **Form send (send).** The hub hands out one contact-form message at a time, with the exact
   subject, message and sender it logged. The worker fills the form with a headless Chrome on this
   machine, presses send, reads the answer and sends back the outcome, the boxes it filled and a
   screenshot. The hub keeps the record.

One Node program runs on both Windows and macOS. The platform parts are only the launchers, the
autostart, and where the log and settings live.

```
hub (ee-auto, Railway)  ◀── /api/form-scan/worker/take|done ──  worker.mjs  (this PC or Mac)
                        ◀── /api/form-send/worker/take|assist|done
                        └── the LLM step for boxes the script cannot place (keys stay on the hub)
```

## Files

| File | What |
|---|---|
| `worker.mjs` | The worker: settings, hub calls, the check lanes and the send lanes |
| `scan.mjs` | The form check for one website (the hub's `processLead` form part) |
| `forms.mjs` | Reading a page's forms, the verdict, the contact-page links, the send outcome |
| `send.mjs` | The send bot: one browser per message, fill, press send, read the answer |
| `web.mjs` | Reading one public page (public addresses only, 12 s, 5 MB) and the own-site check |
| `Start Form Worker.cmd` · `Enable autostart.cmd` · `Disable autostart.cmd` | Windows |
| `Start Form Worker.command` · `Enable autostart.command` · `Disable autostart.command` | macOS |
| `worker.env.example` | Settings to copy to `worker.env` |
| `test/` | Parity with the hub, form reading units, the send bot on a local form, the worker loop on a fake hub |

## Set up on Windows

Needs Node.js 22 or newer and Chrome or Edge.

1. Copy `worker.env.example` to `worker.env` and fill in `GMAP_WORKER_KEY` (the Step 2 Worker's key).
2. Double-click `Start Form Worker.cmd`. The first start runs `npm install`.
3. Once it works, double-click `Enable autostart.cmd` to start it at sign-in. Only the user runs it.

Data and log: `%LOCALAPPDATA%\FormWorker\worker.log`.

## Set up on a Mac (Mac mini)

Needs Node.js 22 or newer (nodejs.org or Homebrew) and Google Chrome.

1. Copy `worker.env.example` to `worker.env` and fill in `GMAP_WORKER_KEY`.
2. Make the scripts runnable once: `chmod +x *.command` (already set in git).
3. Double-click `Start Form Worker.command`. The first start runs `npm install`.
4. To start it at sign-in, double-click `Enable autostart.command` (a LaunchAgent). Keep the Mac awake:
   System Settings → Energy → turn off sleep, or the worker pauses when the Mac sleeps.

Data and log: `~/Library/Application Support/FormWorker/worker.log`.

## Settings

First found wins: the file `FORM_WORKER_ENV` names, `worker.env` in this folder, then the data
folder. An environment variable with the same name wins over the file.

| Setting | Default | Meaning |
|---|---|---|
| `LAB_URL` | (required) | The hub, e.g. `https://ee-auto.up.railway.app` |
| `GMAP_WORKER_KEY` or `LAB_TOKEN` | (required) | The worker key |
| `WORKER_NAME` | `form-<hostname>` | Letters, digits, dot, dash. Two machines must not share it |
| `FORM_JOBS` | `scan,send` | `scan` = website checks only; `send` = form sends only |
| `CONCURRENCY` | `6` | Websites checked at once (1 to 20) |
| `SEND_LANES` | `4` | Forms filled at once (1 to 8) |
| `CHROME_PATH` | usual install | The browser for sending |

A machine with no browser takes no send work, so no lead is marked failed for it.

## Exit codes and restarts

`worker.mjs` exits with 2 when it has nothing to do or is not set up. The launchers stop on 2 and
restart on anything else after 15 seconds.

## How it matches the hub

- `test/fixtures/scan-parity.json` holds 18 fixture sites, each with the verdict the hub's own
  `processLead` gives (generated from `agy-lab/src/list-step2.ts`). `npm test` checks the scan
  against every one.
- If the hub's verdict logic changes (`formVerdict`, `formsInHtml`, `researchWebsite`,
  `contactLinks`, the captcha rules), port the change here and regenerate the fixtures with the
  hub's `processLead`. A change made only here breaks the parity test.
- The send bot follows `agy-lab/src/contact-form-delivery.ts`. It has no database save; the hub
  records every outcome.

Known quirks kept on purpose, so the two sides agree: `classify` matches `lname` inside `fullname`
(so a `fullname` box is treated as a last-name box, which only changes what goes in it), and the
check reads forms in the HTML only, so a form drawn by script is reported as `script_form`.

## Tests

```bash
cd form-worker
npm install
npm test
```

- `scan-parity`: the scan against the hub's verdicts on 18 fixture sites. No network.
- `forms`: form reading units. No network.
- `send`: the send bot against a local form on 127.0.0.1 (a dry run, then a real send to the local
  form). Needs Chrome or Edge; skipped otherwise. No real company is contacted.
- `worker-loop`: the worker against a fake hub: one website and one form taken, done and reported.
  The website is a name that does not resolve. Needs Chrome or Edge.

Not covered by tests: the macOS launchers and LaunchAgent (no Mac here), and a real hub run.
