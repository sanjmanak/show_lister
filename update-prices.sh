#!/usr/bin/env bash
#
# One-click local price refresh for Comedy Houston.
#
# Why this exists: Ticketmaster and TicketWeb block page fetches coming from
# GitHub Actions' datacenter IPs (HTTP 403/530), so the scheduled workflow can
# never scrape ticket prices itself. Run from a home connection this script
# CAN scrape them. It:
#
#   1. pulls the latest events.json from GitHub,
#   2. scrapes missing prices from each event's own ticket page (JSON-LD),
#   3. commits and pushes events.json + index.html + config/price-cache.json.
#
# After the push, the twice-daily Action reuses the recovered prices from
# config/price-cache.json on every run, so once a week is plenty. No API keys
# are needed — prices-only mode never calls the Ticketmaster/Eventbrite APIs.
#
# Usage:  ./update-prices.sh          (from the repo root, on branch main)
#         npm run prices:publish      (same thing)
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "ERROR: you are on branch '$branch', not 'main'." >&2
  echo "Run 'git checkout main' first — this script publishes straight to the live site." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --staged --quiet; then
  echo "ERROR: you have uncommitted local changes." >&2
  echo "Commit or stash them first so the price refresh can't tangle with them." >&2
  exit 1
fi

echo "==> Pulling latest data from GitHub..."
git pull --rebase origin main

# Ticketmaster/TicketWeb 401 plain fetches (since Aug 2026), so those pages
# are loaded through headless Chrome. First run downloads Chrome (~200MB).
if ! node -e "require('puppeteer')" >/dev/null 2>&1; then
  echo "==> Installing puppeteer (one-time, includes a ~200MB Chrome download)..."
  npm install puppeteer --no-save
fi

echo "==> Scraping prices from your home IP (this is the part GitHub's servers can't do)..."
node scripts/fetch-events.js --prices-only

echo "==> Publishing to GitHub..."
git add events.json index.html config/price-cache.json
if git diff --staged --quiet; then
  echo "No price changes to publish — everything was already up to date. Done."
  exit 0
fi
git commit -m "Price refresh (local) — $(date +'%B %d, %Y %I:%M %p')"

# Retry with rebase: the twice-daily Action may push between our pull and push.
for i in 2 4 8 16; do
  if git push origin main; then
    echo ""
    echo "Published! The homepage and WordPress plugin pick this up automatically."
    exit 0
  fi
  echo "Push rejected (someone else pushed first?) — rebasing and retrying in ${i}s..."
  sleep "$i"
  git pull --rebase origin main || { git rebase --abort 2>/dev/null || true; }
done

echo "ERROR: could not push after 4 attempts. Your commit is safe locally —" >&2
echo "run 'git pull --rebase origin main && git push origin main' to finish." >&2
exit 1
