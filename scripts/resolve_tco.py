"""Resolve every t.co short link in the archive to its expanded URL, caching
the mapping in data/tco-map.json.

Runs concurrently with requests; idempotent (skips already-cached entries).

t.co responds to a plain GET with an HTML meta-refresh or a redirect to the
destination. We issue a HEAD with redirect follow first; if that fails we
fall back to GET and parse the `URL=` redirect target out of the body.

Run:
    python3 pipeline/scripts/resolve_tco.py \
        --db data/important-community.sqlite3 \
        --out data/tco-map.json
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path

TCO_RE = re.compile(r"https://t\.co/[A-Za-z0-9]+")
META_RE = re.compile(r'URL=([^"\']+)', re.IGNORECASE)
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0"


def extract_links(db_path: Path) -> set[str]:
    con = sqlite3.connect(db_path)
    rows = con.execute(
        "SELECT body_text FROM posts WHERE body_text LIKE '%https://t.co/%'"
    ).fetchall()
    con.close()
    links: set[str] = set()
    for (body,) in rows:
        links.update(TCO_RE.findall(body or ""))
    return links


def resolve_one(url: str, timeout: float = 15.0) -> tuple[str, str | None]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            final = resp.geturl()
            if final and final != url and not final.startswith("https://t.co/"):
                return url, final
            body = resp.read(4096).decode("utf-8", errors="replace")
            m = META_RE.search(body)
            if m:
                return url, m.group(1)
    except urllib.error.HTTPError as e:
        # 301/302 with a Location header that wasn't auto-followed
        loc = e.headers.get("Location") if e.headers else None
        if loc:
            return url, loc
    except Exception:
        pass
    return url, None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=24)
    args = ap.parse_args()

    cache: dict[str, str | None] = {}
    if args.out.exists():
        cache = json.loads(args.out.read_text())

    all_links = extract_links(args.db)
    todo = sorted(all_links - set(cache.keys()))
    print(f"total t.co links: {len(all_links):,}")
    print(f"already cached  : {len(cache):,}")
    print(f"to resolve      : {len(todo):,}")
    if not todo:
        return

    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(resolve_one, u): u for u in todo}
        for fut in concurrent.futures.as_completed(futs):
            u, expanded = fut.result()
            cache[u] = expanded
            done += 1
            if done % 50 == 0 or done == len(todo):
                resolved = sum(1 for v in cache.values() if v)
                print(f"  {done:>4}/{len(todo)}  cached {resolved:,} resolved total", file=sys.stderr)
    # persist every run so a Ctrl-C doesn't lose progress
    args.out.write_text(json.dumps(cache, indent=2, sort_keys=True))
    miss = sum(1 for v in cache.values() if v is None)
    print(f"wrote {args.out}  ({len(cache):,} entries, {miss:,} unresolved)")


if __name__ == "__main__":
    main()
