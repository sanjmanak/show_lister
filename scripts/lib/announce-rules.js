/**
 * Comedy Houston — "Just announced" business rules (shared).
 *
 * One place that decides whether a listing is announcement-worthy, so the
 * feed flagger (just-announced.js), the local preview cards
 * (announce-cards.js) and the CI autoposter (post-announcements.js) agree.
 * The venue tiers and thresholds live in config/announce-venues.json; the
 * title patterns live here because they are code, not data.
 *
 *   const rules = require("./lib/announce-rules");
 *   const ctx = rules.buildContext(allEvents);   // series index, today
 *   rules.classify(event, ctx) -> { notable, tier, reason }
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_PATH = path.join(ROOT, "config", "announce-venues.json");
const EVENTS_PATH = path.join(ROOT, "events.json");

// Showcases, open mics, recurring series, themed nights. Cheap and applied
// before anything else, including the venue tiers.
const JUNK_TITLE =
  /open mic|show ?case|comedy (?:&|and) drinks|speakeasy|karaoke|trivia|\bdrag\b|improv|brunch|variety|new faces|roast|bring your own|\bbyob\b|all ?-?stars|comedy night|comedy show|night standup comedy|comedy late show|weekly|hosted by|dirty show|x[- ]rated|secret show|mixtape|comedy jam|comedy hour|comedy competition|\bcontest\b|\bfest\b|festival|dating game|game show/i;

// A club billing someone as its headliner is the announcement shape we want,
// even when their credits list "The Late Show" or "Late Night".
const HEADLINER_TITLE = /\bheadlin(?:es|er|ing)\b/i;

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const lc = (arr) => (Array.isArray(arr) ? arr : []).map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  return {
    minDaysOut: Number(raw.min_days_out) || 14,
    unlistedMinPrice: Number(raw.unlisted_venue_min_price) || 45,
    seriesWeeks: Number(raw.series_weeks) || 3,
    bigRooms: lc(raw.big_rooms),
    headlinerRooms: lc(raw.headliner_rooms),
    exclude: lc(raw.exclude),
  };
}

function isJunkTitle(name) {
  const n = String(name || "");
  if (HEADLINER_TITLE.test(n) && !/show ?case|open mic/i.test(n)) return false;
  return JUNK_TITLE.test(n);
}

/** "Comedy & Drinks in a Speakeasy: Thursday 7:30pm" -> "comedy drinks in a speakeasy" */
function seriesTitle(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?s?\b/g, " ")
    .replace(/\b\d{1,2}(:\d{2})?\s*[ap]\.?m\.?\b/g, " ")
    .replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, " ")
    .replace(/\b(early|late|first|second|1st|2nd)\s+show\b/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** ISO-8601 week id ("2026-W41") so Thu-Sat runs count as one week. */
function isoWeek(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  if (isNaN(d)) return null;
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function seriesKey(ev) {
  return `${String(ev.venue || "").toLowerCase().trim()}|${seriesTitle(ev.name)}`;
}

/** Map seriesKey -> Set of ISO weeks the title runs at that venue. */
function buildSeriesIndex(events) {
  const index = new Map();
  for (const ev of events || []) {
    if (!ev || !ev.date) continue;
    const key = seriesKey(ev);
    const wk = isoWeek(ev.date);
    if (!wk) continue;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(wk);
  }
  return index;
}

function daysOut(dateStr, today) {
  const a = new Date(dateStr + "T12:00:00Z");
  const b = new Date(today + "T12:00:00Z");
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

/**
 * @param {Array} events   full events.json list (for series detection).
 *                         Omit to load events.json from disk.
 * @param {object} [opts]  { today: "YYYY-MM-DD" }
 */
function buildContext(events, opts = {}) {
  const config = loadConfig();
  let list = events;
  if (!Array.isArray(list)) {
    try { list = JSON.parse(fs.readFileSync(EVENTS_PATH, "utf8")).events || []; } catch { list = []; }
  }
  return {
    config,
    series: buildSeriesIndex(list),
    today: opts.today || new Date().toISOString().slice(0, 10),
  };
}

function venueTier(venue, config) {
  const v = String(venue || "").toLowerCase();
  if (!v) return null;
  if (config.exclude.some((s) => v.includes(s))) return "excluded";
  if (config.bigRooms.some((s) => v.includes(s))) return "big_room";
  if (config.headlinerRooms.some((s) => v.includes(s))) return "headliner_room";
  return null;
}

/**
 * Decide whether one listing is announcement-worthy.
 * Returns { notable: boolean, tier: string|null, reason: string }.
 */
function classify(ev, ctx) {
  const { config } = ctx;
  const no = (reason) => ({ notable: false, tier: null, reason });

  if (!ev || !ev.date) return no("no date");
  const lead = daysOut(ev.date, ctx.today);
  if (lead === null) return no("bad date");
  if (lead < config.minDaysOut) return no(`only ${lead}d out (min ${config.minDaysOut})`);

  const tier = venueTier(ev.venue, config);
  if (tier === "excluded") return no("venue excluded");
  if (isJunkTitle(ev.name)) return no("title pattern");

  const weeks = ctx.series.get(seriesKey(ev));
  if (weeks && weeks.size >= config.seriesWeeks) return no(`recurring series (${weeks.size} weeks)`);

  if (tier === "big_room") return { notable: true, tier, reason: "big room" };
  if (tier === "headliner_room") return { notable: true, tier, reason: "headliner room" };

  const floor = typeof ev.price_min === "number" ? ev.price_min : null;
  if (floor !== null && floor >= config.unlistedMinPrice) {
    return { notable: true, tier: "unlisted_price", reason: `face value from $${floor}` };
  }
  return no("small room");
}

module.exports = { loadConfig, isJunkTitle, seriesTitle, isoWeek, buildSeriesIndex, buildContext, classify, venueTier };
