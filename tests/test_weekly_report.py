#!/usr/bin/env python3
"""Test for scripts/weekly_report.py: fixture YAML in, expected markdown out.

Run:  python3 tests/test_weekly_report.py   (needs: pip install pyyaml)
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from weekly_report import build_report, cfp_window_open, parse_deadline  # noqa: E402

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "sample_conferences.yml"
EXPECTED = HERE / "fixtures" / "expected_report.md"
NOW = datetime(2026, 7, 13, 12, 0, tzinfo=timezone.utc)

failures = 0


def check(cond, msg):
    global failures
    if cond:
        print(f"  ✓ {msg}")
    else:
        failures += 1
        print(f"  ✗ FAIL: {msg}")


print("parse_deadline:")
aoe = parse_deadline("2026-07-23 23:59", "AoE")
check(aoe.utcoffset().total_seconds() == -12 * 3600, "AoE parses as UTC-12")
check(parse_deadline("2026-07-10", "UTC").hour == 23, "date-only defaults to 23:59")
check(parse_deadline("TBA", "AoE") is None, "TBA parses to None")
check(parse_deadline("garbage", "AoE") is None, "unparseable date yields None")

print("cfp_window_open heuristic:")
check(cfp_window_open("CFP typically opens in July.", NOW), "current month named → open")
check(not cfp_window_open("Deadline typically March 1.", NOW), "other month → not flagged")
check(cfp_window_open("CFP appears in the summer.", NOW), "current season named → open")

print("build_report against golden file:")
report = build_report(FIXTURE.read_text(), NOW)
expected = EXPECTED.read_text()
if report != expected:
    failures += 1
    print("  ✗ FAIL: report differs from fixtures/expected_report.md")
    import difflib
    sys.stdout.writelines(difflib.unified_diff(
        expected.splitlines(keepends=True), report.splitlines(keepends=True),
        fromfile="expected", tofile="actual"))
else:
    print("  ✓ report matches fixtures/expected_report.md exactly")

# Belt-and-suspenders semantic checks (survive cosmetic golden-file updates)
check("Upcoming Conf 2026" in report.split("## 🕰")[0], "upcoming deadline in 30-day section")
check("10 days" in report, "days-remaining arithmetic (Jul 13 → Jul 23 AoE)")
check("Expired Conf 2026" in report.split("## 🕰")[1].split("## 🔭")[0], "expired deadline in expired section")
check("Far Conf 2027" not in report, "far-future deadline in no section (only its VERIFY date line)")
check("TBA Conf" in report, "TBA venue listed")
check("typical CFP window may be open" in report, "July-note venue flagged as window-open")
check("# VERIFY" in report and "2027-01-30" in report.split("## 🚩")[1], "VERIFY line surfaced with content")

if failures:
    print(f"\n{failures} assertion(s) failed.")
    sys.exit(1)
print("\nAll assertions passed.")
