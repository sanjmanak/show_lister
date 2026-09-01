#!/usr/bin/env node

/**
 * Comedy Houston — Deletes comedian spotlight BLOG POSTS once their show
 * week is over.
 *
 * Counterpart to delete-comedian-posts.js (which removes the IG/FB social
 * posts). With the 3-week-lead pipeline the blog posts are INDEXABLE, so
 * they cannot be left to pile up as stale thin content: each week's posts
 * come down the weekend after the show week ends.
 *
 * Mechanics: scans blog/comedians/manifest-*.json (plus the legacy
 * manifest.json); any manifest whose newest post date is before REAP_AFTER
 * days ago has every post deleted from WordPress (lookup by slug, force
 * delete), its local per-comedian files removed, and the manifest renamed
 * to archive/<name> so the sweep is idempotent and the history stays in
 * git. Runs daily from delete-old-comedian-posts.yml; deletions only
 * actually trigger on the first run after a week has fully passed.
 *
 * Env:
 *   WP_SITE_URL / WP_APP_USER / WP_APP_PASSWORD   WordPress REST creds
 *   DRY_RUN                                        truthy → log only
 *   REAP_AFTER_DAYS                                grace days after the last
 *                                                  show date (default 1 —
 *                                                  a Sunday show dies Tue)
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const OUTPUT_DIR = path.resolve(__dirname, "..");
const COMEDIANS_DIR = path.join(OUTPUT_DIR, "blog", "comedians");
const IMAGES_DIR = path.join(COMEDIANS_DIR, "images");
const ARCHIVE_DIR = path.join(COMEDIANS_DIR, "archive");

const WP_SITE_URL = (process.env.WP_SITE_URL || "").replace(/\/$/, "");
const WP_APP_USER = process.env.WP_APP_USER || "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";
const DRY_RUN = !!process.env.DRY_RUN && process.env.DRY_RUN !== "false";
const REAP_AFTER_DAYS = Math.max(0, parseInt(process.env.REAP_AFTER_DAYS || "1", 10) || 1);

if (!WP_SITE_URL || !WP_APP_USER || !WP_APP_PASSWORD) {
  console.log("WP credentials not set — nothing to do.");
  process.exit(0);
}

function wpRequest(method, urlPath) {
  const url = new URL(WP_SITE_URL + urlPath);
  const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString("base64");
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method, headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" }, timeout: 30000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body)); } catch { resolve(body); }
          } else reject(new Error(`HTTP ${res.statusCode} ${method} ${urlPath}`));
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function deletePostBySlug(slug) {
  const found = await wpRequest("GET", `/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&status=publish,draft,future,private`);
  if (!Array.isArray(found) || found.length === 0) {
    console.log(`    (no WP post for slug ${slug} — already gone)`);
    return false;
  }
  if (DRY_RUN) {
    console.log(`    DRY RUN: would delete WP post ${found[0].id} (${slug})`);
    return false;
  }
  await wpRequest("DELETE", `/wp-json/wp/v2/posts/${found[0].id}?force=true`);
  console.log(`    deleted WP post ${found[0].id} (${slug})`);
  return true;
}

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

(async () => {
  if (!fs.existsSync(COMEDIANS_DIR)) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - REAP_AFTER_DAYS);
  const cutoffStr = localDateStr(cutoff);

  const manifests = fs
    .readdirSync(COMEDIANS_DIR)
    .filter((f) => /^manifest(-\d{4}-\d{2}-\d{2})?\.json$/.test(f));

  let reaped = 0;
  for (const name of manifests) {
    const full = path.join(COMEDIANS_DIR, name);
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(full, "utf8")); } catch { continue; }
    const posts = manifest.posts || [];
    if (posts.length === 0) continue;
    const lastShowDate = posts.map((p) => p.date || "").sort().slice(-1)[0];
    if (!lastShowDate || lastShowDate >= cutoffStr) continue; // week not over yet

    console.log(`Reaping ${name} (last show ${lastShowDate}, cutoff ${cutoffStr}):`);
    for (const post of posts) {
      try {
        await deletePostBySlug(post.slug);
      } catch (err) {
        console.log(`    FAILED ${post.slug}: ${err.message} — manifest kept for retry`);
        // Leave the manifest in place so tomorrow's run retries this week.
        manifest._reap_failed = true;
      }
      if (!DRY_RUN) {
        // Local artifacts: post html, caption, graphics, marker.
        const victims = [
          path.join(COMEDIANS_DIR, `${post.slug}.html`),
          path.join(COMEDIANS_DIR, `${post.slug}-caption.txt`),
          path.join(IMAGES_DIR, `${post.slug}.live-refreshed`),
        ];
        for (const f of fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR) : []) {
          if (f.startsWith(post.slug)) victims.push(path.join(IMAGES_DIR, f));
        }
        for (const v of victims) {
          if (fs.existsSync(v)) { fs.unlinkSync(v); }
        }
      }
    }
    if (!manifest._reap_failed && !DRY_RUN) {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      fs.renameSync(full, path.join(ARCHIVE_DIR, name.replace(".json", `.reaped-${localDateStr(new Date())}.json`)));
      console.log(`  archived ${name}`);
      reaped++;
    }
  }
  console.log(`Done. ${reaped} week(s) reaped${DRY_RUN ? " (dry run)" : ""}.`);
})().catch((err) => {
  console.error(`delete-comedian-blog-posts failed: ${err.message}`);
  process.exit(1);
});
