#!/usr/bin/env python3
"""Keep the ?v= query on app.js and styles.css identical everywhere.

The service worker caches by full URL, query included, so a page asking for
app.js?v=6 while the worker precached app.js?v=1 simply never matches. These
strings live in three files, which is one more than anyone edits by hand
correctly.

    python3 scripts/bump-version.py --check   exit 1 if the files disagree
    python3 scripts/bump-version.py js        bump app.js only
    python3 scripts/bump-version.py css       bump styles.css only
    python3 scripts/bump-version.py both      bump both

JS and CSS carry separate numbers because they go stale independently.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ["index.html", "about.html", "sw.js"]
ASSETS = {"js": "app.js", "css": "styles.css"}


def read(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as handle:
        return handle.read()


def write(name, text):
    with open(os.path.join(ROOT, name), "w", encoding="utf-8") as handle:
        handle.write(text)


def pattern(asset):
    return re.compile(re.escape(asset) + r"\?v=(\d+)")


MARKER = re.compile(r'(id="build-mark">js )(\d+)( · css )(\d+)')


def marker_versions():
    match = MARKER.search(read("index.html"))
    if not match:
        return None
    return {"js": int(match.group(2)), "css": int(match.group(4))}


def write_marker(key, version):
    text = read("index.html")

    def repl(match):
        js = version if key == "js" else int(match.group(2))
        css = version if key == "css" else int(match.group(4))
        return f"{match.group(1)}{js}{match.group(3)}{css}"

    fresh = MARKER.sub(repl, text, count=1)
    if fresh != text:
        write("index.html", fresh)


def versions(asset):
    """Every version this asset is referenced with, per file."""
    found = {}
    for name in FILES:
        hits = pattern(asset).findall(read(name))
        if hits:
            found[name] = sorted(set(int(h) for h in hits))
    return found


def check():
    ok = True
    for key, asset in sorted(ASSETS.items()):
        found = versions(asset)
        if not found:
            print(f"{asset}: not referenced anywhere")
            ok = False
            continue
        every = sorted({v for vs in found.values() for v in vs})
        if len(every) == 1:
            print(f"{asset}: v{every[0]} in {', '.join(sorted(found))}")
        else:
            ok = False
            print(f"{asset}: MISMATCH")
            for name in sorted(found):
                print(f"    {name}: {', '.join('v' + str(v) for v in found[name])}")
        mark = marker_versions()
        if mark is None:
            ok = False
            print("build-mark: missing from index.html")
        elif len(every) == 1 and mark[key] != every[0]:
            ok = False
            print(f"build-mark {key}: v{mark[key]} but {asset} is v{every[0]}")
    return 0 if ok else 1


def bump(keys):
    for key in keys:
        asset = ASSETS[key]
        found = versions(asset)
        if not found:
            print(f"{asset}: not referenced anywhere")
            return 1
        nxt = max(v for vs in found.values() for v in vs) + 1
        for name in FILES:
            text = read(name)
            fresh = pattern(asset).sub(f"{asset}?v={nxt}", text)
            if fresh != text:
                write(name, fresh)
        if marker_versions() is None:
            print("build-mark: missing from index.html")
            return 1
        write_marker(key, nxt)
        print(f"{asset}: v{nxt}")
    return 0


def main(argv):
    arg = argv[1] if len(argv) > 1 else "--check"
    if arg == "--check":
        return check()
    if arg == "both":
        return bump(["css", "js"])
    if arg in ASSETS:
        return bump([arg])
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
