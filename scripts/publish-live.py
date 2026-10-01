#!/usr/bin/env python3
"""Deploy GridBoard after status.json changes.

Grok's maintain job writes that file. This publishes the folder that is
already on disk. It does not call Kraken and it does not place orders.

Two things this has to get right, both learned the hard way:

Vercel's free plan allows 100 production deploys a day, counted across every
project on the account, not just this one. Publishing on every status write
burns through that before noon and then deploys start failing for all of them.
MIN_INTERVAL is the floor between deploys. Thirty minutes is 48 a day, which
leaves most of the budget for the other apps and still lands inside the
45-minute window after which the board marks itself stale.

The CLI also reports failure *after* a deployment has already gone live, so the
exit code cannot be trusted. The live site decides whether a snapshot
published. Earlier this script stamped only on exit code 0, so a false failure
left the stamp behind and the same snapshot deployed over and over, which is
what exhausted the quota in the first place.
"""

import datetime
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATUS = os.path.join(ROOT, "status.json")
LOG_DIR = os.path.expanduser("~/Library/Logs/markmaga-preview")
STATE = os.path.join(LOG_DIR, "gridboard-publish.state.json")
LOG = os.path.join(LOG_DIR, "gridboard-publish.log")
VERCEL = "/usr/local/bin/vercel"
LIVE_URL = "https://gridboard.markmaga.com/status.json"

MIN_INTERVAL = 30 * 60
QUOTA_BACKOFF = 60 * 60
QUOTA_MARK = "api-deployments-free-per-day"


def log(msg):
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")


def load_state():
    try:
        with open(STATE, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state):
    os.makedirs(LOG_DIR, exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(state, handle)
    os.replace(tmp, STATE)


def wait_stable():
    last = None
    for _ in range(12):
        try:
            data = open(STATUS, "rb").read()
        except OSError:
            time.sleep(0.4)
            continue
        if data and data == last:
            return data
        last = data
        time.sleep(0.5)
    return last


def moment(value):
    try:
        return datetime.datetime.fromisoformat(str(value)).timestamp()
    except (TypeError, ValueError):
        return None


def live_built():
    """When the snapshot the live site is serving was built."""
    url = LIVE_URL + "?probe=" + str(int(time.time()))
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            return moment(json.load(response).get("generated_at"))
    except Exception:
        return None


def main():
    raw = wait_stable()
    if not raw:
        log("no status.json")
        return 1
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError:
        log("status.json not ready")
        return 1
    if not isinstance(doc.get("pairs"), list):
        log("status.json has no pairs")
        return 1

    digest = hashlib.sha256(raw).hexdigest()
    built = moment(doc.get("generated_at"))
    stamp = str(doc.get("updated_et") or "snapshot")
    state = load_state()
    now = time.time()

    if state.get("live_digest") == digest:
        log("unchanged " + stamp)
        return 0

    waited = now - float(state.get("last_deploy") or 0)
    if waited < MIN_INTERVAL:
        log("throttled %s, %.0f min to go" % (stamp, (MIN_INTERVAL - waited) / 60))
        return 0

    quiet_until = float(state.get("quota_quiet_until") or 0)
    if now < quiet_until:
        log("quota backoff %s, %.0f min to go" % (stamp, (quiet_until - now) / 60))
        return 0

    log("deploy " + stamp)
    state["last_deploy"] = now
    save_state(state)

    result = subprocess.run(
        [VERCEL, "--prod", "--yes"], cwd=ROOT, capture_output=True, text=True
    )
    if QUOTA_MARK in (result.stdout or "") + (result.stderr or ""):
        state["quota_quiet_until"] = time.time() + QUOTA_BACKOFF
        save_state(state)
        log("quota reached, holding %d min" % (QUOTA_BACKOFF // 60))

    # Accept anything at least as new as what we handed over: status.json can
    # be rewritten mid-deploy, in which case a newer snapshot is what landed.
    for _ in range(12):
        there = live_built()
        if there is not None and (built is None or there >= built):
            state["live_digest"] = digest
            save_state(state)
            log("live " + stamp)
            return 0
        time.sleep(6)

    log("not live %s, exit %d" % (stamp, result.returncode))
    return 1


if __name__ == "__main__":
    sys.exit(main())
