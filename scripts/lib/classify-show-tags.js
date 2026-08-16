/**
 * LLM-assisted show tagging.
 *
 * Config rules in config/show-tags.json handle the recurring, obvious cases
 * (title billing like "(En Español)"). This module covers everything else:
 * new headliners and one-off shows get classified once by the model, cached
 * in config/show-tags-cache.json, and the tags auto-apply.
 *
 * Design decisions (owner call, 2026-08-15):
 *   - AUTO-APPLY, opt-out. A curated discovery page tolerates an occasional
 *     false positive far better than it tolerates missing shows. Wrong tags
 *     are removed by adding an entry to `exclusions` in show-tags.json —
 *     exclusions always win, over both config rules and the model.
 *   - Classified ONCE per show name, then cached forever (cache is committed
 *     like price-cache.json). Re-runs cost zero API calls until new show
 *     names appear.
 *   - Fail open: if the API key is missing or OpenAI is down, the import
 *     continues without model tags. The site build must never depend on a
 *     third-party API succeeding.
 *
 * Taxonomy is intentionally tiny — only tags that have a landing page:
 *   black-comedy — Black comedy shows/showcases and Black headliners
 *   en-espanol   — shows performed in Spanish
 */
"use strict";

const https = require("https");
const fs = require("fs");

const TAGS = ["black-comedy", "en-espanol"];
const BATCH_SIZE = 60;
const TIMEOUT_MS = 90000;

const SYSTEM_PROMPT = [
  "You classify Houston stand-up comedy shows for a listings site with",
  "audience-interest pages. For each show, assign zero or more tags:",
  "",
  '  "black-comedy": the show is a Black comedy showcase, is billed toward',
  "  Black audiences, or is headlined by a Black comedian. When you are",
  "  reasonably confident, tag it; light false positives are acceptable and",
  "  a human reviews the page weekly.",
  '  "en-espanol": the show is performed in Spanish.',
  "",
  "Use your knowledge of working comedians. If a name is unknown to you and",
  "the title/description give no signal, assign no tags.",
  "",
  "Respond with ONLY a JSON object mapping each show's id to an array of",
  'tags, e.g. {"1": ["black-comedy"], "2": [], "3": ["en-espanol"]}.',
].join("\n");

function callOpenAI(apiKey, model, userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
      max_tokens: 4000,
    });
    const req = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`OpenAI ${res.statusCode}: ${data.slice(0, 300)}`));
          }
          try {
            resolve(JSON.parse(JSON.parse(data).choices[0].message.content));
          } catch (e) {
            reject(new Error(`Bad OpenAI response: ${e.message}`));
          }
        });
      }
    );
    req.setTimeout(TIMEOUT_MS, () =>
      req.destroy(new Error(`OpenAI request timed out after ${TIMEOUT_MS}ms`))
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function cacheKey(name) {
  return String(name || "").toLowerCase().trim();
}

function loadCache(cachePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return raw && typeof raw.shows === "object" ? raw : { shows: {} };
  } catch (e) {
    return { shows: {} };
  }
}

/**
 * Classify any events whose (normalized) name is not yet in the cache, then
 * return a Map of cacheKey -> tags[] covering EVERY event passed in.
 * Mutates and persists the cache file when new names were classified.
 */
async function classifyShowTags(events, cachePath) {
  const apiKey = process.env.OPENAI_API_KEY || "";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const cache = loadCache(cachePath);

  const unknown = [];
  const seen = new Set();
  for (const ev of events) {
    const key = cacheKey(ev.name);
    if (!key || seen.has(key) || cache.shows[key]) continue;
    seen.add(key);
    unknown.push({
      key,
      name: ev.name,
      venue: ev.venue || "",
      description: String(ev.description || "").slice(0, 200),
    });
  }

  if (unknown.length && !apiKey) {
    console.warn(
      `Show tags: OPENAI_API_KEY not set — skipping model classification of ${unknown.length} new show(s)`
    );
  } else if (unknown.length) {
    console.log(`Show tags: classifying ${unknown.length} new show name(s) via ${model}`);
    for (let i = 0; i < unknown.length; i += BATCH_SIZE) {
      const batch = unknown.slice(i, i + BATCH_SIZE);
      const lines = batch.map(
        (s, idx) =>
          `${idx}: ${s.name} @ ${s.venue}${s.description ? ` — ${s.description}` : ""}`
      );
      try {
        const result = await callOpenAI(apiKey, model, lines.join("\n"));
        for (let idx = 0; idx < batch.length; idx++) {
          const tags = (Array.isArray(result[String(idx)]) ? result[String(idx)] : [])
            .filter((t) => TAGS.includes(t))
            .sort();
          cache.shows[batch[idx].key] = {
            tags,
            model,
            classified_at: new Date().toISOString().slice(0, 10),
          };
        }
      } catch (e) {
        // Fail open: uncached names simply stay untagged this run and are
        // retried on the next import.
        console.warn(`Show tags: classification batch failed (${e.message}) — continuing`);
      }
    }
    try {
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n");
    } catch (e) {
      console.warn(`Show tags: could not write cache: ${e.message}`);
    }
  }

  const out = new Map();
  for (const ev of events) {
    const hit = cache.shows[cacheKey(ev.name)];
    out.set(cacheKey(ev.name), hit ? hit.tags : []);
  }
  return out;
}

module.exports = { classifyShowTags, cacheKey };
