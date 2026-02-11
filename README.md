# Event Scraper

**Every event in a city. One place.**

Automated event aggregator that pulls comedy shows from Ticketmaster and Eventbrite, deduplicates them, and publishes a static site to GitHub Pages — updated twice daily.

## Data Sources

- **Ticketmaster Discovery API** — comedy events filtered to the Houston area (within ~100 miles)
- **Eventbrite API** — events from known Houston organizers, also filtered to Houston-area venues

## How It Works

1. A GitHub Action runs at **8 AM and 6 PM Central** (and can be triggered manually)
2. `scripts/fetch-events.js` calls both APIs, normalizes events into a common schema, filters to Houston-area shows in the next 90 days, and deduplicates
3. The script writes `events.json` and injects data into `index.html`
4. The Action commits and pushes — GitHub Pages rebuilds automatically

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

### 3. Enable GitHub Pages

1. Go to **Settings > Pages** (in the left sidebar)
2. Under **Source**, select **Deploy from a branch**
3. Set branch to `main` (or `master`) and folder to `/ (root)`
4. Click **Save**

### 4. Run It

- Go to the **Actions** tab
- Click **Update Comedy Events** in the left sidebar
- Click **Run workflow** button
- Wait for it to finish (check the green checkmark)
- Visit `https://<your-username>.github.io/<repo-name>/`

## Local Development

```bash
# Set environment variables
export TICKETMASTER_API_KEY="your-key-here"
export EVENTBRITE_TOKEN="your-token-here"

# Run the fetcher
node scripts/fetch-events.js

# Open index.html in your browser
open index.html
```

## File Structure

```
├── .github/workflows/update-events.yml   # Scheduled GitHub Action
├── scripts/fetch-events.js               # API fetcher & normalizer
├── events.json                           # Generated event data
├── index.html                            # Static site (dark theme, responsive)
├── package.json                          # Project metadata
└── README.md
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Action fails with 401 | API key expired or wrong — update the secret |
| Action fails with 429 | Rate limit hit — the script retries automatically, but if persistent, reduce call frequency |
| Page shows 0 events | Check Action logs; one or both APIs may be down. Events load from embedded data or `events.json` |
| Page not updating | Check that GitHub Pages is enabled and pointing to the right branch |
| Events look stale | Trigger a manual workflow run from the Actions tab |
| Seeing non-Houston events | Check that Ticketmaster/Eventbrite credentials are valid and rerun; script now filters by Houston radius + date window |
