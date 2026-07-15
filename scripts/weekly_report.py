#!/usr/bin/env python3
"""Tier 1 of the weekly deadline check (no API key needed).

Reads data/conferences.yml and opens a recurring GitHub issue titled
"Weekly deadline review — {date}" summarizing:

  * deadlines occurring in the next 30 days (sorted, with days remaining)
  * deadlines that expired since the last run (assumed weekly cadence: 7 days)
  * entries still marked TBA, with their typical-CFP-month notes, flagging
    ones whose typical CFP window appears to be open right now
  * every line in the data file carrying a "# VERIFY" comment

The previous week's issue is closed when the new one is opened.

Usage:
  python3 scripts/weekly_report.py             # needs GITHUB_TOKEN + GITHUB_REPOSITORY
  python3 scripts/weekly_report.py --dry-run   # print the markdown, no API calls

Pure logic lives in build_report(); tests/test_weekly_report.py exercises it
against a fixture with a pinned clock.
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

DATA = Path(__file__).resolve().parent.parent / "data" / "conferences.yml"
ISSUE_TITLE_PREFIX = "Weekly deadline review — "

MONTHS = ["january", "february", "march", "april", "may", "june", "july",
          "august", "september", "october", "november", "december"]
SEASONS = {  # northern-hemisphere seasons → months, for notes like "fall CFP"
    "spring": {3, 4, 5}, "summer": {6, 7, 8},
    "fall": {9, 10, 11}, "autumn": {9, 10, 11}, "winter": {12, 1, 2},
}


def parse_deadline(date_str, tz):
    """Parse a schema deadline into an aware datetime, or None for TBA/bad."""
    s = str(date_str).strip()
    if s.upper() == "TBA":
        return None
    t = str(tz or "AoE").strip()
    if t.lower() == "aoe":
        zone = timezone(timedelta(hours=-12))  # Anywhere on Earth = UTC-12
    elif t.lower() == "utc":
        zone = timezone.utc
    else:
        try:
            zone = ZoneInfo(t)
        except Exception:
            return None
    try:
        fmt = "%Y-%m-%d %H:%M" if " " in s else "%Y-%m-%d"
        dt = datetime.strptime(s, fmt)
        if " " not in s:
            dt = dt.replace(hour=23, minute=59)
        return dt.replace(tzinfo=zone)
    except ValueError:
        return None


def cfp_window_open(note, now):
    """Heuristic: does the entry's note mention the current month (or season)?

    Notes follow the convention of naming the typical CFP month ("deadline is
    typically March 1", "watch the site from November"). If the current month
    is named, the venue's typical CFP window is probably open — worth a look.
    """
    if not note:
        return False
    text = str(note).lower()
    if MONTHS[now.month - 1] in text:
        return True
    return any(season in text and now.month in months
               for season, months in SEASONS.items())


def build_report(yaml_text, now):
    """Render the issue body (markdown) from raw YAML text at a fixed clock."""
    entries = yaml.safe_load(yaml_text) or []
    horizon = now + timedelta(days=30)
    last_run = now - timedelta(days=7)  # the workflow runs weekly

    upcoming, expired, tba = [], [], []
    for e in entries:
        deadlines = e.get("deadlines") or []
        tba_labels = []
        for dl in deadlines:
            dt = parse_deadline(dl.get("date"), dl.get("timezone"))
            if dt is None:
                tba_labels.append(dl.get("label", "Submissions"))
                continue
            if now < dt <= horizon:
                upcoming.append((dt, e, dl))
            elif last_run <= dt <= now:
                expired.append((dt, e, dl))
        if not deadlines or tba_labels:
            tba.append((e, tba_labels))

    lines = [f"# Weekly deadline review — {now.date().isoformat()}", ""]

    lines.append("## ⏳ Deadlines in the next 30 days")
    if upcoming:
        for dt, e, dl in sorted(upcoming, key=lambda x: x[0]):
            days = (dt - now).days
            lines.append(
                f"- **[{e['name']}]({e.get('link', '')}) — {dl.get('label')}**: "
                f"`{dl.get('date')}` {dl.get('timezone', 'AoE')} "
                f"(**{days} day{'s' if days != 1 else ''}** remaining)"
            )
    else:
        lines.append("_None._")
    lines.append("")

    lines.append("## 🕰 Expired since the last run (past 7 days)")
    if expired:
        for dt, e, dl in sorted(expired, key=lambda x: x[0], reverse=True):
            lines.append(
                f"- **{e['name']} — {dl.get('label')}**: `{dl.get('date')}` "
                f"{dl.get('timezone', 'AoE')} — consider updating the entry for the next cycle."
            )
    else:
        lines.append("_None._")
    lines.append("")

    lines.append("## 🔭 Still TBA — watch these venues")
    if tba:
        for e, labels in tba:
            flag = " ⚠️ **typical CFP window may be open now** —" if cfp_window_open(e.get("note"), now) else ""
            note = f" {e['note']}" if e.get("note") else ""
            what = f" ({', '.join(labels)})" if labels else ""
            lines.append(f"- **[{e['name']}]({e.get('link', '')})**{what}:{flag}{note}")
    else:
        lines.append("_None._")
    lines.append("")

    lines.append("## 🚩 Lines flagged `# VERIFY`")
    verify_lines = [
        f"- line {i}: `{line.strip()}`"
        for i, line in enumerate(yaml_text.splitlines(), start=1)
        # skip pure comment lines (e.g. the header that explains the convention)
        if "# VERIFY" in line and not line.lstrip().startswith("#")
    ]
    lines.extend(verify_lines or ["_None._"])
    lines.append("")

    lines.append("---")
    lines.append(
        "_Generated automatically by `scripts/weekly_report.py` "
        "(.github/workflows/weekly-deadline-check.yml). Dates are never changed "
        "automatically without review — update `data/conferences.yml` via pull request._"
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# GitHub issue plumbing (only used in CI)
# ---------------------------------------------------------------------------

def gh_request(method, path, token, body=None):
    url = f"https://api.github.com{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def main():
    yaml_text = DATA.read_text()
    now = datetime.now(timezone.utc)
    report = build_report(yaml_text, now)

    if "--dry-run" in sys.argv:
        print(report)
        return 0

    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo:
        print("GITHUB_TOKEN and GITHUB_REPOSITORY must be set (or use --dry-run).")
        return 1

    # Close last week's issue(s) first.
    open_issues = gh_request("GET", f"/repos/{repo}/issues?state=open&per_page=100", token)
    for issue in open_issues:
        if issue.get("title", "").startswith(ISSUE_TITLE_PREFIX) and "pull_request" not in issue:
            gh_request("PATCH", f"/repos/{repo}/issues/{issue['number']}", token,
                       {"state": "closed", "state_reason": "completed"})
            print(f"Closed previous issue #{issue['number']}")

    created = gh_request("POST", f"/repos/{repo}/issues", token, {
        "title": f"{ISSUE_TITLE_PREFIX}{now.date().isoformat()}",
        "body": report,
    })
    print(f"Opened issue #{created['number']}: {created['html_url']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
