#!/usr/bin/env node

/**
 * Comedy Houston — Daily "Tonight in Houston" poster.
 *
 * Reads blog/tonight/tonight-meta.json (written by generate-tonight-post.js
 * earlier in the same workflow, then committed/pushed so the PNG is
 * publicly reachable) and publishes it as a STORY only:
 *
 *   1. Instagram Story — story image  (anchor: failure = exit 1)
 *   2. Facebook Story  — story image  (best-effort)
 *
 * Stories only since 2026-09-30. The daily feed post reached 11 to 48
 * accounts (insights, Aug-Sep 2026), four feed posts a day were burying the
 * spotlight and announcement posts, and a story disappears on its own after
 * 24h so nothing has to be reaped. The Graph API cannot attach a link
 * sticker, so the story image carries the URL as text plus "link in bio".
 *
 * Images are served from raw.githubusercontent.com — available seconds
 * after the push, no GitHub Pages build to wait on, and the date-stamped
 * filename means there is never a stale-CDN-cache problem.
 *
 * Dedupe: tonight-post-state.json records the last posted date. If the
 * workflow re-runs (manual dispatch, retry), the same night is never
 * posted twice. State only advances after the anchor channel succeeds —
 * same rule as post-to-instagram.js.
 *
 * Each night's post IDs are appended to the state's `posted` array so
 * delete-tonight-posts.js can remove the posts once they age past the
 * retention window (see lib/tonight-state.js for the shape).
 */

const fs = require("fs");
const path = require("path");

const {
  withTimeout,
  waitForImageUrl,
  resolveFacebookPageId,
  validateTokenAndGuards,
  postIgStoryImage,
  postFbStoryPhoto,
  shutdown,
} = require("./lib/meta-api");
const { loadTonightState, saveTonightState } = require("./lib/tonight-state");

const ROOT = path.resolve(__dirname, "..");
const TONIGHT_DIR = path.join(ROOT, "blog", "tonight");
const META_PATH = path.join(TONIGHT_DIR, "tonight-meta.json");

// raw.githubusercontent.com serves files straight from the branch — no
// Pages deploy delay. Meta fetches images server-side, and raw URLs serve
// proper image/png content-type.
const IMAGES_BASE_URL =
  "https://raw.githubusercontent.com/sanjmanak/show_lister/main/blog/tonight";

const CHANNEL_TIMEOUT_MS = parseInt(process.env.IG_CHANNEL_TIMEOUT_MS || "180000", 10);

function todayInHouston() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function main() {
  console.log("=== Comedy Houston — Tonight in Houston Poster ===");
  console.log(`    Time: ${new Date().toISOString()}\n`);

  const today = todayInHouston();

  // --- Preconditions ---
  if (!fs.existsSync(META_PATH)) {
    console.log("No tonight-meta.json found — nothing to post. Exiting.");
    return;
  }
  const meta = JSON.parse(fs.readFileSync(META_PATH, "utf8"));

  if (meta.date !== today) {
    console.log(`Meta is stale (${meta.date} vs today ${today}) — skipping.`);
    return;
  }
  if (!meta.count || !meta.story) {
    console.log("No shows tonight — nothing to post. Exiting.");
    return;
  }

  const state = loadTonightState();
  if (state.last_posted_date === today) {
    console.log(`Already posted for ${today} — skipping (re-run protection).`);
    return;
  }

  const storyUrl = `${IMAGES_BASE_URL}/${meta.story}`;

  console.log(`Tonight: ${meta.weekday} ${meta.date} — ${meta.count} show(s)`);
  console.log(`Story:  ${storyUrl}`);

  // --- Token + Page ---
  await validateTokenAndGuards();
  const fbPageId = await resolveFacebookPageId();

  // --- Wait for the freshly pushed images to be reachable ---
  console.log("\nVerifying the story image is publicly reachable…");
  await waitForImageUrl(storyUrl, 12, 10_000);

  // Shape kept identical to the feed-era entries so delete-tonight-posts.js
  // and lib/post-cleanup.js keep working unchanged (null ids are skipped).
  const results = { igFeed: null, igStory: null, fbFeed: null, fbStory: null, errors: [] };

  // --- Instagram Story (anchor — must succeed) ---
  console.log("\n  IG STORY — Tonight in Houston");
  try {
    results.igStory = await withTimeout(postIgStoryImage(storyUrl), "IG Story", CHANNEL_TIMEOUT_MS);
  } catch (err) {
    console.error(`\n  ERROR: IG Story failed — ${err.message}`);
    // State NOT advanced — a manual re-run of the workflow can retry tonight.
    throw err;
  }

  // --- Facebook Story (best-effort) ---
  if (fbPageId) {
    console.log("\n  FB STORY — Tonight in Houston");
    try {
      results.fbStory = await withTimeout(
        postFbStoryPhoto(fbPageId, storyUrl),
        "FB Story",
        CHANNEL_TIMEOUT_MS
      );
    } catch (err) {
      console.error(`\n  WARNING: FB Story failed — ${err.message}`);
      results.errors.push(`FB Story: ${err.message}`);
    }
  } else {
    console.log("\n  FB — Skipped (no Facebook Page ID resolved)");
  }

  // --- Advance state (anchor succeeded) ---
  state.last_posted_date = today;
  state.posted.push({
    date: today,
    igFeedMediaId: results.igFeed,
    igStoryMediaId: results.igStory,
    fbFeedPostId: results.fbFeed,
    fbStoryPostId: results.fbStory,
    postedAt: new Date().toISOString(),
  });
  // Safety cap — delete-tonight-posts.js owns the array's lifecycle, but if
  // that workflow is ever disabled the state file must not grow forever.
  if (state.posted.length > 60) {
    state.posted = state.posted.slice(-60);
  }
  console.log("");
  saveTonightState(state);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS — Tonight in Houston (${today})`);
  console.log(`  IG Story: ${results.igStory ? "POSTED (ID: " + results.igStory + ")" : "FAILED"}`);
  console.log(`  FB Story: ${results.fbStory ? "POSTED (ID: " + results.fbStory + ")" : "SKIPPED/FAILED"}`);
  if (results.errors.length > 0) {
    results.errors.forEach((e) => console.log(`    - ${e}`));
  }
  console.log(`${"=".repeat(60)}`);
}

main()
  .then(() => shutdown(0))
  .catch((err) => {
    // Rate-limit: exit 0 so the workflow doesn't flag red. State was not
    // advanced; tonight's post is simply lost (there's no later cron today),
    // which is the right trade — burning the daily IG quota on retries
    // would also cost the comedian-spotlight posts.
    if (err && typeof err.message === "string" && err.message.startsWith("RATE_LIMITED")) {
      console.error(`\nRATE LIMITED — ${err.message}. Exiting 0; state not advanced.`);
      return shutdown(0);
    }
    console.error(`\nFATAL ERROR: ${err.message}`);
    if (err.stack) console.error(`\nStack trace:\n${err.stack}`);
    shutdown(1);
  });
