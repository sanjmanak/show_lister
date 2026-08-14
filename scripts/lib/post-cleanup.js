/**
 * Comedy Houston — Shared aged-post cleanup.
 *
 * Both cleanup jobs (nightly "Tonight in Houston" cards, and the comedian
 * spotlights) delete the same four channels from the same Meta account
 * under the same hard-won rules, so the per-entry delete loop lives here
 * once. The callers keep their own state files, retention windows, token
 * checks and exit codes.
 *
 * Per-channel rules (unchanged from the original tonight-only cleanup —
 * see ARCHITECTURE.md "Posting reliability" for the incident history):
 *
 *   - IG feed posts: DELETE /{ig-media-id}, gated behind the
 *     instagram_manage_contents scope. A (#10) permission error is
 *     therefore scope-dependent: if the token LACKS the scope the ID is
 *     kept for retry and the caller exits 1 (the notify email says how to
 *     fix the token); if the scope IS present and Meta still refuses, the
 *     ID is pruned with a loud warning (manual takedown if wanted) so the
 *     workflow can't stay red forever.
 *     Any OTHER IG feed error keeps the ID for retry + exit 1.
 *   - FB feed posts: DELETE /{id}; a real failure keeps the ID in state so
 *     the next run retries, and the caller exits 1.
 *   - IG/FB stories: auto-expire after 24h, so any delete error past the
 *     retention window is pruned with a warning, never a failure.
 *   - Entries stuck > maxRetryAgeDays with a failing feed ID are dropped
 *     loudly rather than keeping the workflow red forever.
 *   - A rate limit stops deletes for the run; everything left retries on
 *     the next scheduled pass.
 */

"use strict";

const {
  withTimeout,
  deleteGraphObject,
  isPermissionError,
} = require("./meta-api");

const FEED_FIELDS = [
  ["igFeedMediaId", "IG Feed"],
  ["fbFeedPostId", "FB Feed"],
];
const STORY_FIELDS = [
  ["igStoryMediaId", "IG Story"],
  ["fbStoryPostId", "FB Story"],
];
const ALL_FIELDS = [...FEED_FIELDS, ...STORY_FIELDS];

function isRateLimited(err) {
  return err && typeof err.message === "string" && err.message.startsWith("RATE_LIMITED");
}

/** Default: trust postedAt. An unparseable entry counts as ancient (still
 *  eligible — the delete call itself decides whether the IDs are real). */
function defaultEntryTimeMs(entry) {
  const t = Date.parse(entry.postedAt);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Delete every channel of every entry past the retention window.
 *
 * @param {object}   opts
 * @param {object[]} opts.entries          full state array (mutated in place:
 *                                         deleted IDs are nulled out)
 * @param {number}   opts.retentionDays    days a post stays up
 * @param {number}   opts.maxRetryAgeDays  give-up horizon for stuck entries
 * @param {boolean}  opts.dryRun           log only, change nothing
 * @param {number}   opts.channelTimeoutMs per-delete timeout
 * @param {string|null} opts.fbPageId      resolved FB Page, or null
 * @param {boolean|null} opts.hasManageContents  null = unknown
 * @param {(e:object)=>string} opts.describeEntry  log label for an entry
 * @param {(e:object)=>number} [opts.entryTimeMs]  when the entry was posted
 * @returns {{failures: string[], counts: object, kept: object[]}}
 */
async function cleanupAgedEntries({
  entries,
  retentionDays,
  maxRetryAgeDays,
  dryRun,
  channelTimeoutMs,
  fbPageId,
  hasManageContents,
  describeEntry,
  entryTimeMs = defaultEntryTimeMs,
}) {
  const cutoff = Date.now() - retentionDays * 86400000;
  const forceDropCutoff = Date.now() - maxRetryAgeDays * 86400000;

  const eligible = entries.filter((e) => entryTimeMs(e) < cutoff);
  console.log(`\nState entries: ${entries.length}, past retention: ${eligible.length}`);

  const failures = [];
  const counts = { deleted: 0, alreadyGone: 0, prunedStories: 0, igUndeletable: 0, wouldDelete: 0 };
  let rateLimited = false;

  if (eligible.length === 0) {
    console.log("Nothing to delete.");
    return { failures, counts, kept: entries, rateLimited };
  }

  for (const entry of eligible) {
    console.log(`\n--- ${describeEntry(entry)} ---`);
    if (rateLimited) {
      console.log("  Skipped — rate limited earlier in this run; retrying next run.");
      continue;
    }

    for (const [field, label] of ALL_FIELDS) {
      const id = entry[field];
      if (!id) continue;
      const isStory = STORY_FIELDS.some(([f]) => f === field);

      if (field === "fbFeedPostId" && !fbPageId) {
        // Token doesn't currently resolve to the FB Page — deleting would
        // just produce auth noise. Keep the ID; the next run retries.
        // (FB story IDs don't get this guard: they expired at 24h, so the
        // story branch below prunes them whatever the error.)
        console.log(`  ${label}: skipped (FB Page unresolved), kept for retry.`);
        continue;
      }

      if (dryRun) {
        console.log(`  ${label}: would delete ${id}`);
        counts.wouldDelete++;
        continue;
      }

      try {
        const outcome = await withTimeout(
          deleteGraphObject(id, label),
          `${label} delete`,
          channelTimeoutMs
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
          if (hasManageContents === true) {
            // Scope is granted and Meta still refuses — retrying is
            // pointless and keeping the workflow red helps no one.
            console.warn(
              `  ${label}: (#10) despite instagram_manage_contents being granted. ` +
              `Pruning; remove manually on instagram.com if wanted (ID: ${id}).`
            );
            entry[field] = null;
            counts.igUndeletable++;
          } else {
            // Missing (or unknown) scope — this is fixable by regenerating
            // the token, so keep the ID and alert via the failure email.
            failures.push(
              `${describeEntry(entry)} ${label} (${id}): (#10) — token lacks instagram_manage_contents; ` +
              `regenerate the Page token with that scope and update INSTAGRAM_ACCESS_TOKEN`
            );
          }
        } else {
          console.error(`  ${label}: FAILED — ${err.message.split("\n")[0]}`);
          failures.push(`${describeEntry(entry)} ${label} (${id}): ${err.message.split("\n")[0]}`);
        }
      }
    }
  }

  let kept = entries;
  if (!dryRun) {
    kept = entries.filter((entry) => {
      const remaining = ALL_FIELDS.some(([f]) => entry[f]);
      if (!remaining && entryTimeMs(entry) < cutoff) return false;
      if (remaining && entryTimeMs(entry) < forceDropCutoff && !rateLimited) {
        console.error(
          `\nWARNING: dropping ${describeEntry(entry)} after ${maxRetryAgeDays}+ days of failed ` +
          `deletes — its remaining posts must be removed MANUALLY: ` +
          JSON.stringify(entry)
        );
        return false;
      }
      return true;
    });
  }

  return { failures, counts, kept, rateLimited };
}

/** Shared results block so both jobs report identically. */
function printResults(title, { failures, counts, rateLimited }, { dryRun, eligibleCount }) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS — ${title}`);
  if (dryRun) {
    console.log(`  Would delete: ${counts.wouldDelete} object(s) across ${eligibleCount} entr${eligibleCount === 1 ? "y" : "ies"}`);
  } else {
    console.log(`  Deleted:        ${counts.deleted}`);
    console.log(`  Already gone:   ${counts.alreadyGone}`);
    console.log(`  Stories pruned: ${counts.prunedStories}`);
    if (counts.igUndeletable > 0) {
      console.log(`  IG undeletable: ${counts.igUndeletable}  (Meta refused despite instagram_manage_contents — remove manually if wanted)`);
    }
    console.log(`  Failed:         ${failures.length}`);
    failures.forEach((f) => console.log(`    - ${f}`));
    if (rateLimited) console.log(`  Rate limited — remaining entries retry on the next run.`);
  }
  console.log(`${"=".repeat(60)}`);
}

module.exports = {
  FEED_FIELDS,
  STORY_FIELDS,
  ALL_FIELDS,
  isRateLimited,
  cleanupAgedEntries,
  printResults,
};
