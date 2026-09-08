# Event Scraper

**Every event in a city. One place.**

This is an automated event aggregator that pulls comedy shows from Ticketmaster, Eventbrite and StandupTix venue sites, deduplicates them, and publishes `events.json`, which the comedyhouston.com WordPress plugin renders — updated twice daily. GitHub Pages stays enabled only to serve the Instagram graphics in `blog/comedians/images/`.

## Data Sources

- **Ticketmaster Discovery API** — Houston DMA comedy events (Houston Improv, Punch Line, arena shows, etc.)
- **Eventbrite API** — The Riot Comedy Club, The Secret Group, and other Houston comedy organizers

## How It Works

1. A GitHub Action runs at **8 AM and 6 PM Central** (and can be triggered manually)
2. `scripts/fetch-events.js` calls both APIs, normalizes events into a common schema, and deduplicates
3. The script writes `events.json`
4. The Action commits and pushes; the WordPress plugin fetches the new file from raw.githubusercontent.com and purges its cache

## Setup

### 1. Get API Keys

**Ticketmaster:**
1. Go to [developer.ticketmaster.com](https://developer.ticketmaster.com)
2. Create an account (free, instant approval)
3. Copy your **Consumer Key** (this is your API key)

**Eventbrite:**
1. Go to [eventbrite.com/platform](https://www.eventbrite.com/platform)
2. Log in or create an account
3. Go to **Account Settings > Developer Links > API Keys**
4. Copy your **Private Token**

### 2. Add Secrets to GitHub

1. Go to your repository on GitHub
2. Click **Settings** (tab at the top)
3. In the left sidebar, click **Secrets and variables > Actions**
4. Click **New repository secret**
5. Add `TICKETMASTER_API_KEY` with your Ticketmaster Consumer Key
6. Add `EVENTBRITE_TOKEN` with your Eventbrite Private Token

### 3. Enable GitHub Pages (images only)

Settings > Pages > deploy from `main` / root. Only `blog/comedians/images/` is served from it (the Instagram poster hands those URLs to Meta).

### 4. Run It

- Go to the **Actions** tab
- Click **Update Comedy Events** in the left sidebar
- Click **Run workflow** button
- Wait for it to finish (check the green checkmark)
- `events.json` on `main` is updated; comedyhouston.com picks it up within the hour

## Local Development

```bash
# Set environment variables
export TICKETMASTER_API_KEY="your-key-here"
export EVENTBRITE_TOKEN="your-token-here"

# Run the fetcher
node scripts/fetch-events.js

# Inspect the output
head -c 2000 events.json
```

## File Structure

```
├── .github/workflows/update-events.yml   # Scheduled GitHub Action
├── scripts/fetch-events.js               # API fetcher & normalizer
├── events.json                           # Generated event data (read by the WP plugin)
├── wordpress/
│   ├── comedy-houston.php                # WordPress plugin (v2.16.0)
│   ├── comedy-houston-template.php       # Plugin HTML template
│   ├── comedy-houston.js                 # Client-side filtering & sorting
│   └── comedy-houston.css                # Plugin styles (dark/light/auto)
├── package.json                          # Project metadata
└── README.md
```

## Prices

Ticketmaster's Discovery API returns no `priceRanges` for most Houston comedy
events (TicketWeb-fulfilled Houston Improv shows especially). The fetcher
backfills prices in three steps: a cross-run cache (`config/price-cache.json`),
the TM detail endpoint, and finally the event's own ticket page — parsing the
schema.org JSON-LD that ticketmaster.com/ticketweb.com embed. Page-scraped
prices **include fees**, so they carry `price_source: "page"` in `events.json`
and render as "From $X incl. fees"; API prices carry `price_source: "api"`.
Delete `config/price-cache.json` any time — it rebuilds over the next runs.

### Local price refresh (required for page-scraped prices)

Ticketmaster and TicketWeb **block page fetches from GitHub Actions'
datacenter IPs** (HTTP 403 from ticketmaster.com, HTTP 530 from
ticketweb.com), so the scheduled workflow's page-scrape step never succeeds
on its own — from GitHub, every Ticketmaster/Improv show stays "Price TBA".
The same fetches work fine from a residential connection, so prices are
refreshed by a short local run:

```bash
./update-prices.sh        # or: npm run prices:publish
```

One command does everything: pulls the latest `events.json`, scrapes the
missing prices from each event's ticket page (no API keys needed — the
`--prices-only` mode never calls the TM/EB APIs), and commits + pushes
`events.json` and `config/price-cache.json` back to `main`.
On a Mac, double-clicking `update-prices.command` in Finder does the same.
To refresh prices without publishing, run `npm run prices` and inspect the
diff yourself.

Once a week is enough: the scheduled Action reuses the pushed cache on every
run (and keeps stale entries as a fallback after the 7-day TTL, so prices
degrade gracefully rather than reverting to TBA). The
`price-reminder.yml` workflow checks coverage every Monday and emails a
reminder (via the same SMTP secrets as the failure alerts) only when a local
run is actually due.

## WordPress Page Caching (important)

The `[comedy_houston]` listings are **date-dependent** — `/tonight/` and
`/this-weekend/` (and the "Tonight"/"Tomorrow" headers everywhere) are computed
server-side at render time. The plugin sends a `Cache-Control` header that
expires cached copies at the next midnight America/Chicago, but full-page
caches that ignore response headers (some host caches, WP cache plugins with
fixed TTLs) **must exclude `/tonight/` and `/this-weekend/` from page caching**
(or honor the header). Otherwise crawlers and visitors get yesterday's shows
after midnight.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Action fails with 401 | API key expired or wrong — update the secret |
| Action fails with 429 | Rate limit hit — the script retries automatically, but if persistent, reduce call frequency |
| Site shows 0 events | Check Action logs; one or both APIs may be down |
| Site not updating | The plugin caches events.json; the update workflow purges it, and an hourly cron purges as a fallback |
| Events look stale | Trigger a manual workflow run from the Actions tab |
