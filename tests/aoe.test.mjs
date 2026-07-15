/* End-to-end test of the deadline math and page rendering.
 *
 * Loads the real site in headless Chromium (so the actual app.js code path is
 * exercised, CDN deps and all) and asserts:
 *   1. AoE ("Anywhere on Earth") is computed as UTC-12: a deadline of
 *      "2026-01-15 23:59 AoE" is the same instant as 2026-01-16T11:59Z.
 *   2. Countdown formatting counts down from the right instant.
 *   3. The page renders deadline cards and the TBA section from the YAML.
 *
 * Run (plain Node, no test framework needed):
 *   npm install playwright
 *   node tests/aoe.test.mjs
 * The script starts its own static server on :8123. If your Playwright
 * version doesn't match the installed browsers, point CHROMIUM_PATH at a
 * Chromium executable.
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 8123;
const server = spawn("python3", ["-m", "http.server", String(PORT)], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "ignore",
});

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

try {
  await new Promise((r) => setTimeout(r, 1000)); // let the server come up
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.error(`  [page] ${m.text()}`); });
  page.on("pageerror", (e) => console.error(`  [pageerror] ${e.message}`));
  page.on("requestfailed", (r) => console.error(`  [requestfailed] ${r.url()} — ${r.failure()?.errorText}`));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.BKC !== undefined, { timeout: 15000 });

  console.log("AoE timezone math:");
  const r = await page.evaluate(() => {
    const dt = BKC.parseDeadlineDate("2026-01-15 23:59", "AoE");
    const dtUTC = BKC.parseDeadlineDate("2026-01-15 23:59", "UTC");
    const dtNY = BKC.parseDeadlineDate("2026-01-15 23:59", "America/New_York");
    return {
      zone: BKC.zoneFor("AoE"),
      aoeAsUtc: dt.toUTC().toISO(),
      utcAsUtc: dtUTC.toUTC().toISO(),
      nyAsUtc: dtNY.toUTC().toISO(),
      dateOnly: BKC.parseDeadlineDate("2026-01-15", "AoE").toUTC().toISO(),
      tba: BKC.parseDeadlineDate("TBA", "AoE"),
      nominalDate: BKC.parseDeadlineDate("2026-01-15 23:59", "AoE").toISODate(),
      countdown: BKC.formatCountdown(
        luxon.DateTime.fromISO("2026-01-16T11:59:00Z"),
        luxon.DateTime.fromISO("2026-01-14T11:58:30Z"),
      ),
      expired: BKC.formatCountdown(
        luxon.DateTime.fromISO("2026-01-16T11:59:00Z"),
        luxon.DateTime.fromISO("2026-01-17T00:00:00Z"),
      ),
    };
  });
  assert(r.zone === "UTC-12", `AoE maps to UTC-12 (got ${r.zone})`);
  assert(r.aoeAsUtc === "2026-01-16T11:59:00.000Z",
    `23:59 AoE on Jan 15 == 11:59 UTC on Jan 16 (got ${r.aoeAsUtc})`);
  assert(r.utcAsUtc === "2026-01-15T23:59:00.000Z",
    `UTC zone parses as-is (got ${r.utcAsUtc})`);
  assert(r.nyAsUtc === "2026-01-16T04:59:00.000Z",
    `America/New_York (EST, UTC-5 in January) == 04:59 UTC next day (got ${r.nyAsUtc})`);
  assert(r.dateOnly === "2026-01-16T11:59:00.000Z",
    `date-only input defaults to 23:59 (got ${r.dateOnly})`);
  assert(r.tba === null, `"TBA" parses to null`);
  assert(r.nominalDate === "2026-01-15",
    `deadline keeps its nominal (CFP-printed) date for calendar placement (got ${r.nominalDate})`);
  assert(r.countdown === "2d 00h 00m 30s",
    `countdown 2 days 30s before deadline reads "2d 00h 00m 30s" (got "${r.countdown}")`);
  assert(r.expired === null, `expired deadline yields null (renders "Deadline passed")`);

  console.log("Page rendering:");
  const cards = await page.locator("#deadline-cards .card").count();
  const tba = await page.locator("#tba-cards .card").count();
  const banner = await page.locator("#error-banner").isHidden();
  assert(cards > 0, `deadline cards rendered (${cards})`);
  assert(tba > 0, `TBA section rendered (${tba} venues)`);
  assert(banner, "no validation errors from data/conferences.yml");

  const firstCountdown = await page.locator("#deadline-cards .card:not(.expired) .countdown").first().textContent();
  assert(/^\d+d \d{2}h \d{2}m \d{2}s$/.test(firstCountdown),
    `first upcoming card shows a live countdown ("${firstCountdown}")`);

  // Filters: pick the law-regulation topic and confirm it reaches the URL hash.
  await page.locator('#filter-topic input[value="law-regulation"]').check();
  const hash = await page.evaluate(() => location.hash);
  assert(hash.includes("topic=law-regulation"), `filter persisted to URL hash (${hash})`);
  await page.locator('#filter-topic input[value="law-regulation"]').uncheck();

  console.log("Output-type filter:");
  const ok = await page.evaluate(() => {
    const bucket = BKC.outputKey("extended abstracts") === "extended-abstracts"
      && BKC.outputKey("papers") === "papers"
      && BKC.outputKey("tutorials") === "other"
      && BKC.outputKey("non-archival") === "other";
    const conf = { submission_types: ["papers", "demos"] };
    const sel = (o) => ({ topic: new Set(), type: new Set(), disc: new Set(), output: new Set(o) });
    return bucket
      && BKC.matchesFilters(conf, sel(["papers"]))
      && BKC.matchesFilters(conf, sel(["other"]))          // demos → other
      && !BKC.matchesFilters(conf, sel(["posters"]))
      && BKC.matchesFilters(conf, sel([]));                // inactive group passes
  });
  assert(ok, "bucketing + OR-within-group / AND-across-groups logic");

  await page.locator('#filter-output input[value="panels"]').check();
  const outHash = await page.evaluate(() => location.hash);
  assert(outHash.includes("output=panels"), `output filter persisted to URL hash (${outHash})`);
  const panelCards = await page.evaluate(() =>
    document.querySelectorAll("#deadline-cards .card, #tba-cards .card").length);
  assert(panelCards > 0 && panelCards < 25, `output=panels narrows the list (${panelCards} cards shown)`);

  // Calendar view respects the output filter too: panels-only venues have no
  // dated deadlines in Sept 2026, list vs calendar consistency checked below.
  await page.locator("#view-calendar-btn").click();
  const calItemsFiltered = await page.locator("#cal-grid .cal-item").count();
  await page.locator('#filter-output input[value="panels"]').uncheck();
  const calItemsAll = await page.locator("#cal-grid .cal-item").count();
  assert(calItemsFiltered < calItemsAll,
    `calendar respects output filter (${calItemsFiltered} filtered < ${calItemsAll} unfiltered)`);
  await page.locator("#view-list-btn").click();

  // Calendar view renders a grid.
  await page.locator("#view-calendar-btn").click();
  const calCells = await page.locator("#cal-grid tbody td").count();
  assert(calCells >= 28, `calendar grid rendered (${calCells} cells)`);
  const calHash = await page.evaluate(() => location.hash);
  assert(calHash.includes("view=calendar"), `view persisted to URL hash (${calHash})`);

  await browser.close();
} finally {
  server.kill();
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll assertions passed.");
