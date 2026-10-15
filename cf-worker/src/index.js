/*
 * Tuya lock -> Zoho People attendance, polling version.
 *
 * Every 2 minutes from 08:00 to 18:00 Egypt time, asks Tuya for the unlocks
 * on each lock since the last run and posts each one to Zoho People as a
 * check-in. An unlock on either lock counts. Zoho rejects a repeat with
 * "Duplicate Check-in entry" while the person is already checked in, and
 * checks them back in after they have checked out.
 *
 * State lives in KV, so a failed or skipped run loses nothing: the next run
 * continues from each lock's stored cursor. Unlocks before 08:00 or after
 * 18:00 are posted by the next run inside working hours, at their real time.
 *
 * Budget: Tuya's free Trial Edition allows 26,000 API calls a month. A run
 * costs one log call per lock, plus a token call every ~2 hours (cached in
 * KV). 301 runs a day x 2 locks x 31 days = ~18,700 calls a month.
 */
import { LOCKS } from "./mapping.js";
import { tuyaToken, fetchUnlocks } from "./tuya.js";
import { postCheckIn } from "./zoho.js";
import { egyptOffsetHours, localMinutes, zohoStamp } from "./time.js";

// Working hours, Egypt time, in minutes since midnight. The cron in
// wrangler.toml is in UTC and covers both UTC+2 and UTC+3; runs outside
// these hours return before calling Tuya.
const WORK_START_MIN = 8 * 60;
const WORK_END_MIN = 18 * 60;

// Re-read this many minutes on every run. Covers an unlock that reaches
// Tuya's cloud slightly late; anything already posted is skipped by id.
const OVERLAP_MIN = 5;

// How many posted event ids to remember, to avoid posting one twice.
const POSTED_KEEP = 1000;

const STATE_KEY = "state";

function inWorkingHours(ms) {
  const m = localMinutes(ms);
  return m >= WORK_START_MIN && m <= WORK_END_MIN;
}

async function loadState(env) {
  const state = (await env.STATE.get(STATE_KEY, "json")) || {};
  return { cursors: state.cursors || {}, posted: state.posted || [] };
}

async function syncLock(env, token, lock, cursor, posted, now, log) {
  const startMs = Math.min(cursor ?? now, now - OVERLAP_MIN * 60_000);
  const { events, complete } = await fetchUnlocks(env, token, lock.id, startMs, now);
  log.push(`${lock.name}: ${events.length} unlock(s) since ${zohoStamp(startMs)}`);
  if (!complete) {
    log.push(`${lock.name}: WARNING more unlocks than one run reads; some may be missed`);
  }

  for (const ev of events) {
    const key = `${ev.code}|${ev.value}`;
    const evMs = Number(ev.event_time);
    const id = `${lock.id}|${key}@${evMs}`;
    const stamp = zohoStamp(evMs);

    if (posted.has(id)) continue;

    const empId = lock.people[key];
    if (!empId) {
      if (!lock.ignore.has(key)) log.push(`UNMAPPED ${lock.name} ${key} at ${stamp}`);
      continue;
    }

    try {
      const reply = await postCheckIn(env, empId, stamp);
      log.push(`CHECK-IN ${empId} @ ${stamp} (${lock.name}) -> ${JSON.stringify(reply)}`);
      posted.add(id);
    } catch (err) {
      // Leave it out of `posted` so the next run tries again.
      log.push(`CHECK-IN ${empId} @ ${stamp} (${lock.name}) -> ERROR ${err.message}`);
    }
  }
}

async function sync(env) {
  const now = Date.now();
  const { cursors, posted: postedList } = await loadState(env);
  const posted = new Set(postedList);
  const log = [`RUN ${zohoStamp(now)} (UTC+${egyptOffsetHours(now)})`];

  const token = await tuyaToken(env);
  for (const lock of LOCKS) {
    try {
      await syncLock(env, token, lock, cursors[lock.id], posted, now, log);
      cursors[lock.id] = now;
    } catch (err) {
      // Cursor not moved, so the next run re-reads this lock's window.
      log.push(`${lock.name}: FAILED ${err.message}`);
    }
  }

  await env.STATE.put(
    STATE_KEY,
    JSON.stringify({
      cursors,
      posted: [...posted].slice(-POSTED_KEEP),
      lastRun: new Date(now).toISOString(),
      lastLog: log,
    })
  );

  for (const line of log) console.log(line);
  return log;
}

export default {
  async scheduled(event, env, ctx) {
    if (!inWorkingHours(event.scheduledTime)) return;
    ctx.waitUntil(
      sync(env).catch((err) => {
        console.error(`SYNC FAILED: ${err.stack || err.message}`);
      })
    );
  },

  /**
   * Manual endpoints, for testing. Both need ?key=<ADMIN_KEY>. /run also
   * works outside working hours.
   *   GET /run     - run one sync now and show what it did
   *   GET /status  - show the last run without calling anything
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("key") !== env.ADMIN_KEY) {
      return new Response("forbidden\n", { status: 403 });
    }

    if (url.pathname === "/run") {
      try {
        const log = await sync(env);
        return new Response(log.join("\n") + "\n");
      } catch (err) {
        return new Response(`SYNC FAILED: ${err.stack || err.message}\n`, {
          status: 500,
        });
      }
    }

    if (url.pathname === "/status") {
      const state = (await env.STATE.get(STATE_KEY, "json")) || {};
      const cursors = state.cursors || {};
      return new Response(
        [
          `last run: ${state.lastRun || "never"}`,
          ...LOCKS.map(
            (l) => `cursor ${l.name}: ${cursors[l.id] ? zohoStamp(cursors[l.id]) : "unset"}`
          ),
          `remembered events: ${(state.posted || []).length}`,
          "",
          ...(state.lastLog || []),
          "",
        ].join("\n")
      );
    }

    return new Response("try /run or /status\n", { status: 404 });
  },
};
