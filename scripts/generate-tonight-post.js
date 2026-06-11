#!/usr/bin/env node

/**
 * Comedy Houston — Daily "Tonight in Houston" creative generator.
 *
 * Reads events.json, filters to TODAY (America/Chicago), and renders:
 *
 *   blog/tonight/tonight-YYYY-MM-DD-square.png   1080×1080 IG/FB feed image
 *   blog/tonight/tonight-YYYY-MM-DD-story.png    1080×1920 IG/FB story image
 *   blog/tonight/tonight-YYYY-MM-DD-caption.txt  templated caption
 *   blog/tonight/tonight-meta.json               handoff for post-tonight.js
 *
 * Design intent: one big promise ("TONIGHT."), then proof — the lineup.
 * Typographic, high-contrast, zero clutter. No headshots, no AI calls —
 * this has to work every single day, unattended, for free.
 *
 * Older tonight-* images are deleted so the repo doesn't grow by 2 PNGs/day
 * forever. Date-stamped filenames also mean the raw.githubusercontent.com
 * URL is brand-new each day — no CDN cache staleness when posting minutes
 * after the push.
 *
 * If nothing is on tonight, meta.json is written with count: 0 and no
 * graphics are produced — the workflow then skips the posting step.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EVENTS_PATH = path.join(ROOT, "events.json");
const TONIGHT_DIR = path.join(ROOT, "blog", "tonight");
const META_PATH = path.join(TONIGHT_DIR, "tonight-meta.json");

const MAX_GRAPHIC_ROWS = 6; // rows on the image; the rest become "+N more"
const MAX_CAPTION_ROWS = 8; // lines in the caption

// One short line a day, in the house voice: plain words, one person,
// a reason to go out tonight. Rotates by weekday so regulars don't see
// the same line twice in a row.
const TAGLINES = {
  Sunday: "Sunday sets are where comics take chances.",
  Monday: "Comedy doesn't take Mondays off. Neither should you.",
  Tuesday: "Small crowd, front row, best seat in comedy.",
  Wednesday: "Halfway through the week. Go laugh about it.",
  Thursday: "Tomorrow-you can be tired. Tonight-you is going out.",
  Friday: "You made it to Friday. Somebody's funny tonight.",
  Saturday: "Every stage in Houston is lit tonight.",
};

// ---------------------------------------------------------------------------
// Date helpers (America/Chicago — the runner's clock is UTC)
// ---------------------------------------------------------------------------

function todayInHouston() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // "YYYY-MM-DD"
}

function prettyDate(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const monthDay = d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return { weekday, monthDay };
}

// "7:30 PM" → minutes since midnight, for sorting. Null/TBA sorts last.
function timeToMinutes(t) {
  if (!t) return 24 * 60 + 1;
  const m = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return 24 * 60 + 1;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
}

function escapeHTML(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str, max) {
  const s = String(str || "").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// ---------------------------------------------------------------------------
// Tonight's lineup
// ---------------------------------------------------------------------------

// The comedy-venue feeds carry the occasional non-comedy booking (The
// Secret Group hosts dance parties; Ticketmaster's comedy classification
// leaks touring musicals). Drop the obvious ones by name, and by genre
// once fetch-events.js starts stamping it.
const NON_COMEDY_PATTERNS =
  /dance party|emo night|karaoke|trivia night|burlesque|drag brunch|open jam|wrestling|bingo/i;

function isComedyish(ev) {
  if (NON_COMEDY_PATTERNS.test(ev.name || "")) return false;
  if (ev.genre && !/comedy/i.test(ev.genre)) return false;
  return true;
}

// Trim ticket-listing noise so the graphic reads like a marquee, not a
// listings dump: age-restriction suffixes, redundant showtime tokens,
// "at <venue>" tails (the venue gets its own line).
function cleanShowName(name, venue) {
  let s = String(name || "").trim();
  s = s.replace(/\s*[-–—|]?\s*ages?\s*\d+\s*\+.*$/i, "");
  s = s.replace(/\s*[-–—|]?\s*w\/?\s*valid id.*$/i, "");
  s = s.replace(/\s*\d{1,2}(:\d{2})?\s*(am|pm)\s*show\s*$/i, "");
  if (venue) {
    const at = s.toLowerCase().lastIndexOf(` at ${venue.toLowerCase()}`);
    if (at > 0) s = s.slice(0, at);
  }
  return s.trim() || String(name || "").trim();
}

function loadTonightsEvents(today) {
  const raw = JSON.parse(fs.readFileSync(EVENTS_PATH, "utf8"));
  const events = Array.isArray(raw) ? raw : raw.events || [];

  const tonight = events.filter(
    (ev) =>
      ev.date === today &&
      ev.status !== "cancelled" &&
      ev.status !== "postponed" &&
      isComedyish(ev)
  );

  // Dedupe by name (same show can appear with minor venue-string drift)
  const seen = new Set();
  const unique = [];
  for (const ev of tonight) {
    const key = (ev.name || "").toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ev);
  }

  unique.sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
  return unique;
}

// Pick which shows make the graphic. Sorting by start time alone buries the
// biggest name of the night below the fold (a 7:30 headliner loses to five
// 6-and-7-o'clock showcases). Ticket price is no better — Eventbrite's
// price_max includes VIP table packages while Ticketmaster headliners often
// carry null. The reliable free signal is the show NAME: headliner shows
// are titled after the act ("Rob Schneider", "Tumua"), generic ones say
// "Presents" / "Showcase" / "Night". Headliner-named shows are exempt from
// the venue-spread rule (a club running two headliners is real signal);
// remaining slots fill time-first with venue spread. The final card is
// re-sorted by time so it still reads as a schedule.
const GENERIC_SHOW_WORDS =
  /\b(presents?|showcase|show|night|comedy|club|party|open mic|drinks?|best of|roast|contest|parody|touring|live at|hosted|edition|experience|jam)\b/i;

function looksLikeHeadliner(ev) {
  const name = cleanShowName(ev.name, ev.venue);
  const words = name.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 4 && !GENERIC_SHOW_WORDS.test(name);
}

function pickGraphicRows(events, n) {
  const byTime = (a, b) => timeToMinutes(a.time) - timeToMinutes(b.time);

  const headliners = events.filter(looksLikeHeadliner).sort(byTime);
  const rest = events.filter((ev) => !headliners.includes(ev)).sort(byTime);

  const picked = headliners.slice(0, n);

  const usedVenues = new Set(picked.map((ev) => (ev.venue || "").toLowerCase()));
  for (const venueSpread of [true, false]) {
    for (const ev of rest) {
      if (picked.length >= n) break;
      if (picked.includes(ev)) continue;
      const venueKey = (ev.venue || "").toLowerCase();
      if (venueSpread && usedVenues.has(venueKey)) continue;
      usedVenues.add(venueKey);
      picked.push(ev);
    }
    if (picked.length >= n) break;
  }

  picked.sort(byTime);
  return picked;
}

// ---------------------------------------------------------------------------
// Creative HTML
// ---------------------------------------------------------------------------

// Shared CSS for both formats. The design system matches the site/weekly
// hero (Inter, #0a0a0f → #16213e gradient, warm accent) so the feed looks
// like one brand. The accent gradient is the "marquee" — everything else
// stays quiet so the lineup reads in under two seconds.
function buildCreativeHTML({ width, height, rows, extraCount, weekday, monthDay, tagline, isStory }) {
  const rowItems = rows
    .map(
      (ev) => `      <div class="row">
        <div class="time">${escapeHTML(ev.time || "TBA")}</div>
        <div class="what">
          <div class="show">${escapeHTML(truncate(ev.name, isStory ? 42 : 38))}</div>
          <div class="venue">${escapeHTML(truncate(ev.venue, 40))}</div>
        </div>
      </div>`
    )
    .join("\n");

  const moreLine =
    extraCount > 0
      ? `    <div class="more">+ ${extraCount} more show${extraCount === 1 ? "" : "s"} tonight</div>`
      : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${width}px;
      height: ${height}px;
      font-family: 'Inter', sans-serif;
      background: linear-gradient(160deg, #0a0a0f 0%, #1a1a2e 55%, #16213e 100%);
      color: #f0f0f5;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      overflow: hidden;
      position: relative;
      padding: ${isStory ? "250px 80px" : "56px 76px"};
    }
    /* Soft glows so the black isn't flat */
    body::before, body::after {
      content: "";
      position: absolute;
      border-radius: 50%;
      filter: blur(120px);
      opacity: 0.35;
    }
    body::before {
      width: 700px; height: 700px;
      background: radial-gradient(circle, #ff5e62 0%, transparent 70%);
      top: -300px; right: -250px;
    }
    body::after {
      width: 600px; height: 600px;
      background: radial-gradient(circle, #6c5ce7 0%, transparent 70%);
      bottom: -250px; left: -220px;
    }
    .inner { position: relative; z-index: 1; width: 100%; display: flex; flex-direction: column; height: 100%; }
    .kicker {
      font-size: ${isStory ? 27 : 26}px;
      font-weight: 700;
      letter-spacing: 0.32em;
      text-transform: uppercase;
      color: rgba(240, 240, 245, 0.55);
      white-space: nowrap;
    }
    .headline {
      font-size: ${isStory ? 168 : 138}px;
      font-weight: 900;
      line-height: 1.0;
      letter-spacing: -0.03em;
      margin: ${isStory ? "18px 0 10px" : "10px 0 6px"};
      background: linear-gradient(90deg, #ffffff 30%, #ff9966 75%, #ff5e62 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .tagline {
      font-size: ${isStory ? 36 : 30}px;
      font-weight: 600;
      color: rgba(240, 240, 245, 0.72);
      margin-bottom: ${isStory ? 48 : 28}px;
    }
    .lineup { width: 100%; }
    .row {
      display: flex;
      align-items: center;
      gap: 32px;
      padding: ${isStory ? "24px 0" : "15px 0"};
      border-top: 1px solid rgba(255, 255, 255, 0.10);
    }
    .row:last-of-type { border-bottom: 1px solid rgba(255, 255, 255, 0.10); }
    .time {
      flex: 0 0 ${isStory ? 190 : 160}px;
      font-size: ${isStory ? 38 : 32}px;
      font-weight: 800;
      color: #ff9966;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }
    .what { min-width: 0; }
    .show {
      font-size: ${isStory ? 40 : 34}px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .venue {
      font-size: ${isStory ? 29 : 24}px;
      font-weight: 400;
      color: rgba(240, 240, 245, 0.55);
      margin-top: 3px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .more {
      font-size: ${isStory ? 32 : 26}px;
      font-weight: 700;
      color: #ff9966;
      margin-top: ${isStory ? 28 : 16}px;
    }
    .footer {
      margin-top: auto;
      padding-top: ${isStory ? 48 : 22}px;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      width: 100%;
    }
    .site {
      font-size: ${isStory ? 38 : 32}px;
      font-weight: 800;
      letter-spacing: -0.01em;
    }
    .promise {
      font-size: ${isStory ? 27 : 22}px;
      color: rgba(240, 240, 245, 0.5);
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="inner">
    <div class="kicker">Houston Comedy · ${escapeHTML(weekday)}, ${escapeHTML(monthDay)}</div>
    <div class="headline">TONIGHT.</div>
    <div class="tagline">${escapeHTML(tagline)}</div>
    <div class="lineup">
${rowItems}
    </div>
${moreLine}
    <div class="footer">
      <div class="site">comedyhouston.com</div>
      <div class="promise">every show, every night</div>
    </div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Caption
// ---------------------------------------------------------------------------

function buildCaption({ events, weekday, monthDay, tagline }) {
  const picked = pickGraphicRows(events, MAX_CAPTION_ROWS);
  const lines = picked.map((ev) => {
    const time = ev.time ? `, ${ev.time}` : "";
    return `• ${truncate(cleanShowName(ev.name, ev.venue), 60)} — ${ev.venue}${time}`;
  });
  const extra = events.length - picked.length;

  const parts = [
    tagline,
    "",
    `Tonight in Houston — ${weekday}, ${monthDay}:`,
    "",
    ...lines,
  ];
  if (extra > 0) {
    parts.push(`…plus ${extra} more on the full calendar.`);
  }
  parts.push("");
  parts.push("Every show, every night: comedyhouston.com (link in bio)");
  parts.push("");
  parts.push("#HoustonComedy #StandUp #LiveComedy #HoustonTonight #ThingsToDoInHouston");

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Screenshot (Puppeteer — same pattern as screenshot-hero.js)
// ---------------------------------------------------------------------------

const NAV_TIMEOUT_MS = 20_000;

async function screenshotHTML(html, width, height, outPath) {
  let puppeteer;
  try {
    puppeteer = require("puppeteer");
  } catch (err) {
    throw new Error(
      "puppeteer is not installed. On CI, run `npm install puppeteer` before this script."
    );
  }

  const tmpHtml = outPath.replace(/\.png$/, ".html");
  fs.writeFileSync(tmpHtml, html);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.goto(`file://${tmpHtml}`, {
      waitUntil: "networkidle0",
      timeout: NAV_TIMEOUT_MS,
    });
    await page.screenshot({ path: outPath, type: "png" });
    console.log(`  Screenshot saved: ${outPath}`);
  } finally {
    await browser.close();
    // The HTML is a build artifact, not a deliverable — don't commit it.
    try { fs.unlinkSync(tmpHtml); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // TONIGHT_DATE_OVERRIDE (YYYY-MM-DD) is for local design testing only —
  // post-tonight.js checks meta.date against the real Houston date, so an
  // overridden run can never be accidentally posted.
  const today = process.env.TONIGHT_DATE_OVERRIDE || todayInHouston();
  const { weekday, monthDay } = prettyDate(today);
  const tagline = TAGLINES[weekday] || "Live comedy, every night.";

  console.log(`=== Tonight in Houston — ${weekday}, ${monthDay} (${today}) ===\n`);

  if (!fs.existsSync(TONIGHT_DIR)) {
    fs.mkdirSync(TONIGHT_DIR, { recursive: true });
  }

  // Clean up previous days' artifacts so the repo doesn't grow forever.
  for (const f of fs.readdirSync(TONIGHT_DIR)) {
    if (/^tonight-\d{4}-\d{2}-\d{2}/.test(f) && !f.includes(today)) {
      fs.unlinkSync(path.join(TONIGHT_DIR, f));
      console.log(`  Removed stale artifact: ${f}`);
    }
  }

  const events = loadTonightsEvents(today);
  console.log(`Found ${events.length} show(s) tonight.`);
  for (const ev of events) {
    console.log(`  - ${ev.time || "TBA"}  ${ev.name}  @ ${ev.venue}`);
  }

  const meta = {
    date: today,
    weekday,
    count: events.length,
    generated_at: new Date().toISOString(),
    square: events.length > 0 ? `tonight-${today}-square.png` : null,
    story: events.length > 0 ? `tonight-${today}-story.png` : null,
    caption: events.length > 0 ? `tonight-${today}-caption.txt` : null,
  };

  if (events.length === 0) {
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + "\n");
    console.log("\nNo shows tonight — wrote empty meta, skipping graphics.");
    return;
  }

  const rows = pickGraphicRows(events, MAX_GRAPHIC_ROWS).map((ev) => ({
    ...ev,
    name: cleanShowName(ev.name, ev.venue),
  }));
  const extraCount = events.length - rows.length;

  console.log("\nRendering square (1080×1080)…");
  const squareHTML = buildCreativeHTML({
    width: 1080, height: 1080, rows, extraCount, weekday, monthDay, tagline, isStory: false,
  });
  await screenshotHTML(squareHTML, 1080, 1080, path.join(TONIGHT_DIR, meta.square));

  console.log("Rendering story (1080×1920)…");
  const storyHTML = buildCreativeHTML({
    width: 1080, height: 1920, rows, extraCount, weekday, monthDay, tagline, isStory: true,
  });
  await screenshotHTML(storyHTML, 1080, 1920, path.join(TONIGHT_DIR, meta.story));

  const caption = buildCaption({ events, weekday, monthDay, tagline });
  fs.writeFileSync(path.join(TONIGHT_DIR, meta.caption), caption + "\n");
  console.log(`Caption written (${caption.length} chars).`);

  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + "\n");
  console.log(`Meta written → ${META_PATH}`);
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
