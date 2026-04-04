#!/usr/bin/env node

/**
 * Comedy Houston — Instagram Auto-Poster
 *
 * Reads blog/comedians/manifest.json, determines the next comedian to post
 * (via ig-post-state.json), and publishes one carousel-free image post to
 * Instagram using the Meta Graph API (Content Publishing API).
 *
 * Two-step publish flow:
 *   1. POST /{ig-user-id}/media  → create media container (image_url + caption)
 *   2. POST /{ig-user-id}/media_publish → publish the container
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

    const attempt = (retries) => {
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          console.log(`  [API] Response status: ${res.statusCode}`);

          try {
            const parsed = JSON.parse(data);

            if (res.statusCode >= 500 && retries > 0) {
              console.log(
                `  [API] Server error ${res.statusCode} — retrying (${retries} left)…`
              );
              console.log(`  [API] Response body: ${data.slice(0, 500)}`);
              return setTimeout(() => attempt(retries - 1), 3000);
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
              } else if (errCode === 4) {
                console.error(`\n  DIAGNOSIS: Rate limit hit.`);
                console.error(`  FIX: Wait before retrying. Instagram allows ~25 posts per 24 hours.`);
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
          console.log(`  [API] Retrying (${retries} left)…`);
          return setTimeout(() => attempt(retries - 1), 3000);
        }
        reject(err);
      });

      if (body) req.write(body);
      req.end();
    };

    attempt(2);
  });
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

function loadState() {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  }
  return { posted: [], week_range: null };
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  console.log(`State saved → ${STATE_PATH}`);
}

// ---------------------------------------------------------------------------
// Core: determine next post & publish
// ---------------------------------------------------------------------------

function getNextToPost(manifest, state) {
  // If the week changed, reset state
  if (state.week_range !== manifest.week_range) {
    console.log(
      `New week detected ("${manifest.week_range}" vs "${state.week_range}") — resetting state.`
    );
    state.posted = [];
    state.week_range = manifest.week_range;
  }

  const postedSlugs = new Set(state.posted.map((p) => p.slug));
  const remaining = manifest.posts.filter((p) => !postedSlugs.has(p.slug));

  if (remaining.length === 0) {
    return null;
  }

  return remaining[0];
}

/**
 * Read the caption from the dedicated caption file, falling back to the
 * manifest's inline caption field.
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
 * Step 1: Create a media container
 * Step 2: Publish the container
 */
async function publishToInstagram(post) {
  const imageUrl = `${IMAGES_BASE_URL}/${post.slug}-square.png`;
  const caption = loadCaption(post);

  console.log(`\n📸 Publishing: ${post.comedianName}`);
  console.log(`   Slug: ${post.slug}`);
  console.log(`   Image URL: ${imageUrl}`);
  console.log(`   Caption length: ${caption.length} chars`);
  console.log(`   Caption preview: ${caption.slice(0, 120)}…`);
  console.log(`   IG User ID: ${IG_USER_ID}`);
  console.log(`   Token prefix: ${IG_ACCESS_TOKEN.slice(0, 10)}…`);

  // Verify the image is accessible before calling the API
  console.log("\n   Pre-check: Verifying image URL is accessible…");
  await verifyImageUrl(imageUrl);

  // Step 1 — Create media container
  console.log("\n   Step 1/2: Creating media container…");
  const container = await graphRequest("POST", `/${IG_USER_ID}/media`, {
    image_url: imageUrl,
    caption,
    access_token: IG_ACCESS_TOKEN,
  });

  const creationId = container.id;
  console.log(`   Container created: ${creationId}`);

  // The container may need a few seconds to process the image.
  // Poll the status before publishing (max 30s).
  await waitForContainer(creationId);

  // Step 2 — Publish
  console.log("   Step 2/2: Publishing container…");
  const result = await graphRequest("POST", `/${IG_USER_ID}/media_publish`, {
    creation_id: creationId,
    access_token: IG_ACCESS_TOKEN,
  });

  console.log(`\n   Published! Media ID: ${result.id}`);
  return result.id;
}

/**
 * HEAD-request the image URL to make sure it's publicly accessible.
 * If the image 404s, the Graph API will give a cryptic error — better to
 * catch it early with a clear message.
 */
function verifyImageUrl(imageUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(imageUrl);
    const req = https.request(
      { hostname: url.hostname, path: url.pathname, method: "HEAD" },
      (res) => {
        console.log(`   Image check: HTTP ${res.statusCode}`);
        if (res.statusCode === 200) {
          resolve();
        } else if (res.statusCode === 301 || res.statusCode === 302) {
          console.log(`   Image redirects to: ${res.headers.location}`);
          resolve(); // GitHub Pages may redirect, still OK
        } else {
          reject(
            new Error(
              `Image not accessible (HTTP ${res.statusCode}). ` +
              `The image must be committed to main and deployed via GitHub Pages.\n` +
              `   Expected URL: ${imageUrl}\n` +
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
 * Poll container status until it's FINISHED (or timeout after ~30 seconds).
 * Meta sometimes needs a few seconds to download and process the image.
 */
async function waitForContainer(containerId) {
  const maxAttempts = 10;
  const delayMs = 3000;

  console.log(`\n   Waiting for container ${containerId} to finish processing…`);

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
      console.error(`   Container processing FAILED.`);
      console.error(`   Status detail: ${detail}`);
      console.error(`   Full response: ${JSON.stringify(status)}`);
      throw new Error(
        `Container processing failed (status: ${detail}). This usually means the image URL ` +
        `is not accessible or is in an unsupported format. Ensure the PNG is committed to main ` +
        `and deployed via GitHub Pages.`
      );
    }

    if (i < maxAttempts - 1) {
      console.log(`   Waiting ${delayMs / 1000}s before next poll…`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // Proceed anyway — often works even if status hasn't flipped yet
  console.log("   WARNING: Container poll timed out after 30s — attempting publish anyway.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();
  console.log("=== Comedy Houston — Instagram Auto-Poster ===");
  console.log(`    Time: ${new Date().toISOString()}`);
  console.log(`    Graph API: ${GRAPH_API_VERSION}`);
  console.log(`    Node: ${process.version}\n`);

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

  // Publish
  const mediaId = await publishToInstagram(nextPost);

  // Update state
  state.posted.push({
    slug: nextPost.slug,
    comedianName: nextPost.comedianName,
    mediaId,
    postedAt: new Date().toISOString(),
  });
  saveState(state);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUCCESS — ${nextPost.comedianName} posted to Instagram`);
  console.log(`  Media ID: ${mediaId}`);
  console.log(`  Progress: ${state.posted.length}/${manifest.posts.length} published this week`);
  console.log(`  Remaining: ${manifest.posts.length - state.posted.length}`);
  console.log(`  Elapsed: ${elapsed}s`);
  console.log(`${"=".repeat(60)}`);
}

main().catch((err) => {
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
  process.exit(1);
});
