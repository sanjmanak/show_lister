#!/usr/bin/env node

/**
 * One-off backfill: center the hero <figure> on already-published comedian
 * spotlight posts. New posts get the centered figure from
 * generate-comedian-post.js; the plugin CSS (v2.16.0) covers old posts
 * once uploaded. This patches the post content directly so the week-of
 * Instagram screenshots look right before the plugin is deployed.
 *
 * Idempotent: only touches posts whose content starts with the plain
 * `<figure class="wp-block-image size-large">` the generator used to emit.
 *
 * Env: WP_SITE_URL / WP_APP_USER / WP_APP_PASSWORD, DRY_RUN (truthy = log only)
 */

const https = require("https");

const WP_SITE_URL = (process.env.WP_SITE_URL || "").replace(/\/$/, "");
const WP_APP_USER = process.env.WP_APP_USER || "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";
const DRY_RUN = !!process.env.DRY_RUN && process.env.DRY_RUN !== "false";

if (!WP_SITE_URL || !WP_APP_USER || !WP_APP_PASSWORD) {
  console.error("WP credentials not set.");
  process.exit(1);
}

function wpRequest(method, urlPath, body) {
  const url = new URL(WP_SITE_URL + urlPath);
  const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString("base64");
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch { resolve(data); }
          } else reject(new Error(`HTTP ${res.statusCode} ${method} ${urlPath}: ${data.slice(0, 200)}`));
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

const OLD_OPEN = '<figure class="wp-block-image size-large"><img ';
const NEW_OPEN =
  '<figure class="wp-block-image size-large aligncenter ch-post-hero" style="width:fit-content;max-width:100%;margin-left:auto;margin-right:auto"><img style="display:block;max-width:100%;height:auto" ';

(async () => {
  const cats = await wpRequest("GET", "/wp-json/wp/v2/categories?slug=comedy-shows");
  const catId = Array.isArray(cats) && cats[0] ? cats[0].id : 0;
  if (!catId) throw new Error("comedy-shows category not found");

  let page = 1;
  let fixed = 0;
  let scanned = 0;
  for (;;) {
    const posts = await wpRequest(
      "GET",
      `/wp-json/wp/v2/posts?categories=${catId}&per_page=50&page=${page}&status=publish,future,draft&context=edit`
    );
    if (!Array.isArray(posts) || posts.length === 0) break;
    for (const post of posts) {
      scanned++;
      const raw = post.content && post.content.raw ? post.content.raw : "";
      if (!raw.startsWith(OLD_OPEN)) {
        console.log(`  skip ${post.slug} (already centered or no hero figure)`);
        continue;
      }
      const updated = NEW_OPEN + raw.slice(OLD_OPEN.length);
      if (DRY_RUN) {
        console.log(`  DRY RUN would fix ${post.slug}`);
        continue;
      }
      await wpRequest("POST", `/wp-json/wp/v2/posts/${post.id}`, { content: updated });
      fixed++;
      console.log(`  fixed ${post.slug}`);
    }
    if (posts.length < 50) break;
    page++;
  }
  console.log(`Done. Scanned ${scanned}, fixed ${fixed}${DRY_RUN ? " (dry run)" : ""}.`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
