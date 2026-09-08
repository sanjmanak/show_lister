/**
 * Comedy Houston — Shared image utilities.
 *
 * The display image for a comedian is the event's own ticket image
 * (Ticketmaster 16:9, Eventbrite, StandupTix venue card). It is the image
 * the venue chose for the show, it is already on the event record, and it
 * is what the comedian's own promo uses. Until Sept 2026 this module also
 * scraped Wikipedia / official sites for a headshot and ran a strict
 * quality gate over the candidates; that produced hot-sauce bottles and
 * logos often enough (and cost a slow network round per comedian) that the
 * whole scrape was retired. Git history has it if it is ever wanted back.
 *
 * What is left:
 *   - isUsableImageUrl(): cheap URL-shape check that rejects social-CDN
 *     profile glyphs and vector/animated files before they are rendered.
 *   - buildInitialsPlaceholder(): branded initials SVG for events with no
 *     image at all.
 *   - pickDisplayImage(): event image if usable, otherwise the placeholder.
 */

"use strict";

const SOCIAL_CDN_BLOCKLIST = [
  // Twitter / X
  "pbs.twimg.com/profile_images",
  "abs.twimg.com",
  // Instagram / Meta CDNs
  "cdninstagram.com",
  "scontent.cdninstagram",
  "instagram.f",         // scontent-XXX.fbcdn.net/... pattern
  "instagram.com/static",
  "lookaside.fbsbx",
  "lookaside.instagram",
  "fbcdn.net/safe_image",
  "fbcdn.net/v/",        // most profile-photo shortlinks live here
  // Generic "profile / avatar glyph" hints
  "profile_images",
  "profile_image",
  "profile_pic",
  "profilepic",
  "default_profile",
  "defaultprofile",
  "defaultuser",
  "default-user",
  "default-avatar",
  "default_avatar",
  "mystery_person",
  "mystery-person",
  "silhouette",
  "blank-profile",
  "blank_profile",
  "no-photo",
  "nophoto",
  "no-image",
  "noimage",
  "gravatar.com/avatar/0",
  "/avatar-default",
  // Exact-square sizing patterns that are almost always social glyphs
  "/150x150/",
  "/200x200/",
  "/300x300/",
  "/400x400/",
  "/512x512/",
  // allevents.in serves a default profile.png from upload-temp
  "allevents.in/transup",
];

const EXT_BLOCKLIST = [".svg", ".gif", ".ico"];

/**
 * Cheap URL-level safety check. Returns false for generic avatar/placeholder
 * URLs we never want to display. Used as a last-mile gate by the HTML
 * templates that embed event images (which never go through the full
 * strict-gate pipeline because they are trusted).
 */
function isUsableImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  const lower = url.toLowerCase();
  if (SOCIAL_CDN_BLOCKLIST.some((p) => lower.includes(p))) return false;
  if (EXT_BLOCKLIST.some((ext) => lower.endsWith(ext))) return false;
  return true;
}

/**
 * Returns a data-URI SVG with the comedian's initials over the brand
 * gradient. Used as the absolute floor when neither a scraped headshot
 * nor an event image is available.
 */
function buildInitialsPlaceholder(name) {
  const initials = (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#7c5cff"/>' +
    '<stop offset="1" stop-color="#ff4d6a"/>' +
    "</linearGradient></defs>" +
    '<rect width="200" height="200" fill="url(#g)"/>' +
    '<text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" ' +
    'font-family="Inter,Arial,sans-serif" font-size="80" font-weight="800" ' +
    'fill="#ffffff">' + initials + "</text></svg>";
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

/**
 * Resolve the image to render for a comedian / event tile.
 * opts: { eventImageUrl, comedianName }
 * Returns { displayImage, source: "event" | "initials" }.
 */
function pickDisplayImage(opts) {
  const eventImageUrl = opts && opts.eventImageUrl ? opts.eventImageUrl : "";
  const comedianName = opts && opts.comedianName ? opts.comedianName : "";
  if (eventImageUrl && isUsableImageUrl(eventImageUrl)) {
    return { displayImage: eventImageUrl, source: "event" };
  }
  return { displayImage: buildInitialsPlaceholder(comedianName), source: "initials" };
}

module.exports = {
  SOCIAL_CDN_BLOCKLIST,
  EXT_BLOCKLIST,
  isUsableImageUrl,
  buildInitialsPlaceholder,
  pickDisplayImage,
};
