"""Enumerate every file inside the important-community-media Drive folder
and write data/drive-map.json: { "{post_id}-{n}.{ext}": "{drive_file_id}", ... }

Prerequisites (one-time):
    pip install --upgrade google-api-python-client google-auth-oauthlib

Auth: drops an OAuth token in ~/.config/yume-archive/drive-token.json on
first run. Scope is drive.readonly.

Run:
    python3 pipeline/scripts/enumerate_drive.py \
        --folder 1a22wGn2sznJDhh-CGAw1D1foYXqIJiKz \
        --out data/drive-map.json
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
TOKEN_DIR = Path.home() / ".config" / "yume-archive"
TOKEN_PATH = TOKEN_DIR / "drive-token.json"


def get_service():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build

    creds = None
    if TOKEN_PATH.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            client_secret = os.environ.get("GOOGLE_CLIENT_SECRET_JSON")
            if not client_secret:
                raise SystemExit(
                    "Set GOOGLE_CLIENT_SECRET_JSON to the path of an OAuth client JSON.\n"
                    "Create one at console.cloud.google.com (APIs & Services → Credentials → "
                    "OAuth client ID → Desktop)."
                )
            flow = InstalledAppFlow.from_client_secrets_file(client_secret, SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN_DIR.mkdir(parents=True, exist_ok=True)
        TOKEN_PATH.write_text(creds.to_json())
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def enumerate_folder(svc, folder_id: str) -> dict[str, str]:
    mapping: dict[str, str] = {}
    page_token = None
    while True:
        resp = (
            svc.files()
            .list(
                q=f"'{folder_id}' in parents and trashed = false",
                fields="nextPageToken, files(id, name, mimeType)",
                pageSize=1000,
                pageToken=page_token,
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            )
            .execute()
        )
        for f in resp.get("files", []):
            if f.get("mimeType", "").startswith("application/vnd.google-apps"):
                continue
            mapping[f["name"]] = f["id"]
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return mapping


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--folder", required=True, help="Drive folder id")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--merge", action="store_true", help="merge into existing out file")
    args = ap.parse_args()

    svc = get_service()
    fresh = enumerate_folder(svc, args.folder)
    if args.merge and args.out.exists():
        old = json.loads(args.out.read_text())
        old.update(fresh)
        fresh = old
    args.out.write_text(json.dumps(fresh, indent=2, sort_keys=True))
    print(f"{len(fresh):,} entries written to {args.out}")


if __name__ == "__main__":
    main()
