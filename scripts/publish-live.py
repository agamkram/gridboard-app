#!/usr/bin/env python3
"""Deploy GridBoard after status.json changes.

Grok's maintain job writes that file. This publishes the folder that is
already on disk. It does not call Kraken and it does not place orders.
"""

import hashlib
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATUS = os.path.join(ROOT, "status.json")
LOG_DIR = os.path.expanduser("~/Library/Logs/markmaga-preview")
STAMP = os.path.join(LOG_DIR, "gridboard-publish.stamp")
LOG = os.path.join(LOG_DIR, "gridboard-publish.log")
VERCEL = "/usr/local/bin/vercel"


def log(msg):
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")


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
    try:
        prev = open(STAMP, encoding="utf-8").read().strip()
    except OSError:
        prev = ""
    stamp = doc.get("updated_et") or "snapshot"
    if prev == digest:
        log("unchanged " + str(stamp))
        return 0
    log("deploy " + str(stamp))
    result = subprocess.run([VERCEL, "--prod", "--yes"], cwd=ROOT)
    if result.returncode != 0:
        log("deploy failed " + str(result.returncode))
        return result.returncode
    fresh = open(STATUS, "rb").read()
    fresh_digest = hashlib.sha256(fresh).hexdigest()
    with open(STAMP, "w", encoding="utf-8") as handle:
        handle.write(fresh_digest)
    log("live " + str(stamp))
    if fresh_digest != digest:
        log("file changed during deploy")
        return main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
