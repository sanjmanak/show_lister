# Code Summary

## What This Project Does

Show Lister (`houston-comedy-shows`) is an automated event aggregator for Houston comedy shows. It pulls events from Ticketmaster, Eventbrite and StandupTix venue sites, merges and deduplicates them, and publishes `events.json` for the comedyhouston.com WordPress plugin — updated twice daily with zero manual effort.

## Architecture

```
  Ticketmaster API ──┐
  Eventbrite API ────┼──▶ fetch-events.js ──▶ events.json ──▶ WordPress plugin (comedyhouston.com)
  StandupTix sites ──┘
```

**Pipeline:** GitHub Actions (cron) → Node.js script → events.json on `main` → WP plugin fetches from raw.githubusercontent.com

## Key Files

| File | Purpose |
|------|---------|
| `scripts/fetch-events.js` | Core script (~500 lines). Fetches, normalizes, deduplicates events and generates output files. |
| `.github/workflows/update-events.yml` | GitHub Actions workflow. Runs at 8 AM and 6 PM CT on a cron schedule. |
| `events.json` | Generated data file containing all normalized events. |
| `package.json` | Project metadata. Single script: `npm run fetch`. |

## How `fetch-events.js` Works

### 1. Data Fetching

Two API sources are queried in parallel (`Promise.all`):

- **Ticketmaster Discovery API v2** — Searches for comedy events within 100 miles of Houston (lat/lon: 29.7604, -95.3698), plus venue-specific queries (Houston Improv). Results are post-filtered to Texas only.
- **Eventbrite API v3** — Fetches events from hardcoded organizers: The Riot Comedy Club, The Secret Group, Social Comedy Night, The Den Comedy Club, and Cat Dad Comedy. Supports pagination (up to 10 pages per organizer).

Both use a shared `fetchJSON()` helper with automatic retry on HTTP 429 (rate limit) and network errors, using exponential backoff (2s, 4s, 6s).

### 2. Normalization

Each API returns different data shapes. `normalizeTM()` and `normalizeEB()` convert them into a common schema:

```
{ id, name, venue, date, time, day_of_week, price_min, price_max,
  currency, ticket_url, image_url, source, age_restriction, status,
  description, last_updated }
```

### 3. Deduplication

Events are deduplicated by a 16-character SHA-256 hash of `name|date|venue` (lowercased). When duplicates exist across sources, the event with the higher "completeness score" wins (scored by presence of image, price, description, ticket URL, and time).

### 4. Output Generation

- `events.json` — Written with all event data plus metadata (`last_updated`, `total_events`).

## Frontend

The WordPress plugin in `wordpress/` (`[comedy_houston]` shortcode) renders the listings on comedyhouston.com from `events.json`. The old static `index.html` mirror on GitHub Pages was retired in Sept 2026 (noindexed, unlinked, 866KB of churn per commit).

## CI/CD Pipeline

The GitHub Actions workflow (`.github/workflows/update-events.yml`):

1. Triggers on cron (`0 14 * * *` and `0 0 * * *` UTC, ~8 AM / 6 PM CT) or manual dispatch
2. Checks out the repo, sets up Node.js v20
3. Runs `node scripts/fetch-events.js` with API keys from GitHub Secrets
4. Commits and pushes `events.json` only if it changed, then purges the plugin's cache

## Tech Stack

- **Node.js v20** — built-in modules only (`https`, `fs`, `crypto`, `path`), no npm dependencies
- **Plain HTML/CSS/JS** — no frontend frameworks
- **GitHub Actions** — scheduled automation
- **GitHub Pages** — serves the Instagram graphics only
