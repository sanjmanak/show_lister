#!/usr/bin/env node

/**
 * Comedy Houston — "Just announced" autoposter.
 *
 * Turns notable new listings (config/just-announced.json, written by
 * just-announced.js inside the events workflow) into an Instagram post the
 * same day, with an LLM gate in front so only real headliner announcements
 * go out: a named comedian, a compelling one-line hook, a caption in house
 * style. Showcases, open mics, "Comedy & Drinks" series and anything the
 * model cannot identify as a touring comic are skipped and recorded so
 * they are not re-evaluated every run.
 *
 * Two phases, because Meta fetches media from a public URL and the files
 * must be on `main` first (same pattern as post-tonight.js):
 *
 *   --render   pick candidates, run the LLM gate, render the card(s) and,
 *              when assets/music/ has a track and ffmpeg exists, a 10s reel.
 *              Writes blog/announce/<slug>-{portrait,story}.png[, .mp4] and
 *              blog/announce/pending.json. The workflow commits + pushes.
 *   --post     reads pending.json, posts IG feed (reel or image) + IG story
 *              + FB feed, records config/announced-posted.json.
 *
 * Env: OPENAI_API_KEY (render), INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_USER_ID
 * (post), ANNOUNCE_MAX (default 1 per run), ANNOUNCE_WINDOW_HOURS (default
 * 48), DRY_RUN (render only logs the decision; post only logs).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const FEED = path.join(ROOT, "config", "just-announced.json");
const STATE = path.join(ROOT, "config", "announced-posted.json");
const OUT_DIR = path.join(ROOT, "blog", "announce");
const PENDING = path.join(OUT_DIR, "pending.json");
const MUSIC_DIR = path.join(ROOT, "assets", "music");
const RAW_BASE = "https://raw.githubusercontent.com/sanjmanak/show_lister/main/blog/announce";

const MAX = Math.max(1, parseInt(process.env.ANNOUNCE_MAX || "1", 10) || 1);
const WINDOW_H = parseInt(process.env.ANNOUNCE_WINDOW_HOURS || "48", 10) || 48;
const DRY_RUN = !!process.env.DRY_RUN && process.env.DRY_RUN !== "false";
const MIN_DAYS_OUT = 5;        // a show this week is not an "announcement"
const REPOST_GAP_DAYS = 45;    // same performer not twice in this window
const RETENTION_DAYS = 14;     // rendered assets pruned after this
const REEL_SECONDS = 10;

const args = process.argv.slice(2);
const PHASE = args.includes("--post") ? "post" : "render";

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}
function loadState() {
  return loadJson(STATE, { posted: [], skipped: [] });
}
function daysBetween(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / 86400000;
}

// ---------------------------------------------------------------------------
// Render phase
// ---------------------------------------------------------------------------

async function llmGate(a) {
  const { chatCompletion, stripFences } = require("./lib/openai");
  const system =
    "You screen new Houston comedy listings for an Instagram 'Just announced' post. " +
    "Only a headline show by a named, recognizable stand-up comedian (or comedy duo/podcast act) qualifies: " +
    "someone with specials, TV, a national tour, or a large following. Showcases, open mics, recurring series, " +
    "improv nights, drag brunches, tribute acts, festivals without a named headliner, and anything you cannot " +
    "identify with confidence do NOT qualify. Never invent credits. Reply with JSON only.";
  const { displayVenue } = require("./lib/announce-card");
  const user = `Listing title: ${a.name}
Venue: ${displayVenue(a.venue)}
Date: ${a.date}${a.time ? " " + a.time : ""}
Price: ${a.price_min != null ? "$" + a.price_min : "unknown"}${a.price_max != null ? " to $" + a.price_max : ""}
Source: ${a.source}

Return JSON:
{
  "qualifies": true|false,
  "performer_name": "the comedian's name as fans write it, or null",
  "confidence": 0.0-1.0,
  "reason": "one short sentence",
  "hook": "one line, max 110 characters, written like a headline a comedy editor would run: a concrete credential or reason to care (a named special, a show they host, a tour name, a milestone) with some attitude. Examples of the register: 'Two Netflix specials and a sitcom later, the Tennessee grandmother is playing arenas.' / 'The Chelsea Lately host, back on the road with new material.' Do NOT mention the venue, the city or the date here. No hype words, no exclamation points, no emojis, no em dashes.",
  "caption": "1 to 2 short sentences that do NOT repeat the hook: where and when (venue name, date written out), plus one specific detail if you have one. Then end with exactly: Tickets on sale now. Link in bio. No hashtags, no emojis, no em dashes, no exclamation points."
}

Banned words and shapes anywhere in hook or caption: "brings", "takes the stage", "comes to", "heads to", "hits", "don't miss", "must-see", "get ready", "hilarious", "iconic", "legendary", rhetorical questions.`;
  const text = await chatCompletion({ system, user, maxTokens: 600, effort: "low", jsonMode: true });
  const parsed = JSON.parse(stripFences(text));
  return parsed;
}

function pruneOld() {
  if (!fs.existsSync(OUT_DIR)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f === "pending.json" || f === ".gitkeep") continue;
    const p = path.join(OUT_DIR, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
  }
}

function pickMusic() {
  if (!fs.existsSync(MUSIC_DIR)) return null;
  // Audio files or videos: ffmpeg maps the audio stream ([1:a]) either way,
  // so an .mp4/.mov with a song in it works without a conversion step.
  const tracks = fs.readdirSync(MUSIC_DIR).filter((f) => /\.(mp3|m4a|wav|aac|ogg|mp4|mov|m4v)$/i.test(f));
  if (!tracks.length) return null;
  return path.join(MUSIC_DIR, tracks[Math.floor(Math.random() * tracks.length)]);
}

function haveFfmpeg() {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return r.status === 0;
}

/** Still card -> 10s 1080x1920 reel with a slow push-in and a faded track. */
function renderReel(storyPng, music, outMp4) {
  const frames = REEL_SECONDS * 30;
  const vf =
    `scale=1296:2304,zoompan=z='min(zoom+0.0006,1.2)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30,` +
    `format=yuv420p`;
  const argv = [
    "-y", "-loglevel", "error",
    "-loop", "1", "-i", storyPng,
    "-i", music,
    "-filter_complex", `[0:v]${vf}[v];[1:a]apad,atrim=0:${REEL_SECONDS},afade=t=in:st=0:d=0.5,afade=t=out:st=${REEL_SECONDS - 1.5}:d=1.5[a]`,
    "-map", "[v]", "-map", "[a]",
    "-t", String(REEL_SECONDS),
    "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-r", "30",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-movflags", "+faststart", "-shortest",
    outMp4,
  ];
  const r = spawnSync("ffmpeg", argv, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg exited ${r.status}`);
}

async function renderPhase() {
  const feed = loadJson(FEED, { announcements: [] }).announcements || [];
  const state = loadState();
  const { isUsableImageUrl } = require("./lib/image-utils");
  const cutoff = Date.now() - WINDOW_H * 3600 * 1000;
  const today = new Date().toISOString().slice(0, 10);
  const done = new Set([...state.posted, ...state.skipped].map((x) => x.id));

  const candidates = feed.filter((a) =>
    a.notable &&
    !done.has(a.id) &&
    new Date(a.first_seen).getTime() >= cutoff &&
    a.date && daysBetween(a.date, today) >= MIN_DAYS_OUT && a.date > today &&
    a.image_url && isUsableImageUrl(a.image_url)
  );
  console.log(`Candidates in the last ${WINDOW_H}h: ${candidates.length}`);
  if (!candidates.length) { saveJson(PENDING, { items: [] }); return; }

  // Cheapest filter first: obvious series/showcase titles never reach the model.
  const junk = /open mic|showcase|comedy & drinks|comedy and drinks|speakeasy|karaoke|trivia|drag|improv night|brunch|variety|new faces|roast battle|bring your own/i;
  const picks = [];
  for (const a of candidates.sort((x, y) => (y.price_max || 0) - (x.price_max || 0))) {
    if (junk.test(a.name)) {
      console.log(`  skip (title pattern): ${a.name}`);
      state.skipped.push({ id: a.id, name: a.name, reason: "title pattern", at: new Date().toISOString() });
      continue;
    }
    let verdict;
    try {
      verdict = await llmGate(a);
    } catch (err) {
      console.log(`  gate error for ${a.name}: ${err.message} (left for next run)`);
      continue;
    }
    const ok = verdict && verdict.qualifies && verdict.performer_name && (verdict.confidence || 0) >= 0.75;
    console.log(`  ${ok ? "PASS" : "skip"} ${a.name} -> ${verdict && verdict.performer_name} (${verdict && verdict.confidence}) ${verdict && verdict.reason}`);
    if (!ok) {
      state.skipped.push({ id: a.id, name: a.name, reason: (verdict && verdict.reason) || "gate", at: new Date().toISOString() });
      continue;
    }
    const recent = state.posted.find((p) =>
      p.performer_name && p.performer_name.toLowerCase() === verdict.performer_name.toLowerCase() &&
      daysBetween(p.posted_at, new Date().toISOString()) < REPOST_GAP_DAYS);
    if (recent) {
      console.log(`  skip (posted ${verdict.performer_name} on ${recent.posted_at.slice(0, 10)})`);
      state.skipped.push({ id: a.id, name: a.name, reason: "recent repost", at: new Date().toISOString() });
      continue;
    }
    picks.push({ ...a, performer_name: verdict.performer_name, hook: verdict.hook, caption: verdict.caption, confidence: verdict.confidence });
    if (picks.length >= MAX) break;
  }

  if (!DRY_RUN) saveJson(STATE, state);
  if (!picks.length) { saveJson(PENDING, { items: [] }); console.log("Nothing to post."); return; }

  const puppeteer = require("puppeteer");
  const { cardHTML, photoDataUri, slugify, SIZES, displayVenue } = require("./lib/announce-card");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  pruneOld();
  const music = pickMusic();
  const reelsOn = !!music && haveFfmpeg();
  console.log(`Reel mode: ${reelsOn ? "ON (" + path.basename(music) + ")" : "off (" + (music ? "no ffmpeg" : "no track in assets/music") + ")"}`);

  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const items = [];
  try {
    const page = await browser.newPage();
    for (const a of picks) {
      const slug = `${a.date}-${slugify(a.performer_name)}`;
      const dataUri = await photoDataUri(a.image_url);
      const files = {};
      for (const size of ["portrait", "story"]) {
        const { w, h } = SIZES[size];
        const html = path.join(OUT_DIR, `${slug}-${size}.html`);
        const png = path.join(OUT_DIR, `${slug}-${size}.png`);
        fs.writeFileSync(html, cardHTML(a, dataUri, size));
        await page.setViewport({ width: w, height: h });
        await page.goto("file://" + html, { waitUntil: "networkidle0", timeout: 45000 });
        await page.screenshot({ path: png, type: "png" });
        fs.unlinkSync(html);
        files[size] = path.basename(png);
        console.log(`  rendered ${files[size]}`);
      }
      if (reelsOn) {
        try {
          const mp4 = path.join(OUT_DIR, `${slug}.mp4`);
          renderReel(path.join(OUT_DIR, files.story), music, mp4);
          files.reel = path.basename(mp4);
          console.log(`  rendered ${files.reel} (${Math.round(fs.statSync(mp4).size / 1024)} KB)`);
        } catch (err) {
          console.log(`  reel render failed (${err.message}); posting the image instead`);
        }
      }
      const venueLine = `${a.performer_name} at ${displayVenue(a.venue)}, ${new Date(a.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}.`;
      const caption = [a.hook, a.caption || venueLine, "", "#houstoncomedy #comedyhouston #standupcomedy #houston"].join("\n");
      items.push({ id: a.id, name: a.name, performer_name: a.performer_name, venue: a.venue, date: a.date, ticket_url: a.ticket_url, files, caption, confidence: a.confidence });
    }
  } finally {
    await browser.close();
  }
  saveJson(PENDING, { generated_at: new Date().toISOString(), dry_run: DRY_RUN, items });
  console.log(`Wrote ${PENDING} (${items.length} item(s))${DRY_RUN ? " [DRY RUN]" : ""}`);
}

// ---------------------------------------------------------------------------
// Post phase
// ---------------------------------------------------------------------------

async function postReel(videoUrl, caption, meta) {
  const { graphRequest, IG_USER_ID, IG_ACCESS_TOKEN, publishWithRetry } = meta;
  console.log("   Creating reel container…");
  const container = await graphRequest("POST", `/${IG_USER_ID}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: true,
    access_token: IG_ACCESS_TOKEN,
  });
  // Video containers take longer than images; poll up to ~4 minutes.
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    let status;
    try {
      status = await graphRequest("GET", `/${container.id}`, { fields: "status_code,status", access_token: IG_ACCESS_TOKEN });
    } catch (err) {
      console.log(`   status poll ${i + 1}: ${err.message}`);
      continue;
    }
    console.log(`   status ${i + 1}: ${status.status_code}${status.status ? " " + status.status : ""}`);
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR") throw new Error(`Reel container error: ${status.status}`);
  }
  console.log("   Publishing reel…");
  return publishWithRetry(container.id, "Reel");
}

async function postPhase() {
  const pending = loadJson(PENDING, { items: [] });
  if (!pending.items || !pending.items.length) { console.log("No pending announcements."); return; }
  if (pending.dry_run) { console.log("pending.json is from a dry run; not posting."); return; }
  const meta = require("./lib/meta-api");
  const { handlesForEvent, toUserTags } = require("./lib/social-handles");
  const state = loadState();
  await meta.validateTokenAndGuards();
  const fbPageId = await meta.resolveFacebookPageId();
  const timeout = parseInt(process.env.IG_CHANNEL_TIMEOUT_MS || "300000", 10);

  for (const item of pending.items) {
    if (state.posted.some((p) => p.id === item.id)) { console.log(`already posted: ${item.name}`); continue; }
    const portraitUrl = `${RAW_BASE}/${item.files.portrait}`;
    const storyUrl = `${RAW_BASE}/${item.files.story}`;
    const reelUrl = item.files.reel ? `${RAW_BASE}/${item.files.reel}` : null;
    console.log(`\n📣 ${item.performer_name} (${item.venue}, ${item.date})`);
    if (DRY_RUN) { console.log("   DRY RUN: would post\n" + item.caption); continue; }
    await meta.waitForImageUrl(portraitUrl);
    await meta.waitForImageUrl(storyUrl);
    const tags = toUserTags(handlesForEvent({ name: item.name, venue: item.venue }));
    const record = { id: item.id, name: item.name, performer_name: item.performer_name, venue: item.venue, date: item.date, posted_at: new Date().toISOString(), mode: reelUrl ? "reel" : "image" };

    // Anchor: IG feed. Reel if we have one, image otherwise; a reel failure
    // falls back to the image rather than losing the post.
    try {
      if (reelUrl) {
        try {
          const r = await meta.withTimeout(postReel(reelUrl, item.caption, meta), "IG Reel", timeout);
          record.ig_media_id = r.id;
        } catch (err) {
          console.log(`   reel failed (${err.message}); posting image`);
          record.mode = "image";
          const r = await meta.withTimeout(meta.postIgFeedImage(portraitUrl, item.caption, tags), "IG Feed", timeout);
          record.ig_media_id = r.id || r;
        }
      } else {
        const r = await meta.withTimeout(meta.postIgFeedImage(portraitUrl, item.caption, tags), "IG Feed", timeout);
        record.ig_media_id = r.id || r;
      }
      console.log(`   IG posted (${record.mode}): ${record.ig_media_id}`);
    } catch (err) {
      console.error(`   IG feed failed: ${err.message}`);
      throw err;
    }
    try {
      const r = await meta.withTimeout(meta.postIgStoryImage(storyUrl), "IG Story", timeout);
      record.ig_story_id = r.id || r;
    } catch (err) { console.log(`   IG story failed (non-fatal): ${err.message}`); }
    if (fbPageId) {
      try {
        const r = await meta.withTimeout(meta.postFbFeedPhoto(fbPageId, portraitUrl, item.caption), "FB Feed", timeout);
        record.fb_post_id = r.id || r.post_id || r;
      } catch (err) { console.log(`   FB feed failed (non-fatal): ${err.message}`); }
    }
    state.posted.push(record);
    saveJson(STATE, state);
  }
  saveJson(PENDING, { items: [] });
  if (typeof meta.shutdown === "function") meta.shutdown(0);
}

(PHASE === "post" ? postPhase() : renderPhase()).catch((err) => {
  console.error(`post-announcements (${PHASE}) failed: ${err.message}`);
  process.exit(1);
});
