#!/usr/bin/env node
/**
 * Backfill the show-details sentence into spotlight posts already live on
 * WordPress. Reads every blog/comedians/manifest-*.json, keeps posts whose
 * show date has not passed, fetches each post's raw content, and inserts
 * "<Name> plays <Venue> on <Date>. Get Tickets." before the footer when the
 * body lacks the date or a ticket link (see scripts/lib/show-details.js).
 * Posts that already carry both are left untouched. No OpenAI calls.
 *
 * Env:
 *   WP_SITE_URL, WP_APP_USER, WP_APP_PASSWORD   WordPress app password auth
 *   DRY_RUN=1        report only, write nothing (also the default when no
 *                    credentials are set: reads the public rendered content)
 *   SLUGS=a,b,c      limit to these slugs
 *   INCLUDE_PAST=1   also touch posts whose show already happened
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { ensureShowDetails, hasShowDate, hasTicketLink } = require("./lib/show-details");

const ROOT = path.join(__dirname, "..");
const COMEDIANS_DIR = path.join(ROOT, "blog", "comedians");
const WP_SITE_URL = (process.env.WP_SITE_URL || "https://comedyhouston.com").replace(/\/+$/, "");
const WP_APP_USER = process.env.WP_APP_USER || "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";
const HAS_CREDS = !!(WP_APP_USER && WP_APP_PASSWORD);
const DRY_RUN = process.env.DRY_RUN === "1" || !HAS_CREDS;
const ONLY = (process.env.SLUGS || "").split(",").map((s) => s.trim()).filter(Boolean);
const INCLUDE_PAST = process.env.INCLUDE_PAST === "1";

function wpRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(WP_SITE_URL + urlPath);
    const lib = parsed.protocol === "https:" ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "ComedyHouston-BackfillShowDetails/1.0",
    };
    if (HAS_CREDS) {
      headers.Authorization = "Basic " + Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString("base64");
    }
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);
    const req = lib.request(
      { hostname: parsed.hostname, port: parsed.port || undefined, path: parsed.pathname + parsed.search, method, headers, timeout: 30000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Bad JSON from ${urlPath}: ${data.slice(0, 120)}`)); }
          } else {
            reject(new Error(`WordPress API ${res.statusCode} ${method} ${urlPath} | ${data.slice(0, 160).replace(/\s+/g, " ")}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`timeout ${method} ${urlPath}`)));
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function todayChicago() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function loadCandidates() {
  const today = todayChicago();
  const seen = new Set();
  const out = [];
  for (const f of fs.readdirSync(COMEDIANS_DIR).filter((n) => /^manifest-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort()) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(COMEDIANS_DIR, f), "utf8")); } catch { continue; }
    for (const p of m.posts || []) {
      if (!p.slug || seen.has(p.slug)) continue;
      if (!p.wpLink) continue;
      if (!INCLUDE_PAST && p.date < today) continue;
      if (ONLY.length && !ONLY.includes(p.slug)) continue;
      seen.add(p.slug);
      out.push({ slug: p.slug, comedianName: p.comedianName, venue: p.venue, date: p.date, ticketUrl: p.ticketUrl || "", wpLink: p.wpLink, manifest: f });
    }
  }
  return out;
}

async function main() {
  console.log("=== Comedy Houston — Backfill show details into live spotlight posts ===");
  console.log(`Site: ${WP_SITE_URL} | mode: ${DRY_RUN ? "DRY RUN (no writes)" : "WRITE"}${HAS_CREDS ? "" : " | no credentials: reading public rendered content"}`);
  const candidates = loadCandidates();
  console.log(`Candidates: ${candidates.length} post(s) with a future show date\n`);

  let updated = 0, skipped = 0, failed = 0;
  for (const c of candidates) {
    try {
      // The status filter and context=edit both need auth; anonymous reads
      // get the public published post only.
      const q = `/wp-json/wp/v2/posts?slug=${encodeURIComponent(c.slug)}` + (HAS_CREDS ? "&status=publish,future,draft,private&context=edit" : "");
      const found = await wpRequest("GET", q, null);
      const post = Array.isArray(found) ? found[0] : null;
      if (!post) { console.log(`  ${c.slug}: NOT FOUND on WordPress`); failed++; continue; }
      const html = HAS_CREDS ? (post.content && post.content.raw) : (post.content && post.content.rendered);
      if (typeof html !== "string" || !html) { console.log(`  ${c.slug}: no content returned`); failed++; continue; }

      const res = ensureShowDetails(html, c);
      const status = `date ${res.dateMissing ? "MISSING" : "ok"}, ticket link ${res.ticketMissing ? "MISSING" : "ok"}`;
      if (!res.inserted) { console.log(`  ${c.slug}: leave (${status})`); skipped++; continue; }

      if (DRY_RUN) {
        console.log(`  ${c.slug}: WOULD INSERT (${status})`);
        updated++;
        continue;
      }
      await wpRequest("POST", `/wp-json/wp/v2/posts/${post.id}`, { content: res.html });
      // Read back and prove the sentence landed.
      const check = await wpRequest("GET", `/wp-json/wp/v2/posts/${post.id}?context=edit`, null);
      const raw = check.content && check.content.raw ? check.content.raw : "";
      const ok = hasShowDate(raw, c.date) && (!c.ticketUrl || hasTicketLink(raw, c.ticketUrl));
      console.log(`  ${c.slug}: ${ok ? "UPDATED" : "UPDATED but verification failed"} (${status}) → ${post.link}`);
      updated++;
    } catch (err) {
      console.log(`  ${c.slug}: FAILED ${err.message}`);
      failed++;
    }
  }
  console.log(`\nDone. ${DRY_RUN ? "Would update" : "Updated"} ${updated}, left ${skipped}, failed ${failed}.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
