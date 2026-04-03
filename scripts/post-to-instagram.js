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
const GRAPH_API_VERSION = "v21.0";

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
 */
function graphRequest(method, urlPath, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}${urlPath}`);

    if (method === "GET" && params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }

    const body = method === "POST" ? JSON.stringify(params) : null;

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
          try {
            const parsed = JSON.parse(data);

            if (res.statusCode >= 500 && retries > 0) {
              console.log(
                `  Graph API ${res.statusCode} — retrying (${retries} left)…`
              );
              return setTimeout(() => attempt(retries - 1), 3000);
            }

            if (res.statusCode >= 400) {
              const errMsg =
                parsed.error?.message || data.slice(0, 500);
              return reject(
                new Error(
                  `Graph API error ${res.statusCode}: ${errMsg}`
                )
              );
            }

            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse Graph API response: ${e.message}`));
          }
        });
      });

      req.on("error", (err) => {
        if (retries > 0) {
          console.log(`  Network error — retrying (${retries} left)…`);
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
  console.log(`   Image URL: ${imageUrl}`);
  console.log(`   Caption length: ${caption.length} chars`);

  // Step 1 — Create media container
  console.log("\n   Step 1: Creating media container…");
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
  console.log("   Step 2: Publishing…");
  const result = await graphRequest("POST", `/${IG_USER_ID}/media_publish`, {
    creation_id: creationId,
    access_token: IG_ACCESS_TOKEN,
  });

  console.log(`   Published! Media ID: ${result.id}`);
  return result.id;
}

/**
 * Poll container status until it's FINISHED (or timeout after ~30 seconds).
 * Meta sometimes needs a few seconds to download and process the image.
 */
async function waitForContainer(containerId) {
  const maxAttempts = 10;
  const delayMs = 3000;

  for (let i = 0; i < maxAttempts; i++) {
    const status = await graphRequest("GET", `/${containerId}`, {
      fields: "status_code",
      access_token: IG_ACCESS_TOKEN,
    });

    if (status.status_code === "FINISHED") {
      console.log("   Container ready.");
      return;
    }

    if (status.status_code === "ERROR") {
      throw new Error(
        `Container processing failed: ${JSON.stringify(status)}`
      );
    }

    console.log(
      `   Container status: ${status.status_code || "PROCESSING"} — waiting ${delayMs / 1000}s…`
    );
    await new Promise((r) => setTimeout(r, delayMs));
  }

  // Proceed anyway — often works even if status hasn't flipped yet
  console.log("   Container status poll timed out — attempting publish anyway.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Comedy Houston — Instagram Auto-Poster ===\n");

  // Validate secrets
  if (!IG_ACCESS_TOKEN) {
    console.error("ERROR: INSTAGRAM_ACCESS_TOKEN not set.");
    process.exit(1);
  }
  if (!IG_USER_ID) {
    console.error("ERROR: INSTAGRAM_USER_ID not set.");
    process.exit(1);
  }

  // Load manifest
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.log("No manifest.json found — nothing to post. Exiting.");
    process.exit(0);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  if (!manifest.posts || manifest.posts.length === 0) {
    console.log("Manifest has no posts — nothing to post. Exiting.");
    process.exit(0);
  }

  console.log(
    `Manifest: ${manifest.posts.length} posts for "${manifest.week_range}"`
  );

  // Load state & determine next post
  const state = loadState();
  const nextPost = getNextToPost(manifest, state);

  if (!nextPost) {
    console.log("\nAll posts for this week have been published. Nothing to do.");
    process.exit(0);
  }

  console.log(
    `\nNext up: ${nextPost.comedianName} (${nextPost.slug})`
  );
  console.log(
    `Progress: ${state.posted.length}/${manifest.posts.length} posted so far`
  );

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

  console.log(
    `\nDone! ${state.posted.length}/${manifest.posts.length} posts published this week.`
  );
}

main().catch((err) => {
  console.error("\nFATAL:", err.message);
  process.exit(1);
});
