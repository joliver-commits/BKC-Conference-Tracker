/* BKC Conference Deadlines — all client-side logic.
 *
 * Data flow: fetch data/conferences.yml → parse (js-yaml) → validate →
 * flatten into one "deadline item" per (conference, deadline) pair →
 * render list view, TBA section, calendar view, and iCal exports.
 *
 * Depends on two CDN globals loaded in index.html:
 *   jsyaml (YAML parsing) and luxon (timezone-correct date math).
 */
"use strict";

const { DateTime } = luxon;

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

const TOPICS = {
  "ai-governance-policy": "AI governance & policy",
  "ai-ethics-society": "AI ethics & society",
  "law-regulation": "Law & regulation",
  "human-ai-interaction": "Human–AI interaction",
  "platform-internet-governance": "Platform & internet governance",
  "privacy-surveillance": "Privacy & surveillance",
  "ai-relationships-companions": "AI relationships & companions",
  "media-communication": "Media & communication",
  "digital-humanities": "Digital humanities",
  "safety-security": "Safety & security",
};

const VENUE_TYPES = {
  "conference": "Conference",
  "workshop": "Workshop",
  "policy-convening": "Policy convening",
  "journal": "Journal",
  "symposium": "Symposium",
};

const DISCIPLINES = {
  "cs": "Computer science",
  "law": "Law",
  "policy": "Policy",
  "social-science": "Social science",
  "humanities": "Humanities",
  "interdisciplinary": "Interdisciplinary",
};

/* Output-type filter buckets. submission_types is free-ish text in the YAML;
 * the six buckets below drive the "Output type" filter group. Rare values
 * (tutorials, demos, non-archival, proposals, presentations, …) bucket into
 * "other" for filtering, but cards and popovers always show the exact values. */
const OUTPUT_TYPES = {
  "papers": "Papers",
  "panels": "Panels",
  "posters": "Posters",
  "extended-abstracts": "Extended abstracts",
  "workshops": "Workshops",
  "other": "Other",
};

/* Normalize a submission_types value to its filter bucket. */
function outputKey(value) {
  const s = String(value).trim().toLowerCase().replace(/\s+/g, "-");
  return s in OUTPUT_TYPES && s !== "other" ? s : "other";
}

function outputKeysFor(conf) {
  return (conf.submission_types || []).map(outputKey);
}

/* Topic → CSS color (matches --c-* custom properties in style.css). */
function topicColor(topic) {
  const style = getComputedStyle(document.documentElement);
  const v = style.getPropertyValue(`--c-${topic}`).trim();
  return v || "#666666";
}

/* ------------------------------------------------------------------ */
/* Timezone / countdown math                                           */
/* ------------------------------------------------------------------ */

/* Map a schema timezone string to a Luxon zone specifier.
 * "AoE" (Anywhere on Earth) is defined as UTC−12: a deadline has not
 * passed as long as it is still that date *somewhere* on Earth. */
function zoneFor(tz) {
  if (!tz) return null;
  const t = String(tz).trim();
  if (/^aoe$/i.test(t)) return "UTC-12";
  if (/^utc$/i.test(t)) return "UTC";
  return t; // assume IANA name, e.g. "America/New_York"
}

/* Parse "YYYY-MM-DD HH:mm" or "YYYY-MM-DD" (assumed end of day 23:59)
 * in the given schema timezone. Returns a Luxon DateTime or null. */
function parseDeadlineDate(dateStr, tz) {
  if (!dateStr || String(dateStr).trim().toUpperCase() === "TBA") return null;
  const zone = zoneFor(tz) || "UTC-12"; // default to AoE, the academic norm
  const s = String(dateStr).trim();
  let dt = DateTime.fromFormat(s, "yyyy-MM-dd HH:mm", { zone });
  if (!dt.isValid) dt = DateTime.fromFormat(s + " 23:59", "yyyy-MM-dd HH:mm", { zone });
  return dt.isValid ? dt : null;
}

function formatCountdown(dt, now) {
  const diff = dt.diff(now, ["days", "hours", "minutes", "seconds"]);
  if (diff.as("seconds") <= 0) return null; // expired
  const d = Math.floor(diff.days);
  const pad = (n) => String(Math.floor(n)).padStart(2, "0");
  return `${d}d ${pad(diff.hours)}h ${pad(diff.minutes)}m ${pad(diff.seconds)}s`;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/* Validate raw YAML entries. Returns { entries, problems }.
 * Entries with fatal problems are excluded (and reported); minor issues
 * (unknown tags) are reported as warnings but the entry is kept, so one
 * bad PR never blanks the whole site. */
function validateEntries(raw) {
  const problems = [];
  const entries = [];
  if (!Array.isArray(raw)) {
    problems.push("Top level of data/conferences.yml must be a list of entries (each starting with “- name: …”).");
    return { entries, problems };
  }
  raw.forEach((e, i) => {
    const where = `Entry ${i + 1}${e && e.name ? ` (“${e.name}”)` : ""}`;
    if (!e || typeof e !== "object") { problems.push(`${where}: not a mapping — check indentation.`); return; }
    if (!e.name) { problems.push(`${where}: missing required field “name”.`); return; }
    if (!e.link) { problems.push(`${where}: missing required field “link”.`); return; }
    if (e.venue_type && !VENUE_TYPES[e.venue_type]) {
      problems.push(`${where}: unknown venue_type “${e.venue_type}” (allowed: ${Object.keys(VENUE_TYPES).join(", ")}).`);
    }
    (e.topics || []).forEach((t) => {
      if (!TOPICS[t]) problems.push(`${where}: unknown topic tag “${t}”.`);
    });
    (e.disciplines || []).forEach((d) => {
      if (!DISCIPLINES[d]) problems.push(`${where}: unknown discipline “${d}”.`);
    });
    const deadlines = Array.isArray(e.deadlines) ? e.deadlines : [];
    deadlines.forEach((dl, j) => {
      if (!dl || typeof dl !== "object" || !dl.label) {
        problems.push(`${where}, deadline ${j + 1}: each deadline needs a “label”.`);
        return;
      }
      const isTba = !dl.date || String(dl.date).trim().toUpperCase() === "TBA";
      if (!isTba && !parseDeadlineDate(dl.date, dl.timezone)) {
        problems.push(`${where}, deadline “${dl.label}”: cannot parse date “${dl.date}” with timezone “${dl.timezone || "(none)"}”. Use “YYYY-MM-DD HH:mm” and AoE/UTC/an IANA zone name.`);
      }
    });
    entries.push(e);
  });
  return { entries, problems };
}

/* ------------------------------------------------------------------ */
/* Data shaping                                                        */
/* ------------------------------------------------------------------ */

/* Flatten conferences into per-deadline items, plus a TBA bucket. */
function buildItems(entries) {
  const dated = [];
  const tba = []; // { conf, labels: [...] }
  entries.forEach((conf) => {
    const deadlines = Array.isArray(conf.deadlines) ? conf.deadlines : [];
    const tbaLabels = [];
    deadlines.forEach((dl) => {
      const dt = parseDeadlineDate(dl.date, dl.timezone);
      if (dt) {
        dated.push({ conf, deadline: dl, dt });
      } else {
        tbaLabels.push(dl.label || "Submissions");
      }
    });
    if (deadlines.length === 0 || tbaLabels.length > 0) {
      tba.push({ conf, labels: tbaLabels });
    }
  });
  return { dated, tba };
}

function matchesFilters(conf, sel) {
  const groups = [
    [sel.topic, conf.topics || []],
    [sel.type, conf.venue_type ? [conf.venue_type] : []],
    [sel.disc, conf.disciplines || []],
    [sel.output, outputKeysFor(conf)],
  ];
  return groups.every(([selected, values]) => {
    if (selected.size === 0) return true;            // group inactive → all pass
    return values.some((v) => selected.has(v));      // OR within group
  });                                                // AND across groups
}

/* ------------------------------------------------------------------ */
/* URL hash state                                                      */
/* ------------------------------------------------------------------ */

const state = {
  view: "list",                 // "list" | "calendar"
  topic: new Set(),
  type: new Set(),
  disc: new Set(),
  output: new Set(),
  month: null,                  // "yyyy-MM" or null = current month
  showEvents: true,
};

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  state.view = params.get("view") === "calendar" ? "calendar" : "list";
  const setFrom = (key, vocab) =>
    new Set((params.get(key) || "").split(",").filter((v) => vocab[v]));
  state.topic = setFrom("topic", TOPICS);
  state.type = setFrom("type", VENUE_TYPES);
  state.disc = setFrom("disc", DISCIPLINES);
  state.output = setFrom("output", OUTPUT_TYPES);
  const m = params.get("month");
  state.month = m && /^\d{4}-\d{2}$/.test(m) ? m : null;
  state.showEvents = params.get("events") !== "0";
}

function writeHash() {
  const params = new URLSearchParams();
  if (state.view !== "list") params.set("view", state.view);
  if (state.topic.size) params.set("topic", [...state.topic].join(","));
  if (state.type.size) params.set("type", [...state.type].join(","));
  if (state.disc.size) params.set("disc", [...state.disc].join(","));
  if (state.output.size) params.set("output", [...state.output].join(","));
  if (state.month) params.set("month", state.month);
  if (!state.showEvents) params.set("events", "0");
  const h = params.toString();
  history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
}

/* ------------------------------------------------------------------ */
/* Rendering: shared bits                                              */
/* ------------------------------------------------------------------ */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c);
  }
  return node;
}

function tagPills(conf) {
  const wrap = el("p", { class: "tags" });
  (conf.topics || []).forEach((t) => {
    if (!TOPICS[t]) return;
    const pill = el("span", { class: "tag tag-topic" }, TOPICS[t]);
    pill.style.setProperty("--tag-color", topicColor(t));
    wrap.append(pill);
  });
  if (conf.venue_type && VENUE_TYPES[conf.venue_type]) {
    wrap.append(el("span", { class: "tag" }, VENUE_TYPES[conf.venue_type]));
  }
  (conf.disciplines || []).forEach((d) => {
    if (DISCIPLINES[d]) wrap.append(el("span", { class: "tag" }, DISCIPLINES[d]));
  });
  (conf.submission_types || []).forEach((s) => {
    wrap.append(el("span", { class: "tag" }, s));
  });
  return wrap;
}

function whenWhereText(conf) {
  const parts = [];
  if (conf.event_start) {
    const start = DateTime.fromISO(String(conf.event_start));
    const end = conf.event_end ? DateTime.fromISO(String(conf.event_end)) : null;
    if (start.isValid) {
      parts.push(end && end.isValid
        ? `${start.toFormat("LLL d")} – ${end.toFormat("LLL d, yyyy")}`
        : start.toFormat("LLL d, yyyy"));
    }
  }
  if (conf.location && String(conf.location).toUpperCase() !== "TBA") parts.push(conf.location);
  else if (conf.location) parts.push("Location TBA");
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ */
/* Rendering: list view                                                */
/* ------------------------------------------------------------------ */

function renderList(items, tbaBucket) {
  const now = DateTime.now();
  const container = document.getElementById("deadline-cards");
  container.replaceChildren();

  const visible = items.filter((it) => matchesFilters(it.conf, state));
  const upcoming = visible.filter((it) => it.dt > now).sort((a, b) => a.dt - b.dt);
  const expired = visible.filter((it) => it.dt <= now).sort((a, b) => b.dt - a.dt);

  if (visible.length === 0) {
    container.append(el("p", { class: "no-results" },
      "No deadlines match the current filters. Try clearing a filter group."));
  }

  [...upcoming, ...expired].forEach((it) => {
    const { conf, deadline, dt } = it;
    const isPast = dt <= now;
    const card = el("article", { class: "card" + (isPast ? " expired" : "") });
    const mainTopic = (conf.topics || [])[0];
    if (mainTopic) card.style.setProperty("--topic-color", topicColor(mainTopic));

    card.append(
      el("h3", {},
        el("a", { href: conf.link, rel: "noopener" }, conf.name),
        " ",
        el("span", { class: "deadline-label" }, `— ${deadline.label}`)),
      conf.full_name ? el("p", { class: "full-name" }, conf.full_name) : null,
      el("p", { class: "when-where" }, whenWhereText(conf)),
      conf.note || deadline.note
        ? el("p", { class: "note" }, [conf.note, deadline.note].filter(Boolean).join(" "))
        : null,
      tagPills(conf),
    );

    const box = el("div", { class: "countdown-box" });
    const cd = el("div", { class: "countdown", "data-deadline": dt.toISO() },
      isPast ? "Deadline passed" : (formatCountdown(dt, now) || "Deadline passed"));
    const tzLabel = /^aoe$/i.test(String(deadline.timezone || "")) ? "AoE" : (deadline.timezone || "AoE");
    box.append(cd, el("div", { class: "deadline-date" },
      `${dt.toFormat("EEE, LLL d yyyy, HH:mm")} ${tzLabel}`));
    card.append(box);
    container.append(card);
  });

  // TBA section
  const tbaContainer = document.getElementById("tba-cards");
  tbaContainer.replaceChildren();
  const tbaVisible = tbaBucket.filter((t) => matchesFilters(t.conf, state));
  document.getElementById("tba-heading").hidden = tbaVisible.length === 0;
  document.querySelector(".section-note").hidden = tbaVisible.length === 0;
  tbaVisible.forEach(({ conf, labels }) => {
    const card = el("article", { class: "card tba" });
    const mainTopic = (conf.topics || [])[0];
    if (mainTopic) card.style.setProperty("--topic-color", topicColor(mainTopic));
    card.append(
      el("h3", {}, el("a", { href: conf.link, rel: "noopener" }, conf.name)),
      conf.full_name ? el("p", { class: "full-name" }, conf.full_name) : null,
      el("p", { class: "when-where" }, whenWhereText(conf)),
      conf.note ? el("p", { class: "note" }, conf.note) : null,
      tagPills(conf),
    );
    const box = el("div", { class: "countdown-box" });
    box.append(el("div", { class: "countdown" }, "TBA"),
      el("div", { class: "deadline-date" },
        labels.length ? labels.join(", ") : "CFP not yet announced"));
    card.append(box);
    tbaContainer.append(card);
  });
}

/* Tick all visible countdowns once a second (list view only). */
function tick() {
  const now = DateTime.now();
  document.querySelectorAll(".countdown[data-deadline]").forEach((node) => {
    const dt = DateTime.fromISO(node.dataset.deadline);
    const text = formatCountdown(dt, now);
    if (text) {
      node.textContent = text;
    } else if (node.textContent !== "Deadline passed") {
      node.textContent = "Deadline passed";
      render(); // re-sort: the item just expired
    }
  });
}

/* ------------------------------------------------------------------ */
/* Rendering: calendar view                                            */
/* ------------------------------------------------------------------ */

function currentMonth() {
  return state.month
    ? DateTime.fromFormat(state.month + "-01", "yyyy-MM-dd")
    : DateTime.now().startOf("month");
}

function renderCalendar(items, entries) {
  const now = DateTime.now();
  const month = currentMonth().startOf("month");
  document.getElementById("cal-title").textContent = month.toFormat("LLLL yyyy");

  const tbody = document.querySelector("#cal-grid tbody");
  tbody.replaceChildren();
  closePopover();

  const visibleItems = items.filter((it) => matchesFilters(it.conf, state));
  const visibleConfs = entries.filter((c) => matchesFilters(c, state));

  // Deadlines keyed by their *nominal* date — the date printed in the CFP
  // (i.e. in the deadline's own timezone), not the viewer-local conversion,
  // so a "Sep 10 AoE" deadline appears on Sep 10.
  const byDate = new Map();
  visibleItems.forEach((it) => {
    const key = it.dt.toISODate();
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(it);
  });

  // Event ranges (conference in session), if toggled on.
  const events = [];
  if (state.showEvents) {
    visibleConfs.forEach((conf) => {
      if (!conf.event_start) return;
      const start = DateTime.fromISO(String(conf.event_start));
      if (!start.isValid) return;
      const endRaw = conf.event_end ? DateTime.fromISO(String(conf.event_end)) : start;
      const end = endRaw.isValid ? endRaw : start;
      events.push({ conf, start: start.startOf("day"), end: end.endOf("day") });
    });
  }

  // Monday-first grid covering the whole month.
  let cursor = month.startOf("week"); // luxon weeks start Monday
  const gridEnd = month.endOf("month").endOf("week");
  while (cursor <= gridEnd) {
    const row = el("tr");
    for (let i = 0; i < 7; i++) {
      const day = cursor;
      const inMonth = day.month === month.month;
      const td = el("td", {
        class: (inMonth ? "" : "other-month ") + (day.hasSame(now, "day") ? "today" : ""),
      });
      td.append(el("span", { class: "cal-daynum" }, String(day.day)));

      // Deadline entries
      (byDate.get(day.toISODate()) || [])
        .sort((a, b) => a.dt - b.dt)
        .forEach((it) => {
          const past = it.dt <= now;
          const btn = el("button", {
            type: "button",
            class: "cal-item" + (past ? " past" : ""),
            title: `${it.conf.name} — ${it.deadline.label}`,
            onclick: (ev) => openPopover(ev.currentTarget, it),
          }, it.conf.name);
          const mainTopic = (it.conf.topics || [])[0];
          if (!past && mainTopic) btn.style.setProperty("--item-color", topicColor(mainTopic));
          td.append(btn);
        });

      // Event bands (conference in session)
      events.forEach((evt) => {
        if (day >= evt.start && day <= evt.end) {
          td.append(el("button", {
            type: "button",
            class: "cal-item event-band",
            title: `${evt.conf.name} (event)`,
            onclick: (e) => openPopover(e.currentTarget, { conf: evt.conf, event: evt }),
          }, `▹ ${evt.conf.name}`));
        }
      });

      row.append(td);
      cursor = cursor.plus({ days: 1 });
    }
    tbody.append(row);
  }
}

function openPopover(anchor, it) {
  const pop = document.getElementById("cal-popover");
  pop.replaceChildren();
  const { conf } = it;
  pop.append(el("button", {
    type: "button", class: "popover-close", "aria-label": "Close", onclick: closePopover,
  }, "×"));
  pop.append(el("h3", {}, conf.name));
  if (conf.full_name) pop.append(el("p", {}, conf.full_name));
  if (it.deadline) {
    const now = DateTime.now();
    const cdText = formatCountdown(it.dt, now);
    const tzLabel = /^aoe$/i.test(String(it.deadline.timezone || "")) ? "AoE" : (it.deadline.timezone || "AoE");
    pop.append(
      el("p", {}, el("strong", {}, it.deadline.label), ` — ${it.dt.toFormat("EEE, LLL d yyyy, HH:mm")} ${tzLabel}`),
      el("p", {}, cdText ? `⏳ ${cdText}` : "Deadline passed"),
    );
  } else if (it.event) {
    pop.append(el("p", {},
      `Event: ${it.event.start.toFormat("LLL d")} – ${it.event.end.toFormat("LLL d, yyyy")}`,
      conf.location ? ` · ${conf.location}` : ""));
  }
  if (conf.submission_types && conf.submission_types.length) {
    pop.append(el("p", { class: "popover-outputs" },
      "Accepts: " + conf.submission_types.join(" · ")));
  }
  if (conf.note) pop.append(el("p", { class: "note" }, conf.note));
  pop.append(el("p", {}, el("a", { href: conf.link, rel: "noopener" }, "Open CFP / venue site →")));

  pop.hidden = false;
  const rect = anchor.getBoundingClientRect();
  pop.style.top = `${rect.bottom + window.scrollY + 4}px`;
  pop.style.left = `${Math.min(rect.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 12)}px`;
  pop.querySelector(".popover-close").focus();
}

function closePopover() {
  const pop = document.getElementById("cal-popover");
  if (pop) { pop.hidden = true; pop.replaceChildren(); }
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopover(); });
document.addEventListener("click", (e) => {
  const pop = document.getElementById("cal-popover");
  if (pop && !pop.hidden && !pop.contains(e.target) && !e.target.closest(".cal-item")) closePopover();
});

/* ------------------------------------------------------------------ */
/* iCal export                                                         */
/* ------------------------------------------------------------------ */

function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function buildIcs(items, calName) {
  const stamp = DateTime.utc().toFormat("yyyyMMdd'T'HHmmss'Z'");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Berkman Klein Center community//BKC Conference Deadlines//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${icsEscape(calName)}`,
  ];
  items.forEach(({ conf, deadline, dt }) => {
    const utc = dt.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
    const uid = `${conf.name}-${deadline.label}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}@bkc-conference-deadlines`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${utc}`,
      `DTEND:${utc}`,
      `SUMMARY:${icsEscape(`${conf.name}: ${deadline.label} deadline`)}`,
      `DESCRIPTION:${icsEscape(`${conf.full_name || conf.name}\n${deadline.label} deadline (${deadline.timezone || "AoE"})\n${conf.link}`)}`,
      `URL:${icsEscape(conf.link)}`,
      "END:VEVENT",
    );
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function setupExports(items) {
  const mk = (icsText) =>
    URL.createObjectURL(new Blob([icsText], { type: "text/calendar" }));

  document.getElementById("ics-all").href =
    mk(buildIcs(items, "BKC AI Conference Deadlines — all"));

  const list = document.getElementById("ics-topic-list");
  list.replaceChildren();
  Object.entries(TOPICS).forEach(([slug, label]) => {
    const subset = items.filter((it) => (it.conf.topics || []).includes(slug));
    if (subset.length === 0) return;
    const a = el("a", {
      href: mk(buildIcs(subset, `BKC Deadlines — ${label}`)),
      download: `bkc-deadlines-${slug}.ics`,
    }, `${label} (${subset.length})`);
    list.append(el("li", {}, a));
  });
}

/* ------------------------------------------------------------------ */
/* Filters UI                                                          */
/* ------------------------------------------------------------------ */

function buildFilterGroup(containerId, vocab, stateSet, withDots) {
  const box = document.querySelector(`#${containerId} .checkbox-list`);
  box.replaceChildren();
  Object.entries(vocab).forEach(([slug, label]) => {
    const input = el("input", { type: "checkbox", value: slug });
    input.checked = stateSet.has(slug);
    input.addEventListener("change", () => {
      if (input.checked) stateSet.add(slug); else stateSet.delete(slug);
      writeHash();
      render();
    });
    const lab = el("label", {});
    if (withDots) {
      const dot = el("span", { class: "topic-dot", "aria-hidden": "true" });
      dot.style.background = topicColor(slug);
      lab.append(input, dot, label);
    } else {
      lab.append(input, label);
    }
    box.append(lab);
  });
}

function syncFilterInputs() {
  const groups = [["filter-topic", state.topic], ["filter-type", state.type],
    ["filter-disc", state.disc], ["filter-output", state.output]];
  groups.forEach(([id, set]) => {
    document.querySelectorAll(`#${id} input`).forEach((i) => { i.checked = set.has(i.value); });
  });
}

/* ------------------------------------------------------------------ */
/* View switching + main render                                        */
/* ------------------------------------------------------------------ */

let DATA = { dated: [], tba: [], entries: [] };

function render() {
  const isCal = state.view === "calendar";
  document.getElementById("list-view").hidden = isCal;
  document.getElementById("calendar-view").hidden = !isCal;
  document.getElementById("view-list-btn").setAttribute("aria-pressed", String(!isCal));
  document.getElementById("view-calendar-btn").setAttribute("aria-pressed", String(isCal));
  if (isCal) renderCalendar(DATA.dated, DATA.entries);
  else renderList(DATA.dated, DATA.tba);
}

function setView(view) {
  state.view = view;
  writeHash();
  render();
}

function shiftMonth(delta) {
  const m = delta === 0 ? DateTime.now().startOf("month") : currentMonth().plus({ months: delta });
  state.month = m.hasSame(DateTime.now(), "month") ? null : m.toFormat("yyyy-MM");
  writeHash();
  render();
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function showErrors(problems) {
  const banner = document.getElementById("error-banner");
  if (!problems.length) { banner.hidden = true; return; }
  banner.replaceChildren(
    el("h2", {}, "⚠ Some entries in data/conferences.yml need attention"),
    el("ul", {}, ...problems.map((p) => el("li", {}, p))),
    el("p", {}, "Valid entries are still shown below. See CONTRIBUTING.md for the schema."),
  );
  banner.hidden = false;
}

async function boot() {
  readHash();
  buildFilterGroup("filter-topic", TOPICS, state.topic, true);
  buildFilterGroup("filter-type", VENUE_TYPES, state.type, false);
  buildFilterGroup("filter-disc", DISCIPLINES, state.disc, false);
  buildFilterGroup("filter-output", OUTPUT_TYPES, state.output, false);

  document.getElementById("view-list-btn").addEventListener("click", () => setView("list"));
  document.getElementById("view-calendar-btn").addEventListener("click", () => setView("calendar"));
  document.getElementById("cal-prev").addEventListener("click", () => shiftMonth(-1));
  document.getElementById("cal-next").addEventListener("click", () => shiftMonth(+1));
  document.getElementById("cal-today").addEventListener("click", () => shiftMonth(0));
  document.getElementById("cal-show-events").addEventListener("change", (e) => {
    state.showEvents = e.target.checked;
    writeHash();
    render();
  });
  document.getElementById("clear-filters").addEventListener("click", () => {
    state.topic.clear(); state.type.clear(); state.disc.clear(); state.output.clear();
    syncFilterInputs();
    writeHash();
    render();
  });
  window.addEventListener("hashchange", () => {
    readHash();
    syncFilterInputs();
    document.getElementById("cal-show-events").checked = state.showEvents;
    render();
  });
  document.getElementById("cal-show-events").checked = state.showEvents;

  let text;
  try {
    const resp = await fetch("data/conferences.yml", { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const lastMod = resp.headers.get("Last-Modified");
    document.getElementById("last-updated").textContent = "Last updated: " +
      (lastMod ? DateTime.fromHTTP(lastMod).toFormat("LLL d, yyyy") : "see repository");
    text = await resp.text();
  } catch (err) {
    showErrors([`Could not load data/conferences.yml (${err.message}). If you are viewing this locally, serve the folder with “python3 -m http.server” — opening index.html directly from disk blocks fetch().`]);
    return;
  }

  let raw;
  try {
    raw = jsyaml.load(text);
  } catch (err) {
    showErrors([`YAML syntax error in data/conferences.yml: ${err.message}`]);
    return;
  }

  const { entries, problems } = validateEntries(raw);
  showErrors(problems);

  const { dated, tba } = buildItems(entries);
  DATA = { dated, tba, entries };

  const upcoming = dated.filter((it) => it.dt > DateTime.now()).length;
  document.getElementById("entry-count").textContent =
    `${entries.length} venues · ${upcoming} upcoming deadlines`;

  setupExports(dated.filter((it) => it.dt > DateTime.now()));
  render();
  setInterval(tick, 1000);
}

/* Expose internals for testing (tests/ drives these via Playwright). */
window.BKC = { zoneFor, parseDeadlineDate, formatCountdown, validateEntries, buildItems, matchesFilters, buildIcs, outputKey, outputKeysFor, TOPICS, VENUE_TYPES, DISCIPLINES, OUTPUT_TYPES };

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
