"""Per-day door-unlock report for one employee, for checking a timesheet.

Read-only: it reads Tuya's DP log and writes nothing to the lock or to Zoho.
Tuya keeps only ~7 days of log, so anything older comes back empty for
everyone.

Each day is scored present / absent / weekend / unknown. "unknown" means the
log had no events from anybody, so the day proves nothing either way - that
is the difference between an empty office and an empty database.

Usage:
    python unlock-report.py 26         # employee 26, last 30 days
    python unlock-report.py 26 14      # employee 26, last 14 days

The locks and the employee's credentials come from the Worker's
cf-worker/src/mapping.js, read through node. Tuya credentials come from
TUYA_CLIENT_ID / TUYA_SECRET, read from the environment or from .env next to
this script: the Access ID and Access Secret from the Tuya project overview.
"""
import hashlib
import hmac
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


HERE = os.path.dirname(os.path.abspath(__file__))


def load_env(path=os.path.join(HERE, ".env")):
    """KEY=value lines from .env; variables already set in the environment win."""
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        key, sep, value = line.strip().partition("=")
        if sep and not key.startswith("#"):
            os.environ.setdefault(key.strip(), value.strip())


load_env()

BASE = "https://openapi.tuyaeu.com"
CLIENT_ID = os.environ["TUYA_CLIENT_ID"]
SECRET = os.environ["TUYA_SECRET"]

LOCAL = ZoneInfo("Africa/Cairo")
WEEKEND = ("Fri", "Sat")
ABSENT_DETAIL = "lock logged others, nothing from them"
EMPTY_BODY_SHA = hashlib.sha256(b"").hexdigest()

CODES = "unlock_card,unlock_face,unlock_fingerprint,unlock_password"

MAPPING_JS = os.path.join(HERE, "cf-worker", "src", "mapping.js")


def load_locks():
    """LOCKS from the Worker's mapping.js, so both tools share one map."""
    script = ("import(process.argv[1]).then((m) => console.log(JSON.stringify("
              "m.LOCKS.map((l) => ({ name: l.name, id: l.id, people: l.people })))))")
    out = subprocess.run(["node", "-e", script, pathlib.Path(MAPPING_JS).as_uri()],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


LOCKS = load_locks()
LOCK_NAMES = {lock["id"]: lock["name"] for lock in LOCKS}


# --------------------------------------------------------------------------
# tuya
# --------------------------------------------------------------------------
def _sign(msg):
    return hmac.new(SECRET.encode(), msg.encode(), hashlib.sha256).hexdigest().upper()


def _path(base_path, params):
    return base_path + "?" + urllib.parse.urlencode(sorted(params.items()), safe=",")


def _get(path, token=None):
    t = str(int(time.time() * 1000))
    headers = {
        "client_id": CLIENT_ID,
        "sign": _sign(CLIENT_ID + (token or "") + t + f"GET\n{EMPTY_BODY_SHA}\n\n{path}"),
        "t": t,
        "sign_method": "HMAC-SHA256",
    }
    if token:
        headers["access_token"] = token
    req = urllib.request.Request(BASE + path, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return {"success": False, "msg": f"HTTP {exc.code}: {exc.read().decode()[:300]}"}
    except Exception as exc:                                    # noqa: BLE001
        return {"success": False, "msg": f"{type(exc).__name__}: {exc}"}


def fetch_day(device, token, lo, hi):
    """One day of unlock rows, retrying Tuya's rate limiter."""
    for attempt in range(6):
        res = _get(_path(f"/v1.0/devices/{device}/logs",
                         {"codes": CODES, "start_time": lo, "end_time": hi,
                          "size": 100, "type": 7}), token)
        if res.get("success"):
            rows = (res.get("result") or {}).get("logs") or []
            if len(rows) >= 100:
                print(f"  ! {LOCK_NAMES[device]} hit the 100-row cap in one day; "
                      f"that day is truncated")
            return rows
        if str(res.get("code")) != "40000309":      # log query too frequent
            print(f"  ! {LOCK_NAMES[device]} {res.get('code')} {res.get('msg')}")
            return None
        time.sleep(2 * (attempt + 1))
    print(f"  ! {LOCK_NAMES[device]} still rate-limited after 6 tries")
    return None


def fetch(device, token, start_ms, end_ms):
    """Every unlock row in the window, asked for one calendar day at a time.

    A single wide query cannot be used: the page caps at 100 rows and Tuya
    returns has_next=False even when the page is full, so the result is
    silently truncated with no way to detect it.
    """
    rows, blind = [], set()
    lo = start_ms
    while lo < end_ms:
        hi = min(lo + 86400 * 1000, end_ms)
        got = fetch_day(device, token, lo, hi)
        if got is None:
            blind.add(datetime.fromtimestamp(lo / 1000, LOCAL).date())
        else:
            rows.extend(got)
        time.sleep(0.6)
        lo = hi
    return rows, blind


# --------------------------------------------------------------------------
# report
# --------------------------------------------------------------------------
def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit("usage: python unlock-report.py <zoho employee id> [days]")
    emp = args[0]
    days = int(args[1]) if len(args) > 1 else 30
    # Slot numbers are per lock, so credentials are matched per lock too.
    creds = {lock["id"]: {k for k, v in lock["people"].items() if v == emp}
             for lock in LOCKS}
    creds = {device: keys for device, keys in creds.items() if keys}
    if not creds:
        known = sorted({v for lock in LOCKS for v in lock["people"].values()}, key=int)
        raise SystemExit(f"no credentials in mapping.js for employee {emp}; "
                         f"known: {', '.join(known)}")

    token_res = _get("/v1.0/token?grant_type=1")
    if not token_res.get("success"):
        raise SystemExit(f"token failed: {token_res.get('code')} {token_res.get('msg')}")
    token = token_res["result"]["access_token"]

    end_ms = int(time.time() * 1000)
    start_ms = end_ms - days * 86400 * 1000

    hits = defaultdict(list)      # date -> [(datetime, lock name)]
    traffic = defaultdict(int)    # date -> unlocks by anyone, either lock
    blind_days = set()

    for device, keys in creds.items():
        rows, blind = fetch(device, token, start_ms, end_ms)
        blind_days |= blind
        mine = 0
        for row in rows:
            ts = datetime.fromtimestamp(row["event_time"] / 1000, LOCAL)
            traffic[ts.date()] += 1
            if f"{row.get('code')}|{row.get('value')}" in keys:
                hits[ts.date()].append((ts, LOCK_NAMES[device]))
                mine += 1
        print(f"{LOCK_NAMES[device]:<14}{len(rows):>5} unlock rows, "
              f"{mine:>3} on {', '.join(sorted(keys))}")

    print(f"\n=== employee {emp} - last {days} days, Egypt time ===\n")
    print(f"{'date':<12}{'day':<5}{'n':>3}  {'first':<7}{'last':<7}"
          f"{'traffic':>8}  detail")
    print("-" * 82)

    tally = defaultdict(int)
    day = datetime.fromtimestamp(start_ms / 1000, LOCAL).date()
    today = datetime.now(LOCAL).date()
    while day <= today:
        iso, wd = day.isoformat(), day.strftime("%a")
        events = sorted(hits.get(day, []))
        seen = traffic.get(day, 0)
        live = seen > 0 and day not in blind_days

        if events:
            verdict = "present"
            detail = ", ".join(sorted({lock for _, lock in events}))
            cells = (len(events), f"{events[0][0]:%H:%M}", f"{events[-1][0]:%H:%M}")
        elif live:
            verdict = "weekend" if wd in WEEKEND else "absent"
            detail = "office quiet too" if wd in WEEKEND else ABSENT_DETAIL
            cells = ("-", "", "")
        elif wd in WEEKEND:
            verdict, detail = "weekend", ""
            cells = ("-", "", "")
        else:
            verdict, detail = "unknown", "no log data for anyone"
            cells = ("-", "", "")

        tally[verdict] += 1
        # only days that say something about the employee are worth a row
        if verdict not in ("present", "absent"):
            day += timedelta(days=1)
            continue
        mark = {"present": "*", "absent": "X"}[verdict]
        n, first, last = cells
        seen_cell = str(seen) if live else ""
        print(f"{iso:<12}{wd:<5}{str(n):>3}{mark} {first:<7}{last:<7}"
              f"{seen_cell:>8}  {detail}")
        day += timedelta(days=1)

    print("-" * 82)
    print(f"present {tally['present']}   absent {tally['absent']}")
    print(f"not shown: {tally['weekend']} weekend days, {tally['unknown']} days "
          f"with no log data for anyone (outside Tuya's ~7-day retention)")
    print("\nThe lock records entries only. The last unlock of a day is not a")
    print("checkout, and walking in behind someone leaves no record - so a late")
    print("first unlock is weak evidence. A whole day with nothing, on a day the")
    print("office was busy, is the only firm absence signal.")


if __name__ == "__main__":
    main()
