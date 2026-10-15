/**
 * Comedy Houston — comedian registry.
 *
 * One record per comedian who has ever earned a spotlight, keyed by a stable
 * slug ("dave-chappelle"). It is the source of truth for the evergreen
 * /comedians/{slug}/ pages: the written profile, the research it was built
 * from, every Houston date we have seen for them, the WordPress page id and
 * URL, and the dated slugs of the old per-show spotlight posts so the plugin
 * can 301 them to the page that replaced them.
 *
 * Why a registry rather than re-deriving everything from manifests: the
 * manifests are per-week Instagram artefacts that get archived once a show
 * week ends. A comedian's page outlives any one show, and when they come
 * back to Houston the generator must find the existing page, add the new
 * date and republish it, with no OpenAI spend unless the profile is older
 * than REWRITE_AFTER_DAYS.
 *
 * File: blog/comedians/registry.json (committed, like the manifests).
 * Index for the WordPress plugin: blog/comedians/comedians-index.json, a
 * compact projection the plugin fetches from GitHub with a one-hour
 * transient (name, match terms, page URL, legacy slugs). The index name
 * deliberately does not start with "manifest" so the reaper's manifest scan
 * ignores it.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REGISTRY_NAME = "registry.json";
const INDEX_NAME = "comedians-index.json";
const REGISTRY_VERSION = 1;

/**
 * Lowercase, strip diacritics ("Iván" → "ivan", "Güven" → "guven"), drop
 * punctuation, collapse whitespace. Shared contract with the plugin's
 * normalize_match_text(): both sides must agree or "Iván Fematt" never
 * matches "Iván Fematt La Mole (En Español)".
 */
function normalizeName(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** "José Rafael Guzmán" → "jose-rafael-guzman" (the old slugify dropped the accented letters: "jos-rafael-guzmn"). */
function slugForName(name) {
  return normalizeName(name).replace(/\s/g, "-").slice(0, 60).replace(/^-|-$/g, "");
}

function todayChicago() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function registryPath(dir) {
  return path.join(dir, REGISTRY_NAME);
}

function loadRegistry(dir) {
  const p = registryPath(dir);
  if (!fs.existsSync(p)) {
    return { version: REGISTRY_VERSION, updated_at: null, comedians: [] };
  }
  const reg = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(reg.comedians)) reg.comedians = [];
  return reg;
}

function saveRegistry(dir, reg) {
  reg.version = REGISTRY_VERSION;
  reg.updated_at = new Date().toISOString();
  reg.comedians.sort((a, b) => a.slug.localeCompare(b.slug));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryPath(dir), JSON.stringify(reg, null, 2) + "\n");
}

/** Find by slug, exact normalized name, or any match term. */
function findComedian(reg, name) {
  const norm = normalizeName(name);
  if (!norm) return null;
  const slug = slugForName(name);
  return (
    reg.comedians.find((c) => c.slug === slug) ||
    reg.comedians.find((c) => normalizeName(c.name) === norm) ||
    reg.comedians.find((c) => (c.match || []).includes(norm)) ||
    null
  );
}

function createComedian(reg, name) {
  const entry = {
    slug: slugForName(name),
    name: String(name).trim(),
    match: [normalizeName(name)],
    status: "live",
    created_at: new Date().toISOString(),
    profile_written_at: null,
    profile_html: "",
    research_json: "",
    sameAs: [],
    instagramHandle: "",
    imageUrl: "",
    wpPageId: 0,
    wpLink: "",
    wpImageMediaId: 0,
    legacy_slugs: [],
    shows: [],
    archived_at: null,
  };
  reg.comedians.push(entry);
  return entry;
}

/**
 * Add a match term so the plugin's performer filter catches shows whose
 * title does not contain the comedian's name ("Kill Tony" for Tony
 * Hinchcliffe). The caller passes the event title; it is only added when the
 * existing terms do not already match it, and stored normalized.
 */
function ensureMatchForEvent(entry, eventName) {
  const norm = normalizeName(eventName);
  if (!norm) return false;
  if ((entry.match || []).some((t) => norm.includes(t))) return false;
  entry.match = [...(entry.match || []), norm];
  return true;
}

/** Record a Houston date (idempotent on date + venue). Returns true when added. */
function recordShow(entry, ev) {
  if (!ev || !ev.date) return false;
  const key = `${ev.date}|${normalizeName(ev.venue)}`;
  entry.shows = entry.shows || [];
  if (entry.shows.some((s) => `${s.date}|${normalizeName(s.venue)}` === key)) return false;
  entry.shows.push({
    date: ev.date,
    venue: ev.venue || "",
    time: ev.time || "",
    name: ev.name || "",
    ticket_url: ev.ticket_url || "",
    event_id: ev.id || "",
    image_url: ev.image_url || "",
  });
  entry.shows.sort((a, b) => a.date.localeCompare(b.date));
  return true;
}

function pastShows(entry, today = todayChicago()) {
  return (entry.shows || []).filter((s) => s.date < today);
}

function upcomingShows(entry, today = todayChicago()) {
  return (entry.shows || []).filter((s) => s.date >= today);
}

function lastShowDate(entry) {
  const dates = (entry.shows || []).map((s) => s.date).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

function profileAgeDays(entry, now = new Date()) {
  if (!entry.profile_written_at) return Infinity;
  const t = Date.parse(entry.profile_written_at);
  if (isNaN(t)) return Infinity;
  return (now.getTime() - t) / 86400000;
}

/**
 * The compact projection the WordPress plugin reads. Only live comedians
 * with a published page; the plugin uses `match` for the performer filter
 * and the hub, `legacy_slugs` for the 301s from retired spotlight URLs.
 */
function writeComediansIndex(dir, reg) {
  const comedians = reg.comedians
    .filter((c) => c.status === "live" && c.wpLink)
    .map((c) => ({
      slug: c.slug,
      name: c.name,
      match: c.match || [normalizeName(c.name)],
      wpLink: c.wpLink,
      legacy_slugs: c.legacy_slugs || [],
      next_show: upcomingShows(c)[0] ? upcomingShows(c)[0].date : null,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  // Archived comedians keep their legacy redirects pointing at the hub so a
  // link from an old Instagram post never 404s.
  const archived_legacy = reg.comedians
    .filter((c) => c.status !== "live")
    .flatMap((c) => c.legacy_slugs || []);
  const out = { generated_at: new Date().toISOString(), comedians, archived_legacy_slugs: archived_legacy };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, INDEX_NAME), JSON.stringify(out, null, 2) + "\n");
  return comedians.length;
}

module.exports = {
  REGISTRY_NAME,
  INDEX_NAME,
  normalizeName,
  slugForName,
  todayChicago,
  loadRegistry,
  saveRegistry,
  findComedian,
  createComedian,
  ensureMatchForEvent,
  recordShow,
  pastShows,
  upcomingShows,
  lastShowDate,
  profileAgeDays,
  writeComediansIndex,
};
