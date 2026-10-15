/**
 * Comedy Houston — evergreen comedian page builder + publisher.
 *
 * One WordPress PAGE per comedian at /comedians/{slug}/, child of the
 * /comedians/ hub. The page body is:
 *
 *   1. the event poster (featured image, also inline at the top),
 *   2. [comedy_houston_performer ...] — the plugin renders this comedian's
 *      UPCOMING Houston shows live from events.json at request time, with
 *      ticket links and Event JSON-LD, so the page is current between
 *      Monday runs without anyone republishing it,
 *   3. the written profile (lib/comedian-profile-writer.js, stored in the
 *      registry and reused on every return visit),
 *   4. a "Past Houston shows" list from the registry,
 *   5. the Comedy Houston footer.
 *
 * Title, H1 and meta description carry {performer_next_*} tokens that the
 * plugin expands at render time ("Oct 28 at Toyota Center" today, "Shows,
 * Tickets and Dates" once the run is over), so nothing in the SERP snippet
 * can go stale either. Schema: ProfilePage → Person (+ sameAs from the
 * research), BreadcrumbList. Event schema comes from the live shortcode.
 *
 * Pages rather than posts: pages do not appear in the blog feed, category
 * archives or RSS, which is the point — these are reference pages parked
 * off to the side, not blog entries.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const registry = require("./comedian-registry");

const SITE_URL = (process.env.WP_SITE_URL || "https://comedyhouston.com").replace(/\/+$/, "");
const HUB_SLUG = "comedians";
const LANDING_CONFIG = path.join(__dirname, "..", "..", "config", "landing-pages.json");

function escapeHTML(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Shortcode attribute value: no quotes or brackets, which would end the tag. */
function shortcodeAttr(str) {
  return String(str || "").replace(/["\[\]]/g, "").trim();
}

function formatDateLong(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function pageUrlFor(entry) {
  return `${SITE_URL}/${HUB_SLUG}/${entry.slug}/`;
}

/** The performer shortcode: name for display, match terms for the filter. */
function performerShortcode(entry) {
  const match = (entry.match || [registry.normalizeName(entry.name)]).map(shortcodeAttr).filter(Boolean).join("|");
  return `[comedy_houston_performer name="${shortcodeAttr(entry.name)}" match="${match}" slug="${shortcodeAttr(entry.slug)}"]`;
}

/**
 * Page body. `heroImageUrl` is the WordPress media URL (after upload) or the
 * event poster URL as a fallback; `heroMediaId` adds the wp-image class so
 * the theme treats it like any other inserted image.
 */
function buildPageContent(entry, { heroImageUrl = "", heroMediaId = 0 } = {}) {
  const parts = [];
  if (heroImageUrl) {
    parts.push(
      `<figure class="wp-block-image size-large aligncenter ch-post-hero" style="width:fit-content;max-width:100%;margin-left:auto;margin-right:auto">` +
        `<img src="${escapeHTML(heroImageUrl)}" alt="${escapeHTML(entry.name)}"` +
        (heroMediaId ? ` class="wp-image-${heroMediaId}"` : "") +
        ` style="display:block;max-width:100%;height:auto"/></figure>`
    );
  }
  parts.push(performerShortcode(entry));
  if (entry.profile_html) {
    parts.push(`<div class="ch-comedian-profile">\n${entry.profile_html.trim()}\n</div>`);
  }
  const past = registry.pastShows(entry);
  if (past.length > 0) {
    const items = past
      .slice()
      .reverse()
      .slice(0, 24)
      .map((s) => `<li>${escapeHTML(formatDateLong(s.date))} at ${escapeHTML(s.venue)}</li>`)
      .join("\n");
    parts.push(`<h2>${escapeHTML(entry.name)} in Houston: past shows</h2>\n<ul class="ch-past-shows">\n${items}\n</ul>`);
  }
  parts.push(
    `<div class="post-footer">\n` +
      `<p>See <a href="${SITE_URL}/${HUB_SLUG}/">every comedian coming to Houston</a>, ` +
      `<a href="${SITE_URL}/this-weekend/">this weekend's shows</a>, or <a href="${SITE_URL}/">every upcoming show in the city</a>, updated twice daily.</p>\n` +
      `<p>Know a ${escapeHTML(entry.name)} Houston date we are missing? <a href="${SITE_URL}/contact/">Tell us</a>.</p>\n` +
      `</div>`
  );
  return parts.join("\n\n");
}

/** ProfilePage → Person, plus breadcrumbs. Events come from the live shortcode. */
function buildSchemaGraph(entry, { pageUrl, imageUrl = "", dateModified = null, datePublished = null } = {}) {
  const url = pageUrl || pageUrlFor(entry);
  const person = {
    "@type": "Person",
    "@id": `${url}#person`,
    name: entry.name,
    jobTitle: "Comedian",
    url,
  };
  if (imageUrl) person.image = imageUrl;
  if (Array.isArray(entry.sameAs) && entry.sameAs.length > 0) person.sameAs = entry.sameAs.slice(0, 8);

  const page = {
    "@type": "ProfilePage",
    "@id": `${url}#webpage`,
    url,
    name: `${entry.name} in Houston`,
    mainEntity: { "@id": `${url}#person` },
    isPartOf: { "@type": "WebSite", url: `${SITE_URL}/`, name: "Comedy Houston" },
  };
  if (datePublished) page.datePublished = datePublished;
  if (dateModified) page.dateModified = dateModified;

  const crumbs = {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Comedy Houston", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: "Comedians coming to Houston", item: `${SITE_URL}/${HUB_SLUG}/` },
      { "@type": "ListItem", position: 3, name: entry.name, item: url },
    ],
  };
  return { "@context": "https://schema.org", "@graph": [page, person, crumbs] };
}

/** SEO strings with the plugin's live tokens (see expand_date_tokens()). */
function seoFields(entry) {
  const name = entry.name;
  return {
    title: `${name} in Houston`,
    ch_meta_title: `${name} in Houston: {performer_next_short} | Comedy Houston`,
    ch_h1: `${name} in Houston: {performer_next_h1}`,
    ch_meta_description:
      `{performer_next_sentence} Every ${name} Houston date with showtimes and tickets, ` +
      `who they are, and what to expect live. Updated twice daily.`,
    ch_performer: JSON.stringify({ name, match: entry.match || [registry.normalizeName(name)], slug: entry.slug }),
  };
}

/**
 * Find or create the /comedians/ hub page. Content comes from the same
 * config/landing-pages.json entry the page-sync workflow uses, so the two
 * never disagree; this only exists so a Monday run never has to wait for a
 * manual page-sync dispatch before it can publish a child page.
 */
async function ensureHubPage(wpRequest) {
  const found = await wpRequest("GET", `/wp-json/wp/v2/pages?slug=${HUB_SLUG}&status=publish,draft,future,private`);
  if (Array.isArray(found) && found.length > 0) return found[0];

  let cfg = null;
  try {
    const all = JSON.parse(fs.readFileSync(LANDING_CONFIG, "utf8")).pages || [];
    cfg = all.find((p) => p.slug === HUB_SLUG) || null;
  } catch (_) { /* fall back to the minimal page below */ }
  const data = {
    title: cfg ? cfg.title : "Comedians Coming to Houston",
    slug: HUB_SLUG,
    status: "publish",
    comment_status: "closed",
    content: cfg
      ? [cfg.intro_html, cfg.shortcode, cfg.outro_html].filter(Boolean).join("\n\n")
      : "[comedy_houston_comedians]",
  };
  if (cfg && cfg.meta_title) data.ch_meta_title = cfg.meta_title;
  if (cfg && cfg.meta_description) data.ch_meta_description = cfg.meta_description;
  if (cfg && cfg.h1) data.ch_h1 = cfg.h1;
  const page = await wpRequest("POST", "/wp-json/wp/v2/pages", data);
  console.log(`    Created hub page /${HUB_SLUG}/ (ID ${page.id})`);
  return page;
}

/**
 * Create or update the comedian's page in place. Idempotent: looks up by
 * stored page id first, then by slug (so a hand-created page with the same
 * slug is adopted rather than duplicated as "-2").
 *
 * `uploadHero({ url, filename })` is injected by the caller and returns
 * { mediaId, mediaUrl } or null; the poster is re-uploaded only when the
 * registry's recorded image URL changes (a new show, new poster).
 */
async function publishComedianPage(entry, { wpRequest, uploadHero = null, heroImageUrl = "", dryRun = false }) {
  const hub = await ensureHubPage(wpRequest);

  let existing = null;
  if (entry.wpPageId) {
    try {
      existing = await wpRequest("GET", `/wp-json/wp/v2/pages/${entry.wpPageId}?context=edit`);
      if (existing && existing.status === "trash") existing = null;
    } catch (_) { existing = null; }
  }
  if (!existing) {
    const found = await wpRequest(
      "GET",
      `/wp-json/wp/v2/pages?slug=${encodeURIComponent(entry.slug)}&parent=${hub.id}&status=publish,draft,future,private`
    );
    if (Array.isArray(found) && found.length > 0) existing = found[0];
  }

  // Poster: upload once per distinct image URL.
  let mediaId = entry.wpImageMediaId || 0;
  let mediaUrl = entry.wpImageUrl || "";
  if (heroImageUrl && uploadHero && (heroImageUrl !== entry.imageUrl || !mediaId)) {
    try {
      const up = await uploadHero({ url: heroImageUrl, filename: `${entry.slug}-houston` });
      if (up && up.mediaId) {
        mediaId = up.mediaId;
        mediaUrl = up.mediaUrl || "";
        entry.wpImageMediaId = mediaId;
        entry.wpImageUrl = mediaUrl;
        entry.imageUrl = heroImageUrl;
      }
    } catch (err) {
      console.warn(`    Poster upload failed (page publishes without it): ${err.message}`);
    }
  }

  const pageUrl = existing && existing.link ? existing.link : pageUrlFor(entry);
  const seo = seoFields(entry);
  const content = buildPageContent(entry, { heroImageUrl: mediaUrl || heroImageUrl || entry.imageUrl, heroMediaId: mediaId });
  const graph = buildSchemaGraph(entry, {
    pageUrl,
    imageUrl: mediaUrl || heroImageUrl || entry.imageUrl || "",
    datePublished: existing && existing.date_gmt ? existing.date_gmt + "Z" : null,
    dateModified: new Date().toISOString(),
  });

  const data = {
    title: seo.title,
    slug: entry.slug,
    status: "publish",
    parent: hub.id,
    comment_status: "closed",
    content,
    ch_meta_title: seo.ch_meta_title,
    ch_meta_description: seo.ch_meta_description,
    ch_h1: seo.ch_h1,
    ch_performer: seo.ch_performer,
    ch_schema_graph: JSON.stringify(graph),
    ch_noindex: false,
  };
  if (mediaId) data.featured_media = mediaId;

  if (dryRun) {
    console.log(`    DRY RUN: would ${existing ? "update page " + existing.id : "create page"} /${HUB_SLUG}/${entry.slug}/`);
    return { id: existing ? existing.id : 0, link: pageUrl };
  }

  let page;
  if (existing) {
    page = await wpRequest("POST", `/wp-json/wp/v2/pages/${existing.id}`, data);
    console.log(`    Updated page: ${page.link}`);
  } else {
    page = await wpRequest("POST", "/wp-json/wp/v2/pages", data);
    console.log(`    Created page: ${page.link}`);
    // The graph was built with the predicted URL; if WordPress chose a
    // different permalink (slug collision), rewrite it with the real one.
    if (page.link && page.link !== pageUrl) {
      const fixed = buildSchemaGraph(entry, { pageUrl: page.link, imageUrl: mediaUrl || heroImageUrl || "", dateModified: new Date().toISOString() });
      await wpRequest("POST", `/wp-json/wp/v2/pages/${page.id}`, { ch_schema_graph: JSON.stringify(fixed) });
    }
  }
  entry.wpPageId = page.id;
  entry.wpLink = page.link;
  return { id: page.id, link: page.link };
}

/** Move a comedian's page to the trash (recoverable for 30 days in WP admin). */
async function trashComedianPage(entry, { wpRequest, dryRun = false }) {
  if (!entry.wpPageId) return false;
  if (dryRun) {
    console.log(`    DRY RUN: would trash page ${entry.wpPageId} (/${HUB_SLUG}/${entry.slug}/)`);
    return false;
  }
  try {
    await wpRequest("DELETE", `/wp-json/wp/v2/pages/${entry.wpPageId}`);
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) return true; // already gone
    throw err;
  }
}

module.exports = {
  HUB_SLUG,
  SITE_URL,
  pageUrlFor,
  performerShortcode,
  buildPageContent,
  buildSchemaGraph,
  seoFields,
  ensureHubPage,
  publishComedianPage,
  trashComedianPage,
};
