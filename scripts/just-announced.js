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
 * "Notable" is a cheap heuristic meant to surface the Louis CK / Kill Tony
 * class of announcement: big-room venues or high ticket prices.
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

const BIG_ROOMS = [
  "toyota center", "smart financial", "713 music hall", "bayou music center",
  "house of blues", "arena theatre", "cullen performance", "the grand 1894",
  "hobby center", "nrg", "white oak music hall",
];

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

const events = loadJson(EVENTS, { events: [] }).events || [];
const seen = new Set(loadJson(SEEN, { ids: [] }).ids || []);
const feed = loadJson(FEED, { announcements: [] }).announcements || [];

const firstRun = seen.size === 0;
const now = new Date().toISOString();
const fresh = [];

for (const ev of events) {
  if (!ev.id || seen.has(ev.id)) continue;
  seen.add(ev.id);
  if (firstRun) continue; // seed silently — don't flag the whole backlog
  const venueLc = String(ev.venue || "").toLowerCase();
  const notable =
    BIG_ROOMS.some((r) => venueLc.includes(r)) ||
    (typeof ev.price_max === "number" && ev.price_max >= 60);
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
    notable,
    first_seen: now,
  });
}

const merged = feed.concat(fresh).slice(-FEED_MAX);
fs.writeFileSync(SEEN, JSON.stringify({ updated: now, ids: [...seen].sort() }, null, 0) + "\n");
fs.writeFileSync(FEED, JSON.stringify({ updated: now, announcements: merged }, null, 1) + "\n");

if (firstRun) {
  console.log(`Just announced: seeded ${seen.size} existing event ids (no announcements flagged on first run).`);
} else {
  console.log(`Just announced: ${fresh.length} new event(s), ${fresh.filter(f => f.notable).length} notable.`);
  for (const f of fresh.filter((f) => f.notable)) {
    console.log(`  NOTABLE: ${f.name} @ ${f.venue} on ${f.date} ($${f.price_min ?? "?"}-${f.price_max ?? "?"})`);
  }
}
