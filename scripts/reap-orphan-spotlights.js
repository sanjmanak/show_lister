#!/usr/bin/env node

/**
 * One-off: delete comedian spotlight posts that predate the week-keyed
 * manifests. delete-comedian-blog-posts.js reaps by manifest, so posts
 * published before manifest-YYYY-MM-DD.json existed (July/Aug 2026) were
 * never taken down after their show. Rule: a post in the comedy-shows
 * category whose slug ends in a date before today and whose slug is not in
 * any current manifest is deleted (force). Weekly roundup posts are left
 * alone (their slugs do not end in a date the same way and the plugin
 * 301s them).
 *
 * Env: WP_SITE_URL / WP_APP_USER / WP_APP_PASSWORD, DRY_RUN
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const WP_SITE_URL = (process.env.WP_SITE_URL || "").replace(/\/$/, "");
const WP_APP_USER = process.env.WP_APP_USER || "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";
const DRY_RUN = !!process.env.DRY_RUN && process.env.DRY_RUN !== "false";
const COMEDIANS_DIR = path.resolve(__dirname, "..", "blog", "comedians");

if (!WP_SITE_URL || !WP_APP_USER || !WP_APP_PASSWORD) {
  console.error("WP credentials not set.");
  process.exit(1);
}

function wpRequest(method, urlPath) {
  const url = new URL(WP_SITE_URL + urlPath);
  const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString("base64");
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { Authorization: `Basic ${auth}` }, timeout: 30000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else reject(new Error(`HTTP ${res.statusCode} ${method} ${urlPath}: ${data.slice(0, 200)}`));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

(async () => {
  const keep = new Set();
  for (const f of fs.readdirSync(COMEDIANS_DIR)) {
    if (!/^manifest(-\d{4}-\d{2}-\d{2})?\.json$/.test(f)) continue;
    const m = JSON.parse(fs.readFileSync(path.join(COMEDIANS_DIR, f), "utf8"));
    for (const p of m.posts || []) keep.add(p.slug);
  }
  const today = new Date().toISOString().slice(0, 10);
  const cats = await wpRequest("GET", "/wp-json/wp/v2/categories?slug=comedy-shows");
  const catId = Array.isArray(cats) && cats[0] ? cats[0].id : 0;
  if (!catId) throw new Error("comedy-shows category not found");

  let deleted = 0;
  for (let page = 1; ; page++) {
    const posts = await wpRequest("GET", `/wp-json/wp/v2/posts?categories=${catId}&per_page=50&page=${page}&status=publish,future,draft,private&_fields=id,slug`);
    if (!Array.isArray(posts) || posts.length === 0) break;
    for (const post of posts) {
      const m = post.slug.match(/-(\d{4}-\d{2}-\d{2})$/);
      if (!m) { console.log(`  keep ${post.slug} (not a dated spotlight slug)`); continue; }
      if (post.slug.startsWith("houston-comedy-shows-")) { console.log(`  keep ${post.slug} (roundup)`); continue; }
      if (keep.has(post.slug)) { console.log(`  keep ${post.slug} (in a current manifest)`); continue; }
      if (m[1] >= today) { console.log(`  keep ${post.slug} (show not past)`); continue; }
      if (DRY_RUN) { console.log(`  DRY RUN would delete ${post.slug} (id ${post.id})`); continue; }
      await wpRequest("DELETE", `/wp-json/wp/v2/posts/${post.id}?force=true`);
      deleted++;
      console.log(`  deleted ${post.slug} (id ${post.id})`);
    }
    if (posts.length < 50) break;
  }
  console.log(`Done. Deleted ${deleted}${DRY_RUN ? " (dry run)" : ""}.`);
})().catch((err) => { console.error(err.message); process.exit(1); });
