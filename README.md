# BKC AI Conference & Convening Deadlines

A static, GitHub Pages–ready tracker of submission deadlines for AI-related
conferences, workshops, journals, and policy convenings relevant to internet &
society research — spanning **law, policy, computer science, social science,
and the humanities**. Maintained by the Berkman Klein Center community.

Modeled on [sec-deadlines.github.io](https://sec-deadlines.github.io/):
one data file, live countdowns, tag filters, iCal export, and a
pull-request contribution model.

**Everything on the site comes from one file: [`data/conferences.yml`](data/conferences.yml).**
To add or fix a venue, edit that file and open a pull request — see
[CONTRIBUTING.md](CONTRIBUTING.md) for the schema and a template entry.

## Features

- **Live countdowns** per deadline (days/hours/minutes/seconds), with correct
  handling of **AoE** (Anywhere on Earth, UTC−12), UTC, and named IANA timezones.
- **List and calendar views** (toggle at the top; the choice is kept in the URL
  so views can be shared). The calendar shows deadlines color-coded by topic and,
  optionally, event dates as lighter bands — a "who's convening when" view.
- **Filters** by topic, venue type, and discipline — OR within a group, AND
  across groups — persisted in the URL hash so filtered views are shareable
  (e.g. `#topic=law-regulation&type=policy-convening`).
- **iCal export** for all deadlines or per-topic subsets.
- **TBA section**: venues that haven't announced their next CFP stay visible in
  a "Deadline TBA — watch these venues" section instead of disappearing.
- Expired deadlines grey out and sort to the bottom (kept for reference).
- Validation: a malformed entry produces a readable error banner listing the bad
  entry; the rest of the site keeps working. CI (GitHub Actions) also validates
  every pull request that touches the data.

## Architecture — why plain static, no Jekyll

The whole site is `index.html` + `assets/style.css` + `assets/app.js`. The
browser fetches `data/conferences.yml`, parses it with
[js-yaml](https://github.com/nodeca/js-yaml), and does timezone math with
[Luxon](https://moment.github.io/luxon/). Both libraries are vendored into
`assets/vendor/` (≈115 KB total), so the site has no runtime dependency on any
CDN and works offline. There is **no build step at all**.

Why this over Jekyll (which GitHub Pages also supports):

- Countdowns, filtering, and the calendar are inherently client-side JavaScript
  anyway — a Jekyll build would only pre-render the initial HTML, adding a
  second place where rendering logic lives (Liquid templates *and* JS).
- With no build step, "what you push is what is served." Debugging is
  view-source simple, and local preview is one command.
- Non-developer maintainers only ever touch one YAML file; nobody needs to
  understand Ruby, Liquid, or a Gemfile.

**Why a hand-rolled calendar instead of FullCalendar:** the requirement is a
month grid with small colored entries and a popover — about 150 lines of
vanilla JS here. FullCalendar is a ~250 KB dependency with its own API,
theming system, and upgrade cadence; for non-developer maintainers, less
machinery means less to break. The grid is a plain `<table>`, which also keeps
it screen-reader friendly.

The only GitHub Action is a YAML validator for pull requests
(`.github/workflows/validate.yml`) — the site itself needs no CI. iCal files
are generated in the browser at load time (as Blob downloads), so there is no
"regenerate on push" step to maintain.

## Run it locally

Browsers block `fetch()` from `file://` pages, so serve the folder:

```bash
git clone https://github.com/joliver-commits/BKC-Conference-Tracker.git
cd BKC-Conference-Tracker
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Any static server works; Python's is just
preinstalled on most machines.

## Deploy on GitHub Pages (step by step)

1. Create a repository on GitHub (e.g. `bkc-conference-tracker` under your
   user or org) and push this code to the `main` branch.
2. On GitHub, open the repo → **Settings** → **Pages** (left sidebar).
3. Under **Build and deployment**, set **Source** to "Deploy from a branch",
   choose branch `main` and folder `/ (root)`, and click **Save**.
4. Wait a minute or two. The site appears at
   `https://<user-or-org>.github.io/<repo>/`. (The Pages settings screen shows
   the exact URL.)
5. Update the two repo links if your repo name differs: the
   "send a pull request" button and footer links in `index.html` point at
   `joliver-commits/BKC-Conference-Tracker` — search for that string and
   replace it with your `owner/repo`.

Every later push to `main` redeploys automatically. All paths in the site are
relative, so it works from a project subpath (`/repo/`) without configuration.

## Editing data going forward

- **Where:** everything lives in [`data/conferences.yml`](data/conferences.yml).
  Edit it directly on GitHub (pencil icon) — GitHub will offer to create a
  branch and open a pull request for you.
- **How:** copy the template entry in [CONTRIBUTING.md](CONTRIBUTING.md) and
  fill it in. Never guess a deadline: use `date: "TBA"` until the venue
  announces it, and add a `# VERIFY` comment on anything worth double-checking.
- **Safety net:** CI validates the file on every PR; the site also validates at
  load time and shows a readable error for a bad entry instead of going blank.

## Repository layout

```
index.html                     # the whole site (one page)
assets/style.css               # styling — clean, academic, no framework
assets/app.js                  # rendering, filters, countdowns, calendar, iCal
data/conferences.yml           # ← THE data file; the only file most edits touch
scripts/validate_yaml.py       # schema validator (run by CI, or locally)
.github/workflows/validate.yml # runs the validator on PRs
tests/                         # AoE countdown-math test (Playwright)
CONTRIBUTING.md                # schema reference + template entry
```

## Credits & license

Design closely inspired by
[sec-deadlines.github.io](https://sec-deadlines.github.io/) (security
conference deadlines). Built with js-yaml and Luxon (vendored in assets/vendor/).
Released under the [MIT License](LICENSE). Deadline data is provided
best-effort — **always confirm dates on the venue's own site.**
