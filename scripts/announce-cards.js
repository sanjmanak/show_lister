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
 * The card template itself lives in scripts/lib/announce-card.js and is
 * shared with the CI autoposter (scripts/post-announcements.js).
 */

"use strict";

const fs = require("fs");
const path = require("path");
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

const { cardHTML, photoDataUri, slugify } = require("./lib/announce-card");

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
      const dataUri = await photoDataUri(a.image_url);
      const slug = slugify(a.name);
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
