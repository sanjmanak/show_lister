#!/usr/bin/env node

/**
 * Comedy Houston — Week-of creative refresh for comedian spotlights.
 *
 * With the 3-week-lead pipeline, spotlight blog posts publish ~3 weeks
 * before the show and (ideally) pick up search impressions. The week of
 * the show, the IG feed post becomes a carousel: slide 1 is the designed
 * square graphic (event image + name / date / venue), slide 2 is a live
 * 1080x1080 screenshot of the top of the published post. This script
 * takes that screenshot and writes it to
 * blog/comedians/images/<slug>-teaser-1.png, which post-to-instagram.js
 * picks up automatically. The designed square and story PNGs are left
 * alone, so a screenshot that never happens degrades to a single-image
 * post instead of a 404.
 *
 * Idempotent per comedian per week: a <slug>.live-refreshed marker file is
 * written next to the PNGs; comedians with a marker are skipped, so the
 * every-6-hours workflow only pays the screenshot cost once per comedian.
 *
 * Page loading is deliberately strict about what it waits for: the site
 * carries a Meta pixel, analytics and a popup plugin, and waiting for
 * "network idle" on all of that timed out three times in a row on
 * 2026-09-07. Third-party requests are blocked at the network layer, the
 * popup overlay is hidden, and the wait is for the page load event plus a
 * short settle for images.
 *
 * Runs in post-to-instagram.yml BEFORE the posting step; the workflow
 * commits and pushes any changed PNGs first so GitHub Pages can serve them.
 *
 * Requires puppeteer at runtime (the workflow installs it).
 */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const OUTPUT_DIR = path.resolve(__dirname, "..");
const COMEDIANS_DIR = path.join(OUTPUT_DIR, "blog", "comedians");
const IMAGES_DIR = path.join(COMEDIANS_DIR, "images");

// Hosts the screenshot actually needs. Everything else (pixel, analytics,
// popups, embeds) is aborted so the page settles quickly and cleanly.
const ALLOWED_HOST_SUFFIXES = [
  "comedyhouston.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "s1.ticketm.net",
  "img.evbuc.com",
  "cdn.evbuc.com",
  "theriothtx.com",
  "riotconroe.com",
  "cloudinary.net",
];

const HIDE_CSS = `
  .pum-overlay, .pum, #pum-overlay, [id^="pum-"], .popmake,
  #wpadminbar, .ast-mobile-header-wrap, .cookie-notice, #cookie-law-info-bar,
  .ch-lead-capture, .ch-sticky-cta { display: none !important; }
  html { margin-top: 0 !important; }
`;

function currentMondayStr() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, "0");
  const d = String(monday.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function loadCurrentManifest() {
  const weekly = path.join(COMEDIANS_DIR, `manifest-${currentMondayStr()}.json`);
  if (fs.existsSync(weekly)) return JSON.parse(fs.readFileSync(weekly, "utf8"));
  const legacy = path.join(COMEDIANS_DIR, "manifest.json");
  if (fs.existsSync(legacy)) return JSON.parse(fs.readFileSync(legacy, "utf8"));
  return null;
}

function hostAllowed(url) {
  try {
    const host = new URL(url).hostname;
    return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
  } catch {
    return false;
  }
}

async function shoot(page, url, outPath) {
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 1 });
  const response = await page.goto(url, { waitUntil: "load", timeout: 60000 });
  if (!response || response.status() >= 400) {
    throw new Error(`HTTP ${response ? response.status() : "no response"}`);
  }
  await page.addStyleTag({ content: HIDE_CSS });
  // Let the hero image and web fonts settle; images are eager on the hero
  // figure but a short scroll nudges anything lazy near the fold.
  await page.evaluate(() => window.scrollTo(0, 200));
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: outPath, type: "png", clip: { x: 0, y: 0, width: 1080, height: 1080 } });
}

(async () => {
  const manifest = loadCurrentManifest();
  if (!manifest || !Array.isArray(manifest.posts) || manifest.posts.length === 0) {
    console.log("No current-week manifest — nothing to refresh.");
    return;
  }

  const pending = manifest.posts.filter(
    (p) => p.wpLink && p.slug && !fs.existsSync(path.join(IMAGES_DIR, `${p.slug}.live-refreshed`))
  );
  if (pending.length === 0) {
    console.log("All current-week creative already refreshed.");
    return;
  }
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (hostAllowed(req.url())) req.continue();
    else req.abort();
  });
  let refreshed = 0;

  for (const post of pending) {
    try {
      const teaserPath = path.join(IMAGES_DIR, `${post.slug}-teaser-1.png`);
      await shoot(page, post.wpLink, teaserPath);
      fs.writeFileSync(
        path.join(IMAGES_DIR, `${post.slug}.live-refreshed`),
        new Date().toISOString() + "\n"
      );
      refreshed++;
      console.log(`refreshed live creative: ${post.slug}`);
    } catch (err) {
      // Keep the designed graphics — never block the posting pipeline.
      console.log(`SKIP ${post.slug}: ${err.message}`);
    }
  }

  await browser.close();
  console.log(`Done. ${refreshed}/${pending.length} refreshed.`);
})().catch((err) => {
  // Non-fatal by design: posting proceeds with existing creative.
  console.error(`refresh-live-creative failed (non-fatal): ${err.message}`);
});
