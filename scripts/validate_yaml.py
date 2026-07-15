#!/usr/bin/env python3
"""Validate data/conferences.yml against the schema in CONTRIBUTING.md.

Runs in CI on every pull request so a malformed entry is caught before it
reaches the site. The site also validates client-side and degrades
gracefully, but failing the PR gives contributors faster feedback.

Exit code 0 = OK, 1 = problems found (printed one per line).
"""
import re
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

DATA = Path(__file__).resolve().parent.parent / "data" / "conferences.yml"

TOPICS = {
    "ai-governance-policy", "ai-ethics-society", "law-regulation",
    "human-ai-interaction", "platform-internet-governance",
    "privacy-surveillance", "ai-relationships-companions",
    "media-communication", "digital-humanities", "safety-security",
}
VENUE_TYPES = {"conference", "workshop", "policy-convening", "journal", "symposium"}
DISCIPLINES = {"cs", "law", "policy", "social-science", "humanities", "interdisciplinary"}

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$")


def check_timezone(tz):
    """AoE, UTC, or a valid IANA zone name."""
    if tz is None:
        return False
    t = str(tz).strip()
    if t.lower() in ("aoe", "utc"):
        return True
    try:
        ZoneInfo(t)
        return True
    except Exception:
        return False


def check_date(value):
    s = str(value).strip()
    if s.upper() == "TBA":
        return True
    if not DATE_RE.match(s):
        return False
    try:
        fmt = "%Y-%m-%d %H:%M" if " " in s else "%Y-%m-%d"
        datetime.strptime(s, fmt)
        return True
    except ValueError:
        return False


def main():
    problems = []
    warnings = []
    try:
        raw = yaml.safe_load(DATA.read_text())
    except yaml.YAMLError as e:
        print(f"YAML syntax error in {DATA}:\n{e}")
        return 1

    if not isinstance(raw, list):
        print("Top level of conferences.yml must be a list of entries.")
        return 1

    seen_names = set()
    for i, e in enumerate(raw):
        where = f"Entry {i + 1}" + (f" ({e.get('name')!r})" if isinstance(e, dict) and e.get("name") else "")
        if not isinstance(e, dict):
            problems.append(f"{where}: not a mapping — check indentation.")
            continue
        for field in ("name", "link"):
            if not e.get(field):
                problems.append(f"{where}: missing required field '{field}'.")
        if e.get("name") in seen_names:
            problems.append(f"{where}: duplicate name — names must be unique (they seed iCal event IDs).")
        seen_names.add(e.get("name"))
        if e.get("link") and not str(e["link"]).startswith(("http://", "https://")):
            problems.append(f"{where}: link must be a full URL.")
        if e.get("venue_type") and e["venue_type"] not in VENUE_TYPES:
            problems.append(f"{where}: unknown venue_type '{e['venue_type']}' (allowed: {sorted(VENUE_TYPES)}).")
        for t in e.get("topics") or []:
            if t not in TOPICS:
                problems.append(f"{where}: unknown topic '{t}' (allowed: {sorted(TOPICS)}).")
        for d in e.get("disciplines") or []:
            if d not in DISCIPLINES:
                problems.append(f"{where}: unknown discipline '{d}' (allowed: {sorted(DISCIPLINES)}).")
        # submission_types feeds the "Output type" filter. Missing is a warning,
        # not an error — the entry just won't match any output-type filter.
        st = e.get("submission_types")
        if not st:
            warnings.append(f"{where}: no 'submission_types' — add one so the Output-type filter can match this venue.")
        elif not isinstance(st, list) or not all(isinstance(v, str) for v in st):
            problems.append(f"{where}: 'submission_types' must be a list of strings.")
        for ev_field in ("event_start", "event_end"):
            v = e.get(ev_field)
            if v is not None and not check_date(v):
                problems.append(f"{where}: {ev_field} '{v}' is not YYYY-MM-DD or TBA.")
        deadlines = e.get("deadlines")
        if deadlines is None:
            deadlines = []
        if not isinstance(deadlines, list):
            problems.append(f"{where}: 'deadlines' must be a list (use 'deadlines: []' if none).")
            continue
        for j, dl in enumerate(deadlines):
            if not isinstance(dl, dict) or not dl.get("label"):
                problems.append(f"{where}, deadline {j + 1}: each deadline needs a 'label'.")
                continue
            date = dl.get("date")
            if date is None:
                problems.append(f"{where}, deadline '{dl['label']}': missing 'date' (use \"TBA\" if unknown).")
            elif not check_date(date):
                problems.append(
                    f"{where}, deadline '{dl['label']}': bad date '{date}' — "
                    f"use \"YYYY-MM-DD HH:mm\", \"YYYY-MM-DD\", or \"TBA\" (quote it!)."
                )
            is_tba = str(date).strip().upper() == "TBA"
            if not is_tba and not check_timezone(dl.get("timezone")):
                problems.append(
                    f"{where}, deadline '{dl['label']}': bad or missing timezone "
                    f"'{dl.get('timezone')}' — use AoE, UTC, or an IANA name like America/New_York."
                )

    if warnings:
        print(f"{len(warnings)} warning(s) (not fatal):")
        for w in warnings:
            print(f"  ⚠ {w}")
        print()
    if problems:
        print(f"{len(problems)} problem(s) in {DATA.name}:\n")
        for p in problems:
            print(f"  • {p}")
        return 1
    print(f"OK — {len(raw)} entries validated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
