/**
 * Comedy Houston — per-comedian Instagram graphic templates.
 *
 * Renders the square (1080x1080), portrait (1080x1350) and story
 * (1080x1920) HTML cards for a comedian spotlight: event image on top, a
 * gradient, and name / date / venue / brand at the bottom. Puppeteer turns
 * the HTML into PNGs (screenshot-comedian-graphics.js at generation time,
 * ensure-comedian-graphics.js as a self-heal before posting).
 *
 * Shared by generate-comedian-post.js and ensure-comedian-graphics.js so a
 * rebuilt graphic is pixel-identical to the original.
 */

"use strict";

const fs = require("fs");
const path = require("path");

function imagesDir() {
  return path.resolve(__dirname, "..", "..", "blog", "comedians", "images");
}

function formatDateForDisplay(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function generateComedianGraphicHTML(name, venue, dateStr, imageUrl, size) {
  const displayDate = formatDateForDisplay(dateStr);
  const safeName = name
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const safeVenue = (venue || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const safeDate = displayDate
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const safeImage = (imageUrl || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");

  const dims = {
    square:   { w: 1080, h: 1080 },
    portrait: { w: 1080, h: 1350 },
    story:    { w: 1080, h: 1920 },
  };
  const { w, h } = dims[size];

  // --- Size-specific layout tuning ---
  // Square: tight crop, text fills bottom third
  // Portrait: more breathing room, slight pullback
  // Story: full vertical, photo top 55%, details fill bottom
  const config = {
    square: {
      photoHeight: "68%",
      gradientHeight: "55%",
      objectPosition: "center 20%",
      nameFontSize: "80px",
      dateFontSize: "36px",
      venueFontSize: "29px",
      brandFontSize: "20px",
      bottomPadding: "48px",
      sidePadding: "56px",
      accentWidth: "52px",
      accentHeight: "4px",
    },
    portrait: {
      photoHeight: "62%",
      gradientHeight: "52%",
      objectPosition: "center 15%",
      nameFontSize: "84px",
      dateFontSize: "38px",
      venueFontSize: "31px",
      brandFontSize: "20px",
      bottomPadding: "56px",
      sidePadding: "56px",
      accentWidth: "52px",
      accentHeight: "4px",
    },
    story: {
      photoHeight: "55%",
      gradientHeight: "55%",
      objectPosition: "center 15%",
      nameFontSize: "88px",
      dateFontSize: "40px",
      venueFontSize: "33px",
      brandFontSize: "22px",
      bottomPadding: "64px",
      sidePadding: "60px",
      accentWidth: "56px",
      accentHeight: "5px",
    },
  };
  const c = config[size];

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${w}px;
      height: ${h}px;
      font-family: 'Inter', sans-serif;
      overflow: hidden;
      position: relative;
      background: #0a0a0f;
    }
    .photo {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: ${c.photoHeight};
      object-fit: cover;
      object-position: ${c.objectPosition};
    }
    .gradient {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      height: ${c.gradientHeight};
      background: linear-gradient(
        to bottom,
        rgba(10, 10, 15, 0) 0%,
        rgba(10, 10, 15, 0.55) 30%,
        rgba(10, 10, 15, 0.88) 55%,
        rgba(10, 10, 15, 1) 75%
      );
    }
    .content {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      padding: 0 ${c.sidePadding} ${c.bottomPadding};
      z-index: 2;
    }
    .accent-line {
      width: ${c.accentWidth};
      height: ${c.accentHeight};
      background: #ff4d6a;
      margin-bottom: 20px;
    }
    .name {
      font-size: ${c.nameFontSize};
      font-weight: 900;
      color: #ffffff;
      letter-spacing: -0.03em;
      line-height: 1.05;
      margin-bottom: 16px;
      text-shadow: 0 2px 20px rgba(0, 0, 0, 0.5);
    }
    .date {
      font-size: ${c.dateFontSize};
      font-weight: 700;
      color: rgba(255, 255, 255, 0.95);
      line-height: 1.3;
      margin-bottom: 6px;
    }
    .venue {
      font-size: ${c.venueFontSize};
      font-weight: 500;
      color: rgba(255, 255, 255, 0.7);
      line-height: 1.3;
      margin-bottom: 24px;
    }
    .brand {
      font-size: ${c.brandFontSize};
      font-weight: 700;
      letter-spacing: 3px;
      color: #ff4d6a;
      z-index: 2;
    }
  </style>
</head>
<body>
  ${imageUrl ? `<img class="photo" src="${safeImage}" alt="${safeName}">` : ""}
  <div class="gradient"></div>
  <div class="content">
    <div class="accent-line"></div>
    <div class="name">${safeName}</div>
    <div class="date">${safeDate}</div>
    <div class="venue">${safeVenue}</div>
    <div class="brand">COMEDYHOUSTON.COM</div>
  </div>
</body>
</html>`;
}

/**
 * Write all 3 Instagram graphic HTML files for a comedian.
 * Returns array of { htmlPath, pngPath, size, slug } objects.
 */
function writeComedianGraphics(name, venue, date, imageUrl, slug) {
  const IMAGES_DIR = imagesDir();
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }

  const sizes = ["square", "portrait", "story"];
  const results = [];

  for (const size of sizes) {
    const html = generateComedianGraphicHTML(name, venue, date, imageUrl, size);
    const htmlFile = `${slug}-${size}.html`;
    const pngFile = `${slug}-${size}.png`;
    const htmlPath = path.join(IMAGES_DIR, htmlFile);
    fs.writeFileSync(htmlPath, html);
    results.push({
      htmlPath,
      pngPath: path.join(IMAGES_DIR, pngFile),
      pngFile,
      size,
      slug,
    });
  }

  return results;
}

module.exports = {
  generateComedianGraphicHTML,
  writeComedianGraphics,
  formatDateForDisplay,
  imagesDir,
};
