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
];

const OUTPUT_DIR = path.resolve(__dirname, "..");
const EVENTS_JSON_PATH = path.join(OUTPUT_DIR, "events.json");
const INDEX_HTML_PATH = path.join(OUTPUT_DIR, "index.html");
const TEMPLATE_PATH = path.join(OUTPUT_DIR, "index.html");

// ---------------------------------------------------------------------------
// HTTP helper with retries
// ---------------------------------------------------------------------------

function fetchJSON(url, headers = {}, retries = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode === 429 && retries > 0) {
          const wait = (4 - retries) * 2000;
          console.log(`  Rate limited. Retrying in ${wait / 1000}s...`);
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

  // Format as "yyyy-MM-ddTHH:mm:ssZ"
  const startDateTime = now.toISOString().replace(/\.\d{3}Z$/, "Z");
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

  return txEvents;
}

function normalizeTM(ev) {
  const venueObj =
    ev._embedded && ev._embedded.venues && ev._embedded.venues[0]
      ? ev._embedded.venues[0]
      : null;
  const venue = venueObj ? venueObj.name : "Unknown Venue";
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

  return {
    id: makeId(ev.name, dateStr, venue),
    name: ev.name || "Untitled Event",
    venue,
    venue_state: venueState,
    venue_city: venueCity,
    date: dateStr,
    time: formatTime(timeStr),
    day_of_week: dateStr ? getDayOfWeek(dateStr) : null,
    price_min: priceMin,
    price_max: priceMax,
    currency,
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

  // Eventbrite date format: "yyyy-MM-ddTHH:mm:ss"
  const rangeStart = now.toISOString().replace(/\.\d{3}Z$/, "");
  const rangeEnd = endDate.toISOString().replace(/\.\d{3}Z$/, "");

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
            events.push(normalizeEB(ev, org.name));
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
    }
  }

  console.log(`[Eventbrite] Total: ${events.length} events.`);
  return events;
}

function normalizeEB(ev, orgFallbackName) {
  const venueName =
    ev.venue && ev.venue.name ? ev.venue.name : orgFallbackName;

  const startLocal = ev.start ? ev.start.local : null; // "2026-02-15T19:30:00"
  const dateStr = startLocal ? startLocal.slice(0, 10) : null;
  const timeRaw = startLocal ? startLocal.slice(11, 16) : null;

  let priceMin = null;
  let priceMax = null;
  let currency = "USD";

  if (ev.ticket_availability && ev.ticket_availability.minimum_ticket_price) {
    priceMin = parseFloat(ev.ticket_availability.minimum_ticket_price.major_value);
    currency = ev.ticket_availability.minimum_ticket_price.currency || "USD";
  }
  if (ev.ticket_availability && ev.ticket_availability.maximum_ticket_price) {
    priceMax = parseFloat(ev.ticket_availability.maximum_ticket_price.major_value);
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

function makeId(name, date, venue) {
  const raw = `${(name || "").toLowerCase().trim()}|${date || ""}|${(venue || "").toLowerCase().trim()}`;
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

function deduplicateEvents(events) {
  const seen = new Map();
  for (const ev of events) {
    if (!seen.has(ev.id)) {
      seen.set(ev.id, ev);
    } else {
      // Prefer the one with more data (image, price, description)
      const existing = seen.get(ev.id);
      const scoreA = scoreCompleteness(existing);
      const scoreB = scoreCompleteness(ev);
      if (scoreB > scoreA) {
        seen.set(ev.id, ev);
      }
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
// HTML Generation
// ---------------------------------------------------------------------------

function generateHTML(events, updatedAt) {
  const eventsJSON = JSON.stringify(events, null, 2);
  return buildFullHTML(eventsJSON, updatedAt);
}

function buildFullHTML(eventsJSON, updatedAt) {
  // Read the template HTML
  let html = fs.readFileSync(TEMPLATE_PATH, "utf8");

  // Replace the event data (handles both empty placeholder and previously-embedded data)
  html = html.replace(
    /const EVENTS_DATA = \[.*?\];/s,
    `const EVENTS_DATA = ${eventsJSON};`
  );

  // Replace the updated timestamp (handles both empty and previously-set values)
  html = html.replace(
    /const LAST_UPDATED = ".*?";/,
    `const LAST_UPDATED = "${updatedAt}";`
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

  const allEvents = [...tmEvents, ...ebEvents];
  const deduped = deduplicateEvents(allEvents);

  // Sort by date, then time
  deduped.sort((a, b) => {
    if (a.date !== b.date) return (a.date || "").localeCompare(b.date || "");
    return (a.time || "").localeCompare(b.time || "");
  });

  console.log(`After dedup:  ${deduped.length} events`);
  console.log("");

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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
