#!/usr/bin/env python3
"""Build history.json from every committed status.json.

The chart reads this file from GitHub, the same way the board reads
status.json, so a new point does not need a site deploy. Each point is the
three Totals cards at that snapshot: Neutral, Long, and Buy & hold, in whole
dollars, rounded the way the page rounds them.

    python3 scripts/build-history.py
    python3 scripts/build-history.py --check
"""

import json
import math
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "history.json")


def js_round(x):
    """Math.round: halves go toward +infinity."""
    if x >= 0:
        return int(math.floor(x + 0.5))
    return int(math.ceil(x - 0.5))


def num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)) and math.isfinite(v):
        return float(v)
    if isinstance(v, str):
        try:
            n = float(v.strip())
        except ValueError:
            return None
        if math.isfinite(n):
            return n
    return None


def fee_rate(data):
    rate = num(data.get("fee_rate"))
    if rate is not None and 0 <= rate < 1:
        return rate
    label = str(data.get("fee_label") or "").replace("%", "")
    n = num(label)
    return 0.008 if n is None else n / 100


def capital_of(data):
    n = num(data.get("capital_per_book"))
    return 10000.0 if n is None else n


def sum_field(rows, key):
    total = 0.0
    count = 0
    for row in rows:
        v = num(row.get(key))
        if v is None:
            continue
        total += v
        count += 1
    return total, count


def card_now(total, count):
    if not count:
        return None
    return js_round(total)


def card_triple(rows, capital, fee):
    """Whole-dollar Neutral, Long, and Buy & hold, matching the page cards.

    Held is capital * (1 - fee) * (spot / neutral_seed), summed then rounded.
    Cash on Buy & hold is zero. Returns None for a side that has no rows.
    """
    neutral = card_now(*sum_field(rows, "neutral_coin_usd"))
    neutral_cash = card_now(*sum_field(rows, "neutral_cash_usd"))
    long = card_now(*sum_field(rows, "long_coin_usd"))
    long_cash = card_now(*sum_field(rows, "long_cash_usd"))
    if neutral is None and neutral_cash is None:
        n = None
    else:
        n = (neutral or 0) + (neutral_cash or 0)
    if long is None and long_cash is None:
        l = None
    else:
        l = (long or 0) + (long_cash or 0)
    held = 0.0
    held_n = 0
    for row in rows:
        seed = num(row.get("neutral_seed"))
        spot = num(row.get("spot"))
        if seed is None or spot is None or seed == 0:
            continue
        held += capital * (1 - fee) * (spot / seed)
        held_n += 1
    h = card_now(held, held_n)
    return n, l, h


def point_from(data):
    rows = data.get("pairs")
    if not isinstance(rows, list) or not rows:
        return None
    capital = capital_of(data)
    fee = fee_rate(data)
    n, l, h = card_triple(rows, capital, fee)
    when = data.get("generated_at")
    if not isinstance(when, str) or not when:
        when = data.get("_commit_at")
    if not isinstance(when, str) or not when:
        return None
    if n is None or l is None or h is None:
        return None
    point = {"t": when, "n": n, "l": l, "h": h, "books": len(rows)}
    # 25% set only. Never fold these dollars into n/l/h.
    sets = data.get("sets") if isinstance(data.get("sets"), dict) else {}
    block = sets.get("25") if isinstance(sets.get("25"), dict) else {}
    rows25 = block.get("pairs")
    if isinstance(rows25, list) and rows25:
        n25, l25, h25 = card_triple(rows25, capital, fee)
        if n25 is not None and l25 is not None and h25 is not None:
            point["n25"] = n25
            point["l25"] = l25
            point["h25"] = h25
    return point


def commits():
    """Newest first. Commit time fills in for snapshots written before generated_at."""
    log = subprocess.check_output(
        ["git", "log", "HEAD", "--format=%H%x09%cI", "--", "status.json"],
        cwd=ROOT,
        text=True,
    )
    rows = []
    for line in log.splitlines():
        if "\t" not in line:
            continue
        sha, when = line.split("\t", 1)
        rows.append((sha, when))
    return rows


def snapshot(sha):
    raw = subprocess.check_output(
        ["git", "show", "%s:status.json" % sha],
        cwd=ROOT,
    )
    return json.loads(raw)


def collect():
    points = {}
    skipped = 0
    for sha, committed in commits():
        try:
            data = snapshot(sha)
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            skipped += 1
            continue
        if isinstance(data, dict):
            data["_commit_at"] = committed
        point = point_from(data)
        if point is None:
            skipped += 1
            continue
        # A later commit with the same generated_at replaces an earlier one.
        # git log is newest first, so keep the first one we see.
        points.setdefault(point["t"], point)
    ordered = sorted(points.values(), key=lambda p: p["t"])
    for point in ordered:
        point.pop("books", None)
    return ordered, skipped


def render(points):
    lines = ["{", '  "points": [']
    for i, point in enumerate(points):
        comma = "," if i < len(points) - 1 else ""
        extra = ""
        if "n25" in point and "l25" in point and "h25" in point:
            extra = ', "n25": %d, "l25": %d, "h25": %d' % (
                point["n25"], point["l25"], point["h25"]
            )
        lines.append(
            '    {"t": "%s", "n": %d, "l": %d, "h": %d%s}%s'
            % (point["t"], point["n"], point["l"], point["h"], extra, comma)
        )
    lines.append("  ]")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main(argv):
    points, skipped = collect()
    if not points:
        print("no points", file=sys.stderr)
        return 1
    text = render(points)
    check = "--check" in argv
    if check:
        with open(OUT, encoding="utf-8") as handle:
            current = handle.read()
        if current != text:
            print("history.json is behind the status commits (%d points)" % len(points))
            return 1
        print("history.json matches (%d points)" % len(points))
        return 0
    with open(OUT, "w", encoding="utf-8") as handle:
        handle.write(text)
    print(
        "wrote %d points, skipped %d, %s .. %s"
        % (len(points), skipped, points[0]["t"], points[-1]["t"])
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
