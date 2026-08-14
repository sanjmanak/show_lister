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
 * Design intent: an OPEN LOOP, not a schedule. The graphic leads with the
 * number of shows, adds one data-derived hook line, teases a handful of
 * rows, and names what it is withholding ("+ 7 more, with prices &
 * tickets"). The old six-row card answered the question in-feed, so nobody
 * clicked; the count plus a partial list implies a list worth opening.
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

const MAX_GRAPHIC_ROWS = 4; // rows on the image; the rest become "+N more"
const MAX_CAPTION_ROWS = 3; // lines in the caption

// Comment-to-DM keyword (e.g. "TONIGHT"). Empty = the line is omitted.
// Only set this once an auto-DM tool is actually wired up — an unattended
// cron job can't answer the comments the prompt invites.
const DM_KEYWORD = (process.env.TONIGHT_DM_KEYWORD || "").trim();

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

// Genre is a DENY-list signal only. Requiring /comedy/ used to silently drop
// every Ticketmaster headliner filed under "Miscellaneous" or "Theatre" —
// Mark Normand, Jay Pharoah, Jo Koy, Kill Tony — i.e. exactly the names that
// stop a scroll, and it understated the nightly count too. Both feeds are
// already scoped to comedy upstream, so anything that isn't explicitly
// another segment stays in.
const NON_COMEDY_GENRES = /^(music|sports|film|family|fair|festival)$/i;

function isComedyish(ev) {
  if (NON_COMEDY_PATTERNS.test(ev.name || "")) return false;
  if (ev.genre && NON_COMEDY_GENRES.test(String(ev.genre).trim())) return false;
  return true;
}

// Trim ticket-listing noise so the graphic reads like a marquee, not a
// listings dump: age-restriction suffixes, redundant showtime tokens,
// "at <venue>" tails (the venue gets its own line).
function cleanShowName(name, venue) {
  const original = String(name || "").trim();
  let s = original;
  s = s.replace(/\s*[-–—|]?\s*ages?\s*\d+\s*\+.*$/i, "");
  s = s.replace(/\s*[-–—|]?\s*w\/?\s*valid id.*$/i, "");
  s = s.replace(/\s*\d{1,2}(:\d{2})?\s*(am|pm)\s*show\s*$/i, "");

  // Drop a trailing venue name however it's attached — "at The Den",
  // "en Den Comedy Club", "Headlines The Riot Comedy Club". The venue gets
  // its own line underneath, so repeating it here just burns the character
  // budget and forces a mid-word ellipsis on the card.
  if (venue) {
    const v = String(venue).trim().replace(/^the\s+/i, "");
    if (v.length >= 4) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      s = s.replace(
        new RegExp(
          `\\s*(?:[-–—|,:]\\s*)?(?:live\\s+)?(?:at|in|en|@|headlin(?:es|ing)|presents?)?\\s*(?:the\\s+)?${escaped}\\s*$`,
          "i"
        ),
        ""
      );
    }
  }

  // Trailing showtime token ("… Comedy Showcase 8pm") and any connector or
  // punctuation left dangling by the strips above.
  s = s.replace(/\s*[-–—|,:]?\s*\d{1,2}(:\d{2})?\s*(am|pm)\s*$/i, "");
  s = s.replace(/\s*(?:at|in|en|with|w\/|presents?|headlines?|live)\s*$/i, "");
  s = s.replace(/\s*[-–—|,:·]\s*$/, "").replace(/\s{2,}/g, " ");

  return s.trim() || original;
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
// Open-loop helpers — what the card shows vs. what it holds back
// ---------------------------------------------------------------------------

/**
 * How many rows to print. The card must ALWAYS hold something back, so a
 * thin night (4 shows) doesn't get a card listing all four — that closes
 * the loop and there is nothing left to click for. Below 4 total there is
 * no useful teaser left; show them all and let the CTA sell prices instead.
 */
function rowCountFor(total) {
  if (total <= 3) return total;
  if (total <= 5) return Math.max(2, total - 2);
  return MAX_GRAPHIC_ROWS;
}

// Cheapest ticket is quoted rounded UP: price_min carries cents (Eventbrite
// returns 27.06), and a quoted price must never undercut the real one.
function money(n) {
  return `$${Math.ceil(n)}`;
}

/**
 * One line under the headline, derived from tonight's data — the reason to
 * open the list rather than admire the graphic. Ordered strongest first;
 * falls back to the weekday tagline when the night has no stand-out fact.
 *
 * "Free" is strictly price_min === 0. A null price means UNKNOWN (most
 * Ticketmaster rows are null) and must never be advertised as free.
 */
function buildHook(events, tagline) {
  const free = events.filter((ev) => ev.price_min === 0).length;
  const venues = new Set(
    events.map((ev) => (ev.venue || "").toLowerCase().trim()).filter(Boolean)
  ).size;
  const paidPrices = events
    .map((ev) => ev.price_min)
    .filter((p) => typeof p === "number" && p > 0);
  const cheapest = paidPrices.length > 0 ? Math.min(...paidPrices) : null;

  // Both free rules must outrank the price rule: quoting "cheapest ticket:
  // $8" on a night that has a free show is simply false.
  if (free >= 2) return `${free} of them are free.`;
  if (free === 1) return "One of them is free.";
  if (cheapest !== null && cheapest <= 30) return `Cheapest ticket: ${money(cheapest)}.`;
  if (venues >= 4) return `${venues} venues. One list.`;
  return tagline;
}

/**
 * The call to action — names the withheld value explicitly. "+N more shows"
 * on its own withheld nothing anyone wanted; prices and ticket availability
 * are the things the card genuinely cannot carry.
 */
function buildCta(extraCount) {
  if (extraCount <= 0) return "Prices, tickets & tomorrow's lineup →";
  return `+ ${extraCount} more, with prices & tickets →`;
}

// ---------------------------------------------------------------------------
// Creative HTML
// ---------------------------------------------------------------------------

// Shared CSS for both formats. The design system matches the site/weekly
// hero (Inter, #0a0a0f → #16213e gradient, warm accent) so the feed looks
// like one brand. The accent gradient is the "marquee" — everything else
// stays quiet so the lineup reads in under two seconds.
function buildCreativeHTML({ width, height, rows, total, extraCount, weekday, monthDay, hook, isStory }) {
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

  const ctaLine = `    <div class="cta">${escapeHTML(buildCta(extraCount))}</div>`;

  // Stories can carry a tappable link sticker, but the Content Publishing
  // API cannot place one — it has to be dropped on by hand. The band is
  // deliberately empty so there is somewhere obvious to put it, and the
  // arrow line below points at it.
  // Kept in the lower third, where link stickers actually get placed and
  // where the thumb already is.
  const stickerBand = isStory ? `    <div class="sticker-band"></div>` : "";
  const tapLine = isStory
    ? `    <div class="tap">TAP THE LINK FOR ALL ${total} &nbsp;↓</div>`
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
    /* The count IS the hook — it implies a list the image can't hold.
       "TONIGHT." keeps the gradient so the post is still recognisable
       at grid size. */
    .headline {
      font-weight: 900;
      line-height: 0.94;
      letter-spacing: -0.03em;
      margin: ${isStory ? "16px 0 12px" : "8px 0 8px"};
      background: linear-gradient(90deg, #ffffff 30%, #ff9966 75%, #ff5e62 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .count { font-size: ${isStory ? 168 : 128}px; }
    .unit  { font-size: ${isStory ? 104 : 82}px; letter-spacing: -0.01em; }
    .tonight { display: block; font-size: ${isStory ? 150 : 116}px; }
    .hook {
      font-size: ${isStory ? 40 : 33}px;
      font-weight: 700;
      color: #ff9966;
      margin-bottom: ${isStory ? 40 : 22}px;
    }
    .sticker-band { height: 200px; flex: 0 0 auto; }
    .tap {
      font-size: 34px;
      font-weight: 800;
      letter-spacing: 0.12em;
      color: #ff9966;
      margin-top: 40px;
    }
    .lineup { width: 100%; }
    .row {
      display: flex;
      align-items: center;
      gap: 32px;
      padding: ${isStory ? "26px 0" : "23px 0"};
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
      font-size: ${isStory ? 40 : 36}px;
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
    .cta {
      font-size: ${isStory ? 34 : 29}px;
      font-weight: 800;
      color: #ff9966;
      margin-top: ${isStory ? 30 : 20}px;
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
    <div class="headline"><span class="count">${total}</span><span class="unit"> SHOWS</span><span class="tonight">TONIGHT.</span></div>
    <div class="hook">${escapeHTML(hook)}</div>
    <div class="lineup">
${rowItems}
    </div>
${ctaLine}
${tapLine}
${stickerBand}
    <div class="footer">
      <div class="site">comedyhouston.com</div>
      <div class="promise">link in bio</div>
    </div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Caption
// ---------------------------------------------------------------------------

/**
 * Instagram truncates the caption at ~125 characters behind a "more" link,
 * and most readers never expand it. So line one carries the whole pitch —
 * the count and the hook — and everything else (teaser rows, CTA, the
 * weekday tagline as a sign-off) sits below that fold.
 */
function buildCaption({ events, weekday, monthDay, tagline, hook }) {
  const total = events.length;
  const picked = pickGraphicRows(events, Math.min(MAX_CAPTION_ROWS, rowCountFor(total)));
  const lines = picked.map((ev) => {
    const time = ev.time ? `${ev.time} — ` : "";
    return `• ${time}${truncate(cleanShowName(ev.name, ev.venue), 55)}, ${ev.venue}`;
  });
  const extra = total - picked.length;

  const parts = [
    `${total} comedy show${total === 1 ? "" : "s"} in Houston tonight. ${hook}`,
    "",
    `${weekday}, ${monthDay}. A few of them:`,
    "",
    ...lines,
    "",
  ];

  parts.push(
    extra > 0
      ? `The other ${extra} — with prices, showtimes and who still has tickets — are on the site.`
      : "Prices, showtimes and ticket links are all on the site."
  );
  parts.push("");
  parts.push("👉 comedyhouston.com (link in bio)");
  if (DM_KEYWORD) {
    parts.push(`💬 Or comment ${DM_KEYWORD} and I'll DM you the link.`);
  }
  parts.push("");
  parts.push(tagline);
  parts.push("");
  parts.push(
    "#HoustonComedy #StandUp #LiveComedy #HoustonTonight #ThingsToDoInHouston #HoustonNightlife"
  );

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

  const total = events.length;
  const hook = buildHook(events, tagline);
  const rows = pickGraphicRows(events, rowCountFor(total)).map((ev) => ({
    ...ev,
    name: cleanShowName(ev.name, ev.venue),
  }));
  const extraCount = total - rows.length;
  console.log(`\nHook: "${hook}"`);
  console.log(`Rows: ${rows.length} of ${total}  →  CTA: "${buildCta(extraCount)}"`);

  console.log("\nRendering square (1080×1080)…");
  const squareHTML = buildCreativeHTML({
    width: 1080, height: 1080, rows, total, extraCount, weekday, monthDay, hook, isStory: false,
  });
  await screenshotHTML(squareHTML, 1080, 1080, path.join(TONIGHT_DIR, meta.square));

  console.log("Rendering story (1080×1920)…");
  const storyHTML = buildCreativeHTML({
    width: 1080, height: 1920, rows, total, extraCount, weekday, monthDay, hook, isStory: true,
  });
  await screenshotHTML(storyHTML, 1080, 1920, path.join(TONIGHT_DIR, meta.story));

  const caption = buildCaption({ events, weekday, monthDay, tagline, hook });
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
