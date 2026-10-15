#!/usr/bin/env node

/**
 * Comedy Houston — month pages.
 *
 * Keeps a rolling set of dated month pages live on WordPress:
 *
 *   /comedy-shows-houston-november-2026/
 *   /comedy-shows-houston-december-2026/
 *
 * One page per FUTURE month whose first day is within LEAD_DAYS (60) of
 * today, Houston time. events.json carries 90 days of shows, so a month is
 * only published once every one of its days is inside the data window and
 * the page can never look half-empty. Each page body is a short intro, the
 * month navigation, and the listing shortcode with month="YYYY-MM"; the
 * plugin renders the shows, the "Headliners this month" block and the
 * Event JSON-LD live from events.json at request time, so the page is
 * current between runs without being re-saved.
 *
 * Lifecycle: the month the page describes becomes the CURRENT month → the
 * page is trashed here and the plugin 301s its URL to the evergreen
 * /houston-comedy-shows-this-month/ post (redirect_dated_weekly_posts()).
 * So "comedy shows in houston november 2026" has one URL in October, which
 * hands its signals to the evergreen current-month page on November 1st,
 * and nothing dated ever accumulates. The evergreen post gets the month
 * navigation and a {month_year} title token from here, additively.
 *
 * Idempotent: pages are looked up by slug and updated in place. Runs daily
 * from sync-month-pages.yml (also workflow_dispatch with dry_run).
 *
 * Env: WP_SITE_URL / WP_APP_USER / WP_APP_PASSWORD, DRY_RUN=1,
 *      LEAD_DAYS (default 60), TODAY=YYYY-MM-DD (tests).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { createWpClient } = require("./lib/wp");

const ROOT = path.resolve(__dirname, "..");
const EVENTS_JSON = path.join(ROOT, "events.json");

const WP_SITE_URL = (process.env.WP_SITE_URL || "").replace(/\/+$/, "");
const WP_APP_USER = process.env.WP_APP_USER || "";
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";
const DRY_RUN = !!process.env.DRY_RUN && process.env.DRY_RUN !== "false" && process.env.DRY_RUN !== "0";
const LEAD_DAYS = Math.max(1, parseInt(process.env.LEAD_DAYS || "60", 10) || 60);

// The evergreen current-month page: past and current dated month URLs 301
// here (plugin), and this script gives it the month navigation + live title.
const EVERGREEN_SLUG = "houston-comedy-shows-this-month";
const MONTHS_NAV_SHORTCODE = "[comedy_houston_months]";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function todayChicago() {
  return process.env.TODAY || new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function daysBetween(fromYmd, toYmd) {
  return Math.round((Date.parse(toYmd + "T12:00:00Z") - Date.parse(fromYmd + "T12:00:00Z")) / 86400000);
}

/**
 * Months to publish, as { ym: "2026-11", year, monthIndex, name, slug }.
 * Future months only (never the current one), first day ≤ LEAD_DAYS away.
 * The plugin's months nav uses LEAD_DAYS - 1 so it never links a page this
 * script has not created yet (it runs once a day).
 */
function targetMonths(today = todayChicago(), leadDays = LEAD_DAYS) {
  const [y, m] = today.split("-").map(Number);
  const out = [];
  for (let k = 1; k <= 4; k++) {
    const d = new Date(Date.UTC(y, m - 1 + k, 1));
    const first = d.toISOString().slice(0, 10);
    if (daysBetween(today, first) > leadDays) break;
    out.push(monthRecord(d.getUTCFullYear(), d.getUTCMonth()));
  }
  return out;
}

function monthRecord(year, monthIndex) {
  const name = MONTH_NAMES[monthIndex];
  return {
    ym: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
    year,
    monthIndex,
    name,
    slug: `comedy-shows-houston-${name.toLowerCase()}-${year}`,
  };
}

/** Parse "comedy-shows-houston-november-2026" → record, or null. */
function monthFromSlug(slug) {
  const m = /^comedy-shows-houston-([a-z]+)-(\d{4})$/.exec(String(slug || ""));
  if (!m) return null;
  const idx = MONTH_NAMES.findIndex((n) => n.toLowerCase() === m[1]);
  if (idx < 0) return null;
  return monthRecord(parseInt(m[2], 10), idx);
}

function escapeHTML(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Static copy for a month page. Everything data-driven is rendered by the plugin. */
function buildMonthPage(rec) {
  const label = `${rec.name} ${rec.year}`;
  const intro =
    `<p class="lede">Every comedy show in Houston in ${label}, in one place: touring headliners at the ` +
    `<a href="/venues/houston-improv/">Houston Improv</a> and <a href="/venues/punch-line-houston/">Punch Line</a>, ` +
    `nightly showcases at <a href="/venues/the-secret-group/">The Secret Group</a> and <a href="/venues/the-riot-comedy-club/">The Riot</a>, ` +
    `theater and arena dates, bar shows and free open mics. Listings come straight from the box offices and update twice a day, ` +
    `so the dates, prices and ticket links below are current.</p>`;
  const shortcode = `[comedy_houston month="${rec.ym}" show_summary="true" show_hero="false" show_controls="false" initial_days="0"]`;
  const outro =
    `<h2>Planning a comedy night in ${label}</h2>` +
    `<p>Weekend headliner shows at the big clubs sell out more often than you would think, so buy early for Friday and Saturday. ` +
    `Weeknights are cheaper and looser: showcases and open mics at The Secret Group, The Riot and the bar rooms run most nights for free or under $20. ` +
    `For a specific night, see <a href="/tonight/">comedy shows in Houston tonight</a> and <a href="/this-weekend/">this weekend</a>; ` +
    `for the names on tour, see <a href="/comedians/">every comedian coming to Houston</a>. ` +
    `Most club shows are 18 and up with a two-item minimum; <a href="/clean-comedy-shows-houston/">clean comedy shows</a> and ` +
    `<a href="/free/">free comedy shows</a> have their own pages.</p>` +
    `<h2>Frequently asked questions</h2>` +
    `<h3>What comedy shows are in Houston in ${label}?</h3>` +
    `<p>The full list is above: every ticketed stand-up show, showcase and open mic in Houston for ${label}, from every venue we track, ` +
    `with showtimes, prices and direct ticket links. It updates twice a day as new dates are announced.</p>` +
    `<h3>Which comedians are coming to Houston in ${label}?</h3>` +
    `<p>Touring headliners for the month are listed in the "Headliners" block at the top of the page, with a link to each comedian's Houston page where we have one.</p>` +
    `<h3>Are there free comedy shows in Houston in ${label}?</h3>` +
    `<p>Yes. Free showcases and open mics run most nights of the week; they appear in the list above marked Free, and the ` +
    `<a href="/free/">free comedy shows page</a> keeps the current list.</p>`;
  const faq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `What comedy shows are in Houston in ${label}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `Every ticketed stand-up show, showcase and open mic in Houston for ${label}, from every venue Comedy Houston tracks, with showtimes, prices and direct ticket links, updated twice a day.`,
        },
      },
      {
        "@type": "Question",
        name: `Which comedians are coming to Houston in ${label}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `Touring headliners for ${label} are listed in the Headliners block on the page, with a link to each comedian's Houston page where one exists.`,
        },
      },
      {
        "@type": "Question",
        name: `Are there free comedy shows in Houston in ${label}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `Yes. Free showcases and open mics run most nights of the week in Houston; they are marked Free in the listing and collected on the free comedy shows page.`,
        },
      },
    ],
  };
  return {
    title: `Comedy Shows in Houston: ${label}`,
    content: [intro, MONTHS_NAV_SHORTCODE, shortcode, outro].join("\n\n"),
    ch_meta_title: `Comedy Shows in Houston: ${label} | Full Schedule and Tickets`,
    ch_meta_description:
      `Every comedy show in Houston in ${label}: headliners at the Improv and Punch Line, showcases, theater dates, bar shows and free open mics, ` +
      `with showtimes, prices and ticket links. Updated twice daily.`,
    ch_h1: `Comedy Shows in Houston in ${label}`,
    ch_schema_graph: JSON.stringify(faq),
  };
}

const wp = createWpClient({ siteUrl: WP_SITE_URL, userAgent: "ComedyHouston-MonthPages/1.0", timeoutMs: 30_000 });
const wpRequest = (method, p, body) => wp.request(method, p, body);

/** Published month pages, found by slug pattern over every page (not a hardcoded list). */
async function listMonthPages() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const found = await wpRequest(
      "GET",
      `/wp-json/wp/v2/pages?per_page=100&page=${page}&status=publish,draft,future,private&_fields=id,slug,link,status`
    );
    if (!Array.isArray(found) || found.length === 0) break;
    for (const p of found) if (monthFromSlug(p.slug)) out.push(p);
    if (found.length < 100) break;
  }
  return out;
}

async function findPageBySlugRaw(slug) {
  const found = await wpRequest(
    "GET",
    `/wp-json/wp/v2/pages?slug=${encodeURIComponent(slug)}&status=publish,draft,future,private&context=edit&_fields=id,link,status,content,title,ch_meta_title,ch_meta_description,ch_h1,ch_schema_graph`
  );
  return Array.isArray(found) && found.length > 0 ? found[0] : null;
}

/** True when the live page already carries exactly this content and meta. */
function monthPageUnchanged(existing, data) {
  if (!existing || existing.status !== "publish") return false;
  const raw = existing.content && typeof existing.content.raw === "string" ? existing.content.raw : null;
  const title = existing.title && typeof existing.title.raw === "string" ? existing.title.raw : null;
  return raw === data.content && title === data.title &&
    existing.ch_meta_title === data.ch_meta_title &&
    existing.ch_meta_description === data.ch_meta_description &&
    existing.ch_h1 === data.ch_h1 &&
    existing.ch_schema_graph === data.ch_schema_graph;
}

async function syncMonthPage(rec) {
  const data = { ...buildMonthPage(rec), slug: rec.slug, status: "publish", comment_status: "closed", ch_noindex: false };
  const existing = await findPageBySlugRaw(rec.slug);
  // An unchanged page is not re-saved: a POST moves post_modified, and the
  // sitemap's lastmod must only move when something changed (the plugin
  // bumps it on real data changes already).
  if (monthPageUnchanged(existing, data)) {
    console.log(`  Unchanged /${rec.slug}/ (ID ${existing.id})`);
    return { action: "unchanged", page: existing };
  }
  if (DRY_RUN) {
    console.log(`  DRY RUN: would ${existing ? `update /${rec.slug}/ (ID ${existing.id})` : `create /${rec.slug}/`}`);
    return { action: existing ? "updated" : "created", dry: true };
  }
  if (existing) {
    const page = await wpRequest("POST", `/wp-json/wp/v2/pages/${existing.id}`, data);
    console.log(`  Updated /${rec.slug}/ (ID ${page.id}): ${page.link}`);
    return { action: "updated", page };
  }
  const page = await wpRequest("POST", "/wp-json/wp/v2/pages", data);
  console.log(`  Created /${rec.slug}/ (ID ${page.id}): ${page.link}`);
  return { action: "created", page };
}

/**
 * The evergreen current-month post: make sure the month navigation sits at
 * the top of its body (once) and that its title and description carry the
 * live {month_year} token. Additive; the rest of the post is left alone.
 */
async function syncEvergreenPost() {
  const found = await wpRequest(
    "GET",
    `/wp-json/wp/v2/posts?slug=${EVERGREEN_SLUG}&status=publish&context=edit&_fields=id,link,content,ch_meta_title,ch_meta_description`
  );
  if (!Array.isArray(found) || found.length === 0) {
    console.log(`  /${EVERGREEN_SLUG}/ not found — skipping evergreen sync (past-month URLs still 301 to it).`);
    return;
  }
  const post = found[0];
  const raw = post.content && typeof post.content.raw === "string" ? post.content.raw : "";
  const data = {};
  if (raw && !raw.includes(MONTHS_NAV_SHORTCODE)) {
    data.content = `${MONTHS_NAV_SHORTCODE}\n\n${raw}`;
  }
  const wantTitle = "Comedy Shows in Houston This Month: {month_year} Calendar | Comedy Houston";
  const wantDesc =
    "Every comedy show in Houston this month ({month_year}): headliners, showcases, theater dates and free open mics at every venue, " +
    "with showtimes, prices and ticket links. Updated twice daily.";
  // Seeded ONCE, only when nothing is set: after that the WordPress editor
  // owns them (clear the hidden _ch_meta_title in WP to hand the title back
  // to Rank Math). Same rule as the venue pages.
  if (!post.ch_meta_title) data.ch_meta_title = wantTitle;
  if (!post.ch_meta_description) data.ch_meta_description = wantDesc;
  if (Object.keys(data).length === 0) {
    console.log(`  /${EVERGREEN_SLUG}/ already current.`);
    return;
  }
  if (DRY_RUN) {
    console.log(`  DRY RUN: would update /${EVERGREEN_SLUG}/ (${Object.keys(data).join(", ")})`);
    return;
  }
  await wpRequest("POST", `/wp-json/wp/v2/posts/${post.id}`, data);
  console.log(`  Updated /${EVERGREEN_SLUG}/ (${Object.keys(data).join(", ")})`);
}

async function main() {
  console.log("=== Comedy Houston — Month pages ===");
  const today = todayChicago();
  const targets = targetMonths(today);
  console.log(`Today (Houston): ${today} | lead ${LEAD_DAYS}d | ${DRY_RUN ? "DRY RUN" : "live"}`);
  console.log(`Target months: ${targets.map((t) => t.ym).join(", ") || "(none within the lead window)"}`);

  if (!WP_SITE_URL || !WP_APP_USER || !WP_APP_PASSWORD) {
    console.error("Missing WP_SITE_URL / WP_APP_USER / WP_APP_PASSWORD env vars.");
    process.exit(1);
  }

  let counts = 0;
  try {
    const data = JSON.parse(fs.readFileSync(EVENTS_JSON, "utf8"));
    counts = (data.events || []).length;
  } catch (_) { /* informational only */ }
  if (counts) console.log(`events.json: ${counts} events`);

  const me = await wpRequest("GET", "/wp-json/wp/v2/users/me?context=edit");
  if (!me.capabilities || !me.capabilities.publish_pages) {
    throw new Error("This WP user lacks publish_pages — cannot sync month pages.");
  }

  console.log("\nMonth pages:");
  const wanted = new Set(targets.map((t) => t.slug));
  for (const rec of targets) await syncMonthPage(rec);

  // Retire pages for months that are now current or past (their URLs 301 to
  // the evergreen post in the plugin). Trash, not force-delete: a page is
  // recoverable from WP admin for 30 days if a rule ever misfires.
  const [cy, cm] = today.split("-").map(Number);
  const currentYm = `${cy}-${String(cm).padStart(2, "0")}`;
  for (const p of await listMonthPages()) {
    if (wanted.has(p.slug)) continue;
    const rec = monthFromSlug(p.slug);
    if (!rec || rec.ym > currentYm) continue; // a future month outside the window: leave it
    if (DRY_RUN) {
      console.log(`  DRY RUN: would trash /${p.slug}/ (ID ${p.id}, ${rec.ym} ≤ ${currentYm})`);
      continue;
    }
    await wpRequest("DELETE", `/wp-json/wp/v2/pages/${p.id}`);
    console.log(`  Trashed /${p.slug}/ (ID ${p.id}) — URL now 301s to /${EVERGREEN_SLUG}/`);
  }

  console.log("\nEvergreen current-month post:");
  await syncEvergreenPost();
  console.log("\nDone.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("sync-month-pages failed:", err.message);
    process.exit(1);
  });
}

module.exports = { targetMonths, monthFromSlug, monthRecord, buildMonthPage, MONTH_NAMES, EVERGREEN_SLUG };
