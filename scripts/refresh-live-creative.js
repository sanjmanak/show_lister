#!/usr/bin/env node

/**
 * Comedy Houston — Week-of creative refresh for comedian spotlights.
 *
 * With the 3-week-lead pipeline, spotlight blog posts publish ~3 weeks
 * before the show and (ideally) pick up search impressions. The week of
 * the show, the IG creative becomes a live screenshot of that ranking
 * page: this script loads each current-week comedian's published post in
 * headless Chrome and overwrites their square (1080x1080) and story
 * (1080x1920) PNGs in blog/comedians/images/, which post-to-instagram.js
 * then serves to Meta via GitHub Pages at the SAME urls as before.
 *
 * Idempotent per comedian per week: a <slug>.live-refreshed marker file is
 * written next to the PNGs; comedians with a marker are skipped, so the
 * every-6-hours workflow only pays the screenshot cost once per comedian.
 * Falls back silently (keeps the pre-generated designed graphics) when the
 * post URL does not load — a missing screenshot must never block posting.
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

async function shoot(page, url, viewport, outPath) {
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
  // Nudge lazy images near the top of the page to load, then settle.
  await page.evaluate(() => window.scrollTo(0, 200));
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: outPath, type: "png" });
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

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  let refreshed = 0;

  for (const post of pending) {
    try {
      const squarePath = path.join(IMAGES_DIR, `${post.slug}-square.png`);
      const storyPath = path.join(IMAGES_DIR, `${post.slug}-story.png`);
      await shoot(page, post.wpLink, { width: 1080, height: 1080 }, squarePath);
      await shoot(page, post.wpLink, { width: 1080, height: 1920 }, storyPath);
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
