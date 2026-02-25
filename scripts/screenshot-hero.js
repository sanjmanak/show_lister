#!/usr/bin/env node

/**
 * Takes a screenshot of blog/weekly-hero.html → blog/weekly-hero.png
 * Used in CI after generate-blog-post.js creates the hero creative HTML.
 */

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

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
  await page.setViewport({ width: 1200, height: 630 });
  await page.goto(`file://${HERO_HTML}`, { waitUntil: "networkidle0" });
  await page.screenshot({ path: HERO_IMAGE, type: "png" });

  await browser.close();
  console.log(`Screenshot saved: ${HERO_IMAGE}`);
}

main().catch((err) => {
  console.error("Screenshot error:", err);
  process.exit(1);
});
