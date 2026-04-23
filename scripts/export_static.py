"""Export archived SQLite data to static JSON consumed by the website.

Reads: data/important-community.sqlite3 (path via --db)
Writes: site/data/{archive.json, authors.json, stats.json}

Run:
    python3 scripts/export_static.py --db ../data/important-community.sqlite3 --out ../site/data
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def upgrade_avatar(url: str | None) -> str | None:
    if not url:
        return None
    return url.replace("_normal.", "_400x400.")


TCO_RE = re.compile(r"https://t\.co/[A-Za-z0-9]+")


def strip_trailing_tco(text: str | None, media_count: int) -> str:
    """Strip exactly `media_count` trailing t.co shortlinks from the body.
    Rationale: X appends one t.co link per attached media to the raw text.
    Stripping all trailing t.co links would also drop real external links
    that happen to sit at the end of a tweet before the media links.
    """
    if not text:
        return ""
    parts = text.rstrip().split()
    to_strip = media_count
    while parts and to_strip > 0 and parts[-1].startswith("https://t.co/"):
        parts.pop()
        to_strip -= 1
    return " ".join(parts).strip()


def expand_tco_links(text: str, tco_map: dict[str, str | None]) -> str:
    """Replace every https://t.co/... in `text` with its resolved destination
    from tco_map. Unresolved entries are left as t.co URLs."""
    if not text or not tco_map:
        return text
    def _sub(m):
        url = m.group(0)
        dest = tco_map.get(url)
        # skip self-referential x.com/.../status redirects that point back to
        # the same tweet (these are just media indicators in disguise that
        # survived stripping because the media count was 0)
        return dest if dest else url
    return TCO_RE.sub(_sub, text)


def sized_twimg(url: str | None) -> str | None:
    """Pin pbs.twimg.com photo URLs to a reasonable display size so the site
    doesn't fetch multi-megapixel originals."""
    if not url or "pbs.twimg.com/media/" not in url:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}name=medium"


def drive_image_url(file_id: str) -> str:
    """Public Drive image URL that can embed in <img>. Requires folder to be
    shared 'Anyone with the link'."""
    return f"https://lh3.googleusercontent.com/d/{file_id}=w1200"


def drive_video_url(file_id: str) -> str:
    """Direct-download URL for videos; works inside <video> tags for public files."""
    return f"https://drive.usercontent.google.com/download?id={file_id}&export=download"


def load_drive_map(path: Path | None) -> dict[str, str]:
    if not path or not path.exists():
        return {}
    return json.loads(path.read_text())


def build(
    db_path: Path,
    out_dir: Path,
    drive_map_path: Path | None = None,
    tco_map_path: Path | None = None,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    drive_map = load_drive_map(drive_map_path)
    tco_map: dict[str, str | None] = (
        json.loads(tco_map_path.read_text()) if tco_map_path and tco_map_path.exists() else {}
    )
    # If migration 004_post_links has been applied, prefer its rows over the
    # curl-based tco-map since that data was captured authoritatively from X's
    # GraphQL response (no external service dependency).
    try:
        db_tco_rows = con.execute(
            "SELECT tco_url, expanded_url FROM post_links"
        ).fetchall()
        for r in db_tco_rows:
            if r["expanded_url"]:
                tco_map[r["tco_url"]] = r["expanded_url"]
    except sqlite3.OperationalError:
        pass  # table doesn't exist yet — fall back to tco-map.json only

    community = dict(con.execute("SELECT * FROM communities LIMIT 1").fetchone())

    authors_rows = con.execute(
        "SELECT id, author_x_id, handle, display_name, profile_url, raw_profile_path FROM authors"
    ).fetchall()
    authors = {
        r["id"]: {
            "id": r["author_x_id"],
            "handle": r["handle"],
            "name": r["display_name"] or r["handle"],
            "url": r["profile_url"],
            "avatar": upgrade_avatar(r["raw_profile_path"]),
        }
        for r in authors_rows
    }

    media_rows = con.execute(
        "SELECT owner_post_x_id, media_key, source_url, media_type, mime_type, local_path "
        "FROM media_assets ORDER BY media_key"
    ).fetchall()
    media_by_post: dict[str, list[dict]] = {}
    missing_from_drive: list[str] = []
    for r in media_rows:
        media_type = r["media_type"]
        # drive-map keys are the mirrored filenames: {media_key}.{ext}
        # Media_key looks like "{post_id}-{n}", extension from the source_url
        key = r["media_key"]
        # infer extension from source_url
        src = r["source_url"] or ""
        ext_guess = None
        if media_type == "video" or media_type == "animated_gif" or src.endswith(".mp4"):
            ext_guess = "mp4"
        else:
            # look for .jpg/.png in source_url tail
            for e in ("jpg", "jpeg", "png", "webp", "gif"):
                if f".{e}" in src.lower():
                    ext_guess = e if e != "jpeg" else "jpg"
                    break
        drive_id = None
        if ext_guess:
            drive_id = drive_map.get(f"{key}.{ext_guess}")
            if not drive_id:
                # try the alternates
                for alt in ("mp4", "jpg", "png", "webp", "gif"):
                    drive_id = drive_map.get(f"{key}.{alt}")
                    if drive_id:
                        ext_guess = alt
                        break

        is_video = media_type in ("video", "animated_gif") or ext_guess == "mp4"
        if drive_id:
            url = drive_video_url(drive_id) if is_video else drive_image_url(drive_id)
            source = "drive"
        else:
            url = sized_twimg(src)
            source = "twimg"
            missing_from_drive.append(key)

        media_by_post.setdefault(r["owner_post_x_id"], []).append(
            {
                "key": key,
                "url": url,
                "type": media_type,
                "mime": r["mime_type"],
                "source": source,
                "ext": ext_guess,
                "drive_id": drive_id,
                "tweet_url": src,  # always keep the original twimg URL for fallback
            }
        )

    post_rows = con.execute(
        """
        SELECT post_x_id, author_id, conversation_x_id, parent_post_x_id,
               canonical_url, kind, body_text, posted_at_iso, posted_at_epoch
        FROM posts
        ORDER BY posted_at_epoch DESC
        """
    ).fetchall()

    posts = []
    author_post_counts: Counter[int] = Counter()
    # first pass: compute reply counts (how many posts list this as parent)
    reply_counts: Counter[str] = Counter()
    for r in post_rows:
        if r["parent_post_x_id"]:
            reply_counts[r["parent_post_x_id"]] += 1

    for r in post_rows:
        author = authors.get(r["author_id"])
        author_post_counts[r["author_id"]] += 1
        media = media_by_post.get(r["post_x_id"], [])
        body_stripped = strip_trailing_tco(r["body_text"], len(media))
        body_expanded = expand_tco_links(body_stripped, tco_map)
        posts.append(
            {
                "id": r["post_x_id"],
                "kind": r["kind"],
                "body": body_expanded,
                "raw": r["body_text"] or "",
                "ts": r["posted_at_epoch"],
                "iso": r["posted_at_iso"],
                "conv": r["conversation_x_id"],
                "parent": r["parent_post_x_id"],
                "url": r["canonical_url"],
                "author": author["handle"] if author else None,
                "media": media,
                "replies": reply_counts.get(r["post_x_id"], 0),
            }
        )

    # author list sorted by activity
    author_list = sorted(
        [
            {**a, "posts": author_post_counts.get(aid, 0)}
            for aid, a in authors.items()
        ],
        key=lambda a: a["posts"],
        reverse=True,
    )

    # stats
    times = [p["ts"] for p in posts if p["ts"]]
    stats = {
        "community": {
            "slug": community["slug"],
            "title": community["title"],
            "url": community["url"],
            "id": community["community_x_id"],
        },
        "posts_total": len(posts),
        "authors_total": len(authors),
        "media_total": len(media_rows),
        "kinds": dict(Counter(p["kind"] for p in posts)),
        "earliest": datetime.fromtimestamp(min(times), tz=timezone.utc).isoformat() if times else None,
        "latest": datetime.fromtimestamp(max(times), tz=timezone.utc).isoformat() if times else None,
        "top_authors": [
            {"handle": a["handle"], "name": a["name"], "avatar": a["avatar"], "posts": a["posts"]}
            for a in author_list[:12]
        ],
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
    }

    (out_dir / "archive.json").write_text(json.dumps(posts, ensure_ascii=False, separators=(",", ":")))
    (out_dir / "authors.json").write_text(json.dumps(author_list, ensure_ascii=False, separators=(",", ":")))
    (out_dir / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2))

    print(f"posts     : {len(posts):,}")
    print(f"authors   : {len(authors):,}")
    print(f"media     : {len(media_rows):,}")
    print(f"  drive   : {len(media_rows) - len(missing_from_drive):,}")
    print(f"  twimg   : {len(missing_from_drive):,}  (needs drive-map entry)")
    print(f"range     : {stats['earliest']} → {stats['latest']}")
    print(f"out       : {out_dir}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--drive-map", type=Path, default=None,
                    help="JSON map { filename: drive_file_id } to rewrite media URLs to Drive")
    ap.add_argument("--tco-map", type=Path, default=None,
                    help="JSON map { https://t.co/xxx: https://expanded.url } to expand shortlinks")
    args = ap.parse_args()
    build(args.db, args.out, args.drive_map, args.tco_map)


if __name__ == "__main__":
    main()
