/**
 * Comedy Houston — Shared tonight-post-state.json access.
 *
 * State shape (v2):
 *
 *   {
 *     "last_posted_date": "YYYY-MM-DD",   // dedupe guard for post-tonight.js
 *     "posted": [                          // one entry per posted night, oldest first
 *       { "date": "YYYY-MM-DD",
 *         "igFeedMediaId": "…", "igStoryMediaId": "…",
 *         "fbFeedPostId": "…", "fbStoryPostId": "…",
 *         "postedAt": "ISO timestamp" }
 *     ]
 *   }
 *
 * The array exists so delete-tonight-posts.js can find and delete posts once
 * they age past the retention window — the old single `last_results` object
 * was overwritten daily, losing the IDs deletion needs.
 *
 * Legacy migration: v1 files carried a single `last_results` object. Per the
 * forward-only retention decision (auto-delete only applies to posts made
 * AFTER this feature shipped), the legacy entry is discarded — that post
 * stays up, like the rest of the pre-existing backlog.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const STATE_PATH = path.resolve(
  __dirname, "..", "..", "blog", "tonight", "tonight-post-state.json"
);

function loadTonightState() {
  const state = fs.existsSync(STATE_PATH)
    ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))
    : { last_posted_date: null };

  if (!Array.isArray(state.posted)) state.posted = [];

  if (state.last_results) {
    console.log(
      "State migration: dropping legacy last_results entry " +
      `(${state.last_posted_date}) — pre-feature posts are not auto-deleted.`
    );
    delete state.last_results;
  }

  return state;
}

function saveTonightState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  console.log(`State saved → ${STATE_PATH}`);
}

module.exports = { STATE_PATH, loadTonightState, saveTonightState };
