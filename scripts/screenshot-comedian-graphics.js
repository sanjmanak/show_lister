#!/usr/bin/env node

/**
 * Screenshots all comedian Instagram graphic HTML files → PNG.
 *
 * Reads blog/comedians/images/*.html and produces matching .png files.
 * Each HTML file encodes its dimensions in the body element (width/height in CSS).
 *
 * Sizes:
 *   *-square.html   → 1080×1080
 *   *-portrait.html → 1080×1350
 *   *-story.html    → 1080×1920
 */

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

const IMAGES_DIR = path.resolve(__dirname, "../blog/comedians/images");

const SIZE_MAP = {
  square:   { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  story:    { width: 1080, height: 1920 },
};

async function main() {
  if (!fs.existsSync(IMAGES_DIR)) {
    console.log("No images directory found, skipping screenshots.");
    process.exit(0);
  }

  const htmlFiles = fs.readdirSync(IMAGES_DIR).filter((f) => f.endsWith(".html"));
  if (htmlFiles.length === 0) {
    console.log("No HTML graphic files found, skipping screenshots.");
    process.exit(0);
  }

  console.log(`Found ${htmlFiles.length} graphic template(s) to screenshot.`);
  console.log("Launching headless browser...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  for (const htmlFile of htmlFiles) {
    // Determine size from filename suffix
    let size = null;
    for (const key of Object.keys(SIZE_MAP)) {
      if (htmlFile.includes(`-${key}.html`)) {
        size = key;
        break;
      }
    }

    if (!size) {
      console.log(`  Skipping ${htmlFile} — unknown size suffix.`);
      continue;
    }

    const { width, height } = SIZE_MAP[size];
    const htmlPath = path.join(IMAGES_DIR, htmlFile);
    const pngFile = htmlFile.replace(/\.html$/, ".png");
    const pngPath = path.join(IMAGES_DIR, pngFile);

    await page.setViewport({ width, height });
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0", timeout: 30000 });
    await page.screenshot({ path: pngPath, type: "png" });
    console.log(`  ${htmlFile} → ${pngFile} (${width}×${height})`);
  }

  await browser.close();
  console.log(`Done. Screenshotted ${htmlFiles.length} graphic(s).`);
}

main().catch((err) => {
  console.error("Screenshot error:", err);
  process.exit(1);
});
