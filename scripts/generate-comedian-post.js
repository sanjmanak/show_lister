#!/usr/bin/env node

/**
 * Comedy Houston — comedian pages + weekly spotlight assets.
 *
 * Reads events.json for the week LEAD_WEEKS ahead, identifies headliners,
 * and for each one:
 *
 *   1. finds or creates the comedian in blog/comedians/registry.json
 *      (lib/comedian-registry.js) and records the Houston date;
 *   2. writes the evergreen profile ONLY if the registry has none, or it is
 *      older than REWRITE_AFTER_DAYS: research (web search) → write →
 *      fact-check → polish (lib/comedian-profile-writer.js). A returning
 *      comedian costs no OpenAI spend beyond the Instagram caption;
 *   3. publishes or updates the evergreen PAGE /comedians/{slug}/
 *      (lib/comedian-page.js) — upcoming shows render live from events.json
 *      through the plugin's performer shortcode, so the page stays current
 *      between runs and after the show without being republished;
 *   4. writes the per-show Instagram graphics + caption to blog/comedians/
 *      and the week-keyed manifest the IG poster, the graphics self-heal and
 *      the reaper consume (unchanged contract: slug/date/venue/caption/
 *      graphicFiles; wpLink now points at the comedian page).
 *
 * The old per-show spotlight POSTS (name-venue-date slugs, deleted the week
 * after the show) are retired. Their slugs are recorded as legacy_slugs on
 * the comedian so the plugin 301s them to the page; the reaper deletes the
 * posts themselves (scripts/delete-comedian-blog-posts.js).
 *
 * Images: the event's own ticket image is the page's featured image and the
 * photo on the Instagram graphics. No headshot scraping.
 *
 * Zero npm dependencies — uses only built-in Node modules.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const http = require("http");

// Cheap URL-shape check that keeps social-CDN glyphs and vector files out
// of the rendered graphics. See scripts/lib/image-utils.js.
const { isUsableImageUrl } = require("./lib/image-utils");

// Shared OpenAI plumbing (model policy, parameter shapes per model family,
// web-search research call). See scripts/lib/openai.js.
const openai = require("./lib/openai");

// Instagram graphic templates (square / portrait / story), shared with the
// self-heal script ensure-comedian-graphics.js.
const { writeComedianGraphics } = require("./lib/comedian-graphics");

// Regex-based scrub for LLM-produced HTML. Runs after the fact-check and
// polish passes, right before we wrap the body in the final template.
// See scripts/lib/sanitize-html.js.
const { sanitizeAiHtml } = require("./lib/sanitize-html");
const { verifyOutboundLinks } = require("./lib/link-check");
const { createWpClient } = require("./lib/wp");
const { writeSpotlightIndex } = require("./lib/spotlight-index");
const registry = require("./lib/comedian-registry");
const comedianPage = require("./lib/comedian-page");
const profileWriter = require("./lib/comedian-profile-writer");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OPENAI_API_KEY = openai.OPENAI_API_KEY;
const OPENAI_MODEL = openai.OPENAI_MODEL;

// WordPress publishing config (optional — skipped if not set)
const WP_SITE_URL = process.env.WP_SITE_URL || "";          // e.g. https://www.comedyhouston.com
const WP_APP_USER = process.env.WP_APP_USER || "";           // e.g. Comedy Houston Field Team
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";   // Application Password from WP
const WP_ENABLED = !!(WP_SITE_URL && WP_APP_USER && WP_APP_PASSWORD);

const OUTPUT_DIR = path.resolve(__dirname, "..");
const EVENTS_JSON_PATH = path.join(OUTPUT_DIR, "events.json");
const COMEDIANS_DIR = path.join(OUTPUT_DIR, "blog", "comedians");

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

// How many weeks ahead of the current week to generate for. 3 (the cron
// default) publishes each spotlight ~3 weeks before the show so the post
// has time to index and rank for "[comedian] [venue] houston" searches
// before the IG push and the show itself. Override per-run via the
// workflow_dispatch lead_weeks input (0 = the old same-week behavior,
// used for transition backfills).
const LEAD_WEEKS = Math.max(0, parseInt(process.env.LEAD_WEEKS || "3", 10) || 0);

// A comedian's profile is reused on every return visit. Older than this and
// the Monday run researches and rewrites it (a 2025 "recent hook" should not
// headline a 2027 page). 0 = always rewrite.
const REWRITE_AFTER_DAYS = Math.max(0, parseInt(process.env.REWRITE_AFTER_DAYS || "180", 10) || 0);

function getCurrentWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7) + LEAD_WEEKS * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { monday, sunday };
}

/** YYYY-MM-DD in process-local time. toISOString() would convert to UTC,
 * which pushes Sunday 23:59 Central onto the following Monday. */
function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** "8:00 PM" → minutes since midnight. String compares put "10:00 PM"
 * before "8:00 PM"; missing/unparseable times sort last. */
function timeToMinutes(t) {
  if (!t) return 24 * 60 + 1;
  const m = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return 24 * 60 + 1;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
}

function formatDateForDisplay(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatWeekRange(monday, sunday) {
  const opts = { month: "long", day: "numeric" };
  const start = monday.toLocaleDateString("en-US", opts);
  const end = sunday.toLocaleDateString("en-US", { ...opts, year: "numeric" });
  return `${start} – ${end}`;
}

// Punctuation-insensitive identity key so "D. L. Hughley" == "DL Hughley".
// Same helper as generate-blog-post.js — the 2026-07-06 run generated and
// posted the same comedian twice because this script still deduped on the
// raw lowercased name.
function comedianDedupeKey(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Event identity: title + venue, punctuation stripped. A four-night run at
// one club is ONE event, and — the reason this exists — every recognizable
// comedian on a shared bill maps to the same key. Without it, the 2026-09-21
// handoff (Dan Howell, Phil Lester, Arin Hanson, Dan Avidan, Brian Wecht)
// would have produced five spotlight posts and fifteen graphics for exactly
// two shows, each carrying the same ticket image, while Martin Amini, Justin
// Whitehead and Chelby Morgan got nothing.
function eventDedupeKey(ev) {
  if (!ev) return "";
  const title = (ev.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const venue = (ev.venue || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!title && !venue) return "";
  return `${title}@${venue}`;
}

/** The event a headliner entry refers to, using the same match as the loop. */
function matchHeadlinerEvent(headliner, events) {
  return events.find(
    (ev) =>
      ev.name === headliner.show ||
      ev.name.toLowerCase().includes((headliner.name || "").toLowerCase())
  );
}

/** Turn "Ali Siddiq: The Domino Effect Tour" into "ali-siddiq-domino-effect-tour" */
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80)
    // Strip edge hyphens AFTER the length cut: truncating at a word boundary
    // re-introduces a trailing "-", WordPress silently normalizes it away on
    // save, and the ?slug= idempotency lookup then misses the existing post
    // and creates a "-2" duplicate on every rerun.
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Load and filter events
// ---------------------------------------------------------------------------

function loadThisWeeksEvents() {
  if (!fs.existsSync(EVENTS_JSON_PATH)) {
    throw new Error(`events.json not found at ${EVENTS_JSON_PATH}`);
  }

  const raw = JSON.parse(fs.readFileSync(EVENTS_JSON_PATH, "utf8"));
  const events = raw.events || [];

  const { monday, sunday } = getCurrentWeekRange();
  const mondayStr = toLocalDateStr(monday);
  const sundayStr = toLocalDateStr(sunday);

  const filtered = events.filter((ev) => {
    if (!ev.date) return false;
    return ev.date >= mondayStr && ev.date <= sundayStr;
  });

  filtered.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return timeToMinutes(a.time) - timeToMinutes(b.time);
  });

  console.log(
    `Found ${filtered.length} events for the week of ${mondayStr} to ${sundayStr}`
  );
  return { events: filtered, monday, sunday };
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions API
// ---------------------------------------------------------------------------

// Per-request timeouts on OpenAI sockets. Without these a stalled socket
// hangs forever and burns the 45-minute job timeout, which cancels the
// commit/email steps downstream. Chat completion typically returns in
// <30s; web-search Responses calls get a larger budget since the tool
// latency tail is longer.
/**
 * Chat completion. `temperature` is honored only on models that accept it
 * (legacy gpt-4o); reasoning models run at their default with low effort,
 * which is what the prose passes want anyway. See scripts/lib/openai.js.
 */
function callOpenAI(prompt, systemPrompt, temperature) {
  return openai.chatCompletion({
    system: systemPrompt,
    user: prompt,
    temperature: temperature !== undefined ? temperature : 0.7,
    maxTokens: 8000,
    effort: "low",
  });
}

/** Responses API with web search. */
function callOpenAIResponses(input, instructions) {
  return openai.webResearch({ input, instructions, effort: "low" });
}

// ---------------------------------------------------------------------------
// Step 0: Identify headliners (reuses existing pattern)
// ---------------------------------------------------------------------------

function identifyTopComedians(events) {
  const eventNames = events
    .filter((ev) => {
      const name = ev.name.toLowerCase();
      return (
        !name.includes("open mic") &&
        !name.includes("showcase") &&
        !name.includes("karaoke") &&
        !name.includes("showdown") &&
        !name.includes("dating")
      );
    })
    .map((ev) => ev.name);

  const unique = [...new Set(eventNames)];

  const prompt = `Here is a list of comedy show names happening in Houston this week. Identify ALL that feature recognizable comedians — anyone with Netflix/HBO/Comedy Central specials, TV appearances, major podcast appearances, sold-out tours, large social media followings (100k+), etc.

Shows:
${unique.map((n) => `- ${n}`).join("\n")}

Return ONLY a JSON array of objects with "name" (the comedian's name, not the event title) and "show" (the event title exactly as listed). Example:
[{"name": "Ali Siddiq", "show": "Ali Siddiq: The Domino Effect Tour"}]

If there are no recognizable names, return an empty array [].
Return ONLY the JSON array, no other text.`;

  return callOpenAI(prompt, "You are a comedy expert. Return only valid JSON.", 0.3);
}

// ---------------------------------------------------------------------------
// Step 1: Deep research (per comedian)
// ---------------------------------------------------------------------------

function researchComedian(name) {
  const input = `Research the comedian ${name} thoroughly. I need VERIFIED facts only.

Return a JSON object with these fields (leave null/empty if you cannot verify):
{
  "full_name": "",
  "hometown": "",
  "career_start_year": null,
  "specials": [{"title": "", "platform": "", "year": null}],
  "podcast_appearances": [{"show": "", "year_approx": null}],
  "tv_appearances": [{"show": "", "context": ""}],
  "comedy_style": {
    "tone": "",
    "structure": "",
    "recurring_themes": [],
    "comparable_to": ""
  },
  "live_reputation": "",
  "recent_activity_2025_2026": "",
  "recent_hook": {
    "summary": "",
    "quote": "",
    "source_publication": "",
    "source_url": "",
    "date": ""
  },
  "instagram_handle": "",
  "notable_bits_or_quotes": [],
  "unverifiable_claims_to_avoid": [],
  "background_story": "",
  "source_urls": [
    {"label": "Wikipedia", "url": ""},
    {"label": "Netflix special page or IMDB", "url": ""},
    {"label": "Notable interview or article", "url": ""},
    {"label": "Podcast episode or appearance", "url": ""}
  ]
}

For recent_hook: This is the SINGLE MOST IMPORTANT field. Find the freshest piece of news about this comedian — ideally from the last 90 days, no older than 12 months. A new tour announcement, a recent podcast/interview, an album, a Netflix release, a public comment, a project in development. Include a real verbatim quote if you can find one, with the publication name, URL, and date. If you cannot find anything from the last 12 months, leave it null — do NOT pad with old material. The blog post will be built around this hook, so it must be specific and recent.

For unverifiable_claims_to_avoid: List any "facts" you encountered during research that appeared in low-quality sources, fan wikis, or AI-generated summaries that you could NOT independently verify (e.g. "supposedly appeared in X show"). The writer will be told to never use these.

For source_urls: include 3-6 real, working URLs you found during research. These should be the actual pages you pulled facts from — Wikipedia, IMDB, Netflix, YouTube specials, podcast episodes, magazine interviews, etc. Only include URLs you actually visited and verified. Leave the array empty if you cannot find reliable sources.

CRITICAL: Only include facts you can verify via web search. If you cannot find a special title, do not invent one. If you cannot find podcast appearances, leave the array empty. Accuracy over completeness.

Return ONLY the JSON object, no other text.`;

  const instructions =
    "You are a comedy research assistant. Search the web thoroughly to find accurate, current information about this comedian. Return ONLY verified facts in valid JSON format. Never fabricate credits, special titles, or appearances. If something cannot be verified, omit it.";

  return callOpenAIResponses(input, instructions);
}

// Instagram graphic templates live in scripts/lib/comedian-graphics.js
// (shared with ensure-comedian-graphics.js so a rebuilt PNG matches).

// ---------------------------------------------------------------------------
// Per-comedian Instagram caption
// ---------------------------------------------------------------------------

function generateComedianCaption(comedianName, venue, dateStr, instagramHandle, research) {
  const displayDate = formatDateForDisplay(dateStr);

  const prompt = `Write an Instagram caption promoting a single comedian's upcoming show.

COMEDIAN: ${comedianName}
VENUE: ${venue}
DATE: ${displayDate}
INSTAGRAM: ${instagramHandle || "(not found)"}

RESEARCH (use ONLY verified details from this):
${research}

STRUCTURE:
1. HOOK (1 sentence): Lead with one specific, real credit — a special title, a show they were on, a podcast they host. Make it feel like insider knowledge. Address Houston directly.

2. THE PITCH (2-3 sentences): Why this comedian is worth seeing live. Use 1-2 concrete details from the research. Describe their style or energy in plain language. Frame it as a personal recommendation.

3. SHOW DETAILS (1 line): ${venue} · ${displayDate}

4. CTA (1 sentence): Link in bio for tickets. Tag someone you'd bring.

5. HASHTAGS (new line): #HoustonComedy #StandUp #LiveComedy #DateNightHouston #ThingsToDoInHouston #${comedianName.replace(/[^a-zA-Z0-9]/g, "")}

6. TAGS (new line): ${instagramHandle ? instagramHandle : "(skip — no handle available)"}

RULES:
- Total caption body (sections 1-4): 80-120 words
- NO emojis except 🎤 once (optional). Zero is also fine.
- Every claim must come from the research. No invented credits.
- NO hyperbole. No "masterclass." No "redefine comedy."
- NO AI filler: "But wait," "This isn't just X," "Don't just hear about it"
- Write at a 6th grade reading level. Short sentences. Plain words.
- The voice is a friend who follows comedy recommending a show.
- If an Instagram handle is provided, include it EXACTLY as given. Never invent handles.`;

  return callOpenAI(
    prompt,
    "You are writing an Instagram caption for a local comedy publication. Your influences are Seth Godin (minimal, say less, mean more) and Roy H. Williams aka the Wizard of Ads (speak to one person, be honest, earn trust). Clean, modern copy that converts because it's genuine — not because it's loud. No AI voice. No marketing fluff."
  );
}

/**
 * Pull sameAs URLs (Wikipedia, IMDB, Netflix, Rotten Tomatoes, official site,
 * Instagram) out of the research JSON so Google can link the Person node to
 * the comedian's real knowledge graph entity. Returns a deduped URL array.
 */
function extractPerformerSameAs(research) {
  const urls = new Set();
  if (!research) return [];

  let text = research;
  if (typeof research === "object") {
    try { text = JSON.stringify(research); } catch (_) { text = ""; }
  }

  // Whitelist of identity-establishing domains. Ordered by authority so that
  // if we ever want to cap the array, we keep the most useful first.
  // Note: `)` is deliberately NOT excluded from the URL character class —
  // Wikipedia disambiguation URLs legitimately end with `)`, e.g.
  // `https://en.wikipedia.org/wiki/Zakir_Khan_(comedian)`. We handle
  // sentence-boundary closing parens in the cleanup step below.
  const hostRegex = /\bhttps?:\/\/(?:[\w-]+\.)*(?:en\.wikipedia\.org|wikipedia\.org|imdb\.com|netflix\.com|rottentomatoes\.com|instagram\.com|twitter\.com|x\.com|youtube\.com)[^\s"'<>]+/gi;
  const matches = String(text).match(hostRegex) || [];
  for (const url of matches) {
    // Strip trailing punctuation that commonly comes from sentence boundaries.
    // For `)`: only strip when unbalanced (more closing than opening parens
    // in the URL) so "Zakir_Khan_(comedian)" is preserved but "(visit X)"
    // correctly drops the trailing ')'.
    let cleaned = url.replace(/[.,;:\]]+$/, "");
    while (cleaned.endsWith(")")) {
      const opens = (cleaned.match(/\(/g) || []).length;
      const closes = (cleaned.match(/\)/g) || []).length;
      if (closes > opens) {
        cleaned = cleaned.slice(0, -1);
      } else {
        break;
      }
    }
    urls.add(cleaned);
  }

  // If the research JSON has an instagram_handle but no instagram URL made it
  // into the matches above, synthesize the URL from the handle.
  if (typeof research === "string") {
    try {
      const obj = JSON.parse(String(research).replace(/^```json\s*\n?/i, "").replace(/\n?```\s*$/g, "").trim());
      if (obj && obj.instagram_handle) {
        const handle = String(obj.instagram_handle).replace(/^@+/, "").trim();
        if (handle) urls.add(`https://www.instagram.com/${handle}/`);
      }
    } catch (_) { /* research wasn't JSON — ignore */ }
  }

  return Array.from(urls).slice(0, 8);
}

/** WordPress REST call (shared client, 30s timeout, detailed errors, no retry). */
const wpClient = createWpClient({ userAgent: "ComedyHouston-BlogBot/1.0" });
function wpRequest(method, urlPath, body) {
  return wpClient.request(method, urlPath, body);
}

/**
 * Preflight WordPress auth check. Calls /wp-json/wp/v2/users/me before we
 * start publishing posts. If the credentials, IP, or host firewall are
 * broken, we want to find out *now* with a loud, specific error — not after
 * silently skipping every publish.
 *
 * Hostinger's edge ("hcdn") intermittently answers the GitHub runner with a
 * 403 "Checking your browser before accessing" HTML page instead of the API
 * (2026-09-07 weekly run, 2026-09-22 backfill). The page itself says to
 * refresh in 30s, and a second dispatch 20 minutes later sailed through, so
 * a 403 / 5xx / network error is retried after WP_PREFLIGHT_RETRY_MS. A 401
 * (bad app password) or 400 is deterministic and fails on the first try.
 *
 * Returns true on success, false on failure (caller decides whether to
 * proceed). On failure, the underlying detailed error is logged.
 */
const WP_PREFLIGHT_ATTEMPTS = parseInt(process.env.WP_PREFLIGHT_ATTEMPTS || "4", 10);
const WP_PREFLIGHT_RETRY_MS = parseInt(process.env.WP_PREFLIGHT_RETRY_MS || "35000", 10);

function isRetryablePreflightError(err) {
  const m = /WordPress API (\d{3})/.exec(err && err.message ? err.message : "");
  if (!m) return true; // network / DNS / socket error — no HTTP status at all
  const status = parseInt(m[1], 10);
  return status === 403 || status === 408 || status === 429 || status >= 500;
}

async function wpPreflight() {
  const total = Math.max(1, WP_PREFLIGHT_ATTEMPTS);
  let lastErr = null;
  for (let attempt = 1; attempt <= total; attempt++) {
    console.log(`Preflight: checking WordPress auth via /wp-json/wp/v2/users/me (attempt ${attempt}/${total}) ...`);
    try {
      const me = await wpRequest("GET", "/wp-json/wp/v2/users/me?context=edit", null);
      console.log(`  WP auth OK — authenticated as "${me.name}" (id=${me.id}, slug=${me.slug})`);
      return true;
    } catch (err) {
      lastErr = err;
      const isChallenge = /Checking your browser/i.test(err.message || "");
      console.error(`  attempt ${attempt}/${total} failed: ${(err.message || "").slice(0, 200)}`);
      if (isChallenge) console.error("  (Hostinger bot-challenge page, not the API — the host is screening the runner IP)");
      if (attempt >= total || !isRetryablePreflightError(err)) break;
      console.error(`  retrying in ${Math.round(WP_PREFLIGHT_RETRY_MS / 1000)}s...`);
      await new Promise((r) => setTimeout(r, WP_PREFLIGHT_RETRY_MS));
    }
  }
  console.error("  WP PREFLIGHT FAILED.");
  console.error(`  ${lastErr ? lastErr.message : "unknown error"}`);
  console.error("  Common causes:");
  console.error("    • Hostinger edge (hcdn) bot challenge on the GitHub Actions runner IP — usually clears in minutes; re-dispatch the workflow");
  console.error("    • WP_APP_PASSWORD secret in GitHub is stale (regenerate in WP → Users → Application Passwords)");
  console.error("    • WP_APP_USER does not match the user the password belongs to");
  console.error("    • LiteSpeed / security plugin is blocking the runner IP (check hPanel security logs)");
  console.error("    • LiteSpeed Cache is stripping the Authorization header (exclude /wp-json/ from cache)");
  return false;
}

/**
 * Download an image from a URL and return the raw Buffer + content type.
 * Follows up to 3 redirects; a misconfigured CDN that loops
 * 301→301→301 used to recurse indefinitely here because the "up to 3"
 * comment was never enforced in code. Also attaches a 30s per-request
 * timeout so a stalled CDN can't burn the job timeout.
 */
function downloadImage(imageUrl, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 3;
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) {
      return reject(new Error("Image download failed: too many redirects"));
    }
    const parsed = new URL(imageUrl);
    const lib = parsed.protocol === "https:" ? https : http;

    const req = lib.get(
      imageUrl,
      { headers: { "User-Agent": "ComedyHouston-BlogBot/1.0" } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return downloadImage(res.headers.location, redirectsLeft - 1).then(resolve).catch(reject);
        }
        if (res.statusCode >= 400) {
          return reject(new Error(`Image download failed: HTTP ${res.statusCode}`));
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: res.headers["content-type"] || "image/jpeg",
          });
        });
        res.on("error", reject);
      }
    );
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`downloadImage timed out after 30000ms: ${imageUrl.slice(0, 80)}`));
    });
    req.on("error", reject);
  });
}

/** Upload an image to WordPress media library, return the media ID. */
function wpUploadImage(imageBuffer, contentType, filename) {
  return new Promise((resolve, reject) => {
    const fullUrl = WP_SITE_URL.replace(/\/$/, "") + "/wp-json/wp/v2/media";
    const parsed = new URL(fullUrl);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString("base64");

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname,
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": imageBuffer.length,
        "User-Agent": "ComedyHouston-BlogBot/1.0",
      },
    };

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          return reject(
            new Error(`WP media upload ${res.statusCode}: ${data.slice(0, 500)}`)
          );
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.id);
        } catch (e) {
          reject(new Error(`Failed to parse WP media response: ${e.message}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(imageBuffer);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Legacy spotlight migration
// ---------------------------------------------------------------------------

/** Every week-keyed manifest on disk, with its path, for in-place edits. */
function loadWeekManifests() {
  if (!fs.existsSync(COMEDIANS_DIR)) return [];
  return fs
    .readdirSync(COMEDIANS_DIR)
    .filter((f) => /^manifest-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => {
      const file = path.join(COMEDIANS_DIR, f);
      try {
        return { file, manifest: JSON.parse(fs.readFileSync(file, "utf8")) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Point every manifest entry for this comedian at the new page and record
 * the old per-show POST slugs as legacy_slugs so (a) the event cards'
 * "More info" link goes to the page as soon as the spotlight index is
 * rebuilt, (b) the plugin 301s the old URLs, and (c) the reaper deletes the
 * old posts. Returns the number of legacy posts adopted. manifest_version
 * is deliberately left alone: the IG poster treats a changed version as a
 * mid-week regeneration.
 */
function adoptLegacySpotlights(entry, weekManifests, pageLink) {
  let adopted = 0;
  const terms = entry.match || [];
  for (const { file, manifest } of weekManifests) {
    let dirty = false;
    for (const post of manifest.posts || []) {
      const norm = registry.normalizeName(post.comedianName);
      if (!norm || !(norm === registry.normalizeName(entry.name) || terms.includes(norm))) continue;
      if (post.wpLink && post.wpLink !== pageLink && !/\/comedians\//.test(post.wpLink)) {
        if (!entry.legacy_slugs.includes(post.slug)) entry.legacy_slugs.push(post.slug);
        adopted++;
      }
      if (post.wpLink !== pageLink || post.wpType !== "page" || post.comedianSlug !== entry.slug) {
        post.wpLink = pageLink;
        post.wpType = "page";
        post.comedianSlug = entry.slug;
        dirty = true;
      }
    }
    if (dirty) fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  }
  return adopted;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Comedy Houston — Per-Comedian Blog Post Generator ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`WordPress publishing: ${WP_ENABLED ? "ENABLED (" + WP_SITE_URL + ")" : "DISABLED (no WP credentials set)"}`);
  console.log("");

  if (!OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY environment variable is not set.");
    process.exit(1);
  }

  // Load events
  const { events, monday, sunday } = loadThisWeeksEvents();
  if (events.length === 0) {
    console.log("No events found for this week. Skipping.");
    process.exit(0);
  }

  const weekRange = formatWeekRange(monday, sunday);
  console.log(`Week range: ${weekRange}`);
  console.log("");

  // Preflight WordPress auth once, up front, before a single OpenAI call.
  // It used to log the failure and carry on generating: the 2026-09-22
  // backfill spent the full research/write/polish budget on five posts it
  // then could not publish, and the manifest it committed had no wpLink for
  // the IG poster to use. A spotlight without its post is not worth paying
  // for, so a failed preflight now ends the run here. The workflow's
  // notify-on-failure step sends the alert; re-dispatch once the host clears.
  // WP_PREFLIGHT_SOFT=1 restores the old carry-on behaviour for a deliberate
  // graphics-only run.
  let wpReady = WP_ENABLED;
  if (WP_ENABLED) {
    wpReady = await wpPreflight();
    if (!wpReady) {
      if (process.env.WP_PREFLIGHT_SOFT === "1") {
        console.warn("WordPress publishing DISABLED for this run due to preflight failure (WP_PREFLIGHT_SOFT=1, continuing).\n");
      } else {
        console.error("Aborting before any OpenAI spend: nothing generated, nothing to publish. Re-run the workflow once WordPress is reachable.");
        process.exit(1);
      }
    }
  }

  // Ensure output directory exists
  if (!fs.existsSync(COMEDIANS_DIR)) {
    fs.mkdirSync(COMEDIANS_DIR, { recursive: true });
  }

  // Prune files that belong to shows that have already happened. Nothing
  // for the current or future weeks is touched: with the 3-week lead this
  // run writes week N+3 while post-to-instagram.js is still serving weeks
  // N, N+1 and N+2 from the same images/ directory. (Wiping the whole
  // directory here, as an earlier version did, deleted the current week's
  // PNGs every Monday and the next IG run 404'd on them: 2026-09-07.)
  // delete-comedian-blog-posts.js is the real reaper; this is a backstop
  // for orphans it never saw (re-runs that swapped comedians, etc.).
  console.log("Pruning files for past shows...");
  {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 2);
    const cutoff = toLocalDateStr(yesterday);
    const datedFile = /-(\d{4}-\d{2}-\d{2})(?:-(?:square|portrait|story|teaser-\d)\.(?:png|html)|-caption\.txt|\.live-refreshed)$/;
    let pruned = 0;
    // IMAGES_DIR was removed in the 2026-09-07 cleanup (event image only);
    // referencing it here crashed the 2026-09-14 run with a ReferenceError.
    const dirs = [COMEDIANS_DIR].filter((d) => fs.existsSync(d));
    for (const dir of dirs) {
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(datedFile);
        if (m && m[1] < cutoff) {
          fs.unlinkSync(path.join(dir, f));
          pruned++;
        }
      }
    }
    console.log(`  Removed ${pruned} file(s) for shows before ${cutoff}.`);
  }
  // Email summary files are rewritten every run; drop stale copies so a
  // run that generates nothing cannot email last week's assets.
  for (const f of ["email-subject.txt", "email-body.txt", "email-attachments.txt"]) {
    const p = path.join(COMEDIANS_DIR, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  console.log("");

  // Step 0: Identify headliners
  console.log("Step 0: Identifying headliners...");
  let headliners = [];

  // Prefer the handoff file written by generate-blog-post.js earlier on
  // Monday — this guarantees the weekly roundup and the per-comedian posts
  // cover the exact same comedians (and saves one OpenAI call).
  const handoffPath = path.join(__dirname, "..", "blog", "top-comedians.json");
  if (fs.existsSync(handoffPath)) {
    try {
      const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
      if (
        handoff &&
        handoff.week_range === weekRange &&
        Array.isArray(handoff.comedians) &&
        handoff.comedians.length > 0
      ) {
        // Capped below, AFTER the per-event dedupe — slicing first would
        // spend the five slots on five names from two shows.
        headliners = handoff.comedians;
        console.log(
          `Using ${headliners.length} headliner(s) from blog handoff: ${headliners.map((c) => c.name).join(", ")}`
        );
        console.log("");
      } else {
        console.log("Handoff file exists but week_range doesn't match — falling back to OpenAI.");
      }
    } catch (e) {
      console.warn(`Could not read handoff file: ${e.message}`);
    }
  }

  if (headliners.length > 0) {
    // Skip the OpenAI call entirely; headliners came from the handoff.
  } else
  try {
    const raw = await identifyTopComedians(events);
    const jsonStr = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    try {
      headliners = JSON.parse(jsonStr);
    } catch (parseErr) {
      // OpenAI sometimes wraps or prefixes the JSON with prose. Fall back to
      // extracting the first top-level JSON array before giving up.
      console.warn(`  JSON parse failed: ${parseErr.message}. Attempting array extraction…`);
      const match = jsonStr.match(/\[[\s\S]*\]/);
      if (!match) throw parseErr;
      headliners = JSON.parse(match[0]);
    }
    // Deduplicate by name (punctuation-insensitive)
    const seen = new Set();
    headliners = headliners.filter((c) => {
      const key = comedianDedupeKey(c.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // The 5-post cap is applied after the per-event dedupe below.
    console.log(`Identified ${headliners.length} headliner(s): ${headliners.map((c) => c.name).join(", ")}`);
  } catch (err) {
    console.error(`Failed to identify headliners: ${err.message}`);
    process.exit(1);
  }
  console.log("");

  // Final dedupe regardless of which path produced the list — the handoff
  // path previously had no dedupe at all.
  {
    const seenKeys = new Set();
    headliners = headliners.filter((c) => {
      const key = comedianDedupeKey(c && c.name);
      if (!key || seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
  }

  // One post per SHOW. Co-headliners of the same bill collapse onto the
  // first (highest-ranked) entry, which keeps the others' names so the post
  // can name the full lineup instead of pretending it's a solo date.
  {
    const seenEvents = new Map();
    const perEvent = [];
    for (const c of headliners) {
      const key = eventDedupeKey(matchHeadlinerEvent(c, events));
      if (!key) {
        perEvent.push(c);
        continue;
      }
      const existing = seenEvents.get(key);
      if (existing) {
        existing.names = existing.names || [existing.name];
        if (!existing.names.includes(c.name)) existing.names.push(c.name);
        console.log(`  ${c.name} shares a bill with ${existing.name} — one post covers both.`);
        continue;
      }
      seenEvents.set(key, c);
      perEvent.push(c);
    }
    if (perEvent.length !== headliners.length) {
      console.log(`${headliners.length} headliner(s) → ${perEvent.length} show(s) after grouping.`);
    }
    headliners = perEvent;
  }

  // Hard cap: max 5 spotlight posts per week.
  if (headliners.length > 5) {
    console.log(`Found ${headliners.length} shows — capping at 5.`);
    headliners = headliners.slice(0, 5);
  }
  console.log(`Processing ${headliners.length} show(s): ${headliners.map((c) => c.name).join(", ")}`);

  if (headliners.length === 0) {
    console.log("No recognizable headliners this week. Skipping.");
    process.exit(0);
  }

  // Registry: one record per comedian, the source of truth for the pages.
  const reg = registry.loadRegistry(COMEDIANS_DIR);
  const weekManifests = loadWeekManifests();

  // Poster upload for the comedian page: download the event image, push it
  // to the WP media library, hand back the media id + URL.
  const uploadHero = async ({ url, filename }) => {
    const { buffer, contentType } = await downloadImage(url);
    const ext = contentType.includes("png") ? "png" : "jpg";
    const mediaId = await wpUploadImage(buffer, contentType, `${filename}.${ext}`);
    let mediaUrl = "";
    try {
      const media = await wpRequest("GET", `/wp-json/wp/v2/media/${mediaId}`, null);
      mediaUrl = media.source_url || "";
    } catch (_) { /* page falls back to the vendor URL */ }
    return { mediaId, mediaUrl };
  };

  const generatedPosts = [];

  for (const headliner of headliners) {
    console.log(`━━━ Processing: ${headliner.name} ━━━`);

    // Find the matching event(s) — use the first one for details
    const matchedEvent = events.find(
      (ev) => ev.name === headliner.show || ev.name.toLowerCase().includes(headliner.name.toLowerCase())
    );

    if (!matchedEvent) {
      console.log(`  Could not match event for ${headliner.name}. Skipping.`);
      console.log("");
      continue;
    }

    const venue = matchedEvent.venue || "Houston Venue";
    const date = matchedEvent.date;
    const ticketUrl = matchedEvent.ticket_url || "";
    const eventImageUrl = matchedEvent.image_url || "";

    // ── Registry ──────────────────────────────────────────────────────────
    let entry = registry.findComedian(reg, headliner.name);
    if (!entry) {
      entry = registry.createComedian(reg, headliner.name);
      console.log(`  New comedian → /comedians/${entry.slug}/`);
    } else {
      const age = entry.profile_written_at ? `${Math.round(registry.profileAgeDays(entry))}d old` : "missing";
      console.log(`  Known comedian (/comedians/${entry.slug}/, ${entry.shows.length} Houston date(s) on record, profile ${age})`);
    }
    if (entry.status !== "live") {
      console.log("  Reactivating archived comedian — the page comes back at its old URL.");
      entry.status = "live";
      entry.archived_at = null;
    }
    // Every night of this run (same title + venue), not just the first.
    const runKey = eventDedupeKey(matchedEvent);
    let added = 0;
    for (const ev of events) {
      if (eventDedupeKey(ev) === runKey && registry.recordShow(entry, ev)) added++;
    }
    if (added) console.log(`  Recorded ${added} Houston date(s).`);
    if (registry.ensureMatchForEvent(entry, matchedEvent.name)) {
      console.log(`  Added match term for the show title ("${matchedEvent.name}") so the page lists it.`);
    }

    // ── Profile (only when missing or stale) ──────────────────────────────
    const needsProfile =
      !entry.profile_html || REWRITE_AFTER_DAYS === 0 || registry.profileAgeDays(entry) > REWRITE_AFTER_DAYS;
    let research = entry.research_json || "";
    let instagramHandle = entry.instagramHandle || "";

    if (needsProfile) {
      // Step 1: Deep research
      console.log("  Step 1: Researching via web search...");
      try {
        research = await researchComedian(headliner.name);
        console.log("  Research complete.");
      } catch (err) {
        console.warn(`  Research failed: ${err.message}. Writing with limited data.`);
        research = JSON.stringify({ full_name: headliner.name, note: "Research unavailable" });
      }

      // Step 2: Write the evergreen profile
      console.log("  Step 2: Writing profile...");
      let draft = "";
      try {
        draft = openai.stripFences(
          await profileWriter.writeProfile(headliner.name, research, { pastShows: registry.pastShows(entry) })
        );
        console.log("  Draft complete.");
      } catch (err) {
        console.error(`  Profile writing failed: ${err.message}.`);
      }

      let finalContent = draft;
      if (draft) {
        // Step 3: Fact-check pass
        console.log("  Step 3: Fact-checking...");
        try {
          finalContent = openai.stripFences(await profileWriter.factCheckProfile(research, draft, headliner.name));
          console.log("  Fact-check complete.");
        } catch (err) {
          console.warn(`  Fact-check failed: ${err.message}. Using unedited draft.`);
        }

        // Step 4: Polish pass — voice, rhythm, length (no new facts)
        console.log("  Step 4: Polish pass...");
        try {
          const polished = openai.stripFences(await profileWriter.polishProfile(finalContent, headliner.name));
          if (polished && polished.length > 200) {
            finalContent = polished;
            console.log("  Polish complete.");
          } else {
            console.warn("  Polish output too short — keeping fact-checked draft.");
          }
        } catch (err) {
          console.warn(`  Polish failed: ${err.message}. Using fact-checked draft.`);
        }

        finalContent = profileWriter.stripH1(profileWriter.stripEmDashes(profileWriter.stripEditorMarkers(finalContent)));

        // Sanitize the AI output (scripts, iframes, javascript: URLs).
        const sanitized = sanitizeAiHtml(finalContent);
        if (sanitized.removed.length > 0) {
          console.warn(`  sanitizeAiHtml removed for ${headliner.name}: ${sanitized.removed.join(", ")}`);
        }
        finalContent = sanitized.html;

        // Dead cited links are unwrapped, inconclusive ones left alone.
        try {
          const links = await verifyOutboundLinks(finalContent);
          if (links.removed.length > 0) console.log(`  Dead source links unwrapped: ${links.removed.join(", ")}`);
          finalContent = links.html;
        } catch (err) {
          console.warn(`  Link verification failed (non-fatal, links kept): ${err.message}`);
        }
      }

      if (finalContent && finalContent.length >= 300) {
        entry.profile_html = finalContent;
        entry.profile_written_at = new Date().toISOString();
        entry.research_json = research;
        entry.sameAs = extractPerformerSameAs(research);
      } else if (entry.profile_html) {
        console.warn(`  New profile too short (${(finalContent || "").length} chars) — keeping the existing one.`);
        research = entry.research_json || research;
      } else {
        console.warn(`  Profile too short for ${headliner.name} (${(finalContent || "").length} chars) — skipping; no page without a profile.`);
        console.log("");
        continue;
      }

      // Instagram handle from the research (normalized to "@name").
      try {
        const researchObj = JSON.parse(openai.stripFences(research));
        instagramHandle = researchObj.instagram_handle || "";
      } catch (_) { /* research wasn't JSON — that's fine */ }
      if (instagramHandle) {
        instagramHandle = "@" + instagramHandle.replace(/^@+/, "").trim();
        if (instagramHandle === "@") instagramHandle = "";
      }
      entry.instagramHandle = instagramHandle;
    } else {
      console.log("  Profile is current — reused (research reused for the caption, no OpenAI spend).");
    }
    registry.saveRegistry(COMEDIANS_DIR, reg);

    // ── Instagram assets (per show, unchanged contract) ───────────────────
    const graphicImageUrl = isUsableImageUrl(eventImageUrl) ? eventImageUrl : "";
    if (!graphicImageUrl) console.log("  No usable event image — graphics will render text-only.");

    // Slug: name + venue + show date. Names the graphics and the caption
    // file; the IG poster and the graphics self-heal key on it.
    const postSlug = `${slugify(headliner.name)}-${slugify(venue)}-${date}`;

    console.log("  Step 5: Generating Instagram graphic templates...");
    let graphicFiles = [];
    try {
      graphicFiles = writeComedianGraphics(headliner.name, venue, date, graphicImageUrl, postSlug);
      for (const gf of graphicFiles) console.log(`    Wrote: blog/comedians/images/${path.basename(gf.htmlPath)}`);
    } catch (err) {
      console.warn(`  Instagram graphics failed: ${err.message}`);
    }

    console.log("  Step 6: Generating Instagram caption...");
    let caption = "";
    try {
      caption = await generateComedianCaption(headliner.name, venue, date, instagramHandle, research);
      fs.writeFileSync(path.join(COMEDIANS_DIR, `${postSlug}-caption.txt`), caption);
      console.log(`  Wrote: blog/comedians/${postSlug}-caption.txt`);
    } catch (err) {
      console.warn(`  Caption generation failed: ${err.message}`);
    }

    // ── Page ──────────────────────────────────────────────────────────────
    let wpLink = entry.wpLink || "";
    if (wpReady) {
      console.log("  Step 7: Publishing comedian page...");
      try {
        const res = await comedianPage.publishComedianPage(entry, { wpRequest, heroImageUrl: eventImageUrl, uploadHero });
        wpLink = res.link;
        const migrated = adoptLegacySpotlights(entry, weekManifests, wpLink);
        if (migrated) console.log(`  ${migrated} legacy spotlight post(s) now redirect to the page (reaper deletes them).`);
      } catch (err) {
        console.error(`  Page publish failed: ${err.message}`);
        console.log("  Graphics and caption still ship; the page is retried next run.");
      }
      registry.saveRegistry(COMEDIANS_DIR, reg);
    }
    console.log("");

    generatedPosts.push({
      comedianName: headliner.name,
      comedianSlug: entry.slug,
      venue: venue,
      date: date,
      imageUrl: eventImageUrl,
      graphicImageUrl: graphicImageUrl,
      ticketUrl: ticketUrl,
      slug: postSlug,
      wpLink: wpLink,
      wpType: "page",
      caption: caption,
      instagramHandle: instagramHandle, // "@name" or "" — poster uses this to tag the comedian in the IG photo
      graphicFiles: graphicFiles.map((gf) => gf.pngFile),
    });
  }

  if (generatedPosts.length > 0) {
    // Write manifest JSON (consumed by post-to-instagram.js, the reaper,
    // and ensure-comedian-graphics.js)
    // `manifest_version` is a monotonic stamp that changes every time this
    // script runs — the IG poster uses it to detect mid-week manifest
    // regeneration and prune state entries whose slugs no longer exist.
    const manifest = {
      generated_at: new Date().toISOString(),
      manifest_version: Date.now(),
      week_range: weekRange,
      posts: generatedPosts,
    };
    // Week-keyed filename so several future weeks can be in flight at once;
    // post-to-instagram.js resolves the file matching the CURRENT week.
    const manifestName = `manifest-${toLocalDateStr(monday)}.json`;
    fs.writeFileSync(
      path.join(COMEDIANS_DIR, manifestName),
      JSON.stringify(manifest, null, 2)
    );
    console.log(`Wrote: blog/comedians/${manifestName}`);

    // Write email summary for the workflow email step
    const names = generatedPosts.map((p) => p.comedianName);
    const totalImages = generatedPosts.reduce((n, p) => n + (p.graphicFiles || []).length, 0);
    const subject = `Comedy Houston — Comedian Spotlights: ${names.join(", ")} (${totalImages} posts)`;

    let emailBody = `Here are this week's comedian spotlight assets — ready to post on Instagram.\n\n`;

    for (const post of generatedPosts) {
      emailBody += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      emailBody += `${post.comedianName} — ${post.venue}, ${formatDateForDisplay(post.date)}\n`;
      if (post.wpLink) {
        emailBody += `Comedian page: ${post.wpLink}\n`;
      } else {
        emailBody += `Comedian page: NOT PUBLISHED (WordPress publish failed — see the run log)\n`;
      }
      emailBody += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      if (post.caption) {
        emailBody += `INSTAGRAM CAPTION (copy & paste):\n\n${post.caption}\n\n`;
      }
      emailBody += `Images attached: ${(post.graphicFiles || []).join(", ") || "none"}\n\n`;
    }

    emailBody += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    emailBody += `All ${totalImages} images are attached — 3 sizes per comedian (square, portrait, story).\n`;
    emailBody += `Browse all shows: https://comedyhouston.com\n`;

    fs.writeFileSync(path.join(COMEDIANS_DIR, "email-subject.txt"), subject);
    fs.writeFileSync(path.join(COMEDIANS_DIR, "email-body.txt"), emailBody);
    // Exact attachment list for THIS run. images/ now holds three weeks of
    // graphics at once, so the workflow must not glob the whole directory.
    const attachments = generatedPosts
      .flatMap((p) => (p.graphicFiles || []).map((f) => `blog/comedians/images/${f}`))
      .join(",");
    fs.writeFileSync(path.join(COMEDIANS_DIR, "email-attachments.txt"), attachments + "\n");
    console.log(`Wrote: blog/comedians/email-subject.txt`);
    console.log(`Wrote: blog/comedians/email-body.txt`);
    console.log(`Wrote: blog/comedians/email-attachments.txt`);
  }

  // Rebuild the plugin's indexes from disk. Always, even when nothing was
  // generated, so a manual re-run repairs the files:
  //   spotlight-index.json  — per-show "More info" links on the event cards
  //   comedians-index.json  — performer match terms, page URLs, legacy 301s
  try {
    const n = writeSpotlightIndex(COMEDIANS_DIR);
    console.log(`Wrote: blog/comedians/spotlight-index.json (${n} posts)`);
  } catch (err) {
    console.warn(`Spotlight index write failed: ${err.message}`);
  }
  try {
    const n = registry.writeComediansIndex(COMEDIANS_DIR, reg);
    console.log(`Wrote: blog/comedians/comedians-index.json (${n} comedians)`);
  } catch (err) {
    console.warn(`Comedians index write failed: ${err.message}`);
  }

  console.log("");
  console.log(`Done. Generated ${generatedPosts.length} comedian post(s).`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
