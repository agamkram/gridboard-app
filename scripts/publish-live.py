#!/usr/bin/env python3
"""Deploy GridBoard after status.json changes.

Grok's maintain job writes that file. This publishes the folder that is
already on disk. It does not call Kraken and it does not place orders.

Two things this has to get right, both learned the hard way:

Vercel's free plan allows 100 production deploys a day, counted across every
project on the account, not just this one. Publishing on every status write
burns through that before noon and then deploys start failing for all of them.
MIN_INTERVAL is the floor between deploys.

The board no longer reads its data from here: it reads the copy Grok Bot pushes
to GitHub, which costs nothing and updates every 12 to 15 minutes. The deployed
status.json is only the fallback for when GitHub cannot be reached, so it needs
to be warm rather than current. Two hours is 12 deploys a day instead of 96.

The CLI also reports failure *after* a deployment has already gone live, so the
exit code cannot be trusted. The live site decides whether a snapshot
published. Earlier this script stamped only on exit code 0, so a false failure
left the stamp behind and the same snapshot deployed over and over, which is
what exhausted the quota in the first place.
"""

import datetime
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATUS = os.path.join(ROOT, "status.json")
LOG_DIR = os.path.expanduser("~/Library/Logs/markmaga-preview")
STATE = os.path.join(LOG_DIR, "gridboard-publish.state.json")
LOCK = os.path.join(LOG_DIR, "gridboard-publish.lock")
LOG = os.path.join(LOG_DIR, "gridboard-publish.log")
VERCEL = "/usr/local/bin/vercel"
SITE_URL = "https://gridboard.markmaga.com/"
LIVE_URL = SITE_URL + "status.json"

MIN_INTERVAL = 2 * 60 * 60
QUOTA_BACKOFF = 20 * 60
QUOTA_MARK = "api-deployments-free-per-day"

# A data update can wait for the floor. A code change cannot: it is the whole
# point of a deploy, and waiting means looking at a board that is not the one
# on disk. These bypass MIN_INTERVAL when any of them differs from what is live.
CODE_FILES = (
    "index.html",
    "about.html",
    "app.js",
    "styles.css",
    "sw.js",
    "vercel.json",
    "manifest.webmanifest",
)


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


def code_digest():
    sha = hashlib.sha256()
    for name in CODE_FILES:
        try:
            sha.update(open(os.path.join(ROOT, name), "rb").read())
        except OSError:
            sha.update(b"missing")
        sha.update(b"\0")
    return sha.hexdigest()


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


def asset_markers():
    """The versioned asset names index.html on disk is asking for."""
    try:
        html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    except OSError:
        return []
    return sorted(set(re.findall(r"(?:app\.js|styles\.css)\?v=\d+", html)))


def live_serves(markers):
    """True when the live page asks for these same assets."""
    url = SITE_URL + "?probe=" + str(int(time.time()))
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            html = response.read().decode("utf-8", "replace")
    except Exception:
        return False
    return all(marker in html for marker in markers)


def run():
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

    code = code_digest()
    code_changed = state.get("live_code") != code

    if state.get("live_digest") == digest and not code_changed:
        log("unchanged " + stamp)
        return 0

    waited = now - float(state.get("last_deploy") or 0)
    if waited < MIN_INTERVAL and not code_changed:
        log("throttled %s, %.0f min to go" % (stamp, (MIN_INTERVAL - waited) / 60))
        return 0
    if code_changed:
        log("code changed")

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

    # Data: accept anything at least as new as what we handed over, since
    # status.json can be rewritten mid-deploy and the newer snapshot is what
    # landed. Code: the live page has to be asking for the assets on disk.
    # Without that check a code-only deploy would confirm itself against a
    # snapshot that never changed.
    markers = asset_markers() if code_changed else []
    for _ in range(12):
        there = live_built()
        data_ok = there is not None and (built is None or there >= built)
        if data_ok and (not markers or live_serves(markers)):
            state["live_digest"] = digest
            state["live_code"] = code
            save_state(state)
            log("live " + stamp + (" + code" if code_changed else ""))
            return 0
        time.sleep(6)

    log("not live %s, exit %d" % (stamp, result.returncode))
    return 1


def main():
    """One publish at a time.

    WatchPaths and StartInterval can both fire, and a deploy takes long enough
    that two runs overlapped and each called vercel --prod. That wastes a
    deploy from the daily allowance and lets the two race over the state file.
    """
    os.makedirs(LOG_DIR, exist_ok=True)
    handle = open(LOCK, "a+")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("busy, a publish is already running")
        return 0
    try:
        return run()
    finally:
        fcntl.flock(handle, fcntl.LOCK_UN)
        handle.close()


if __name__ == "__main__":
    sys.exit(main())
