#!/usr/bin/env node

/**
 * Comedy Houston — Blog Post Teaser Screenshot Generator
 *
 * Reads blog/comedians/manifest.json and generates 1080×1080 "teaser" PNGs
 * from each comedian's blog post. These teasers are used as carousel slides
 * in Instagram posts (slide 1 = comedian graphic, slides 2–3 = blog teasers).
 *
 * Each blog post gets 2 teaser images:
 *   - {slug}-teaser-1.png — first section of the blog post
 *   - {slug}-teaser-2.png — second section of the blog post
 *
 * The teasers are styled as branded 1080×1080 cards with the Comedy Houston
 * look, featuring excerpts from the actual blog post text.
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

/**
 * Extract paragraphs from a comedian's blog post HTML.
 * Returns an array of text paragraphs (stripped of HTML tags).
 */
function extractParagraphs(htmlPath) {
  const html = fs.readFileSync(htmlPath, "utf8");

  // Extract content inside <article>...</article>
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (!articleMatch) return [];

  const articleHtml = articleMatch[1];

  // Extract all <p> tags
  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pRegex.exec(articleHtml)) !== null) {
    // Strip HTML tags from paragraph content
    const text = match[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .trim();
    if (text.length > 20) {
      paragraphs.push(text);
    }
  }

  return paragraphs;
}

/**
 * Extract the h1 title from the blog post.
 */
function extractTitle(htmlPath) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!match) return "";
  return match[1].replace(/<[^>]+>/g, "").trim();
}

/**
 * Build a branded 1080×1080 teaser card as HTML.
 */
function buildTeaserHtml(comedianName, title, paragraphText, slideNumber, totalSlides, venue, date) {
  // Truncate text to fit nicely in the card
  const maxChars = 500;
  let displayText = paragraphText;
  if (displayText.length > maxChars) {
    displayText = displayText.slice(0, maxChars).replace(/\s+\S*$/, "") + "…";
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      width: 1080px;
      height: 1080px;
      font-family: 'Inter', sans-serif;
      background: #0a0a0f;
      color: #f0f0f5;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .header {
      padding: 48px 56px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .brand {
      font-size: 28px;
      font-weight: 800;
      background: linear-gradient(135deg, #ff4d6a, #7c5cff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .slide-indicator {
      font-size: 22px;
      color: #666677;
      font-weight: 500;
    }

    .content {
      flex: 1;
      padding: 40px 56px;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .comedian-name {
      font-size: 24px;
      font-weight: 600;
      color: #ff4d6a;
      margin-bottom: 16px;
      text-transform: uppercase;
      letter-spacing: 2px;
    }

    .title {
      font-size: 36px;
      font-weight: 800;
      line-height: 1.25;
      margin-bottom: 32px;
      max-height: 180px;
      overflow: hidden;
    }

    .divider {
      width: 80px;
      height: 4px;
      background: linear-gradient(135deg, #ff4d6a, #7c5cff);
      border-radius: 2px;
      margin-bottom: 32px;
    }

    .text {
      font-size: 26px;
      line-height: 1.65;
      color: #ccccdd;
      overflow: hidden;
      max-height: 400px;
    }

    .footer {
      padding: 0 56px 48px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .cta {
      font-size: 22px;
      font-weight: 700;
      color: #ff4d6a;
    }

    .venue-date {
      font-size: 20px;
      color: #666677;
      font-weight: 500;
      text-align: right;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">Comedy Houston</div>
    <div class="slide-indicator">${slideNumber} / ${totalSlides}</div>
  </div>
  <div class="content">
    <div class="comedian-name">${comedianName}</div>
    ${slideNumber === 2 ? `<div class="title">${title}</div>` : ""}
    <div class="divider"></div>
    <div class="text">${displayText}</div>
  </div>
  <div class="footer">
    <div class="cta">Read more — link in bio</div>
    <div class="venue-date">${venue}<br>${date}</div>
  </div>
</body>
</html>`;
}

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

  console.log(`Processing ${manifest.posts.length} comedians…\n`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewport(TEASER_SIZE);

  let totalScreenshots = 0;

  for (const post of manifest.posts) {
    const blogPath = path.join(COMEDIANS_DIR, post.filename);

    if (!fs.existsSync(blogPath)) {
      console.log(`  Skipping ${post.comedianName} — blog file not found: ${post.filename}`);
      continue;
    }

    console.log(`  ${post.comedianName}:`);

    const paragraphs = extractParagraphs(blogPath);
    const title = extractTitle(blogPath);

    if (paragraphs.length < 2) {
      console.log(`    Only ${paragraphs.length} paragraph(s) — skipping teasers.`);
      continue;
    }

    const venue = post.venue || "";
    const date = post.date || "";
    // Total carousel slides: 1 (graphic) + 2 (teasers) = 3
    const totalSlides = 3;

    // Teaser 1: title + first paragraph (slide 2 of carousel)
    const teaser1Html = buildTeaserHtml(
      post.comedianName, title, paragraphs[0], 2, totalSlides, venue, date
    );
    const teaser1Path = path.join(IMAGES_DIR, `${post.slug}-teaser-1.html`);
    const teaser1Png = path.join(IMAGES_DIR, `${post.slug}-teaser-1.png`);
    fs.writeFileSync(teaser1Path, teaser1Html);

    await page.goto(`file://${teaser1Path}`, { waitUntil: "networkidle0", timeout: 15000 });
    await page.screenshot({ path: teaser1Png, type: "png" });
    console.log(`    → ${post.slug}-teaser-1.png`);
    totalScreenshots++;

    // Teaser 2: second paragraph (slide 3 of carousel)
    const teaser2Html = buildTeaserHtml(
      post.comedianName, "", paragraphs.slice(1, 3).join("\n\n"), 3, totalSlides, venue, date
    );
    const teaser2Path = path.join(IMAGES_DIR, `${post.slug}-teaser-2.html`);
    const teaser2Png = path.join(IMAGES_DIR, `${post.slug}-teaser-2.png`);
    fs.writeFileSync(teaser2Path, teaser2Html);

    await page.goto(`file://${teaser2Path}`, { waitUntil: "networkidle0", timeout: 15000 });
    await page.screenshot({ path: teaser2Png, type: "png" });
    console.log(`    → ${post.slug}-teaser-2.png`);
    totalScreenshots++;
  }

  await browser.close();
  console.log(`\nDone! Generated ${totalScreenshots} teaser screenshots.`);
}

main().catch((err) => {
  console.error("Teaser screenshot error:", err);
  process.exit(1);
});
