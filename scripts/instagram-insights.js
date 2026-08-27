#!/usr/bin/env node

/**
 * Comedy Houston — Instagram insights reader
 *
 * Pulls per-post performance for the last ~50 IG posts plus account-level
 * daily reach, and writes reports/instagram-insights.json. Read-only: no
 * publishing, no state changes. Runs in CI where INSTAGRAM_ACCESS_TOKEN
 * lives (the token never leaves GitHub's environment; only aggregated
 * numbers are committed).
 *
 * Env: INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_USER_ID (same secrets as
 * post-to-instagram.js), optional GRAPH_API_VERSION (default v21.0).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || "";
const IG_USER_ID = process.env.INSTAGRAM_USER_ID || "";
const V = process.env.GRAPH_API_VERSION || "v21.0";
const OUT = path.join(__dirname, "..", "reports", "instagram-insights.json");

if (!TOKEN || !IG_USER_ID) {
  console.error("Missing INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_USER_ID");
  process.exit(1);
}

function get(pathAndQuery) {
  return new Promise((resolve, reject) => {
    https
      .get(`https://graph.facebook.com/${V}${pathAndQuery}`, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.error) return resolve({ __error: json.error.message });
            resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function main() {
  const media = await get(
    `/${IG_USER_ID}/media?fields=id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count&limit=50&access_token=${TOKEN}`
  );
  if (media.__error) throw new Error("media list: " + media.__error);

  const posts = [];
  for (const m of media.data || []) {
    // Metric availability differs by media type; request a broad set and
    // fall back to a minimal one on error rather than failing the post.
    const metricSets = [
      "reach,saved,shares,views,total_interactions",
      "reach,saved",
      "reach",
    ];
    let insights = null;
    for (const metrics of metricSets) {
      const r = await get(`/${m.id}/insights?metric=${metrics}&access_token=${TOKEN}`);
      if (!r.__error) {
        insights = {};
        for (const row of r.data || []) {
          insights[row.name] = row.values && row.values[0] ? row.values[0].value : null;
        }
        break;
      }
    }
    posts.push({
      id: m.id,
      type: m.media_product_type || m.media_type,
      timestamp: m.timestamp,
      permalink: m.permalink,
      caption_head: (m.caption || "").slice(0, 90),
      likes: m.like_count,
      comments: m.comments_count,
      insights,
    });
    process.stdout.write(".");
  }
  console.log("");

  const account = await get(
    `/${IG_USER_ID}?fields=followers_count,media_count&access_token=${TOKEN}`
  );

  const report = {
    generated_at: new Date().toISOString(),
    account: account.__error ? { error: account.__error } : account,
    posts,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${posts.length} posts)`);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
