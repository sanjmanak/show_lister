#!/usr/bin/env node

/**
 * Comedy Houston — WordPress page sync
 *
 * Creates/updates the SEO landing pages (config/landing-pages.json) and the
 * venue pages (config/venues.json, if present) on WordPress. Idempotent:
 * pages are looked up by slug and updated in place, never duplicated.
 *
 * Runs from the "Manage WordPress Pages" workflow (workflow_dispatch) with:
 *   WP_SITE_URL, WP_APP_USER, WP_APP_PASSWORD
 *
 * The page CONTENT is a short intro + the [comedy_houston] shortcode, so the
 * event listings on these pages stay live via the plugin — the pages only
 * need re-syncing when the copy in the config files changes.
 *
 * OWNERSHIP, and the reason the two page types behave differently:
 *
 *   Landing pages  — always overwritten. Their titles and H1s carry date
 *                    tokens ({weekend_range} and friends) that the plugin
 *                    expands at render time, so config/landing-pages.json
 *                    has to stay the source of truth or the dates go stale.
 *
 *   Venue pages    — CREATE-ONLY. config/venues.json seeds a venue page the
 *                    first time it is published; after that WordPress owns
 *                    it, because the whole point is to hand-edit the body
 *                    copy, add links, and drop in images natively in the WP
 *                    editor. A venue page that already exists is skipped,
 *                    not updated, so a stray workflow run can never clobber
 *                    that work.
 *
 * To deliberately push repo copy over a venue page that already exists (e.g.
 * after rewriting it here), set OVERWRITE_SLUGS to a comma-separated slug
 * list — the workflow exposes this as its `overwrite` input. Use "venues"
 * for the /venues/ parent page and "all" for everything.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const WP_SITE_URL = (process.env.WP_SITE_URL || "").replace(/\/+$/, "");
const WP_APP_USER = process.env.WP_APP_USER || "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";

const ROOT = path.resolve(__dirname, "..");
const LANDING_CONFIG = path.join(ROOT, "config", "landing-pages.json");
const VENUES_CONFIG = path.join(ROOT, "config", "venues.json");
const EVENTS_JSON = path.join(ROOT, "events.json");

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Venue-page slugs the caller explicitly wants overwritten this run, from the
 * workflow's `overwrite` input. Empty by default: venue pages are create-only
 * so that manual WordPress edits survive (see the header comment). "all"
 * overwrites every venue page, and "venues" covers the /venues/ parent.
 */
const OVERWRITE_SLUGS = new Set(
  (process.env.OVERWRITE_SLUGS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

function shouldOverwrite(slug) {
  return OVERWRITE_SLUGS.has("all") || OVERWRITE_SLUGS.has(String(slug).toLowerCase());
}

function wpRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(WP_SITE_URL + apiPath);
    const mod = url.protocol === "http:" ? http : https;
    const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString("base64");
    const payload = body ? JSON.stringify(body) : null;

    const req = mod.request(
      url,
      {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          "User-Agent": "ComedyHouston-PageSync/1.0 (+https://comedyhouston.com)",
          Accept: "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`WP ${method} ${apiPath}: JSON parse error: ${e.message}`));
            }
          } else {
            reject(
              new Error(
                `WP ${method} ${apiPath} failed: HTTP ${res.statusCode}\n${data.slice(0, 1000)}`
              )
            );
          }
        });
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`WP ${method} ${apiPath} timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Preflight: authenticate and report what this application-password user is
 * allowed to do. Aborts (throws) if the user cannot publish pages, since
 * that's this script's whole job.
 */
async function preflight() {
  console.log("Preflight: GET /wp-json/wp/v2/users/me?context=edit ...");
  const me = await wpRequest("GET", "/wp-json/wp/v2/users/me?context=edit", null);
  const caps = me.capabilities || {};
  const interesting = ["publish_pages", "edit_pages", "publish_posts", "upload_files", "unfiltered_html", "manage_options"];
  console.log(`  Authenticated as "${me.name}" (id=${me.id}, slug=${me.slug})`);
  console.log(`  Roles: ${(me.roles || []).join(", ") || "(none reported)"}`);
  console.log("  Capabilities of interest:");
  for (const cap of interesting) {
    console.log(`    ${cap}: ${caps[cap] ? "YES" : "no"}`);
  }
  if (!caps.publish_pages) {
    throw new Error(
      "This WP user lacks the publish_pages capability — cannot sync landing/venue pages. " +
        "Grant the user an Editor/Administrator role, or fall back to posts."
    );
  }
  return me;
}

async function findPageBySlug(slug) {
  const found = await wpRequest(
    "GET",
    `/wp-json/wp/v2/pages?slug=${encodeURIComponent(slug)}&status=publish,draft,future,private`,
    null
  );
  return Array.isArray(found) && found.length > 0 ? found[0] : null;
}

/**
 * Create or update (by slug) a WordPress page.
 *
 * With `createOnly`, an existing page is left completely untouched and
 * reported as "skipped" — no title, content, meta or schema write. That is
 * the venue-page default so hand-edits in the WordPress editor survive.
 *
 * Returns { page, action } where action is "created" | "updated" | "skipped".
 */
async function syncPage({ slug, title, content, parent = 0, metaTitle, metaDescription, h1, schemaGraph, createOnly = false }) {
  const pageData = {
    title,
    content,
    status: "publish",
    slug,
    comment_status: "closed",
    parent,
  };
  if (metaTitle) pageData.ch_meta_title = metaTitle;
  if (metaDescription) pageData.ch_meta_description = metaDescription;
  // Dynamic H1 override. Kept out of `title` on purpose: the stored post
  // title feeds nav menus, breadcrumbs and the admin list, and a literal
  // "{weekend_range}" showing up there would be worse than the static
  // heading it replaced. The plugin expands the tokens at render time and
  // only for the main-loop H1.
  if (h1) pageData.ch_h1 = h1;
  if (schemaGraph) pageData.ch_schema_graph = JSON.stringify(schemaGraph);

  const existing = await findPageBySlug(slug);
  if (existing && createOnly) {
    console.log(`  Skipped  /${slug}/ (ID ${existing.id}) — WordPress owns this page`);
    return { page: existing, action: "skipped" };
  }
  let page;
  if (existing) {
    page = await wpRequest("POST", `/wp-json/wp/v2/pages/${existing.id}`, pageData);
    console.log(`  Updated  /${slug}/ (ID ${page.id}): ${page.link}`);
  } else {
    page = await wpRequest("POST", "/wp-json/wp/v2/pages", pageData);
    console.log(`  Created  /${slug}/ (ID ${page.id}): ${page.link}`);
  }
  return { page, action: existing ? "updated" : "created" };
}

/** Cross-link block appended to each landing page (excluding itself). */
function landingCrossLinks(pages, selfSlug) {
  const links = pages
    .filter((p) => p.slug !== selfSlug)
    .map((p) => `<a href="/${p.slug}/">${escapeHTML(p.title)}</a>`)
    .join(" &middot; ");
  return `<p class="ch-landing-crosslinks"><em>More Houston comedy: ${links} &middot; <a href="/">Every upcoming show</a></em></p>`;
}

function escapeHTML(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function syncLandingPages() {
  if (!fs.existsSync(LANDING_CONFIG)) {
    console.log("No config/landing-pages.json — skipping landing pages.");
    return [];
  }
  const config = JSON.parse(fs.readFileSync(LANDING_CONFIG, "utf8"));
  const pages = config.pages || [];
  console.log(`\nSyncing ${pages.length} landing page(s)...`);

  const results = [];
  for (const p of pages) {
    const content = `${p.intro_html}\n\n${p.shortcode}\n\n${landingCrossLinks(pages, p.slug)}`;
    try {
      const { page, action } = await syncPage({
        slug: p.slug,
        title: p.title,
        content,
        metaTitle: p.meta_title,
        metaDescription: p.meta_description,
        h1: p.h1,
      });
      results.push({ slug: p.slug, link: page.link, action, ok: true });
    } catch (err) {
      console.error(`  ERROR syncing /${p.slug}/: ${err.message}`);
      results.push({ slug: p.slug, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Derive a schema.org priceRange for a venue from its events, using each
 * event's entry price (price_min). Returns e.g. "$19–$35", "Free", or null
 * when no price data is available (Ticketmaster-sourced venues currently
 * carry no priceRanges, so those correctly get no priceRange rather than a
 * fabricated one). Because pages only re-sync on demand, this is a
 * point-in-time snapshot — coarse whole-dollar bounds keep it stable across
 * minor day-to-day fluctuations.
 */
function deriveVenuePriceRange(venue, events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const names = new Set(
    [venue.name, ...(venue.aliases || [])].map((s) => String(s).toLowerCase().trim())
  );
  const mins = [];
  for (const e of events) {
    const v = String(e.venue || "").toLowerCase().trim();
    if (!names.has(v)) continue;
    if (typeof e.price_min === "number" && !Number.isNaN(e.price_min)) {
      mins.push(e.price_min);
    }
  }
  if (mins.length === 0) return null;
  const positive = mins.filter((m) => m > 0);
  if (positive.length === 0) return "Free";
  const lo = Math.round(Math.min(...positive));
  const hi = Math.round(Math.max(...mins));
  return lo === hi ? `$${lo}` : `$${lo}–$${hi}`;
}

/** Build LocalBusiness JSON-LD for a venue (used by venue pages). */
function buildVenueSchema(venue, priceRange) {
  const address = {
    "@type": "PostalAddress",
    streetAddress: venue.address.street,
    addressLocality: venue.address.locality || "Houston",
    addressRegion: venue.address.region || "TX",
    addressCountry: "US",
  };
  // Omit postalCode when unknown (e.g. an unverified zip) rather than
  // emitting an empty string, which is not schema.org-valid.
  if (venue.address.postal) address.postalCode = venue.address.postal;

  const schema = {
    "@context": "https://schema.org",
    "@type": venue.schema_type || "ComedyClub",
    name: venue.name,
    address,
  };
  if (venue.phone) schema.telephone = venue.phone;
  if (venue.website) schema.url = venue.website;
  if (priceRange) schema.priceRange = priceRange;
  if (venue.same_as && venue.same_as.length > 0) schema.sameAs = venue.same_as;
  return schema;
}

async function syncVenuePages() {
  if (!fs.existsSync(VENUES_CONFIG)) {
    console.log("No config/venues.json — skipping venue pages.");
    return [];
  }
  const config = JSON.parse(fs.readFileSync(VENUES_CONFIG, "utf8"));
  const venues = (config.venues || []).filter((v) => v.page && v.page.enabled !== false);
  if (venues.length === 0) {
    console.log("No venues with pages enabled — skipping venue pages.");
    return [];
  }

  // Load events (best-effort) so we can derive a priceRange per venue for the
  // ComedyClub schema. Missing/invalid events.json just means no priceRange.
  let events = [];
  try {
    if (fs.existsSync(EVENTS_JSON)) {
      const raw = JSON.parse(fs.readFileSync(EVENTS_JSON, "utf8"));
      events = Array.isArray(raw) ? raw : raw.events || [];
    }
  } catch (err) {
    console.log(`  (events.json unreadable — venue priceRange skipped: ${err.message})`);
  }

  const overwriting = venues.filter((v) => shouldOverwrite(v.slug)).map((v) => v.slug);
  console.log(`\nSyncing venues parent page + ${venues.length} venue page(s)...`);
  console.log(
    "  Venue pages are create-only: existing pages are left alone so WordPress edits survive."
  );
  console.log(
    overwriting.length > 0
      ? `  Overwriting on request: ${overwriting.join(", ")}`
      : "  Overwriting: nothing (pass the workflow's `overwrite` input to force a specific slug)."
  );

  // Parent page /venues/ so children live at /venues/{slug}/.
  const venueLinks = venues
    .map((v) => `<li><a href="/venues/${v.slug}/">${escapeHTML(v.name)}</a></li>`)
    .join("\n");
  const { page: parent, action: parentAction } = await syncPage({
    slug: "venues",
    title: "Houston Comedy Venues",
    content:
      `<p>Every comedy club and venue we track in Houston — showtimes, ticket links, and what to know before you go.</p>\n<ul>\n${venueLinks}\n</ul>`,
    metaTitle: "Houston Comedy Clubs & Venues | Comedy Houston",
    metaDescription:
      "Guides to every comedy club in Houston — Houston Improv, Punch Line, The Secret Group, The Riot, The Den — with upcoming shows, tickets, and venue info.",
    createOnly: !shouldOverwrite("venues"),
  });

  // The parent page is a hand-editable list, so we don't rewrite it. That
  // means a newly added venue would silently never get linked from /venues/,
  // which is the one thing create-only can quietly break. Check and say so
  // rather than leaving it to be noticed months later in Search Console.
  if (parentAction === "skipped") {
    const parentHTML = (parent.content && parent.content.rendered) || "";
    const missing = venues.filter((v) => !parentHTML.includes(`/venues/${v.slug}/`));
    if (missing.length > 0) {
      console.log(
        `  NOTE: /venues/ does not link to ${missing.length} venue page(s): ` +
          missing.map((v) => `${v.name} (/venues/${v.slug}/)`).join(", ")
      );
      console.log(
        "        Add the link(s) by hand in the WordPress editor, or re-run with overwrite=venues to regenerate the list."
      );
    }
  }

  const results = [];
  for (const v of venues) {
    const p = v.page;
    const shortcode = `[comedy_houston venue="${v.name}" show_hero="false" show_controls="false"]`;
    const content = [
      p.description_html,
      `<h2>Upcoming shows at ${escapeHTML(v.name)}</h2>`,
      shortcode,
      `<p class="ch-landing-crosslinks"><em>More Houston comedy: <a href="/venues/">All venues</a> &middot; <a href="/tonight/">Tonight</a> &middot; <a href="/this-weekend/">This weekend</a> &middot; <a href="/">Every upcoming show</a></em></p>`,
    ].join("\n\n");

    try {
      const { page, action } = await syncPage({
        slug: v.slug,
        title: p.title || `${v.name} — Shows, Tickets & Info`,
        content,
        parent: parent.id,
        metaTitle: p.meta_title || `${v.name} — Shows, Tickets & Info | Comedy Houston`,
        metaDescription: p.meta_description || "",
        schemaGraph: v.address && v.address.street
          ? buildVenueSchema(v, deriveVenuePriceRange(v, events))
          : null,
        createOnly: !shouldOverwrite(v.slug),
      });
      results.push({ slug: `venues/${v.slug}`, link: page.link, action, ok: true });
    } catch (err) {
      console.error(`  ERROR syncing /venues/${v.slug}/: ${err.message}`);
      results.push({ slug: `venues/${v.slug}`, ok: false, error: err.message });
    }
  }
  return results;
}

async function main() {
  console.log("=== Comedy Houston — WordPress Page Sync ===");
  console.log(`Time: ${new Date().toISOString()}`);

  if (!WP_SITE_URL || !WP_APP_USER || !WP_APP_PASSWORD) {
    console.error("Missing WP_SITE_URL / WP_APP_USER / WP_APP_PASSWORD env vars.");
    process.exit(1);
  }

  await preflight();

  const landing = await syncLandingPages();
  const venuesRes = await syncVenuePages();

  const all = [...landing, ...venuesRes];
  const failed = all.filter((r) => !r.ok);
  const count = (a) => all.filter((r) => r.ok && r.action === a).length;
  console.log(
    `\nDone: ${count("created")} created, ${count("updated")} updated, ` +
      `${count("skipped")} skipped (WordPress-owned), ${failed.length} failed.`
  );
  if (failed.length > 0) {
    console.error(`Failed: ${failed.map((f) => f.slug).join(", ")}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
  });
}

module.exports = { buildVenueSchema, deriveVenuePriceRange, landingCrossLinks };
