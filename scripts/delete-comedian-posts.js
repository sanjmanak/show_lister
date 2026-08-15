#!/usr/bin/env node

/**
 * Comedy Houston — Deletes aged comedian-spotlight social posts.
 *
 * A spotlight sells one show on one date. Once that show has passed, the
 * post is dead weight on the grid — and the grid is the profile's
 * conversion surface, the thing a first-time visitor scrolls before
 * deciding whether to tap the bio link. So spotlights come down after
 * COMEDIAN_RETENTION_DAYS (default 5). The blog post they link to STAYS —
 * that's the SEO asset, and it has its own lifecycle in
 * noindex-comedian-posts.js.
 *
 * ID source: the `cleanup_queue` array in blog/comedians/ig-post-state.json,
 * appended by post-to-instagram.js. Deliberately NOT the `posted` array —
 * that one is the this-week dedupe ledger and post-to-instagram.js wipes it
 * whenever the manifest's week_range rolls over, which would strand every
 * media ID from the previous week. cleanup_queue is never reset; entries
 * leave it only when their posts are gone (or provably undeletable).
 *
 * Forward-only, like the tonight cleanup: spotlights posted before this
 * feature shipped have no queue entry and are never touched.
 *
 * The per-channel delete rules live in lib/post-cleanup.js, shared with the
 * "Tonight in Houston" cleanup.
 *
 * Env:
 *   COMEDIAN_RETENTION_DAYS  days a spotlight stays up (default 5, min 1)
 *   DRY_RUN                  truthy → log what would be deleted, change nothing
 *   IG_CHANNEL_TIMEOUT_MS    per-delete timeout (same var the posters use)
 */

const fs = require("fs");
const path = require("path");

const {
  IG_ACCESS_TOKEN,
  IG_USER_ID,
  graphRequest,
  resolveFacebookPageId,
  tokenHasManageContents,
  shutdown,
} = require("./lib/meta-api");
const { isRateLimited, cleanupAgedEntries, printResults } = require("./lib/post-cleanup");

const STATE_PATH = path.resolve(
  __dirname, "..", "blog", "comedians", "ig-post-state.json"
);

const RETENTION_DAYS = parseInt(process.env.COMEDIAN_RETENTION_DAYS || "5", 10);
const MAX_RETRY_AGE_DAYS = 21;
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");
const CHANNEL_TIMEOUT_MS = parseInt(process.env.IG_CHANNEL_TIMEOUT_MS || "180000", 10);

function entryTimeMs(entry) {
  const t = Date.parse(entry.postedAt);
  return Number.isNaN(t) ? 0 : t;
}

async function main() {
  console.log("=== Comedy Houston — Comedian Spotlight Cleanup ===");
  console.log(`    Time: ${new Date().toISOString()}`);
  console.log(`    Retention: ${RETENTION_DAYS} day(s)${DRY_RUN ? "  [DRY RUN]" : ""}\n`);

  if (Number.isNaN(RETENTION_DAYS) || RETENTION_DAYS < 1) {
    throw new Error(`Invalid COMEDIAN_RETENTION_DAYS: ${process.env.COMEDIAN_RETENTION_DAYS}`);
  }
  if (!IG_ACCESS_TOKEN || !IG_USER_ID) {
    throw new Error(
      "INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_USER_ID secrets are not set. " +
      "Add them in GitHub repo → Settings → Secrets → Actions."
    );
  }
  if (!fs.existsSync(STATE_PATH)) {
    console.log(`No state file at ${STATE_PATH} — nothing has been posted yet.`);
    return [];
  }

  // Lightweight token check only — NOT validateTokenAndGuards(): its expiry
  // early-warning clocks process.exit(1), and the posting workflows already
  // fire those alert emails. This job shouldn't double-report them.
  console.log("Validating access token…");
  const tokenCheck = await graphRequest("GET", `/${IG_USER_ID}`, {
    fields: "id,username",
    access_token: IG_ACCESS_TOKEN,
  });
  console.log(`  Token valid! IG account: @${tokenCheck.username || tokenCheck.id}`);

  const fbPageId = await resolveFacebookPageId();

  console.log("\nChecking token for instagram_manage_contents…");
  const hasManageContents = await tokenHasManageContents();
  if (hasManageContents === true) {
    console.log("  Scope present — IG media deletes should be permitted.");
  } else if (hasManageContents === false) {
    console.warn(
      "  ⚠ Token LACKS instagram_manage_contents — IG feed deletes will fail (#10).\n" +
      "    FIX: Graph API Explorer → grant instagram_manage_contents → generate a\n" +
      "    long-lived Page token → update the INSTAGRAM_ACCESS_TOKEN GitHub secret."
    );
  }

  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  if (!Array.isArray(state.cleanup_queue)) state.cleanup_queue = [];

  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  const eligibleCount = state.cleanup_queue.filter((e) => entryTimeMs(e) < cutoff).length;

  const result = await cleanupAgedEntries({
    entries: state.cleanup_queue,
    retentionDays: RETENTION_DAYS,
    maxRetryAgeDays: MAX_RETRY_AGE_DAYS,
    dryRun: DRY_RUN,
    channelTimeoutMs: CHANNEL_TIMEOUT_MS,
    fbPageId,
    hasManageContents,
    entryTimeMs,
    describeEntry: (e) =>
      `${e.comedianName || e.slug} (posted ${e.postedAt || "unknown"})`,
  });

  if (!DRY_RUN) {
    state.cleanup_queue = result.kept;
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
    console.log(`\nState saved → ${STATE_PATH}`);
  }

  printResults("Comedian spotlight cleanup", result, { dryRun: DRY_RUN, eligibleCount });

  return result.failures;
}

main()
  .then((failures) => {
    if (failures.length > 0) {
      console.error(`\n${failures.length} delete(s) failed — IDs kept in state for retry.`);
      return shutdown(1);
    }
    shutdown(0);
  })
  .catch((err) => {
    // Rate-limit before any deletes happened: exit 0, state untouched,
    // tomorrow's cron retries — same convention as the posting scripts.
    if (isRateLimited(err)) {
      console.error(`\nRATE LIMITED — ${err.message}. Exiting 0; retrying tomorrow.`);
      return shutdown(0);
    }
    console.error(`\nFATAL ERROR: ${err.message}`);
    if (err.stack) console.error(`\nStack trace:\n${err.stack}`);
    shutdown(1);
  });
