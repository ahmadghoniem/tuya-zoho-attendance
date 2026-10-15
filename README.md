# Tuya lock -> Zoho People attendance

Turns face / fingerprint / password unlocks on Tuya smart locks into Zoho
People check-ins.

| Path | What it is |
|---|---|
| `cf-worker/` | The sync: a Cloudflare Worker (`tuya-zoho-attendance`) that polls every lock every 2 minutes, 08:00-18:00 Egypt time, and posts check-ins. Setup is in `cf-worker/README.md`. |
| `cf-worker/src/mapping.example.js` | Template for `mapping.js`: lock slot (`unlock_face|39`) -> Zoho employee ID, one table per lock. |
| `unlock-report.py` | Present/absent report for one employee from the lock logs (`python unlock-report.py 26 14`). Reads `TUYA_CLIENT_ID` and `TUYA_SECRET` from `.env`. |
| `CLAUDE.md` | Notes for Claude Code sessions on this project. |

## Not in the repo

These hold real employee data or credentials and are listed in `.gitignore`:

- `cf-worker/src/mapping.js`: the real slot -> employee map. Copy
  `mapping.example.js` to start one.
- `.env`, `cf-worker/.dev.vars`: Tuya credentials for local runs.
- `private/`: employee exports, raw lock snapshots, device metadata with the
  locks' `local_key`s, and older mapping tables.
- `CLAUDE.local.md`: notes that name employees.

The Worker's secrets (Tuya, Zoho, `ADMIN_KEY`) live in `wrangler secret`.

## Tuya plan limits

The Tuya IoT Core Trial Edition allows 26,000 API calls a month and has to be
extended every few months; when it lapses, every Tuya call fails with
`28841002`. The current schedule uses about 18,700 calls a month for two
locks.
