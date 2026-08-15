/**
 * Comedy Houston — Shared Meta Graph API helpers.
 *
 * Single source of truth for the Instagram/Facebook publishing plumbing used
 * by post-to-instagram.js (weekly comedian spotlights) and post-tonight.js
 * (daily "Tonight in Houston" lineup). Extracted verbatim from
 * post-to-instagram.js, which accreted these defenses against real, observed
 * Meta behaviors — see ARCHITECTURE.md "Posting reliability" before changing
 * anything here:
 *
 *   - graphRequest: Retry-After-aware 429/rate-limit handling (RATE_LIMITED
 *     sentinel errors), 5xx retry with capped backoff, error diagnosis logs.
 *   - waitForContainer: tolerates the May-2026 Meta quirk where container
 *     status GETs return code 100/subcode 33 on every call; falls through
 *     to publish after a fixed buffer.
 *   - publishWithRetry: absorbs code 9007 "media not ready" races.
 *   - shutdown(): destroys keep-alive sockets so the process actually exits
 *     (a leak here used to cancel the state-commit step and cause duplicate
 *     posts).
 *
 * Zero npm dependencies — uses only built-in Node modules.
 */

"use strict";

const https = require("https");

// ---------------------------------------------------------------------------
// Config (same env vars both posting scripts use)
// ---------------------------------------------------------------------------

const IG_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || "";
const IG_USER_ID = process.env.INSTAGRAM_USER_ID || "";
const GRAPH_API_VERSION = "v25.0";

// ---------------------------------------------------------------------------
// HTTP: graphRequest
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

    if ((method === "GET" || method === "DELETE") && params) {
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
                if (method === "DELETE") {
                  console.error(`\n  DIAGNOSIS: Token lacks permission to delete this object.`);
                  console.error(`  For IG media, deletion requires the instagram_manage_contents scope`);
                  console.error(`  (added to the Graph API Dec 2025 — tokens issued before then, or without`);
                  console.error(`  that scope granted, get this (#10)).`);
                  console.error(`  FIX: Regenerate the Page token with instagram_manage_contents granted`);
                  console.error(`  and update the INSTAGRAM_ACCESS_TOKEN GitHub secret.`);
                } else {
                  console.error(`\n  DIAGNOSIS: App does not have permission to publish.`);
                  console.error(`  FIX: Ensure instagram_content_publish permission is granted and the app has access to the Page.`);
                }
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
// Image URL verification
// ---------------------------------------------------------------------------

/**
 * HEAD-request an image URL to verify it's publicly accessible.
 *
 * 15s cap — GitHub Pages CDN normally answers HEAD in <1s. Anything longer
 * is a stalled socket; without this, a hung CDN would burn the per-channel
 * timeout and block the whole posting run.
 */
const VERIFY_IMAGE_TIMEOUT_MS = 15_000;

function verifyImageUrl(imageUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(imageUrl);
    const req = https.request(
      // path must include the query string: the weekly-roundup hero appends
      // ?v=<date> as a CDN cache-buster, and verifying only the bare path can
      // hit a stale cached 200 while the ?v= variant Meta will actually fetch
      // hasn't propagated yet.
      { hostname: url.hostname, path: url.pathname + url.search, method: "HEAD" },
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
              `   FIX: Make sure the branch is merged to main and the file has been pushed/deployed.`
            )
          );
        }
      }
    );
    req.setTimeout(VERIFY_IMAGE_TIMEOUT_MS, () => {
      req.destroy(
        new Error(`verifyImageUrl timed out after ${VERIFY_IMAGE_TIMEOUT_MS}ms: ${imageUrl}`)
      );
    });
    req.on("error", (err) => {
      reject(new Error(`Cannot reach image URL: ${err.message}`));
    });
    req.end();
  });
}

/**
 * Poll an image URL until it's reachable (or attempts run out). Used by
 * workflows that commit an image and post it in the same run — the push
 * has to propagate to the CDN before Meta can fetch it.
 */
async function waitForImageUrl(imageUrl, attempts = 10, delayMs = 10_000) {
  for (let i = 0; i < attempts; i++) {
    try {
      await verifyImageUrl(imageUrl);
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      console.log(
        `   Image not reachable yet (attempt ${i + 1}/${attempts}) — waiting ${Math.round(delayMs / 1000)}s…`
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// ---------------------------------------------------------------------------
// Container status polling + publish retry
// ---------------------------------------------------------------------------

/**
 * Detect Meta rejecting a container-status GET with GraphMethodException
 * code 100 / subcode 33 ("Authorization Error" / "does not exist" / "cannot be
 * loaded" / "Unsupported get request").
 *
 * IMPORTANT: this is NOT a transient read-after-write race (an earlier theory).
 * Between 2026-05-18 and 2026-05-26 Meta changed behavior so that
 * `GET /{ig-container-id}` — for BOTH single-image, carousel child, AND carousel
 * parent containers — returns this error on every attempt, even though the
 * create call returned 200 and the token can still read the IG account, the
 * Page, and debug_token. Container status reads are simply unavailable right
 * now. We can't poll for FINISHED, so we fall through to publish and let
 * publishWithRetry() absorb any "media not ready" (9007) along the way.
 */
function isContainerNotReadable(err) {
  if (!err || typeof err.message !== "string") return false;
  const m = err.message;
  return (
    /code 100\b/.test(m) &&
    /Authorization Error|does not exist|cannot be loaded|Unsupported get request/i.test(m)
  );
}

/**
 * Poll container status until FINISHED (max ~30 seconds). If Meta refuses to
 * serve container status (code 100/33 — see isContainerNotReadable), stop
 * polling after a few attempts, wait a fixed buffer, and return so the caller
 * can publish anyway (publishWithRetry handles "media not ready").
 */
async function waitForContainer(containerId) {
  const maxAttempts = 10;
  const delayMs = 3000;
  const maxNotReadable = 3;
  const fallthroughBufferMs = 12000;
  let notReadableCount = 0;

  console.log(`   Waiting for container ${containerId} to finish processing…`);

  for (let i = 0; i < maxAttempts; i++) {
    let status;
    try {
      // Query only status_code — the `status` detail field is dropped in case
      // Meta is rejecting the read because of that field specifically.
      status = await graphRequest("GET", `/${containerId}`, {
        fields: "status_code",
        access_token: IG_ACCESS_TOKEN,
      });
    } catch (err) {
      if (isContainerNotReadable(err)) {
        notReadableCount++;
        if (notReadableCount >= maxNotReadable) {
          console.log(
            `   Container status reads are being rejected by Meta (code 100/33) ` +
            `after ${notReadableCount} attempts — the status endpoint is ` +
            `unavailable for this container. Skipping the poll and proceeding ` +
            `to publish; the publish step retries on "media not ready".`
          );
          console.log(
            `   Waiting ${fallthroughBufferMs / 1000}s for processing before publish…`
          );
          await new Promise((r) => setTimeout(r, fallthroughBufferMs));
          return;
        }
        console.log(
          `   Poll ${i + 1}/${maxAttempts}: status not readable ` +
          `(${err.message.split("\n")[0]}) — retrying in ${delayMs}ms…`
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }

    const code = status.status_code || "UNKNOWN";
    console.log(`   Poll ${i + 1}/${maxAttempts}: status=${code}`);

    if (code === "FINISHED") {
      console.log("   Container ready for publishing.");
      return;
    }

    if (code === "ERROR") {
      console.error(`   Container processing FAILED (status_code=ERROR).`);
      throw new Error(
        `Container processing failed (status_code: ERROR). Ensure the PNG is committed ` +
        `to main and publicly reachable.`
      );
    }

    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.log("   WARNING: Container poll timed out after 30s — attempting publish anyway.");
}

/**
 * Publish a finished container with retry on 9007 / "not ready".
 *
 * Meta's container poll occasionally reports FINISHED before the publish
 * endpoint has caught up, especially for carousels and stories. The IG
 * publish call then returns code 9007 / subcode 2207027 / "The media is
 * not ready for publishing, please wait for a moment". This is transient
 * even though Meta annotates it `is_transient: false`.
 */
async function publishWithRetry(creationId, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await graphRequest("POST", `/${IG_USER_ID}/media_publish`, {
        creation_id: creationId,
        access_token: IG_ACCESS_TOKEN,
      });
    } catch (err) {
      const m = err.message || "";
      const isNotReady =
        /code 9007\b/.test(m) ||
        /2207027/.test(m) ||
        /not ready/i.test(m) ||
        /Media ID is not available/i.test(m);
      if (isNotReady && attempt < 2) {
        const waitSec = (attempt + 1) * 5;
        console.log(
          `   ${label} not ready yet — waiting ${waitSec}s before retry ${attempt + 2}/3…`
        );
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// user_tags error detection
// ---------------------------------------------------------------------------

/**
 * Detect Meta Graph API errors caused by an unusable user_tag handle —
 * private account, invalid username, deleted user, ineligible-for-tagging.
 *
 * Observed signatures from real failures:
 *   code 110 / subcode 2207018 / "Invalid user id" /
 *     "Cannot load user with a private account or invalid username"
 *   code 100 / subcode 2207039 / "user is not allowed to be tagged"
 *   code 100 / "user_tags" malformed
 */
function isUserTagError(err) {
  if (!err || typeof err.message !== "string") return false;
  const m = err.message;
  if (/code 110\b/.test(m) && /Invalid user id/i.test(m)) return true;
  if (/2207018|2207039|2207065/.test(m)) return true;
  if (/Cannot load user/i.test(m)) return true;
  if (/user is not allowed to be tagged/i.test(m)) return true;
  if (/user_tags?\b/i.test(m) && /code (100|110)\b/.test(m)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Per-channel timeout wrapper
// ---------------------------------------------------------------------------

function withTimeout(promise, label, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Facebook Page ID resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Facebook Page ID from the Page Access Token (no extra secret
 * needed). Returns the Page ID string, or "" if resolution fails — in which
 * case FB posting should be skipped while IG posting continues.
 */
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
      console.log(`  Facebook Page: "${me.name || "(unnamed)"}" (ID: ${me.id})`);
      return me.id;
    }
    console.error("  ERROR: /me returned no id — token does not resolve to a Facebook Page.");
    console.error("  ACTION: Ensure INSTAGRAM_ACCESS_TOKEN is a Page Access Token (not a User token).");
    console.error("  Facebook posting will be UNAVAILABLE this run; IG posting will continue.");
  } catch (err) {
    console.error(`  ERROR: Could not resolve Facebook Page ID — ${err.message}`);
    console.error("  ACTION: Regenerate a long-lived Page Access Token and update INSTAGRAM_ACCESS_TOKEN.");
    console.error("  Facebook posting will be UNAVAILABLE this run; IG posting will continue.");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Token validation + expiry guards
// ---------------------------------------------------------------------------

/**
 * Validate secrets + token, then run the two expiry early-warning clocks.
 * process.exit()s with a loud diagnosis on hard failures — identical
 * behavior to the original inline block in post-to-instagram.js:
 *
 *   - expires_at < 7 days   → exit 1 (fires the notify-on-failure email
 *     BEFORE the token dies; this run's post is sacrificed on purpose)
 *   - data_access_expires_at < 7 days → exit 1 (same trade — see
 *     ARCHITECTURE.md "Access token model" for the 90-day window)
 *   - 7–14 days on either clock → warn but continue
 */
async function validateTokenAndGuards() {
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
    console.error("FIX: Your access token may be expired or invalid.");
    console.error("     Generate a new one via Graph API Explorer and update the GitHub secret.");
    process.exit(1);
  }

  try {
    const debug = await graphRequest("GET", "/debug_token", {
      input_token: IG_ACCESS_TOKEN,
      access_token: IG_ACCESS_TOKEN,
    });
    const data = debug && debug.data;
    const expiresAt = data && data.expires_at; // unix seconds; 0 = never expires
    if (expiresAt && expiresAt > 0) {
      const daysLeft = Math.floor((expiresAt * 1000 - Date.now()) / 86400000);
      const expiryDate = new Date(expiresAt * 1000).toISOString().slice(0, 10);
      console.log(`  Token expires: ${expiryDate} (${daysLeft} days remaining)`);
      if (daysLeft < 7) {
        console.error(`\n╔════════════════════════════════════════════════════════════╗`);
        console.error(`║  TOKEN EXPIRES IN ${daysLeft} DAYS — REFRESH IMMEDIATELY        `);
        console.error(`╠════════════════════════════════════════════════════════════╣`);
        console.error(`║  1. Open https://developers.facebook.com/tools/explorer    ║`);
        console.error(`║  2. Select your app, generate a long-lived Page token      ║`);
        console.error(`║  3. Update the INSTAGRAM_ACCESS_TOKEN GitHub secret        ║`);
        console.error(`║  4. Re-run this workflow                                   ║`);
        console.error(`╚════════════════════════════════════════════════════════════╝`);
        process.exit(1);
      } else if (daysLeft < 14) {
        console.warn(`  ⚠ WARNING: Token expires in ${daysLeft} days — refresh soon to avoid outage.`);
      }
    } else {
      console.log("  Token has no expiry (or never-expires user token).");
    }

    // Second clock: the data-access window. A non-expiring PAGE token
    // (expires_at: 0) still carries a ~90-day `data_access_expires_at` (Meta's
    // data-use / inactivity policy — see ARCHITECTURE.md "Access token model").
    // When it lapses, data-touching calls start failing even though expires_at
    // is still 0 — the one silent outage this token model is otherwise immune
    // to, and nothing else watches the date.
    const dataAccessAt = data && data.data_access_expires_at; // unix seconds; 0 = no window
    if (dataAccessAt && dataAccessAt > 0) {
      const daysLeft = Math.floor((dataAccessAt * 1000 - Date.now()) / 86400000);
      const windowEnd = new Date(dataAccessAt * 1000).toISOString().slice(0, 10);
      console.log(`  Data-access window ends: ${windowEnd} (${daysLeft} days remaining)`);
      if (daysLeft < 7) {
        console.error(`\n╔════════════════════════════════════════════════════════════╗`);
        console.error(`║  DATA-ACCESS WINDOW ENDS IN ${daysLeft} DAYS — REFRESH TOKEN     `);
        console.error(`╠════════════════════════════════════════════════════════════╣`);
        console.error(`║  The token never "expires" (expires_at: 0) but its 90-day  ║`);
        console.error(`║  data-access window is closing. When it lapses, posting    ║`);
        console.error(`║  silently fails. Re-derive the Page token:                 ║`);
        console.error(`║  1. Graph Explorer → long-lived USER token                 ║`);
        console.error(`║  2. GET /me/accounts with it → copy the PAGE access_token  ║`);
        console.error(`║  3. Update the INSTAGRAM_ACCESS_TOKEN GitHub secret        ║`);
        console.error(`║  4. Re-run this workflow                                   ║`);
        console.error(`╚════════════════════════════════════════════════════════════╝`);
        process.exit(1);
      } else if (daysLeft < 14) {
        console.warn(`  ⚠ WARNING: Data-access window ends in ${daysLeft} days — re-derive the Page token soon.`);
      }
    }
  } catch (err) {
    // Don't fail the run on debug_token errors — the validation call above
    // already proved the token works for the actual API surface we use.
    console.warn(`  Could not check token expiry (non-fatal): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Simple single-image channel primitives (no user_tags / carousel logic —
// those stay in post-to-instagram.js where the comedian-specific handling
// lives). Used by post-tonight.js.
// ---------------------------------------------------------------------------

/**
 * Create a media container, degrading the tag list rather than losing the
 * post — or the good tags — when Meta rejects one.
 *
 * `userTags` is PRIORITY ORDERED. On a user-tag rejection the LAST tag is
 * dropped and the call retried, down to no tags at all. Meta doesn't say
 * WHICH handle it objected to, so dropping the whole list (the old
 * behaviour) meant one stale venue handle silently cost the comedian tag —
 * the valuable one. Callers put the most important tag first.
 */
async function createTaggedContainer(params, userTags = []) {
  let tags = (userTags || []).filter(Boolean);
  for (;;) {
    const attempt = { ...params };
    if (tags.length > 0) {
      attempt.user_tags = JSON.stringify(tags);
    } else {
      delete attempt.user_tags;
    }
    try {
      return await graphRequest("POST", `/${IG_USER_ID}/media`, attempt);
    } catch (err) {
      if (tags.length === 0 || !isUserTagError(err)) throw err;
      const dropped = tags[tags.length - 1];
      tags = tags.slice(0, -1);
      console.warn(
        `   ⚠ Meta rejected the tag set (${err.message.split("\n")[0]}). ` +
        `Meta doesn't reliably say WHICH handle it objected to, so dropping ` +
        `the lowest-priority one (@${dropped.username}) and retrying with ` +
        `${tags.length} tag(s).`
      );
    }
  }
}

async function postIgFeedImage(imageUrl, caption, userTags = []) {
  console.log("   Creating media container…");
  if (userTags.length > 0) {
    console.log(`   Tagging: ${userTags.map((t) => "@" + t.username).join(", ")}`);
  }
  const container = await createTaggedContainer({
    image_url: imageUrl,
    caption,
    access_token: IG_ACCESS_TOKEN,
  }, userTags);
  console.log(`   Container: ${container.id}`);
  await waitForContainer(container.id);
  console.log("   Publishing…");
  const result = await publishWithRetry(container.id, "IG Feed");
  console.log(`   IG Feed posted! Media ID: ${result.id}`);
  return result.id;
}

async function postIgStoryImage(imageUrl) {
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
  console.log("   Publishing story…");
  const result = await publishWithRetry(container.id, "Story");
  console.log(`   IG Story posted! Media ID: ${result.id}`);
  return result.id;
}

async function postFbFeedPhoto(pageId, imageUrl, caption) {
  console.log("   Posting photo to Facebook Page…");
  const result = await graphRequest("POST", `/${pageId}/photos`, {
    url: imageUrl,
    message: caption,
    published: true,
    access_token: IG_ACCESS_TOKEN,
  });
  console.log(`   FB Feed posted! Post ID: ${result.id || result.post_id}`);
  return result.id || result.post_id;
}

async function postFbStoryPhoto(pageId, imageUrl) {
  console.log("   Uploading unpublished photo…");
  const photo = await graphRequest("POST", `/${pageId}/photos`, {
    url: imageUrl,
    published: false,
    access_token: IG_ACCESS_TOKEN,
  });
  console.log(`   Photo ID: ${photo.id}`);
  console.log("   Creating Facebook story…");
  const story = await graphRequest("POST", `/${pageId}/photo_stories`, {
    photo_id: photo.id,
    access_token: IG_ACCESS_TOKEN,
  });
  console.log(`   FB Story posted! Story ID: ${story.id || story.post_id}`);
  return story.id || story.post_id;
}

// ---------------------------------------------------------------------------
// Object deletion (used by delete-tonight-posts.js)
// ---------------------------------------------------------------------------

/**
 * Detect "the object is already gone" errors on a DELETE — the object was
 * deleted manually, expired (stories), or never existed. Deliberately
 * NARROWER than isContainerNotReadable: a bare "Authorization Error" on a
 * delete is a REAL failure (token/permission problem), not already-gone,
 * and must stay in state for retry.
 */
function isObjectGoneError(err) {
  if (!err || typeof err.message !== "string") return false;
  const m = err.message;
  if (/Graph API error 404\b/.test(m)) return true;
  return (
    /code 100\b/.test(m) &&
    /subcode 33\b|does not exist|cannot be loaded|Unsupported (get|delete) request|No node specified/i.test(m)
  );
}

/**
 * Detect Meta's OAuthException code 10 — "(#10) Insufficient permissions".
 * On DELETE /{ig-media-id} the usual cause is a token missing the
 * instagram_manage_contents scope: Meta added IG media deletion to the API
 * in Dec 2025 behind that permission, so tokens issued before then (or
 * generated without the scope) get (#10) on every media delete. The earlier
 * "no permission fixes it" conclusion (verified 2026-07-21) predates the
 * scope being grantable for this app. delete-tonight-posts.js uses
 * tokenHasManageContents() to decide whether a (#10) is fixable (missing
 * scope → keep for retry + alert) or genuinely refused (scope present →
 * prune rather than stay red forever).
 */
function isPermissionError(err) {
  return !!err && typeof err.message === "string" && /\(code 10\):/.test(err.message);
}

/**
 * Whether the stored token carries the instagram_manage_contents scope
 * (required for DELETE /{ig-media-id} since Dec 2025). Checks both the flat
 * `scopes` list and `granular_scopes` — page-token debug output has been
 * observed using either. Returns true/false, or null when debug_token
 * itself fails (callers should treat null as "unknown", not "missing").
 */
async function tokenHasManageContents() {
  try {
    const debug = await graphRequest("GET", "/debug_token", {
      input_token: IG_ACCESS_TOKEN,
      access_token: IG_ACCESS_TOKEN,
    });
    const data = (debug && debug.data) || {};
    const flat = Array.isArray(data.scopes) ? data.scopes : [];
    const granular = Array.isArray(data.granular_scopes)
      ? data.granular_scopes.map((s) => s && s.scope).filter(Boolean)
      : [];
    return flat.includes("instagram_manage_contents") ||
      granular.includes("instagram_manage_contents");
  } catch (err) {
    console.warn(`  Could not read token scopes (non-fatal): ${err.message.split("\n")[0]}`);
    return null;
  }
}

/**
 * DELETE a Graph API object (IG media, FB post/photo) by ID.
 * Returns "deleted" on success, "already_gone" if the object no longer
 * exists. Rethrows everything else (including RATE_LIMITED sentinels).
 * DELETE is idempotent, so graphRequest's 5xx retry loop is safe here.
 */
async function deleteGraphObject(objectId, label) {
  try {
    await graphRequest("DELETE", `/${objectId}`, {
      access_token: IG_ACCESS_TOKEN,
    });
    console.log(`   ${label} deleted (ID: ${objectId})`);
    return "deleted";
  } catch (err) {
    if (isObjectGoneError(err)) {
      console.log(`   ${label} already gone (ID: ${objectId}) — treating as deleted.`);
      return "already_gone";
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shared exit path
// ---------------------------------------------------------------------------

/**
 * Without this the process has been observed to hang for over an hour after
 * main() completes — lingering HTTP/1.1 keep-alive sockets to
 * graph.facebook.com (and/or any other unref'd handle) keep the event loop
 * alive, GitHub Actions eventually cancels the step, the state-commit step
 * never runs, and the next scheduled run reposts the same content. Destroy
 * the agent, give Node a tick to tear down sockets, then exit. Use for BOTH
 * success and error paths so state is never left uncommitted because of a
 * keep-alive leak on the error branch.
 */
function shutdown(code) {
  // The timer below is unref'd, so if the event loop drains before it fires
  // (e.g. an error thrown before any socket was opened) Node exits naturally
  // — exitCode makes sure that path still reports the right status instead
  // of a silent 0.
  process.exitCode = code;
  try { https.globalAgent.destroy(); } catch {}
  // Unref any remaining handles and give destroy() a beat to complete.
  setTimeout(() => process.exit(code), 150).unref();
}

module.exports = {
  IG_ACCESS_TOKEN,
  IG_USER_ID,
  GRAPH_API_VERSION,
  graphRequest,
  verifyImageUrl,
  waitForImageUrl,
  isContainerNotReadable,
  waitForContainer,
  publishWithRetry,
  isUserTagError,
  withTimeout,
  resolveFacebookPageId,
  validateTokenAndGuards,
  createTaggedContainer,
  postIgFeedImage,
  postIgStoryImage,
  postFbFeedPhoto,
  postFbStoryPhoto,
  isObjectGoneError,
  isPermissionError,
  tokenHasManageContents,
  deleteGraphObject,
  shutdown,
};
