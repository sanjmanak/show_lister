#!/usr/bin/env node

/**
 * Takes a screenshot of blog/weekly-hero.html → blog/weekly-hero.png
 * Used in CI after generate-blog-post.js creates the hero creative HTML.
 */

const path = require("path");
const fs = require("fs");

// Puppeteer is a heavy dependency and isn't always installed on a fresh
// checkout. Give the user a clear, actionable error instead of Node's
// default "Cannot find module 'puppeteer'" stack trace.
let puppeteer;
try {
  puppeteer = require("puppeteer");
} catch (err) {
  console.error(
    "screenshot-hero.js: puppeteer is not installed.\n" +
      "  Install it with `npm install puppeteer` (or `npm ci` if the\n" +
      "  project lockfile already has it pinned). On CI, the workflow\n" +
      "  step that builds the weekly hero PNG must run `npm install`\n" +
      "  before invoking this script."
  );
  process.exit(1);
}

const HERO_HTML = path.resolve(__dirname, "../blog/weekly-hero.html");
const HERO_IMAGE = path.resolve(__dirname, "../blog/weekly-hero.png");

async function main() {
  if (!fs.existsSync(HERO_HTML)) {
    console.log("No hero HTML found, skipping screenshot.");
    process.exit(0);
  }

  console.log("Launching headless browser...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080 });
  await page.goto(`file://${HERO_HTML}`, { waitUntil: "networkidle0" });
  await page.screenshot({ path: HERO_IMAGE, type: "png" });

  await browser.close();
  console.log(`Screenshot saved: ${HERO_IMAGE}`);
}

main().catch((err) => {
  console.error("Screenshot error:", err);
  process.exit(1);
});
