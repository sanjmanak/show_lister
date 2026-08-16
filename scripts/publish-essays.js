#!/usr/bin/env node
/**
 * publish-essays.js — publish the comedian essay series to WordPress.
 *
 * Reads config/essays.json, and for each entry:
 *   1. loads the essay HTML from blog/essays/ (title = the <h1>, stripped from body)
 *   2. uploads the featured image to the WP media library (reused if the post
 *      already has one — re-runs must not pile up duplicate media)
 *   3. creates the post in the comedy-advice category, or updates in place if a
 *      post with that slug already exists in any status (WP REST does not dedupe
 *      by slug — it would auto-suffix "-2" and leave the old post live)
 *
 * Scheduling: schedule_gmt=null (or a past date) publishes now; a future date
 * creates a "future" post WordPress publishes on its own. Already-published
 * posts are never demoted back to "future" by a re-run.
 *
 * Unlike the per-comedian spotlights these are indexable on purpose — no
 * ch_noindex is sent. They're the marquee content the spotlights link down to.
 *
 * Env: WP_SITE_URL, WP_APP_USER, WP_APP_PASSWORD (same secrets as the other
 * WP workflows). Zero npm dependencies.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "essays.json");

const WP_SITE_URL = process.env.WP_SITE_URL || "";
const WP_APP_USER = process.env.WP_APP_USER || "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";

const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 60_000;

if (!WP_SITE_URL || !WP_APP_USER || !WP_APP_PASSWORD) {
  console.error("Missing WP_SITE_URL / WP_APP_USER / WP_APP_PASSWORD env vars.");
  process.exit(1);
}

function wpRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const fullUrl = WP_SITE_URL.replace(/\/$/, "") + urlPath;
    const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString("base64");
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      fullUrl,
      {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : null);
            } catch (e) {
              reject(new Error(`WP ${method} ${urlPath}: unparseable response`));
            }
          } else {
            reject(new Error(`WP ${method} ${urlPath}: HTTP ${res.statusCode} — ${data.slice(0, 300)}`));
          }
        });
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`WP ${method} ${urlPath}: timeout`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function downloadImage(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Too many redirects downloading image"));
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadImage(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Image download: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          buffer: Buffer.concat(chunks),
          contentType: res.headers["content-type"] || "image/jpeg",
        })
      );
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Image download: timeout")));
    req.on("error", reject);
  });
}

function wpUploadImage(buffer, contentType, filename) {
  return new Promise((resolve, reject) => {
    const fullUrl = WP_SITE_URL.replace(/\/$/, "") + "/wp-json/wp/v2/media";
    const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString("base64");
    const req = https.request(
      fullUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": buffer.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error("Media upload: unparseable response"));
            }
          } else {
            reject(new Error(`Media upload: HTTP ${res.statusCode} — ${data.slice(0, 300)}`));
          }
        });
      }
    );
    req.setTimeout(UPLOAD_TIMEOUT_MS, () => req.destroy(new Error("Media upload: timeout")));
    req.on("error", reject);
    req.write(buffer);
    req.end();
  });
}

// House style: no em dashes in anything that ships to readers. This is the
// final gate before WordPress — fail loudly rather than publish one.
function lintNoEmDash(label, text) {
  if (text && text.includes("—")) {
    throw new Error(`em dash found in ${label}; house style forbids them in published copy`);
  }
}

async function publishEssay(essay, categoryId) {
  const htmlPath = path.join(ROOT, essay.file);
  const raw = fs.readFileSync(htmlPath, "utf8");
  lintNoEmDash(essay.file, raw);
  lintNoEmDash(`${essay.slug} excerpt`, essay.excerpt);

  const h1Match = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!h1Match) throw new Error(`No <h1> found in ${essay.file}`);
  const title = h1Match[1].replace(/<[^>]+>/g, "").trim();
  let content = raw.replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, "").trim();

  // Slug dedupe across all statuses — update in place on re-runs.
  const found = await wpRequest(
    "GET",
    `/wp-json/wp/v2/posts?slug=${encodeURIComponent(essay.slug)}&status=publish,draft,future,private&context=edit`,
    null
  );
  const existing = Array.isArray(found) && found.length > 0 ? found[0] : null;

  // Featured image: reuse the existing post's media on re-runs.
  let featuredMediaId = existing && existing.featured_media ? existing.featured_media : 0;
  let wpImageUrl = "";
  if (!featuredMediaId && essay.image_url) {
    const { buffer, contentType } = await downloadImage(essay.image_url);
    const ext = contentType.includes("png") ? "png" : "jpg";
    const media = await wpUploadImage(buffer, contentType, `${essay.slug}.${ext}`);
    featuredMediaId = media.id;
    wpImageUrl = media.source_url || "";
    console.log(`    featured image uploaded (media ${featuredMediaId})`);
  } else if (featuredMediaId) {
    try {
      const media = await wpRequest("GET", `/wp-json/wp/v2/media/${featuredMediaId}`, null);
      wpImageUrl = media.source_url || "";
    } catch (_) {
      /* post keeps its featured image; in-body figure just gets skipped */
    }
  }

  if (wpImageUrl) {
    const alt = (essay.image_alt || title).replace(/"/g, "&quot;");
    content =
      `<figure class="wp-block-image size-large"><img src="${wpImageUrl}" alt="${alt}" class="wp-image-${featuredMediaId}"/></figure>\n\n` +
      content;
  }

  // Scheduling. Never demote an already-published post back to "future".
  let status = "publish";
  let dateGmt = null;
  if (essay.schedule_gmt && new Date(essay.schedule_gmt + "Z") > new Date()) {
    if (existing && existing.status === "publish") {
      console.log("    already published — leaving live (schedule ignored)");
    } else {
      status = "future";
      dateGmt = essay.schedule_gmt;
    }
  }

  const postData = {
    title,
    content,
    excerpt: essay.excerpt || "",
    status,
    slug: essay.slug,
    comment_status: "closed",
  };
  if (dateGmt) postData.date_gmt = dateGmt;
  if (featuredMediaId) postData.featured_media = featuredMediaId;
  if (categoryId) postData.categories = [categoryId];

  let post;
  if (existing) {
    post = await wpRequest("POST", `/wp-json/wp/v2/posts/${existing.id}`, postData);
    console.log(`    updated post ${post.id} (${post.status}) — ${post.link}`);
  } else {
    post = await wpRequest("POST", "/wp-json/wp/v2/posts", postData);
    console.log(`    created post ${post.id} (${post.status}) — ${post.link}`);
  }
  return post;
}

(async () => {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  const me = await wpRequest("GET", "/wp-json/wp/v2/users/me", null);
  console.log(`WP auth OK — "${me.name}" (id=${me.id})`);

  let categoryId = 0;
  try {
    const cats = await wpRequest(
      "GET",
      `/wp-json/wp/v2/categories?slug=${encodeURIComponent(config.category_slug)}`,
      null
    );
    if (Array.isArray(cats) && cats.length > 0) categoryId = cats[0].id;
  } catch (e) {
    console.warn(`Category lookup failed: ${e.message}`);
  }
  console.log(`Category "${config.category_slug}" → id ${categoryId || "(none — posts go Uncategorized)"}`);

  const failures = [];
  for (const essay of config.essays) {
    console.log(`\n▸ ${essay.slug}`);
    try {
      await publishEssay(essay, categoryId);
    } catch (err) {
      console.error(`    FAILED: ${err.message}`);
      failures.push(essay.slug);
    }
  }

  console.log(`\nDone. ${config.essays.length - failures.length}/${config.essays.length} succeeded.`);
  if (failures.length) {
    console.error(`Failed: ${failures.join(", ")}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
