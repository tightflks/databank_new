#!/usr/bin/env python3
"""Turn the weekly CSV snapshots into one record per property with its history.

    python3 tools/rxd/history.py --csv out                    # all types, from out/<week>/<TYPE>.csv
    python3 tools/rxd/history.py --csv out --type APTS
    python3 tools/rxd/history.py --csv out --upload           # also write to Dropbox _csv/history/

Every weekly file is a snapshot of the same live Reflex database, so a property is
the same row seen week after week. Rows are linked across weeks by, in order:
    parcel + address, parcel + name, address + name, parcel, address, name
where parcel = COUNTY / DISTRICT / LANDLOT / PARCEL (PARCEL alone is only the last
segment and is shared by dozens of rows) and address = number + street + city.
Each link that changes a tracked field becomes an event; rows that vanish are
marked removed and pick up their history again if they come back.

Output per type (out/history/<TYPE>.json.gz):
    { "type", "generated", "weeks": [...], "fields": [...], "properties": [
        { "id", "name", "address", "city", "county", "parcel", "first", "last",
          "seen", "removed", "current": {field: value}, "events": [[week, field, from, to], ...] } ] }

Incremental: the JSON remembers the weeks already folded in, so the weekly job
only reads the new week(s); --full rebuilds from the first week.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import json
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dropbox_sync import DST_FOLDER, Dropbox  # noqa: E402

TYPES = ["APTS", "FRANCHIS", "IND", "LANDSALE", "OFFSHOP"]
WEEK_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
IGNORED = re.compile(r"^(\$ (ACRE|SF|UNIT LAND|UNIT PROJECT)|\d avg \$.*|% .*|\d (MIN|MAX) .*|\d INCREASE|\d NOTE 1|M\d+)$")

csv.field_size_limit(1 << 26)


def norm(s: str) -> str:
    return re.sub(r"\W+", "", s).upper()


def first_name(s: str) -> str:
    """'ARIUM JOHNS CREEK/CHELSEA RIDGE/WAS BRISTOL PARK' -> 'ARIUMJOHNSCREEK'."""
    return norm(re.split(r"[/(]", s, 1)[0])


class Keys:
    def __init__(self, header: list[str]):
        ix = {c: i for i, c in enumerate(header)}
        self.ix = ix
        self.parcel_cols = [ix[c] for c in ("COUNTY", "DISTRICT", "LANDLOT", "PARCEL") if c in ix]
        self.addr_cols = [ix[c] for c in ("P STREET NUMBER", "P STREET NAME", "P CITY") if c in ix]
        self.name_col = ix.get("P NAME")

    def of(self, row: list[str]) -> tuple[str, str, str]:
        parcel = "/".join(norm(row[i]) for i in self.parcel_cols)
        if "PARCEL" not in self.ix or not norm(row[self.ix["PARCEL"]]):
            parcel = ""
        addr = "".join(norm(row[i]) for i in self.addr_cols) if self.addr_cols else ""
        name = first_name(row[self.name_col]) if self.name_col is not None else ""
        return parcel, addr, name


def load_week(path: str) -> tuple[list[str], list[list[str]]]:
    with open(path, encoding="utf-8", errors="replace", newline="") as fh:
        rows = list(csv.reader(fh))
    header = [c.strip() for c in rows[0]]
    body = [[v.strip() for v in r] + [""] * (len(header) - len(r)) for r in rows[1:]]
    return header, [r for r in body if sum(1 for v in r if v) >= 3]


def weeks_in(csv_dir: str, typ: str) -> list[str]:
    today = dt.date.today() + dt.timedelta(days=14)
    out = []
    for w in os.listdir(csv_dir):
        if WEEK_RE.match(w) and os.path.exists(os.path.join(csv_dir, w, f"{typ}.csv")):
            if dt.date.fromisoformat(w) <= today:
                out.append(w)
    return sorted(out)


def new_history(typ: str) -> dict:
    return {"type": typ, "generated": None, "weeks": [], "fields": [], "properties": []}


def fold_week(hist: dict, week: str, header: list[str], rows: list[list[str]]) -> dict[str, int]:
    """Link this week's rows to the properties in `hist`, appending events. Mutates hist."""
    keys = Keys(header)
    fields = hist["fields"] or header
    hist["fields"] = fields
    props = hist["properties"]
    live = [p for p in props if not p["removed"]]

    def index(pool: list[dict]):
        by: dict[str, dict[str, list[dict]]] = {k: defaultdict(list) for k in ("pa", "pn", "an", "p", "a", "n")}
        for p in pool:
            parcel, addr, name = p["_k"]
            if parcel and addr:
                by["pa"][parcel + "#" + addr].append(p)
            if parcel and name:
                by["pn"][parcel + "#" + name].append(p)
            if addr and name:
                by["an"][addr + "#" + name].append(p)
            if parcel:
                by["p"][parcel].append(p)
            if addr:
                by["a"][addr].append(p)
            if name:
                by["n"][name].append(p)
        return by

    live_ix = index(live)
    gone_ix = index([p for p in props if p["removed"]])
    claimed: set[int] = set()
    stats = {"linked": 0, "new": 0, "removed": 0, "restored": 0, "events": 0}

    def find(k: tuple[str, str, str]) -> dict | None:
        parcel, addr, name = k
        probes = [
            ("pa", parcel and addr and parcel + "#" + addr),
            ("pn", parcel and name and parcel + "#" + name),
            ("an", addr and name and addr + "#" + name),
            ("p", parcel),
            ("a", addr),
            ("n", name),
        ]
        for ix in (live_ix, gone_ix):
            for bucket, key in probes:
                if not key:
                    continue
                cands = [p for p in ix[bucket].get(key, ()) if id(p) not in claimed]
                if len(cands) == 1 or (cands and bucket in ("pa", "pn", "an")):
                    return cands[0]
        return None

    for row in rows:
        k = keys.of(row)
        rec = {fields[i]: v for i, v in enumerate(row) if i < len(fields) and v}
        p = find(k)
        if p is None:
            p = {
                "id": f"{hist['type']}-{len(props) + 1:05d}",
                "first": week,
                "last": week,
                "seen": 0,
                "removed": False,
                "current": {},
                "events": [],
                "_k": k,
            }
            props.append(p)
            stats["new"] += 1
        else:
            if p["removed"]:
                p["removed"] = False
                p["events"].append([week, "*", "removed", "restored"])
                stats["restored"] += 1
            stats["linked"] += 1
        claimed.add(id(p))
        cur = p["current"]
        for f in set(cur) | set(rec):
            if IGNORED.match(f):
                continue
            a, b = cur.get(f, ""), rec.get(f, "")
            if a != b and p["seen"]:
                p["events"].append([week, f, a, b])
                stats["events"] += 1
        p["current"] = rec
        p["_k"] = k
        p["last"] = week
        p["seen"] += 1

    for p in live:
        if id(p) not in claimed:
            p["removed"] = True
            p["events"].append([week, "*", "present", "removed"])
            stats["removed"] += 1

    hist["weeks"].append(week)
    return stats


def summarize(p: dict) -> None:
    c = p["current"]
    p["name"] = c.get("P NAME", "")
    p["address"] = " ".join(v for v in (c.get("P STREET NUMBER"), c.get("P STREET NAME")) if v)
    p["city"] = c.get("P CITY", "")
    p["county"] = c.get("COUNTY", "")
    p["parcel"] = "/".join(v for v in (c.get("DISTRICT"), c.get("LANDLOT"), c.get("PARCEL")) if v)


def build(csv_dir: str, typ: str, out_dir: str, full: bool) -> dict:
    path = os.path.join(out_dir, f"{typ}.json.gz")
    hist = new_history(typ)
    if not full and os.path.exists(path):
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            hist = json.load(fh)
        for p in hist["properties"]:
            p["_k"] = tuple(p.pop("_key", ("", "", "")))
    done = set(hist["weeks"])
    todo = [w for w in weeks_in(csv_dir, typ) if w not in done]
    for w in todo:
        header, rows = load_week(os.path.join(csv_dir, w, f"{typ}.csv"))
        s = fold_week(hist, w, header, rows)
        print(f"  {typ} {w}: {len(rows)} rows, {s['linked']} linked, {s['new']} new, {s['removed']} removed, {s['restored']} restored, {s['events']} changes", file=sys.stderr)
    for p in hist["properties"]:
        summarize(p)
        p["_key"] = list(p.pop("_k"))
    hist["generated"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    os.makedirs(out_dir, exist_ok=True)
    tmp = path + ".tmp"
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=6) as fh:
        json.dump(hist, fh, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, path)
    return hist


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default="out", help="folder holding <week>/<TYPE>.csv (default: out)")
    ap.add_argument("--out", default=None, help="history folder (default: <csv>/history)")
    ap.add_argument("--type", action="append", choices=TYPES, help="limit to a property type")
    ap.add_argument("--full", action="store_true", help="rebuild from the first week instead of appending")
    ap.add_argument("--upload", action="store_true", help=f"also write the JSON to {DST_FOLDER}/history/")
    a = ap.parse_args(argv)
    out_dir = a.out or os.path.join(a.csv, "history")
    dbx = Dropbox.from_env() if a.upload else None
    for typ in a.type or TYPES:
        hist = build(a.csv, typ, out_dir, a.full)
        n = len(hist["properties"])
        live = sum(1 for p in hist["properties"] if not p["removed"])
        ev = sum(len(p["events"]) for p in hist["properties"])
        print(f"{typ}: {n} properties ({live} current), {ev} changes over {len(hist['weeks'])} weeks", file=sys.stderr)
        if dbx:
            with open(os.path.join(out_dir, f"{typ}.json.gz"), "rb") as fh:
                dbx.upload(f"{DST_FOLDER}/history/{typ}.json.gz", fh.read())
    return 0


if __name__ == "__main__":
    sys.exit(main())
