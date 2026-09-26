#!/usr/bin/env python3
"""Read Borland Reflex (DOS) .RXD databases directly — no DOSBox, no Reflex.

    python3 tools/rxd/rxd.py APTS.RXD                 # CSV to stdout
    python3 tools/rxd/rxd.py datafile_01_14_2026.zip  # one CSV per .RXD, next to the zip
    python3 tools/rxd/rxd.py --fields APTS.RXD        # field names + types only

Also importable: `read_rxd(path) -> (fields, rows)`.

File layout (little-endian, 16-bit DOS integers):
  * 512-byte header: int16 size, 12-byte stamp "3Q.!&@#$!&&", version words,
    then a table of (int16 type, int32 addr, int32 len) section descriptors.
  * Section 2 (field directory): 12 bytes sort info, then three
    length-prefixed blocks — name index, name text (NUL-terminated strings),
    and 16-byte field descriptors (name offset, type, precision, record
    offset, index, pool, sort). After 6 bytes, one (index, pool) block pair
    per repeating-text field, in reverse field order.
  * Section 9 (master record): int16 record count.
  * Section 1 (data records): 2 bytes, then one length-prefixed record each.
    Text fields hold an int16 offset into the record (local text) or into
    the field's repeating-text pool; dates are int16 days since 1899-12-31;
    numerics are IEEE doubles; integers are int16.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import os
import re
import struct
import sys
import zipfile
from dataclasses import dataclass
from typing import BinaryIO, Iterable

STAMP = b"3Q.!&@#$!&&\x00"
SEC_DATA_RECS, SEC_FIELD_DIR, SEC_MASTER_REC = 1, 2, 9
T_UNTYPED, T_TEXT, T_REPTEXT, T_DATE, T_NUMERIC, T_INT = range(6)
TYPE_NAMES = ["untyped", "text", "reptext", "date", "numeric", "int"]
NULL_INT = 0x8000
NULL_NUMERIC = b"\x00\x00\x00\x00\x00\x00\xff\x7f"
DATE_EPOCH = dt.date(1899, 12, 31)
ENCODING = "cp437"


class RxdError(ValueError):
    pass


@dataclass
class Field:
    name: str
    type: int
    offset: int
    pool: int = -1  # index into repeating-text pools, for T_REPTEXT

    @property
    def type_name(self) -> str:
        return TYPE_NAMES[self.type]


def _block(f: BinaryIO) -> bytes:
    (n,) = struct.unpack("<H", f.read(2))
    buf = f.read(n)
    if len(buf) != n:
        raise RxdError("truncated block")
    return buf


def _cstr(buf: bytes, off: int) -> str:
    end = buf.find(b"\x00", off)
    if end < 0:
        end = len(buf)
    return buf[off:end].decode(ENCODING)


def _sections(f: BinaryIO) -> dict[int, tuple[int, int]]:
    f.seek(0)
    hdr = f.read(512)
    if hdr[2:14] != STAMP:
        raise RxdError("not a Reflex database (bad stamp)")
    (count,) = struct.unpack_from("<h", hdr, 64)
    out: dict[int, tuple[int, int]] = {}
    for i in range(count):
        typ, addr, ln = struct.unpack_from("<hii", hdr, 66 + 10 * i)
        out.setdefault(typ, (addr, ln))
    return out


def _read_fields(f: BinaryIO, addr: int) -> tuple[list[Field], list[bytes]]:
    f.seek(addr + 12)  # skip sort info
    _block(f)  # name index (one int16 per field; unused)
    names = _block(f)
    directory = _block(f)
    if len(directory) % 16:
        raise RxdError("field directory not a multiple of 16 bytes")
    fields = []
    for i in range(len(directory) // 16):
        name_off, typ, _prec, rec_off = struct.unpack_from("<HBBH", directory, i * 16)
        if typ > T_INT:
            raise RxdError(f"unknown field type {typ}")
        fields.append(Field(_cstr(names, name_off), typ, rec_off))
    f.seek(6, os.SEEK_CUR)
    rep = [fl for fl in reversed(fields) if fl.type == T_REPTEXT]
    pools = []
    for i, fl in enumerate(rep):
        _block(f)  # pointer table into the pool; unused
        pools.append(_block(f))
        fl.pool = i
    return fields, pools


def _value(fl: Field, rec: bytes, pools: list[bytes]):
    off = fl.offset
    if fl.type == T_TEXT or fl.type == T_REPTEXT:
        (p,) = struct.unpack_from("<H", rec, off)
        buf = rec if fl.type == T_TEXT else pools[fl.pool]
        if p == 0 or p >= len(buf):
            return None
        return _cstr(buf, p)
    if fl.type == T_DATE:
        (d,) = struct.unpack_from("<H", rec, off)
        if d == 0:
            return None
        try:
            return DATE_EPOCH + dt.timedelta(days=d)
        except OverflowError:
            return None
    if fl.type == T_NUMERIC:
        raw = rec[off : off + 8]
        if raw == NULL_NUMERIC:
            return None
        (v,) = struct.unpack("<d", raw)
        return None if v != v or v in (float("inf"), float("-inf")) else v
    if fl.type == T_INT:
        (v,) = struct.unpack_from("<H", rec, off)
        return None if v == NULL_INT else struct.unpack("<h", rec[off : off + 2])[0]
    return None


def read_rxd(src: str | BinaryIO) -> tuple[list[Field], list[list]]:
    """Return (fields, rows). Row values are str, date, float, int or None."""
    f = open(src, "rb") if isinstance(src, str) else src
    try:
        secs = _sections(f)
        for s in (SEC_FIELD_DIR, SEC_MASTER_REC, SEC_DATA_RECS):
            if s not in secs:
                raise RxdError(f"missing section {s}")
        fields, pools = _read_fields(f, secs[SEC_FIELD_DIR][0])
        f.seek(secs[SEC_MASTER_REC][0])
        (nrec,) = struct.unpack("<H", f.read(2))
        f.seek(secs[SEC_DATA_RECS][0] + 2)
        rows = []
        for _ in range(nrec):
            rec = _block(f)
            rows.append([_value(fl, rec, pools) for fl in fields])
        return fields, rows
    finally:
        if isinstance(src, str):
            f.close()


def _fmt(v) -> str:
    if v is None:
        return ""
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, float):
        return repr(v) if v != int(v) or abs(v) >= 1e15 else str(int(v))
    return str(v)


# Dates that record something that already happened. Loan due/complete dates are
# legitimately in the future and are left alone.
EVENT_DATE = ("INSIDER DATE", "SALE DATE", "LAND SALE DATE", "LOAN START DATE")


def _is_event_date(name: str) -> bool:
    return any(k in name.upper() for k in EVENT_DATE)


def _year_candidates(year: int) -> set[int]:
    """Years reachable from a mistyped one by fixing a single digit or swapping two adjacent digits."""
    s = str(year)
    out = set()
    for i in range(4):
        for d in "0123456789":
            out.add(int(s[:i] + d + s[i + 1:]))
    for i in range(3):
        out.add(int(s[:i] + s[i + 1] + s[i] + s[i + 2:]))
    out.discard(year)
    return out


def repair_date(name: str, value: dt.date, week: dt.date, anchor: dt.date | None) -> dt.date:
    """Fix a typed-in year that lands after the file's week (2062-02-13 -> 2026-02-13, 8/5/2916 -> 2016).

    Insider dates prefer a Friday, the day the report goes out (96% of them are);
    then the candidate nearest the record's INSIDER DATE (or the week) wins.
    """
    if value <= week or not _is_event_date(name):
        return value
    target = anchor or week
    upper = week
    if anchor and "PREVIOUS INSIDER" in name.upper():
        upper = anchor - dt.timedelta(days=1)
    fixes = []
    for y in _year_candidates(value.year):
        if y < 1950 or y > upper.year:
            continue
        try:
            d = value.replace(year=y)
        except ValueError:
            continue
        if d <= upper:
            fixes.append(d)
    if not fixes:
        return value
    pool = fixes
    if "INSIDER" in name.upper():
        # A wrong year typed on this week's entry lands within days of the week
        # itself; otherwise the Friday the report went out picks the year.
        near = [d for d in pool if abs((d - target).days) <= 60]
        fridays = [d for d in pool if d.weekday() == 4]
        pool = near or fridays or pool
    return min(pool, key=lambda d: (abs((d - target).days), -d.year))


_MDY = re.compile(r"^\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*$")


def _as_date(v) -> dt.date | None:
    """A date cell: a real date, an ISO string, or Reflex's free-text m/d/yyyy (APTS 'PREVIOUS INSIDER DATE 1')."""
    if isinstance(v, dt.date):
        return v
    if not isinstance(v, str):
        return None
    try:
        return dt.date.fromisoformat(v.strip())
    except ValueError:
        pass
    m = _MDY.match(v)
    if not m:
        return None
    try:
        return dt.date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
    except ValueError:
        return None


def repair_dates(fields: list[Field], rows: list[list], week: dt.date) -> list[tuple[int, str, dt.date, dt.date]]:
    """Repair event dates in place; returns (row index, field, before, after) for each change.

    Text-typed date cells keep their spelling (m/d/yyyy stays m/d/yyyy).
    """
    date_cols = [i for i, fl in enumerate(fields) if _is_event_date(fl.name)]
    if not date_cols:
        return []
    ins = next((i for i, fl in enumerate(fields) if fl.name.upper() == "INSIDER DATE"), None)
    changes = []
    for r, row in enumerate(rows):
        anchor = _as_date(row[ins]) if ins is not None else None
        if anchor is not None and anchor > week:
            anchor = None
        for i in date_cols:
            v = _as_date(row[i])
            if v is None or v <= week:
                continue
            fixed = repair_date(fields[i].name, v, week, anchor)
            if fixed == v:
                continue
            if isinstance(row[i], str) and _MDY.match(row[i]):
                row[i] = f"{fixed.month}/{fixed.day}/{fixed.year}"
            else:
                row[i] = fixed
            changes.append((r, fields[i].name, v, fixed))
    return changes


def repair_csv(text: str, week: dt.date) -> tuple[str, list[tuple[int, str, dt.date, dt.date]]]:
    """Apply repair_dates to an already-converted CSV (ISO dates); returns (new text, changes)."""
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return text, []
    header, body = rows[0], rows[1:]
    body = [r + [""] * (len(header) - len(r)) for r in body]
    fields = [Field(h, T_TEXT, 0) for h in header]
    changes = repair_dates(fields, body, week)
    if not changes:
        return text, []
    buf = io.StringIO(newline="")
    write_csv(fields, body, buf)
    return buf.getvalue(), changes


def write_csv(fields: list[Field], rows: Iterable[list], out) -> None:
    w = csv.writer(out, lineterminator="\n")
    w.writerow(fl.name for fl in fields)
    for r in rows:
        w.writerow(_fmt(v) for v in r)


def convert_zip(zip_path: str, out_dir: str | None = None, week: dt.date | None = None) -> list[str]:
    out_dir = out_dir or os.path.splitext(zip_path)[0]
    os.makedirs(out_dir, exist_ok=True)
    written = []
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            if not info.filename.lower().endswith(".rxd"):
                continue
            with z.open(info) as member:
                fields, rows = read_rxd(io.BytesIO(member.read()))
            if week:
                for _, name, before, after in repair_dates(fields, rows, week):
                    print(f"  {info.filename}: {name} {before} -> {after}", file=sys.stderr)
            dest = os.path.join(out_dir, os.path.basename(info.filename)[:-4] + ".csv")
            with open(dest, "w", newline="", encoding="utf-8") as fh:
                write_csv(fields, rows, fh)
            written.append(dest)
            print(f"{info.filename}: {len(rows)} records, {len(fields)} fields -> {dest}", file=sys.stderr)
    return written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("path", help=".RXD file or a zip of them")
    ap.add_argument("-o", "--out", help="output CSV (file) or directory (zip)")
    ap.add_argument("--fields", action="store_true", help="list fields and exit")
    a = ap.parse_args(argv)
    if a.path.lower().endswith(".zip"):
        convert_zip(a.path, a.out)
        return 0
    fields, rows = read_rxd(a.path)
    if a.fields:
        for i, fl in enumerate(fields):
            print(f"{i:3d}  {fl.type_name:8s} {fl.name}")
        return 0
    if a.out:
        with open(a.out, "w", newline="", encoding="utf-8") as fh:
            write_csv(fields, rows, fh)
        print(f"{len(rows)} records, {len(fields)} fields -> {a.out}", file=sys.stderr)
    else:
        write_csv(fields, rows, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
