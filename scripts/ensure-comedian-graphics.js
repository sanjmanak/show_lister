#!/usr/bin/env node

/**
 * Comedy Houston — self-heal for comedian spotlight graphics.
 *
 * post-to-instagram.js serves blog/comedians/images/<slug>-{square,story}.png
 * to Meta over GitHub Pages. If either file is missing for a comedian in
 * the current week's manifest (a bad cleanup, a failed screenshot step, a
 * manual deletion), the feed post 404s and the run fails. This script runs
 * in post-to-instagram.yml before posting and rebuilds any missing PNG
 * from the manifest itself — name, venue, date and the event image are all
 * in there — using the same template as the Monday generator.
 *
 *   node scripts/ensure-comedian-graphics.js          # current week only
 *   node scripts/ensure-comedian-graphics.js --all    # every manifest
 *
 * Requires puppeteer at runtime (the workflow installs it). Never throws
 * on a per-comedian failure: a rebuild that cannot happen leaves posting
 * to fail loudly on its own.
 */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const { generateComedianGraphicHTML, imagesDir } = require("./lib/comedian-graphics");

const COMEDIANS_DIR = path.resolve(__dirname, "..", "blog", "comedians");
const IMAGES_DIR = imagesDir();
const ALL = process.argv.includes("--all");

const SIZES = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
};

function currentMondayStr() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, "0");
  const d = String(monday.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function loadManifests() {
  if (!fs.existsSync(COMEDIANS_DIR)) return [];
  const names = fs
    .readdirSync(COMEDIANS_DIR)
    .filter((f) => /^manifest(-\d{4}-\d{2}-\d{2})?\.json$/.test(f));
  const wanted = ALL ? names : names.filter((f) => f === `manifest-${currentMondayStr()}.json`);
  const out = [];
  for (const name of wanted) {
    try {
      out.push({ name, manifest: JSON.parse(fs.readFileSync(path.join(COMEDIANS_DIR, name), "utf8")) });
    } catch (err) {
      console.log(`skip ${name}: ${err.message}`);
    }
  }
  return out;
}

(async () => {
  const manifests = loadManifests();
  if (manifests.length === 0) {
    console.log(ALL ? "No manifests found." : "No current-week manifest — nothing to check.");
    return;
  }

  // Work list: one entry per missing PNG. The live-refresh marker means a
  // screenshot deliberately replaced the designed teaser; that file is not
  // a rebuild target, so only the three designed sizes are checked.
  const jobs = [];
  for (const { name, manifest } of manifests) {
    for (const post of manifest.posts || []) {
      if (!post.slug) continue;
      const imageUrl = post.imageUrl || post.graphicImageUrl || "";
      for (const size of Object.keys(SIZES)) {
        const png = path.join(IMAGES_DIR, `${post.slug}-${size}.png`);
        if (fs.existsSync(png)) continue;
        jobs.push({ manifest: name, post, size, png, imageUrl });
      }
    }
  }
  if (jobs.length === 0) {
    console.log("All spotlight graphics present.");
    return;
  }
  console.log(`Rebuilding ${jobs.length} missing graphic(s)...`);
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  let rebuilt = 0;
  for (const job of jobs) {
    const { post, size, png, imageUrl } = job;
    try {
      const html = generateComedianGraphicHTML(post.comedianName, post.venue, post.date, imageUrl, size);
      const htmlPath = png.replace(/\.png$/, ".html");
      fs.writeFileSync(htmlPath, html);
      await page.setViewport(SIZES[size]);
      await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0", timeout: 45000 });
      await page.screenshot({ path: png, type: "png" });
      rebuilt++;
      console.log(`  rebuilt ${path.basename(png)} (${job.manifest})`);
    } catch (err) {
      console.log(`  FAILED ${path.basename(png)}: ${err.message}`);
    }
  }
  await browser.close();
  console.log(`Done. ${rebuilt}/${jobs.length} rebuilt.`);
})().catch((err) => {
  console.error(`ensure-comedian-graphics failed (non-fatal): ${err.message}`);
});
