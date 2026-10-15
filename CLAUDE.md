# tuya-zoho

Tuya lock unlocks -> Zoho People check-ins. The live code is the Cloudflare
Worker in `cf-worker/`; see `README.md` for the file map. Notes that name
employees (pending enrollments, open questions) are in `CLAUDE.local.md`,
which is not in git.

## Check at the start of every session

- **Egypt time zone.** The Worker (`cf-worker/src/time.js`) and
  `unlock-report.py` both use the tz database zone `Africa/Cairo`, so DST is
  handled with no hand-written rule. If anyone adds a fixed offset or a DST
  if-condition back, tell the user it is redundant and can be removed.
- **Tuya IoT Core trial** ends 7 Apr 2027. After that every Tuya call fails
  with `28841002` until it is extended.

## Rules

- The repo is public. No employee names, Zoho IDs, slot owners or device IDs
  in tracked files, commit messages or examples. Real data goes in
  `cf-worker/src/mapping.js`, `private/` or `CLAUDE.local.md`, all ignored.
- Secrets stay out of git: Tuya access ID and secret, Zoho client secret and
  refresh token, `ADMIN_KEY`, and the locks' `local_key`s (in
  `private/local-lan/`). The Worker reads them from `wrangler secret`;
  `unlock-report.py` reads `.env`.
- Read-only against the locks. Never call `door-lock/dynamic-password` (it
  creates a real door code) or any endpoint that writes to a lock.
- `npx wrangler deploy` and `/run` post real check-ins to Zoho. Ask the user
  before either.
- Slot numbers are per lock. `cf-worker/src/mapping.js` has one table per lock.
- Tuya Trial Edition allows 26,000 calls a month. The current schedule uses
  about 18,700; recheck the budget before changing the cron or adding a lock.
