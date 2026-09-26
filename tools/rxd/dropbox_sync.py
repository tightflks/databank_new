#!/usr/bin/env python3
"""Pull the Databank weekly zips from Dropbox and read every .RXD inside to CSV.

    python3 tools/rxd/dropbox_sync.py                 # sync everything not yet done
    python3 tools/rxd/dropbox_sync.py --dry-run       # list what would be pulled
    python3 tools/rxd/dropbox_sync.py --since 2026-01-01 --limit 5
    python3 tools/rxd/dropbox_sync.py --upload        # also write the CSVs back to Dropbox
    python3 tools/rxd/dropbox_sync.py --auth          # one-time: obtain a refresh token

Source folder:  /GrooveSolutions/Databank/_archive/_datafile  (datafile_MM_DD_YYYY.zip)
Local output:   out/<YYYY-MM-DD>/<TYPE>.csv  plus  out/manifest.json
Dropbox output: /GrooveSolutions/Databank/_archive/_csv/<YYYY-MM-DD>/<TYPE>.csv  (--upload,
                needs the files.content.write scope on the app)

Idempotent: a week is skipped when its Dropbox `content_hash` matches the
manifest, so the same command is the historical backfill and the weekly job.

Auth, in order of preference (environment variables):
  DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY + DROPBOX_APP_SECRET   long-lived, for the cron job
  DROPBOX_ACCESS_TOKEN                                            short-lived, for a one-off run
Stdlib only — no `dropbox` SDK, no pandas.
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rxd import read_rxd, repair_csv, repair_dates, write_csv  # noqa: E402

SRC_FOLDER = "/GrooveSolutions/Databank/_archive/_datafile"
DST_FOLDER = "/GrooveSolutions/Databank/_archive/_csv"
API = "https://api.dropboxapi.com/2/"
CONTENT = "https://content.dropboxapi.com/2/"
WEEK_RE = re.compile(r"(\d{2})\D+(\d{2})\D+(\d{4})")  # tolerates datafile_02))02_2023.zip


class DropboxError(RuntimeError):
    pass


class Dropbox:
    def __init__(self, token: str):
        self.token = token

    @classmethod
    def from_env(cls) -> "Dropbox":
        refresh = os.environ.get("DROPBOX_REFRESH_TOKEN")
        key, secret = os.environ.get("DROPBOX_APP_KEY"), os.environ.get("DROPBOX_APP_SECRET")
        if refresh and key and secret:
            return cls(_oauth_token({"grant_type": "refresh_token", "refresh_token": refresh}, key, secret))
        token = os.environ.get("DROPBOX_ACCESS_TOKEN")
        if not token:
            raise DropboxError(
                "set DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY + DROPBOX_APP_SECRET, or DROPBOX_ACCESS_TOKEN"
            )
        return cls(token)

    def rpc(self, endpoint: str, body: dict) -> dict:
        req = urllib.request.Request(
            API + endpoint,
            data=json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"},
        )
        return _send(req)

    def list_folder(self, path: str) -> list[dict]:
        res = self.rpc("files/list_folder", {"path": path, "limit": 2000})
        entries = res["entries"]
        while res.get("has_more"):
            res = self.rpc("files/list_folder/continue", {"cursor": res["cursor"]})
            entries += res["entries"]
        return entries

    def download(self, path: str) -> bytes:
        req = urllib.request.Request(
            CONTENT + "files/download",
            headers={"Authorization": "Bearer " + self.token, "Dropbox-API-Arg": json.dumps({"path": path})},
        )
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.read()

    def upload(self, path: str, data: bytes) -> None:
        arg = {"path": path, "mode": "overwrite", "mute": True}
        req = urllib.request.Request(
            CONTENT + "files/upload",
            data=data,
            headers={
                "Authorization": "Bearer " + self.token,
                "Dropbox-API-Arg": json.dumps(arg),
                "Content-Type": "application/octet-stream",
            },
        )
        _send(req)


def _send(req: urllib.request.Request) -> dict:
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        raise DropboxError(f"{req.full_url}: {e.code} {e.read().decode(errors='replace')[:400]}") from None
    except urllib.error.URLError as e:
        # Dropbox drops the connection mid-body when the app lacks the scope
        # for an upload endpoint, which surfaces as an SSL EOF rather than a 4xx.
        raise DropboxError(f"{req.full_url}: {e.reason} (missing files.content.write scope?)") from None
    return json.loads(raw) if raw else {}


def _oauth_token(params: dict, key: str, secret: str) -> str:
    data = urllib.parse.urlencode({**params, "client_id": key, "client_secret": secret}).encode()
    req = urllib.request.Request("https://api.dropboxapi.com/oauth2/token", data=data)
    return _send(req)["access_token"]


def obtain_refresh_token() -> None:
    """Interactive one-off: prints the URL to visit, exchanges the code for a refresh token."""
    key, secret = os.environ.get("DROPBOX_APP_KEY"), os.environ.get("DROPBOX_APP_SECRET")
    if not key or not secret:
        raise DropboxError("set DROPBOX_APP_KEY and DROPBOX_APP_SECRET")
    url = (
        "https://www.dropbox.com/oauth2/authorize?"
        + urllib.parse.urlencode({"client_id": key, "response_type": "code", "token_access_type": "offline"})
    )
    print("1. Open this URL, approve the app, copy the code:\n   " + url)
    code = input("2. Paste the code: ").strip()
    data = urllib.parse.urlencode(
        {"code": code, "grant_type": "authorization_code", "client_id": key, "client_secret": secret}
    ).encode()
    res = _send(urllib.request.Request("https://api.dropboxapi.com/oauth2/token", data=data))
    print("3. Store this as DROPBOX_REFRESH_TOKEN (it does not expire):\n   " + res["refresh_token"])


def week_of(name: str) -> dt.date | None:
    m = WEEK_RE.search(name)
    if not m:
        return None
    month, day, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
    today = dt.date.today()
    if year > today.year + 1:
        year = today.year  # datafile_07_16_2096.zip: a mistyped 2026
    try:
        week = dt.date(year, month, day)
    except ValueError:
        return None
    return week if week <= today + dt.timedelta(days=14) else None


def load_manifest(out_dir: str, dbx: Dropbox | None = None) -> dict:
    """Local manifest; when uploading from a fresh machine (the cron job), fall back to the Dropbox copy."""
    p = os.path.join(out_dir, "manifest.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as fh:
            return json.load(fh)
    if dbx is not None:
        try:
            return json.loads(dbx.download(f"{DST_FOLDER}/manifest.json"))
        except (DropboxError, urllib.error.HTTPError):
            pass
    return {"weeks": {}}


def save_manifest(out_dir: str, manifest: dict) -> None:
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(out_dir, "manifest.json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1, sort_keys=True)
    os.replace(tmp, os.path.join(out_dir, "manifest.json"))


def convert(zip_bytes: bytes, week: dt.date | None = None) -> dict[str, tuple[bytes, int]]:
    """{TYPE: (csv_bytes, row_count)} for every .RXD in the zip; typo'd future dates are repaired against `week`."""
    out: dict[str, tuple[bytes, int]] = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        for info in z.infolist():
            if not info.filename.lower().endswith(".rxd"):
                continue
            fields, rows = read_rxd(io.BytesIO(z.read(info)))
            if week:
                for _, name, before, after in repair_dates(fields, rows, week):
                    print(f"    {info.filename}: {name} {before} -> {after}", file=sys.stderr)
            buf = io.StringIO(newline="")
            write_csv(fields, rows, buf)
            name = os.path.basename(info.filename)[:-4].upper()
            if not name.isalnum():
                continue  # stray files like "'.RXD" that Reflex leaves behind
            out[name] = (buf.getvalue().encode("utf-8"), len(rows))
    return out


def pending(entries: list[dict], manifest: dict, since: dt.date | None) -> list[tuple[dt.date, dict]]:
    todo = []
    for e in entries:
        if e[".tag"] != "file" or not e["name"].lower().endswith(".zip"):
            continue
        week = week_of(e["name"])
        if week is None:
            print(f"skip (no date in name): {e['name']}", file=sys.stderr)
            continue
        if since and week < since:
            continue
        done = manifest["weeks"].get(week.isoformat())
        if done and done.get("content_hash") == e.get("content_hash"):
            continue
        todo.append((week, e))
    todo.sort(key=lambda t: t[0])
    return todo


def sync(dbx: Dropbox, out_dir: str, since: dt.date | None, limit: int | None, upload: bool, dry_run: bool) -> int:
    manifest = load_manifest(out_dir, dbx if upload else None)
    todo = pending(dbx.list_folder(SRC_FOLDER), manifest, since)
    if limit is not None:
        todo = todo[:limit]
    print(f"{len(todo)} week(s) to pull, {len(manifest['weeks'])} already done", file=sys.stderr)
    for week, e in todo:
        label = week.isoformat()
        if dry_run:
            print(f"  would pull {e['name']} -> {label}/  ({e['size'] // 1024} KB)", file=sys.stderr)
            continue
        try:
            files = convert(dbx.download(e["path_lower"]), week)
        except zipfile.BadZipFile:
            # A corrupt upload; record it so the run moves on and does not retry
            # it every week. It's re-pulled if the zip is ever replaced.
            print(f"  {e['name']} -> SKIPPED, not a valid zip", file=sys.stderr)
            files = {}
        week_dir = os.path.join(out_dir, label)
        os.makedirs(week_dir, exist_ok=True)
        for typ, (data, _) in files.items():
            with open(os.path.join(week_dir, typ + ".csv"), "wb") as fh:
                fh.write(data)
            if upload:
                dbx.upload(f"{DST_FOLDER}/{label}/{typ}.csv", data)
        manifest["weeks"][label] = {
            "zip": e["name"],
            "content_hash": e.get("content_hash"),
            "size": e["size"],
            "files": {typ: n for typ, (_, n) in files.items()},
            **({} if files else {"error": "not a valid zip"}),
            "synced_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        }
        save_manifest(out_dir, manifest)
        if upload:
            # Per week, not at the end: a killed run still leaves Dropbox's copy
            # matching what's there, and the dashboard reads it live.
            with open(os.path.join(out_dir, "manifest.json"), "rb") as fh:
                dbx.upload(f"{DST_FOLDER}/manifest.json", fh.read())
        summary = ", ".join(f"{t} {n}" for t, (_, n) in sorted(files.items()))
        print(f"  {e['name']} -> {label}/  {summary}", file=sys.stderr)
    return len(todo)


def repair(dbx: Dropbox | None, out_dir: str, upload: bool) -> int:
    """Re-run the date repair over CSVs already converted (before the repair existed); upload the ones that change."""
    changed = 0
    for label in sorted(os.listdir(out_dir)):
        try:
            week = dt.date.fromisoformat(label)
        except ValueError:
            continue
        for name in sorted(os.listdir(os.path.join(out_dir, label))):
            if not name.endswith(".csv"):
                continue
            p = os.path.join(out_dir, label, name)
            with open(p, encoding="utf-8", newline="") as fh:
                text = fh.read()
            new, changes = repair_csv(text, week)
            if not changes:
                continue
            with open(p, "w", encoding="utf-8", newline="") as fh:
                fh.write(new)
            if upload and dbx is not None:
                dbx.upload(f"{DST_FOLDER}/{label}/{name}", new.encode("utf-8"))
            changed += 1
            print(f"  {label}/{name}: {len(changes)} date(s) repaired", file=sys.stderr)
    print(f"{changed} file(s) changed", file=sys.stderr)
    return changed


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="out", help="local output directory (default: out)")
    ap.add_argument("--since", type=dt.date.fromisoformat, help="only weeks on/after YYYY-MM-DD")
    ap.add_argument("--limit", type=int, help="pull at most N weeks (oldest first)")
    ap.add_argument("--upload", action="store_true", help=f"also write CSVs to {DST_FOLDER}")
    ap.add_argument("--dry-run", action="store_true", help="list pending weeks, download nothing")
    ap.add_argument("--auth", action="store_true", help="obtain a long-lived refresh token and exit")
    ap.add_argument("--repair", action="store_true", help="re-run the date repair over already-converted CSVs in --out")
    a = ap.parse_args(argv)
    try:
        if a.auth:
            obtain_refresh_token()
            return 0
        if a.repair:
            repair(Dropbox.from_env() if a.upload else None, a.out, a.upload)
            return 0
        sync(Dropbox.from_env(), a.out, a.since, a.limit, a.upload, a.dry_run)
        return 0
    except DropboxError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
