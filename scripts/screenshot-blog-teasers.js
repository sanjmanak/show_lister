#!/usr/bin/env node

/**
 * Comedy Houston — Blog Post Teaser Screenshot Generator
 *
 * Reads blog/comedians/manifest.json and screenshots each comedian's
 * live WordPress blog post to create carousel teaser images for Instagram.
 *
 * Each blog post gets 2 screenshots:
 *   - {slug}-teaser-1.png — top of the blog post (hero + intro)
 *   - {slug}-teaser-2.png — scrolled down (body content)
 *
 * Screenshots are taken from the live WordPress site (comedyhouston.com)
 * so they reflect the real published look and feel.
 *
 * Output: 1080×1080 PNGs saved to blog/comedians/images/
 *
 * Requires: puppeteer (installed by the workflow, not committed)
 */

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

const COMEDIANS_DIR = path.resolve(__dirname, "../blog/comedians");
const IMAGES_DIR = path.join(COMEDIANS_DIR, "images");
const MANIFEST_PATH = path.join(COMEDIANS_DIR, "manifest.json");

const TEASER_SIZE = { width: 1080, height: 1080 };

async function main() {
  console.log("=== Comedy Houston — Blog Teaser Screenshot Generator ===\n");

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.log("No manifest.json found — nothing to do.");
    process.exit(0);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  if (!manifest.posts || manifest.posts.length === 0) {
    console.log("Manifest has no posts — nothing to do.");
    process.exit(0);
  }

  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }

  // Filter to posts that have a WordPress link
  const postsWithWp = manifest.posts.filter((p) => p.wpLink);
  if (postsWithWp.length === 0) {
    console.log("No posts have WordPress links — nothing to screenshot.");
    process.exit(0);
  }

  console.log(`Processing ${postsWithWp.length} comedians with WordPress posts…\n`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  // Set viewport to 1080 wide — screenshots will be 1080×1080 crops
  await page.setViewport({ width: 1080, height: 1080 });

  let totalScreenshots = 0;

  for (const post of postsWithWp) {
    console.log(`  ${post.comedianName}:`);
    console.log(`    URL: ${post.wpLink}`);

    try {
      // Navigate to the WordPress blog post
      const response = await page.goto(post.wpLink, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      if (!response || response.status() >= 400) {
        console.log(`    SKIP — page returned HTTP ${response ? response.status() : "no response"}`);
        continue;
      }

      // Wait a moment for any lazy-loaded images/fonts
      await new Promise((r) => setTimeout(r, 2000));

      // Teaser 1: Top of the page (hero area + intro)
      const teaser1Path = path.join(IMAGES_DIR, `${post.slug}-teaser-1.png`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((r) => setTimeout(r, 500));
      await page.screenshot({
        path: teaser1Path,
        type: "png",
        clip: { x: 0, y: 0, width: 1080, height: 1080 },
      });
      console.log(`    → ${post.slug}-teaser-1.png (top of page)`);
      totalScreenshots++;

      // Teaser 2: Scrolled down to show body content
      const teaser2Path = path.join(IMAGES_DIR, `${post.slug}-teaser-2.png`);
      await page.evaluate(() => window.scrollTo(0, 800));
      await new Promise((r) => setTimeout(r, 500));
      await page.screenshot({
        path: teaser2Path,
        type: "png",
        clip: { x: 0, y: 0, width: 1080, height: 1080 },
      });
      console.log(`    → ${post.slug}-teaser-2.png (scrolled content)`);
      totalScreenshots++;

    } catch (err) {
      console.log(`    ERROR — ${err.message}`);
      console.log(`    Skipping teasers for ${post.comedianName}.`);
    }
  }

  await browser.close();
  console.log(`\nDone! Generated ${totalScreenshots} teaser screenshots.`);
}

main().catch((err) => {
  console.error("Teaser screenshot error:", err);
  process.exit(1);
});
