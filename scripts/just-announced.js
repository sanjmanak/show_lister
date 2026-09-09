#!/usr/bin/env node

/**
 * Comedy Houston — "Just announced" detector
 *
 * Compares events.json against config/announced-seen.json (a set of event
 * ids already observed) and appends any newcomers to
 * config/just-announced.json — a rolling feed of {id, name, venue, date,
 * price, image_url, ticket_url, notable, first_seen}. Runs inside the
 * update-events workflow right after the fetch, so the feed is always
 * current and nobody ever has to diff events.json by hand.
 *
 * "Notable" is decided by scripts/lib/announce-rules.js against
 * config/announce-venues.json: big rooms (arenas, theaters, music halls),
 * headliner clubs, or an unlisted venue whose face-value floor is high,
 * minus showcases, recurring series and shows fewer than two weeks out.
 * Every feed entry is re-scored on every run, so a rule change applies to
 * the whole rolling window, not just to newcomers.
 *
 * Idempotent; state and feed are committed like the other config caches.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EVENTS = path.join(ROOT, "events.json");
const SEEN = path.join(ROOT, "config", "announced-seen.json");
const FEED = path.join(ROOT, "config", "just-announced.json");
const FEED_MAX = 200; // rolling window; old entries fall off

const rules = require("./lib/announce-rules");

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

const events = loadJson(EVENTS, { events: [] }).events || [];
const seen = new Set(loadJson(SEEN, { ids: [] }).ids || []);
const feed = loadJson(FEED, { announcements: [] }).announcements || [];

const firstRun = seen.size === 0;
const now = new Date().toISOString();
const ctx = rules.buildContext(events);
const fresh = [];

for (const ev of events) {
  if (!ev.id || seen.has(ev.id)) continue;
  seen.add(ev.id);
  if (firstRun) continue; // seed silently — don't flag the whole backlog
  const verdict = rules.classify(ev, ctx);
  fresh.push({
    id: ev.id,
    name: ev.name,
    venue: ev.venue,
    date: ev.date,
    time: ev.time,
    price_min: ev.price_min,
    price_max: ev.price_max,
    image_url: ev.image_url || "",
    ticket_url: ev.ticket_url || "",
    source: ev.source,
    notable: verdict.notable,
    tier: verdict.tier,
    notable_reason: verdict.reason,
    first_seen: now,
  });
}

// Re-score the existing window too: rules change, entries should follow.
const merged = feed.concat(fresh).slice(-FEED_MAX).map((a) => {
  const v = rules.classify(a, ctx);
  return { ...a, notable: v.notable, tier: v.tier, notable_reason: v.reason };
});
fs.writeFileSync(SEEN, JSON.stringify({ updated: now, ids: [...seen].sort() }, null, 0) + "\n");
fs.writeFileSync(FEED, JSON.stringify({ updated: now, announcements: merged }, null, 1) + "\n");

if (firstRun) {
  console.log(`Just announced: seeded ${seen.size} existing event ids (no announcements flagged on first run).`);
} else {
  const freshIds = new Set(fresh.map((f) => f.id));
  const freshScored = merged.filter((a) => freshIds.has(a.id));
  console.log(`Just announced: ${fresh.length} new event(s), ${freshScored.filter((f) => f.notable).length} notable.`);
  for (const f of freshScored.filter((f) => f.notable)) {
    console.log(`  NOTABLE (${f.notable_reason}): ${f.name} @ ${f.venue} on ${f.date} ($${f.price_min ?? "?"}-${f.price_max ?? "?"})`);
  }
}
