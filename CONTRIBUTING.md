# Contributing

Thanks for helping keep the tracker accurate! All conference data lives in one
file: [`data/conferences.yml`](data/conferences.yml). To add or update a venue,
edit that file and open a pull request — the easiest way is the pencil (✏️)
icon on the file in GitHub, which creates the branch and PR for you.

A GitHub Action validates your change automatically; if it fails, the log
tells you exactly which entry and field to fix.

## Golden rules

1. **Never guess a deadline.** If the venue hasn't announced it, write
   `date: "TBA"` — the site shows the venue in a "Deadline TBA — watch this
   venue" section, which is far better than a wrong date.
2. **Quote TBA** (`"TBA"`) and dates (`"2027-01-18 23:59"`) so YAML treats
   them as strings.
3. If you copied a date from a cached page, mailing list, or anywhere other
   than the venue's own site, add a `# VERIFY` comment on that line so a human
   double-checks it.
4. One entry per venue *edition* (e.g. `FAccT 2027`). When a new cycle is
   announced, update the entry (or add the next edition and let the old one
   age out).

## Template entry (copy, paste, fill in)

```yaml
- name: "FAccT 2027"                    # short display name incl. year — must be unique
  full_name: "ACM Conference on Fairness, Accountability, and Transparency"
  link: "https://facctconference.org/"  # CFP page if it exists, else venue home
  location: "TBA"                       # "City, Country" or "TBA"
  event_start: "2027-06-01"             # optional — omit if unknown
  event_end: "2027-06-04"               # optional
  deadlines:                            # one item per deadline; use [] if none announced
    - label: "Abstract"                 # e.g. Abstract, Full paper, Panel proposals
      date: "2027-01-11 23:59"          # "YYYY-MM-DD HH:mm", "YYYY-MM-DD" (=23:59), or "TBA"
      timezone: "AoE"                   # AoE | UTC | IANA name (America/New_York, Europe/Brussels…)
    - label: "Full paper"
      date: "2027-01-18 23:59"
      timezone: "AoE"
  venue_type: "conference"              # see vocabulary below
  submission_types: ["papers", "posters"]
  topics: ["ai-governance-policy", "ai-ethics-society"]
  disciplines: ["cs", "law", "social-science"]
  note: "Non-archival option available."   # optional free text, shown on the card
```

## Field reference

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Short display name with year (`"CHI 2027"`). Must be unique — it seeds calendar labels and iCal event IDs. |
| `full_name` | – | Spelled-out name, shown under the title. |
| `link` | ✅ | Full URL, ideally the CFP page. |
| `location` | – | `"City, Country"` or `"TBA"`. |
| `event_start` / `event_end` | – | `YYYY-MM-DD`. Drives the light "event band" in the calendar view. Omit if unknown. |
| `deadlines` | ✅ (may be `[]`) | Each deadline renders as its own card. Multiple cycles (abstract/full paper, rolling rounds) = multiple items. |
| `deadlines[].label` | ✅ | What is due (`"Abstract"`, `"Full paper"`, `"Panel proposals"`, `"Round 2"`, …). |
| `deadlines[].date` | ✅ | `"YYYY-MM-DD HH:mm"`, `"YYYY-MM-DD"` (treated as 23:59), or `"TBA"`. |
| `deadlines[].timezone` | ✅ unless TBA | `AoE` (Anywhere on Earth = UTC−12, the academic default), `UTC`, or an IANA zone name. |
| `venue_type` | – | See vocabulary below. |
| `submission_types` | – | Free-ish list; common values below. Shown as small tags. |
| `topics` | – | Drives the topic filter, card colors, and per-topic iCal feeds. |
| `disciplines` | – | Drives the discipline filter. |
| `note` | – | One sentence of free text (typical CFP month, non-archival status, etc.). |

## Tag vocabulary

**Topics** (`topics`):
`ai-governance-policy` · `ai-ethics-society` · `law-regulation` ·
`human-ai-interaction` · `platform-internet-governance` ·
`privacy-surveillance` · `ai-relationships-companions` ·
`media-communication` · `digital-humanities` · `safety-security`

**Venue types** (`venue_type`):
`conference` · `workshop` · `policy-convening` · `journal` · `symposium`

**Disciplines** (`disciplines`):
`cs` · `law` · `policy` · `social-science` · `humanities` · `interdisciplinary`

**Common submission types** (`submission_types`, not strictly validated):
`papers` · `panels` · `posters` · `extended abstracts` · `tutorials` ·
`demos` · `non-archival` · `proposals` · `workshops`

Want a new topic tag? Open an issue or PR — tags are defined in one place in
`assets/app.js` (`TOPICS`) with a matching color in `assets/style.css`
(`--c-<tag>`), plus the allowlist in `scripts/validate_yaml.py`.

## Checking your change locally (optional)

```bash
python3 -m http.server 8000    # then open http://localhost:8000
python3 scripts/validate_yaml.py   # needs: pip install pyyaml
```

If you skip this, no problem — CI runs the same validator on your PR, and the
site shows a readable error banner (rather than breaking) if an entry is
malformed.
