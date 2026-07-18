#!/usr/bin/env node

/**
 * Comedy Houston — Event Fetcher
 * Pulls comedy events from Ticketmaster and Eventbrite APIs,
 * normalizes them into a single schema, deduplicates, and writes events.json + index.html.
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TM_API_KEY = process.env.TICKETMASTER_API_KEY || "";
const EB_TOKEN = process.env.EVENTBRITE_TOKEN || "";

const HOUSTON_LAT = "29.7604";
const HOUSTON_LON = "-95.3698";
const SEARCH_RADIUS = "100";
const SEARCH_UNIT = "miles";
const MAX_DAYS_AHEAD = 90;
const TM_BASE = "https://app.ticketmaster.com/discovery/v2/events.json";

const EB_BASE = "https://www.eventbriteapi.com/v3";
const EB_ORGANIZERS = [
  { id: "29979960920", name: "The Riot Comedy Club" },
  { id: "20138725138", name: "The Secret Group" },
  { id: "120744254440", name: "Social Comedy Night" },
  { id: "120997218882", name: "The Den Comedy Club" },
  { id: "120461230041", name: "Cat Dad Comedy" },
  // The Riot's second location, hosted at GuadalaHARRY's in Conroe. This
  // organizer account only produces Conroe shows, and Eventbrite's raw venue
  // string for them varies ("GuadalaHARRY's", etc.), so `forceVenue` pins
  // every event to the canonical Conroe venue name rather than relying on the
  // per-event venue string. Must match the venue `name` in config/venues.json.
  {
    id: "120648602531",
    name: "The Riot Comedy Club — Conroe",
    forceVenue: "The Riot Comedy Club — Conroe",
  },
];

const OUTPUT_DIR = path.resolve(__dirname, "..");
const EVENTS_JSON_PATH = path.join(OUTPUT_DIR, "events.json");
const INDEX_HTML_PATH = path.join(OUTPUT_DIR, "index.html");
const TEMPLATE_PATH = path.join(OUTPUT_DIR, "index.html");
const FILTERS_JSON_PATH = path.join(OUTPUT_DIR, "config", "filters.json");
const EXCLUDED_JSON_PATH = path.join(OUTPUT_DIR, "excluded-events.json");
const PRICE_CACHE_PATH = path.join(OUTPUT_DIR, "config", "price-cache.json");

// Price-enrichment pacing. Ticketmaster's Discovery API allows 5 req/s, so
// detail calls are spaced 250ms apart. Ticket-page fetches hit the vendors'
// public web servers — space them out further and only ~111 pages max, 2x/day.
const API_DETAIL_DELAY_MS = 250;
const PAGE_FETCH_DELAY_MS = 350;
// Re-verify page-scraped prices this often; between refreshes the cached
// price is reused so resolved events cost zero fetches per run.
const PRICE_CACHE_TTL_DAYS = 7;

// ---------------------------------------------------------------------------
// HTTP helper with retries
// ---------------------------------------------------------------------------

// 30s per-call cap. Ticketmaster / Eventbrite normally respond in <2s; anything
// past 30s is a stalled socket and will burn the 15-min job timeout if we let
// it. Applied via req.setTimeout() so it fires even after the connection has
// been established (socket read stalls, not just connect stalls).
const FETCH_TIMEOUT_MS = 30_000;

// Default headers on every API request. Node's https module sends NO
// User-Agent by default, and Eventbrite's CloudFront WAF started blocking
// UA-less requests with a 403 "Request blocked" HTML page (first observed
// 2026-06-11 — every organizer call failed and events.json silently went
// Ticketmaster-only). An identifying UA is also just good API citizenship.
const DEFAULT_HEADERS = {
  "User-Agent": "ComedyHouston-EventBot/1.0 (+https://comedyhouston.com)",
  "Accept": "application/json",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fetchJSON(url, headers = {}, retries = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { ...DEFAULT_HEADERS, ...headers } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        // Retry transient server errors too — a single TM/EB 502 used to kill
        // that source's whole fetch for the run.
        if ((res.statusCode === 429 || res.statusCode >= 500) && retries > 0) {
          const wait = (4 - retries) * 2000;
          console.log(`  HTTP ${res.statusCode}. Retrying in ${wait / 1000}s...`);
          return setTimeout(
            () => fetchJSON(url, headers, retries - 1).then(resolve, reject),
            wait
          );
        }
        if (res.statusCode >= 400) {
          return reject(
            new Error(`HTTP ${res.statusCode} for ${url}\n${body.slice(0, 500)}`)
          );
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON parse error for ${url}: ${e.message}`));
        }
      });
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`));
    });
    req.on("error", (err) => {
      if (retries > 0) {
        const wait = (4 - retries) * 2000;
        console.log(`  Network error. Retrying in ${wait / 1000}s...`);
        setTimeout(
          () => fetchJSON(url, headers, retries - 1).then(resolve, reject),
          wait
        );
      } else {
        reject(err);
      }
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Ticket-page fetching (price fallback)
//
// The Discovery API has NO priceRanges for most Houston comedy events (the
// 2026-07-17 run backfilled 0/200 via the detail endpoint with zero request
// failures — the data simply isn't there, especially for TicketWeb-fulfilled
// Houston Improv shows). The public event pages DO show prices, and both
// ticketmaster.com and ticketweb.com embed schema.org Event JSON-LD with an
// offers block carrying price/lowPrice/highPrice. So as a last resort we
// fetch the event's own ticket page and read the price out of its JSON-LD.
// NOTE: page prices include fees (the API's priceRanges are face value), so
// these are stamped price_source:"page" and the UI labels them "incl. fees".
// ---------------------------------------------------------------------------

// A plain browser UA: ticket vendors serve the full page (JSON-LD included)
// to browsers, while obvious bot UAs risk a WAF block page with no schema.
const PAGE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
};

/** Fetch an HTML page as text: follows redirects (TM URLs often 301 to the
 * canonical slug), decompresses gzip/brotli, no retries — a per-event miss
 * is tolerated by the caller and retried on the next scheduled run. */
function fetchPage(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(new Error(`Bad URL: ${url}`));
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return reject(new Error(`Unsupported protocol: ${url}`));
    }
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.get(url, { headers: PAGE_HEADERS }, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location &&
        redirectsLeft > 0
      ) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return fetchPage(next, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        try {
          if (enc.includes("br")) buf = zlib.brotliDecompressSync(buf);
          else if (enc.includes("gzip")) buf = zlib.gunzipSync(buf);
          else if (enc.includes("deflate")) {
            try {
              buf = zlib.inflateSync(buf);
            } catch (e) {
              buf = zlib.inflateRawSync(buf);
            }
          }
        } catch (e) {
          return reject(new Error(`Decompress failed (${enc}): ${e.message}`));
        }
        resolve(buf.toString("utf8"));
      });
      res.on("error", reject);
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`));
    });
    req.on("error", reject);
  });
}

/** All parseable <script type="application/ld+json"> payloads in a page. */
function extractJsonLdBlocks(html) {
  const blocks = [];
  const re =
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch (e) {
      // Malformed block — skip it, others may still parse.
    }
  }
  return blocks;
}

/**
 * Pull {min, max, currency} out of a ticket page's schema.org Event JSON-LD,
 * or null when the page carries no usable price. Handles single Offer,
 * Offer arrays, AggregateOffer (lowPrice/highPrice), priceSpecification,
 * @graph nesting, and Event subtypes (ComedyEvent, TheaterEvent, ...).
 *
 * Guards: a page price of 0 is a placeholder (unavailable/TBA), NOT a free
 * show — free shows come from the APIs, never from scraping. Prices are also
 * sanity-bounded so a parse artifact can't publish a $0.50 or $50,000 ticket.
 */
function parseJsonLdPrices(html) {
  const toNum = (v) => {
    if (v === null || v === undefined || typeof v === "object") return null;
    const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  const lows = [];
  const highs = [];
  let currency = null;

  const visitOffer = (offer) => {
    if (!offer || typeof offer !== "object") return;
    if (Array.isArray(offer)) {
      for (const o of offer) visitOffer(o);
      return;
    }
    const spec =
      offer.priceSpecification && typeof offer.priceSpecification === "object"
        ? offer.priceSpecification
        : null;
    let low = toNum(offer.lowPrice);
    if (low === null) low = toNum(offer.price);
    if (low === null && spec) low = toNum(spec.minPrice) ?? toNum(spec.price);
    let high = toNum(offer.highPrice);
    if (high === null && spec) high = toNum(spec.maxPrice);
    if (low !== null && low > 0 && low < 5000) {
      lows.push(low);
      if (high !== null && high >= low && high < 10000) highs.push(high);
      if (!currency) {
        currency = offer.priceCurrency || (spec ? spec.priceCurrency : null) || null;
      }
    } else if (high !== null && high > 0 && high < 10000) {
      // Aggregate offer with only a highPrice — still worth the range top.
      highs.push(high);
    }
  };

  const visitNode = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visitNode(n);
      return;
    }
    const type = [].concat(node["@type"] || []).join(",");
    if (/Event/i.test(type) && node.offers) visitOffer(node.offers);
    if (node["@graph"]) visitNode(node["@graph"]);
  };

  for (const block of extractJsonLdBlocks(html)) visitNode(block);
  if (lows.length === 0) return null;
  const min = Math.min(...lows);
  // Multiple tier Offers (GA $29, VIP $41.50) each carry a plain `price`;
  // the top of the range is the highest of everything seen.
  const top = Math.max(...lows.concat(highs));
  return {
    min,
    max: top >= min ? top : min,
    currency: currency || "USD",
  };
}

// ---------------------------------------------------------------------------
// Price cache (config/price-cache.json)
//
// Page-scraped (and API-detail) prices are persisted across runs keyed by
// event id, so an event resolved once isn't re-fetched twice a day for the
// rest of its on-sale life. Entries refresh after PRICE_CACHE_TTL_DAYS and
// are pruned when their event leaves the feed.
// ---------------------------------------------------------------------------

function loadPriceCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(PRICE_CACHE_PATH, "utf8"));
    return raw && typeof raw.entries === "object" && raw.entries !== null
      ? raw.entries
      : {};
  } catch (e) {
    return {};
  }
}

function savePriceCache(entries) {
  const payload = {
    _readme:
      "Prices recovered by scripts/fetch-events.js price enrichment (API detail endpoint or ticket-page JSON-LD), keyed by event id. source:'page' prices include fees. Safe to delete — it will be rebuilt over the next runs.",
    last_updated: new Date().toISOString(),
    entries,
  };
  fs.writeFileSync(PRICE_CACHE_PATH, JSON.stringify(payload, null, 2));
}

function applyPrice(ev, min, max, currency, source) {
  ev.price_min = min;
  ev.price_max = max !== null && max !== undefined ? max : min;
  if (currency) ev.currency = currency;
  ev.price_source = source;
}

/**
 * Best-effort price backfill, run AFTER relevance filtering + dedup so we
 * never spend a request on an event that won't be published.
 *
 *   1. cache  — reuse prices resolved on previous runs (fresh within TTL)
 *   2. api    — Ticketmaster detail endpoint (face value, throttled 250ms)
 *   3. page   — the event's own ticket page's schema.org JSON-LD (includes
 *               fees; throttled; works for TM, TicketWeb, Eventbrite, etc.)
 *
 * We NEVER fabricate a price. Every step logs per-event success/failure and
 * a summary so the Action log shows exactly what was recovered from where.
 */
async function enrichPrices(events) {
  const isMissing = (e) => e.price_min === null || e.price_min === undefined;
  const cache = loadPriceCache();
  const cacheSnapshot = JSON.stringify(cache);
  const nowMs = Date.now();
  const ttlMs = PRICE_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

  const missing = events.filter(isMissing);
  const currentIds = new Set(events.map((e) => e.id));

  let fromCache = 0;
  let fromApi = 0;
  let fromPage = 0;

  if (missing.length > 0) {
    console.log(`[prices] ${missing.length} event(s) missing a price.`);

    // Pass 1: cache.
    const uncached = [];
    for (const e of missing) {
      const c = cache[e.id];
      const fresh =
        c &&
        typeof c.price_min === "number" &&
        c.price_min > 0 &&
        nowMs - (Date.parse(c.fetched_at) || 0) < ttlMs;
      if (fresh) {
        applyPrice(e, c.price_min, c.price_max, c.currency, c.source || "page");
        fromCache++;
      } else {
        uncached.push(e);
      }
    }

    // Pass 2: Ticketmaster detail endpoint.
    const detailTargets = TM_API_KEY ? uncached.filter((e) => e._tmId) : [];
    if (detailTargets.length > 0) {
      console.log(
        `[prices] Trying TM detail endpoint for ${detailTargets.length} event(s)...`
      );
    }
    for (const e of detailTargets) {
      await sleep(API_DETAIL_DELAY_MS);
      const url =
        `https://app.ticketmaster.com/discovery/v2/events/` +
        `${encodeURIComponent(e._tmId)}.json?apikey=${encodeURIComponent(TM_API_KEY)}`;
      try {
        const detail = await fetchJSON(url);
        const pr = detail && Array.isArray(detail.priceRanges) ? detail.priceRanges : [];
        if (pr.length > 0 && typeof pr[0].min === "number" && pr[0].min > 0) {
          applyPrice(
            e,
            pr[0].min,
            typeof pr[0].max === "number" ? pr[0].max : pr[0].min,
            pr[0].currency || null,
            "api"
          );
          cache[e.id] = {
            price_min: e.price_min,
            price_max: e.price_max,
            currency: e.currency,
            source: "api",
            url,
            fetched_at: new Date().toISOString(),
          };
          fromApi++;
          console.log(`  [prices] api hit: "${e.name}" ${e.date} → $${e.price_min}`);
        } else {
          console.log(`  [prices] api: no priceRanges for "${e.name}" (${e._tmId})`);
        }
      } catch (err) {
        console.log(`  [prices] api detail FAILED for "${e.name}": ${err.message}`);
      }
    }

    // Pass 3: the event's own ticket page.
    const pageTargets = uncached.filter(
      (e) => isMissing(e) && /^https?:\/\//i.test(String(e.ticket_url || ""))
    );
    if (pageTargets.length > 0) {
      console.log(
        `[prices] Trying ticket-page JSON-LD for ${pageTargets.length} event(s)...`
      );
    }
    for (const e of pageTargets) {
      await sleep(PAGE_FETCH_DELAY_MS);
      const stale = cache[e.id];
      try {
        const html = await fetchPage(e.ticket_url);
        const p = parseJsonLdPrices(html);
        if (p) {
          applyPrice(e, p.min, p.max, p.currency, "page");
          cache[e.id] = {
            price_min: p.min,
            price_max: p.max,
            currency: p.currency,
            source: "page",
            url: e.ticket_url,
            fetched_at: new Date().toISOString(),
          };
          fromPage++;
          console.log(
            `  [prices] page hit: "${e.name}" ${e.date} → $${p.min}` +
              (p.max !== p.min ? `–$${p.max}` : "") +
              " (incl. fees)"
          );
        } else if (stale && typeof stale.price_min === "number" && stale.price_min > 0) {
          // Page no longer carries a price (e.g. sold out) — a stale cached
          // price beats regressing to "Price TBA".
          applyPrice(e, stale.price_min, stale.price_max, stale.currency, stale.source || "page");
          fromCache++;
          console.log(`  [prices] page had no price for "${e.name}" — kept stale cache`);
        } else {
          console.log(`  [prices] page: no JSON-LD price on ${e.ticket_url}`);
        }
      } catch (err) {
        if (stale && typeof stale.price_min === "number" && stale.price_min > 0) {
          applyPrice(e, stale.price_min, stale.price_max, stale.currency, stale.source || "page");
          fromCache++;
          console.log(
            `  [prices] page fetch FAILED for "${e.name}" (${err.message}) — kept stale cache`
          );
        } else {
          console.log(`  [prices] page fetch FAILED for "${e.name}": ${err.message}`);
        }
      }
    }
  }

  // Prune cache entries for events no longer in the feed, then persist —
  // but only when the entries actually changed, so a run that recovers
  // nothing doesn't dirty the file with a timestamp-only bump (which would
  // make update-prices.sh publish an empty "price refresh" commit).
  for (const id of Object.keys(cache)) {
    if (!currentIds.has(id)) delete cache[id];
  }
  if (JSON.stringify(cache) !== cacheSnapshot) {
    try {
      savePriceCache(cache);
    } catch (err) {
      console.warn(`[prices] Could not write ${PRICE_CACHE_PATH}: ${err.message}`);
    }
  }

  const stillUnknown = events.filter(isMissing).length;
  console.log(
    `[prices] Summary: ${fromCache} from cache, ${fromApi} from API detail, ` +
      `${fromPage} from ticket pages; ${stillUnknown} still unknown ` +
      `(of ${missing.length} initially missing, ${events.length} total).`
  );
}

// ---------------------------------------------------------------------------
// Ticketmaster
// ---------------------------------------------------------------------------

async function fetchTicketmaster() {
  if (!TM_API_KEY) {
    console.log("[Ticketmaster] No API key — skipping.");
    return [];
  }

  console.log("[Ticketmaster] Fetching comedy events near Houston, TX...");
  const events = [];

  const now = new Date();
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() + MAX_DAYS_AHEAD);

  // Format as "yyyy-MM-ddTHH:mm:ssZ". Anchored to the start of TODAY in
  // America/Chicago, not the current UTC instant — the same fix the
  // Eventbrite side got in 6d9dec7. Anchoring to now.toISOString() made an
  // evening run (00:00 UTC = ~7pm CT) drop every Ticketmaster show earlier
  // that same evening, so tonight's lineup vanished from the feed mid-day.
  const startDateTime = centralStartOfDayUTC(now)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const endDateTime = endDate.toISOString().replace(/\.\d{3}Z$/, "Z");

  // Broad comedy search near Houston using lat/long + radius
  const params = new URLSearchParams({
    apikey: TM_API_KEY,
    classificationName: "comedy",
    latlong: `${HOUSTON_LAT},${HOUSTON_LON}`,
    radius: SEARCH_RADIUS,
    unit: SEARCH_UNIT,
    stateCode: "TX",
    startDateTime,
    endDateTime,
    size: "200",
    sort: "date,asc",
  });

  try {
    const data = await fetchJSON(`${TM_BASE}?${params}`);
    if (data._embedded && data._embedded.events) {
      for (const ev of data._embedded.events) {
        events.push(normalizeTM(ev));
      }
    }
    console.log(`[Ticketmaster] Found ${events.length} events from geo search.`);
  } catch (err) {
    console.error(`[Ticketmaster] Geo search failed: ${err.message}`);
  }

  // Venue-specific searches for Houston Improv
  const venueIds = [
    { id: "KovZpZAJledA", name: "Houston Improv" },
  ];

  for (const venue of venueIds) {
    try {
      const vp = new URLSearchParams({
        apikey: TM_API_KEY,
        venueId: venue.id,
        startDateTime,
        endDateTime,
        size: "200",
        sort: "date,asc",
      });
      const data = await fetchJSON(`${TM_BASE}?${vp}`);
      if (data._embedded && data._embedded.events) {
        let added = 0;
        for (const ev of data._embedded.events) {
          const normalized = normalizeTM(ev);
          if (!events.find((e) => e.id === normalized.id)) {
            events.push(normalized);
            added++;
          }
        }
        console.log(`[Ticketmaster] +${added} events from ${venue.name}.`);
      }
    } catch (err) {
      console.error(`[Ticketmaster] ${venue.name} search failed: ${err.message}`);
    }
  }

  // Post-fetch safety filter: only keep events in Texas
  const txEvents = events.filter((e) => {
    if (!e.venue_state) return true; // keep if state unknown
    return e.venue_state === "TX";
  });
  const removed = events.length - txEvents.length;
  if (removed > 0) {
    console.log(`[Ticketmaster] Filtered out ${removed} non-TX events.`);
  }

  // Price enrichment happens in main() AFTER relevance filtering + dedup so
  // no requests are spent on events that won't be published. _tmId rides
  // along until then and is stripped before events.json is written.
  return txEvents;
}

function normalizeTM(ev) {
  const venueObj =
    ev._embedded && ev._embedded.venues && ev._embedded.venues[0]
      ? ev._embedded.venues[0]
      : null;
  const venue = normalizeVenueName(venueObj ? venueObj.name : "Unknown Venue");
  const venueState =
    venueObj && venueObj.state ? venueObj.state.stateCode : null;
  const venueCity =
    venueObj && venueObj.city ? venueObj.city.name : null;

  const dateStr =
    ev.dates && ev.dates.start ? ev.dates.start.localDate : null;
  const timeStr =
    ev.dates && ev.dates.start ? ev.dates.start.localTime : null;

  const priceRanges = ev.priceRanges || [];
  const priceMin = priceRanges.length > 0 ? priceRanges[0].min : null;
  const priceMax = priceRanges.length > 0 ? priceRanges[0].max : null;
  const currency = priceRanges.length > 0 ? priceRanges[0].currency : "USD";

  const image = pickBestImage(ev.images || []);
  const ageRestriction =
    ev.ageRestrictions && ev.ageRestrictions.legalAgeEnforced ? "18+" : null;

  const status =
    ev.dates && ev.dates.status ? ev.dates.status.code : "unknown";

  // Ticketmaster's "comedy" search leaks touring musicals and plays
  // (Spamilton, Clue). Stamp the genre so downstream consumers (daily
  // Tonight post, weekly hero backfill) can filter Theatre out.
  const genre =
    ev.classifications && ev.classifications[0] && ev.classifications[0].genre
      ? ev.classifications[0].genre.name || null
      : null;

  return {
    id: makeId(ev.name, dateStr, venue),
    // Raw Ticketmaster event id, used only to enrich missing prices via the
    // detail endpoint (see enrichTMPrices). Stripped before events are
    // returned, so it never lands in events.json.
    _tmId: ev.id || null,
    name: ev.name || "Untitled Event",
    genre,
    venue,
    venue_state: venueState,
    venue_city: venueCity,
    date: dateStr,
    time: formatTime(timeStr),
    day_of_week: dateStr ? getDayOfWeek(dateStr) : null,
    price_min: priceMin,
    price_max: priceMax,
    currency,
    // Where the price came from: "api" = face value from the source API,
    // "page" = scraped from the ticket page's JSON-LD (includes fees —
    // the UI labels those "incl. fees"). Null when no price is known.
    price_source: priceMin !== null ? "api" : null,
    ticket_url: ev.url || null,
    image_url: image,
    source: "ticketmaster",
    age_restriction: ageRestriction,
    status: mapTMStatus(status),
    description: ev.info || ev.pleaseNote || null,
    last_updated: new Date().toISOString(),
  };
}

function mapTMStatus(code) {
  const map = {
    onsale: "on_sale",
    offsale: "off_sale",
    cancelled: "cancelled",
    postponed: "postponed",
    rescheduled: "rescheduled",
  };
  return map[code] || "unknown";
}

function pickBestImage(images) {
  if (!images || images.length === 0) return null;
  // Prefer 16:9 ratio, largest width
  const ratio16x9 = images.filter((i) => i.ratio === "16_9");
  const pool = ratio16x9.length > 0 ? ratio16x9 : images;
  pool.sort((a, b) => (b.width || 0) - (a.width || 0));
  return pool[0].url || null;
}

// ---------------------------------------------------------------------------
// Eventbrite
// ---------------------------------------------------------------------------

async function fetchEventbrite() {
  if (!EB_TOKEN) {
    console.log("[Eventbrite] No token — skipping.");
    return [];
  }

  console.log("[Eventbrite] Fetching events from known organizers...");
  const events = [];
  const headers = { Authorization: `Bearer ${EB_TOKEN}` };

  const now = new Date();
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() + MAX_DAYS_AHEAD);

  // Eventbrite reads a NAIVE `start_date.range_*` (no "Z"/offset) as the
  // event's LOCAL time — Central for Houston — not UTC. Passing
  // now.toISOString() (a UTC wall-clock like "21:10") therefore got read as
  // 9:10pm Central, which silently dropped every show still to come earlier
  // that evening: an afternoon run wiped out that night's whole lineup.
  //
  // Anchor the window to Central calendar days instead: from the start of
  // today (Central) so today's full lineup is always retained regardless of
  // run time, through end-of-day on the last day. The plugin filters display
  // by date (not time), so including earlier-today shows is exactly what it
  // expects, and past days are still trimmed from the payload.
  const rangeStart = `${centralDay(now)}T00:00:00`;
  const rangeEnd = `${centralDay(endDate)}T23:59:59`;

  // Per-organizer collapse guard: the whole-source guard in main() only
  // trips when Eventbrite returns 0 events TOTAL. If 4 of 6 organizers fail
  // (WAF block, auth change) but two still respond, a gutted feed would
  // publish silently. Any organizer failing after fetchJSON's retries fails
  // the run instead — last good events.json stays live and the failure
  // email fires.
  const failedOrgs = [];

  for (const org of EB_ORGANIZERS) {
    try {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({
          status: "live",
          order_by: "start_asc",
          "expand": "venue,ticket_availability",
          "start_date.range_start": rangeStart,
          "start_date.range_end": rangeEnd,
          page: String(page),
        });
        const url = `${EB_BASE}/organizers/${org.id}/events/?${params}`;
        const data = await fetchJSON(url, headers);

        if (data.events && data.events.length > 0) {
          for (const ev of data.events) {
            events.push(normalizeEB(ev, org.name, org.forceVenue));
          }
        }

        hasMore = data.pagination
          ? data.pagination.has_more_items
          : false;
        page++;

        // Safety limit
        if (page > 10) break;
      }
      console.log(
        `[Eventbrite] Fetched events from ${org.name} (${org.id}).`
      );
    } catch (err) {
      console.error(
        `[Eventbrite] Failed for ${org.name}: ${err.message}`
      );
      failedOrgs.push(org.name);
    }
  }

  if (failedOrgs.length > 0) {
    throw new Error(
      `[Eventbrite] ${failedOrgs.length}/${EB_ORGANIZERS.length} organizer ` +
        `fetch(es) failed after retries: ${failedOrgs.join(", ")}. ` +
        `Refusing to publish a partial Eventbrite feed — keeping last good data.`
    );
  }

  console.log(`[Eventbrite] Total: ${events.length} events.`);
  return events;
}

function normalizeEB(ev, orgFallbackName, forceVenue) {
  // A location-specific organizer can pin its events to one canonical venue
  // (forceVenue) so an inconsistent per-event venue string can't split it off
  // into an unmatched venue. Otherwise fall back to the event's own venue name.
  const venueName = forceVenue
    ? forceVenue
    : normalizeVenueName(
        ev.venue && ev.venue.name ? ev.venue.name : orgFallbackName
      );

  const startLocal = ev.start ? ev.start.local : null; // "2026-02-15T19:30:00"
  const dateStr = startLocal ? startLocal.slice(0, 10) : null;
  const timeRaw = startLocal ? startLocal.slice(11, 16) : null;

  let priceMin = null;
  let priceMax = null;
  let currency = "USD";

  if (ev.ticket_availability && ev.ticket_availability.minimum_ticket_price) {
    priceMin = parseFloat(ev.ticket_availability.minimum_ticket_price.major_value);
    if (Number.isNaN(priceMin)) priceMin = null;
    currency = ev.ticket_availability.minimum_ticket_price.currency || "USD";
  }
  if (ev.ticket_availability && ev.ticket_availability.maximum_ticket_price) {
    priceMax = parseFloat(ev.ticket_availability.maximum_ticket_price.major_value);
    if (Number.isNaN(priceMax)) priceMax = null;
  }

  const image = ev.logo ? ev.logo.original ? ev.logo.original.url : ev.logo.url : null;

  return {
    id: makeId(ev.name ? ev.name.text : "Untitled", dateStr, venueName),
    name: ev.name ? ev.name.text : "Untitled Event",
    venue: venueName,
    date: dateStr,
    time: formatTime(timeRaw),
    day_of_week: dateStr ? getDayOfWeek(dateStr) : null,
    price_min: priceMin,
    price_max: priceMax,
    currency,
    price_source: priceMin !== null ? "api" : null,
    ticket_url: ev.url || null,
    image_url: image,
    source: "eventbrite",
    age_restriction: ev.is_free ? null : null,
    status: ev.status === "live" ? "on_sale" : ev.status || "unknown",
    description: ev.summary || (ev.description ? ev.description.text : null),
    last_updated: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Calendar day ("YYYY-MM-DD") of a Date in America/Chicago. */
function centralDay(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * The UTC instant of midnight (start of day) in America/Chicago for the
 * Central calendar day containing `d`. Central is UTC-5 (CDT) or UTC-6
 * (CST); try both candidate instants and keep the one that is actually
 * 00:00 in Chicago — DST transitions happen at 2am, so Central midnight
 * always exists and exactly one candidate matches.
 */
function centralStartOfDayUTC(d) {
  const day = centralDay(d);
  for (const offset of ["-05:00", "-06:00"]) {
    const candidate = new Date(`${day}T00:00:00${offset}`);
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(candidate);
    if (centralDay(candidate) === day && hour === "00") return candidate;
  }
  // Unreachable, but never let a TZ-library surprise kill the fetch.
  return new Date(`${day}T00:00:00-06:00`);
}

// The same physical venue arrives under different names per source —
// Ticketmaster says "Houston Improv" while the club's ticketweb/Eventbrite
// listings say "Improv Comedy Club- Houston". The venue is part of the
// dedupe hash (makeId), so without normalization the same show appears
// twice on the site and the venue filter splits into two entries.
// Keys are lowercased with whitespace collapsed.
const VENUE_ALIASES = {
  "improv comedy club- houston": "Houston Improv",
  "improv comedy club - houston": "Houston Improv",
  "improv comedy club-houston": "Houston Improv",
  "improv comedy club houston": "Houston Improv",
  "houston improv comedy club": "Houston Improv",
  "the houston improv": "Houston Improv",
  // The Riot's Eventbrite listings carry the old "Upstairs at Rudyards"
  // location string; both point at 2010 Waugh Dr. Without this alias the
  // venue filter splits into two entries and dedupe misses collisions.
  // NOTE: "Stages" is a genuinely different venue The Riot produces shows
  // at — do NOT alias it here.
  "the riot comedy club upstairs at rudyards": "The Riot Comedy Club",
  "the riot comedy club upstairs at rudyard's": "The Riot Comedy Club",
};

// Merge venue aliases from config/venues.json — the single source of truth
// for venue data (also consumed by the WP plugin and the page-sync script).
// Non-fatal on failure; the hardcoded aliases above still apply.
try {
  const venuesConfig = JSON.parse(
    fs.readFileSync(path.join(OUTPUT_DIR, "config", "venues.json"), "utf8")
  );
  for (const v of venuesConfig.venues || []) {
    if (!v || !v.name) continue;
    for (const alias of v.aliases || []) {
      VENUE_ALIASES[String(alias).toLowerCase().replace(/\s+/g, " ").trim()] = v.name;
    }
  }
} catch (err) {
  console.warn(`Could not merge venue aliases from config/venues.json: ${err.message}`);
}

function normalizeVenueName(name) {
  if (!name) return name;
  // Collapse whitespace and trim the returned name too — Ticketmaster has
  // shipped venues like "White Oak Music Hall - Upstairs " (trailing space),
  // which otherwise survives into events.json and splits the venue filter.
  const cleaned = String(name).replace(/\s+/g, " ").trim();
  return VENUE_ALIASES[cleaned.toLowerCase()] || cleaned;
}

function makeId(name, date, venue) {
  // Strip punctuation/whitespace from the name before hashing so the same show
  // from two sources doesn't survive as two events. Ticketmaster and Eventbrite
  // spell headliners differently ("DL Hughley" vs "D. L. Hughley"), and without
  // this the dedupe hash differs and the same show is listed twice — on the
  // site and in the weekly hero. This mirrors what VENUE_ALIASES already does
  // for the venue half of the key. Only collapses punctuation/spacing/case;
  // genuinely different names still differ in letters, so distinct shows at the
  // same venue+date are never merged.
  const nameKey = (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const raw = `${nameKey}|${date || ""}|${(venue || "").toLowerCase().trim()}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function getDayOfWeek(dateStr) {
  const days = [
    "Sunday", "Monday", "Tuesday", "Wednesday",
    "Thursday", "Friday", "Saturday",
  ];
  const d = new Date(dateStr + "T12:00:00");
  return days[d.getDay()];
}

function formatTime(timeStr) {
  if (!timeStr) return null;
  // timeStr may be "HH:MM:SS" or "HH:MM"
  const parts = timeStr.split(":");
  let h = parseInt(parts[0], 10);
  const m = parts[1] || "00";
  const ampm = h >= 12 ? "PM" : "AM";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${m} ${ampm}`;
}

/** "8:00 PM" → minutes since midnight. String compares put "10:00 PM"
 * before "8:00 PM"; missing/unparseable times sort last. */
function timeToMinutes(t) {
  if (!t) return 24 * 60 + 1;
  const m = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return 24 * 60 + 1;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
}

function deduplicateEvents(events) {
  const seen = new Map();
  for (const ev of events) {
    if (!seen.has(ev.id)) {
      seen.set(ev.id, ev);
    } else {
      // Keep the record with more/better data as the winner, then backfill
      // any fields it's missing from the loser (same as the fuzzy pass) —
      // previously the loser's fields were simply discarded, so a TM listing
      // with a price could lose it to an EB duplicate with a better image.
      const existing = seen.get(ev.id);
      const winner = mergePreferenceScore(ev) > mergePreferenceScore(existing) ? ev : existing;
      const loser = winner === ev ? existing : ev;
      backfillEvent(winner, loser);
      seen.set(ev.id, winner);
    }
  }
  return Array.from(seen.values());
}

function scoreCompleteness(ev) {
  let s = 0;
  if (ev.image_url) s++;
  if (ev.price_min !== null) s++;
  if (ev.description) s++;
  if (ev.ticket_url) s++;
  if (ev.time) s++;
  return s;
}

// ---------------------------------------------------------------------------
// Fuzzy deduplication (second pass)
//
// The exact-hash dedup above only merges events whose normalized
// name|date|venue match exactly. The same show frequently arrives with
// VARIANT TITLES — e.g. Ticketmaster's geo search returns "Alfred Robles"
// (ticketmaster.com listing) while the Houston Improv venue query returns
// "Alfred Robles: Vatos with Gatos Tour" (ticketweb.com listing), same
// venue, same date, same start time. This pass buckets events by normalized
// venue + date + start time and merges pairs whose titles are similar
// (token-Jaccard ≥ 0.8) or where one title's tokens are a subset of the
// other's (the tour-subtitle case above).
// ---------------------------------------------------------------------------

function titleTokens(name) {
  return new Set(
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  );
}

const TITLE_SIMILARITY_THRESHOLD = 0.8;

function titlesLookLikeSameShow(nameA, nameB) {
  const a = titleTokens(nameA);
  const b = titleTokens(nameB);
  if (a.size === 0 || b.size === 0) return false;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  const jaccard = inter / union;
  if (jaccard >= TITLE_SIMILARITY_THRESHOLD) return true;
  // Containment: "alfred robles" ⊂ "alfred robles vatos with gatos tour".
  // Require the contained title to have ≥2 tokens so a single generic word
  // ("comedy") can't swallow an unrelated show in the same room.
  const smaller = a.size <= b.size ? a : b;
  if (smaller.size >= 2 && inter === smaller.size) return true;
  return false;
}

// Vendors we can append affiliate params to (see the WP plugin) — a listing
// on one of these hosts beats the same show's ticketweb/universe mirror.
const PREFERRED_TICKET_HOSTS = /(^|\.)(ticketmaster\.com|eventbrite\.com|livenation\.com)$/i;

function ticketHost(url) {
  const m = String(url || "").match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function mergePreferenceScore(ev) {
  let s = scoreCompleteness(ev);
  // Real price data trumps "Price TBA" — weight it above everything else.
  if (ev.price_min !== null && ev.price_min !== undefined) s += 10;
  if (PREFERRED_TICKET_HOSTS.test(ticketHost(ev.ticket_url))) s += 5;
  return s;
}

/** Copy any fields the winner is missing from the record being dropped. */
function backfillEvent(winner, loser) {
  if (winner.price_min === null || winner.price_min === undefined) {
    winner.price_min = loser.price_min;
    winner.price_max = loser.price_max;
    winner.currency = loser.currency || winner.currency;
    if (loser.price_min !== null && loser.price_min !== undefined) {
      winner.price_source = loser.price_source || "api";
    }
  }
  if (!winner.image_url) winner.image_url = loser.image_url;
  if (!winner.description) winner.description = loser.description;
  if (!winner.ticket_url) winner.ticket_url = loser.ticket_url;
  if (!winner.time) winner.time = loser.time;
  if (!winner.age_restriction) winner.age_restriction = loser.age_restriction;
  if (!winner.genre) winner.genre = loser.genre;
  // Keep the TM id so the price-detail pass can still try the winner.
  if (!winner._tmId && loser._tmId) winner._tmId = loser._tmId;
}

// Two listings of the same show can disagree on start time — TM lists the
// showtime ("7:30 PM") while EB lists doors ("7:00 PM"). Treat times within
// this window as the same slot; a typical early/late double-header is 2h+
// apart so 60 minutes can't bridge two genuinely different shows.
const FUZZY_TIME_WINDOW_MIN = 60;

/** Times-of-day mentioned in a title (e.g. "5PM Show"), as minutes. */
function titleTimeTokens(name) {
  const tokens = new Set();
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/gi;
  let m;
  while ((m = re.exec(String(name || ""))) !== null) {
    let h = parseInt(m[1], 10) % 12;
    if (/^p/i.test(m[3])) h += 12;
    tokens.add(h * 60 + (m[2] ? parseInt(m[2], 10) : 0));
  }
  return tokens;
}

/** True when both titles name times and they differ — "5PM Show" vs
 * "7PM Show" is two separate shows even if the titles otherwise match. */
function conflictingTitleTimes(nameA, nameB) {
  const a = titleTimeTokens(nameA);
  const b = titleTimeTokens(nameB);
  if (a.size === 0 || b.size === 0) return false;
  if (a.size !== b.size) return true;
  for (const t of a) if (!b.has(t)) return true;
  return false;
}

function fuzzyDeduplicateEvents(events) {
  // Bucket by venue + date only. Bucketing on the exact time string meant a
  // TM "7:30 PM" and EB "7:00 PM" (doors) listing of the same show were
  // never even compared; the ±FUZZY_TIME_WINDOW_MIN check below replaces
  // the exact-time equality.
  const buckets = new Map();
  for (const ev of events) {
    const venueKey = String(ev.venue || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    const key = `${venueKey}|${ev.date || ""}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(ev);
  }

  const MISSING_TIME = 24 * 60 + 1; // timeToMinutes() sentinel
  const dropped = new Set();
  for (const group of buckets.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      if (dropped.has(group[i].id)) continue;
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (dropped.has(b.id)) continue;
        // Same slot? Merge when both start times are known and within the
        // window, or both are unknown. One-known/one-unknown stays split:
        // on a two-show night we can't tell which show the timeless
        // listing belongs to.
        const ta = timeToMinutes(a.time);
        const tb = timeToMinutes(b.time);
        const bothKnown = ta !== MISSING_TIME && tb !== MISSING_TIME;
        const bothUnknown = ta === MISSING_TIME && tb === MISSING_TIME;
        if (!(bothUnknown || (bothKnown && Math.abs(ta - tb) <= FUZZY_TIME_WINDOW_MIN))) {
          continue;
        }
        // "5PM Show" vs "7PM Show": explicit conflicting times in the
        // titles mean two different shows in the same room.
        if (conflictingTitleTimes(a.name, b.name)) continue;
        if (!titlesLookLikeSameShow(a.name, b.name)) continue;
        const winner = mergePreferenceScore(b) > mergePreferenceScore(a) ? b : a;
        const loser = winner === a ? b : a;
        backfillEvent(winner, loser);
        dropped.add(loser.id);
        console.log(
          `  [fuzzy-dedupe] "${loser.name}" (${loser.source}) merged into ` +
            `"${winner.name}" (${winner.source}) @ ${winner.venue} ${winner.date} ${winner.time || ""}`
        );
        // If the loser was slot i, the winner (slot j) keeps comparing.
        if (loser === a) break;
      }
    }
  }

  if (dropped.size > 0) {
    console.log(`Fuzzy dedup merged ${dropped.size} variant-title listing(s).`);
  }
  return events.filter((e) => !dropped.has(e.id));
}

// ---------------------------------------------------------------------------
// Relevance filtering (config/filters.json)
//
// The site should list ONLY comedy events in the Houston metro. The
// Ticketmaster comedy search reaches 100 miles (Beaumont) and the Eventbrite
// organizer feeds include everything a venue publishes (karaoke, dance
// parties, music tours). Rules live in config/filters.json so they're easy
// to edit without touching code; every excluded event is logged to
// excluded-events.json for false-positive auditing.
// ---------------------------------------------------------------------------

function loadRelevanceFilters() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILTERS_JSON_PATH, "utf8"));
    const lc = (arr) => (Array.isArray(arr) ? arr.map((s) => String(s).toLowerCase().trim()).filter(Boolean) : []);
    return {
      venueBlocklist: lc(raw.venue_blocklist),
      cityBlocklist: lc(raw.city_blocklist),
      titleBlocklist: lc(raw.title_blocklist),
      artistBlocklist: lc(raw.artist_blocklist),
      genreBlocklist: lc(raw.genre_blocklist),
      titleAllowlist: lc(raw.title_allowlist),
    };
  } catch (err) {
    console.warn(`Could not load ${FILTERS_JSON_PATH}: ${err.message} — relevance filtering skipped.`);
    return null;
  }
}

/**
 * Returns a human-readable exclusion reason, or null if the event should be
 * kept. The title allowlist protects against title/genre blocks only —
 * venue, city, and music-artist blocks always win.
 */
function classifyExclusion(ev, filters) {
  if (!filters) return null;
  const name = String(ev.name || "").toLowerCase();
  const venue = String(ev.venue || "").toLowerCase().trim();
  const city = String(ev.venue_city || "").toLowerCase().trim();
  const genre = String(ev.genre || "").toLowerCase().trim();

  if (venue && filters.venueBlocklist.includes(venue)) {
    return `venue blocklisted: ${ev.venue}`;
  }
  if (city && filters.cityBlocklist.includes(city)) {
    return `city blocklisted: ${ev.venue_city}`;
  }
  for (const artist of filters.artistBlocklist) {
    if (name.includes(artist)) {
      return `music artist blocklisted: "${artist}"`;
    }
  }

  const allowlisted = filters.titleAllowlist.some((kw) => name.includes(kw));
  if (!allowlisted) {
    for (const kw of filters.titleBlocklist) {
      if (name.includes(kw)) {
        return `title keyword blocklisted: "${kw}"`;
      }
    }
    if (genre && filters.genreBlocklist.includes(genre)) {
      return `genre blocklisted: ${ev.genre}`;
    }
  }
  return null;
}

function applyRelevanceFilters(events, filters) {
  const kept = [];
  const excluded = [];
  for (const ev of events) {
    const reason = classifyExclusion(ev, filters);
    if (reason) {
      excluded.push({
        name: ev.name,
        venue: ev.venue,
        venue_city: ev.venue_city || null,
        date: ev.date,
        time: ev.time,
        source: ev.source,
        genre: ev.genre || null,
        ticket_url: ev.ticket_url,
        reason,
      });
    } else {
      kept.push(ev);
    }
  }
  return { kept, excluded };
}

function writeExcludedLog(excluded, updatedAt) {
  const sorted = excluded
    .slice()
    .sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.name || "").localeCompare(b.name || ""));
  const payload = {
    _readme:
      "Events removed by config/filters.json at the last fetch. Review for false positives; edit the config to adjust.",
    last_updated: updatedAt,
    total_excluded: sorted.length,
    events: sorted,
  };
  fs.writeFileSync(EXCLUDED_JSON_PATH, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${EXCLUDED_JSON_PATH} (${sorted.length} excluded)`);
}

// ---------------------------------------------------------------------------
// HTML Generation
// ---------------------------------------------------------------------------

function generateHTML(events, updatedAt) {
  // Escape "<" so organizer-supplied text containing "</script>" can't break
  // out of the inline <script> block ("<" is a valid JS string escape).
  const eventsJSON = JSON.stringify(events, null, 2).replace(/</g, "\\u003c");
  return buildFullHTML(eventsJSON, updatedAt);
}

function buildFullHTML(eventsJSON, updatedAt) {
  // Read the template HTML
  let html = fs.readFileSync(TEMPLATE_PATH, "utf8");

  // Replace the event data (handles both the empty placeholder and previously-
  // embedded data). The pretty-printed JSON's only column-0 "]" is the final
  // top-level close, so anchoring on "\n];" can't stop early at a "];" inside
  // an event's text (JSON strings can't contain raw newlines). Replacer
  // functions, not replacement strings: event text containing "$&"/"$'"
  // would otherwise be expanded as replacement patterns.
  html = html.replace(
    /const EVENTS_DATA = (?:\[\]|\[[\s\S]*?\n\]);/,
    () => `const EVENTS_DATA = ${eventsJSON};`
  );

  // Replace the updated timestamp (handles both empty and previously-set values)
  html = html.replace(
    /const LAST_UPDATED = ".*?";/,
    () => `const LAST_UPDATED = "${updatedAt}";`
  );

  return html;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Comedy Houston — Event Fetcher ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log("");

  const [tmEvents, ebEvents] = await Promise.all([
    fetchTicketmaster(),
    fetchEventbrite(),
  ]);

  console.log("");
  console.log(`Ticketmaster: ${tmEvents.length} events`);
  console.log(`Eventbrite:   ${ebEvents.length} events`);

  // Source-collapse guard. On 2026-06-11 Eventbrite's WAF started 403-ing
  // every API call; the fetcher logged the errors, got 0 events, and
  // silently published a Ticketmaster-only file — the site lost half its
  // listings (The Riot, Secret Group, Den, …) with no alert. If a source
  // that contributed events to the last good events.json suddenly returns
  // zero, fail the run instead: the commit step never runs, the last good
  // data stays live (stale > gutted), and the notify-on-failure email fires.
  if (fs.existsSync(EVENTS_JSON_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(EVENTS_JSON_PATH, "utf8"));
      const prevEvents = prev.events || [];
      const checks = [
        ["eventbrite", ebEvents.length],
        ["ticketmaster", tmEvents.length],
      ];
      for (const [source, count] of checks) {
        const prevCount = prevEvents.filter((e) => e.source === source).length;
        if (prevCount > 0 && count === 0) {
          throw new Error(
            `${source} returned 0 events but the previous events.json had ${prevCount}. ` +
              `Refusing to publish a gutted file — keeping last good data. ` +
              `Check the fetch errors above (API outage, WAF block, expired token?).`
          );
        }
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.warn("Could not parse previous events.json — skipping source-collapse guard.");
      } else {
        throw err;
      }
    }
  }

  // Relevance filtering (comedy-only, Houston-metro-only) — see
  // config/filters.json. Runs before dedup so junk can't win a merge.
  const filters = loadRelevanceFilters();
  const { kept: relevantEvents, excluded } = applyRelevanceFilters(
    [...tmEvents, ...ebEvents],
    filters
  );
  if (excluded.length > 0) {
    console.log(`Relevance filter excluded ${excluded.length} events:`);
    for (const ex of excluded.slice(0, 30)) {
      console.log(`  [excluded] ${ex.date} | ${ex.venue} | ${ex.name} — ${ex.reason}`);
    }
    if (excluded.length > 30) console.log(`  ... and ${excluded.length - 30} more (see excluded-events.json)`);
  }
  writeExcludedLog(excluded, new Date().toISOString());

  const allEvents = relevantEvents;
  const deduped = fuzzyDeduplicateEvents(deduplicateEvents(allEvents));

  // Price backfill: cache → TM detail API → ticket-page JSON-LD. Runs after
  // filtering + dedup so requests are only spent on events being published.
  await enrichPrices(deduped);
  // The raw Ticketmaster id was only needed for the detail-endpoint pass —
  // strip it so it never reaches events.json.
  for (const e of deduped) delete e._tmId;

  // Sort by date, then time. Times are 12-hour strings ("8:00 PM"), so a
  // string compare puts "10:00 PM" before "8:00 PM" — compare minutes instead.
  deduped.sort((a, b) => {
    if (a.date !== b.date) return (a.date || "").localeCompare(b.date || "");
    return timeToMinutes(a.time) - timeToMinutes(b.time);
  });

  console.log(`After dedup:  ${deduped.length} events`);
  console.log("");

  // Preserve each event's last_updated stamp from the previous run when its
  // content is otherwise identical. Re-stamping all ~280 events every run
  // made every twice-daily commit a ~570 KB diff even when nothing changed —
  // and made the field meaningless (it's meant to say when THIS event's data
  // last changed; the WP plugin uses it for JSON-LD validFrom).
  try {
    if (fs.existsSync(EVENTS_JSON_PATH)) {
      const prev = JSON.parse(fs.readFileSync(EVENTS_JSON_PATH, "utf8"));
      const prevById = new Map((prev.events || []).map((e) => [e.id, e]));
      const contentKey = ({ last_updated, ...rest }) => JSON.stringify(rest);
      let preserved = 0;
      for (const ev of deduped) {
        const old = prevById.get(ev.id);
        if (old && old.last_updated && contentKey(old) === contentKey(ev)) {
          ev.last_updated = old.last_updated;
          preserved++;
        }
      }
      console.log(`Preserved last_updated on ${preserved}/${deduped.length} unchanged events`);
    }
  } catch (e) {
    console.warn(`Could not diff against previous events.json: ${e.message}`);
  }

  const updatedAt = new Date().toISOString();

  // Write events.json
  const output = {
    last_updated: updatedAt,
    total_events: deduped.length,
    events: deduped,
  };
  fs.writeFileSync(EVENTS_JSON_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${EVENTS_JSON_PATH}`);

  // Generate HTML with embedded data
  try {
    const html = generateHTML(deduped, updatedAt);
    fs.writeFileSync(INDEX_HTML_PATH, html);
    console.log(`Wrote ${INDEX_HTML_PATH}`);
  } catch (err) {
    console.error(`HTML generation failed: ${err.message}`);
    console.log("index.html will use events.json at runtime via fetch().");
  }

  console.log("");
  console.log("Done!");
}

/**
 * `--prices-only`: refresh prices on the ALREADY-PUBLISHED events.json without
 * touching the event list itself. No API keys needed — the TM detail pass is
 * skipped automatically (events.json carries no _tmId), so this is purely
 * cache + ticket-page scraping.
 *
 * This mode exists because Ticketmaster/TicketWeb block page fetches from
 * GitHub Actions' datacenter IPs (HTTP 403/530) but serve them fine to
 * residential IPs. Run it from a home machine (see update-prices.sh) and the
 * recovered prices land in config/price-cache.json, which the scheduled
 * Action then reuses on every run — including as a stale fallback after the
 * TTL, so prices survive until the event leaves the feed.
 */
async function pricesOnlyMain() {
  console.log("=== Comedy Houston — Price Refresh (prices-only mode) ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log("");

  if (!fs.existsSync(EVENTS_JSON_PATH)) {
    throw new Error(
      `${EVENTS_JSON_PATH} not found — run a full fetch first (npm run fetch).`
    );
  }
  const prev = JSON.parse(fs.readFileSync(EVENTS_JSON_PATH, "utf8"));
  const events = prev.events || [];
  if (events.length === 0) {
    throw new Error("events.json has no events — refusing to run prices-only.");
  }

  const priceKey = (e) =>
    JSON.stringify([e.price_min, e.price_max, e.currency, e.price_source]);
  const before = new Map(events.map((e) => [e.id, priceKey(e)]));

  await enrichPrices(events);

  const changed = events.filter((e) => before.get(e.id) !== priceKey(e));
  if (changed.length === 0) {
    console.log("No price changes — events.json and index.html left untouched.");
    return;
  }

  // Only re-stamp events whose price actually changed, mirroring the full
  // run's diff-aware last_updated handling (the WP plugin reads this field).
  const updatedAt = new Date().toISOString();
  for (const e of changed) e.last_updated = updatedAt;

  const output = {
    last_updated: updatedAt,
    total_events: events.length,
    events,
  };
  fs.writeFileSync(EVENTS_JSON_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${EVENTS_JSON_PATH} (${changed.length} event(s) re-priced)`);

  try {
    const html = generateHTML(events, updatedAt);
    fs.writeFileSync(INDEX_HTML_PATH, html);
    console.log(`Wrote ${INDEX_HTML_PATH}`);
  } catch (err) {
    console.error(`HTML generation failed: ${err.message}`);
    console.log("index.html will use events.json at runtime via fetch().");
  }

  console.log("");
  console.log("Done!");
}

if (require.main === module) {
  const entry = process.argv.includes("--prices-only") ? pricesOnlyMain : main;
  entry().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

// Exported for tests — running `node scripts/fetch-events.js` still executes
// main() as before; require()-ing the module does not.
module.exports = {
  normalizeVenueName,
  makeId,
  deduplicateEvents,
  fuzzyDeduplicateEvents,
  titlesLookLikeSameShow,
  conflictingTitleTimes,
  loadRelevanceFilters,
  classifyExclusion,
  applyRelevanceFilters,
  parseJsonLdPrices,
  extractJsonLdBlocks,
  enrichPrices,
  pricesOnlyMain,
  fetchPage,
  centralStartOfDayUTC,
  timeToMinutes,
};
