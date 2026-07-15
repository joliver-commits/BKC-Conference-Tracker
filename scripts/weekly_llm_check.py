#!/usr/bin/env python3
"""Tier 2 of the weekly deadline check (requires ANTHROPIC_API_KEY).

For each venue in data/conferences.yml that is still TBA or carries a
"# VERIFY" flag (capped at MAX_VENUES per run to control cost), asks Claude
(claude-sonnet-4-6 with the server-side web-search tool) to check the venue's
official CFP page. Verified dates are applied as minimal text edits to
data/conferences.yml, and a PR body is written to proposed-changes.md listing
every change with the URL it was verified against.

Safety properties, in order of importance:
  * NEVER merges anything — the workflow opens a pull request for human review.
  * Never deletes an entry; only updates deadline dates/timezones, event
    dates, and notes, or appends new deadline items.
  * Any date sourced from a non-official page keeps a "# VERIFY" comment.
  * After editing, scripts/validate_yaml.py is run; if validation fails, all
    edits are rolled back and no PR is proposed.
  * If ANTHROPIC_API_KEY is not set, exits 0 with a log message (Tier 1 has
    already run by then).

The git/PR mechanics live in .github/workflows/weekly-deadline-check.yml —
this script only edits the file and writes the PR body.
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "conferences.yml"
PROPOSAL_FILE = ROOT / "proposed-changes.md"

MODEL = "claude-sonnet-4-6"
MAX_VENUES = 15          # cost cap per run
MAX_SEARCHES_PER_VENUE = 5
MAX_CONTINUATIONS = 5    # pause_turn resumes per venue

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$")


# ---------------------------------------------------------------------------
# Selecting venues to check
# ---------------------------------------------------------------------------

class EntryBlock:
    """One conference entry as a line range in the raw file (keeps comments)."""

    def __init__(self, name, start, end):
        self.name = name
        self.start = start  # inclusive line index
        self.end = end      # exclusive

    def text(self, lines):
        return "\n".join(lines[self.start:self.end])


def find_blocks(lines):
    blocks, current = [], None
    for i, line in enumerate(lines):
        m = re.match(r'^- name: "(.*)"', line)
        if m:
            if current:
                current.end = i
                blocks.append(current)
            current = EntryBlock(m.group(1), i, len(lines))
    if current:
        blocks.append(current)
    return blocks


def needs_check(block, lines):
    text = block.text(lines)
    return 'date: "TBA"' in text or "# VERIFY" in text or "deadlines: []" in text


# ---------------------------------------------------------------------------
# Asking Claude (web search enabled)
# ---------------------------------------------------------------------------

PROMPT = """Today's date is {today}. You are verifying call-for-papers deadlines \
for an academic deadline tracker. Here is the tracker's current YAML entry for one venue:

```yaml
{entry_yaml}
```

Use web search to check this venue's OFFICIAL website / CFP page for its next \
upcoming submission deadlines (and event dates/location if stated). Rules:
- Report a date ONLY if it is explicitly stated on a page you found. NEVER guess, \
infer, or extrapolate dates from past editions.
- Prefer the venue's official site. If you can only verify via a non-official \
source (aggregator, cached page, social media), still report it but set \
"source_is_official": false.
- If nothing new or verifiable is found, return status "nothing_new".

Respond with ONLY a JSON object (no prose before or after) in this shape:
{{
  "status": "found" | "nothing_new",
  "source_url": "<page you verified against>",
  "source_is_official": true,
  "deadlines": [{{"label": "<what is due>", "date": "YYYY-MM-DD HH:mm", "timezone": "AoE"}}],
  "event_start": "YYYY-MM-DD" or null,
  "event_end": "YYYY-MM-DD" or null,
  "location": "City, Country" or null,
  "note": "<optional one-sentence replacement for the entry's note>" or null,
  "summary": "<one line: what you found>"
}}
Use timezone values "AoE", "UTC", or an IANA name. If a deadline's time of day \
is not stated, use "YYYY-MM-DD" without a time."""


def ask_claude(client, entry_yaml, today):
    """One venue check. Handles pause_turn resumes; returns parsed dict or None."""
    user_msg = {"role": "user", "content": PROMPT.format(today=today, entry_yaml=entry_yaml)}
    messages = [user_msg]
    tools = [{"type": "web_search_20260209", "name": "web_search",
              "max_uses": MAX_SEARCHES_PER_VENUE}]

    for _ in range(MAX_CONTINUATIONS):
        resp = client.messages.create(
            model=MODEL, max_tokens=2000, tools=tools, messages=messages,
        )
        if resp.stop_reason == "pause_turn":
            # server-side tool loop paused; resend to resume where it left off
            messages = [user_msg, {"role": "assistant", "content": resp.content}]
            continue
        text = "".join(b.text for b in resp.content if b.type == "text")
        return parse_json_reply(text)
    return None


def parse_json_reply(text):
    """Extract the first JSON object from the model's reply."""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def valid_timezone(tz):
    if str(tz).strip().lower() in ("aoe", "utc"):
        return True
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo(str(tz).strip())
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Applying edits (line-level, minimal diffs, comments preserved)
# ---------------------------------------------------------------------------

def set_field(lines, block, field, value, indent="  "):
    """Replace `{indent}{field}: ...` inside the block, or insert it.

    Returns True if the file changed.
    """
    new_line = f'{indent}{field}: "{value}"'
    for i in range(block.start, block.end):
        if re.match(rf"^{indent}{field}:", lines[i]):
            old_val = lines[i].split(":", 1)[1]
            old_val = re.sub(r"\s*#.*$", "", old_val).strip().strip('"')
            if old_val == str(value):
                return False
            lines[i] = new_line
            return True
    # Insert after the last header-ish line so field order stays sensible
    # (link → location → event_start → event_end).
    anchors = [i for i in range(block.start, block.end)
               if re.match(r"^  (link|location|event_start|event_end):", lines[i])]
    if anchors:
        lines.insert(max(anchors) + 1, new_line)
        block.end += 1
        return True
    return False


def find_deadline_items(lines, block):
    """Return [(label, label_idx)] for the block's deadline items."""
    items = []
    for i in range(block.start, block.end):
        m = re.match(r'^    - label: "(.*)"', lines[i])
        if m:
            items.append((m.group(1), i))
    return items


def norm_label(s):
    return re.sub(r"[^a-z]+", "", str(s).lower())


def update_deadline(lines, block, proposal, verify_suffix):
    """Update an existing deadline item (matched by label) or append a new one.

    Returns a human-readable change description, or None if nothing changed.
    """
    label, date, tz = proposal["label"], proposal["date"], proposal.get("timezone", "AoE")
    date_line = f'      date: "{date}"{verify_suffix}'
    tz_line = f'      timezone: "{tz}"'

    for existing_label, idx in find_deadline_items(lines, block):
        a, b = norm_label(existing_label), norm_label(label)
        if a == b or (a and b and (a in b or b in a)):
            changed = False
            for j in range(idx + 1, min(idx + 4, block.end)):
                if re.match(r"^      date:", lines[j]):
                    if f'"{date}"' not in lines[j]:
                        lines[j] = date_line
                        changed = True
                elif re.match(r"^      timezone:", lines[j]):
                    if f'"{tz}"' not in lines[j]:
                        lines[j] = tz_line
                        changed = True
            return f"**{existing_label}** → `{date}` {tz}" if changed else None

    # No matching label — append a new deadline item.
    for i in range(block.start, block.end):
        if re.match(r"^  deadlines: \[\]", lines[i]):
            lines[i] = "  deadlines:"
            lines.insert(i + 1, f'    - label: "{label}"')
            lines.insert(i + 2, date_line)
            lines.insert(i + 3, tz_line)
            block.end += 3
            return f"new deadline **{label}** → `{date}` {tz}"
    items = find_deadline_items(lines, block)
    if items:
        insert_at = items[-1][1] + 3  # after label/date/timezone of the last item
        lines.insert(insert_at, f'    - label: "{label}"')
        lines.insert(insert_at + 1, date_line)
        lines.insert(insert_at + 2, tz_line)
        block.end += 3
        return f"new deadline **{label}** → `{date}` {tz}"
    return None


def apply_proposal(lines, block, result):
    """Apply one venue's verified findings. Returns list of change strings."""
    changes = []
    official = bool(result.get("source_is_official"))
    url = result.get("source_url", "")
    verify_suffix = "" if official else f"   # VERIFY — non-official source: {url}"

    for dl in result.get("deadlines") or []:
        if not dl.get("label") or not DATE_RE.match(str(dl.get("date", ""))):
            continue
        if not valid_timezone(dl.get("timezone", "AoE")):
            dl["timezone"] = "AoE"
        desc = update_deadline(lines, block, dl, verify_suffix)
        if desc:
            changes.append(desc)

    for field in ("event_start", "event_end"):
        v = result.get(field)
        if v and DATE_RE.match(str(v)) and " " not in str(v):
            if set_field(lines, block, field, v):
                changes.append(f"{field} → `{v}`")
    loc = result.get("location")
    if loc and set_field(lines, block, "location", loc):
        changes.append(f"location → {loc}")
    note = result.get("note")
    if note and changes:  # only touch the note when we changed something real
        if set_field(lines, block, "note", str(note).replace('"', "'")):
            changes.append("note updated")
    return changes


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY not configured — skipping Tier 2 gracefully. "
              "(Tier 1 issue has already been posted; see README to enable Tier 2.)")
        return 0

    import anthropic
    client = anthropic.Anthropic()

    original_text = DATA.read_text()
    lines = original_text.splitlines()
    blocks = find_blocks(lines)
    candidates = [b for b in blocks if needs_check(b, lines)][:MAX_VENUES]
    today = datetime.now(timezone.utc).date().isoformat()
    print(f"Checking {len(candidates)} venue(s) (cap {MAX_VENUES}): "
          + ", ".join(b.name for b in candidates))

    all_changes = []  # (venue, url, official, [change descriptions])
    # Work back-to-front so earlier blocks' line numbers stay valid as we insert.
    for block in sorted(candidates, key=lambda b: b.start, reverse=True):
        entry_yaml = block.text(lines)
        try:
            result = ask_claude(client, entry_yaml, today)
        except anthropic.APIStatusError as e:
            print(f"  {block.name}: API error {e.status_code} — skipping venue")
            continue
        if not result or result.get("status") != "found" or not result.get("source_url"):
            print(f"  {block.name}: nothing new")
            continue
        changes = apply_proposal(lines, block, result)
        if changes:
            print(f"  {block.name}: {len(changes)} change(s) — {result.get('summary', '')}")
            all_changes.append((block.name, result["source_url"],
                                bool(result.get("source_is_official")), changes))
        else:
            print(f"  {block.name}: findings match existing data")

    if not all_changes:
        print("No changes to propose this week.")
        return 0

    DATA.write_text("\n".join(lines) + "\n")

    # Safety gate: a malformed edit must never reach a PR.
    check = subprocess.run([sys.executable, str(ROOT / "scripts" / "validate_yaml.py")],
                           capture_output=True, text=True)
    if check.returncode != 0:
        print("Edited file failed validation — rolling back, no PR will be opened:")
        print(check.stdout)
        DATA.write_text(original_text)
        return 0

    body = [
        f"## Automated weekly deadline update — {today}",
        "",
        "**Automated proposal — verify dates against linked sources before merging.**",
        "",
        f"Checked {len(candidates)} TBA/`# VERIFY` venue(s) with {MODEL} + web search; "
        f"found verifiable updates for {len(all_changes)}:",
        "",
    ]
    for venue, url, official, changes in sorted(all_changes):
        badge = "official page" if official else "⚠️ NON-official source — `# VERIFY` flags added"
        body.append(f"### {venue}")
        body.append(f"Verified against: <{url}> ({badge})")
        body.extend(f"- {c}" for c in changes)
        body.append("")
    body.append("---")
    body.append("_Opened automatically by `.github/workflows/weekly-deadline-check.yml` "
                "(Tier 2). This workflow never merges; a human must review each date "
                "against the linked source._")
    PROPOSAL_FILE.write_text("\n".join(body) + "\n")
    print(f"Wrote {PROPOSAL_FILE.name}; data/conferences.yml updated and validated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
