#!/usr/bin/env node

/**
 * Comedy Houston — content reaper for the comedian pipeline.
 *
 * Counterpart to delete-comedian-posts.js (which removes the IG/FB social
 * posts). Three jobs, all idempotent, all daily from
 * delete-old-comedian-posts.yml:
 *
 *   1. LEGACY SPOTLIGHT POSTS. Until October 2026 each spotlight was a
 *      dated WordPress POST (name-venue-date slug) deleted the week after
 *      its show. Those posts are replaced by the evergreen comedian PAGES
 *      (/comedians/{slug}/). Any legacy post whose comedian page is live is
 *      deleted as soon as this runs (the plugin 301s its URL to the page
 *      from comedians-index.json); any legacy post without a page yet is
 *      deleted the week after its show, as before. Slugs come from the
 *      registry's legacy_slugs and from the manifests.
 *
 *   2. FINISHED WEEKS. A week-keyed manifest whose last show date is more
 *      than REAP_AFTER_DAYS behind is archived to archive/ and its local
 *      per-show files (caption, graphics) removed. The comedian page is NOT
 *      touched: it is evergreen.
 *
 *   3. STALE COMEDIAN PAGES. A comedian with no upcoming Houston date and
 *      no date in the last COMEDIAN_STALE_DAYS (default 365) has their page
 *      moved to the WordPress trash and their registry record archived.
 *      Profile and history are kept in the registry, so if they come back
 *      the Monday run republishes the page at the same URL with no OpenAI
 *      spend. Nothing stale stays indexable; nothing is lost.
 *
 * Both plugin indexes (spotlight-index.json, comedians-index.json) are
 * rewritten whenever anything changed.
 *
 * Env:
 *   WP_SITE_URL / WP_APP_USER / WP_APP_PASSWORD   WordPress REST creds
 *   DRY_RUN                                        truthy → log only
 *   REAP_AFTER_DAYS                                grace days after the last
 *                                                  show date (default 1)
 *   COMEDIAN_STALE_DAYS                            default 365
 */

const fs = require("fs");
const path = require("path");
const { createWpClient } = require("./lib/wp");
const { writeSpotlightIndex } = require("./lib/spotlight-index");
const registry = require("./lib/comedian-registry");
const comedianPage = require("./lib/comedian-page");

const OUTPUT_DIR = path.resolve(__dirname, "..");
const COMEDIANS_DIR = path.join(OUTPUT_DIR, "blog", "comedians");
const IMAGES_DIR = path.join(COMEDIANS_DIR, "images");
const ARCHIVE_DIR = path.join(COMEDIANS_DIR, "archive");

const WP_SITE_URL = (process.env.WP_SITE_URL || "").replace(/\/$/, "");
const WP_APP_USER = process.env.WP_APP_USER || "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";
const DRY_RUN = !!process.env.DRY_RUN && process.env.DRY_RUN !== "false";
const REAP_AFTER_DAYS = Math.max(0, parseInt(process.env.REAP_AFTER_DAYS || "1", 10) || 1);
const COMEDIAN_STALE_DAYS = Math.max(30, parseInt(process.env.COMEDIAN_STALE_DAYS || "365", 10) || 365);

if (!WP_SITE_URL || !WP_APP_USER || !WP_APP_PASSWORD) {
  console.log("WP credentials not set — nothing to do.");
  process.exit(0);
}

const wpClient = createWpClient({ siteUrl: WP_SITE_URL, userAgent: "ComedyHouston-Reaper/1.0" });
function wpRequest(method, urlPath, body) {
  return wpClient.request(method, urlPath, body);
}

/** Delete a legacy spotlight POST by slug. Returns true when a post was removed. */
async function deletePostBySlug(slug) {
  const found = await wpRequest("GET", `/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&status=publish,draft,future,private`);
  if (!Array.isArray(found) || found.length === 0) {
    return false;
  }
  if (DRY_RUN) {
    console.log(`    DRY RUN: would delete WP post ${found[0].id} (${slug})`);
    await deleteLegacyMedia(slug, found[0].id);
    return false;
  }
  await deleteLegacyMedia(slug, found[0].id);
  await wpRequest("DELETE", `/wp-json/wp/v2/posts/${found[0].id}?force=true`);
  console.log(`    deleted WP post ${found[0].id} (${slug})`);
  return true;
}

/**
 * Delete the media left behind by a legacy spotlight post: its hero image
 * was uploaded under the post's slug, and once the post is force-deleted
 * WordPress serves that orphaned attachment page at the old URL (so it is
 * no longer a 404 and Rank Math 301s it to the homepage). Matches the exact
 * slug or WP's -N duplicate suffix, only unattached media or media attached
 * to `parentId`. Comedian page heroes use "{slug}-houston", never matched.
 */
async function deleteLegacyMedia(slug, parentId) {
  const pattern = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-\\d+)?$`);
  const found = await wpRequest(
    "GET",
    `/wp-json/wp/v2/media?search=${encodeURIComponent(slug)}&per_page=20&_fields=id,slug,post`
  );
  if (!Array.isArray(found)) return 0;
  let deleted = 0;
  for (const m of found) {
    if (!pattern.test(m.slug || "")) continue;
    if (m.post && parentId && m.post !== parentId) continue;
    if (DRY_RUN) {
      console.log(`    DRY RUN: would delete media ${m.id} (${m.slug})`);
      continue;
    }
    await wpRequest("DELETE", `/wp-json/wp/v2/media/${m.id}?force=true`);
    console.log(`    deleted media ${m.id} (${m.slug})`);
    deleted++;
  }
  return deleted;
}

function localDateStr(d) {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function removeLocalFiles(slug) {
  const victims = [
    path.join(COMEDIANS_DIR, `${slug}.html`),
    path.join(COMEDIANS_DIR, `${slug}-caption.txt`),
    path.join(IMAGES_DIR, `${slug}.live-refreshed`),
  ];
  for (const f of fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR) : []) {
    if (f.startsWith(slug)) victims.push(path.join(IMAGES_DIR, f));
  }
  for (const v of victims) {
    if (fs.existsSync(v)) fs.unlinkSync(v);
  }
}

(async () => {
  if (!fs.existsSync(COMEDIANS_DIR)) return;
  const today = localDateStr(new Date());
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - REAP_AFTER_DAYS);
  const cutoffStr = localDateStr(cutoff);
  let changed = false;

  const reg = registry.loadRegistry(COMEDIANS_DIR);

  // ── 1. Legacy spotlight posts already replaced by a page ──────────────
  console.log("Legacy spotlight posts replaced by comedian pages:");
  let legacyDeleted = 0;
  let legacyMediaDeleted = 0;
  for (const c of reg.comedians) {
    if (c.status !== "live" || !c.wpLink) continue;
    for (const slug of c.legacy_slugs || []) {
      try {
        if (await deletePostBySlug(slug)) legacyDeleted++;
        else legacyMediaDeleted += await deleteLegacyMedia(slug, 0); // post already gone: orphans only
      } catch (err) {
        console.log(`    FAILED ${slug}: ${err.message} — retried tomorrow`);
      }
    }
  }
  console.log(`  ${legacyDeleted} deleted, ${legacyMediaDeleted} orphaned media removed${DRY_RUN ? " (dry run)" : ""}.`);

  // ── 2. Finished weeks ─────────────────────────────────────────────────
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
      // Legacy entries (wpType unset) were WordPress posts under this slug;
      // page-era entries never had one and the lookup is a cheap no-op.
      try {
        if (post.wpType !== "page" && !(await deletePostBySlug(post.slug))) {
          console.log(`    (no WP post for slug ${post.slug} — already gone)`);
        }
      } catch (err) {
        console.log(`    FAILED ${post.slug}: ${err.message} — manifest kept for retry`);
        manifest._reap_failed = true;
      }
      if (!DRY_RUN) removeLocalFiles(post.slug);
    }
    if (!manifest._reap_failed && !DRY_RUN) {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      fs.renameSync(full, path.join(ARCHIVE_DIR, name.replace(".json", `.reaped-${today}.json`)));
      console.log(`  archived ${name}`);
      reaped++;
      changed = true;
    }
  }

  // ── 3. Stale comedian pages ───────────────────────────────────────────
  console.log(`Stale comedian pages (no Houston date in ${COMEDIAN_STALE_DAYS}d, none upcoming):`);
  const staleCutoff = new Date();
  staleCutoff.setDate(staleCutoff.getDate() - COMEDIAN_STALE_DAYS);
  const staleStr = localDateStr(staleCutoff);
  let archived = 0;
  for (const c of reg.comedians) {
    if (c.status !== "live") continue;
    const last = registry.lastShowDate(c);
    if (!last || last >= staleStr) continue; // recent, or upcoming (dates in the future are >= today > staleStr)
    if (registry.upcomingShows(c, today).length > 0) continue;
    console.log(`  ${c.name} (/comedians/${c.slug}/) — last show ${last}`);
    try {
      const trashed = await comedianPage.trashComedianPage(c, { wpRequest, dryRun: DRY_RUN });
      if (!DRY_RUN) {
        c.status = "archived";
        c.archived_at = new Date().toISOString();
        archived++;
        changed = true;
        console.log(`    ${trashed ? "page trashed" : "no page to trash"}; registry record archived (profile kept).`);
      }
    } catch (err) {
      console.log(`    FAILED: ${err.message} — retried tomorrow`);
    }
  }
  console.log(`  ${archived} archived${DRY_RUN ? " (dry run)" : ""}.`);

  if (changed && !DRY_RUN) {
    registry.saveRegistry(COMEDIANS_DIR, reg);
    const n = writeSpotlightIndex(COMEDIANS_DIR);
    const m = registry.writeComediansIndex(COMEDIANS_DIR, reg);
    console.log(`Rewrote spotlight-index.json (${n} posts) and comedians-index.json (${m} comedians)`);
  }
  console.log(`Done. ${reaped} week(s) reaped, ${legacyDeleted} legacy post(s) deleted, ${archived} comedian(s) archived${DRY_RUN ? " (dry run)" : ""}.`);
})().catch((err) => {
  console.error(`delete-comedian-blog-posts failed: ${err.message}`);
  process.exit(1);
});
