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

const https = require("https");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const IG_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || "";
const IG_USER_ID = process.env.INSTAGRAM_USER_ID || "";
const GRAPH_API_VERSION = "v25.0";

const OUTPUT_DIR = path.resolve(__dirname, "..");
const COMEDIANS_DIR = path.join(OUTPUT_DIR, "blog", "comedians");
const MANIFEST_PATH = path.join(COMEDIANS_DIR, "manifest.json");
const STATE_PATH = path.join(COMEDIANS_DIR, "ig-post-state.json");
const IMAGES_BASE_URL =
  "https://sanjmanak.github.io/show_lister/blog/comedians/images";

// Facebook Page ID is resolved at runtime from the Page Access Token
let FB_PAGE_ID = "";

// ---------------------------------------------------------------------------
// HTTP helpers (vanilla Node.js — matches existing repo patterns)
// ---------------------------------------------------------------------------

/**
 * Make an HTTPS request and return parsed JSON.
 * Retries up to 2 times on transient errors (5xx, network).
 * Logs full request/response details for debugging.
 */
function graphRequest(method, urlPath, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}${urlPath}`);

    // Build safe params for logging (redact access_token)
    const safeParams = params ? { ...params } : {};
    if (safeParams.access_token) {
      safeParams.access_token = safeParams.access_token.slice(0, 10) + "…REDACTED";
    }

    if (method === "GET" && params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }

    const body = method === "POST" ? JSON.stringify(params) : null;

    // Log the request (safe version)
    console.log(`\n  [API] ${method} ${url.pathname}`);
    console.log(`  [API] Params: ${JSON.stringify(safeParams)}`);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
      },
    };

    const attempt = (retries, backoffMs) => {
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          console.log(`  [API] Response status: ${res.statusCode}`);

          // Honor Retry-After header if present (seconds or HTTP date).
          const retryAfterHeader = res.headers && res.headers["retry-after"];
          let retryAfterMs = 0;
          if (retryAfterHeader) {
            const n = Number(retryAfterHeader);
            if (!Number.isNaN(n)) {
              retryAfterMs = n * 1000;
            } else {
              const t = Date.parse(retryAfterHeader);
              if (!Number.isNaN(t)) retryAfterMs = Math.max(0, t - Date.now());
            }
          }

          try {
            const parsed = JSON.parse(data);

            // 429 Too Many Requests — respect Retry-After, then bail out of
            // this run entirely (exit 0) so state is NOT advanced and the
            // next scheduled cron picks up cleanly. We don't loop locally —
            // Meta's IG publish quota is ~25/day and retrying in-process just
            // burns job minutes.
            if (res.statusCode === 429) {
              const waitSec = retryAfterMs ? Math.round(retryAfterMs / 1000) : "unknown";
              console.error(`  [API] 429 Rate limited. Retry-After: ${waitSec}s`);
              return reject(new Error(`RATE_LIMITED:${waitSec}`));
            }

            if (res.statusCode >= 500 && retries > 0) {
              const delay = retryAfterMs || backoffMs;
              console.log(
                `  [API] Server error ${res.statusCode} — retrying in ${delay}ms (${retries} left)…`
              );
              console.log(`  [API] Response body: ${data.slice(0, 500)}`);
              return setTimeout(() => attempt(retries - 1, Math.min(backoffMs * 2, 30000)), delay);
            }

            if (res.statusCode >= 400) {
              const errCode = parsed.error?.code || "unknown";
              const errSubcode = parsed.error?.error_subcode || "none";
              const errType = parsed.error?.type || "unknown";
              const errMsg = parsed.error?.message || data.slice(0, 500);

              console.error(`  [API] ERROR ${res.statusCode}:`);
              console.error(`  [API]   Type: ${errType}`);
              console.error(`  [API]   Code: ${errCode}, Subcode: ${errSubcode}`);
              console.error(`  [API]   Message: ${errMsg}`);
              console.error(`  [API]   Full response: ${data.slice(0, 1000)}`);

              // Common error diagnosis
              if (errCode === 190) {
                console.error(`\n  DIAGNOSIS: Access token is expired or invalid.`);
                console.error(`  FIX: Generate a new long-lived token and update the INSTAGRAM_ACCESS_TOKEN GitHub secret.`);
              } else if (errCode === 10 || errSubcode === 2207050) {
                console.error(`\n  DIAGNOSIS: App does not have permission to publish.`);
                console.error(`  FIX: Ensure instagram_content_publish permission is granted and the app has access to the Page.`);
              } else if (errCode === 36003) {
                console.error(`\n  DIAGNOSIS: Image URL is not publicly accessible.`);
                console.error(`  FIX: Ensure the image is committed to main and accessible via GitHub Pages.`);
              } else if (errCode === 9007) {
                console.error(`\n  DIAGNOSIS: Duplicate post — this image/caption may have already been published.`);
              } else if (errCode === 4 || errCode === 17 || errCode === 32 || errCode === 613) {
                console.error(`\n  DIAGNOSIS: Rate limit hit (code ${errCode}).`);
                console.error(`  FIX: Skipping this run; state will NOT advance. Next cron will retry.`);
                return reject(new Error(`RATE_LIMITED:code_${errCode}`));
              }

              return reject(
                new Error(
                  `Graph API error ${res.statusCode} (code ${errCode}): ${errMsg}`
                )
              );
            }

            console.log(`  [API] Success: ${JSON.stringify(parsed).slice(0, 200)}`);
            resolve(parsed);
          } catch (e) {
            console.error(`  [API] Failed to parse response: ${data.slice(0, 500)}`);
            reject(new Error(`Failed to parse Graph API response: ${e.message}`));
          }
        });
      });

      req.on("error", (err) => {
        console.error(`  [API] Network error: ${err.message}`);
        if (retries > 0) {
          console.log(`  [API] Retrying in ${backoffMs}ms (${retries} left)…`);
          return setTimeout(() => attempt(retries - 1, Math.min(backoffMs * 2, 30000)), backoffMs);
        }
        reject(err);
      });

      if (body) req.write(body);
      req.end();
    };

    attempt(2, 3000);
  });
}

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

/**
 * HEAD-request an image URL to verify it's publicly accessible.
 */
function verifyImageUrl(imageUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(imageUrl);
    const req = https.request(
      { hostname: url.hostname, path: url.pathname, method: "HEAD" },
      (res) => {
        console.log(`   Image check: HTTP ${res.statusCode} — ${imageUrl.split("/").pop()}`);
        if (res.statusCode === 200) {
          resolve();
        } else if (res.statusCode === 301 || res.statusCode === 302) {
          console.log(`   Image redirects to: ${res.headers.location}`);
          resolve();
        } else {
          reject(
            new Error(
              `Image not accessible (HTTP ${res.statusCode}): ${imageUrl}\n` +
              `   FIX: Make sure the branch is merged to main and GitHub Pages has deployed.`
            )
          );
        }
      }
    );
    req.on("error", (err) => {
      reject(new Error(`Cannot reach image URL: ${err.message}`));
    });
    req.end();
  });
}

/**
 * Poll container status until FINISHED (max ~30 seconds).
 */
async function waitForContainer(containerId) {
  const maxAttempts = 10;
  const delayMs = 3000;

  console.log(`   Waiting for container ${containerId} to finish processing…`);

  for (let i = 0; i < maxAttempts; i++) {
    const status = await graphRequest("GET", `/${containerId}`, {
      fields: "status_code,status",
      access_token: IG_ACCESS_TOKEN,
    });

    const code = status.status_code || "UNKNOWN";
    console.log(`   Poll ${i + 1}/${maxAttempts}: status=${code}`);

    if (code === "FINISHED") {
      console.log("   Container ready for publishing.");
      return;
    }

    if (code === "ERROR") {
      const detail = status.status || "no detail provided";
      console.error(`   Container processing FAILED: ${detail}`);
      throw new Error(
        `Container processing failed (status: ${detail}). Ensure the PNG is committed ` +
        `to main and deployed via GitHub Pages.`
      );
    }

    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.log("   WARNING: Container poll timed out after 30s — attempting publish anyway.");
}

// ---------------------------------------------------------------------------
// Channel 1: Instagram Feed — carousel (if teasers exist) or single image
// ---------------------------------------------------------------------------

/**
 * Check if blog teaser images exist for this comedian on GitHub Pages.
 * Returns array of teaser URLs that are accessible, or empty array.
 */
async function findTeaserImages(slug) {
  const teasers = [];
  for (let i = 1; i <= 2; i++) {
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
 */
async function createCarouselChild(imageUrl, handle = null) {
  const params = {
    image_url: imageUrl,
    is_carousel_item: true,
    access_token: IG_ACCESS_TOKEN,
  };
  if (handle) {
    params.user_tags = JSON.stringify([
      { username: handle, x: 0.5, y: 0.5 },
    ]);
  }
  const child = await graphRequest("POST", `/${IG_USER_ID}/media`, params);
  await waitForContainer(child.id);
  return child.id;
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
      const childId = await createCarouselChild(allImages[i], childHandle);
      childIds.push(childId);
      console.log(`   Child ${i + 1}: ${childId}${childHandle ? ` (tagged @${childHandle})` : ""}`);
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

    // Step 3 — Publish
    console.log("   Publishing carousel…");
    const result = await graphRequest("POST", `/${IG_USER_ID}/media_publish`, {
      creation_id: carousel.id,
      access_token: IG_ACCESS_TOKEN,
    });

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
    const container = await graphRequest("POST", `/${IG_USER_ID}/media`, mediaParams);
    console.log(`   Container: ${container.id}`);

    await waitForContainer(container.id);

    console.log("   Publishing…");
    const result = await graphRequest("POST", `/${IG_USER_ID}/media_publish`, {
      creation_id: container.id,
      access_token: IG_ACCESS_TOKEN,
    });

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

  // Step 2 — Publish (with retry for the 9007 "not ready" race condition)
  console.log("   Publishing story…");
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = await graphRequest("POST", `/${IG_USER_ID}/media_publish`, {
        creation_id: container.id,
        access_token: IG_ACCESS_TOKEN,
      });
      break; // success
    } catch (err) {
      const isNotReady = err.message.includes("9007") || err.message.includes("not ready");
      if (isNotReady && attempt < 2) {
        const waitSec = (attempt + 1) * 5;
        console.log(`   Story not ready yet — waiting ${waitSec}s before retry ${attempt + 2}/3…`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
      } else {
        throw err;
      }
    }
  }

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

function withTimeout(promise, label, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
// Resolve Facebook Page ID from the Page Access Token
// ---------------------------------------------------------------------------

async function resolveFacebookPageId() {
  try {
    console.log("\nResolving Facebook Page ID from token…");
    const me = await graphRequest("GET", "/me", {
      fields: "id,name",
      access_token: IG_ACCESS_TOKEN,
    });
    // A Page Access Token returns the Page when you call /me
    // A User Access Token returns the user — check which one we got
    if (me && me.id) {
      FB_PAGE_ID = me.id;
      console.log(`  Facebook Page: "${me.name || "(unnamed)"}" (ID: ${FB_PAGE_ID})`);
      return;
    }
    console.error("  ERROR: /me returned no id — token does not resolve to a Facebook Page.");
    console.error("  ACTION: Ensure INSTAGRAM_ACCESS_TOKEN is a Page Access Token (not a User token).");
    console.error("  Facebook posting will be UNAVAILABLE this run; IG posting will continue.");
  } catch (err) {
    console.error(`  ERROR: Could not resolve Facebook Page ID — ${err.message}`);
    console.error("  ACTION: Regenerate a long-lived Page Access Token and update INSTAGRAM_ACCESS_TOKEN.");
    console.error("  Facebook posting will be UNAVAILABLE this run; IG posting will continue.");
  }
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

  // Validate secrets
  if (!IG_ACCESS_TOKEN) {
    console.error("ERROR: INSTAGRAM_ACCESS_TOKEN secret is not set.");
    console.error("FIX: Add it in GitHub repo → Settings → Secrets → Actions.");
    console.error("     See ARCHITECTURE.md for setup instructions.");
    process.exit(1);
  }
  if (!IG_USER_ID) {
    console.error("ERROR: INSTAGRAM_USER_ID secret is not set.");
    console.error("FIX: Add it in GitHub repo → Settings → Secrets → Actions.");
    console.error("     Run this in Graph API Explorer to find it:");
    console.error("     GET /{page-id}?fields=instagram_business_account");
    process.exit(1);
  }

  console.log(`Config:`);
  console.log(`  IG User ID: ${IG_USER_ID}`);
  console.log(`  Token: ${IG_ACCESS_TOKEN.slice(0, 10)}…(${IG_ACCESS_TOKEN.length} chars)`);
  console.log(`  Manifest: ${MANIFEST_PATH}`);
  console.log(`  State: ${STATE_PATH}`);
  console.log(`  Images base URL: ${IMAGES_BASE_URL}`);

  // Validate token with a lightweight API call
  console.log("\nValidating access token…");
  try {
    const tokenCheck = await graphRequest("GET", `/${IG_USER_ID}`, {
      fields: "id,username",
      access_token: IG_ACCESS_TOKEN,
    });
    console.log(`  Token valid! IG account: @${tokenCheck.username || tokenCheck.id}`);
  } catch (err) {
    console.error(`\nERROR: Token validation failed — ${err.message}`);
    console.error("FIX: Your access token may be expired (they last ~60 days).");
    console.error("     Generate a new one via Graph API Explorer and update the GitHub secret.");
    process.exit(1);
  }

  // Resolve Facebook Page ID (for FB feed + FB stories)
  await resolveFacebookPageId();

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

// Shared exit path. Without this the process has been observed to hang for
// over an hour after main() completes — lingering HTTP/1.1 keep-alive sockets
// to graph.facebook.com (and/or any other unref'd handle) keep the event loop
// alive, GitHub Actions eventually cancels the step, the state-commit step
// never runs, and the next scheduled run reposts the same comedian to all
// four channels. Destroy the agent, give Node a tick to tear down sockets,
// then exit. Used by BOTH success and error paths so state is never left
// uncommitted because of a keep-alive leak on the error branch.
function exit(code) {
  try { https.globalAgent.destroy(); } catch {}
  // Unref any remaining handles and give destroy() a beat to complete.
  setTimeout(() => process.exit(code), 150).unref();
}

main()
  .then(() => exit(0))
  .catch((err) => {
    // Rate-limit: exit 0 so the workflow doesn't flag red; state was NOT
    // advanced, so the next cron will retry the same comedian cleanly.
    if (err && typeof err.message === "string" && err.message.startsWith("RATE_LIMITED")) {
      console.error(`\nRATE LIMITED — ${err.message}. Exiting 0; state not advanced.`);
      return exit(0);
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
    exit(1);
  });
