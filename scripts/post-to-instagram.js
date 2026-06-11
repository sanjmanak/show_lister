#!/usr/bin/env node

/**
 * Comedy Houston — Social Media Auto-Poster
 *
 * Reads blog/comedians/manifest.json, determines the next comedian to post
 * (via ig-post-state.json), and publishes across four channels:
 *
 *   1. Instagram Feed  — square image + caption + comedian tag
 *   2. Instagram Story — story-sized image (no caption — API limitation)
 *   3. Facebook Page   — square image + caption
 *   4. Facebook Story  — story-sized image
 *
 * Uses the Meta Graph API (Content Publishing API). The same Page Access
 * Token works for both Instagram and Facebook since the IG Business account
 * is linked to the Facebook Page.
 *
 * Zero npm dependencies — uses only built-in Node modules.
 */

const fs = require("fs");
const path = require("path");

// Shared Meta Graph API plumbing (graphRequest retry/rate-limit handling,
// container status workarounds, publish retries, token guards, shutdown).
// Extracted to scripts/lib/meta-api.js so the daily "Tonight in Houston"
// poster reuses the exact same battle-tested code. See ARCHITECTURE.md
// "Posting reliability" before changing the lib.
const {
  IG_ACCESS_TOKEN,
  IG_USER_ID,
  GRAPH_API_VERSION,
  graphRequest,
  verifyImageUrl,
  waitForContainer,
  publishWithRetry,
  isUserTagError,
  withTimeout,
  resolveFacebookPageId,
  validateTokenAndGuards,
  shutdown,
} = require("./lib/meta-api");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OUTPUT_DIR = path.resolve(__dirname, "..");
const COMEDIANS_DIR = path.join(OUTPUT_DIR, "blog", "comedians");
const MANIFEST_PATH = path.join(COMEDIANS_DIR, "manifest.json");
const STATE_PATH = path.join(COMEDIANS_DIR, "ig-post-state.json");
const IMAGES_BASE_URL =
  "https://sanjmanak.github.io/show_lister/blog/comedians/images";

// Facebook Page ID is resolved at runtime from the Page Access Token
let FB_PAGE_ID = "";

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

function loadState() {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  }
  return { posted: [], week_range: null, manifest_version: null };
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  console.log(`State saved → ${STATE_PATH}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNextToPost(manifest, state) {
  if (state.week_range !== manifest.week_range) {
    console.log(
      `New week detected ("${manifest.week_range}" vs "${state.week_range}") — resetting state.`
    );
    state.posted = [];
    state.week_range = manifest.week_range;
    state.manifest_version = manifest.manifest_version || null;
  } else if (
    manifest.manifest_version &&
    state.manifest_version &&
    state.manifest_version !== manifest.manifest_version
  ) {
    // Same week but manifest was regenerated mid-week. Drop any state
    // entries whose slugs no longer appear in the manifest — they refer to
    // comedians we no longer intend to post. Keep entries that still match
    // so we don't re-post anyone who already went out.
    const manifestSlugs = new Set(manifest.posts.map((p) => p.slug));
    const before = state.posted.length;
    state.posted = state.posted.filter((p) => manifestSlugs.has(p.slug));
    const dropped = before - state.posted.length;
    console.log(
      `Manifest regenerated mid-week (v${state.manifest_version} → v${manifest.manifest_version}). ` +
        `Pruned ${dropped} stale state entr${dropped === 1 ? "y" : "ies"}.`
    );
    state.manifest_version = manifest.manifest_version;
  } else if (manifest.manifest_version && !state.manifest_version) {
    state.manifest_version = manifest.manifest_version;
  }

  const postedSlugs = new Set(state.posted.map((p) => p.slug));
  const remaining = manifest.posts.filter((p) => !postedSlugs.has(p.slug));

  return remaining.length === 0 ? null : remaining[0];
}

/**
 * Read caption from dedicated file, falling back to manifest inline caption.
 */
function loadCaption(post) {
  const captionFile = path.join(COMEDIANS_DIR, `${post.slug}-caption.txt`);
  if (fs.existsSync(captionFile)) {
    const txt = fs.readFileSync(captionFile, "utf8").trim();
    if (txt) return txt;
  }
  return post.caption || "";
}

/**
 * Resolve the comedian's Instagram handle for user_tags on the IG photo.
 *
 * Priority:
 *   1. post.instagramHandle from manifest.json (authoritative — set by
 *      the generator from OpenAI research, always "@name" format).
 *   2. Last @mention in the caption body.
 *   3. Bare-handle fallback: the generator template puts the handle on
 *      its own trailing line, so if the last non-empty line looks like a
 *      single handle token (no spaces, handle-legal chars), use it.
 *      This recovers captions that were generated before the normalizer
 *      fix landed and emitted the handle without an "@" prefix.
 *
 * Returns the handle WITHOUT the leading "@", or null if none found.
 */
function resolveHandle(post, caption) {
  // 1. Manifest field (authoritative)
  if (post.instagramHandle) {
    return post.instagramHandle.replace(/^@+/, "").trim() || null;
  }

  // 2. Last @mention in caption
  const mentions = caption.match(/@([a-zA-Z0-9_.]+)/g);
  if (mentions && mentions.length > 0) {
    return mentions[mentions.length - 1].replace("@", "");
  }

  // 3. Bare handle on the last non-empty line (legacy fallback)
  const lines = caption.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Skip hashtag-only lines
    if (line.startsWith("#")) continue;
    // Single token, handle-legal chars, reasonable length, not a sentence
    if (/^[a-zA-Z0-9_.]{3,30}$/.test(line) && !/\s/.test(line)) {
      return line;
    }
    // Stop at the first non-matching non-hashtag line — the handle is
    // only valid if it's at the very end, not buried mid-caption.
    break;
  }

  return null;
}

// verifyImageUrl, waitForContainer, publishWithRetry, isUserTagError come
// from scripts/lib/meta-api.js — including the May-2026 container-status
// workaround and the 9007 "media not ready" retry. See the lib for the
// full incident history.

// ---------------------------------------------------------------------------
// Channel 1: Instagram Feed — carousel (if teasers exist) or single image
// ---------------------------------------------------------------------------

/**
 * Check if blog teaser images exist for this comedian on GitHub Pages.
 * Returns array of teaser URLs that are accessible, or empty array.
 */
async function findTeaserImages(slug) {
  const teasers = [];
  // Only one teaser is generated now (the top-of-page shot). Sharing a
  // second screenshot of the article body gives away too much of the post.
  for (let i = 1; i <= 1; i++) {
    const url = `${IMAGES_BASE_URL}/${slug}-teaser-${i}.png`;
    try {
      await verifyImageUrl(url);
      teasers.push(url);
    } catch {
      // Teaser doesn't exist — that's fine
    }
  }
  return teasers;
}

/**
 * Create a single carousel child container.
 *
 * Meta's Graph API does NOT accept `user_tags` on the carousel parent
 * (returns 400 / OAuthException 100 / subcode 2207065). Tags must be
 * attached to the child container at creation time. We tag only slide 1
 * (the comedian's main image).
 *
 * If the handle is bad (private/invalid/deleted), Meta rejects the create
 * call. Retry once without user_tags so the post still goes out — the
 * caption already references @handle as text. Returns the child id and a
 * boolean indicating whether the tag was dropped.
 */
async function createCarouselChild(imageUrl, handle = null) {
  const baseParams = {
    image_url: imageUrl,
    is_carousel_item: true,
    access_token: IG_ACCESS_TOKEN,
  };
  const params = handle
    ? {
        ...baseParams,
        user_tags: JSON.stringify([{ username: handle, x: 0.5, y: 0.5 }]),
      }
    : baseParams;

  let child;
  let tagDropped = false;
  try {
    child = await graphRequest("POST", `/${IG_USER_ID}/media`, params);
  } catch (err) {
    if (handle && isUserTagError(err)) {
      console.warn(
        `   ⚠ Meta rejected user_tag @${handle} (${err.message.split("\n")[0]}). ` +
        `Retrying without the tag — caption still references the handle.`
      );
      child = await graphRequest("POST", `/${IG_USER_ID}/media`, baseParams);
      tagDropped = true;
    } else {
      throw err;
    }
  }
  // Do NOT poll a carousel *child* item container's status. Unlike single-image
  // and parent carousel containers, the Graph API rejects a status GET on a
  // child item with GraphMethodException code 100 / subcode 33 ("Authorization
  // Error") even though the create call returned 200 — observed persistently
  // (every poll, not a transient race) in production. Child readiness is
  // reflected by the PARENT carousel container's status, which IS pollable and
  // which we wait on before publishing. So just return the child ID.
  return { id: child.id, tagDropped };
}

async function postInstagramFeed(post, caption, handle) {
  const squareUrl = `${IMAGES_BASE_URL}/${post.slug}-square.png`;

  console.log(`\n  IG FEED — ${post.comedianName}`);
  await verifyImageUrl(squareUrl);

  // Check for teaser images (for carousel)
  console.log("   Checking for blog teaser images…");
  const teaserUrls = await findTeaserImages(post.slug);

  if (teaserUrls.length > 0) {
    // ---- CAROUSEL MODE ----
    console.log(`   Found ${teaserUrls.length} teaser(s) — building carousel.`);
    const allImages = [squareUrl, ...teaserUrls];

    // Step 1 — Create child containers for each image. Tag the comedian
    // on slide 1 only; Meta rejects user_tags on the carousel parent.
    const childIds = [];
    for (let i = 0; i < allImages.length; i++) {
      console.log(`   Creating carousel child ${i + 1}/${allImages.length}…`);
      const childHandle = i === 0 ? handle : null;
      const { id: childId, tagDropped } = await createCarouselChild(
        allImages[i],
        childHandle
      );
      childIds.push(childId);
      const tagNote = childHandle
        ? tagDropped
          ? ` (tag @${childHandle} dropped — invalid/private)`
          : ` (tagged @${childHandle})`
        : "";
      console.log(`   Child ${i + 1}: ${childId}${tagNote}`);
    }

    // Step 2 — Create the carousel container (no user_tags here — Meta
    // rejects them on CAROUSEL_V2 parents).
    console.log("   Creating carousel container…");
    const carouselParams = {
      media_type: "CAROUSEL",
      caption,
      children: childIds.join(","),
      access_token: IG_ACCESS_TOKEN,
    };

    const carousel = await graphRequest("POST", `/${IG_USER_ID}/media`, carouselParams);
    console.log(`   Carousel container: ${carousel.id}`);

    await waitForContainer(carousel.id);

    // Step 3 — Publish (with 9007 "not ready" retry — see publishWithRetry)
    console.log("   Publishing carousel…");
    const result = await publishWithRetry(carousel.id, "Carousel");

    console.log(`   IG Feed posted as CAROUSEL (${allImages.length} slides)! Media ID: ${result.id}`);
    return result.id;

  } else {
    // ---- SINGLE IMAGE MODE (fallback) ----
    console.log("   No teasers found — posting single image.");

    const mediaParams = {
      image_url: squareUrl,
      caption,
      access_token: IG_ACCESS_TOKEN,
    };

    if (handle) {
      mediaParams.user_tags = JSON.stringify([
        { username: handle, x: 0.5, y: 0.5 },
      ]);
      console.log(`   Tagging: @${handle}`);
    }

    console.log("   Creating media container…");
    let container;
    try {
      container = await graphRequest("POST", `/${IG_USER_ID}/media`, mediaParams);
    } catch (err) {
      if (handle && isUserTagError(err)) {
        console.warn(
          `   ⚠ Meta rejected user_tag @${handle} (${err.message.split("\n")[0]}). ` +
          `Retrying without the tag — caption still references the handle.`
        );
        delete mediaParams.user_tags;
        container = await graphRequest("POST", `/${IG_USER_ID}/media`, mediaParams);
      } else {
        throw err;
      }
    }
    console.log(`   Container: ${container.id}`);

    await waitForContainer(container.id);

    console.log("   Publishing…");
    const result = await publishWithRetry(container.id, "IG Feed");

    console.log(`   IG Feed posted! Media ID: ${result.id}`);
    return result.id;
  }
}

// ---------------------------------------------------------------------------
// Channel 2: Instagram Story (story-sized image, no caption)
// ---------------------------------------------------------------------------

async function postInstagramStory(post) {
  const imageUrl = `${IMAGES_BASE_URL}/${post.slug}-story.png`;

  console.log(`\n  IG STORY — ${post.comedianName}`);
  await verifyImageUrl(imageUrl);

  // Step 1 — Create story container
  console.log("   Creating story container…");
  const container = await graphRequest("POST", `/${IG_USER_ID}/media`, {
    image_url: imageUrl,
    media_type: "STORIES",
    access_token: IG_ACCESS_TOKEN,
  });
  console.log(`   Container: ${container.id}`);

  await waitForContainer(container.id);

  // Stories need extra buffer time after FINISHED — Meta's backend sometimes
  // reports FINISHED before the media is actually ready to publish (code 9007).
  console.log("   Waiting 5s for Stories backend to fully process…");
  await new Promise((r) => setTimeout(r, 5000));

  // Step 2 — Publish (publishWithRetry handles 9007 "not ready" race)
  console.log("   Publishing story…");
  const result = await publishWithRetry(container.id, "Story");

  console.log(`   IG Story posted! Media ID: ${result.id}`);
  return result.id;
}

// ---------------------------------------------------------------------------
// Channel 3: Facebook Page Feed (square image + caption)
// ---------------------------------------------------------------------------

async function postFacebookFeed(post, caption) {
  if (!FB_PAGE_ID) {
    console.log("\n  FB FEED — Skipped (no Facebook Page ID resolved)");
    return null;
  }

  const imageUrl = `${IMAGES_BASE_URL}/${post.slug}-square.png`;

  console.log(`\n  FB FEED — ${post.comedianName}`);

  // Facebook Pages API: POST /{page-id}/photos
  console.log("   Posting photo to Facebook Page…");
  const result = await graphRequest("POST", `/${FB_PAGE_ID}/photos`, {
    url: imageUrl,
    message: caption,
    published: true,
    access_token: IG_ACCESS_TOKEN,
  });

  console.log(`   FB Feed posted! Post ID: ${result.id || result.post_id}`);
  return result.id || result.post_id;
}

// ---------------------------------------------------------------------------
// Channel 4: Facebook Page Story (story-sized image)
// ---------------------------------------------------------------------------

async function postFacebookStory(post) {
  if (!FB_PAGE_ID) {
    console.log("\n  FB STORY — Skipped (no Facebook Page ID resolved)");
    return null;
  }

  const imageUrl = `${IMAGES_BASE_URL}/${post.slug}-story.png`;

  console.log(`\n  FB STORY — ${post.comedianName}`);

  // Step 1 — Upload photo as unpublished
  console.log("   Uploading unpublished photo…");
  const photo = await graphRequest("POST", `/${FB_PAGE_ID}/photos`, {
    url: imageUrl,
    published: false,
    access_token: IG_ACCESS_TOKEN,
  });
  console.log(`   Photo ID: ${photo.id}`);

  // Step 2 — Create story from the photo
  console.log("   Creating Facebook story…");
  const story = await graphRequest("POST", `/${FB_PAGE_ID}/photo_stories`, {
    photo_id: photo.id,
    access_token: IG_ACCESS_TOKEN,
  });

  console.log(`   FB Story posted! Story ID: ${story.id || story.post_id}`);
  return story.id || story.post_id;
}

// ---------------------------------------------------------------------------
// Orchestrator: post to all channels, tolerating individual failures
// ---------------------------------------------------------------------------

// Hard timeout (ms) for any single channel publish. If Meta's container
// poll loop or any other step hangs, we abort that channel and continue
// to the next one rather than letting the whole job stall for hours.
const CHANNEL_TIMEOUT_MS = parseInt(process.env.IG_CHANNEL_TIMEOUT_MS || "300000", 10); // 5 min default

async function publishEverywhere(post) {
  const caption = loadCaption(post);
  const handle = resolveHandle(post, caption);

  console.log(`\n📸 Publishing: ${post.comedianName}`);
  console.log(`   Caption length: ${caption.length} chars`);
  console.log(`   Caption preview: ${caption.slice(0, 120)}…`);
  console.log(`   Comedian handle: ${handle ? "@" + handle : "(not found)"}`);
  console.log(`   Per-channel timeout: ${Math.round(CHANNEL_TIMEOUT_MS / 1000)}s`);

  const results = {
    igFeed: null,
    igStory: null,
    fbFeed: null,
    fbStory: null,
    errors: [],
  };

  // --- Instagram Feed (primary — must succeed) ---
  // Even the primary channel gets a timeout so a stuck container poll
  // can't hang the workflow indefinitely.
  try {
    results.igFeed = await withTimeout(
      postInstagramFeed(post, caption, handle),
      "IG Feed",
      CHANNEL_TIMEOUT_MS
    );
  } catch (err) {
    console.error(`\n  ERROR: IG Feed failed — ${err.message}`);
    results.errors.push(`IG Feed: ${err.message}`);
    // IG Feed is the anchor post — if it failed, don't waste API quota on
    // the other channels for this comedian; bail out and let the next
    // scheduled run retry the same comedian (state is only updated on
    // successful IG Feed below).
    throw err;
  }

  // --- Instagram Story (best-effort) ---
  try {
    results.igStory = await withTimeout(
      postInstagramStory(post),
      "IG Story",
      CHANNEL_TIMEOUT_MS
    );
  } catch (err) {
    console.error(`\n  WARNING: IG Story failed — ${err.message}`);
    results.errors.push(`IG Story: ${err.message}`);
  }

  // --- Facebook Page Feed (best-effort) ---
  try {
    results.fbFeed = await withTimeout(
      postFacebookFeed(post, caption),
      "FB Feed",
      CHANNEL_TIMEOUT_MS
    );
  } catch (err) {
    console.error(`\n  WARNING: FB Feed failed — ${err.message}`);
    results.errors.push(`FB Feed: ${err.message}`);
  }

  // --- Facebook Page Story (best-effort) ---
  try {
    results.fbStory = await withTimeout(
      postFacebookStory(post),
      "FB Story",
      CHANNEL_TIMEOUT_MS
    );
  } catch (err) {
    console.error(`\n  WARNING: FB Story failed — ${err.message}`);
    results.errors.push(`FB Story: ${err.message}`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();
  console.log("=== Comedy Houston — Social Media Auto-Poster ===");
  console.log(`    Time: ${new Date().toISOString()}`);
  console.log(`    Graph API: ${GRAPH_API_VERSION}`);
  console.log(`    Node: ${process.version}`);
  console.log(`    Channels: IG Feed + IG Story + FB Feed + FB Story\n`);

  console.log(`Config:`);
  console.log(`  IG User ID: ${IG_USER_ID || "(not set)"}`);
  console.log(`  Token: ${IG_ACCESS_TOKEN.slice(0, 10)}…(${IG_ACCESS_TOKEN.length} chars)`);
  console.log(`  Manifest: ${MANIFEST_PATH}`);
  console.log(`  State: ${STATE_PATH}`);
  console.log(`  Images base URL: ${IMAGES_BASE_URL}`);

  // Secrets check, token validation, and the two expiry early-warning
  // clocks (token expiry + 90-day data-access window). Exits loudly on
  // hard failures so the notify-on-failure email fires — see the lib.
  await validateTokenAndGuards();

  // Resolve Facebook Page ID (for FB feed + FB stories)
  FB_PAGE_ID = await resolveFacebookPageId();

  // Load manifest
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.log("\nNo manifest.json found — nothing to post. Exiting.");
    process.exit(0);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  if (!manifest.posts || manifest.posts.length === 0) {
    console.log("\nManifest has no posts — nothing to post. Exiting.");
    process.exit(0);
  }

  console.log(`\nManifest loaded:`);
  console.log(`  Week: "${manifest.week_range}"`);
  console.log(`  Generated: ${manifest.generated_at}`);
  console.log(`  Comedians: ${manifest.posts.map((p) => p.comedianName).join(", ")}`);

  // Load state & determine next post
  const state = loadState();
  console.log(`\nState loaded:`);
  console.log(`  State week: "${state.week_range || "none"}"`);
  console.log(`  Already posted: ${state.posted.length} (${state.posted.map((p) => p.comedianName).join(", ") || "none"})`);

  const nextPost = getNextToPost(manifest, state);

  if (!nextPost) {
    console.log("\nAll posts for this week have been published. Nothing to do.");
    process.exit(0);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`POSTING: ${nextPost.comedianName}`);
  console.log(`  Slug: ${nextPost.slug}`);
  console.log(`  Venue: ${nextPost.venue}`);
  console.log(`  Date: ${nextPost.date}`);
  console.log(`  Progress: ${state.posted.length + 1}/${manifest.posts.length}`);
  console.log(`${"=".repeat(60)}`);

  // Publish across all channels
  const results = await publishEverywhere(nextPost);

  // Update state
  state.posted.push({
    slug: nextPost.slug,
    comedianName: nextPost.comedianName,
    igFeedMediaId: results.igFeed,
    igStoryMediaId: results.igStory,
    fbFeedPostId: results.fbFeed,
    fbStoryPostId: results.fbStory,
    postedAt: new Date().toISOString(),
  });
  saveState(state);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS — ${nextPost.comedianName}`);
  console.log(`  IG Feed:  ${results.igFeed ? "POSTED (ID: " + results.igFeed + ")" : "FAILED"}`);
  console.log(`  IG Story: ${results.igStory ? "POSTED (ID: " + results.igStory + ")" : "SKIPPED/FAILED"}`);
  console.log(`  FB Feed:  ${results.fbFeed ? "POSTED (ID: " + results.fbFeed + ")" : "SKIPPED/FAILED"}`);
  console.log(`  FB Story: ${results.fbStory ? "POSTED (ID: " + results.fbStory + ")" : "SKIPPED/FAILED"}`);
  if (results.errors.length > 0) {
    console.log(`  Warnings: ${results.errors.length}`);
    results.errors.forEach((e) => console.log(`    - ${e}`));
  }
  console.log(`  Progress: ${state.posted.length}/${manifest.posts.length} published this week`);
  console.log(`  Remaining: ${manifest.posts.length - state.posted.length}`);
  console.log(`  Elapsed: ${elapsed}s`);
  console.log(`${"=".repeat(60)}`);
}

// Shared exit path (scripts/lib/meta-api.js shutdown()): destroys keep-alive
// sockets so the process actually exits — a leak here used to cancel the
// state-commit step and cause duplicate comedian posts. Used by BOTH success
// and error paths.
main()
  .then(() => shutdown(0))
  .catch((err) => {
    // Rate-limit: exit 0 so the workflow doesn't flag red; state was NOT
    // advanced, so the next cron will retry the same comedian cleanly.
    if (err && typeof err.message === "string" && err.message.startsWith("RATE_LIMITED")) {
      console.error(`\nRATE LIMITED — ${err.message}. Exiting 0; state not advanced.`);
      return shutdown(0);
    }
    console.error(`\n${"!".repeat(60)}`);
    console.error(`FATAL ERROR: ${err.message}`);
    console.error(`${"!".repeat(60)}`);
    if (err.stack) {
      console.error(`\nStack trace:\n${err.stack}`);
    }
    console.error(`\nCommon fixes:`);
    console.error(`  1. Expired token → regenerate in Graph API Explorer, update GitHub secret`);
    console.error(`  2. Image not found → ensure branch is merged to main and GitHub Pages deployed`);
    console.error(`  3. Permission error → check instagram_content_publish is granted to the app`);
    console.error(`  4. Rate limit → wait and retry (max ~25 posts per 24 hours)`);
    shutdown(1);
  });
