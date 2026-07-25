#!/usr/bin/env node

/**
 * Comedy Houston — one-time noindex backfill for the per-comedian archive.
 *
 * Flags existing per-comedian/per-event preview posts with ch_noindex=1
 * (a REST field registered by the Comedy Houston plugin v2.8.0+, which then
 * emits <meta name="robots" content="noindex, follow"> on those posts).
 * New posts get the flag at publish time from generate-comedian-post.js;
 * this script covers the ~90 already published.
 *
 * A post is targeted when its slug ends in a -YYYY-MM-DD date suffix
 * (adam-hunter-the-riot-comedy-club-conroe-2026-07-24, ...) EXCEPT:
 *   - houston-comedy-shows-this-week-*  — retired weekly roundups, already
 *     301'd to /this-week/ by the plugin; noindexing a redirecting URL is
 *     pointless.
 *   - posts with ch_allow_index set     — the operator's keep-indexed list.
 *   - posts already flagged ch_noindex  — nothing to do.
 *
 * DRY RUN by default — prints what it would flag. Pass --apply to write.
 *
 * Env: WP_SITE_URL, WP_APP_USER, WP_APP_PASSWORD (same application-password
 * credentials the publishing scripts use).
 */

const WP_SITE_URL = (process.env.WP_SITE_URL || "").replace(/\/$/, "");
const WP_APP_USER = process.env.WP_APP_USER || "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";
const APPLY = process.argv.includes("--apply");

const DATED_SLUG = /-\d{4}-\d{2}-\d{2}$/;
const SKIP_PREFIX = "houston-comedy-shows-this-week-";

function authHeader() {
  return "Basic " + Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString("base64");
}

async function wpRequest(method, urlPath, body) {
  const res = await fetch(`${WP_SITE_URL}${urlPath}`, {
    method,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${urlPath} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return { json: await res.json(), totalPages: parseInt(res.headers.get("x-wp-totalpages") || "1", 10) };
}

async function main() {
  console.log(`=== Comedy Houston — noindex backfill (${APPLY ? "APPLY" : "dry run"}) ===`);
  if (!WP_SITE_URL || !WP_APP_USER || !WP_APP_PASSWORD) {
    throw new Error("WP_SITE_URL, WP_APP_USER, and WP_APP_PASSWORD must be set.");
  }

  // Collect every published post (the site has ~120; pagination is cheap).
  const posts = [];
  let page = 1;
  let totalPages = 1;
  do {
    const { json, totalPages: tp } = await wpRequest(
      "GET",
      `/wp-json/wp/v2/posts?per_page=100&page=${page}&status=publish&_fields=id,slug,link,ch_noindex,ch_allow_index`,
      null
    );
    posts.push(...json);
    totalPages = tp;
    page++;
  } while (page <= totalPages);
  console.log(`Fetched ${posts.length} published posts.`);

  let flagged = 0, skipped = 0;
  for (const post of posts) {
    if (!DATED_SLUG.test(post.slug) || post.slug.startsWith(SKIP_PREFIX)) continue;
    if (post.ch_allow_index) {
      console.log(`  [keep-indexed] ${post.slug} (ch_allow_index set)`);
      skipped++;
      continue;
    }
    if (post.ch_noindex) {
      skipped++;
      continue;
    }
    if (APPLY) {
      await wpRequest("POST", `/wp-json/wp/v2/posts/${post.id}`, { ch_noindex: 1 });
      console.log(`  [flagged]  ${post.slug}`);
    } else {
      console.log(`  [would flag] ${post.slug}`);
    }
    flagged++;
  }

  console.log("");
  console.log(`${APPLY ? "Flagged" : "Would flag"} ${flagged} post(s); ${skipped} already handled/kept.`);
  if (!APPLY) {
    console.log("Dry run only — re-run with --apply to write.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
