/**
 * Comedy Houston — spotlight index for the WordPress plugin.
 *
 * The plugin used to fetch blog/comedians/manifest.json to add a "More info"
 * link from each event card to its comedian spotlight post. Manifests became
 * week-keyed (manifest-YYYY-MM-DD.json, several weeks in flight) on
 * 2026-09-05 and nothing wrote the single file any more, so the plugin got a
 * 404 and every card silently lost the link for three weeks.
 *
 * This module writes blog/comedians/spotlight-index.json: one small file that
 * merges every week-keyed manifest on disk down to the four fields the plugin
 * matches on. It is rewritten whenever a manifest is written (Monday
 * generation) or removed (the daily reaper), and the plugin fetches it with a
 * one-hour transient cache.
 *
 * The name deliberately does not start with "manifest" so the reaper's
 * /^manifest(-date)?\.json$/ scan and the IG poster's week lookup ignore it.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const INDEX_NAME = "spotlight-index.json";
const WEEK_MANIFEST_RE = /^manifest-\d{4}-\d{2}-\d{2}\.json$/;

function localDateStr(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

/**
 * Rebuild the index from every manifest-*.json in `comediansDir`.
 * Keeps posts with a date on or after yesterday (Houston time) and a wpLink.
 * Returns the number of posts written.
 */
function writeSpotlightIndex(comediansDir) {
  const posts = [];
  const seen = new Set();
  const names = fs.existsSync(comediansDir)
    ? fs.readdirSync(comediansDir).filter((n) => WEEK_MANIFEST_RE.test(n)).sort()
    : [];
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const cutoff = localDateStr(yesterday);

  for (const name of names) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(comediansDir, name), "utf8"));
    } catch {
      continue;
    }
    for (const p of manifest.posts || []) {
      if (!p || !p.date || !p.comedianName || !p.wpLink || !p.slug) continue;
      if (p.date < cutoff) continue;
      const key = `${p.date}|${p.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      posts.push({ date: p.date, comedianName: p.comedianName, slug: p.slug, wpLink: p.wpLink, venue: p.venue || "" });
    }
  }
  posts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.slug.localeCompare(b.slug)));

  const out = { generated_at: new Date().toISOString(), source_manifests: names, posts };
  fs.mkdirSync(comediansDir, { recursive: true });
  fs.writeFileSync(path.join(comediansDir, INDEX_NAME), JSON.stringify(out, null, 2) + "\n");
  return posts.length;
}

module.exports = { writeSpotlightIndex, INDEX_NAME };
