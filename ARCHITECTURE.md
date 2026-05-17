# Show Lister — Complete Architecture Guide

> **Version:** 2.4.0 | **Last updated:** March 2026 | **Owner:** sanjmanak

---

## Table of Contents

1. [What Is This? (The Simple Version)](#what-is-this-the-simple-version)
2. [Business Value & Intended Audience](#business-value--intended-audience)
3. [System Overview](#system-overview)
4. [Component Deep Dive](#component-deep-dive)
   - [Event Fetcher](#1-event-fetcher-scriptsfetch-eventsjs)
   - [Static Website](#2-static-website-indexhtml)
   - [Blog Post Generator](#3-weekly-blog-post-generator-scriptsgenerate-blog-postjs)
   - [WordPress Plugin](#4-wordpress-plugin-wordpress)
   - [GitHub Actions Workflows](#5-github-actions-workflows)
   - [GitHub Pages Hosting](#6-github-pages-hosting)
5. [Data Flow Diagram](#data-flow-diagram)
6. [Event Data Schema](#event-data-schema)
7. [Secrets & Environment Variables](#secrets--environment-variables)
8. [File Map](#file-map)
9. [Making the Repo Private — Impact Assessment](#making-the-repo-private--impact-assessment)
10. [Security Audit](#security-audit)
11. [Cost & Billing Exposure](#cost--billing-exposure)

---

## What Is This? (The Simple Version)

Imagine you love comedy and live in Houston. There are dozens of comedy shows every week at places like the Houston Improv, The Riot, The Secret Group, and more. But finding them is annoying — you'd have to check Ticketmaster, Eventbrite, and each venue's website separately.

**Show Lister fixes that.** It's a robot that:

1. **Checks Ticketmaster and Eventbrite twice a day** for every comedy show happening in Houston
2. **Removes duplicates** (the same show often appears on both platforms)
3. **Builds a beautiful dark-themed website** listing every show with dates, prices, and ticket links
4. **Publishes it automatically** — no human has to press any buttons
5. **Every Monday morning**, it uses AI (OpenAI/ChatGPT) to write a blog post about the best shows that week, research the comedians performing, find their Instagram handles, and generate a ready-to-post Instagram caption with a 1080×1080 graphic
6. **Emails the caption + graphic** to somebody so they can post it on Instagram in minutes
7. **Has a WordPress plugin** so the same show listings can be embedded on any WordPress website

The whole thing runs for free on GitHub (hosting, automation, scheduling) with the only costs being the API keys (Ticketmaster and Eventbrite are free; OpenAI costs a few dollars per month).

**Think of it like this:** It's a personal assistant that watches every comedy venue in Houston and keeps a constantly-updated website + weekly Instagram content pipeline running — completely on autopilot.

---

## Business Value & Intended Audience

| Aspect | Details |
|--------|---------|
| **Primary user** | The repo owner — a comedy fan in Houston who wants a personal aggregator |
| **Website visitors** | Anyone looking for Houston comedy shows (friends, social media followers) |
| **WordPress audience** | Visitors to any WordPress site that embeds the plugin |
| **Instagram followers** | People who follow the associated Instagram account for weekly show roundups |
| **Revenue model** | Optional affiliate tracking (Ticketmaster/Eventbrite affiliate IDs via the WordPress plugin) |
| **Competitive advantage** | Automated, zero-maintenance, covers multiple sources, AI-generated content pipeline |
| **Why it exists** | Personal pet project — solves a real annoyance, generates social media content effortlessly |

---

## System Overview

There are **eight major components** that work together:

| # | Component | What It Does | Tech |
|---|-----------|-------------|------|
| 1 | **Event Fetcher** | Pulls shows from Ticketmaster + Eventbrite, deduplicates, writes JSON + HTML | Node.js script |
| 2 | **Static Website** | The public-facing show listing page (dark theme, filters, search) | Plain HTML/CSS/JS |
| 3 | **Blog Generator** | Weekly AI-written blog post + Instagram caption + hero image | Node.js + OpenAI API |
| 4 | **Comedian Post Generator** | Per-comedian 600-word SEO blog posts with source links and fact-checking | Node.js + OpenAI API |
| 5 | **Social Media Auto-Poster** | Publishes comedian spotlights to Instagram feed + stories, Facebook Page feed + stories, with comedian tagging | Node.js + Meta Graph API |
| 6 | **WordPress Plugin** | Embeds show listings on any WordPress site with filtering, themes, affiliate tracking, GA4 event tracking | PHP + JS + CSS |
| 7 | **GitHub Actions** | Four automated workflows: twice-daily fetch + weekly blog + weekly comedian posts + staggered IG posting | YAML workflow files |
| 8 | **GitHub Pages** | Free static hosting — serves the website, JSON data, and blog posts | GitHub infrastructure |

---

## Component Deep Dive

### 1. Event Fetcher (`scripts/fetch-events.js`)

**~500 lines of Node.js. Zero npm dependencies.** Uses only built-in Node modules (`https`, `fs`, `crypto`, `path`).

#### What it does, step by step:

1. **Fetches from Ticketmaster Discovery API v2**
   - Searches for comedy events within 100 miles of Houston (lat: 29.7604, lon: -95.3698)
   - Also does a venue-specific search for "Houston Improv" (Ticketmaster venue ID: `KovZpZAJledA`)
   - Looks 90 days into the future
   - Post-filters to only keep Texas events
   - Handles HTTP 429 rate limits with automatic retry (exponential backoff: 2s, 4s, 6s)

2. **Fetches from Eventbrite API v3**
   - Pulls from hardcoded comedy organizers:
     - The Riot Comedy Club (organizer ID: `29979960920`)
     - The Secret Group (organizer ID: `20138725138`)
     - Social Comedy Night (organizer ID: `120744254440`)
   - Supports pagination (up to 10 pages per organizer)
   - Filters to live events within 90 days

3. **Normalizes** both API responses into a single unified schema (see [Event Data Schema](#event-data-schema))

4. **Deduplicates** using a SHA-256 hash of `name|date|venue` (lowercased, first 16 chars). When duplicates exist across sources, the event with more complete data wins (scored by presence of: image, price, description, ticket URL, time).

5. **Writes two files:**
   - `events.json` — all events as structured data
   - `index.html` — reads the existing HTML template and injects event data directly into JavaScript variables (`EVENTS_DATA` and `LAST_UPDATED`), so the page loads instantly with zero API calls from the browser

#### Runtime: ~3 seconds

---

### 2. Static Website (`index.html`)

**~8,285 lines. Single self-contained HTML file. No frameworks, no build tools, no external dependencies** (except Google Fonts).

#### Features:
- **Dark theme** with gradient accents and smooth animations
- **Filters:** time period (today, tomorrow, weekend, week, month), venue dropdown, text search, sort options (date, price, name)
- **Event cards:** show image (or venue placeholder), name, venue, date/time, price range, age restriction, status badge, source badge, "Get Tickets" button
- **Smart date labels:** "Tonight", "Tomorrow", "This Friday", etc.
- **Responsive grid:** auto-fill columns, 300px minimum width
- **Zero-latency first paint:** all event data is embedded directly in the HTML at build time — no fetch requests needed

#### How data gets in:
The fetcher script finds these lines in the HTML and replaces them:
```javascript
const EVENTS_DATA = [];        // → replaced with actual event array
const LAST_UPDATED = "";       // → replaced with ISO timestamp
```

---

### 3. Weekly Blog Post Generator (`scripts/generate-blog-post.js`)

**~1,950 lines. The AI-powered content pipeline.** Runs once a week (Monday mornings). Image-pipeline helpers (URL blocklists, HEAD validation, real-dimension parser, strict-gate headshot finder, inverted display-image policy) live in `scripts/lib/image-utils.js` and are shared with `generate-comedian-post.js`.

#### What it does, step by step:

1. **Reads `events.json`** and filters to this week's events (Monday–Sunday)

2. **Identifies top comedians** — sends the event list to OpenAI and asks it to pick out recognizable names (filters out open mics, showcases, karaoke nights, etc.)

3. **Researches each comedian** — uses OpenAI's Responses API (which has built-in web search) to find:
   - Netflix/HBO/Comedy Central specials (by title)
   - Podcast appearances (Joe Rogan, Kill Tony, Tigerbelly, etc.)
   - Late night TV spots, roasts, viral clips
   - Comedy style and stage presence

4. **Looks up Instagram handles** — web searches for each comedian's official Instagram

5. **Generates the blog post** — AI writes a full HTML blog post with:
   - Day-by-day event groupings (Thursday, Friday, Saturday…)
   - 2-sentence comedian blurbs with specific credits (not generic praise)
   - "Get Tickets" links for each show

6. **Generates a hero creative** — an HTML file (`blog/weekly-hero.html`) that renders a 1080×1080 image with a 3×2 grid of comedian headshots and a gradient overlay with the week range

7. **Screenshots the hero** — uses Puppeteer to render the HTML to a PNG (`blog/weekly-hero.png`)

8. **Generates an Instagram caption** — 110–150 words, specific comedian credits, hashtags, @handles, no fluff, 6th-grade reading level

9. **Emails everything** (if SMTP is configured) — sends the hero image + caption to a configured email address so someone can quickly post it to Instagram

#### Files generated:
| File | Purpose |
|------|---------|
| `blog/index.html` | Full blog post (served on GitHub Pages) |
| `blog/weekly-hero.html` | Hero creative as HTML (source for screenshot) |
| `blog/weekly-hero.png` | 1080×1080 PNG screenshot (Instagram-ready) |
| `blog/instagram-caption.txt` | Ready-to-paste Instagram caption |
| `blog/top-comedians.json` | Headliner handoff (consumed by `generate-comedian-post.js`) |

**Hero image is required for WordPress publish.** If the hero PNG is missing or the upload fails, the weekly roundup publish is aborted (throws) rather than silently publishing image-less. The slug-dedupe logic below means the next run updates the post in place once the image is available.

**Slug dedupe on WordPress publish.** Before creating a roundup post, the script looks up any existing post with the same slug and `POST /wp-json/wp/v2/posts/{id}` to update in place. Prevents "-2" suffixed duplicates when the workflow is re-run on the same Monday. The per-comedian publisher uses the same pattern.

#### Image pipeline — inverted preference + strict gate (`scripts/lib/image-utils.js`)

The hero used to render Instagram glyphs and silhouette PNGs because the headshot validator was HEAD-only (status + content-type + ≥8KB bytes). Social-CDN profile icons and default-avatar PNGs sailed through that gate, and `findBestHeadshot()` returned the first match — so the Eventbrite/Ticketmaster event image was never reached via the `c.headshotUrl || c.imageUrl` short-circuit.

The new policy treats the **event image as the floor**, not a fallback:

1. **`scripts/lib/image-utils.js`** is the single source of truth for the URL blocklists, HEAD validation, candidate extraction, and the strict gate. Strict gate = URL not in expanded social-CDN blocklist (`pbs.twimg.com`, `cdninstagram`, `lookaside.fb`, `profile_image`, `/400x400/`, etc.) → HEAD `200` + `image/*` + `Content-Length ≥ 20_000` → real pixel dimensions parsed from the first 32KB via a ranged GET (JPEG SOFn / PNG IHDR / WebP VP8/VP8L/VP8X / GIF) → width & height ≥ 300 → aspect ratio in `[0.65, 1.55]`. A scraped headshot only replaces the event image if it beats the entire bar.

2. **`pickDisplayImage(eventImageUrl, validatedHeadshotUrl, comedianName)`** applies the inverted rule once. Both the weekly hero, the inline hero on `blog/index.html`, the `/this-week/` landing page card grid, and the per-comedian Instagram graphics consume the same decision so they always render the same image for the same comedian.

3. **`blog/top-comedians.json` handoff** is now written *after* the strict-gate step and includes `imageUrl`, `headshotUrl`, `displayImage`, and `imageSource` (`"event" | "headshot" | "initials"`) for each comedian. `generate-comedian-post.js` reuses the pre-validated `displayImage` directly and skips re-scraping — one round of network work, not two, and guaranteed visual consistency between weekly hero and per-comedian spotlights.

4. The same library is `require()`d by both blog scripts, deleting ~340 lines of drifted duplicate code (the comedian script's old copy carried `openmicnight` in its blocklist while the blog script's didn't, etc.).

#### WordPress publish reliability — per-request timeouts + cumulative budget

WordPress / Hostinger occasionally drop a TCP connection silently mid-upload. The script's `wpRequest`, `wpUploadImage`, and `downloadImage` helpers used to set no client-side timeout, so a hang would wait forever and burn the entire job-level `timeout-minutes` — losing the Instagram caption email along with it. Run #26 was killed exactly that way.

Three layers of defense are now in place:

| Layer | Value | Behavior |
|-------|-------|----------|
| Per-call timeout (JSON) | `WP_REQUEST_TIMEOUT_MS = 30_000` | `req.setTimeout()` destroys the socket and rejects with a clear `... timed out after 30000ms` error |
| Per-call timeout (media upload) | `WP_UPLOAD_TIMEOUT_MS = 60_000` | Larger budget for the hero PNG payload |
| Cumulative budget | `WP_TOTAL_BUDGET_MS = 8 * 60 * 1000` | `wpDeadline` is armed at the start of Step 7; every subsequent WP call short-circuits with a `budget-exceeded` error once the wall-clock blows past it |

Every `wpRequest` / `wpUploadImage` / `downloadImage` failure is already swallowed by the existing try/catch around Step 7 ("Publishing weekly roundup to WordPress…"), which `console.warn`s and continues. So the script always exits cleanly within ~10 minutes worst-case, the workflow's `Commit and push blog post` step still runs, and the email step still ships the hero PNG + Instagram caption to the operator's inbox even if the WordPress publish failed.

The workflow YAML reinforces the same idea: every step from `Commit and push blog post` onward runs under `if: ${{ !cancelled() }}`, so a non-zero exit from `node scripts/generate-blog-post.js` no longer skips the email. Job-level `timeout-minutes` is now `20` (down from 30), and the script's per-call + cumulative timeouts mean it should never come close to that ceiling.

#### OpenAI models used:
- **Chat Completions API** (`/v1/chat/completions`) — for blog writing, comedian identification, caption generation
- **Responses API** (`/v1/responses`) — for web search (comedian research, Instagram handle lookup)

---

### 3b. Per-Comedian SEO Blog Post Generator (`scripts/generate-comedian-post.js`)

**~1,940 lines of Node.js. Zero npm dependencies.** Runs once a week (Monday mornings, 1 hour after the weekly blog post). Shares all image-pipeline code with `generate-blog-post.js` via `scripts/lib/image-utils.js` (see §3 above) — no more drifted duplicate copies.

#### What it does, step by step:

1. **Reads `events.json`** and filters to this week's events (Monday–Sunday)

2. **Identifies headliners** — prefers `blog/top-comedians.json`, a handoff file written by `generate-blog-post.js` earlier on Monday. This guarantees the weekly roundup and the per-comedian posts cover the exact same comedians and saves one OpenAI call. Falls back to its own OpenAI call (with JSON-array extraction as a second-chance parser) only if the handoff file is missing or stale (different `week_range`).

3. **For each headliner, runs a 4-call pipeline:**

   **Call 1 — Deep Research** (OpenAI Responses API with web search):
   - Full bio, hometown, career arc
   - Specific specials (title, platform, year)
   - Podcast appearances, TV spots, viral moments
   - Comedy style description
   - Instagram handle
   - **`recent_hook`** — the freshest piece of news about this comedian (last 90 days ideally), with verbatim quote, publication, URL, and date. The blog post is built around this hook so the lede is fresh, not the same Daily-Show / Netflix-special default that every other write-up uses.
   - **`unverifiable_claims_to_avoid`** — explicit do-not-use list of "facts" surfaced in low-quality sources. The writer is told these are forbidden, which structurally blocks credit hallucinations.
   - **Source URLs** (Wikipedia, IMDB, Netflix, YouTube, interviews) — 3-6 verified URLs per comedian

   **Call 2 — Write the Blog Post** (OpenAI Chat Completions):
   - **400-word hard ceiling** (down from 600 — shorter forces the model to cut padding, which is where most AI-voice lives)
   - System prompt includes a **voice anchor**: a real human-written paragraph in the target register, with annotation explaining what it does. Models imitate provided samples far better than they follow style descriptions.
   - **Absolute fact rules**: the writer can ONLY state facts present in the research JSON. No "reasonable inferences," no paraphrased quotes, no credits not in the verified list.
   - SEO title with comedian name + city + venue
   - **Banned structures** (separate from banned phrases): no "X isn't just Y, it's Z," no rhetorical questions, no atmospheric openings ("in the dim glow of"), no closing reassurance ("boundaries blur"), no metaphor stacking, no tricolons, the literal word "scalpel" forbidden.
   - **3-4 source hyperlinks** woven naturally into the text
   - Comedy Houston footer with links to homepage and contact page

   **Call 3 — Fact-Check Pass** (OpenAI Chat Completions):
   - Compares draft against research data and **silently removes** any claim not supported by the research (no `[VERIFY]` markers — the post must read as final)
   - Strips generic sentences, unverified adjectives, fabricated quotes, rhetorical questions, "isn't just" constructions, CTA paragraphs
   - Preserves source hyperlinks and footer

   **Call 4 — Polish Pass** (OpenAI Chat Completions):
   - Copy-chief style + rhythm tightening on the fact-checked draft
   - Cannot add new facts — only cuts and rearranges
   - Enforces 400-word ceiling by cutting the weakest paragraph entirely if over
   - Same "no editor flags" rule as fact-check

   **Final safety net — `stripEditorMarkers()`**: a regex pass that removes any `[VERIFY]`, `[CHECK]`, `[CITATION NEEDED]`, `[TODO]`, `[CONFIRM]`, `[FACT-CHECK]` tokens that slipped past both LLM passes. The published post is guaranteed to have no bracketed editor notes.

4. **Picks the display image without re-scraping.** For each headliner, the script first looks at the pre-validated `displayImage` written by `generate-blog-post.js` into `blog/top-comedians.json`. That image already cleared the strict gate (URL blocklist + HEAD ≥ 20KB + real-dimension check + aspect ratio in [0.65, 1.55]) so it's reused as-is for the Instagram square / portrait / story graphics — no second round of network work, and the per-comedian spotlight visually matches the weekly hero. Only when the handoff is missing or stale (different `week_range`) does the script fall back to the same shared `findBestHeadshot()` from `scripts/lib/image-utils.js` and run the strict gate fresh.

5. **Writes individual HTML files** to `blog/comedians/` — one per comedian

6. **Generates an index page** listing all comedian posts for the week

7. **Writes a manifest.json** with post metadata (comedian name, venue, date, image URL, slug) — used by Phase 2 WordPress auto-publishing

#### Files generated:
| File | Purpose |
|------|---------|
| `blog/comedians/{slug}.html` | Individual comedian blog post |
| `blog/comedians/index.html` | Index page listing all comedian posts |
| `blog/comedians/manifest.json` | Post metadata + `manifest_version` stamp (used by WP publishing + IG poster state reconciliation) |
| `blog/top-comedians.json` | Headliner handoff written by the weekly blog generator and consumed by this script so both workflows agree on the comedian list |

#### Cost per run:
~$0.16–0.32 per comedian (4 API calls — research, write, fact-check, polish). Typical weekly run with 3–5 comedians: **$0.55–1.60**.

#### WordPress publishing — preflight & error logging

Before any per-comedian publish runs, `wpPreflight()` calls `GET /wp-json/wp/v2/users/me?context=edit` once. If it fails, WordPress publishing is disabled for the rest of the run and the failure reason is logged loudly at the top of the workflow output (with hints: stale app password, username mismatch, Hostinger/LiteSpeed blocking the runner IP, LiteSpeed stripping the Authorization header). Posts still get written to GitHub Pages so nothing is lost. This replaces the old behavior where a 401 from the first category lookup would silently bail out per-comedian and the only sign of trouble was 25 "Post saved to GitHub Pages only" lines deep in the log.

`wpRequest()` errors now include the HTTP method, path, a relevant subset of response headers (`content-type`, `www-authenticate`, `x-litespeed-cache`, `cf-ray`, `server`), and the first 1500 chars of the response body — enough to distinguish credential failures (`rest_not_logged_in` JSON) from host firewall blocks (HTML body, no JSON code) from payload validation errors (`rest_invalid_param`) from rate-limiting (429).

---

### 4. WordPress Plugin (`wordpress/`)

**Version 2.4.0. ~900 lines of PHP + 460 lines of JS + 639 lines of CSS.**

A full-featured WordPress plugin that embeds show listings on any WordPress site.

#### Installation:
1. Upload the `wordpress/` folder as `comedy-houston/` to `/wp-content/plugins/`
2. Activate in WordPress Admin → Plugins
3. Configure at Settings → Comedy Houston
4. Add `[comedy_houston]` shortcode to any page

#### Features:

| Feature | Details |
|---------|---------|
| **Data source** | Fetches `events.json` from GitHub (`raw.githubusercontent.com`) — cached for 1 hour via WordPress transients |
| **Three themes** | Dark, Light, Auto (follows OS dark mode preference) |
| **Filtering** | Time period, venue, source, max price, open mic toggle |
| **Sorting** | Date, price, name |
| **Affiliate tracking** | Redirects ticket links through the WordPress site, appending Ticketmaster/Eventbrite affiliate IDs. Logs clicks to a database table with hashed IPs |
| **GA4 event tracking** | Fires `gtag('event', 'ticket_click')` with comedian name, venue, price, and outbound URL on every "Get Tickets" click. Works with Google Site Kit's existing gtag injection. |
| **SEO** | Server-side rendering for Googlebot, JSON-LD structured data, Open Graph meta tags |
| **Shortcode params** | `filter`, `max_price`, `venue`, `source`, `theme`, `title`, `show_hero`, `show_controls`, `show_footer`, `show_venue_filter`, `show_sort`, `show_open_mic`, `type` |

#### Admin settings:
- GitHub username/repo (where to fetch `events.json` from)
- Color scheme
- Ticketmaster/Eventbrite affiliate IDs
- Click tracking on/off
- Shows click stats in admin panel

#### Admin click analytics dashboard:
The Settings → Comedy Houston page displays:
- **Clicks today** and **total clicks** summary banner
- **Top 10 clicked links today** — table with readable show names extracted from URLs, click counts
- **Top 10 clicked links last 30 days** — same format, wider window
- Show names are extracted from Ticketmaster/Eventbrite URL slugs for human-readable display

#### Database table (`wp_ch_clicks`):
Logs every ticket click with: timestamp, original URL, final URL (with affiliate params), hashed IP, user agent, referer.

---

### 5. GitHub Actions Workflows

#### Workflow 1: Update Events (`.github/workflows/update-events.yml`)

| Field | Value |
|-------|-------|
| **Schedule** | Twice daily: `0 14 * * *` and `0 0 * * *` UTC (~8 AM and ~6 PM Central) |
| **Manual trigger** | Yes (`workflow_dispatch`) |
| **What it runs** | `node scripts/fetch-events.js` |
| **Secrets used** | `TICKETMASTER_API_KEY`, `EVENTBRITE_TOKEN` |
| **Commits** | `events.json` + `index.html` (only if changed) |
| **Commit message** | `Update events data — {timestamp in CT}` |

#### Workflow 2: Generate Blog Post (`.github/workflows/generate-blog-post.yml`)

| Field | Value |
|-------|-------|
| **Schedule** | Weekly: `0 15 * * 1` UTC (Monday ~9–10 AM Central) and `0 15 * * 4` UTC (Thursday weekend-post refresh) |
| **Manual trigger** | Yes (`workflow_dispatch`) |
| **What it runs** | `generate-blog-post.js` (which calls `screenshot-hero.js` inline) → `git commit/push` → email (conditional) |
| **Secrets used** | `OPENAI_API_KEY` + optionally all SMTP secrets |
| **Commits** | `blog/index.html`, `blog/weekly-hero.html`, `blog/weekly-hero.png`, `blog/instagram-caption.txt`, `blog/top-comedians.json` |
| **Job timeout** | `timeout-minutes: 20` (down from 30 — script-side per-call WP timeouts make this a fail-safe, not the primary kill switch) |
| **Email** | Sends whenever `SMTP_SERVER` is set AND the caption + hero files exist on disk. Crucially, the `Commit and push`, `Check if email is configured`, `Load caption for email`, and `Email weekly creative + caption` steps all run under `if: ${{ !cancelled() }}` — so if `node scripts/generate-blog-post.js` exits non-zero (e.g. WordPress publish failure), the operator still gets the Instagram caption + hero PNG by email and can post manually. |

#### Workflow 3: Generate Comedian Posts (`.github/workflows/generate-comedian-posts.yml`)

| Field | Value |
|-------|-------|
| **Schedule** | Weekly: `0 16 * * 1` UTC (Monday ~10–11 AM Central, 1 hour after blog post) |
| **Manual trigger** | Yes (`workflow_dispatch`) |
| **What it runs** | `generate-comedian-post.js` |
| **Secrets used** | `OPENAI_API_KEY` |
| **Commits** | `blog/comedians/*.html`, `blog/comedians/manifest.json` |
| **Cost** | ~$0.50–1.50 per run (3 API calls per comedian, typically 3–5 comedians) |

#### Workflow 4: Social Media Auto-Poster (`.github/workflows/post-to-instagram.yml`)

| Field | Value |
|-------|-------|
| **Schedule** | Every 6 hours: `0 4,10,16,22 * * *` UTC (covers Mon 4pm CT onward) |
| **Manual trigger** | Yes (`workflow_dispatch`) |
| **What it runs** | `post-to-instagram.js` — posts the next comedian across 4 channels |
| **Secrets used** | `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_USER_ID` |
| **Commits** | `blog/comedians/ig-post-state.json` |
| **Cost** | Free (Meta Graph API has no per-call cost) |

**Per comedian, 4 posts go out:**

| Channel | Image | Caption | Comedian Tag |
|---------|-------|---------|-------------|
| Instagram Feed | **Carousel**: slide 1 = square graphic, slide 2 = single blog post teaser (top of post; falls back to a single image if the teaser doesn't exist) | Full caption + hashtags | Tagged in photo via `user_tags` |
| Instagram Story | Story (1080×1920) | None (API limitation) | Not supported in Stories API |
| Facebook Page Feed | Square (1080×1080) | Full caption + hashtags | N/A |
| Facebook Page Story | Story (1080×1920) | None | N/A |

The Instagram Feed post is the primary channel — if it fails, the run fails and state is NOT advanced, so the next scheduled cron retries the same comedian. The other 3 channels are **best-effort**: if any fail, the error is logged but the run still succeeds and state is saved. The Facebook Page ID is resolved automatically at runtime from the Page Access Token (no extra secret needed); if that resolution fails the error is now logged loudly (not silent) and FB posting is skipped for that run while IG posting continues.

**Rate limiting.** `graphRequest` parses the `Retry-After` header and treats any 429 or Meta rate-limit error code (4, 17, 32, 613) as a `RATE_LIMITED` condition. When that happens the run exits 0 without advancing state, so the next cron picks up cleanly instead of burning job minutes in-process. Network/5xx retries use exponential backoff capped at 30s.

**Exit handling / socket leak guard.** Both the success and error paths go through a single `exit(code)` helper that calls `https.globalAgent.destroy()` and gives Node 150 ms to tear down keep-alive sockets before `process.exit`. This prevents the post-success hang that used to cause the state-commit step to be cancelled by the job timeout, which in turn caused duplicate comedian posts on the following run.

**Manifest / state reconciliation.** The manifest written by `generate-comedian-post.js` includes a `manifest_version` timestamp. The IG poster compares it against `state.manifest_version`: if the week matches but the version changed (mid-week manifest regeneration), it prunes state entries whose slugs no longer appear in the new manifest so orphaned comedians can't resurface.

**Carousel teasers** are generated by `screenshot-blog-teasers.js` during the Monday comedian post generation workflow. Each comedian gets **one** 1080×1080 screenshot of the top of their blog post (hero + intro). Sharing a second mid-article shot was giving away too much of the post, so it was removed. If the teaser image doesn't exist (e.g., older posts), the feed post falls back to a single square image automatically.

---

### 6. GitHub Pages Hosting

- **Source:** `main` branch, root folder (`/`)
- **URL:** `https://sanjmanak.github.io/show_lister/`
- **What's served:**
  - `/` → `index.html` (main show listing)
  - `/events.json` → raw event data (consumed by WordPress plugin)
  - `/blog/` → `blog/index.html` (weekly blog post)
  - `/blog/weekly-hero.png` → hero image
  - `/blog/comedians/` → individual comedian spotlight posts
  - `/blog/comedians/manifest.json` → post metadata for WordPress publishing

GitHub Pages rebuilds automatically whenever the Actions workflow pushes a commit.

---

## Data Flow Diagram

```
╔══════════════════════════════════════════════════════════════════════════╗
║                        TWICE DAILY (8 AM & 6 PM CT)                    ║
╠══════════════════════════════════════════════════════════════════════════╣
║                                                                        ║
║  ┌──────────────────┐    ┌──────────────────┐                          ║
║  │  Ticketmaster API │    │  Eventbrite API   │                         ║
║  │  (Discovery v2)   │    │  (v3)             │                         ║
║  └────────┬─────────┘    └────────┬─────────┘                          ║
║           │                       │                                     ║
║           └───────────┬───────────┘                                     ║
║                       ▼                                                 ║
║           ┌───────────────────────┐                                     ║
║           │  fetch-events.js      │                                     ║
║           │  • Normalize schemas  │                                     ║
║           │  • Deduplicate        │                                     ║
║           │  • Sort by date       │                                     ║
║           └─────────┬─────────────┘                                     ║
║                     │                                                   ║
║           ┌─────────┴─────────┐                                         ║
║           ▼                   ▼                                         ║
║    ┌─────────────┐    ┌─────────────┐                                   ║
║    │ events.json │    │ index.html  │                                   ║
║    │ (raw data)  │    │ (embedded)  │                                   ║
║    └──────┬──────┘    └──────┬──────┘                                   ║
║           │                  │                                          ║
║           └────────┬─────────┘                                          ║
║                    ▼                                                    ║
║           ┌───────────────────┐                                         ║
║           │  git commit + push │                                        ║
║           └────────┬──────────┘                                         ║
║                    ▼                                                    ║
║           ┌───────────────────┐                                         ║
║           │  GitHub Pages     │──── serves ───▶  Visitors               ║
║           │  (auto-rebuild)   │──── serves ───▶  WordPress Plugin       ║
║           └───────────────────┘                  (fetches events.json)  ║
║                                                                        ║
╠══════════════════════════════════════════════════════════════════════════╣
║                     WEEKLY (Monday 9 AM CT)                            ║
╠══════════════════════════════════════════════════════════════════════════╣
║                                                                        ║
║    ┌─────────────┐                                                      ║
║    │ events.json │                                                      ║
║    └──────┬──────┘                                                      ║
║           ▼                                                             ║
║    ┌───────────────────────────┐     ┌──────────────────┐               ║
║    │  generate-blog-post.js   │────▶│  OpenAI API       │              ║
║    │  • Identify comedians    │◀────│  • Chat completion│              ║
║    │  • Research via web      │     │  • Web search     │              ║
║    │  • Write blog post       │     └──────────────────┘               ║
║    │  • Generate caption      │                                         ║
║    │  • Build hero HTML       │                                         ║
║    └───────────┬──────────────┘                                         ║
║                │                                                        ║
║    ┌───────────┴──────────────────────────┐                             ║
║    ▼              ▼            ▼           ▼                             ║
║  blog/        blog/         blog/       blog/                           ║
║  index.html   weekly-       weekly-     instagram-                      ║
║  (blog post)  hero.html     hero.png    caption.txt                     ║
║                             (Puppeteer                                  ║
║                              screenshot)                                ║
║                │                                                        ║
║                ▼                                                        ║
║    ┌───────────────────────┐                                            ║
║    │  Email (if SMTP set)  │──▶  Recipient posts to Instagram           ║
║    │  • Hero image attached│                                            ║
║    │  • Caption in body    │                                            ║
║    └───────────────────────┘                                            ║
║                                                                        ║
╚══════════════════════════════════════════════════════════════════════════╝
```

---

## Event Data Schema

Every event from both APIs is normalized to this structure:

```json
{
  "id": "a1b2c3d4e5f6g7h8",
  "name": "Ali Siddiq: The Domino Effect Tour",
  "venue": "Houston Improv",
  "venue_state": "TX",
  "venue_city": "Houston",
  "date": "2026-03-20",
  "time": "7:30 PM",
  "day_of_week": "Friday",
  "price_min": 25.00,
  "price_max": 45.00,
  "currency": "USD",
  "ticket_url": "https://www.ticketmaster.com/event/...",
  "image_url": "https://s1.ticketm.net/dam/a/...",
  "source": "ticketmaster",
  "age_restriction": "18+",
  "status": "on_sale",
  "description": "Ali Siddiq brings his raw storytelling...",
  "last_updated": "2026-03-17T14:00:00.000Z"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | 16-char SHA-256 of `name\|date\|venue` (lowercased) |
| `name` | string | Event title |
| `venue` | string | Venue name |
| `venue_state` | string | Always "TX" (post-filtered) |
| `venue_city` | string | City name |
| `date` | string | `YYYY-MM-DD` format |
| `time` | string | `HH:MM AM/PM` or null |
| `day_of_week` | string | "Monday" through "Sunday" |
| `price_min` | number | Lowest ticket price, or null |
| `price_max` | number | Highest ticket price, or null |
| `currency` | string | Usually "USD" |
| `ticket_url` | string | Direct link to buy tickets |
| `image_url` | string | Event/artist image, or null |
| `source` | string | `"ticketmaster"` or `"eventbrite"` |
| `age_restriction` | string | `"18+"`, `"21+"`, or null |
| `status` | string | `"on_sale"`, `"off_sale"`, `"cancelled"`, `"postponed"`, `"rescheduled"`, `"unknown"` |
| `description` | string | Event description, or null |
| `last_updated` | string | ISO 8601 timestamp |

---

## Secrets & Environment Variables

### Required for event fetching (twice daily):

| Secret | Purpose | Where to get it |
|--------|---------|-----------------|
| `TICKETMASTER_API_KEY` | Ticketmaster Discovery API consumer key | [developer.ticketmaster.com](https://developer.ticketmaster.com) (free) |
| `EVENTBRITE_TOKEN` | Eventbrite private API token | [eventbrite.com/platform](https://www.eventbrite.com/platform) (free) |

### Required for blog generation (weekly):

| Secret | Purpose | Where to get it |
|--------|---------|-----------------|
| `OPENAI_API_KEY` | OpenAI API key (chat + web search) | [platform.openai.com](https://platform.openai.com) (paid, ~$2–10/month for this usage) |

### Optional (for email delivery):

| Secret | Purpose |
|--------|---------|
| `SMTP_SERVER` | SMTP hostname (e.g., `smtp.gmail.com`) |
| `SMTP_PORT` | SMTP port (usually `587`) |
| `SMTP_USERNAME` | SMTP login username |
| `SMTP_PASSWORD` | SMTP login password or app password |
| `SMTP_FROM` | Sender email address |
| `NOTIFY_EMAIL` | Recipient email address |

### Optional (for Instagram auto-posting):

| Secret | Purpose | Where to get it |
|--------|---------|-----------------|
| `INSTAGRAM_ACCESS_TOKEN` | Long-lived Page Access Token (~60 day expiry) | See Meta setup guide below |
| `INSTAGRAM_USER_ID` | Instagram Business account numeric ID | See Meta setup guide below |

All secrets are stored in **GitHub Repository Secrets** (Settings → Secrets and variables → Actions). They are never committed to the repo.

### Meta Developer Portal Setup (Instagram Auto-Posting)

The Instagram auto-poster uses Meta's **Content Publishing API** via a Facebook Page linked to an Instagram Business account. Here's the full setup:

#### Prerequisites
- An **Instagram Business** or **Creator** account (not Personal)
- A **Facebook Page** linked to that Instagram account
- Your personal Facebook account must be an **admin** of that Page

#### Step 1: Create a Meta App
1. Go to [developers.facebook.com](https://developers.facebook.com) → My Apps → Create App
2. Select **"Business"** as the app type
3. Name it (e.g., "Comedy Houston Poster")
4. Leave it in **Development mode** (no App Review needed for your own account)

#### Step 2: Add Use Cases & Permissions
1. Go to your app → **Use cases** → add the **"Instagram API"** use case
2. Under Use cases → Customize → **Permissions and features**, add these (click `+ Add` on each):
   - `instagram_business_basic`
   - `instagram_business_content_publish`
   - `pages_show_list`
   - `pages_read_engagement`
   - `business_management` ← **critical** — without this, `me/accounts` returns empty on newer API versions
3. Also add the **"Manage Pages"** use case and ensure `pages_show_list` and `pages_read_engagement` are active there too

#### Step 2b: Add Instagram Tester Role
1. In your app, go to **App Roles** → **Roles** (in the left sidebar or settings gear)
2. Find the **"Instagram Testers"** section and click **Add Instagram Testers**
3. Enter the Instagram username you want to post to (e.g., `comedyhoustontx`)
4. On your phone/browser, log into that Instagram account → Settings → Apps and Websites → **Tester Invitations** → **Accept** the invite
5. You do **NOT** need to generate a token from the "API setup with Instagram login" use case page — skip that entirely

#### Step 3: Generate Access Token
1. Go to [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. Set the domain dropdown to **`graph.facebook.com`** (not `graph.instagram.com`)
3. Select your app in the "Meta App" dropdown
4. Set "User or Page" to **"User Token"**
5. Under Permissions, add: `business_management`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `pages_read_engagement`, `pages_show_list`
6. Click **"Generate Access Token"** — in the authorization popup, **make sure you select your Facebook Page** on the Page selection screen

#### Step 4: Get Your Instagram User ID
Run this in Graph API Explorer:
```
me/accounts?fields=id,name,access_token,instagram_business_account&limit=50
```
Find your Page in the results. The `instagram_business_account.id` is your `INSTAGRAM_USER_ID`.

#### Step 5: Exchange for Long-Lived Token
Copy the **Page Access Token** (the `access_token` inside the `data` array, NOT the one in the top-right panel) and run in your terminal:
```bash
curl -s "https://graph.facebook.com/v25.0/oauth/access_token?grant_type=fb_exchange_token&client_id=YOUR_APP_ID&client_secret=YOUR_APP_SECRET&fb_exchange_token=PAGE_TOKEN" | jq .
```
The returned `access_token` is valid for ~60 days.

#### Step 6: Save to GitHub Secrets
- `INSTAGRAM_ACCESS_TOKEN` → the long-lived token from Step 5
- `INSTAGRAM_USER_ID` → the numeric ID from Step 4

#### Token Refresh
Long-lived tokens expire in ~60 days. Set a calendar reminder to regenerate before expiry. The script validates the token on every run and will log a clear error message if it's expired.

---

## File Map

```
show_lister/
│
├── .github/
│   └── workflows/
│       ├── update-events.yml            # Cron: fetch events 2x daily
│       ├── generate-blog-post.yml       # Cron: weekly blog + email
│       ├── generate-comedian-posts.yml  # Cron: weekly per-comedian SEO posts
│       └── post-to-instagram.yml       # Cron: staggered IG posting (every 6h)
│
├── scripts/
│   ├── fetch-events.js                  # Core fetcher (~500 lines)
│   ├── generate-blog-post.js            # AI blog generator (~1,600 lines)
│   ├── generate-comedian-post.js        # Per-comedian SEO post generator (~500 lines)
│   ├── post-to-instagram.js             # Multi-channel social poster: IG carousel/story + FB feed/story (~550 lines)
│   ├── screenshot-blog-teasers.js       # Puppeteer blog teaser cards for carousel slides (~200 lines)
│   └── screenshot-hero.js               # Puppeteer PNG screenshotter (~40 lines)
│
├── wordpress/
│   ├── comedy-houston.php               # Main plugin file (~900 lines) — includes click analytics dashboard
│   ├── comedy-houston-template.php      # Plugin HTML template
│   ├── comedy-houston.js                # Client-side filtering + GA4 tracking (~460 lines)
│   └── comedy-houston.css               # Plugin styles, 3 themes (~639 lines)
│
├── blog/
│   ├── index.html                       # Generated weekly blog post
│   ├── weekly-hero.html                 # Hero creative (HTML source)
│   ├── weekly-hero.png                  # Hero creative (1080×1080 PNG)
│   ├── instagram-caption.txt            # Generated Instagram caption
│   └── comedians/                       # Per-comedian spotlight posts
│       ├── index.html                   # Index listing all comedian posts
│       ├── manifest.json                # Post metadata (for WordPress publishing)
│       ├── ig-post-state.json           # Tracks which comedians have been posted to IG
│       └── {comedian-slug}.html         # Individual comedian blog posts
│
├── index.html                           # Main static website (~8,285 lines)
├── events.json                          # Generated event data
├── package.json                         # Project metadata (no dependencies)
├── README.md                            # Setup guide
├── CODE_SUMMARY.md                      # Technical summary
└── ARCHITECTURE.md                      # This file
```

---

## Making the Repo Private — Impact Assessment

**Short answer: Making this repo private WILL break things, but everything is fixable.**

### What breaks:

| Component | Impact | Severity | Fix |
|-----------|--------|----------|-----|
| **GitHub Pages** | Pages on free plans require public repos. Your site at `sanjmanak.github.io/show_lister/` will go offline. | **HIGH** | Upgrade to GitHub Pro ($4/month) which allows Pages on private repos. Or use a different host (Netlify, Cloudflare Pages — both have free tiers for private repos). |
| **WordPress plugin** | The plugin fetches `events.json` from `raw.githubusercontent.com`. Private repos return 404 for unauthenticated requests. | **HIGH** | Option A: Add a GitHub personal access token (PAT) to the plugin's fetch logic. Option B: Serve `events.json` from a different public endpoint (e.g., a CDN, S3 bucket, or Cloudflare Worker). Option C: Keep the JSON file hosted elsewhere. |
| **GitHub Actions** | Workflows continue to work on private repos — no change. | **NONE** | N/A |
| **Blog posts** | Blog pages are served via GitHub Pages, so same impact as above. | **HIGH** | Same fix as GitHub Pages above. |
| **`events.json` as a public API** | Anyone currently consuming this URL will lose access. | **LOW** | Likely only your own WordPress plugin consumes this. |

### What doesn't break:

- GitHub Actions workflows (they run fine on private repos, secrets still work)
- The email pipeline (runs in Actions, doesn't depend on repo visibility)
- The fetch scripts themselves (they call external APIs, not GitHub)
- The WordPress plugin's core logic (only the data fetch URL needs updating)

### Recommended approach:

1. **Upgrade to GitHub Pro** ($4/month) — this is the simplest fix. Private repo + GitHub Pages just works.
2. **Or** move hosting to **Cloudflare Pages** (free tier, supports private repos, auto-deploys from GitHub).
3. For the WordPress plugin, if you go with GitHub Pro, `raw.githubusercontent.com` still works for private repos if you add a token. But cleaner would be to have the plugin fetch from your Pages URL (e.g., `https://sanjmanak.github.io/show_lister/events.json`) instead of the raw GitHub URL.

---

## Security Audit

### CRITICAL Issues

#### 1. Open Redirect Vulnerability — WordPress Plugin
**File:** `wordpress/comedy-houston.php` (redirect handler)
**Risk:** HIGH

The affiliate redirect feature (`?ch_go={base64_encoded_url}`) accepts any valid URL after base64-decoding. While it validates the URL format with `filter_var(..., FILTER_VALIDATE_URL)`, it does not restrict the URL scheme.

**What this means:** An attacker could craft a link like `yoursite.com/?ch_go=aHR0cHM6Ly9tYWxpY2lvdXMuY29tL3BoaXNoaW5n` that redirects visitors through your WordPress site to a phishing page. This abuses your domain's trust.

**Fix:** Add a scheme whitelist — only allow `http://` and `https://` URLs:
```php
if (!preg_match('~^https?://~i', $decoded)) {
    wp_safe_redirect(home_url('/'));
    exit;
}
```

Additionally, consider whitelisting only known ticket domains (ticketmaster.com, eventbrite.com).

#### 2. Prompt Injection via Event Data
**File:** `scripts/generate-blog-post.js`
**Risk:** MEDIUM-HIGH

Event names and descriptions from Ticketmaster/Eventbrite are embedded directly into OpenAI prompts without sanitization. If either API returned a malicious event (unlikely but possible), the injected text could manipulate the AI's output.

**Real-world risk:** Low, because Ticketmaster and Eventbrite are trusted sources. But if either platform were compromised, or if a venue operator intentionally crafted a malicious event title, it could affect your blog post output.

**Fix:** Strip or escape special prompt characters from event data before embedding in prompts, or use structured JSON input instead of string interpolation.

---

### MEDIUM Issues

#### 3. OpenAI API Cost Exposure
**File:** `scripts/generate-blog-post.js`, `.github/workflows/generate-blog-post.yml`
**Risk:** MEDIUM

The blog generation workflow can be triggered manually (`workflow_dispatch`). Each run makes 4–6 OpenAI API calls including web search, costing roughly $2–10 per run. If someone with repo write access (or a compromised GitHub token) triggered it repeatedly, they could run up your OpenAI bill.

**What this means for you specifically:** Since this is your personal repo and presumably only you have write access, the risk is low. But if you ever add collaborators or if your GitHub account were compromised, this is an attack vector.

**Mitigations already in place:** Only people with write access can trigger `workflow_dispatch`.

**Additional fixes:**
- Set a monthly spending limit on your OpenAI account (Settings → Billing → Usage limits)
- Set up billing alerts on OpenAI so you get emailed if spend exceeds a threshold
- Consider removing `workflow_dispatch` from the blog workflow if you don't need manual triggers

#### 4. SMTP Credentials in Third-Party Action
**File:** `.github/workflows/generate-blog-post.yml`
**Risk:** LOW-MEDIUM

SMTP password is passed to `dawidd6/action-send-mail@v3`, a third-party GitHub Action. If that action were ever compromised (supply chain attack), your email credentials could leak.

**Fix:** Pin the action to a specific commit SHA instead of `@v3`:
```yaml
uses: dawidd6/action-send-mail@abcdef1234567890  # pin to specific commit
```

#### 5. No `.gitignore` File
**Risk:** LOW-MEDIUM

There's no `.gitignore`, which means if you ever create a `.env` file for local development, it would be committed to the repo. This is a common way API keys get leaked.

**Fix:** Add a `.gitignore` (see recommendation below).

---

### LOW Issues

#### 6. API Keys Could Leak in Error Logs
**File:** `scripts/fetch-events.js`
**Risk:** LOW

The Ticketmaster API key is embedded in the URL as a query parameter. If the script throws an unhandled error that includes the full URL, the key could appear in GitHub Actions logs. GitHub does mask known secrets, but URL-embedded secrets can sometimes slip through.

**Current protection:** GitHub Actions automatically masks values that match known secrets. This likely catches it, but it's not guaranteed for URL-embedded values.

#### 7. XSS via AI-Generated Blog Content
**File:** `scripts/generate-blog-post.js`
**Risk:** LOW

The blog post HTML generated by OpenAI is embedded directly in the final HTML file. If the AI were somehow manipulated (via the prompt injection in item #2) to output `<script>` tags, they'd execute on visitors' browsers.

**Current protection:** OpenAI models generally don't output raw script tags, and the content is generated from trusted event data. But it's defense-in-depth worth noting.

---

### What's Already Done Well (Security Positives)

- **All API keys are in GitHub Secrets** — nothing hardcoded in the repo
- **No npm dependencies** — zero supply chain attack surface for the Node.js scripts
- **WordPress plugin hashes IPs** with `wp_hash()` before storing click logs
- **Eventbrite token uses Authorization header** (not URL parameter) — safer than URL embedding
- **The fetcher has retry logic with backoff** — won't hammer APIs on failure
- **WordPress plugin validates URLs** with `filter_var()` and uses `esc_url_raw()` for output
- **WordPress plugin uses nonces** for admin settings (CSRF protection)
- **WordPress plugin uses `$wpdb->prepare()`** for database queries (SQL injection protection)

---

## Cost & Billing Exposure

Here's what each API costs and how someone could theoretically abuse it:

| API | Cost | Your Usage | Abuse Scenario | Max Damage |
|-----|------|-----------|----------------|------------|
| **Ticketmaster** | Free (5,000 calls/day limit) | ~4 calls/day | Can't run up a bill — it's free. Worst case: rate limited. | $0 |
| **Eventbrite** | Free (1,000 calls/hour limit) | ~4 calls/day | Can't run up a bill — it's free. Worst case: rate limited. | $0 |
| **OpenAI** | Pay-per-use (~$0.01–0.03/1K tokens + web search) | ~$3–12/week (blog + comedian posts) | If `workflow_dispatch` triggered repeatedly: ~$10/run × N runs | **Potentially significant** — set a spend cap |
| **GitHub Actions** | Free (2,000 min/month for free tier) | ~5 min/day (fetch) + ~15 min/week (blog + comedian posts) | If workflows triggered excessively, you'd hit the free tier limit and they'd just stop. | $0 (just stops running) |
| **GitHub Pages** | Free | Continuous | No billing risk. If traffic spikes, GitHub may throttle (soft limit ~100GB/month bandwidth). | $0 |
| **SMTP (email)** | Depends on provider | ~4 emails/month | If blog workflow triggered repeatedly, more emails sent. Most providers have daily limits. | Minimal |

### Bottom Line on Billing Risk

**The only real billing risk is OpenAI.** Everything else is either free or has hard limits that just stop working (no charges).

**Action item:** Go to [platform.openai.com/settings/organization/limits](https://platform.openai.com/settings/organization/limits) and set a monthly budget cap (e.g., $25/month). This guarantees nobody can ever run up your bill beyond that, even if your GitHub account were compromised.

---

## Quick Reference for Agents / AI Assistants

If you're an AI agent working on this codebase, here's what you need to know:

- **To update the event fetching logic:** Edit `scripts/fetch-events.js`. Test locally with `TICKETMASTER_API_KEY` and `EVENTBRITE_TOKEN` env vars set.
- **To change the website appearance:** Edit `index.html` — all CSS and JS is inline. The `EVENTS_DATA` variable at the top gets replaced at build time, so don't move it.
- **To modify the weekly blog generation:** Edit `scripts/generate-blog-post.js`. The OpenAI prompts are in functions like `buildPrompt()`, `generateInstagramCaption()`, `identifyTopComedians()`.
- **To modify per-comedian blog posts:** Edit `scripts/generate-comedian-post.js`. Key functions: `researchComedian()` (research prompt), `writeBlogPost()` (writing prompt with source links), `factCheckPost()` (editorial pass). The writing prompt includes banned phrase lists, source URL requirements, and the Comedy Houston footer.
- **To change the WordPress plugin:** Edit files in `wordpress/`. The PHP file handles server-side logic + admin click analytics dashboard; the JS file handles client-side filtering + GA4 event tracking; the CSS file has three theme variants.
- **To change the automation schedule:** Edit the `cron` lines in `.github/workflows/*.yml`. Times are in UTC. The comedian post workflow runs 1 hour after the weekly blog post.
- **GA4 tracking:** The JS fires `gtag('event', 'ticket_click', {...})` on every "Get Tickets" click. Requires Google Site Kit (or any gtag injection) on the WordPress site. Events appear in GA4 → Reports → Engagement → Events.
- **Click analytics dashboard:** The PHP admin page queries `wp_ch_clicks` for top 10 links clicked today and last 30 days. URL slugs are parsed into readable show names via `extract_link_label()`.
- **There are no tests.** This is a personal project. Changes are validated by running locally and checking the output.
- **There are no npm dependencies.** Don't add any unless absolutely necessary — the zero-dependency approach is intentional.
