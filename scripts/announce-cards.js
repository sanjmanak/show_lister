#!/usr/bin/env node

/**
 * Comedy Houston — "Just announced" Instagram cards
 *
 * Renders branded 1080x1350 announcement cards (IG portrait) for entries in
 * config/just-announced.json, using each show's own listing image as the
 * background under the house overlay (same brand language as the essay
 * quote cards and gear-guide heroes).
 *
 * Usage:
 *   node scripts/announce-cards.js            cards for notable entries first_seen in the last 36h
 *   node scripts/announce-cards.js --all      cards for ALL entries in the last 36h
 *   node scripts/announce-cards.js --demo     card for the newest notable entry regardless of age
 *   node scripts/announce-cards.js --hours=72 widen the window
 *
 * Output: ~/showList/announce-cards/<date>-<slug>.png  (outside the repo)
 * Requires puppeteer (repo devDependency, already installed).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const puppeteer = require("puppeteer");

const ROOT = path.join(__dirname, "..");
const FEED = path.join(ROOT, "config", "just-announced.json");
const OUT_DIR = path.join(process.env.HOME || "~", "showList", "announce-cards");
const W = 1080, H = 1350;

const args = process.argv.slice(2);
const ALL = args.includes("--all");
const DEMO = args.includes("--demo");
const hoursArg = args.find((a) => a.startsWith("--hours="));
const WINDOW_H = hoursArg ? parseInt(hoursArg.split("=")[1], 10) : 36;

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fetchBuf(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
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

function cardHTML(a, photoDataUri) {
  const nameSize = a.name.length > 40 ? 58 : a.name.length > 24 ? 72 : 88;
  const price = a.price_min != null ? ("From $" + a.price_min) : "On sale now";
  const bg = photoDataUri
    ? `background-image:url('${photoDataUri}');background-size:cover;background-position:center 25%;`
    : `background:#0a0a0f;background-image:radial-gradient(ellipse 120% 70% at 85% 0%,rgba(124,92,255,.2),transparent 60%),radial-gradient(ellipse 100% 60% at 10% 100%,rgba(255,77,106,.16),transparent 55%);`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@600;700;800;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;font-family:'Inter',sans-serif;color:#fff;overflow:hidden;position:relative;background:#0a0a0f}
.photo{position:absolute;inset:0;${bg}}
.shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,10,15,.20) 0%,rgba(10,10,15,.35) 45%,rgba(10,10,15,.95) 100%)}
.content{position:absolute;inset:0;display:flex;flex-direction:column;padding:64px 64px 56px}
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
    <div class="name">${esc(a.name)}</div>
    <div class="meta">${esc(a.venue)} &middot; ${esc(niceDate(a.date))}</div>
    <div class="row"><div class="chip">${esc(price)}</div><div class="url">comedyhouston.com</div></div>
  </div>
</div>
</body></html>`;
}

async function main() {
  const feed = JSON.parse(fs.readFileSync(FEED, "utf8")).announcements || [];
  let picks;
  if (DEMO) {
    picks = feed.filter((a) => a.notable).slice(-1);
    if (!picks.length) picks = feed.slice(-1);
  } else {
    const cutoff = Date.now() - WINDOW_H * 3600 * 1000;
    picks = feed.filter((a) => new Date(a.first_seen).getTime() >= cutoff && (ALL || a.notable));
  }
  if (!picks.length) {
    console.log("No matching announcements in the window. (Try --all, --hours=72, or --demo.)");
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H });
    for (const a of picks) {
      let dataUri = null;
      if (a.image_url) {
        try {
          const buf = await fetchBuf(a.image_url);
          if (buf.length > 5000) dataUri = "data:image/jpeg;base64," + buf.toString("base64");
        } catch (e) { /* fall back to brand background */ }
      }
      const slug = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
      const out = path.join(OUT_DIR, `${a.date}-${slug}.png`);
      const tmp = out.replace(/\.png$/, ".html");
      fs.writeFileSync(tmp, cardHTML(a, dataUri));
      await page.goto("file://" + tmp, { waitUntil: "networkidle0", timeout: 30000 });
      await page.screenshot({ path: out, type: "png" });
      fs.unlinkSync(tmp);
      console.log("card:", out);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
