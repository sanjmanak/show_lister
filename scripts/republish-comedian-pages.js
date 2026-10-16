#!/usr/bin/env node
/**
 * Republish every live comedian page from the registry, without touching
 * the profile text or the poster. Use after a change to the page template
 * (lib/comedian-page.js buildPageContent / seoFields / buildSchemaGraph) so
 * existing pages pick it up; the generator only rewrites a page when the
 * comedian is in a processed week.
 *
 * Env: WP_SITE_URL / WP_APP_USER / WP_APP_PASSWORD, DRY_RUN (truthy = log only),
 *      ONLY (comma-separated slugs to limit the run).
 */
const path = require("path");
const { createWpClient } = require("./lib/wp");
const registry = require("./lib/comedian-registry");
const comedianPage = require("./lib/comedian-page");

const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, "..");
const COMEDIANS_DIR = path.join(OUTPUT_DIR, "blog", "comedians");
const WP_SITE_URL = (process.env.WP_SITE_URL || "").replace(/\/$/, "");
const DRY_RUN = !!process.env.DRY_RUN && process.env.DRY_RUN !== "false";
const ONLY = new Set((process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean));

if (!WP_SITE_URL || !process.env.WP_APP_USER || !process.env.WP_APP_PASSWORD) {
  console.log("WP credentials not set — nothing to do.");
  process.exit(0);
}
const wpClient = createWpClient({ siteUrl: WP_SITE_URL, userAgent: "ComedyHouston-Republish/1.0" });
const wpRequest = (method, urlPath, body) => wpClient.request(method, urlPath, body);

(async () => {
  const reg = registry.loadRegistry(COMEDIANS_DIR);
  let done = 0, failed = 0;
  for (const entry of reg.comedians) {
    if (entry.status !== "live" || !entry.wpPageId) continue;
    if (ONLY.size && !ONLY.has(entry.slug)) continue;
    console.log(`━━━ ${entry.name} (/comedians/${entry.slug}/)`);
    try {
      await comedianPage.publishComedianPage(entry, { wpRequest, dryRun: DRY_RUN });
      done++;
    } catch (err) {
      failed++;
      console.log(`    FAILED: ${err.message}`);
    }
  }
  if (!DRY_RUN) registry.saveRegistry(COMEDIANS_DIR, reg);
  console.log(`Done. ${done} page(s) republished, ${failed} failed${DRY_RUN ? " (dry run)" : ""}.`);
  if (failed) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
