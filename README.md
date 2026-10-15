# tuya-zoho-attendance

Automatic office attendance from smart-lock unlocks. When an employee opens
a Tuya smart lock with their face, fingerprint, card or door code, a
Cloudflare Worker sees the unlock and checks that employee in on
Zoho People, at the time the door was opened.

Nobody has to open the Zoho app in the morning, and the check-in time is
the time they actually arrived.

## How it works

```
 ┌────────────┐   unlock event   ┌────────────┐   every 2 min    ┌───────────────────┐   check-in    ┌─────────────┐
 │ Tuya lock  │ ───────────────► │ Tuya Cloud │ ◄─────────────── │ Cloudflare Worker │ ────────────► │ Zoho People │
 │ face/finger│                  │  (log API) │   "unlocks since │  slot -> employee │  empId + time │ attendance  │
 └────────────┘                  └────────────┘    last run?"    └───────────────────┘               └─────────────┘
                                                                          │
                                                                          ▼
                                                                  Workers KV: cursor,
                                                                  posted ids, tokens
```

1. Each lock reports every unlock to Tuya Cloud as a log entry such as
   `{ "code": "unlock_face", "value": "39", "event_time": 1791354249735 }`.
   `code` is the unlock method and `value` is the credential slot on that
   lock.
2. A cron trigger runs the Worker every 2 minutes during working hours. For
   each lock it asks Tuya's log API for all unlocks since that lock's last
   successful run.
3. The Worker looks up `unlock_face|39` in that lock's table in
   `cf-worker/src/mapping.js` to find the Zoho employee ID.
4. It posts a check-in to the Zoho People attendance API with the unlock's
   own timestamp, in local time.
5. It saves the new cursor and the ids of the posted unlocks in Workers KV.

### Reliability

- **Saved cursor per lock.** A failed or skipped run loses nothing; the next
  run continues where the last successful one stopped. If one lock fails,
  the others still sync.
- **No double posts.** Every posted unlock is remembered by
  `lock|method|slot@timestamp`, so re-reading the same window is harmless.
- **Overlap.** Each run re-reads the last 5 minutes, in case an unlock
  reaches Tuya's cloud late.
- **Nothing dropped outside hours.** An unlock at 07:40 is posted by the
  first run after 08:00, with its real 07:40 time.
- **Zoho handles repeats.** If someone is already checked in, Zoho answers
  "Duplicate Check-in entry" and nothing changes. If they checked out and
  come back, the next unlock checks them in again.

## The lock map

Tuya identifies a credential only by its method and slot number on one lock,
and slot numbers are not shared between locks: `face|39` on one door and
`face|39` on another are usually different people. The map therefore has one
table per lock:

```js
export const LOCKS = [
  {
    name: "front office",
    id: "TUYA_DEVICE_ID_1",
    people: {
      "unlock_face|10": "4",        // slot -> Zoho employee ID
      "unlock_fingerprint|1": "1",
    },
    ignore: new Set(["unlock_face|20"]),   // known people with no Zoho record
  },
];
```

- One employee can own several credentials, on one lock or across locks.
- `ignore` is for people who use the door but are not in Zoho People, such
  as cleaners or visitors. Their unlocks are skipped silently.
- Any credential in neither list is logged as `UNMAPPED`, which is how you
  find new or unidentified slots.

To find who owns a slot, open the lock's unlock records in the Tuya / Smart
Life app; they show the lock user's name for each entry.

The real map holds employee data, so it is not committed. Start from
`cf-worker/src/mapping.example.js`.

## Repository layout

| Path | What it is |
|---|---|
| `cf-worker/src/index.js` | Cron handler, working-hours check, the sync loop, and the `/run` and `/status` endpoints. |
| `cf-worker/src/tuya.js` | Tuya request signing (HMAC-SHA256), access token, unlock log with paging. Read-only. |
| `cf-worker/src/zoho.js` | Zoho OAuth token from a refresh token, and the check-in call. |
| `cf-worker/src/time.js` | Local time from the `Africa/Cairo` tz zone, and Zoho's date format. |
| `cf-worker/src/mapping.example.js` | Template for the lock map. |
| `cf-worker/wrangler.toml` | Worker name, cron schedule and KV binding. |
| `cf-worker/README.md` | Full setup, testing and settings. |
| `unlock-report.py` | Per-employee present/absent report from the lock logs. |

## Getting started

You need a Tuya IoT Platform cloud project with the locks linked to it, a
Zoho People account with API access, and a Cloudflare account.

```bash
cd cf-worker
cp src/mapping.example.js src/mapping.js     # then fill in your locks
npx wrangler kv namespace create STATE       # put the id in wrangler.toml
npx wrangler secret put TUYA_ACCESS_ID       # and the other secrets
npx wrangler deploy
```

`cf-worker/README.md` covers each step, including getting a Zoho refresh
token, the full list of secrets, and how to test with `/run` and `/status`.

Deploying starts posting real check-ins to Zoho People.

### Adapting it

- **Time zone and hours:** the zone is set in `src/time.js` and the working
  hours in `src/index.js` (`WORK_START_MIN`, `WORK_END_MIN`). Adjust the cron
  in `wrangler.toml` to match, since cron times are UTC.
- **Tuya region:** `src/tuya.js` uses the EU data center
  (`openapi.tuyaeu.com`). Use the host for the region your project is in.
- **Zoho region:** on `zoho.eu`, change both hosts in `src/zoho.js`.

## Attendance report

`unlock-report.py` prints one employee's days at the office straight from
the lock logs, which is useful for checking a timesheet against Zoho:

```bash
python unlock-report.py 26        # employee 26, last 30 days
python unlock-report.py 26 14     # last 14 days
```

It reads the locks and credentials from `cf-worker/src/mapping.js` (Node.js
is needed for that) and the Tuya credentials `TUYA_CLIENT_ID` and
`TUYA_SECRET` from a `.env` file. Each day is marked present, absent,
weekend or unknown. "Unknown" means the lock logged nobody that day, so the
log can't tell an empty office from missing data. Tuya keeps about 7 days of
log.

## Limits

- **Check-ins only.** Locks have a plain handle on the inside, so leaving is
  not recorded. People check out in Zoho, or Zoho's auto-checkout closes the
  day.
- **Only the person who unlocked is recorded.** Someone who walks in behind
  them is not checked in.
- **Up to 2 minutes of delay.** Tuya's message queue (Pulsar) could make it
  instant, but that needs a long-running connection, which Workers don't
  provide.
- **Tuya API budget.** The free Trial Edition of Tuya IoT Core allows 26,000
  calls a month and has to be renewed periodically; when it lapses, every
  call fails with `28841002`. Each run costs one call per lock: two locks
  every 2 minutes for 10 hours a day is about 18,700 calls a month. Check
  the budget before adding a lock or running more often.
- **Read-only against the locks.** The Worker only reads logs. It never
  creates codes or changes lock settings.
