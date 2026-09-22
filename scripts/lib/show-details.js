/**
 * Show-details guarantee for the per-comedian spotlight posts.
 *
 * The writer prompt asks for the date, venue and a "Get Tickets" link woven
 * into the narrative. The fact-check pass then removes any sentence that is
 * not backed by the comedian research (the show logistics never are), and
 * the polish pass cuts the weakest paragraph to stay under 400 words. Across
 * the 20 spotlights live on 2026-09-22, only 11 named the show date in the
 * body and 5 carried a ticket link; the Sep 21-22 batches were at 3/10 and
 * 1/10 after the gpt-5.6 switch made the editors follow the removal rules
 * more literally.
 *
 * This module is the deterministic backstop: given the final HTML and the
 * verified show facts from our own listings, it checks whether the body
 * already names the show date and links to tickets, and inserts one plain
 * sentence before the post footer if not. No model involved, so it cannot
 * regress on a model change. Shared by generate-comedian-post.js (at
 * generation time) and backfill-show-details.js (for posts already live).
 */

const { addSponsoredRelToTicketLinks } = require("./sanitize-html");

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const TICKET_HOST_RE = /(?:ticketmaster|livenation|eventbrite|ticketweb|axs|frontgatetickets|standuptix|donttellcomedy|showclix|seetickets|etix|tixr|universe|dice\.fm|punchlinecomedyclub|improv\.com|theriotcomedy|secretgrouphtx|whiteoakmusichall)\./i;

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDateForDisplay(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** The article body: everything before the post footer / internal-link block. */
function bodyOnly(html) {
  const s = String(html || "");
  const cut = [s.indexOf('<div class="post-footer">'), s.indexOf("<h3>Also performing in Houston this week</h3>")]
    .filter((i) => i >= 0);
  return cut.length ? s.slice(0, Math.min(...cut)) : s;
}

function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** Does the body name the show date? Accepts "October 8", "Oct. 8", "Oct 8th", "10/8". */
function hasShowDate(html, dateStr) {
  const text = stripTags(bodyOnly(html));
  const [y, m, d] = String(dateStr).split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return false;
  const month = MONTHS[m - 1];
  const abbr = month.slice(0, 3);
  const re = new RegExp(`\\b(?:${month}|${abbr}\\.?)\\s+${d}(?:st|nd|rd|th)?\\b|\\b${m}/${d}(?:/${y}|/${String(y).slice(2)})?\\b`, "i");
  return re.test(text);
}

/** Does the body carry a ticket link (class, known host, or the exact URL)? */
function hasTicketLink(html, ticketUrl) {
  const body = bodyOnly(html);
  const anchors = body.match(/<a\b[^>]*>/gi) || [];
  return anchors.some((a) => {
    if (/class\s*=\s*"[^"]*\bticket-link\b[^"]*"/i.test(a)) return true;
    const href = (a.match(/href\s*=\s*"([^"]*)"/i) || [])[1] || "";
    if (!href) return false;
    if (ticketUrl && href === ticketUrl) return true;
    return TICKET_HOST_RE.test(href);
  });
}

/**
 * One plain sentence with the show logistics and the ticket link.
 * No hype, no em dashes (house rule for reader-facing copy).
 */
function buildShowDetailsParagraph(facts, { dateMissing = true } = {}) {
  const name = escapeHtml(facts.comedianName);
  const venue = escapeHtml(facts.venue);
  const when = escapeHtml(formatDateForDisplay(facts.date));
  const time = facts.time && /\d/.test(String(facts.time)) ? ` at ${escapeHtml(facts.time)}` : "";
  const link = facts.ticketUrl
    ? ` <a class="ticket-link" href="${escapeHtml(facts.ticketUrl)}">Get Tickets</a>.`
    : "";
  const sentence = dateMissing
    ? `<strong>${name}</strong> plays ${venue} on ${when}${time}.${link}`
    : `Tickets for the ${when} show at ${venue}:${link || " see the venue."}`;
  return addSponsoredRelToTicketLinks(`<p class="show-details">${sentence}</p>`);
}

/**
 * Insert the show-details paragraph if the body lacks the date or a ticket
 * link. Returns { html, inserted, dateMissing, ticketMissing }.
 */
function ensureShowDetails(html, facts) {
  const src = String(html || "");
  const dateMissing = !hasShowDate(src, facts.date);
  const ticketMissing = !!facts.ticketUrl && !hasTicketLink(src, facts.ticketUrl);
  if (!dateMissing && !ticketMissing) {
    return { html: src, inserted: false, dateMissing, ticketMissing };
  }
  if (/<p class="show-details">/.test(src)) {
    // Already backfilled once; don't stack a second paragraph.
    return { html: src, inserted: false, dateMissing, ticketMissing };
  }
  const para = buildShowDetailsParagraph(facts, { dateMissing });
  const markers = ['<div class="post-footer">', "<hr />\n<h3>Also performing in Houston this week</h3>", "<h3>Also performing in Houston this week</h3>"];
  for (const marker of markers) {
    const i = src.indexOf(marker);
    if (i >= 0) {
      return { html: src.slice(0, i) + para + "\n" + src.slice(i), inserted: true, dateMissing, ticketMissing };
    }
  }
  return { html: src.replace(/\s*$/, "") + "\n" + para, inserted: true, dateMissing, ticketMissing };
}

module.exports = {
  ensureShowDetails,
  hasShowDate,
  hasTicketLink,
  buildShowDetailsParagraph,
  formatDateForDisplay,
  bodyOnly,
};
