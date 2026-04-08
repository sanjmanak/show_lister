#!/usr/bin/env node

/**
 * Comedy Houston — Weekly Blog Post Generator
 * Reads events.json, filters to this week's events, calls OpenAI to write
 * a blog post, and outputs blog/index.html.
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// Shared image pipeline: URL blocklists, HEAD validation, dimension parser,
// strict-gate headshot finder, and the inverted display-image policy that
// prefers the event image unless a scraped headshot clears the quality bar.
// See scripts/lib/image-utils.js for the full rationale.
const imageUtils = require("./lib/image-utils");
const {
  findBestHeadshot,
  evaluateHeadshotCandidate,
  isUsableImageUrl,
  buildInitialsPlaceholder,
  pickDisplayImage,
} = imageUtils;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

// WordPress publishing config (optional — skipped if not set)
const WP_SITE_URL = process.env.WP_SITE_URL || "";
const WP_APP_USER = process.env.WP_APP_USER || "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";
const WP_ENABLED = !!(WP_SITE_URL && WP_APP_USER && WP_APP_PASSWORD);

const OUTPUT_DIR = path.resolve(__dirname, "..");
const EVENTS_JSON_PATH = path.join(OUTPUT_DIR, "events.json");
const BLOG_DIR = path.join(OUTPUT_DIR, "blog");
const BLOG_HTML_PATH = path.join(BLOG_DIR, "index.html");
const BLOG_HERO_HTML_PATH = path.join(BLOG_DIR, "weekly-hero.html");
const BLOG_CAPTION_PATH = path.join(BLOG_DIR, "instagram-caption.txt");

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Get Monday 00:00 and Sunday 23:59 of the current week (Central Time). */
function getCurrentWeekRange() {
  // Work in UTC but label as Central for display
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ...

  // Monday of this week
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);

  // Sunday of this week
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return { monday, sunday };
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
  const mondayStr = monday.toISOString().slice(0, 10);
  const sundayStr = sunday.toISOString().slice(0, 10);

  const filtered = events.filter((ev) => {
    if (!ev.date) return false;
    return ev.date >= mondayStr && ev.date <= sundayStr;
  });

  // Sort by date then time
  filtered.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (a.time || "").localeCompare(b.time || "");
  });

  console.log(
    `Found ${filtered.length} events for the week of ${mondayStr} to ${sundayStr}`
  );
  return { events: filtered, monday, sunday };
}

// ---------------------------------------------------------------------------
// OpenAI API call
// ---------------------------------------------------------------------------

function callOpenAI(prompt, systemPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 8000,
    });

    const options = {
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          return reject(
            new Error(`OpenAI API error ${res.statusCode}: ${data.slice(0, 500)}`)
          );
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices[0].message.content;
          const usage = parsed.usage;
          console.log(
            `OpenAI usage — prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens}, total: ${usage.total_tokens}`
          );
          resolve(content);
        } catch (e) {
          reject(new Error(`Failed to parse OpenAI response: ${e.message}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// OpenAI Responses API (with web search)
// ---------------------------------------------------------------------------

function callOpenAIResponses(input, instructions) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: OPENAI_MODEL,
      instructions: instructions,
      input: input,
      tools: [{ type: "web_search_preview" }],
    });

    const options = {
      hostname: "api.openai.com",
      path: "/v1/responses",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          return reject(
            new Error(`OpenAI Responses API error ${res.statusCode}: ${data.slice(0, 500)}`)
          );
        }
        try {
          const parsed = JSON.parse(data);
          const textOutput = parsed.output
            .filter((item) => item.type === "message")
            .flatMap((item) => item.content)
            .filter((c) => c.type === "output_text")
            .map((c) => c.text)
            .join("\n");

          if (parsed.usage) {
            console.log(
              `OpenAI Responses usage — input: ${parsed.usage.input_tokens}, output: ${parsed.usage.output_tokens}, total: ${parsed.usage.total_tokens}`
            );
          }
          resolve(textOutput);
        } catch (e) {
          reject(new Error(`Failed to parse Responses API response: ${e.message}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Headshot extraction — moved to scripts/lib/image-utils.js
// fetchPage, validateImageUrl, extractImageCandidates, findBestHeadshot,
// isUsableImageUrl, and buildInitialsPlaceholder all live in the shared
// lib now so generate-comedian-post.js uses the same strict-gate pipeline.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WordPress REST API helpers
// ---------------------------------------------------------------------------

// Single-request timeout for every WordPress / image-download HTTP call.
// Without this, a silent TCP hang on Hostinger's load balancer (or any
// upstream proxy) leaves the Node socket waiting indefinitely — which
// burned a 30-minute job timeout in run #26 and lost the Instagram
// caption email along with it. With the timeout in place, the request
// throws a clear error after WP_REQUEST_TIMEOUT_MS, the existing
// try/catch around the WP publish swallows it, and the script
// continues to the email step.
const WP_REQUEST_TIMEOUT_MS = 30_000;
// Hero PNG upload is the biggest payload (~200KB) and the slowest call —
// give it a bit more headroom than a JSON POST.
const WP_UPLOAD_TIMEOUT_MS = 60_000;
// Hard ceiling so a misbehaving server can't burn the whole job. After
// this many ms across ALL WP operations in main(), we abort WP publish
// and let the email step take over.
const WP_TOTAL_BUDGET_MS = 8 * 60 * 1000; // 8 minutes
let wpDeadline = 0; // set in main() right before the WP publish step

/**
 * Reject a pending WP request if we've blown the cumulative budget. Cheap
 * and best-effort: each individual request still has its own timeout, but
 * this catches pathological "lots of slow-but-not-quite-timing-out" cases.
 */
function checkWpDeadline(label) {
  if (wpDeadline > 0 && Date.now() > wpDeadline) {
    throw new Error(`${label} skipped: cumulative WP budget of ${WP_TOTAL_BUDGET_MS}ms exceeded`);
  }
}

/**
 * Attach a hard timeout to an http(s) ClientRequest. If the response
 * doesn't arrive within `ms` (or the body stalls mid-stream), destroy
 * the socket so the consumer's `error` handler fires with a real
 * Error instead of hanging forever — Node's default behavior.
 */
function attachRequestTimeout(req, ms, label) {
  req.setTimeout(ms, () => {
    req.destroy(new Error(`${label} timed out after ${ms}ms`));
  });
}

function wpRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    try { checkWpDeadline(`WP ${method} ${urlPath}`); } catch (e) { return reject(e); }
    const fullUrl = WP_SITE_URL.replace(/\/$/, "") + urlPath;
    const parsed = new URL(fullUrl);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString("base64");
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        "User-Agent": "ComedyHouston-BlogBot/1.0",
      },
    };
    if (bodyStr) options.headers["Content-Length"] = Buffer.byteLength(bodyStr);

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`WordPress API ${res.statusCode}: ${data.slice(0, 500)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Failed to parse WP response: ${e.message}`)); }
      });
    });
    attachRequestTimeout(req, WP_REQUEST_TIMEOUT_MS, `WP ${method} ${urlPath}`);
    req.on("error", (err) => reject(err));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function downloadImage(imageUrl, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 3;
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) return reject(new Error("Image download failed: too many redirects"));
    const parsed = new URL(imageUrl);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.get(imageUrl, { headers: { "User-Agent": "ComedyHouston-BlogBot/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadImage(res.headers.location, redirectsLeft - 1).then(resolve).catch(reject);
      }
      if (res.statusCode >= 400) return reject(new Error(`Image download failed: HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers["content-type"] || "image/jpeg" }));
      res.on("error", reject);
    });
    attachRequestTimeout(req, WP_REQUEST_TIMEOUT_MS, `downloadImage ${imageUrl.slice(0, 60)}`);
    req.on("error", reject);
  });
}

function wpUploadImage(imageBuffer, contentType, filename) {
  return new Promise((resolve, reject) => {
    try { checkWpDeadline(`WP media upload ${filename}`); } catch (e) { return reject(e); }
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
        if (res.statusCode >= 400) return reject(new Error(`WP media upload ${res.statusCode}: ${data.slice(0, 500)}`));
        try { resolve(JSON.parse(data).id); } catch (e) { reject(new Error(`Failed to parse WP media response: ${e.message}`)); }
      });
    });
    attachRequestTimeout(req, WP_UPLOAD_TIMEOUT_MS, `WP media upload ${filename}`);
    req.on("error", (err) => reject(err));
    req.write(imageBuffer);
    req.end();
  });
}

async function wpGetCategoryBySlug(slug) {
  try {
    const categories = await wpRequest("GET", `/wp-json/wp/v2/categories?slug=${encodeURIComponent(slug)}`, null);
    if (Array.isArray(categories) && categories.length > 0) return categories[0].id;
  } catch (err) { console.warn(`  Could not look up category "${slug}": ${err.message}`); }
  return 0;
}

// ---------------------------------------------------------------------------
// Research comedians via web search
// ---------------------------------------------------------------------------

function researchComedians(comedianNames) {
  const input = `Search the web for current information about these comedians who are performing in Houston this week:

${comedianNames.map((name) => `- ${name}`).join("\n")}

For EACH comedian, return a JSON object with these fields:
{
  "name": "Comedian Name",
  "summary": "3-4 sentence research summary with SPECIFIC special titles, show names, podcast names. No generic praise.",
  "sourceUrls": ["https://en.wikipedia.org/wiki/...", "https://www.netflix.com/title/...", "https://www.youtube.com/..."],
  "headshotPageUrls": ["https://en.wikipedia.org/wiki/Comedian_Name", "https://www.imdb.com/name/...", "https://comedianname.com"]
}

IMPORTANT:
- "sourceUrls": 2-3 real, verifiable URLs where readers can learn more (Wikipedia, IMDB, Netflix page, YouTube special, interview). These will be hyperlinked in the blog post.
- "headshotPageUrls": 2-4 pages likely to have a good headshot photo (Wikipedia, IMDB, official site, press page). These are for image extraction, NOT displayed to users.
- "summary": Use SPECIFIC NAMES AND TITLES, not generic descriptions. If you can't find reliable info, say so.

Return ONLY a JSON array of these objects, no other text.`;

  const instructions =
    "You are a comedy research assistant. Search the web to find accurate, current information about each comedian. Cite specific show titles, special names, and verifiable facts. Return structured JSON with source URLs and headshot page URLs. If you cannot find information about a comedian, say so rather than guessing.";

  return callOpenAIResponses(input, instructions);
}

// ---------------------------------------------------------------------------
// Look up Instagram handles via web search
// ---------------------------------------------------------------------------

function lookupInstagramHandles(comedianNames) {
  const input = `Find the official Instagram handles for EACH of these comedians. You MUST search for EVERY single person on this list individually — do not skip anyone:

${comedianNames.map((name) => `- ${name}`).join("\n")}

SEARCH STRATEGY — for EACH comedian, try ALL of these approaches:
1. Search "[comedian name] instagram" directly
2. Search "[comedian name] comedian social media"
3. Search "[comedian name] official website" — their site often links to their Instagram
4. Search "[comedian name] linktree" — Linktree pages list all social handles
5. Check if their Instagram handle is simply their name with no spaces (very common for comedians — e.g., Bill Burr = @wilfredburr, Katt Williams = @kattwilliams, Michelle Buteau = @michellebuteau)

Most working comedians — especially anyone with Netflix specials, HBO specials, or national tours — WILL have an Instagram account. If someone is famous enough to headline a comedy club, they almost certainly have an Instagram. Try harder before returning null.

Return ONLY a JSON array of objects with "name" (comedian name) and "instagram" (their handle including the @ symbol, or null if truly not found). Example:
[{"name": "Ali Siddiq", "instagram": "@alisiddiq"}, {"name": "Unknown Local Comic", "instagram": null}]

IMPORTANT:
- Search for EVERY comedian on the list. Do not stop after finding 2-3.
- Most of these people WILL have Instagram accounts. null should be rare, not the default.
- Do NOT guess or fabricate handles — but DO search thoroughly before giving up.
- Return ONLY the JSON array, no other text.`;

  const instructions =
    "You are a social media research assistant. Your job is to search the web and find the Instagram handle for EVERY comedian on the list. Search thoroughly for each person — try multiple search queries per comedian. These are professional comedians; most of them have Instagram accounts. Only return null if you genuinely cannot find their handle after searching.";

  return callOpenAIResponses(input, instructions);
}

// ---------------------------------------------------------------------------
// Identify top comedians via OpenAI
// ---------------------------------------------------------------------------

function identifyTopComedians(events) {
  const eventNames = events
    .filter((ev) => {
      const name = ev.name.toLowerCase();
      // Skip open mics, showcases, karaoke, and generic recurring events
      return (
        !name.includes("open mic") &&
        !name.includes("showcase") &&
        !name.includes("karaoke") &&
        !name.includes("showdown") &&
        !name.includes("dating")
      );
    })
    .map((ev) => ev.name);

  // Deduplicate names (same comedian may have multiple dates)
  const unique = [...new Set(eventNames)];

  const prompt = `Here is a list of comedy show names happening in Houston this week. Identify ALL that feature recognizable comedians — anyone with Netflix/HBO/Comedy Central specials, TV appearances, major podcast appearances, sold-out tours, large social media followings (100k+), etc. Don't limit yourself to a fixed number. If there are no recognizable names, return an empty array.

Shows:
${unique.map((n) => `- ${n}`).join("\n")}

Return ONLY a JSON array of objects with "name" (the comedian's name, not the event title) and "show" (the event title exactly as listed). Example:
[{"name": "Ali Siddiq", "show": "Ali Siddiq"}, {"name": "Greg Fitzsimmons", "show": "Greg Fitzsimmons"}]

Return ONLY the JSON array, no other text.`;

  return callOpenAI(prompt, "You are a comedy expert. Return only valid JSON.");
}

// ---------------------------------------------------------------------------
// HTML hero creative (replaces DALL-E)
// ---------------------------------------------------------------------------

function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// isUsableImageUrl + buildInitialsPlaceholder are imported from the shared
// image-utils lib. The hero creative below uses pickDisplayImage() to apply
// the inverted preference rule: event image is the floor, scraped headshot
// only wins if it cleared the strict gate earlier in the pipeline.

function generateHeroCreativeHTML(comedians, weekRange) {
  // Take up to 6 comedians. Each one's displayImage is set via the inverted
  // preference rule in pickDisplayImage(): event image first, strict-gated
  // headshot only if it beat the floor, branded initials SVG as last resort.
  const featured = comedians.slice(0, 6).map((c) => {
    // Respect an already-chosen displayImage (set upstream by the strict-gate
    // pipeline in main() so both the hero and the per-comedian spotlights use
    // the same decision).
    if (c.displayImage) return { ...c };
    const { displayImage } = pickDisplayImage({
      eventImageUrl: c.imageUrl,
      validatedHeadshotUrl: c.headshotUrl,
      comedianName: c.name,
    });
    return { ...c, displayImage };
  });

  // Adaptive grid: 2x2 for 4 comedians, 3-col for 5–6, single row for 1–3.
  const count = featured.length;
  let gridClass = "cols-3";
  if (count === 4) gridClass = "cols-2";
  else if (count <= 3) gridClass = `cols-${Math.max(count, 1)}`;

  const gridItems = featured
    .map(
      (c) => `      <div class="grid-item">
        <img src="${escapeHTML(c.displayImage)}" alt="${escapeHTML(c.name)}">
        <div class="grid-name">${escapeHTML(c.name)}</div>
      </div>`
    )
    .join("\n");
  // Keep `withImages` name available below for the "extra lineup" diff.
  const withImages = featured;

  // List any remaining comedian names that didn't make the image grid
  const gridNames = new Set(withImages.map((c) => c.name));
  const extraNames = comedians.filter((c) => !gridNames.has(c.name));
  const extraItems = extraNames
    .map((c) => `      <span class="extra-name">${escapeHTML(c.name)}</span>`)
    .join("\n");
  const extraSection =
    extraNames.length > 0
      ? `  <div class="extra-lineup">\n${extraItems}\n  </div>`
      : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 1080px;
      height: 1080px;
      font-family: 'Inter', sans-serif;
      background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 50%, #16213e 100%);
      color: #f0f0f5;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      overflow: hidden;
      position: relative;
    }
    .bg-accent {
      position: absolute;
      width: 500px;
      height: 500px;
      border-radius: 50%;
      filter: blur(140px);
      opacity: 0.15;
    }
    .bg-accent-1 { background: #ff4d6a; top: -150px; right: -100px; }
    .bg-accent-2 { background: #7c5cff; bottom: -150px; left: -100px; }
    .header-label {
      font-size: 16px;
      font-weight: 600;
      letter-spacing: 5px;
      text-transform: uppercase;
      color: #ff4d6a;
      margin-bottom: 8px;
      z-index: 1;
    }
    .title {
      font-size: 48px;
      font-weight: 900;
      letter-spacing: -1px;
      margin-bottom: 36px;
      z-index: 1;
      text-align: center;
    }
    .headshot-grid {
      display: grid;
      gap: 32px 48px;
      z-index: 1;
      margin-bottom: 28px;
      justify-items: center;
    }
    .headshot-grid.cols-1 { grid-template-columns: 1fr; max-width: 360px; }
    .headshot-grid.cols-2 { grid-template-columns: repeat(2, 1fr); max-width: 640px; }
    .headshot-grid.cols-3 { grid-template-columns: repeat(3, 1fr); max-width: 720px; gap: 24px 40px; }
    .grid-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }
    .grid-item img {
      width: 180px;
      height: 180px;
      border-radius: 50%;
      object-fit: cover;
      border: 3px solid rgba(255, 77, 106, 0.5);
    }
    /* When fewer comedians are featured, give each one more visual weight. */
    .headshot-grid.cols-2 .grid-item img,
    .headshot-grid.cols-1 .grid-item img {
      width: 260px;
      height: 260px;
      border-width: 4px;
    }
    .headshot-grid.cols-2 .grid-name,
    .headshot-grid.cols-1 .grid-name {
      font-size: 22px;
      max-width: 260px;
    }
    .grid-name {
      font-size: 17px;
      font-weight: 700;
      color: #ffffff;
      text-align: center;
      max-width: 180px;
    }
    .extra-lineup {
      display: flex;
      gap: 16px;
      z-index: 1;
      margin-bottom: 24px;
      flex-wrap: wrap;
      justify-content: center;
      max-width: 800px;
    }
    .extra-name {
      font-size: 16px;
      font-weight: 600;
      color: #9999aa;
      padding: 2px 12px;
      border-left: 2px solid #ff4d6a;
    }
    .week-range {
      font-size: 20px;
      font-weight: 500;
      color: #9999aa;
      z-index: 1;
    }
    .brand {
      position: absolute;
      bottom: 28px;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 2px;
      color: #666677;
      z-index: 1;
    }
  </style>
</head>
<body>
  <div class="bg-accent bg-accent-1"></div>
  <div class="bg-accent bg-accent-2"></div>
  <div class="header-label">This Week In</div>
  <div class="title">Houston Comedy</div>
  <div class="headshot-grid ${gridClass}">
${gridItems}
  </div>
${extraSection}
  <div class="week-range">${escapeHTML(weekRange)}</div>
  <div class="brand">COMEDYHOUSTON.COM</div>
</body>
</html>`;
}

function generateInlineHeroHTML(comedians, weekRange) {
  // Pick up to 6 comedians with images for a 3x2 grid. Prefer the
  // already-validated displayImage (set by Step 2b in main) and fall back
  // to the event image for any comedian that didn't run through 2b.
  const resolve = (c) => c.displayImage || c.imageUrl || "";
  const withImages = comedians.filter((c) => resolve(c)).slice(0, 6);
  const gridItems = withImages
    .map(
      (c) => `        <div class="hero-grid-item">
          <img src="${escapeHTML(resolve(c))}" alt="${escapeHTML(c.name)}">
          <div class="hero-grid-name">${escapeHTML(c.name)}</div>
        </div>`
    )
    .join("\n");

  // List remaining names
  const gridNames = new Set(withImages.map((c) => c.name));
  const extraNames = comedians.filter((c) => !gridNames.has(c.name));
  const extraItems = extraNames
    .map((c) => `        <span class="hero-extra-name">${escapeHTML(c.name)}</span>`)
    .join("\n");
  const extraSection =
    extraNames.length > 0
      ? `      <div class="hero-extra-lineup">\n${extraItems}\n      </div>`
      : "";

  return `    <div class="hero-creative">
      <div class="hero-label">This Week In</div>
      <div class="hero-title">Houston Comedy</div>
      <div class="hero-grid">
${gridItems}
      </div>
${extraSection}
      <div class="hero-dates">${escapeHTML(weekRange)}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Instagram caption generation
// ---------------------------------------------------------------------------

function generateInstagramCaption(comedianNames, weekRange, instagramHandles, comedianResearch) {
  const namesList = comedianNames.slice(0, 6).join(", ");

  // Build the handles section for the prompt
  const handlesFound = instagramHandles || {};
  const handleEntries = Object.entries(handlesFound).filter(([, handle]) => handle);
  const handlesList = handleEntries.map(([, handle]) => handle).join(" ");

  // Build research context so the caption can reference real credits
  const researchSection = comedianResearch
    ? `\nBACKGROUND ON THESE COMEDIANS (use this to write specific, informed copy — do NOT dump all of it into the caption, just pick 1-2 details that make the best hook):\n\n${comedianResearch}\n`
    : "";

  const prompt = `Write an Instagram caption for Comedy Houston's weekly post.

Week: ${weekRange}
Featured comedians: ${namesList}
${researchSection}
STRUCTURE (follow this exact format):

1. HOOK (1 sentence): Address Houston directly. Use a SPECIFIC detail from the research to make it interesting — a comedian's real special title, a real credit, something concrete. Not "great comedy this week" but something like "The guy behind Netflix's 'The Domino Effect' is in Houston this Thursday." Make it feel like insider knowledge, not an ad.

2. THE PITCH (2-3 sentences): Recommend 2-3 of the biggest names with ONE specific, real detail each — a special title, a podcast they host, a show they were on. Don't stack adjectives. Just state the fact and let it speak. Frame it as a personal recommendation for a night out.

3. CTA (1 sentence): Simple and direct. Link in bio. Grab tickets. Tag someone you'd bring.

4. HASHTAGS (on a new line): #HoustonComedy #StandUp #LiveComedy #DateNightHouston #ThingsToDoInHouston

5. COMEDIAN TAGS (on a new line after hashtags): List ALL of the following Instagram handles on their own line, separated by spaces. Do NOT skip any. Do NOT invent handles. ONLY use the exact handles provided here:${handlesList ? `\n${handlesList}` : "\n(No handles available — skip this section entirely)"}

RULES:
- Caption body (sections 1-3): 110-150 words. Enough room to mention 3-4 comedians with real credits, not enough to ramble.
- NO emojis except 🎤 once (optional). Zero is also fine.
- Every comedian you mention MUST have a real, verifiable credit attached. No "known for his hilarious style." Either name the special/show/podcast or don't mention them.
- NO hyperbole. No "masterclass." No "redefine comedy." No "hotter than a Texas summer." Just be real.
- NO AI filler phrases: "But wait, there's more," "This isn't just X, it's Y," "Don't just hear about it — be about it." These are banned.
- Write at a 6th grade reading level. Short sentences. Plain words.
- The voice is a friend who actually follows comedy telling you what's good this week — not a copywriter.
- The comedian handles section MUST use ONLY the exact handles listed above. Never make up a handle.`;

  return callOpenAI(
    prompt,
    "You are writing an Instagram caption for a local comedy publication. Your influences are Seth Godin (be minimal, say less, mean more) and Roy H. Williams aka the Wizard of Ads (speak to one person, be honest, earn trust). You write clean, modern copy that converts because it's genuine — not because it's loud. No AI voice. No marketing fluff. Just a clear, warm, specific recommendation backed by real facts."
  );
}

// ---------------------------------------------------------------------------
// Build the prompt
// ---------------------------------------------------------------------------

function buildPrompt(events, weekRange, comedianResearch, comedianSourceLinks) {
  const eventList = events
    .map((ev, idx) => {
      const parts = [`- **${ev.name}** [EVENT_ID: ${idx}]`];
      parts.push(`  Venue: ${ev.venue}`);
      parts.push(`  Date: ${formatDateForDisplay(ev.date)}`);
      if (ev.day_of_week) parts.push(`  Day: ${ev.day_of_week}`);
      if (ev.time) parts.push(`  Time: ${ev.time}`);
      if (ev.price_min !== null) {
        const price =
          ev.price_min === ev.price_max || ev.price_max === null
            ? `$${ev.price_min}`
            : `$${ev.price_min} – $${ev.price_max}`;
        parts.push(`  Price: ${price}`);
      }
      if (ev.description) {
        const desc =
          ev.description.length > 300
            ? ev.description.slice(0, 300) + "..."
            : ev.description;
        parts.push(`  Description: ${desc}`);
      }
      if (ev.ticket_url) parts.push(`  Tickets: ${ev.ticket_url}`);
      if (ev.image_url) parts.push(`  Image: ${ev.image_url}`);
      return parts.join("\n");
    })
    .join("\n\n");

  const researchSection = comedianResearch
    ? `\n\nCOMEDIAN RESEARCH (from web search — use this for accurate, current blurbs):\n\n${comedianResearch}\n`
    : "";

  // Build source links context for the prompt
  let sourceLinksSection = "";
  if (comedianSourceLinks && Object.keys(comedianSourceLinks).length > 0) {
    sourceLinksSection = "\n\nSOURCE LINKS PER COMEDIAN (use 1-2 of these as hyperlinks in each comedian's blurb):\n";
    for (const [name, urls] of Object.entries(comedianSourceLinks)) {
      sourceLinksSection += `- ${name}: ${urls.join(", ")}\n`;
    }
  }

  return `Write a blog post about Houston comedy shows for the week of ${weekRange}.

Here are the ${events.length} events happening this week:

${eventList}
${researchSection}${sourceLinksSection}
Requirements:

WORD COUNT: Aim for ~600 words of article body text (not counting HTML tags). This is a tight, punchy roundup — every sentence earns its place.

COMEDIAN DEEP DIVES (this is the MOST IMPORTANT part — this is what makes this blog post worth reading):

You MUST identify the most well-known, nationally recognized comedians performing this week and write a DETAILED two-sentence blurb for each one. These blurbs are the heart of the blog post.

Rules for the blurbs:
- Write a blurb for EVERY comedian you genuinely recognize as having a notable presence — Netflix specials, HBO specials, Comedy Central specials, late night TV appearances, major podcasts like Joe Rogan / Kill Tony / Tigerbelly, viral clips, sitcom roles, movies, comedy albums, tours, large social media followings (100k+), etc. Don't skip someone just because you already wrote about others.
- For EACH one, write EXACTLY two sentences that are specific and personal:
  - Sentence 1: What they're specifically known for — name the ACTUAL special titles, show names, podcast names, movie titles, etc. Be concrete. Not "known for his relatable humor" but "broke out with his Netflix hour 'The Domino Effect' and his legendary storytelling segments on 'This Is Not Happening'"
  - Sentence 2: What the audience can expect at the live show — their style, energy, what makes their live performance different or special. For example: "His live sets are marathon storytelling sessions that feel like sitting around a campfire with the funniest person you've ever met — raw, unpredictable, and impossible to look away from."
- For EACH comedian blurb, include 1-2 hyperlinks to credible sources (Wikipedia page, Netflix special page, YouTube clip, IMDB page, etc.). Use the SOURCE LINKS provided above if available. Wrap them naturally: e.g., "broke out with his Netflix hour <a href="URL">The Domino Effect</a>". Do NOT dump bare URLs — weave them into the text.
- Write these blurbs using a <p class="blurb"> tag inside the show-info div
- If a comedian appears multiple times in the week (e.g., Thursday + Friday + Saturday), write the full blurb ONLY on their first appearance. For subsequent dates, write one sentence like "Another chance to catch [Name] — see Thursday's listing for why you don't want to miss this."
- If you DON'T genuinely recognize a comedian, DO NOT write a blurb. Do NOT fabricate credits. Just present the event details. Silence is better than filler.
- For open mic nights, showcases, karaoke, or multi-act variety shows — write one sentence about the vibe/format of the event instead of comedian blurbs.

MINIMUM OUTPUT: At least 2 comedians with 2-sentence blurbs.
There is NO maximum — if 6 comedians are recognizable, write blurbs for all 6. Every comedian with verifiable credits deserves a blurb. If there genuinely are fewer than 2 recognizable names this week, that's OK — just say so in the intro.

INTRO PARAGRAPH:
- Open with an engaging 2-3 sentence intro that specifically names the biggest acts of the week and why they're a big deal
- Don't be generic ("Houston is bursting with laughs!"). Instead: "Ali Siddiq brings his raw prison-to-stage storytelling to the Improv this week, and if you haven't seen Greg Fitzsimmons' razor-sharp crowd work, Friday at Punch Line is your shot."
- Set the tone like you're texting a friend who asked "what's good in comedy this week?"

IMAGES:
- For EVERY event that has an Image URL listed above, you MUST embed it using this exact HTML structure:
  <div class="show-card">
    <img src="THE_IMAGE_URL" alt="EVENT NAME" class="show-img" loading="lazy">
    <div class="show-info">
      ...show details here...
    </div>
  </div>
- For events without an image, use the same structure but skip the <img> tag
- The image and show info should appear side-by-side (the CSS handles this)

STRUCTURE:
- Group events by day of the week (Monday, Tuesday, etc.) — only include days that have events
- Use <h2> for the blog post title
- Use <h3> for each day heading (e.g., "Thursday" or "Friday Night")
- Within each day, use a <div class="show-card"> for each event
- For each event's show-info div, include: show name in <strong>, venue, time, price (each on a line with <br>), the <p class="blurb"> if applicable, and a "Get Tickets" link
- End with a short 1-2 sentence outro encouraging people to grab tickets early, mentioning which shows are most likely to sell out

FORMAT:
- Output ONLY the blog post content in HTML (just the article body — no <html>, <head>, or <body> tags)
- Use semantic HTML: <h2>, <h3>, <p>, <a>, <strong>
- Wrap ticket links in <a class="ticket-link" href="URL">Get Tickets</a>
- Comedian blurbs go in <p class="blurb"> tags
- Keep it conversational and knowledgeable — you're a comedy nerd who actually follows these comedians, not a marketing intern generating copy`;
}

const SYSTEM_PROMPT = `You are a Houston comedy scene blogger who ACTUALLY follows stand-up comedy closely. You write the weekly roundup for ComedyHouston.com. You have deep, specific knowledge of the comedy world:

- You know specific Netflix/HBO/Comedy Central special TITLES (not just "they have a special")
- You know which podcasts comedians host or have appeared on (Joe Rogan, Kill Tony, Tigerbelly, Your Mom's House, WTF with Marc Maron, etc.)
- You know breakout moments: Last Comic Standing seasons, Comedy Central roasts, viral clips, late night sets
- You know comedians' STYLES: storytelling vs. one-liners vs. crowd work vs. observational vs. dark humor

CRITICAL RULES:
1. When you write a blurb about a comedian, you MUST include at least one SPECIFIC, VERIFIABLE credit (a named special, a named show, a named podcast). "Known for his hilarious style" is BANNED. "Known for his Netflix hour 'The Domino Effect'" is correct.
2. If you cannot name a specific credit for a comedian, DO NOT write a blurb. Just list the event details.
3. Never describe a comedian as "a rising star" or "up-and-coming" or "known for relatable humor" — these are empty filler phrases. Either you know specific things about them or you stay silent.
4. Write like you're texting a friend, not writing marketing copy. No exclamation points in every sentence. Be genuine.
5. BANNED PHRASES: "don't miss", "side-splitting", "laugh-out-loud", "gut-busting", "rib-tickling", "a night to remember", "Houston's comedy scene", "Whether you're a fan of", "Something for everyone", "masterclass", "comedic genius", "redefine comedy", "hotter than a Texas summer", "buckle up", "prepare to". These are generic filler — replace with specific facts.
6. Each comedian blurb MUST include 1-2 hyperlinks to real sources (Wikipedia, Netflix, YouTube, IMDB). Weave them into the text naturally.

You write in clean, semantic HTML using the CSS classes specified in the prompt. You always include practical details (day, time, venue, price, ticket links) and embed event images when provided.`;

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function wrapInHTML(blogContent, weekRange, generatedAt, inlineHeroHTML) {

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>This Week in Houston Comedy — ${weekRange}</title>
  <meta name="description" content="Your weekly roundup of every comedy show in Houston for ${weekRange}. Find shows at Houston Improv, The Riot, The Secret Group, and more.">
  <meta property="og:image" content="weekly-hero.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg-primary: #0a0a0f;
      --bg-secondary: #12121a;
      --bg-card: #1a1a26;
      --border: #2a2a3a;
      --text-primary: #f0f0f5;
      --text-secondary: #9999aa;
      --text-muted: #666677;
      --accent: #ff4d6a;
      --accent-hover: #ff6b83;
      --accent-secondary: #7c5cff;
      --radius: 12px;
      --transition: 0.2s ease;
    }

    html { scroll-behavior: smooth; -webkit-font-smoothing: antialiased; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.7;
      min-height: 100vh;
    }

    a { color: var(--accent); text-decoration: none; transition: color var(--transition); }
    a:hover { color: var(--accent-hover); text-decoration: underline; }

    .container {
      max-width: 760px;
      margin: 0 auto;
      padding: 40px 24px 80px;
    }

    .header-nav {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 40px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }

    .header-nav a {
      color: var(--text-secondary);
      font-size: 0.9rem;
      font-weight: 500;
    }

    .header-nav .brand {
      font-size: 1.1rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--accent), var(--accent-secondary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .header-nav .sep { color: var(--text-muted); }

    .hero-creative {
      background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 50%, #16213e 100%);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 48px 32px;
      margin-bottom: 32px;
      text-align: center;
      position: relative;
      overflow: hidden;
    }

    .hero-creative::before,
    .hero-creative::after {
      content: '';
      position: absolute;
      width: 300px;
      height: 300px;
      border-radius: 50%;
      filter: blur(100px);
      opacity: 0.15;
    }

    .hero-creative::before {
      background: var(--accent);
      top: -100px;
      right: -50px;
    }

    .hero-creative::after {
      background: var(--accent-secondary);
      bottom: -100px;
      left: -50px;
    }

    .hero-label {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 3px;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 8px;
      position: relative;
      z-index: 1;
    }

    .hero-title {
      font-size: 2rem;
      font-weight: 900;
      letter-spacing: -1px;
      margin-bottom: 24px;
      position: relative;
      z-index: 1;
    }

    .hero-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px 24px;
      justify-items: center;
      margin-bottom: 20px;
      position: relative;
      z-index: 1;
      max-width: 480px;
      margin-left: auto;
      margin-right: auto;
    }

    .hero-grid-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }

    .hero-grid-item img {
      width: 100px;
      height: 100px;
      border-radius: 50%;
      object-fit: cover;
      border: 3px solid rgba(255, 77, 106, 0.4);
    }

    .hero-grid-name {
      font-size: 0.85rem;
      font-weight: 700;
      text-align: center;
      max-width: 120px;
    }

    .hero-extra-lineup {
      display: flex;
      gap: 12px;
      justify-content: center;
      flex-wrap: wrap;
      margin-bottom: 20px;
      position: relative;
      z-index: 1;
    }

    .hero-extra-name {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--text-secondary);
      padding: 2px 10px;
      border-left: 2px solid var(--accent);
    }

    .hero-dates {
      font-size: 0.95rem;
      font-weight: 500;
      color: var(--text-secondary);
      position: relative;
      z-index: 1;
    }

    article h2 {
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.2;
      margin-bottom: 8px;
    }

    .meta {
      color: var(--text-secondary);
      font-size: 0.9rem;
      margin-bottom: 32px;
    }

    article h3 {
      font-size: 1.3rem;
      font-weight: 700;
      margin-top: 36px;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
      color: var(--accent);
    }

    article p {
      margin-bottom: 16px;
      color: var(--text-secondary);
    }

    article strong { color: var(--text-primary); }

    article ul, article ol {
      margin-bottom: 16px;
      padding-left: 24px;
      color: var(--text-secondary);
    }

    article li { margin-bottom: 8px; }

    .show-card {
      display: flex;
      gap: 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      margin-bottom: 20px;
      transition: border-color var(--transition);
    }

    .show-card:hover {
      border-color: #3a3a4f;
    }

    .show-img {
      width: 180px;
      min-width: 180px;
      height: 180px;
      object-fit: cover;
      border-radius: 8px;
      flex-shrink: 0;
    }

    .show-info {
      flex: 1;
      min-width: 0;
    }

    .show-info p {
      margin-bottom: 8px;
      font-size: 0.95rem;
    }

    .show-info strong {
      font-size: 1.1rem;
    }

    .show-info .blurb {
      font-style: italic;
      color: var(--text-secondary);
      margin-top: 4px;
      margin-bottom: 10px;
      font-size: 0.9rem;
      line-height: 1.5;
    }

    .show-info .details {
      color: var(--text-muted);
      font-size: 0.88rem;
    }

    .ticket-link {
      display: inline-block;
      margin-top: 10px;
      padding: 6px 16px;
      background: var(--accent);
      color: #fff !important;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 600;
      transition: background var(--transition);
    }

    .ticket-link:hover {
      background: var(--accent-hover);
      text-decoration: none !important;
    }

    @media (max-width: 640px) {
      .show-card {
        flex-direction: column;
        gap: 14px;
      }

      .show-img {
        width: 100%;
        min-width: unset;
        height: 200px;
      }
    }

    .footer {
      margin-top: 60px;
      padding-top: 24px;
      border-top: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 0.85rem;
      text-align: center;
    }

    @media (max-width: 640px) {
      article h2 { font-size: 1.5rem; }
      article h3 { font-size: 1.15rem; }
      .container { padding: 24px 16px 60px; }
      .hero-creative { padding: 32px 20px; }
      .hero-grid-item img { width: 80px; height: 80px; }
      .hero-grid-name { font-size: 0.8rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <nav class="header-nav">
      <a href="/" class="brand">Comedy Houston</a>
      <span class="sep">/</span>
      <a href="/blog/">Weekly Blog</a>
    </nav>
${inlineHeroHTML}

    <article>
${blogContent}
    </article>

    <div class="meta" style="margin-top: 24px;">
      Generated on ${generatedAt}
    </div>

    <footer class="footer">
      <p>
        <a href="/">Browse all shows</a> &middot;
        Powered by Comedy Houston &middot;
        Updated weekly
      </p>
    </footer>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Comedy Houston — Weekly Blog Post Generator ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log("");

  if (!OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY environment variable is not set.");
    process.exit(1);
  }

  // Detect if this is a Thursday "weekend-only" refresh
  const dayOfWeek = new Date().getDay(); // 0=Sun, 4=Thu
  const isThursdayRefresh = dayOfWeek === 4;
  if (isThursdayRefresh) {
    console.log("Thursday detected — running weekend post refresh only.");
    console.log("");
  }

  // Load and filter events
  const { events, monday, sunday } = loadThisWeeksEvents();

  if (events.length === 0) {
    console.log("No events found for this week. Skipping blog generation.");
    process.exit(0);
  }

  const weekRange = formatWeekRange(monday, sunday);
  console.log(`Week range: ${weekRange}`);
  console.log("");

  // Thursday: only update the weekend post, then exit
  if (isThursdayRefresh) {
    if (WP_ENABLED) {
      console.log("Updating 'This Weekend' evergreen post on WordPress...");
      // Quick comedian identification for the weekend post
      let quickComedians = [];
      let quickResearch = "";
      let quickSourceLinks = {};
      try {
        const topComediansRaw = await identifyTopComedians(events);
        const jsonStr = topComediansRaw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        const parsed = JSON.parse(jsonStr);
        quickComedians = parsed.map((c) => {
          const matchedEvent = events.find(
            (ev) => ev.name === c.show || ev.name.toLowerCase().includes(c.name.toLowerCase())
          );
          return { name: c.name, show: c.show, imageUrl: matchedEvent?.image_url || null };
        });
        // Deduplicate
        const seen = new Set();
        quickComedians = quickComedians.filter((c) => {
          const key = c.name.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        console.log(`Comedians identified: ${quickComedians.map((c) => c.name).join(", ")}`);

        // Quick research for weekend post copy
        if (quickComedians.length > 0) {
          const researchRaw = await researchComedians(quickComedians.map((c) => c.name));
          const researchJson = researchRaw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          try {
            const researchParsed = JSON.parse(researchJson);
            const summaries = [];
            for (const entry of researchParsed) {
              if (entry.name && entry.summary) summaries.push(`**${entry.name}**: ${entry.summary}`);
              if (entry.name && entry.sourceUrls) quickSourceLinks[entry.name] = entry.sourceUrls;
            }
            quickResearch = summaries.join("\n\n");
          } catch (_) {
            quickResearch = researchRaw;
          }
        }
      } catch (err) {
        console.warn(`Comedian identification failed: ${err.message}`);
      }

      try {
        await updateWeekendPost(events, weekRange, quickComedians, quickResearch, quickSourceLinks);
      } catch (err) {
        console.warn(`Weekend post update failed: ${err.message}`);
      }
    } else {
      console.log("WordPress not configured — nothing to do on Thursday.");
    }
    console.log("");
    console.log("Done! (Thursday refresh)");
    return;
  }

  // Ensure blog directory exists
  if (!fs.existsSync(BLOG_DIR)) {
    fs.mkdirSync(BLOG_DIR, { recursive: true });
  }

  // Step 1: Identify top comedians
  console.log("Identifying top comedians...");
  let topComedians = []; // [{name, show, imageUrl}]

  try {
    const topComediansRaw = await identifyTopComedians(events);
    // Parse JSON from the response (handle potential markdown wrapping)
    const jsonStr = topComediansRaw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(jsonStr);
    // Match each comedian back to their event to grab the image URL
    topComedians = parsed.map((c) => {
      const matchedEvent = events.find(
        (ev) => ev.name === c.show || ev.name.toLowerCase().includes(c.name.toLowerCase())
      );
      return {
        name: c.name,
        show: c.show,
        imageUrl: matchedEvent?.image_url || null,
      };
    });
    // Deduplicate by comedian name (OpenAI sometimes returns the same person twice)
    const seen = new Set();
    topComedians = topComedians.filter((c) => {
      const key = c.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    console.log(`Top comedians identified: ${topComedians.map((c) => c.name).join(", ")}`);
    console.log("");
    // Handoff JSON is written below after Step 2b, once displayImage has
    // been resolved via the strict-gate pipeline. That way generate-comedian-
    // post.js consumes the already-validated image and doesn't re-scrape.
  } catch (err) {
    console.warn(`Warning: Could not identify top comedians: ${err.message}`);
    console.log("");
  }

  const topComedianNames = topComedians.map((c) => c.name);

  // Step 2: Research comedians via web search (returns structured JSON now)
  let comedianResearch = "";
  let comedianSourceLinks = {}; // { "Name": ["url1", "url2"] }
  let comedianHeadshotPages = {}; // { "Name": ["page1", "page2"] }
  if (topComedianNames.length > 0) {
    console.log("Researching comedians via web search...");
    try {
      const researchRaw = await researchComedians(topComedianNames);
      const researchJson = researchRaw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      try {
        const researchParsed = JSON.parse(researchJson);
        // Build the text summary for the blog prompt
        const summaries = [];
        for (const entry of researchParsed) {
          if (entry.name && entry.summary) summaries.push(`**${entry.name}**: ${entry.summary}`);
          if (entry.name && entry.sourceUrls && entry.sourceUrls.length > 0) {
            comedianSourceLinks[entry.name] = entry.sourceUrls;
          }
          if (entry.name && entry.headshotPageUrls && entry.headshotPageUrls.length > 0) {
            comedianHeadshotPages[entry.name] = entry.headshotPageUrls;
          }
        }
        comedianResearch = summaries.join("\n\n");
        console.log(`Research completed for ${researchParsed.length} comedian(s).`);
        console.log(`Source links found for: ${Object.keys(comedianSourceLinks).join(", ") || "none"}`);
        console.log(`Headshot pages found for: ${Object.keys(comedianHeadshotPages).join(", ") || "none"}`);
      } catch (parseErr) {
        // Fallback: treat as plain text if JSON parsing fails
        console.warn(`Warning: Research JSON parse failed, using as plain text: ${parseErr.message}`);
        comedianResearch = researchRaw;
      }
      console.log("");
    } catch (err) {
      console.warn(`Warning: Comedian research failed: ${err.message}`);
      console.warn("Continuing without web research.");
      console.log("");
    }
  }

  // Step 2b: Try to upgrade each comedian's image. The event (ticket) image
  // is the FLOOR — we only replace it if a scraped headshot clears the
  // strict gate (URL blocklist + HEAD + bytes >= 20KB + dims >= 300x300 +
  // aspect ratio in [0.65, 1.55]). This inverts the old behavior, where
  // any HEAD-passing scraped image won over the event image and gave us
  // Instagram glyphs / silhouettes.
  //
  // Each comedian ends up with:
  //   - headshotUrl: strict-gated scraped headshot (or null)
  //   - displayImage: the final rendered image via pickDisplayImage()
  //   - imageSource: "headshot" | "event" | "initials" (for logging + handoff)
  if (topComedians.length > 0) {
    console.log("Finding headshot images for comedians (event image is the floor)...");
    for (const comedian of topComedians) {
      const pageUrls = comedianHeadshotPages[comedian.name] || [];
      if (pageUrls.length > 0) {
        try {
          console.log(`  ${comedian.name}: searching ${pageUrls.length} page(s)...`);
          const headshot = await findBestHeadshot(pageUrls, comedian.name);
          if (headshot) {
            console.log(`  ${comedian.name}: scraped headshot cleared strict gate → upgrade`);
            comedian.headshotUrl = headshot;
          } else {
            console.log(`  ${comedian.name}: no scraped candidate beat the strict gate → keeping event image`);
          }
        } catch (err) {
          console.log(`  ${comedian.name}: headshot search failed: ${err.message}`);
        }
      } else {
        console.log(`  ${comedian.name}: no candidate pages → keeping event image`);
      }

      // Apply the inverted preference rule once, store on the comedian
      // object so every downstream consumer (weekly hero HTML, inline
      // hero, WP landing page, handoff file for generate-comedian-post.js)
      // renders the same decision.
      const pick = pickDisplayImage({
        eventImageUrl: comedian.imageUrl,
        validatedHeadshotUrl: comedian.headshotUrl,
        comedianName: comedian.name,
      });
      comedian.displayImage = pick.displayImage;
      comedian.imageSource = pick.source;
      console.log(`  ${comedian.name}: displayImage source = ${pick.source}`);
    }
    console.log("");

    // Persist the selection so generate-comedian-post.js can consume it and
    // guarantee both workflows render the exact same comedians with the
    // exact same images (instead of each making its own OpenAI + scrape
    // round-trip and disagreeing).
    //
    // The `displayImage` field is the already-validated URL (either the
    // event image or a strict-gate-winning scraped headshot). The comedian
    // workflow reuses it directly and skips re-scraping — one round of
    // network work, not two, and guaranteed visual consistency.
    try {
      const handoffPath = path.join(BLOG_DIR, "top-comedians.json");
      fs.writeFileSync(
        handoffPath,
        JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            week_range: weekRange,
            comedians: topComedians.map((c) => ({
              name: c.name,
              show: c.show,
              imageUrl: c.imageUrl || null,
              headshotUrl: c.headshotUrl || null,
              displayImage: c.displayImage || null,
              imageSource: c.imageSource || null,
            })),
          },
          null,
          2
        )
      );
      console.log(`Wrote headliner handoff → ${handoffPath}`);
      console.log("");
    } catch (e) {
      console.warn(`Could not write top-comedians.json handoff: ${e.message}`);
    }
  }

  // Step 3: Generate hero creative HTML (replaces DALL-E)
  let inlineHeroHTML = "";
  if (topComedians.length > 0) {
    const heroHTML = generateHeroCreativeHTML(topComedians, weekRange);
    fs.writeFileSync(BLOG_HERO_HTML_PATH, heroHTML);
    console.log(`Wrote hero creative HTML: ${BLOG_HERO_HTML_PATH}`);
    inlineHeroHTML = generateInlineHeroHTML(topComedians, weekRange);

    // Render the hero HTML to PNG immediately so any downstream consumer
    // (especially the WordPress weekly-roundup publish below) uses *this*
    // week's image. Previously the workflow rendered the screenshot AFTER
    // generate-blog-post.js finished, which meant WP got last week's PNG
    // that was still committed in the repo.
    try {
      const screenshotScript = path.join(__dirname, "screenshot-hero.js");
      console.log("Rendering hero PNG via screenshot-hero.js...");
      const result = spawnSync(process.execPath, [screenshotScript], {
        stdio: "inherit",
      });
      if (result.status !== 0) {
        console.warn(`Warning: screenshot-hero.js exited with status ${result.status}. WP publish may use a stale image.`);
      }
    } catch (err) {
      console.warn(`Warning: could not render hero PNG inline: ${err.message}`);
    }
    console.log("");
  }

  // Step 4: Generate the blog post (with research context + source links)
  const prompt = buildPrompt(events, weekRange, comedianResearch, comedianSourceLinks);
  console.log(`Sending ${events.length} events to OpenAI (${OPENAI_MODEL})...`);

  let blogContent = await callOpenAI(prompt, SYSTEM_PROMPT);
  // Strip markdown code fences that OpenAI sometimes wraps around HTML output
  blogContent = blogContent.replace(/^```html\s*\n?/i, "").replace(/\n?```\s*$/g, "").trim();
  console.log("Blog post generated successfully.");
  console.log("");

  // Write the HTML file
  const generatedAt = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const html = wrapInHTML(blogContent, weekRange, generatedAt, inlineHeroHTML);
  fs.writeFileSync(BLOG_HTML_PATH, html);
  console.log(`Wrote ${BLOG_HTML_PATH}`);
  console.log("");

  // Step 5: Look up Instagram handles via web search
  let instagramHandles = {}; // { "Comedian Name": "@handle" or null }
  if (topComedianNames.length > 0) {
    console.log("Looking up Instagram handles...");
    try {
      const handlesRaw = await lookupInstagramHandles(topComedianNames);
      const handlesJson = handlesRaw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const handlesParsed = JSON.parse(handlesJson);
      for (const entry of handlesParsed) {
        if (entry.name && entry.instagram) {
          instagramHandles[entry.name] = entry.instagram;
        }
      }
      const found = Object.entries(instagramHandles);
      if (found.length > 0) {
        console.log(`Found ${found.length} Instagram handle(s):`);
        for (const [name, handle] of found) {
          console.log(`  ${name} → ${handle}`);
        }
      } else {
        console.log("No Instagram handles found.");
      }
      console.log("");
    } catch (err) {
      console.warn(`Warning: Instagram handle lookup failed: ${err.message}`);
      console.warn("Continuing without handles.");
      console.log("");
    }
  }

  // Step 6: Generate Instagram caption (with handles)
  if (topComedianNames.length > 0) {
    console.log("Generating Instagram caption...");
    try {
      let caption = await generateInstagramCaption(topComedianNames, weekRange, instagramHandles, comedianResearch);
      caption = caption.replace(/^```\w*\s*\n?/g, "").replace(/\n?```\s*$/g, "").trim();
      fs.writeFileSync(BLOG_CAPTION_PATH, caption);
      console.log(`Wrote Instagram caption: ${BLOG_CAPTION_PATH}`);
      console.log("");
    } catch (err) {
      console.warn(`Warning: Caption generation failed: ${err.message}`);
      console.log("");
    }
  }

  // Step 7: Publish weekly roundup to WordPress
  if (WP_ENABLED) {
    // Arm the cumulative WP budget. After this many ms across ALL WP
    // calls in the script, every subsequent call short-circuits with a
    // budget-exceeded error so the email step at the end of the workflow
    // still gets a chance to run. Each individual call also has its own
    // per-request timeout (WP_REQUEST_TIMEOUT_MS / WP_UPLOAD_TIMEOUT_MS).
    wpDeadline = Date.now() + WP_TOTAL_BUDGET_MS;
    console.log(`Publishing weekly roundup to WordPress... (cumulative budget: ${Math.round(WP_TOTAL_BUDGET_MS / 1000)}s)`);
    try {
      const wpTitle = `Houston Comedy Shows This Week — ${weekRange}`;
      const wpSlug = `houston-comedy-shows-this-week-${monday.toISOString().slice(0, 10)}`;

      // Build WordPress post content from the blog HTML (just the article body)
      let wpContent = blogContent;

      // Upload hero image as featured image
      let featuredMediaId = 0;
      const heroPngPath = path.join(BLOG_DIR, "weekly-hero.png");
      if (fs.existsSync(heroPngPath)) {
        try {
          console.log("  Uploading hero image to WordPress...");
          const heroBuffer = fs.readFileSync(heroPngPath);
          featuredMediaId = await wpUploadImage(heroBuffer, "image/png", `weekly-hero-${monday.toISOString().slice(0, 10)}.png`);
          console.log(`  Hero image uploaded (media ID: ${featuredMediaId})`);

          // Get the WP URL for the uploaded image
          try {
            const media = await wpRequest("GET", `/wp-json/wp/v2/media/${featuredMediaId}`, null);
            const wpHeroUrl = media.source_url || "";
            if (wpHeroUrl) {
              const heroFigure = `<figure class="wp-block-image size-large"><img src="${wpHeroUrl}" alt="Houston Comedy Shows This Week" class="wp-image-${featuredMediaId}"/></figure>\n\n`;
              wpContent = heroFigure + wpContent;
            }
          } catch (_) {}
        } catch (err) {
          // The hero image is the anchor visual for the weekly roundup — if
          // it fails to upload, abort the WP publish rather than silently
          // publishing an image-less post. The next scheduled run (or manual
          // re-trigger) will retry cleanly thanks to the slug-dedupe fix.
          console.error(`  ERROR: Hero image upload failed: ${err.message}`);
          throw new Error(`Weekly roundup aborted: hero image upload failed (${err.message})`);
        }
      } else {
        console.error(`  ERROR: weekly-hero.png not found at ${heroPngPath}`);
        throw new Error("Weekly roundup aborted: weekly-hero.png missing");
      }

      // Upload 1-2 comedian headshots inline
      const comediansWithHeadshots = topComedians.filter((c) => c.headshotUrl).slice(0, 2);
      for (const comedian of comediansWithHeadshots) {
        try {
          console.log(`  Uploading headshot for ${comedian.name}...`);
          const { buffer, contentType } = await downloadImage(comedian.headshotUrl);
          const ext = contentType.includes("png") ? "png" : "jpg";
          const imgFilename = `${comedian.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-headshot.${ext}`;
          const mediaId = await wpUploadImage(buffer, contentType, imgFilename);
          const media = await wpRequest("GET", `/wp-json/wp/v2/media/${mediaId}`, null);
          const imgUrl = media.source_url || comedian.headshotUrl;
          // Inject comedian headshot after the first mention of their name in the content
          const nameEscaped = comedian.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const nameRegex = new RegExp(`(</p>)`, "i");
          const imgTag = `\n<figure class="wp-block-image size-medium"><img src="${imgUrl}" alt="${comedian.name.replace(/"/g, '&quot;')}" class="wp-image-${mediaId}"/><figcaption>${comedian.name}</figcaption></figure>\n`;
          // Insert after the first paragraph that mentions the comedian
          const mentionRegex = new RegExp(`(${nameEscaped}[^<]*</p>)`, "i");
          if (mentionRegex.test(wpContent)) {
            wpContent = wpContent.replace(mentionRegex, `$1${imgTag}`);
            console.log(`  Headshot for ${comedian.name} injected into post.`);
          }
        } catch (err) {
          console.warn(`  Headshot upload for ${comedian.name} failed: ${err.message}`);
        }
      }

      // Look up category
      const categoryId = await wpGetCategoryBySlug("comedy-shows");

      const postData = {
        title: wpTitle,
        content: wpContent,
        status: "publish",
        slug: wpSlug,
        comment_status: "closed",
      };
      if (featuredMediaId) postData.featured_media = featuredMediaId;
      if (categoryId) postData.categories = [categoryId];

      // If a roundup with this slug already exists (e.g. the workflow is
      // being re-run on the same Monday), update it in place instead of
      // creating a duplicate post. WordPress's REST API does NOT dedupe by
      // slug — it would auto-suffix the new slug to "...-2" and leave the
      // old (often broken) post live.
      let existingRoundup = null;
      try {
        const found = await wpRequest(
          "GET",
          `/wp-json/wp/v2/posts?slug=${encodeURIComponent(wpSlug)}&status=publish,draft,future,private`,
          null
        );
        if (Array.isArray(found) && found.length > 0) {
          existingRoundup = found[0];
        }
      } catch (err) {
        console.warn(`  Slug lookup failed (will create new post): ${err.message}`);
      }

      let post;
      if (existingRoundup) {
        console.log(`  Existing roundup found (ID ${existingRoundup.id}) — updating in place.`);
        post = await wpRequest("POST", `/wp-json/wp/v2/posts/${existingRoundup.id}`, postData);
        console.log(`  Weekly roundup updated: ${post.link}`);
      } else {
        post = await wpRequest("POST", "/wp-json/wp/v2/posts", postData);
        console.log(`  Weekly roundup published: ${post.link}`);
      }
      console.log("");
    } catch (err) {
      console.warn(`Warning: WordPress weekly roundup publish failed: ${err.message}`);
      console.warn("Blog post is still live on GitHub Pages.");
      console.log("");
    }
  } else {
    console.log("WordPress publishing disabled (no WP credentials set).");
    console.log("");
  }

  // Step 8: Update the "This Weekend" evergreen WordPress post
  if (WP_ENABLED) {
    console.log("Updating 'This Weekend' evergreen post on WordPress...");
    try {
      await updateWeekendPost(events, weekRange, topComedians, comedianResearch, comedianSourceLinks);
    } catch (err) {
      console.warn(`Warning: Weekend post update failed: ${err.message}`);
    }
    console.log("");
  }

  // Step 9: Update the /this-week/ landing page on WordPress.
  // This is the page your Instagram bio link points at — it never changes URL,
  // but the contents are refreshed every Monday so every IG impression lands
  // on this week's headliners + ticket links + email capture.
  if (WP_ENABLED && topComedians.length > 0) {
    console.log("Updating '/this-week/' landing page on WordPress...");
    try {
      await updateThisWeekLandingPage(topComedians, weekRange, monday, sunday);
    } catch (err) {
      console.warn(`Warning: This-week landing page update failed: ${err.message}`);
    }
    console.log("");
  }

  console.log("Done!");
}

/**
 * Build + publish the "/this-week/" WordPress page — the permanent IG-bio
 * destination. Same slug every week, contents refreshed.
 *
 * Why a Page (not a Post): pages don't show up in the blog archive / RSS,
 * they have stable canonical URLs, and they're meant for evergreen
 * always-current content. Exactly what an IG bio link needs.
 */
async function updateThisWeekLandingPage(topComedians, weekRange, monday, sunday) {
  const slug = "this-week";
  const title = `Houston Comedy This Week — ${weekRange}`;

  // Build the comedian card grid. Each card links to the per-comedian post
  // (which itself has the internal-link footer back to the rest of the week).
  const cardsHtml = topComedians
    .map((c) => {
      // Use the already-validated displayImage set by Step 2b in main().
      // It applies the inverted preference rule: event image is the floor,
      // strict-gated scraped headshot only if it beat the floor, initials
      // SVG as the absolute last resort.
      let usable = "";
      if (c.displayImage && !c.displayImage.startsWith("data:")) {
        usable = c.displayImage;
      } else if (c.imageUrl && isUsableImageUrl(c.imageUrl)) {
        // Fallback for comedians that didn't go through Step 2b (e.g. the
        // Thursday refresh path where we skip headshot scraping).
        usable = c.imageUrl;
      }
      const imgHtml = usable
        ? `<img src="${escapeHTML(usable)}" alt="${escapeHTML(c.name)}" loading="lazy" />`
        : `<div class="placeholder">${escapeHTML(c.name.split(" ").map((w) => w[0]).join("").slice(0, 2))}</div>`;
      const showLine = c.show ? `<p class="show">${escapeHTML(c.show)}</p>` : "";
      return `
  <div class="comedian-card">
    ${imgHtml}
    <h3>${escapeHTML(c.name)}</h3>
    ${showLine}
  </div>`;
    })
    .join("\n");

  const dateRangeLabel = `${monday.toLocaleDateString("en-US", { month: "long", day: "numeric" })} – ${sunday.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;

  // Page content. Inline styles because we can't rely on the WP theme
  // having matching CSS classes — pages on different themes break otherwise.
  const pageContent = `
<style>
.this-week-landing { max-width: 900px; margin: 0 auto; }
.this-week-landing .lede { font-size: 1.25rem; line-height: 1.6; color: #444; margin: 1.5rem 0 2rem; }
.this-week-landing .comedian-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 24px; margin: 2rem 0; }
.this-week-landing .comedian-card { background: #f8f8fb; border-radius: 12px; padding: 16px; text-align: center; }
.this-week-landing .comedian-card img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; margin-bottom: 12px; }
.this-week-landing .comedian-card .placeholder { width: 100%; aspect-ratio: 1; border-radius: 8px; background: linear-gradient(135deg, #ff4d6a, #7c5cff); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 2.5rem; font-weight: 800; margin-bottom: 12px; }
.this-week-landing .comedian-card h3 { margin: 0 0 4px; font-size: 1.05rem; }
.this-week-landing .comedian-card .show { font-size: 0.85rem; color: #777; margin: 0; }
.this-week-landing .cta-block { background: #0a0a0f; color: #fff; padding: 32px; border-radius: 16px; text-align: center; margin: 2.5rem 0; }
.this-week-landing .cta-block h2 { margin-top: 0; color: #fff; }
.this-week-landing .cta-block .btn { display: inline-block; background: #ff4d6a; color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; margin-top: 12px; }
.this-week-landing .secondary-cta { background: #fff8e7; border: 1px solid #f0d99a; padding: 20px; border-radius: 12px; margin: 1.5rem 0; }
</style>

<div class="this-week-landing">

  <p class="lede">Every comedian playing Houston this week, in one place. Updated every Monday morning — bookmark this page or follow <a href="https://instagram.com/comedyhoustontx">@comedyhoustontx</a> on Instagram.</p>

  <p style="color: #888; font-size: 0.95rem; margin-top: -1rem;"><strong>Week of ${escapeHTML(dateRangeLabel)}</strong></p>

  <h2>This week's headliners</h2>
  <div class="comedian-grid">
    ${cardsHtml}
  </div>

  <div class="cta-block">
    <h2>Get the full weekly roundup</h2>
    <p>Day-by-day breakdown, ticket links, and the inside take on every show.</p>
    <a class="btn" href="https://comedyhouston.com/category/comedy-shows/">Read the full weekly roundup →</a>
  </div>

  <div class="secondary-cta">
    <h3 style="margin-top: 0;">🎟️ Want discount tickets?</h3>
    <p>Join the Comedy Houston mailing list and we'll send you ticket discounts and the best shows each week. <a href="https://comedyhouston.com/#email">Sign up free →</a></p>
  </div>

  <h2>Browse every show in Houston</h2>
  <p>Looking for something specific? Our live event tracker pulls comedy shows from every venue in Houston — Improv, Riot, Secret Group, and more — twice a day.</p>
  <p><a href="https://comedyhouston.com/all-shows/"><strong>See every Houston comedy show →</strong></a></p>

  <p style="margin-top: 3rem; color: #888; font-size: 0.85rem; text-align: center;">Last updated: ${escapeHTML(new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }))}</p>

</div>
`;

  // Look up existing /this-week/ page by slug — update in place if it exists.
  let existingPage = null;
  try {
    const found = await wpRequest(
      "GET",
      `/wp-json/wp/v2/pages?slug=${encodeURIComponent(slug)}&status=publish,draft,future,private`,
      null
    );
    if (Array.isArray(found) && found.length > 0) existingPage = found[0];
  } catch (err) {
    console.warn(`  Slug lookup failed (will create new page): ${err.message}`);
  }

  const pageData = {
    title: title,
    content: pageContent,
    status: "publish",
    slug: slug,
    comment_status: "closed",
  };

  let page;
  if (existingPage) {
    console.log(`  Existing /this-week/ page found (ID ${existingPage.id}) — updating in place.`);
    page = await wpRequest("POST", `/wp-json/wp/v2/pages/${existingPage.id}`, pageData);
  } else {
    console.log("  Creating new /this-week/ page.");
    page = await wpRequest("POST", "/wp-json/wp/v2/pages", pageData);
  }
  console.log(`  Landing page live: ${page.link}`);
}

// ---------------------------------------------------------------------------
// "This Weekend" evergreen post updater
// ---------------------------------------------------------------------------

async function updateWeekendPost(allEvents, weekRange, topComedians, comedianResearch, comedianSourceLinks) {
  // Filter to Friday–Sunday events
  const weekendEvents = allEvents.filter((ev) => {
    const dow = (ev.day_of_week || "").toLowerCase();
    return dow === "friday" || dow === "saturday" || dow === "sunday";
  });

  if (weekendEvents.length === 0) {
    console.log("  No weekend events found — skipping update.");
    return;
  }

  // Find the existing post by slug
  const slug = "houston-comedy-shows-this-weekend";
  let existingPost = null;
  try {
    const posts = await wpRequest("GET", `/wp-json/wp/v2/posts?slug=${slug}&status=publish`, null);
    if (Array.isArray(posts) && posts.length > 0) {
      existingPost = posts[0];
      console.log(`  Found existing post (ID: ${existingPost.id}): ${existingPost.link}`);
    }
  } catch (err) {
    console.warn(`  Could not find existing weekend post: ${err.message}`);
  }

  if (!existingPost) {
    console.log("  No existing 'this weekend' post found — creating new one.");
  }

  // Build the weekend date range string
  const fridayEvents = weekendEvents.filter((ev) => (ev.day_of_week || "").toLowerCase() === "friday");
  const sundayEvents = weekendEvents.filter((ev) => (ev.day_of_week || "").toLowerCase() === "sunday");
  const firstDate = weekendEvents[0]?.date || "";
  const lastDate = weekendEvents[weekendEvents.length - 1]?.date || firstDate;
  const weekendRangeStr = firstDate === lastDate
    ? formatDateForDisplay(firstDate)
    : `${formatDateForDisplay(firstDate).replace(/,\s*\d{4}$/, "")} – ${formatDateForDisplay(lastDate)}`;

  // Identify which top comedians are performing this weekend
  const weekendComedianNames = [];
  for (const comedian of topComedians) {
    const hasWeekendShow = weekendEvents.some((ev) =>
      ev.name.toLowerCase().includes(comedian.name.toLowerCase())
    );
    if (hasWeekendShow) weekendComedianNames.push(comedian.name);
  }

  // Generate editorial copy via OpenAI
  const weekendResearch = comedianResearch || "";
  let sourceLinksHint = "";
  if (comedianSourceLinks && weekendComedianNames.length > 0) {
    sourceLinksHint = "\n\nSOURCE LINKS (use 1-2 as hyperlinks per comedian you mention):\n";
    for (const name of weekendComedianNames) {
      if (comedianSourceLinks[name]) sourceLinksHint += `- ${name}: ${comedianSourceLinks[name].join(", ")}\n`;
    }
  }

  const weekendPrompt = `Write a short, punchy editorial intro for the "Houston Comedy Shows This Weekend" page on ComedyHouston.com.

Weekend: ${weekendRangeStr}
Total shows: ${weekendEvents.length}
${weekendComedianNames.length > 0 ? `Notable comedians this weekend: ${weekendComedianNames.join(", ")}` : "No major national headliners this weekend — it's a great time to discover local talent."}

${weekendResearch ? `COMEDIAN RESEARCH:\n${weekendResearch}\n` : ""}${sourceLinksHint}

RULES:
- 150-200 words MAX. This text sits ABOVE a live event widget, so keep it tight.
- Open with a hook that names the biggest act or most interesting show this weekend.
- Mention 2-3 specific shows with real details (venue, time, what makes them worth attending).
- If you mention a comedian, include 1 hyperlink to a credible source (Wikipedia, Netflix, YouTube).
- End with a single sentence nudge: "Scroll down for the full lineup and ticket links."
- NO generic filler. NO "Houston's comedy scene is thriving." NO "Whether you're looking for..."
- BANNED PHRASES: "don't miss", "side-splitting", "a night to remember", "something for everyone", "buckle up", "prepare to"
- Write like a friend recommending weekend plans, not a press release.
- Output ONLY the HTML paragraphs (2-3 <p> tags). No headings, no wrapper tags.`;

  let editorialContent = "";
  try {
    editorialContent = await callOpenAI(weekendPrompt,
      "You write short, specific recommendations for a Houston comedy event page. Your voice is warm, knowing, and concise — like a friend who actually goes to shows. You never use filler or hype. Every sentence has a specific fact or recommendation."
    );
    editorialContent = editorialContent.replace(/^```html\s*\n?/i, "").replace(/\n?```\s*$/g, "").trim();
    console.log("  Weekend editorial copy generated.");
  } catch (err) {
    console.warn(`  Weekend editorial generation failed: ${err.message}`);
    editorialContent = `<p>Here are all the comedy shows happening in Houston this weekend (${weekendRangeStr}). Grab your tickets before they sell out.</p>`;
  }

  // Build the full post content: dynamic editorial + static SEO copy + shortcode
  const updatedDate = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const postContent = `${editorialContent}

<p>Houston is one of the best cities in the country for live comedy, with shows happening every night of the week at venues like the <strong>Houston Improv</strong>, <strong>The Secret Group</strong>, <strong>The Riot</strong>, <strong>Joke Joint Comedy Showcase</strong>, and more. It can be hard to keep track of every comedy show happening across the city — and to tell the difference between open mics and proper headliner shows you'd want to take a date or a group of friends to.</p>

<p>The list below is updated every week and includes all <strong>comedy shows in Houston this weekend</strong>, <strong>excluding open mic comedy</strong>, so you only see featured shows and touring headliners. Whether you're looking for stand-up comedy, improv, or a late-night variety show, this is the most complete weekend comedy calendar for Houston.</p>

<p>If you have any suggestions on shows we didn't list here, please use our <a href="https://www.comedyhouston.com/contact">contact page to message us</a>.</p>

<p><em>Last updated: ${updatedDate}</em></p>

[comedy_houston filter="weekend"]

<p>Looking for shows beyond the weekend? Check out our <a href="https://www.comedyhouston.com">full Houston comedy calendar</a> for every show this month, or read our <a href="https://www.comedyhouston.com/blog/">weekly comedy roundup</a> for in-depth previews of the biggest acts coming to town.</p>`;

  const postTitle = `Houston Comedy Shows This Weekend — ${weekendRangeStr}`;

  if (existingPost) {
    // Update the existing post
    const updateData = {
      content: postContent,
      title: postTitle,
    };
    const updated = await wpRequest("POST", `/wp-json/wp/v2/posts/${existingPost.id}`, updateData);
    console.log(`  Weekend post updated: ${updated.link}`);
  } else {
    // Create a new post
    const categoryId = await wpGetCategoryBySlug("comedy-shows");
    const newPostData = {
      title: postTitle,
      content: postContent,
      status: "publish",
      slug: slug,
      comment_status: "closed",
    };
    if (categoryId) newPostData.categories = [categoryId];
    const created = await wpRequest("POST", "/wp-json/wp/v2/posts", newPostData);
    console.log(`  Weekend post created: ${created.link}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
