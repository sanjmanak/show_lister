#!/usr/bin/env node
/**
 * generate-essay-graphics.js — render Instagram quote cards for the comedian
 * essay series (config/essays.json).
 *
 * Per essay: three 1080x1080 feed squares (one per pull quote) plus one
 * 1080x1920 story of the first quote, and a ready-to-post caption file.
 * Output: blog/essays/graphics/<slug>-q1.png, -q2.png, -q3.png, -story.png,
 * -caption.txt. All 18 quote cards across the series are recyclable evergreen
 * creative; nothing here expires.
 *
 * Modes:
 *   (default)      promote the next LIVE essay not yet in promo-state.json.
 *                  Writes graphics + caption + latest.json (consumed by the
 *                  essay-promo workflow's email step) and records the slug in
 *                  blog/essays/promo-state.json. If nothing needs promoting,
 *                  exits 0 without writing latest.json, so the workflow's
 *                  email step is skipped.
 *   --slug=<slug>  force a specific essay (also updates state).
 *   --all          regenerate every essay's cards (library refresh; does not
 *                  touch state or latest.json).
 *
 * House style is enforced: any em dash in the essay HTML, pull quotes,
 * excerpt, or caption fails the run.
 *
 * Requires puppeteer at runtime (CI: `npm install puppeteer` first).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "essays.json");
const OUT_DIR = path.join(ROOT, "blog", "essays", "graphics");
const STATE_PATH = path.join(ROOT, "blog", "essays", "promo-state.json");
const LATEST_PATH = path.join(OUT_DIR, "latest.json");
const NAV_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// House-style lint: no em dashes anywhere in user-facing copy.
// ---------------------------------------------------------------------------
function lintNoEmDash(label, text) {
  if (text && text.includes("—")) {
    throw new Error(`Em dash found in ${label} — house style forbids them in copy. Fix the source and re-run.`);
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Quote length → font size so short punchy quotes go huge and long ones fit.
function quoteFontSize(quote, isStory) {
  const len = quote.length;
  if (isStory) {
    if (len < 60) return 84;
    if (len < 90) return 72;
    return 62;
  }
  if (len < 60) return 76;
  if (len < 90) return 64;
  return 54;
}

function cardHTML(quote, essayTitle, { width, height, story }) {
  const fontSize = quoteFontSize(quote, story);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${width}px; height: ${height}px;
      font-family: 'Inter', sans-serif;
      background: #0a0a0f;
      background-image: radial-gradient(ellipse 120% 70% at 85% 0%, rgba(124, 92, 255, 0.16), transparent 60%),
                        radial-gradient(ellipse 100% 60% at 10% 100%, rgba(255, 77, 106, 0.12), transparent 55%);
      color: #ffffff;
      display: flex; flex-direction: column;
      padding: ${story ? "180px 96px 160px" : "88px 88px 76px"};
      overflow: hidden;
    }
    .brand {
      display: flex; align-items: center; gap: 18px;
      margin-bottom: ${story ? "auto" : "56px"};
    }
    .brand-bar { width: 52px; height: 8px; border-radius: 4px;
      background: linear-gradient(90deg, #ff4d6a, #7c5cff); }
    .brand-name { font-weight: 800; font-size: 30px; letter-spacing: 0.22em; color: #ffffff; }
    .quote-wrap { margin: auto 0; }
    .quote-mark { font-weight: 900; font-size: 150px; line-height: 0.6; color: #ff4d6a; margin-bottom: 34px; }
    .quote { font-weight: 800; font-size: ${fontSize}px; line-height: 1.22; letter-spacing: -0.015em; }
    .footer { margin-top: ${story ? "auto" : "64px"}; }
    .essay-title { font-weight: 600; font-size: 30px; color: rgba(255,255,255,0.55); margin-bottom: 22px; }
    .cta { display: flex; align-items: center; justify-content: space-between; }
    .url { font-weight: 800; font-size: 32px; color: #ff4d6a; }
    .tag { font-weight: 700; font-size: 24px; letter-spacing: 0.18em; color: rgba(255,255,255,0.35); }
  </style>
</head>
<body>
  <div class="brand"><div class="brand-bar"></div><div class="brand-name">COMEDY HOUSTON</div></div>
  <div class="quote-wrap">
    <div class="quote-mark">&ldquo;</div>
    <div class="quote">${escapeHtml(quote)}</div>
  </div>
  <div class="footer">
    <div class="essay-title">From: ${escapeHtml(essayTitle)}</div>
    <div class="cta"><div class="url">comedyhouston.com</div><div class="tag">NOTES FOR WORKING COMICS</div></div>
  </div>
</body>
</html>`;
}

// Same Puppeteer pattern as generate-tonight-post.js / screenshot-hero.js.
async function screenshotHTML(html, width, height, outPath) {
  let puppeteer;
  try {
    puppeteer = require("puppeteer");
  } catch (err) {
    throw new Error("puppeteer is not installed. On CI, run `npm install puppeteer` before this script.");
  }
  const tmpHtml = outPath.replace(/\.png$/, ".html");
  fs.writeFileSync(tmpHtml, html);
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.goto(`file://${tmpHtml}`, { waitUntil: "networkidle0", timeout: NAV_TIMEOUT_MS });
    await page.screenshot({ path: outPath, type: "png" });
    console.log(`  saved ${path.relative(ROOT, outPath)}`);
  } finally {
    await browser.close();
    try { fs.unlinkSync(tmpHtml); } catch {}
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { promoted: {} };
  }
}

function essayTitle(essay) {
  const raw = fs.readFileSync(path.join(ROOT, essay.file), "utf8");
  const m = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) throw new Error(`No <h1> in ${essay.file}`);
  return m[1].replace(/<[^>]+>/g, "").trim();
}

function lintEssay(essay) {
  lintNoEmDash(`${essay.slug} html`, fs.readFileSync(path.join(ROOT, essay.file), "utf8"));
  lintNoEmDash(`${essay.slug} excerpt`, essay.excerpt);
  lintNoEmDash(`${essay.slug} ig_caption`, essay.ig_caption);
  (essay.pull_quotes || []).forEach((q, i) => lintNoEmDash(`${essay.slug} pull_quotes[${i}]`, q));
}

async function renderEssay(essay) {
  const title = essayTitle(essay);
  const quotes = essay.pull_quotes || [];
  if (quotes.length === 0) throw new Error(`${essay.slug}: no pull_quotes in config/essays.json`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = [];
  for (let i = 0; i < quotes.length; i++) {
    const out = path.join(OUT_DIR, `${essay.slug}-q${i + 1}.png`);
    await screenshotHTML(cardHTML(quotes[i], title, { width: 1080, height: 1080, story: false }), 1080, 1080, out);
    files.push(path.relative(ROOT, out));
  }
  const storyOut = path.join(OUT_DIR, `${essay.slug}-story.png`);
  await screenshotHTML(cardHTML(quotes[0], title, { width: 1080, height: 1920, story: true }), 1080, 1920, storyOut);
  files.push(path.relative(ROOT, storyOut));

  const captionPath = path.join(OUT_DIR, `${essay.slug}-caption.txt`);
  fs.writeFileSync(captionPath, (essay.ig_caption || "") + "\n");
  files.push(path.relative(ROOT, captionPath));
  return { title, files };
}

(async () => {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const args = process.argv.slice(2);
  const slugArg = (args.find((a) => a.startsWith("--slug=")) || "").replace("--slug=", "");
  const all = args.includes("--all");

  config.essays.forEach(lintEssay);

  if (all) {
    for (const essay of config.essays) {
      console.log(`▸ ${essay.slug}`);
      await renderEssay(essay);
    }
    console.log(`\nLibrary refresh done: ${config.essays.length} essays, ${config.essays.length * 4} images.`);
    return;
  }

  const state = loadState();
  let target = null;
  if (slugArg) {
    target = config.essays.find((e) => e.slug === slugArg);
    if (!target) throw new Error(`Unknown slug: ${slugArg}`);
  } else {
    const now = new Date();
    target = config.essays.find(
      (e) =>
        !state.promoted[e.slug] &&
        (!e.schedule_gmt || new Date(e.schedule_gmt + "Z") <= now)
    );
  }

  if (!target) {
    console.log("Nothing to promote: every live essay has already had its creative generated.");
    try { fs.unlinkSync(LATEST_PATH); } catch {}
    return;
  }

  console.log(`▸ ${target.slug}`);
  const { title, files } = await renderEssay(target);

  state.promoted[target.slug] = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  fs.writeFileSync(
    LATEST_PATH,
    JSON.stringify({ slug: target.slug, title, files, caption: target.ig_caption }, null, 2) + "\n"
  );
  console.log(`\nCreative ready for approval: ${target.slug} (${files.length} files).`);
})().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
