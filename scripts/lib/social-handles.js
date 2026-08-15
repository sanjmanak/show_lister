/**
 * Comedy Houston — Venue & series Instagram handle lookup.
 *
 * Reads config/social-handles.json (researched by hand — see that file's
 * _readme for why it isn't generated) and answers "who should this post
 * tag?".
 *
 * Two rules are enforced here rather than left to callers, because getting
 * either wrong is publicly embarrassing:
 *
 *   1. ONLY `confirmed` and `owner-confirmed` handles are ever returned.
 *      An `unverified` entry is research someone still has to eyeball; a
 *      tag on a wrong handle @s a stranger in front of their followers.
 *   2. Matching takes the FIRST hit on a most-specific-first list.
 *      "The Riot Comedy Club" is a substring of "The Riot Comedy Club —
 *      Conroe", so a naive scan tags Conroe shows with the Houston account.
 *      The config is ordered to make this correct; this module must not
 *      reorder or sort it.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.resolve(
  __dirname, "..", "..", "config", "social-handles.json"
);

const TAGGABLE = new Set(["confirmed", "owner-confirmed"]);

let cached = null;

function loadConfig() {
  if (cached) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    cached = {
      venues: Array.isArray(raw.venues) ? raw.venues : [],
      series: Array.isArray(raw.series) ? raw.series : [],
    };
  } catch (err) {
    // Never fatal: a missing or broken handle file must not stop a post
    // going out. Worst case the post publishes untagged, exactly as it
    // did before tagging existed.
    console.warn(`  ⚠ Could not read ${CONFIG_PATH}: ${err.message}. Posting untagged.`);
    cached = { venues: [], series: [] };
  }
  return cached;
}

function normalize(str) {
  return String(str || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function taggable(entry) {
  return !!(entry && entry.instagram && TAGGABLE.has(entry.confidence));
}

/** Handle for a venue name, or null. First match wins — see rule 2 above. */
function venueHandle(venueName) {
  const v = normalize(venueName);
  if (!v) return null;
  for (const entry of loadConfig().venues) {
    if (!entry || !entry.match) continue;
    if (v.includes(normalize(entry.match))) {
      return taggable(entry) ? entry.instagram : null;
    }
  }
  return null;
}

/**
 * Series entry matching an event title, or null. Returns the whole entry
 * so callers can honour `also_tag_venue` — a national show brand and the
 * local room it runs in are different audiences and both are worth having.
 */
function seriesEntry(eventTitle) {
  const t = normalize(eventTitle).replace(/-/g, " ");
  if (!t) return null;
  for (const entry of loadConfig().series) {
    if (!entry || !entry.title_match) continue;
    if (t.includes(normalize(entry.title_match))) return entry;
  }
  return null;
}

/**
 * Every handle worth tagging on a post about one show, in priority order:
 * the series account first when there is one (it's the more specific
 * subject), then the room. Deduped, nulls dropped.
 *
 * A series with `also_tag_venue: false` suppresses the venue — for a show
 * whose own account IS the room's audience, two tags is one too many.
 */
function handlesForEvent({ name, venue } = {}) {
  const out = [];
  const series = seriesEntry(name);
  if (series && taggable(series)) out.push(series.instagram);

  const suppressVenue = series && series.also_tag_venue === false;
  if (!suppressVenue) {
    const v = venueHandle(venue);
    if (v) out.push(v);
  }
  return [...new Set(out)];
}

/**
 * Venue handles for a set of events, busiest room first, capped.
 *
 * Ordering by show count is deliberate: on a weekly roundup the rooms
 * carrying the week deserve the tag over a room with a single booking, and
 * the cap keeps a weekly post from turning into a tag farm.
 */
function venueHandlesForEvents(events, limit = 8) {
  const counts = new Map();
  for (const ev of events || []) {
    const handle = venueHandle(ev && ev.venue);
    if (!handle) continue;
    counts.set(handle, (counts.get(handle) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([handle]) => handle);
}

/**
 * Meta wants an {x, y} per tag, in 0..1 image space. One tag keeps the
 * historical dead-centre position; several are spread down the middle so
 * the bubbles don't stack on top of each other when someone taps the photo.
 */
function toUserTags(handles) {
  const list = (handles || []).filter(Boolean);
  if (list.length === 0) return [];
  if (list.length === 1) return [{ username: list[0], x: 0.5, y: 0.5 }];
  return list.map((username, i) => ({
    username,
    x: 0.5,
    y: Math.min(0.9, 0.2 + (i * 0.6) / Math.max(1, list.length - 1)),
  }));
}

module.exports = {
  CONFIG_PATH,
  venueHandle,
  seriesEntry,
  handlesForEvent,
  venueHandlesForEvents,
  toUserTags,
  _resetCacheForTests: () => { cached = null; },
};
