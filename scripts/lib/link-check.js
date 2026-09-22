/**
 * Outbound link verification for LLM-written posts.
 *
 * The writer is told to cite only URLs from the research, but it invents
 * them anyway now and then: the Martin Amini spotlight (2026-09-01) shipped
 * with youtube.com/watch?v=xyz123. The fact-check pass "preserves all
 * hyperlinks that link to real source URLs" without any way to know which
 * are real. This module actually asks the web.
 *
 * For each external <a href="http(s)://..."> in the body:
 *   - youtube.com / youtu.be: ask the oEmbed endpoint. A watch URL for a
 *     video that does not exist still returns a 200 HTML page, so a plain
 *     GET proves nothing; oEmbed returns 400/401/404 for a bad video id.
 *   - everything else: GET with a browser-ish User-Agent, follow up to 5
 *     redirects, read at most a few KB. 2xx/3xx = alive.
 *
 * Verdicts: "ok", "dead" (404/410, or oEmbed rejects the id), "unknown"
 * (403/429/5xx/timeout/network: the site is blocking bots or is down, which
 * says nothing about whether the URL is real). Only "dead" links are acted
 * on: the anchor is unwrapped so the sentence keeps its text and loses the
 * citation. Nothing is removed on ambiguity.
 *
 * Skipped: comedyhouston.com internal links, mailto:/tel:, and ticket links
 * (class ticket-link or a known ticket host), which come from our own
 * listings and often sit behind bot walls that answer 403 to a script.
 */

const https = require("https");
const http = require("http");

const TICKET_HOST_RE = /(?:ticketmaster|livenation|eventbrite|ticketweb|axs|frontgatetickets|standuptix|donttellcomedy|showclix|seetickets|etix|tixr|dice\.fm)\./i;
const INTERNAL_RE = /^https?:\/\/(?:www\.)?comedyhouston\.com(?:\/|$)/i;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ComedyHoustonLinkCheck/1.0";

function fetchStatus(url, { timeoutMs = 10000, redirects = 5 } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ status: 0, error: "bad url" }); }
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { "User-Agent": UA, Accept: "text/html,application/json;q=0.9,*/*;q=0.8", Range: "bytes=0-4095" },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects > 0) {
          res.resume();
          let next;
          try { next = new URL(res.headers.location, url).toString(); } catch { return resolve({ status, error: "bad redirect" }); }
          return resolve(fetchStatus(next, { timeoutMs, redirects: redirects - 1 }));
        }
        let body = "";
        res.on("data", (c) => { if (body.length < 8192) body += c; });
        res.on("end", () => resolve({ status, body }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ status: 0, error: err.message }));
    req.end();
  });
}

function youtubeId(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)youtu\.be$/i.test(u.hostname)) return u.pathname.slice(1).split("/")[0] || null;
    if (/(^|\.)youtube\.com$/i.test(u.hostname)) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/);
      if (m) return m[1];
      return "channel-or-page";
    }
  } catch { /* fall through */ }
  return null;
}

/** Classify one URL: { verdict: "ok" | "dead" | "unknown", status, note }. */
async function checkUrl(url, opts = {}) {
  const yt = youtubeId(url);
  if (yt && yt !== "channel-or-page") {
    const r = await fetchStatus(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${yt}`)}&format=json`, opts);
    if (r.status >= 200 && r.status < 300) return { verdict: "ok", status: r.status, note: "youtube oembed" };
    if ([400, 401, 403, 404].includes(r.status)) return { verdict: "dead", status: r.status, note: "youtube oembed rejects video id" };
    return { verdict: "unknown", status: r.status, note: r.error || "youtube oembed inconclusive" };
  }
  const r = await fetchStatus(url, opts);
  if (r.status >= 200 && r.status < 400) return { verdict: "ok", status: r.status };
  if (r.status === 404 || r.status === 410) return { verdict: "dead", status: r.status };
  return { verdict: "unknown", status: r.status, note: r.error || "" };
}

function shouldCheck(anchorTag, href) {
  if (!/^https?:\/\//i.test(href)) return false;
  if (INTERNAL_RE.test(href)) return false;
  if (/class\s*=\s*"[^"]*\bticket-link\b[^"]*"/i.test(anchorTag)) return false;
  if (TICKET_HOST_RE.test(href)) return false;
  return true;
}

/**
 * Verify every external link in `html`; unwrap the dead ones.
 * Returns { html, checked: [{href, verdict, status, note}], removed: [href] }.
 */
async function verifyOutboundLinks(html, opts = {}) {
  const src = String(html || "");
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const found = [];
  let m;
  while ((m = anchorRe.exec(src))) {
    const href = (m[1].match(/href\s*=\s*"([^"]*)"/i) || [])[1];
    if (href && shouldCheck(m[0], href)) found.push(href);
  }
  const unique = [...new Set(found)];
  const results = new Map();
  const concurrency = opts.concurrency || 4;
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
      while (i < unique.length) {
        const href = unique[i++];
        results.set(href, await checkUrl(href, opts));
      }
    })
  );
  const removed = [];
  const out = src.replace(anchorRe, (whole, attrs, inner) => {
    const href = (attrs.match(/href\s*=\s*"([^"]*)"/i) || [])[1];
    const r = href && results.get(href);
    if (r && r.verdict === "dead") {
      removed.push(href);
      return inner;
    }
    return whole;
  });
  const checked = unique.map((href) => ({ href, ...results.get(href) }));
  return { html: out, checked, removed };
}

module.exports = { verifyOutboundLinks, checkUrl, youtubeId };
