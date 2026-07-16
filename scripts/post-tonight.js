#!/usr/bin/env node

/**
 * Comedy Houston — Daily "Tonight in Houston" poster.
 *
 * Reads blog/tonight/tonight-meta.json (written by generate-tonight-post.js
 * earlier in the same workflow, then committed/pushed so the PNGs are
 * publicly reachable) and publishes across the same four channels as the
 * comedian spotlights:
 *
 *   1. Instagram Feed  — square image + caption  (anchor: failure = exit 1)
 *   2. Instagram Story — story image              (best-effort)
 *   3. Facebook Feed   — square image + caption   (best-effort)
 *   4. Facebook Story  — story image              (best-effort)
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
  postIgFeedImage,
  postIgStoryImage,
  postFbFeedPhoto,
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
  if (!meta.count || !meta.square) {
    console.log("No shows tonight — nothing to post. Exiting.");
    return;
  }

  const state = loadTonightState();
  if (state.last_posted_date === today) {
    console.log(`Already posted for ${today} — skipping (re-run protection).`);
    return;
  }

  const captionPath = path.join(TONIGHT_DIR, meta.caption);
  const caption = fs.existsSync(captionPath)
    ? fs.readFileSync(captionPath, "utf8").trim()
    : "";
  if (!caption) {
    throw new Error(`Caption file missing or empty: ${captionPath}`);
  }

  const squareUrl = `${IMAGES_BASE_URL}/${meta.square}`;
  const storyUrl = `${IMAGES_BASE_URL}/${meta.story}`;

  console.log(`Tonight: ${meta.weekday} ${meta.date} — ${meta.count} show(s)`);
  console.log(`Square: ${squareUrl}`);
  console.log(`Story:  ${storyUrl}`);
  console.log(`Caption: ${caption.length} chars`);

  // --- Token + Page ---
  await validateTokenAndGuards();
  const fbPageId = await resolveFacebookPageId();

  // --- Wait for the freshly pushed images to be reachable ---
  console.log("\nVerifying images are publicly reachable…");
  await waitForImageUrl(squareUrl, 12, 10_000);
  await waitForImageUrl(storyUrl, 6, 10_000);

  const results = { igFeed: null, igStory: null, fbFeed: null, fbStory: null, errors: [] };

  // --- Instagram Feed (anchor — must succeed) ---
  console.log("\n  IG FEED — Tonight in Houston");
  try {
    results.igFeed = await withTimeout(
      postIgFeedImage(squareUrl, caption),
      "IG Feed",
      CHANNEL_TIMEOUT_MS
    );
  } catch (err) {
    console.error(`\n  ERROR: IG Feed failed — ${err.message}`);
    // State NOT advanced — a manual re-run of the workflow can retry tonight.
    throw err;
  }

  // --- Instagram Story (best-effort) ---
  console.log("\n  IG STORY — Tonight in Houston");
  try {
    results.igStory = await withTimeout(postIgStoryImage(storyUrl), "IG Story", CHANNEL_TIMEOUT_MS);
  } catch (err) {
    console.error(`\n  WARNING: IG Story failed — ${err.message}`);
    results.errors.push(`IG Story: ${err.message}`);
  }

  // --- Facebook Feed (best-effort) ---
  if (fbPageId) {
    console.log("\n  FB FEED — Tonight in Houston");
    try {
      results.fbFeed = await withTimeout(
        postFbFeedPhoto(fbPageId, squareUrl, caption),
        "FB Feed",
        CHANNEL_TIMEOUT_MS
      );
    } catch (err) {
      console.error(`\n  WARNING: FB Feed failed — ${err.message}`);
      results.errors.push(`FB Feed: ${err.message}`);
    }

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
  console.log(`  IG Feed:  ${results.igFeed ? "POSTED (ID: " + results.igFeed + ")" : "FAILED"}`);
  console.log(`  IG Story: ${results.igStory ? "POSTED (ID: " + results.igStory + ")" : "SKIPPED/FAILED"}`);
  console.log(`  FB Feed:  ${results.fbFeed ? "POSTED (ID: " + results.fbFeed + ")" : "SKIPPED/FAILED"}`);
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
