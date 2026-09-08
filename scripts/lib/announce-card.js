/**
 * Comedy Houston — "Just announced" card template (shared).
 *
 * Renders the branded announcement card as HTML for Puppeteer. Two sizes:
 *   portrait 1080x1350 (IG feed / FB feed)
 *   story    1080x1920 (IG story, and the still frame behind a reel)
 * Used by scripts/announce-cards.js (local preview) and
 * scripts/post-announcements.js (CI autoposter).
 */

"use strict";

const https = require("https");

const SIZES = {
  portrait: { w: 1080, h: 1350 },
  story: { w: 1080, h: 1920 },
};

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fetchBuf(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "ComedyHouston-BlogBot/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 4) {
        return resolve(fetchBuf(res.headers.location, redirects + 1));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

function niceDate(iso) {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Display name for the card: the verified performer name when the LLM pass
 *  supplied one, else the raw listing title. */
function displayName(a) {
  return a.performer_name || a.name;
}

/** "Toyota Center - TX" -> "Toyota Center"; Ticketmaster suffixes the state. */
function displayVenue(v) {
  return String(v || "").replace(/\s*[-\u2013]\s*TX$/i, "").trim();
}

function cardHTML(a, photoDataUri, size = "portrait") {
  const { w: W, h: H } = SIZES[size] || SIZES.portrait;
  const story = size === "story";
  const name = displayName(a);
  const nameSize = (name.length > 40 ? 58 : name.length > 24 ? 72 : 88) * (story ? 1.1 : 1);
  const price = a.price_min != null ? ("From $" + a.price_min) : "On sale now";
  const bg = photoDataUri
    ? `background-image:url('${photoDataUri}');background-size:cover;background-position:center ${story ? "30%" : "25%"};`
    : `background:#0a0a0f;background-image:radial-gradient(ellipse 120% 70% at 85% 0%,rgba(124,92,255,.2),transparent 60%),radial-gradient(ellipse 100% 60% at 10% 100%,rgba(255,77,106,.16),transparent 55%);`;
  const pad = story ? "140px 72px 200px" : "64px 64px 56px";
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@600;700;800;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;font-family:'Inter',sans-serif;color:#fff;overflow:hidden;position:relative;background:#0a0a0f}
.photo{position:absolute;inset:0;${bg}}
.shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,10,15,.20) 0%,rgba(10,10,15,.35) 45%,rgba(10,10,15,.95) 100%)}
.content{position:absolute;inset:0;display:flex;flex-direction:column;padding:${pad}}
.brand{display:flex;align-items:center;gap:16px}
.brand-bar{width:52px;height:8px;border-radius:4px;background:linear-gradient(90deg,#ff4d6a,#7c5cff)}
.brand-name{font-weight:800;font-size:26px;letter-spacing:.22em;text-shadow:0 2px 12px rgba(0,0,0,.6)}
.bottom{margin-top:auto}
.flag{display:inline-block;font-weight:900;font-size:34px;letter-spacing:.14em;background:#ff4d6a;padding:12px 26px;border-radius:8px;margin-bottom:26px;box-shadow:0 4px 20px rgba(0,0,0,.45)}
.name{font-weight:900;font-size:${nameSize}px;line-height:1.05;letter-spacing:-.015em;margin-bottom:22px;text-shadow:0 3px 18px rgba(0,0,0,.7)}
.meta{font-weight:700;font-size:36px;color:rgba(255,255,255,.92);margin-bottom:30px;text-shadow:0 2px 10px rgba(0,0,0,.7)}
.row{display:flex;align-items:center;justify-content:space-between}
.chip{display:inline-block;font-weight:800;font-size:28px;letter-spacing:.04em;padding:13px 28px;border-radius:999px;background:#7c5cff;box-shadow:0 4px 20px rgba(0,0,0,.45)}
.url{font-weight:800;font-size:26px;color:rgba(255,255,255,.85);text-shadow:0 2px 10px rgba(0,0,0,.6)}
</style></head><body>
<div class="photo"></div><div class="shade"></div>
<div class="content">
  <div class="brand"><div class="brand-bar"></div><div class="brand-name">COMEDY HOUSTON</div></div>
  <div class="bottom">
    <div class="flag">JUST ANNOUNCED</div>
    <div class="name">${esc(name)}</div>
    <div class="meta">${esc(displayVenue(a.venue))} &middot; ${esc(niceDate(a.date))}</div>
    <div class="row"><div class="chip">${esc(price)}</div><div class="url">comedyhouston.com</div></div>
  </div>
</div>
</body></html>`;
}

/** Fetch the show image as a data URI (null if missing or too small). */
async function photoDataUri(imageUrl) {
  if (!imageUrl) return null;
  try {
    const buf = await fetchBuf(imageUrl);
    if (buf.length > 5000) return "data:image/jpeg;base64," + buf.toString("base64");
  } catch (_) { /* brand background */ }
  return null;
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

module.exports = { SIZES, cardHTML, photoDataUri, niceDate, slugify, displayName, displayVenue };
