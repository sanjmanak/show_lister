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

// Regex-based scrub for the LLM's blog HTML — strips <script>, on*= handlers,
// javascript:/data: URLs, and a handful of other injection shapes. Zero npm
// deps by design. See scripts/lib/sanitize-html.js for the full rationale.
const { sanitizeAiHtml, addSponsoredRelToTicketLinks } = require("./lib/sanitize-html");
const { addBlogPostingToGraph, wpGmtToIso } = require("./lib/schema-utils");

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

// Process start time — used to prove the hero PNG was rendered by THIS run
// (the checkout always contains last week's committed copy).
const SCRIPT_START_MS = Date.now();

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

  // Sort by date then time (numeric — see timeToMinutes)
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
// OpenAI API call
// ---------------------------------------------------------------------------

// Per-request timeouts on the OpenAI sockets. Same class of bug as the
// Hostinger mid-upload hang that killed run #26: a stalled OpenAI socket
// would wait forever and burn the full job timeout, cancelling the
// commit/email steps that depend on `if: !cancelled()`. Chat completions
// usually return in <30s; web-search Responses calls can run longer and
// get their own larger budget.
const OPENAI_CHAT_TIMEOUT_MS = 90_000;
const OPENAI_RESPONSES_TIMEOUT_MS = 120_000;

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

    req.setTimeout(OPENAI_CHAT_TIMEOUT_MS, () => {
      req.destroy(new Error(`OpenAI chat request timed out after ${OPENAI_CHAT_TIMEOUT_MS}ms`));
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

    req.setTimeout(OPENAI_RESPONSES_TIMEOUT_MS, () => {
      req.destroy(new Error(`OpenAI Responses request timed out after ${OPENAI_RESPONSES_TIMEOUT_MS}ms`));
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

// Transient-failure retry for WordPress network calls. Run #51 died on a
// single intermittent 403 (HTML body, not a JSON API error) from the host's
// WAF sitting in front of /wp-json — runs #47–#50 published fine, so it was a
// blip, not a config break. Before this, there was ZERO retry: one bad
// response aborted the whole WP publish. Now each WP call retries transient
// failures (403 WAF blocks, 408/429, 5xx, socket timeouts / resets) with
// exponential backoff, capped so it can't blow the cumulative WP budget.
const WP_MAX_ATTEMPTS = parseInt(process.env.WP_MAX_ATTEMPTS || "4", 10);
const WP_RETRY_BASE_MS = parseInt(process.env.WP_RETRY_BASE_MS || "2000", 10);

// Marker file the workflow checks after posting: if present, WordPress
// publishing failed but Instagram/Facebook still went out, so the run stays
// green and a dedicated "WordPress failed" alert email fires instead.
const WP_STATUS_PATH = path.join(BLOG_DIR, "wp-publish-status.json");

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
 * Decide whether a failed WP call is worth retrying. Retry the transient
 * stuff — WAF 403s, 408/429, 5xx, and network-level errors (timeouts, resets,
 * DNS) that carry no statusCode. Do NOT retry hard failures: 401 (bad app
 * password), 400 (malformed request), 404 (missing) — those won't fix
 * themselves, and the cumulative-budget "skipped" error must not loop either.
 */
function isRetryableWpError(err) {
  const code = err && err.statusCode;
  if (code === 403 || code === 408 || code === 429) return true;
  if (typeof code === "number" && code >= 500 && code <= 599) return true;
  if (!code) {
    const m = (err && err.message) || "";
    if (/cumulative WP budget/i.test(m)) return false; // budget exhausted — stop
    if (/timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|socket hang up|network/i.test(m)) {
      return true;
    }
  }
  return false;
}

/**
 * Run a WP network operation with exponential backoff on transient errors.
 * Stops early if the cumulative WP budget is blown so retries can't eat the
 * whole job. Non-transient errors throw immediately (no point retrying a bad
 * password). Each individual attempt still has its own per-request timeout.
 */
async function withWpRetry(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= WP_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= WP_MAX_ATTEMPTS || !isRetryableWpError(err)) throw err;
      if (wpDeadline > 0 && Date.now() > wpDeadline) {
        console.warn(`  ${label}: WP budget exhausted — not retrying.`);
        throw err;
      }
      const delay = WP_RETRY_BASE_MS * Math.pow(2, attempt - 1); // 2s, 4s, 8s…
      const firstLine = String(err.message || err).split("\n")[0].slice(0, 140);
      console.warn(
        `  ${label} failed (${firstLine}) — retry ${attempt}/${WP_MAX_ATTEMPTS - 1} in ${Math.round(delay / 1000)}s…`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Record WordPress publish failures without failing the run. Instagram/
 * Facebook posting is the deliverable and runs as a separate workflow step, so
 * a WP-only failure shouldn't paint the whole automation red (that's what made
 * run #51 look like the IG post hadn't happened when it actually had). Drop a
 * marker file the workflow turns into a dedicated alert email; the run stays
 * green and the next scheduled run retries WordPress cleanly (slug-dedupe makes
 * re-publishing safe).
 */
function reportWpFailures(wpFailures, context) {
  if (!wpFailures || wpFailures.length === 0) return;
  console.error(`\n⚠ WordPress publish had ${wpFailures.length} failure(s) — Instagram/Facebook are NOT affected:`);
  wpFailures.forEach((f) => console.error(`   - ${f}`));
  console.error("Run stays GREEN (social post is the deliverable); a WordPress-failure alert email will be sent.");
  try {
    if (!fs.existsSync(BLOG_DIR)) fs.mkdirSync(BLOG_DIR, { recursive: true });
    fs.writeFileSync(
      WP_STATUS_PATH,
      JSON.stringify({ context, failedAt: new Date().toISOString(), failures: wpFailures }, null, 2) + "\n"
    );
  } catch (e) {
    console.error(`   (could not write ${WP_STATUS_PATH}: ${e.message})`);
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
  return withWpRetry(`WP ${method} ${urlPath}`, () => wpRequestOnce(method, urlPath, body));
}

function wpRequestOnce(method, urlPath, body) {
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
        if (res.statusCode >= 400) {
          const e = new Error(`WordPress API ${res.statusCode}: ${data.slice(0, 500)}`);
          e.statusCode = res.statusCode;
          return reject(e);
        }
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
  return withWpRetry(`WP media upload ${filename}`, () => wpUploadImageOnce(imageBuffer, contentType, filename));
}

function wpUploadImageOnce(imageBuffer, contentType, filename) {
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
        if (res.statusCode >= 400) {
          const e = new Error(`WP media upload ${res.statusCode}: ${data.slice(0, 500)}`);
          e.statusCode = res.statusCode;
          return reject(e);
        }
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

// ---------------------------------------------------------------------------
// Instagram handle validation
// ---------------------------------------------------------------------------
//
// The LLM tells us "don't fabricate handles" but it absolutely does. Before a
// hallucinated @handle reaches the public caption, HEAD instagram.com/{handle}/
// and drop anything that doesn't 200. A logged-out IG profile still returns
// 200 for valid usernames and 404 for invalid ones — no auth needed.
//
// 10s cap so a single slow check can't stall the run, single attempt so we
// don't retry-spam Instagram. Conservative: if the request errors out (SSL,
// DNS, timeout), we KEEP the handle rather than stripping it, because an IG
// infra hiccup shouldn't silently delete real @-mentions from the caption.

const IG_HANDLE_CHECK_TIMEOUT_MS = 10_000;

function validateInstagramHandle(handle) {
  return new Promise((resolve) => {
    if (!handle || typeof handle !== "string") return resolve(false);
    const clean = handle.trim().replace(/^@/, "");
    // IG usernames: letters, digits, period, underscore; 1–30 chars.
    if (!/^[A-Za-z0-9._]{1,30}$/.test(clean)) return resolve(false);

    const req = https.request(
      {
        hostname: "www.instagram.com",
        path: `/${clean}/`,
        method: "HEAD",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ComedyHoustonBot/1.0)",
        },
      },
      (res) => {
        // IG returns 200 for real usernames (even logged out), 404 for bogus.
        // 301/302 is a redirect to the login wall for a username they don't
        // want to expose publicly — treat as valid to avoid false negatives.
        if (res.statusCode === 200 || res.statusCode === 301 || res.statusCode === 302) {
          resolve(true);
        } else {
          resolve(false);
        }
        res.resume();
      }
    );
    req.setTimeout(IG_HANDLE_CHECK_TIMEOUT_MS, () => {
      req.destroy(new Error("ig handle check timeout"));
    });
    req.on("error", () => resolve(true)); // conservative: keep on error
    req.end();
  });
}

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

// Open mics, showcases, karaoke, and generic recurring events — skipped when
// identifying headliners and (unless nothing else exists) when backfilling
// the hero grid.
const GENERIC_EVENT_PATTERNS = ["open mic", "showcase", "karaoke", "showdown", "dating"];

function filterSpotlightEvents(events) {
  return events.filter((ev) => {
    const name = ev.name.toLowerCase();
    return !GENERIC_EVENT_PATTERNS.some((p) => name.includes(p));
  });
}

// Normalize a comedian name into a dedupe key. A plain toLowerCase() is not
// enough: the LLM returns the same person under different spellings/punctuation
// ("D. L. Hughley" vs "DL Hughley", "Ali Siddiq" vs "ali  siddiq"), which then
// slip past the dedupe and produce twin hero circles + double @-mentions in the
// caption. Stripping everything but [a-z0-9] collapses those variants:
//   "D. L. Hughley" -> "dlhughley"  ==  "DL Hughley" -> "dlhughley"
function comedianDedupeKey(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function identifyTopComedians(events) {
  const filtered = filterSpotlightEvents(events);

  // Build show entries with venue info so OpenAI can factor in venue size
  const showEntries = filtered.map((ev) => {
    const venue = ev.venue ? ` (at ${ev.venue})` : "";
    return `${ev.name}${venue}`;
  });

  // Deduplicate (same comedian may have multiple dates)
  const unique = [...new Set(showEntries)];

  const prompt = `Here is a list of comedy show names happening in Houston this week, with their venues. Identify ALL that feature recognizable comedians — anyone with Netflix/HBO/Comedy Central specials, TV appearances, major podcast appearances, sold-out tours, large social media followings (100k+), etc. Don't limit yourself to a fixed number. If there are no recognizable names, return an empty array.

IMPORTANT: Return the results RANKED by drawing power / overall fame, biggest names first. Consider:
- Social media following (millions of followers > hundreds of thousands)
- Venue size (arenas/stadiums like NRG Arena > large theaters like Bayou Music Center > mid-size clubs like Houston Improv > small clubs like The Secret Group)
- Mainstream recognition (Netflix specials, late-night TV, major tours)
- International fame
The comedian playing the biggest venue with the largest following should be #1, not the one whose show happens earliest in the week.

Shows:
${unique.map((n) => `- ${n}`).join("\n")}

Return ONLY a JSON array of objects with "name" (the comedian's name, not the event title) and "show" (the event title exactly as listed, WITHOUT the venue in parentheses). Example:
[{"name": "Ali Siddiq", "show": "Ali Siddiq"}, {"name": "Greg Fitzsimmons", "show": "Greg Fitzsimmons"}]

Return ONLY the JSON array, no other text.`;

  return callOpenAI(prompt, "You are a comedy expert with deep knowledge of comedian popularity, social media followings, and venue sizes. Return only valid JSON.");
}

// ---------------------------------------------------------------------------
// Hero backfill — notable events fill the grid when comedians run short
// ---------------------------------------------------------------------------

// Shorten an event title for a hero tile. "Ali Siddiq: The Domino Effect
// Tour" → "Ali Siddiq"; generic titles pass through, long ones get clipped.
function eventTileName(title) {
  let name = String(title || "").trim();
  // "Riot Comedy Club Presents \"The Show\"" → "The Show"
  const presents = name.match(/\bpresents[:\s]+["“]?(.+?)["”]?$/i);
  if (presents && presents[1].trim().length >= 4) name = presents[1].trim();
  const first = name.split(/\s*[|–—]\s*|:\s/)[0].trim();
  if (first.length >= 4) name = first;
  if (name.length > 36) name = name.slice(0, 33).trimEnd() + "…";
  return name;
}

// The weekly hero should ALWAYS render a full 6-tile grid so the calendar
// looks active even on a slow week. When identifyTopComedians() only finds
// 2-3 recognizable names, fill the remaining slots with notable events:
// dedupe by title, skip shows already covered by a featured comedian, rank
// by image availability + ticket price (a rough drawing-power proxy), and
// spread across venues. Open mics / showcases are only used if there is
// literally nothing else on the calendar.
function buildHeroBackfillEntries(events, existingEntries, needed) {
  if (needed <= 0) return [];

  const covered = existingEntries.map((c) => ({
    name: (c.name || "").toLowerCase(),
    show: (c.show || "").toLowerCase(),
  }));

  const seenTitles = new Set();
  const collect = (pool) => {
    const out = [];
    for (const ev of pool) {
      const key = (ev.name || "").trim().toLowerCase();
      if (!key || seenTitles.has(key)) continue;
      const isCovered = covered.some(
        (c) => (c.show && key === c.show) || (c.name && key.includes(c.name))
      );
      if (isCovered) continue;
      seenTitles.add(key);
      out.push(ev);
    }
    return out;
  };

  let candidates = collect(filterSpotlightEvents(events));
  if (candidates.length < needed) {
    candidates = candidates.concat(collect(events));
  }

  candidates.sort((a, b) => {
    const imgDiff = (b.image_url ? 1 : 0) - (a.image_url ? 1 : 0);
    if (imgDiff) return imgDiff;
    const priceDiff =
      (b.price_max || b.price_min || 0) - (a.price_max || a.price_min || 0);
    if (priceDiff) return priceDiff;
    return (a.date || "").localeCompare(b.date || "");
  });

  // First pass takes at most one event per venue so the grid shows the
  // breadth of the week; second pass fills any remaining slots.
  const picked = [];
  const usedVenues = new Set();
  for (const venueSpread of [true, false]) {
    for (const ev of candidates) {
      if (picked.length >= needed) break;
      if (picked.includes(ev)) continue;
      const venueKey = (ev.venue || "").toLowerCase();
      if (venueSpread && usedVenues.has(venueKey)) continue;
      usedVenues.add(venueKey);
      picked.push(ev);
    }
    if (picked.length >= needed) break;
  }

  return picked.map((ev) => {
    const pick = pickDisplayImage({
      eventImageUrl: ev.image_url,
      comedianName: ev.name,
    });
    return {
      name: eventTileName(ev.name),
      show: ev.name,
      venue: ev.venue || null,
      date: ev.date || null,
      imageUrl: ev.image_url || null,
      displayImage: pick.displayImage,
      imageSource: pick.source,
      isEventBackfill: true,
    };
  });
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
      font-size: 18px;
      font-weight: 600;
      letter-spacing: 6px;
      text-transform: uppercase;
      color: #ff4d6a;
      margin-bottom: 10px;
      z-index: 1;
    }
    .title {
      font-size: 62px;
      font-weight: 900;
      letter-spacing: -1px;
      margin-bottom: 46px;
      z-index: 1;
      text-align: center;
    }
    /* The headshots are the content — size them up so they fill the 1080×1080
       frame instead of floating in dead space (matches the "pinch to zoom"
       crop an operator would otherwise do by hand before posting). */
    .headshot-grid {
      display: grid;
      gap: 34px 54px;
      z-index: 1;
      margin-bottom: 38px;
      justify-items: center;
    }
    .headshot-grid.cols-1 { grid-template-columns: 1fr; max-width: 420px; }
    .headshot-grid.cols-2 { grid-template-columns: repeat(2, 1fr); max-width: 720px; }
    .headshot-grid.cols-3 { grid-template-columns: repeat(3, 1fr); max-width: 920px; gap: 34px 54px; }
    .grid-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
    }
    .grid-item img {
      width: 270px;
      height: 270px;
      border-radius: 50%;
      object-fit: cover;
      border: 4px solid rgba(255, 77, 106, 0.5);
    }
    /* When fewer comedians are featured, give each one even more visual weight. */
    .headshot-grid.cols-2 .grid-item img,
    .headshot-grid.cols-1 .grid-item img {
      width: 330px;
      height: 330px;
      border-width: 5px;
    }
    .headshot-grid.cols-2 .grid-name,
    .headshot-grid.cols-1 .grid-name {
      font-size: 26px;
      max-width: 330px;
    }
    .grid-name {
      font-size: 21px;
      font-weight: 700;
      color: #ffffff;
      text-align: center;
      max-width: 270px;
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
      font-size: 25px;
      font-weight: 500;
      color: #9999aa;
      z-index: 1;
    }
    .brand {
      position: absolute;
      bottom: 34px;
      font-size: 16px;
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

function generateInstagramCaption(comedianNames, weekRange, instagramHandles, comedianResearch, extraShows = []) {
  const namesList =
    comedianNames.length > 0
      ? comedianNames.slice(0, 6).join(", ")
      : "(no big-name headliners identified this week — lead with the shows listed below)";

  // Backfill events that fill out the hero grid on slow weeks. The caption
  // should acknowledge them so the copy matches the 6-tile image.
  const extraShowsSection =
    extraShows.length > 0
      ? `\nAlso on this week's calendar (these appear in the post image — work 1-2 of them into the pitch or a single "also happening" sentence, naming the venue):\n${extraShows
          .map((s) => `- ${s.show}${s.venue ? ` at ${s.venue}` : ""}`)
          .join("\n")}\n`
      : "";

  // Build the handles section for the prompt
  const handlesFound = instagramHandles || {};
  const handleEntries = Object.entries(handlesFound).filter(([, handle]) => handle);
  // Dedupe the handles themselves: even after name-level dedupe, two distinct
  // names could resolve to the same account (e.g. a variant that slipped
  // through), which would otherwise print "@realdlhughley @realdlhughley".
  const seenHandles = new Set();
  const handlesList = handleEntries
    .map(([, handle]) => handle)
    .filter((handle) => {
      const key = handle.trim().toLowerCase().replace(/^@/, "");
      if (!key || seenHandles.has(key)) return false;
      seenHandles.add(key);
      return true;
    })
    .join(" ");

  // Build research context so the caption can reference real credits
  const researchSection = comedianResearch
    ? `\nBACKGROUND ON THESE COMEDIANS (use this to write specific, informed copy — do NOT dump all of it into the caption, just pick 1-2 details that make the best hook):\n\n${comedianResearch}\n`
    : "";

  const prompt = `Write an Instagram caption for Comedy Houston's weekly post.

Week: ${weekRange}
Featured comedians: ${namesList}
${researchSection}${extraShowsSection}
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
  <meta name="robots" content="noindex">
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

  // Collect WordPress publish failures across all WP-touching steps. At the
  // end they're written to a marker file (reportWpFailures) that the workflow
  // turns into a dedicated alert email — WordPress is best-effort and no longer
  // fails the run, since the Instagram/Facebook post is the real deliverable
  // and posts from its own workflow step regardless of WP's outcome.
  const wpFailures = [];

  // Clear any stale marker so a previous run's WP failure can't trigger a
  // false alert. (Fresh checkouts won't have it, but local re-runs might.)
  try { if (fs.existsSync(WP_STATUS_PATH)) fs.unlinkSync(WP_STATUS_PATH); } catch (_) {}

  // Load and filter events
  const { events, monday, sunday } = loadThisWeeksEvents();

  if (events.length === 0) {
    console.log("No events found for this week. Skipping blog generation.");
    process.exit(0);
  }

  const weekRange = formatWeekRange(monday, sunday);
  console.log(`Week range: ${weekRange}`);
  console.log("");

  // Thursday used to run a cut-down refresh whose only output was the
  // /houston-comedy-shows-this-weekend/ blog post. That post is retired
  // (it duplicated the evergreen /this-weekend/ page and now 301s to it),
  // so the branch had nothing left to publish — it just spent OpenAI calls
  // on comedian identification and research that were then thrown away.
  // The Thursday cron is removed from generate-blog-post.yml too; a manual
  // dispatch on any day now does the full run.

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
    // Deduplicate by comedian name (OpenAI sometimes returns the same person
    // twice, often under different spellings — "D. L. Hughley" vs "DL Hughley")
    const seen = new Set();
    topComedians = topComedians.filter((c) => {
      const key = comedianDedupeKey(c.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Hard cap: the identifyTopComedians() prompt explicitly says "Don't
    // limit yourself to a fixed number" so a chatty run can return 20+
    // names. Everything downstream (headshot scrape loop, research call,
    // Instagram handle lookup, handoff file) would then do ~20× the work,
    // blow past the 20-minute job budget, and balloon the OpenAI bill.
    // The hero only renders 6 and the per-comedian script caps at 5, so
    // 8 is a safe ceiling that leaves a little margin for dedupe/miss.
    // NOTE: The list is now ranked by drawing power (biggest names first)
    // so the top 8 are the most prominent acts of the week.
    const MAX_TOP_COMEDIANS = 8;
    if (topComedians.length > MAX_TOP_COMEDIANS) {
      console.log(
        `Capping ${topComedians.length} → ${MAX_TOP_COMEDIANS} comedians (ranked by prominence).`
      );
      topComedians = topComedians.slice(0, MAX_TOP_COMEDIANS);
    }
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

  // Step 2c: Build the hero lineup — comedians first, then notable-event
  // backfill so the grid always shows HERO_TILE_COUNT tiles. Backfill
  // entries are hero/caption-only: they are NOT written to the
  // top-comedians.json handoff, so the per-comedian deep-research posts
  // still only cover real headliners.
  const HERO_TILE_COUNT = 6;
  let heroEntries = [...topComedians];
  if (heroEntries.length < HERO_TILE_COUNT) {
    const backfill = buildHeroBackfillEntries(
      events,
      topComedians,
      HERO_TILE_COUNT - heroEntries.length
    );
    if (backfill.length > 0) {
      console.log(
        `Hero backfill: only ${topComedians.length} comedian(s) found — adding ${backfill.length} notable event(s): ${backfill.map((e) => e.name).join(", ")}`
      );
      console.log("");
    }
    heroEntries = heroEntries.concat(backfill);
  }
  const backfillEntries = heroEntries.filter((e) => e.isEventBackfill);

  // Step 3: Generate hero creative HTML (replaces DALL-E)
  let inlineHeroHTML = "";
  if (heroEntries.length > 0) {
    const heroHTML = generateHeroCreativeHTML(heroEntries, weekRange);
    fs.writeFileSync(BLOG_HERO_HTML_PATH, heroHTML);
    console.log(`Wrote hero creative HTML: ${BLOG_HERO_HTML_PATH}`);
    inlineHeroHTML = generateInlineHeroHTML(heroEntries, weekRange);

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

  // Minimum-length sanity check. If the model returned an empty string, a
  // safety refusal, or a single-sentence "I can't help with that" we do NOT
  // want that landing in production. Fail loudly so the notify-on-failure
  // step fires and the operator investigates.
  if (blogContent.length < 400) {
    throw new Error(
      `Blog content too short (${blogContent.length} chars) — treating as a model refusal or empty response. First 200 chars: ${blogContent.slice(0, 200)}`
    );
  }

  // Sanitize AI output — strip any <script>/<iframe>/on*=/javascript: that
  // slipped through. We do NOT trust the LLM with raw HTML, ever.
  const sanitized = sanitizeAiHtml(blogContent);
  if (sanitized.removed.length > 0) {
    console.warn(`  sanitizeAiHtml removed: ${sanitized.removed.join(", ")}`);
  }
  blogContent = addSponsoredRelToTicketLinks(sanitized.html);

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

      // Validate each handle with a single HEAD to instagram.com/{handle}/.
      // Drops hallucinated usernames before they land in the public caption.
      // See validateInstagramHandle() for the "conservative on error" rule.
      const entries = Object.entries(instagramHandles);
      if (entries.length > 0) {
        console.log(`Validating ${entries.length} handle(s) against instagram.com...`);
        const validated = {};
        for (const [name, handle] of entries) {
          const ok = await validateInstagramHandle(handle);
          if (ok) {
            validated[name] = handle;
            console.log(`  ✓ ${name} → ${handle}`);
          } else {
            console.warn(`  ✗ ${name} → ${handle} (not reachable — dropped)`);
          }
        }
        instagramHandles = validated;
      }

      const found = Object.entries(instagramHandles);
      if (found.length > 0) {
        console.log(`Found ${found.length} validated Instagram handle(s).`);
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

  // Step 6: Generate Instagram caption (with handles). Runs whenever the
  // hero has anything to show — on a slow week with zero recognized
  // comedians the caption is built from the backfill events instead, so
  // the weekly IG post still goes out.
  if (heroEntries.length > 0) {
    console.log("Generating Instagram caption...");
    try {
      let caption = await generateInstagramCaption(topComedianNames, weekRange, instagramHandles, comedianResearch, backfillEntries);
      caption = caption.replace(/^```\w*\s*\n?/g, "").replace(/\n?```\s*$/g, "").trim();
      fs.writeFileSync(BLOG_CAPTION_PATH, caption);
      console.log(`Wrote Instagram caption: ${BLOG_CAPTION_PATH}`);

      // Auto-post handoff: post-weekly-roundup.js (run by the workflow after
      // commit/push lands the hero PNG on main) requires this meta to prove
      // the caption + hero on disk belong to THIS week — not last week's
      // files from the checkout after a partial generation failure.
      // Existence alone doesn't prove freshness — LAST week's committed PNG
      // is always present in the checkout. Require the file to have been
      // (re)written during THIS process, else a failed screenshot-hero run
      // would auto-post last week's image under this week's caption.
      const heroPngForMeta = path.join(BLOG_DIR, "weekly-hero.png");
      const heroIsFresh =
        fs.existsSync(heroPngForMeta) &&
        fs.statSync(heroPngForMeta).mtimeMs >= SCRIPT_START_MS;
      if (!heroIsFresh && fs.existsSync(heroPngForMeta)) {
        console.warn(
          "weekly-hero.png predates this run (screenshot-hero failed?) — NOT writing weekly-meta.json, auto-post will be skipped."
        );
      }
      if (heroIsFresh) {
        fs.writeFileSync(
          path.join(BLOG_DIR, "weekly-meta.json"),
          JSON.stringify(
            {
              week_monday: monday.toISOString().slice(0, 10),
              week_range: weekRange,
              generated_at: new Date().toISOString(),
              hero: "weekly-hero.png",
              caption: "instagram-caption.txt",
            },
            null,
            2
          ) + "\n"
        );
        console.log("Wrote weekly-meta.json (auto-post handoff).");
      }
      console.log("");
    } catch (err) {
      console.warn(`Warning: Caption generation failed: ${err.message}`);
      console.log("");
    }
  }

  // Step 7 (RETIRED): the dated weekly roundup post
  // (/houston-comedy-shows-this-week-YYYY-MM-DD/) is no longer published.
  // Each dated post duplicated the evergreen /this-week/ page for its seven
  // days of relevance, then lived on as permanent thin content cannibalizing
  // the URL that actually ranks — ~20 near-identical archives competing for
  // "houston comedy shows this week". The WordPress plugin (v2.7.0) now 301s
  // the existing dated URLs to /this-week/, which Step 9 below refreshes in
  // place every Monday. The hero PNG + caption still ship to Instagram via
  // post-weekly-roundup.js, and blog/index.html still gets the full article.
  if (WP_ENABLED) {
    // Arm the cumulative WP budget for Steps 8-9. After this many ms across
    // ALL WP calls in the script, every subsequent call short-circuits with a
    // budget-exceeded error so the email step at the end of the workflow
    // still gets a chance to run. Each individual call also has its own
    // per-request timeout (WP_REQUEST_TIMEOUT_MS / WP_UPLOAD_TIMEOUT_MS).
    wpDeadline = Date.now() + WP_TOTAL_BUDGET_MS;
    console.log(`WordPress updates (cumulative budget: ${Math.round(WP_TOTAL_BUDGET_MS / 1000)}s) — dated weekly post retired, updating evergreen pages only.`);
    console.log("");
  } else {
    console.log("WordPress publishing disabled (no WP credentials set).");
    console.log("");
  }

  // Step 8: (retired) The "This Weekend" blog POST used to be republished
  // here. It duplicated the evergreen /this-weekend/ PAGE - same 31-event
  // ItemList, both indexable, both self-canonical - so the two competed for
  // one query and Google flipped between them, splitting whatever links
  // either earned. /this-weekend/ won on internal links (it is in the nav;
  // nothing linked to the post, not even the post itself) and now carries
  // the dated title that was the post's only real advantage.
  //
  // The URL 301s to /this-weekend/ in the plugin. Publishing had to stop as
  // well, not just redirect: updateWeekendPost() recreated the post with
  // status "publish" whenever it was missing, so drafting or deleting it in
  // WP admin only bought a week before it reappeared in the sitemap.
  //
  // Deliberately NOT done by disabling generate-blog-post.yml. That workflow
  // also builds the weekly hero, the Instagram caption and
  // top-comedians.json, which post-weekly-roundup.js consumes - killing the
  // workflow would have silently killed the weekly social post with it.

  // Step 9: Update the /this-week/ landing page on WordPress.
  // This is the page your Instagram bio link points at — it never changes URL,
  // but the contents are refreshed every Monday so every IG impression lands
  // on this week's headliners + ticket links + email capture.
  // heroEntries, not topComedians: on a quiet week with zero "recognizable"
  // names the old topComedians gate skipped this update entirely and the
  // page (the IG bio link target) kept showing LAST week's dated title for
  // seven days (2026-08-17). The hero's notable-event backfill exists for
  // exactly this case — use the same lineup here.
  if (WP_ENABLED && heroEntries.length > 0) {
    console.log("Updating '/this-week/' landing page on WordPress...");
    try {
      await updateThisWeekLandingPage(heroEntries, weekRange, monday, sunday);
    } catch (err) {
      console.error(`ERROR: This-week landing page update failed: ${err.message}`);
      wpFailures.push(`this-week landing page: ${err.message}`);
    }
    console.log("");
  }

  // WordPress publishing is best-effort: the Instagram/Facebook auto-post is
  // the deliverable and runs as its own workflow step, so a WP-only failure no
  // longer fails the run. We record the failures to a marker file; the workflow
  // turns that into a dedicated "WordPress failed" alert email and the run
  // stays green. The next scheduled run retries WP cleanly (slug-dedupe).
  reportWpFailures(wpFailures, "monday-full");

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
/**
 * Resolve an internal link target by page slug, falling back to a path we
 * know exists.
 *
 * The /this-week/ template used to hardcode https://comedyhouston.com/all-shows/,
 * a page that does not exist — so every Monday's run republished a 404 onto
 * one of the site's better pages. Hardcoding is the bug: a slug that is
 * right today silently rots when a page is renamed, and nothing in this
 * pipeline would ever notice.
 *
 * Looking the slug up through the REST API we are already authenticated
 * against costs one request, is cached for the run, and degrades to a
 * known-good path with a loud warning rather than shipping a dead link.
 */
const internalUrlCache = new Map();

async function resolveInternalUrl(slug, fallbackPath) {
  if (internalUrlCache.has(slug)) return internalUrlCache.get(slug);

  const base = WP_SITE_URL.replace(/\/$/, "") || "https://comedyhouston.com";
  let url = `${base}${fallbackPath}`;

  try {
    const pages = await wpRequest(
      "GET",
      `/wp-json/wp/v2/pages?slug=${encodeURIComponent(slug)}&status=publish`,
      null
    );
    if (Array.isArray(pages) && pages.length > 0 && pages[0].link) {
      url = pages[0].link;
    } else {
      console.warn(
        `  Link target /${slug}/ not found — falling back to ${fallbackPath}. ` +
        `If that page was renamed, update the slug in updateThisWeekLandingPage().`
      );
    }
  } catch (err) {
    console.warn(`  Could not resolve /${slug}/ (${err.message}) — using ${fallbackPath}.`);
  }

  internalUrlCache.set(slug, url);
  return url;
}

async function updateThisWeekLandingPage(topComedians, weekRange, monday, sunday) {
  const slug = "this-week";
  const title = `Houston Comedy This Week — ${weekRange}`;

  // Resolved rather than hardcoded — see resolveInternalUrl().
  const allShowsUrl = await resolveInternalUrl("houston-comedy-shows-this-month", "/");
  const weekendUrl = await resolveInternalUrl("this-weekend", "/");

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
    <h2>Going out this weekend?</h2>
    <p>Friday, Saturday and Sunday shows at every club in the city, with prices and ticket links.</p>
    <a class="btn" href="${weekendUrl}">See this weekend's shows →</a>
  </div>

  <div class="secondary-cta">
    <h3 style="margin-top: 0;">🎟️ Want discount tickets?</h3>
    <p>Join the Comedy Houston mailing list and we'll send you ticket discounts and the best shows each week. <a href="https://comedyhouston.com/#email">Sign up free →</a></p>
  </div>

  <h2>Browse every show in Houston</h2>
  <p>Looking for something specific? Our live event tracker pulls comedy shows from every venue in Houston — Improv, Riot, Secret Group, and more — twice a day.</p>
  <p><a href="${allShowsUrl}"><strong>See every Houston comedy show →</strong></a></p>

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


// Only run the full generator when invoked directly (`node generate-blog-post.js`).
// Exporting the pure builders lets tests/previews render the hero creative
// without kicking off OpenAI calls, WordPress publishing, or Puppeteer.
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = {
  generateHeroCreativeHTML,
  generateInlineHeroHTML,
  escapeHTML,
};
