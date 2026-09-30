/**
 * Comedy Houston — shared WordPress REST client (zero dependencies).
 *
 * Replaces the five hand-rolled `wpRequest` copies that used to live in
 * generate-blog-post.js, generate-comedian-post.js, backfill-show-details.js,
 * delete-comedian-blog-posts.js and manage-wp-pages.js (2026-09-30).
 *
 *   const { createWpClient, withRetry, isRetryableWpError } = require("./lib/wp");
 *   const wp = createWpClient({ userAgent: "ComedyHouston-BlogBot/1.0" });
 *   const me = await wp.request("GET", "/wp-json/wp/v2/users/me?context=edit");
 *
 * Behaviour (superset of the old copies):
 *   - Credentials default to WP_SITE_URL / WP_APP_USER / WP_APP_PASSWORD.
 *     Without a user+password the request goes out unauthenticated (public
 *     GETs still work; `wp.hasCreds` tells the caller which mode it is in).
 *   - Every request has a hard timeout (default 30s) that destroys the socket
 *     and rejects with "... timed out after Nms" so a stalled host cannot hang
 *     a workflow.
 *   - Non-2xx responses reject with an Error whose message is
 *     "WordPress API <status> <METHOD> <path> | headers={...} | body=<first 1500 chars>"
 *     and whose `.statusCode` is set. The header subset tells a WAF/bot
 *     challenge page (403 HTML, no JSON code) apart from a real API error.
 *   - 2xx bodies are JSON-parsed; an empty body resolves to null; a non-JSON
 *     2xx body rejects ("Failed to parse WP response") because that is almost
 *     always a cache/WAF page, not a result.
 *   - No retries here. Retrying a write after a timeout can double-post, so
 *     the caller decides: wrap calls in `withRetry` when the operation is safe
 *     to repeat (slug-deduped publishes, idempotent PATCHes, reads).
 */

"use strict";

const http = require("http");
const https = require("https");

const DEFAULT_TIMEOUT_MS = 30_000;

function createWpClient(opts = {}) {
  const siteUrl = String(opts.siteUrl ?? process.env.WP_SITE_URL ?? "").replace(/\/+$/, "");
  const user = opts.user ?? process.env.WP_APP_USER ?? "";
  const password = opts.password ?? process.env.WP_APP_PASSWORD ?? "";
  const userAgent = opts.userAgent || "ComedyHouston-WpClient/1.0";
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const hasCreds = !!(user && password);
  const authHeader = hasCreds ? "Basic " + Buffer.from(`${user}:${password}`).toString("base64") : null;

  function request(method, urlPath, body = null, reqOpts = {}) {
    return new Promise((resolve, reject) => {
      if (!siteUrl) return reject(new Error("WP_SITE_URL is not set"));
      let parsed;
      try {
        parsed = new URL(siteUrl + urlPath);
      } catch (e) {
        return reject(new Error(`Bad WP URL ${siteUrl}${urlPath}: ${e.message}`));
      }
      const isHttps = parsed.protocol === "https:";
      const lib = isHttps ? https : http;
      const bodyStr = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
      const headers = {
        "Content-Type": reqOpts.contentType || "application/json",
        Accept: "application/json",
        "User-Agent": userAgent,
      };
      if (authHeader) headers.Authorization = authHeader;
      if (bodyStr != null) headers["Content-Length"] = Buffer.byteLength(bodyStr);
      const label = `WP ${method} ${urlPath}`;
      const ms = reqOpts.timeoutMs || timeoutMs;

      const req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method,
          headers,
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const relevantHeaders = {
                "content-type": res.headers["content-type"],
                "www-authenticate": res.headers["www-authenticate"],
                "x-litespeed-cache": res.headers["x-litespeed-cache"],
                "cf-ray": res.headers["cf-ray"],
                server: res.headers["server"],
              };
              const err = new Error(
                `WordPress API ${res.statusCode} ${method} ${urlPath} | ` +
                  `headers=${JSON.stringify(relevantHeaders)} | body=${data.slice(0, 1500)}`
              );
              err.statusCode = res.statusCode;
              err.body = data;
              return reject(err);
            }
            if (!data.trim()) return resolve(null);
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Failed to parse WP response for ${label}: ${e.message} | body=${data.slice(0, 200)}`));
            }
          });
        }
      );
      req.setTimeout(ms, () => req.destroy(new Error(`${label} timed out after ${ms}ms`)));
      req.on("error", (err) => reject(err));
      if (bodyStr != null) req.write(bodyStr);
      req.end();
    });
  }

  return { request, siteUrl, hasCreds, userAgent, timeoutMs };
}

/**
 * Decide whether a failed WP call is worth retrying: WAF 403s, 408/429, 5xx,
 * and network-level errors (timeouts, resets, DNS) that carry no statusCode.
 * Never retry 400/401/404 or a "cumulative WP budget" abort.
 */
function isRetryableWpError(err) {
  const code = err && err.statusCode;
  if (code === 403 || code === 408 || code === 429) return true;
  if (typeof code === "number" && code >= 500 && code <= 599) return true;
  if (!code) {
    const m = (err && err.message) || "";
    if (/cumulative WP budget/i.test(m)) return false;
    if (/timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|socket hang up|network/i.test(m)) {
      return true;
    }
  }
  return false;
}

/**
 * Run an operation with exponential backoff on transient errors.
 *   withRetry(label, fn, { maxAttempts: 4, baseMs: 2000, shouldStop: () => bool })
 * `shouldStop` is consulted before each retry (used for the blog script's
 * cumulative time budget). Non-transient errors throw immediately.
 */
async function withRetry(label, fn, opts = {}) {
  const maxAttempts = Math.max(1, opts.maxAttempts || parseInt(process.env.WP_MAX_ATTEMPTS || "4", 10));
  const baseMs = opts.baseMs || parseInt(process.env.WP_RETRY_BASE_MS || "2000", 10);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryableWpError(err)) throw err;
      if (opts.shouldStop && opts.shouldStop()) {
        console.warn(`  ${label}: not retrying (${opts.stopReason || "caller asked to stop"}).`);
        throw err;
      }
      const delay = baseMs * Math.pow(2, attempt - 1); // 2s, 4s, 8s…
      const firstLine = String(err.message || err).split("\n")[0].slice(0, 140);
      console.warn(`  ${label} failed (${firstLine}) — retry ${attempt}/${maxAttempts - 1} in ${Math.round(delay / 1000)}s…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = { createWpClient, withRetry, isRetryableWpError, DEFAULT_TIMEOUT_MS };
