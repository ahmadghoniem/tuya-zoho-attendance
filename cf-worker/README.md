# Tuya lock -> Zoho People attendance (Cloudflare Worker)

Polls each office lock listed in `src/mapping.js` every 2 minutes from 08:00
to 18:00 Egypt time, every day, and posts each unlock to Zoho People as a
check-in. An unlock on any lock counts. It replaced a Zoho Deluge function
that had the same logic but could only run every 15 minutes and forgot
everything between runs.

What the Worker adds over that:

- **A saved cursor.** A failed or skipped run loses nothing; the next run
  continues where the last one stopped.
- **2-minute delay instead of 15.**
- **No double posts.** The ids of posted unlocks are kept in KV.
- **Nothing is dropped.** Unlocks before 08:00, after 18:00 or during an
  outage are posted by the next run, at the time they happened.

| File | What it does |
|---|---|
| `src/index.js` | Schedule check, the sync loop over both locks, `/run` and `/status`. |
| `src/mapping.js` | Slot -> Zoho employee ID, one table per lock. Not in git; copy `src/mapping.example.js`. |
| `src/tuya.js` | Tuya request signing, access token, unlock log. |
| `src/zoho.js` | Zoho access token and the check-in call. |
| `src/time.js` | Egypt time (`Africa/Cairo`, DST included) and Zoho's date format. |

## Setup

### 1. Install and log in

```bash
cd cf-worker
npm install -g wrangler        # or use npx wrangler for every command
npx wrangler login
```

### 2. Write the map

```bash
cp src/mapping.example.js src/mapping.js
```

Fill in each lock's Tuya device ID and its slots. See [The map](#the-map).

### 3. Create the KV namespace

```bash
npx wrangler kv namespace create STATE
```

Paste the printed `id` into `wrangler.toml` in place of the existing one.

### 4. Get a Zoho refresh token

The Worker runs outside Zoho, so it needs OAuth. The Deluge version didn't,
because a function inside Zoho People already has permission.

1. Go to <https://api-console.zoho.com> and create a **Self Client**.
2. Scope: `ZOHOPEOPLE.attendance.ALL`. Duration: 10 minutes. Generate the code.
3. Swap the code for tokens within those 10 minutes:

```bash
curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "grant_type=authorization_code" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "code=THE_CODE"
```

Keep `refresh_token` from the reply. It doesn't expire.

If your Zoho account is on `zoho.eu` rather than `zoho.com`, change both
`accounts.zoho.com` and `people.zoho.com` in `src/zoho.js`. The wrong one
returns 401 with no explanation.

### 5. Set the secrets

```bash
npx wrangler secret put TUYA_ACCESS_ID
npx wrangler secret put TUYA_ACCESS_SECRET
npx wrangler secret put ZOHO_CLIENT_ID
npx wrangler secret put ZOHO_CLIENT_SECRET
npx wrangler secret put ZOHO_REFRESH_TOKEN
npx wrangler secret put ADMIN_KEY          # any long random string
```

`ADMIN_KEY` guards the two manual URLs below so a stranger can't trigger
check-ins.

### 6. Deploy

```bash
npx wrangler deploy
```

## Testing

```
https://tuya-zoho-attendance.<your-subdomain>.workers.dev/run?key=ADMIN_KEY
https://tuya-zoho-attendance.<your-subdomain>.workers.dev/status?key=ADMIN_KEY
```

`/run` does one sync immediately and prints what it did. `/status` shows the
last run without calling Tuya or Zoho.

A real test:

1. Check out in Zoho.
2. Unlock one of the locks with your face.
3. Wait 2 minutes, or open `/run`.

Expected: `CHECK-IN <your Zoho ID> @ <unlock time> -> {"response":"success",...}`.
Run it a second time and nothing happens, because the unlock is remembered.

Live logs while testing:

```bash
npx wrangler tail
```

## Settings

In `src/index.js`:

| Constant | Default | Meaning |
|---|---|---|
| `WORK_START_MIN`, `WORK_END_MIN` | 08:00, 18:00 | Egypt-time hours when the cron runs do anything. |
| `OVERLAP_MIN` | 5 | How far back each run re-reads, in case an unlock reaches Tuya late. |
| `POSTED_KEEP` | 1000 | How many posted unlock ids to remember. |

Egypt time comes from the tz database zone `Africa/Cairo` (`src/time.js`), so
the summer/winter change is automatic.

In `wrangler.toml`: `crons = ["*/2 5-16 * * *"]`. Cron times are UTC, so this
covers 08:00-18:00 local in both summer and winter, and the code drops the
runs outside those hours before they call Tuya. Each run costs one Tuya call
per lock: 301 runs a day x 2 locks x 31 days is about 18,700 calls a month,
against the free Trial Edition's 26,000. Running all day, or every minute,
would go over the limit and Tuya would stop answering until the month ends.

## The map

`src/mapping.js`, one table per lock, built from the Tuya open-logs (they
name the lock user behind each slot).

Slot numbers belong to one lock: `face|39` on one lock and `face|39` on
another are usually different people.

Each table has `people` (slot -> Zoho ID) and `ignore` (people who use the
door but have no Zoho People record). Anything in neither prints `UNMAPPED` in the
log; the current unidentified slots are listed at the bottom of each table.

## What it can't do

- **No check-outs.** The lock has a plain handle inside, so leaving isn't
  recorded. People check out in Zoho, or Zoho's auto-checkout closes the day.
- **Doesn't know who walked in behind someone.** Only the person who touched
  the sensor is checked in.
- **2-minute delay.** The push version (Tuya Pulsar) is the way to make it
  instant, but it needs a program that stays connected all the time.
