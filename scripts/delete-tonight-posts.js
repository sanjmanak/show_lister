#!/usr/bin/env node

/**
 * Comedy Houston — Deletes aged "Tonight in Houston" social posts.
 *
 * The daily lineup post is only useful on the night it covers, so this
 * script removes each night's posts once they age past the retention
 * window (default 3 days). Runs from delete-old-tonight-posts.yml daily
 * at 17:00 UTC — 3h before post-tonight's 20:00 slot, in the same
 * concurrency group, so the two never race the state commit.
 *
 * ID source: the `posted` array in blog/tonight/tonight-post-state.json,
 * appended by post-tonight.js. Forward-only by design — posts made before
 * the array existed are never touched (user decision; see ARCHITECTURE.md).
 *
 * Per-channel rules:
 *   - IG feed posts: Meta refuses to delete IG media for this app —
 *     DELETE /{ig-media-id} returns (#10) even with every grantable scope
 *     (verified 2026-07-21; see isPermissionError in meta-api.js). A (#10)
 *     on an IG feed delete is pruned with a loud warning (manual takedown
 *     if wanted); any OTHER IG feed error keeps the ID for retry + exit 1.
 *   - FB feed posts: DELETE /{id}; a real failure keeps the ID in state
 *     so tomorrow's run retries, and exits 1 (fires the notify email).
 *   - IG/FB stories: auto-expire after 24h, so any delete error past the
 *     retention window is pruned with a warning, never a failure.
 *   - Entries stuck > MAX_RETRY_AGE_DAYS with a failing feed ID are dropped
 *     loudly rather than keeping the workflow red forever.
 *
 * Env:
 *   TONIGHT_RETENTION_DAYS  days a post stays up (default 3, min 1)
 *   DRY_RUN                 truthy → log what would be deleted, change nothing
 *   IG_CHANNEL_TIMEOUT_MS   per-delete timeout (same var the posters use)
 */

const {
  IG_ACCESS_TOKEN,
  IG_USER_ID,
  graphRequest,
  withTimeout,
  resolveFacebookPageId,
  deleteGraphObject,
  isPermissionError,
  shutdown,
} = require("./lib/meta-api");
const { loadTonightState, saveTonightState } = require("./lib/tonight-state");

const RETENTION_DAYS = parseInt(process.env.TONIGHT_RETENTION_DAYS || "3", 10);
const MAX_RETRY_AGE_DAYS = 14;
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");
const CHANNEL_TIMEOUT_MS = parseInt(process.env.IG_CHANNEL_TIMEOUT_MS || "180000", 10);

const FEED_FIELDS = [
  ["igFeedMediaId", "IG Feed"],
  ["fbFeedPostId", "FB Feed"],
];
const STORY_FIELDS = [
  ["igStoryMediaId", "IG Story"],
  ["fbStoryPostId", "FB Story"],
];

function isRateLimited(err) {
  return err && typeof err.message === "string" && err.message.startsWith("RATE_LIMITED");
}

/**
 * When a post went out. Falls back to end-of-day Houston time for entries
 * missing postedAt; an unparseable entry counts as ancient (still eligible —
 * the delete call itself decides whether the IDs are real).
 */
function entryTimeMs(entry) {
  const t = Date.parse(entry.postedAt || `${entry.date}T23:59:59-05:00`);
  return Number.isNaN(t) ? 0 : t;
}

async function main() {
  console.log("=== Comedy Houston — Tonight in Houston Cleanup ===");
  console.log(`    Time: ${new Date().toISOString()}`);
  console.log(`    Retention: ${RETENTION_DAYS} day(s)${DRY_RUN ? "  [DRY RUN]" : ""}\n`);

  if (Number.isNaN(RETENTION_DAYS) || RETENTION_DAYS < 1) {
    throw new Error(`Invalid TONIGHT_RETENTION_DAYS: ${process.env.TONIGHT_RETENTION_DAYS}`);
  }
  if (!IG_ACCESS_TOKEN || !IG_USER_ID) {
    throw new Error(
      "INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_USER_ID secrets are not set. " +
      "Add them in GitHub repo → Settings → Secrets → Actions."
    );
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

  const state = loadTonightState();
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  const forceDropCutoff = Date.now() - MAX_RETRY_AGE_DAYS * 86400000;

  const eligible = state.posted.filter((e) => entryTimeMs(e) < cutoff);
  console.log(`\nState entries: ${state.posted.length}, past retention: ${eligible.length}`);
  if (eligible.length === 0) {
    console.log("Nothing to delete.");
    return [];
  }

  const failures = [];
  const counts = { deleted: 0, alreadyGone: 0, prunedStories: 0, igUndeletable: 0, wouldDelete: 0 };
  let rateLimited = false;

  for (const entry of eligible) {
    console.log(`\n--- ${entry.date} (posted ${entry.postedAt || "unknown"}) ---`);
    if (rateLimited) {
      console.log("  Skipped — rate limited earlier in this run; retrying tomorrow.");
      continue;
    }

    for (const [field, label] of [...FEED_FIELDS, ...STORY_FIELDS]) {
      const id = entry[field];
      if (!id) continue;
      const isStory = STORY_FIELDS.some(([f]) => f === field);

      if (field === "fbFeedPostId" && !fbPageId) {
        // Token doesn't currently resolve to the FB Page — deleting would
        // just produce auth noise. Keep the ID; tomorrow's run retries.
        // (FB story IDs don't get this guard: they expired at 24h, so the
        // story branch below prunes them whatever the error.)
        console.log(`  ${label}: skipped (FB Page unresolved), kept for retry.`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  ${label}: would delete ${id}`);
        counts.wouldDelete++;
        continue;
      }

      try {
        const outcome = await withTimeout(
          deleteGraphObject(id, label),
          `${label} delete`,
          CHANNEL_TIMEOUT_MS
        );
        entry[field] = null;
        if (outcome === "deleted") counts.deleted++;
        else counts.alreadyGone++;
      } catch (err) {
        if (isRateLimited(err)) {
          console.error(`  ${label}: rate limited — stopping deletes for this run.`);
          rateLimited = true;
          break;
        }
        if (isStory) {
          // Stories expired ~24h after posting regardless; whatever Meta is
          // objecting to, there is nothing left to take down.
          console.warn(`  ${label}: delete error (${err.message.split("\n")[0]}) — pruning; story already expired.`);
          entry[field] = null;
          counts.prunedStories++;
        } else if (field === "igFeedMediaId" && isPermissionError(err)) {
          // Meta won't delete IG media for this app no matter the scopes —
          // retrying is pointless and keeping the workflow red helps no one.
          console.warn(
            `  ${label}: (#10) — Meta refuses IG media deletes for this app. ` +
            `Pruning; remove manually on instagram.com if wanted (ID: ${id}).`
          );
          entry[field] = null;
          counts.igUndeletable++;
        } else {
          console.error(`  ${label}: FAILED — ${err.message.split("\n")[0]}`);
          failures.push(`${entry.date} ${label} (${id}): ${err.message.split("\n")[0]}`);
        }
      }
    }
  }

  if (!DRY_RUN) {
    state.posted = state.posted.filter((entry) => {
      const remaining = [...FEED_FIELDS, ...STORY_FIELDS].some(([f]) => entry[f]);
      if (!remaining && entryTimeMs(entry) < cutoff) return false;
      if (remaining && entryTimeMs(entry) < forceDropCutoff && !rateLimited) {
        console.error(
          `\nWARNING: dropping ${entry.date} after ${MAX_RETRY_AGE_DAYS}+ days of failed ` +
          `deletes — its remaining posts must be removed MANUALLY: ` +
          JSON.stringify(entry)
        );
        return false;
      }
      return true;
    });
    console.log("");
    saveTonightState(state);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS — Tonight in Houston cleanup`);
  if (DRY_RUN) {
    console.log(`  Would delete: ${counts.wouldDelete} object(s) across ${eligible.length} night(s)`);
  } else {
    console.log(`  Deleted:        ${counts.deleted}`);
    console.log(`  Already gone:   ${counts.alreadyGone}`);
    console.log(`  Stories pruned: ${counts.prunedStories}`);
    if (counts.igUndeletable > 0) {
      console.log(`  IG undeletable: ${counts.igUndeletable}  (Meta forbids IG media deletes — remove manually if wanted)`);
    }
    console.log(`  Failed:         ${failures.length}`);
    failures.forEach((f) => console.log(`    - ${f}`));
    if (rateLimited) console.log(`  Rate limited — remaining entries retry tomorrow.`);
  }
  console.log(`${"=".repeat(60)}`);

  return failures;
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
