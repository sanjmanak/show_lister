/**
 * Comedy Houston — Shared image utilities.
 *
 * Single source of truth for the headshot-scraping + strict-gate pipeline
 * used by generate-blog-post.js and generate-comedian-post.js. Before this
 * module, both scripts carried their own drifted copies of these functions
 * (~280 lines each) which made bugs impossible to fix in one place.
 *
 * Strategy (new as of the "comedian workflow" refactor):
 *
 *   1. The ticket/event image (Ticketmaster or Eventbrite) is treated as the
 *      FLOOR, not a fallback. It's already on the event record, already a
 *      proper landscape/portrait, and already reliable.
 *
 *   2. Scraped headshot candidates from Wikipedia/IMDb/official sites MUST
 *      pass a strict quality gate before they are allowed to replace the
 *      event image:
 *         - URL not on expanded social-CDN / profile-glyph blocklist
 *         - HEAD: 200 + image/* + Content-Length >= MIN_HEADSHOT_BYTES
 *         - Ranged GET of first ~32KB, parse JPEG/PNG/WebP/GIF header
 *         - Real pixel width >= MIN_HEADSHOT_WIDTH
 *         - Aspect ratio w/h in [ASPECT_MIN, ASPECT_MAX]
 *
 *   3. If no candidate clears the bar, we keep the event image. If the event
 *      image is also missing, we fall back to a gradient-initials SVG.
 *
 * This fixes the "Mo Amer renders as an Instagram glyph" / "Peter Revello
 * renders as a silhouette" class of bugs: those images passed the old
 * HEAD-only validator because they're valid JPEG/PNG with non-trivial
 * byte length, but they fail the real-dimension + bytes + URL-pattern gate.
 */

"use strict";

const https = require("https");
const http = require("http");

// ---------------------------------------------------------------------------
// Tunable thresholds
// ---------------------------------------------------------------------------

const MIN_HEADSHOT_BYTES = 20_000;   // 20KB — real headshots are 25–200KB
const MIN_HEADSHOT_WIDTH = 300;      // px
const MIN_HEADSHOT_HEIGHT = 300;     // px
const ASPECT_MIN = 0.65;             // w/h — reject extremely tall
const ASPECT_MAX = 1.55;             // w/h — reject banners / 16:9 panoramas
const DIM_FETCH_BYTES = 32 * 1024;   // bytes to pull for header parsing
const USER_AGENT = "ComedyHouston-BlogBot/1.0";

// ---------------------------------------------------------------------------
// URL blocklists
// ---------------------------------------------------------------------------

/**
 * Social-network CDNs and profile-glyph URL patterns that almost never
 * return a real headshot. Matched as case-insensitive substrings against
 * the full URL (hostname + path).
 *
 * These are the patterns that passed the old HEAD-only validator and gave
 * us the Mo Amer "@" glyph, Peter Revello silhouette, generic FB profile
 * shadow, etc. Matching here short-circuits the pipeline before we even
 * make a network call.
 */
const SOCIAL_CDN_BLOCKLIST = [
  // Twitter / X
  "pbs.twimg.com/profile_images",
  "abs.twimg.com",
  // Instagram / Meta CDNs
  "cdninstagram.com",
  "scontent.cdninstagram",
  "instagram.f",         // scontent-XXX.fbcdn.net/... pattern
  "instagram.com/static",
  "lookaside.fbsbx",
  "lookaside.instagram",
  "fbcdn.net/safe_image",
  "fbcdn.net/v/",        // most profile-photo shortlinks live here
  // Generic "profile / avatar glyph" hints
  "profile_images",
  "profile_image",
  "profile_pic",
  "profilepic",
  "default_profile",
  "defaultprofile",
  "defaultuser",
  "default-user",
  "default-avatar",
  "default_avatar",
  "mystery_person",
  "mystery-person",
  "silhouette",
  "blank-profile",
  "blank_profile",
  "no-photo",
  "nophoto",
  "no-image",
  "noimage",
  "gravatar.com/avatar/0",
  "/avatar-default",
  // Exact-square sizing patterns that are almost always social glyphs
  "/150x150/",
  "/200x200/",
  "/300x300/",
  "/400x400/",
  "/512x512/",
  // allevents.in serves a default profile.png from upload-temp
  "allevents.in/transup",
];

/**
 * File-extension blocklist — vectors and tiny animated GIFs are almost
 * never real headshots.
 */
const EXT_BLOCKLIST = [".svg", ".gif", ".ico"];

/**
 * Substrings that indicate site chrome (logo, favicon, nav, ads, etc.)
 * rather than a comedian photo. Used during scraping to reject candidates
 * before validation.
 */
const CHROME_URL_PATTERNS = [
  "favicon", "logo", "icon", "1x1", "pixel", "tracking", "badge",
  "button", "banner", "sprite", "data:image", "avatar", "widget",
  "footer", "header", "nav-", "menu", "social", "share", "arrow",
  "close", "search", "cart", "checkout", "payment", "ad-", "ads/",
  "analytics", "placeholder",
  "open-mic", "openmic", "open_mic", "openmicnight",
  "flyer", "poster", "event-", "events/", "venue",
  "microphone", "neon", "stage-", "crowd", "audience",
  "background", "bg-", "bg_", "hero-bg", "pattern",
  "default", "no-image", "noimage", "coming-soon",
  "ticket", "buy-ticket", "calendar",
];

/**
 * Alt-text substrings that indicate event / venue chrome rather than
 * a comedian photo.
 */
const CHROME_ALT_PATTERNS = [
  "open mic", "logo", "venue", "banner", "ticket", "calendar", "event",
];

// ---------------------------------------------------------------------------
// Lightweight URL-shape checks (no network)
// ---------------------------------------------------------------------------

/**
 * Cheap URL-level safety check. Returns false for generic avatar/placeholder
 * URLs we never want to display. Used as a last-mile gate by the HTML
 * templates that embed event images (which never go through the full
 * strict-gate pipeline because they are trusted).
 */
function isUsableImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  const lower = url.toLowerCase();
  if (SOCIAL_CDN_BLOCKLIST.some((p) => lower.includes(p))) return false;
  if (EXT_BLOCKLIST.some((ext) => lower.endsWith(ext))) return false;
  return true;
}

/**
 * Returns a data-URI SVG with the comedian's initials over the brand
 * gradient. Used as the absolute floor when neither a scraped headshot
 * nor an event image is available.
 */
function buildInitialsPlaceholder(name) {
  const initials = (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#7c5cff"/>' +
    '<stop offset="1" stop-color="#ff4d6a"/>' +
    "</linearGradient></defs>" +
    '<rect width="200" height="200" fill="url(#g)"/>' +
    '<text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" ' +
    'font-family="Inter,Arial,sans-serif" font-size="80" font-weight="800" ' +
    'fill="#ffffff">' + initials + "</text></svg>";
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

// ---------------------------------------------------------------------------
// HTML page fetcher (used for scraping candidate pages)
// ---------------------------------------------------------------------------

/** Fetch a URL and return the response body as a string. Follows up to 3 redirects. */
function fetchPage(url, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 3;
  return new Promise((resolve) => {
    if (!url || redirectsLeft < 0) return resolve("");
    let resolved = false;
    function done(val) { if (!resolved) { resolved = true; resolve(val); } }

    try {
      const lib = url.startsWith("https") ? https : http;
      const req = lib.get(
        url,
        { timeout: 8000, headers: { "User-Agent": USER_AGENT } },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            let next = res.headers.location;
            if (next.startsWith("/")) {
              try { next = new URL(next, url).href; } catch (_) { return done(""); }
            }
            res.resume();
            return fetchPage(next, redirectsLeft - 1).then(done).catch(() => done(""));
          }
          if (res.statusCode !== 200) { res.resume(); return done(""); }
          const ct = (res.headers["content-type"] || "").toLowerCase();
          if (!ct.includes("text/html") && !ct.includes("text/plain") && !ct.includes("application/xhtml")) {
            res.resume();
            return done("");
          }
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
            if (data.length > 200_000) { res.destroy(); done(data); }
          });
          res.on("end", () => done(data));
          res.on("error", () => done(data || ""));
        }
      );
      req.on("error", () => done(""));
      req.on("timeout", () => { req.destroy(); done(""); });
    } catch (_) { done(""); }
  });
}

// ---------------------------------------------------------------------------
// HEAD request — status, content-type, content-length (follows redirects)
// ---------------------------------------------------------------------------

/**
 * HEAD an image URL. Returns:
 *   { ok: true, statusCode, contentType, contentLength, finalUrl }
 *   { ok: false, reason }
 *
 * Follows up to 3 redirects. Accepts servers that omit Content-Length
 * (contentLength will be 0 in that case).
 */
function headImage(url, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 3;
  return new Promise((resolve) => {
    if (!url || typeof url !== "string") return resolve({ ok: false, reason: "no-url" });
    if (redirectsLeft < 0) return resolve({ ok: false, reason: "too-many-redirects" });
    let parsed;
    try { parsed = new URL(url); } catch (_) { return resolve({ ok: false, reason: "bad-url" }); }
    if (!parsed.protocol.startsWith("http")) return resolve({ ok: false, reason: "bad-protocol" });

    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      { method: "HEAD", timeout: 5000, headers: { "User-Agent": USER_AGENT } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let next = res.headers.location;
          if (next.startsWith("/")) {
            try { next = new URL(next, url).href; } catch (_) {
              return resolve({ ok: false, reason: "bad-redirect" });
            }
          }
          return headImage(next, redirectsLeft - 1).then(resolve);
        }
        if (res.statusCode !== 200) return resolve({ ok: false, reason: "http-" + res.statusCode });
        const contentType = (res.headers["content-type"] || "").toLowerCase();
        if (!contentType.startsWith("image/")) return resolve({ ok: false, reason: "not-image" });
        const contentLength = parseInt(res.headers["content-length"] || "0", 10);
        resolve({ ok: true, statusCode: 200, contentType, contentLength, finalUrl: url });
      }
    );
    req.on("error", () => resolve({ ok: false, reason: "network-error" }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, reason: "timeout" }); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Image dimension reader — ranged GET + header parse
// ---------------------------------------------------------------------------

/**
 * Fetch the first N bytes of a URL (best-effort — some servers ignore
 * the Range header, in which case we just destroy the socket after we
 * have enough bytes). Follows redirects. Returns a Buffer or null.
 */
function fetchImageBytes(url, byteLimit, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 3;
  return new Promise((resolve) => {
    if (!url || redirectsLeft < 0) return resolve(null);
    let parsed;
    try { parsed = new URL(url); } catch (_) { return resolve(null); }
    if (!parsed.protocol.startsWith("http")) return resolve(null);

    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.get(
      url,
      {
        timeout: 7000,
        headers: {
          "User-Agent": USER_AGENT,
          "Range": "bytes=0-" + (byteLimit - 1),
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let next = res.headers.location;
          if (next.startsWith("/")) {
            try { next = new URL(next, url).href; } catch (_) { res.resume(); return resolve(null); }
          }
          res.resume();
          return fetchImageBytes(next, byteLimit, redirectsLeft - 1).then(resolve);
        }
        // 200 = server ignored Range, 206 = Partial Content = honored Range
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return resolve(null);
        }
        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          chunks.push(chunk);
          total += chunk.length;
          if (total >= byteLimit) {
            res.destroy();
            resolve(Buffer.concat(chunks).slice(0, byteLimit));
          }
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", () => resolve(chunks.length ? Buffer.concat(chunks) : null));
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/**
 * Parse width/height from the first bytes of an image file. Supports
 * JPEG, PNG, GIF, and WebP (both VP8 and VP8X chunks). Returns
 * { width, height, format } or null if the header can't be parsed.
 *
 * This is the single highest-leverage change in the headshot pipeline —
 * a HEAD request gives you bytes but not pixels, so a 400x400 Twitter
 * glyph and a 1200x1600 Wikipedia headshot both "pass" a HEAD-only
 * validator. Real dimensions make square-vs-portrait detection actually
 * work.
 */
function parseImageDimensions(buf) {
  if (!buf || buf.length < 10) return null;

  // PNG: \x89 P N G \r \n \x1a \n
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    // IHDR chunk: 4 bytes length + "IHDR" + width(4) + height(4) ...
    // So width starts at byte 16, height at byte 20 (big-endian).
    if (buf.length < 24) return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height, format: "png" };
  }

  // GIF: GIF87a or GIF89a, then 2-byte LE width + 2-byte LE height
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    if (buf.length < 10) return null;
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    return { width, height, format: "gif" };
  }

  // JPEG: starts with FFD8. Walk the markers until we hit a SOFn (C0/C1/C2).
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // Skip padding fills (0xFF repeated)
      if (marker === 0xff) { i++; continue; }
      // Markers without length: SOI/EOI/RSTn/TEM
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      // SOFn (baseline/progressive/etc.) — skip DHT(C4), DAC(CC), and JPG-reserved(C8)
      if (
        (marker >= 0xc0 && marker <= 0xcf) &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      ) {
        // Segment layout: FF Cx | len(2) | precision(1) | height(2) | width(2) ...
        if (i + 9 >= buf.length) return null;
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        return { width, height, format: "jpeg" };
      }
      // Any other marker: read its 2-byte big-endian length and skip
      if (i + 3 >= buf.length) return null;
      const segLen = buf.readUInt16BE(i + 2);
      if (segLen < 2) return null;
      i += 2 + segLen;
    }
    return null;
  }

  // WebP: RIFF ???? WEBP ...
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    if (buf.length < 30) return null;
    const chunkId = buf.toString("ascii", 12, 16);
    if (chunkId === "VP8X") {
      // Extended format: width-1 and height-1 at offsets 24..29 (3-byte LE each)
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return { width, height, format: "webp" };
    }
    if (chunkId === "VP8L") {
      // Lossless: at byte 21, 14-bit width and 14-bit height (width-1/height-1)
      if (buf.length < 25) return null;
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height, format: "webp" };
    }
    if (chunkId === "VP8 ") {
      // Lossy: 16-bit width/height at bytes 26 and 28 (mask top 2 bits)
      if (buf.length < 30) return null;
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height, format: "webp" };
    }
    return null;
  }

  return null;
}

/**
 * Fetch just enough bytes to read the image dimensions. Returns
 * { width, height, format } or null.
 */
async function readImageDimensions(url) {
  const buf = await fetchImageBytes(url, DIM_FETCH_BYTES);
  if (!buf) return null;
  return parseImageDimensions(buf);
}

// ---------------------------------------------------------------------------
// Strict-gate evaluator — decides whether a candidate URL beats the floor
// ---------------------------------------------------------------------------

/**
 * Apply the full strict gate to a candidate URL. Returns:
 *   { ok: true, url, bytes, width, height, format }
 *   { ok: false, url, reason }
 *
 * Reasons (for logging): blocklist, ext, head-<reason>, bytes-<n>, dims-none,
 * width-<n>, height-<n>, aspect-<ratio>.
 */
async function evaluateHeadshotCandidate(url) {
  if (!url || typeof url !== "string") return { ok: false, url, reason: "no-url" };
  const lower = url.toLowerCase();

  // Cheap URL-level rejects first.
  if (SOCIAL_CDN_BLOCKLIST.some((p) => lower.includes(p))) {
    return { ok: false, url, reason: "blocklist" };
  }
  // endsWith, not includes — a host like gifts.com or a query param containing
  // ".gif" must not disqualify an otherwise valid JPEG (isUsableImageUrl
  // already does it this way). Strip the query string before checking.
  const pathOnly = lower.split(/[?#]/)[0];
  if (EXT_BLOCKLIST.some((ext) => pathOnly.endsWith(ext))) {
    return { ok: false, url, reason: "ext" };
  }

  // HEAD — cheap network check for status + type + bytes.
  const head = await headImage(url);
  if (!head.ok) return { ok: false, url, reason: "head-" + head.reason };
  if (head.contentLength > 0 && head.contentLength < MIN_HEADSHOT_BYTES) {
    return { ok: false, url, reason: "bytes-" + head.contentLength };
  }

  // Ranged GET + header parse — the real-dimension check. Without this,
  // square social glyphs slip through whenever the server reports a
  // content-length above MIN_HEADSHOT_BYTES (or omits it entirely).
  const dims = await readImageDimensions(head.finalUrl || url);
  if (!dims) return { ok: false, url, reason: "dims-none" };
  if (dims.width < MIN_HEADSHOT_WIDTH) return { ok: false, url, reason: "width-" + dims.width };
  if (dims.height < MIN_HEADSHOT_HEIGHT) return { ok: false, url, reason: "height-" + dims.height };
  const ar = dims.width / dims.height;
  if (ar < ASPECT_MIN || ar > ASPECT_MAX) {
    return { ok: false, url, reason: "aspect-" + ar.toFixed(2) };
  }

  return {
    ok: true,
    url: head.finalUrl || url,
    bytes: head.contentLength,
    width: dims.width,
    height: dims.height,
    format: dims.format,
  };
}

// ---------------------------------------------------------------------------
// HTML candidate extraction (og:image, twitter:image, JSON-LD, <img>, srcset)
// ---------------------------------------------------------------------------

/**
 * Extract candidate image URLs from an HTML page, prioritizing candidates
 * whose URL or alt text matches the comedian's name. Returns an array of
 * URL strings, best candidates first. Rejects obvious chrome/nav images
 * up front so we don't waste HEAD requests on them.
 */
function extractImageCandidates(html, baseUrl, comedianName) {
  const candidates = [];
  const seen = new Set();

  const nameFragments = [];
  if (comedianName) {
    const parts = comedianName.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
    nameFragments.push(...parts);
    if (parts.length > 1) {
      nameFragments.push(parts.join(""));
      nameFragments.push(parts.join("-"));
      nameFragments.push(parts.join("_"));
    }
  }

  function nameMatchScore(url, altText) {
    const check = (url + " " + (altText || "")).toLowerCase();
    let score = 0;
    for (const frag of nameFragments) {
      if (frag.length >= 3 && check.includes(frag)) score++;
    }
    return score;
  }

  function addCandidate(raw, basePriority, altText) {
    if (!raw || typeof raw !== "string") return;
    let url = raw.trim();
    if (url.startsWith("//")) url = "https:" + url;
    else if (url.startsWith("/")) {
      try { url = new URL(url, baseUrl).href; } catch (_) { return; }
    }
    if (!url.startsWith("http")) return;
    const lower = url.toLowerCase();
    if (CHROME_URL_PATTERNS.some((p) => lower.includes(p))) return;
    if (EXT_BLOCKLIST.some((ext) => lower.endsWith(ext))) return;
    const altLower = (altText || "").toLowerCase();
    if (altLower && CHROME_ALT_PATTERNS.some((p) => altLower.includes(p))) return;
    if (seen.has(url)) return;
    seen.add(url);
    const nameBonus = nameMatchScore(url, altText);
    const priority = nameBonus > 0 ? Math.max(0, basePriority - nameBonus * 3) : basePriority;
    candidates.push({ url, priority, nameBonus });
  }

  // og:image
  const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogMatch) addCandidate(ogMatch[1], 2);

  // twitter:image
  const twMatch = html.match(/<meta[^>]+(?:name|property)=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']twitter:image["']/i);
  if (twMatch) addCandidate(twMatch[1], 3);

  // JSON-LD
  const jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const block of jsonLdMatch) {
      const inner = block.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "");
      try {
        const ld = JSON.parse(inner);
        const img = ld.image || (ld["@graph"] && ld["@graph"].find((n) => n.image));
        if (typeof img === "string") addCandidate(img, 4);
        else if (img && typeof img.url === "string") addCandidate(img.url, 4);
      } catch (_) {}
    }
  }

  // <img> tags
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    const src = imgMatch[1];
    const tag = imgMatch[0];
    const altMatch = tag.match(/alt=["']([^"']*?)["']/i);
    const altText = altMatch ? altMatch[1] : "";
    const widthMatch = tag.match(/width=["']?(\d+)/i);
    const width = widthMatch ? parseInt(widthMatch[1], 10) : 0;
    if (width >= 300 || !widthMatch) addCandidate(src, width >= 300 ? 5 : 7, altText);
  }

  // srcset
  const srcsetRegex = /srcset=["']([^"']+)["']/gi;
  let srcsetMatch;
  while ((srcsetMatch = srcsetRegex.exec(html)) !== null) {
    const parts = srcsetMatch[1].split(",");
    for (const part of parts) {
      const src = part.trim().split(/\s+/)[0];
      addCandidate(src, 6);
    }
  }

  candidates.sort((a, b) => {
    if (a.nameBonus > 0 && b.nameBonus === 0) return -1;
    if (b.nameBonus > 0 && a.nameBonus === 0) return 1;
    return a.priority - b.priority;
  });
  return candidates.map((c) => c.url);
}

// ---------------------------------------------------------------------------
// Top-level headshot finder — picks the best scraped candidate (or null)
// ---------------------------------------------------------------------------

/**
 * Walk the candidate page URLs, scrape image candidates from each, and
 * return the first candidate that clears the strict gate.
 *
 * Unlike the pre-refactor version, this does NOT first-match on the old
 * HEAD-only validator — every returned URL has passed the full gate
 * (URL blocklist + HEAD + dimensions + aspect ratio). If nothing clears
 * the bar, returns null and the caller should keep the event image.
 *
 * Options:
 *   - candidatesPerPage (default 6): how many candidates to validate per page
 *   - logger: function(message) — defaults to console.log
 */
async function findBestHeadshot(pageUrls, comedianName, opts) {
  const options = opts || {};
  const candidatesPerPage = options.candidatesPerPage || 6;
  const log = options.logger || ((m) => console.log(m));

  for (const pageUrl of pageUrls) {
    try {
      log("    Fetching page: " + pageUrl);
      const html = await fetchPage(pageUrl);
      if (!html) { log("      Page fetch failed, skipping."); continue; }
      const candidates = extractImageCandidates(html, pageUrl, comedianName);
      log("      Found " + candidates.length + " image candidate(s).");
      for (const imgUrl of candidates.slice(0, candidatesPerPage)) {
        const result = await evaluateHeadshotCandidate(imgUrl);
        if (result.ok) {
          log("      Accepted (" + result.width + "x" + result.height +
              ", " + result.bytes + "B): " + result.url);
          return result.url;
        } else {
          log("      Rejected (" + result.reason + "): " + imgUrl);
        }
      }
      log("      No candidate cleared the strict gate on this page.");
    } catch (err) {
      log("      Error processing " + pageUrl + ": " + err.message);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Convenience: the inverted-preference decision
// ---------------------------------------------------------------------------

/**
 * The central "what image should we display for this comedian?" decision.
 *
 * Order of preference (new, inverted policy):
 *   1. Event image (Ticketmaster/Eventbrite) — treated as the FLOOR.
 *   2. Scraped headshot ONLY if it beat the strict gate (caller passes
 *      the already-validated URL or null).
 *   3. Gradient initials SVG — absolute floor if nothing else exists.
 *
 * The caller is responsible for running findBestHeadshot() to obtain the
 * validatedHeadshotUrl. This function just makes the final selection so
 * the same policy applies everywhere we render a comedian image.
 *
 * Returns { displayImage, source } where source is one of:
 *   "event" | "headshot" | "initials"
 */
function pickDisplayImage(opts) {
  const eventImageUrl = opts && opts.eventImageUrl ? opts.eventImageUrl : "";
  const validatedHeadshotUrl = opts && opts.validatedHeadshotUrl ? opts.validatedHeadshotUrl : "";
  const comedianName = opts && opts.comedianName ? opts.comedianName : "";

  // 1. Event image is the floor. Use it unless a validated headshot beat it.
  if (eventImageUrl && isUsableImageUrl(eventImageUrl)) {
    if (validatedHeadshotUrl) {
      return { displayImage: validatedHeadshotUrl, source: "headshot" };
    }
    return { displayImage: eventImageUrl, source: "event" };
  }

  // 2. No usable event image — take whatever validated headshot we have.
  if (validatedHeadshotUrl) {
    return { displayImage: validatedHeadshotUrl, source: "headshot" };
  }

  // 3. Absolute floor: branded initials SVG.
  return { displayImage: buildInitialsPlaceholder(comedianName), source: "initials" };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Tunables (exposed so callers can log / display them)
  MIN_HEADSHOT_BYTES,
  MIN_HEADSHOT_WIDTH,
  MIN_HEADSHOT_HEIGHT,
  ASPECT_MIN,
  ASPECT_MAX,
  SOCIAL_CDN_BLOCKLIST,
  // HTML scraping
  fetchPage,
  extractImageCandidates,
  // Image validation
  headImage,
  readImageDimensions,
  parseImageDimensions,
  evaluateHeadshotCandidate,
  findBestHeadshot,
  // Display policy
  isUsableImageUrl,
  buildInitialsPlaceholder,
  pickDisplayImage,
};





