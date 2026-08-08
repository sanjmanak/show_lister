# Performer-Booking MVP — "🎤 Interested in performing?"

> **Status:** Phase-one experiment | **Added:** August 2026 | Plugin v2.9.0

## The hypothesis

When comedians are browsing actual Houston comedy shows on ComedyHouston.com,
will they express interest in performing on a **specific** show?

That's the whole experiment. No accounts, no profiles, no matching, no
payments. Eligible event cards get a quiet secondary CTA; clicking it opens a
four-field form; submissions are emailed to the admin, who manually
concierges the first matches. Success = the first legitimate submissions tied
to real events.

## How it works (data flow)

```
config/performer-requests.json          (eligibility allowlist — YOU edit this)
        │
        ▼  scripts/fetch-events.js (twice-daily GitHub Action)
events.json                             (every event gets performer_requests: true|false)
        │
        ▼  WordPress plugin fetches events.json from GitHub raw
comedyhouston.com event cards           (CTA renders only when performer_requests === true;
        │                                both the SSR renderer in comedy-houston.php and
        ▼                                the client renderer in comedy-houston.js)
"🎤 Interested in performing?" → bottom sheet/modal (comedy-houston.js)
        │
        ▼  POST /wp-json/comedy-houston/v1/performer-interest
comedy-houston.php handler              (honeypot + timed token + per-IP rate limit)
        │
        ▼  wp_mail()
creative@comedyhouston.com              (one email per submission — this IS the database)
```

## 1. Where eligibility is controlled

**Single file: [`config/performer-requests.json`](config/performer-requests.json).**

- `enabled` — master kill switch for the whole experiment.
- `include_open_mics` — flags every event that already has `is_open_mic: true`
  (classification from `config/open-mics.json`).
- `series_allowlist` — one entry per recurring show/series:
  `title_match` (case-insensitive substring of the event title, hyphens
  normalized to spaces), optional `venue_match` (substring of the venue name),
  per-entry `enabled`, and a `note` explaining why it's in (or must stay out).

Changes take effect the next time `scripts/fetch-events.js` runs (~8 AM and
6 PM CT via GitHub Actions), because eligibility is stamped onto `events.json`
at ingest as an explicit `performer_requests` boolean — **default false** for
every event. The WordPress plugin never guesses; it renders the CTA only where
the JSON says so. To force an immediate update, trigger the "Update Events"
workflow manually in GitHub Actions, then hit the plugin's refresh endpoint
(or wait — the plugin's transient cache is short).

Events.json is regenerated twice daily, so **never** hand-edit
`performer_requests` in `events.json` — the next fetch overwrites it. Edit the
config file.

### The initial cohort (August 2026)

Local multi-comic lineups only (~83 of 256 events at launch):

| Series | Venue(s) | Why |
|---|---|---|
| All open mics (`is_open_mic`) | The Secret Group's 6 weekly mics | Comedians literally come to perform |
| Social Comedy Nite | Notsuoh, Social Beer Garden HTX, Big Ben Tavern | Free booked bar showcases (owner-confirmed booked, not mics) |
| East End Comedy Showcase | Wonky Power | Weekly independent showcase |
| The Best of the Secret Group (+ Rated R) | The Secret Group | "Best of Houston"-style multi-comic showcase |
| Monday Night Comedy! | The Secret Group | Weekly local showcase |
| $2 BILL Two Dollar Comedy Show | The Secret Group | Weekly local showcase |
| Comedy & Drinks in a Speakeasy | The Den Comedy Club | Rotating multi-comic club showcase |

Deliberately excluded: every nationally touring headliner (Houston Improv,
Punch Line, Riot Conroe touring acts), Kill Tony, podcast tapings, and "The
Best of TSG **Headliner** Series — {name}" (single named headliner; the
title_match is scoped so it doesn't catch these).

### Cohort expansion: venue-wide rules (2026-08-08)

Per-series entries couldn't keep up with The Secret Group's catalog — nearly
everything that venue runs is a local multi-comic production, and each new
series name (C U Next Tuesday, The Last Laugh, The Passing Lane, ...) needed
its own allowlist line. The config now also supports **`venue_rules`**:

- `venue_match` — substring of the venue name; the rule covers every show
  there.
- `title_include` (optional) — if present, the title must contain at least
  one of these keywords. Omit it to flag the venue wholesale.
- `title_exclude` — any of these keywords in the title vetoes the flag.

Two rules ship with the expansion:

| Rule | Effect |
|---|---|
| The Secret Group, exclude `headliner`/`headlines` | Every TSG show gets the CTA except headliner-branded ones ("Best of TSG Headliner Series — {name}", "Secret Headliner with ...") |
| Riot Comedy Club (both rooms), include `showcase` / `best of` / `late night` / `open mic` / `new faces`, exclude `headliner`/`headlines` | The Riot mostly books touring headliners, so only its obviously-local multi-comic formats qualify — fed by the new StandupTix harvest of theriothtx.com |

`series_allowlist` still works and still applies (the TSG series entries are
now redundant with the venue rule but kept as a fallback if the venue-wide
rule is ever rolled back).

### Why a boolean, not a status enum

`performer_requests: true|false` is enough for phase one — there is exactly
one behavior to toggle. The richer lifecycle (`disabled | testing |
producer_unverified | producer_verified | producer_accepting`) only earns its
complexity once producers are in the loop. If/when that happens, the single
stamping point in `fetch-events.js` (search `performer_requests`) and the two
render guards (PHP + JS) are the only places to change.

## 2. What data is stored for each submission, and where

**Storage = one email per submission** to the address returned by
`performer_email()` in `comedy-houston.php` — defaults to the existing inquiry
address `creative@comedyhouston.com`. Override without editing code:
`add_filter('comedy_houston_performer_email', fn() => 'you@example.com');`

Each email (subject: `Performer interest — {show} @ {venue}, {date}`) contains:

- **Performer fields (form):** Instagram handle (required, validated
  `[A-Za-z0-9._]{1,30}`), set length (5/10/15/20+ min), clip URL (optional),
  short note (optional, ≤2000 chars).
- **Event metadata (captured silently from the card's event object):** event
  ID (the 16-char dedupe hash from events.json), event title, venue, date,
  time, source (ticketmaster/eventbrite), open-mic flag.

Nothing is written to the WordPress database except the transient rate-limit
counters. No accounts, no PII beyond what the performer types. If an email
fails to send, the submitter sees an error and can retry — there is no silent
drop, but there is also no second copy: **the inbox is the system of record**,
so consider a Gmail label/filter for `Performer interest —`.

## 3. Anti-spam (same design as the corporate inquiry form)

1. **Timed HMAC token** — minted from `/wp-json/comedy-houston/v1/performer-token`
   as soon as eligible cards render (so the clock runs while browsing);
   submissions must arrive 8 s–6 h after minting. Context-separated from the
   corporate-inquiry token.
2. **Honeypot** — hidden `website` field; any value silently "succeeds".
3. **Rate limit** — 5 submissions per IP per hour (separate bucket from the
   inquiry form).

## 4. Analytics (GA4 via the existing Site Kit gtag, `event_category: performer_mvp`)

| Event | Fires when | Params |
|---|---|---|
| `eligible_show_viewed` | Once per page load, when ≥1 eligible card is rendered | `eligible_count`, `event_ids` (first 20) |
| `performer_interest_clicked` | CTA clicked, modal opened | `event_id`, `event_label` (title), `venue_name`, `event_date` |
| `performer_interest_submitted` | Submission accepted by the server | same |

Funnel = viewed → clicked → submitted. If gtag is absent the flow still works;
events are simply not recorded. (GA4 custom params need registration as custom
dimensions in the GA4 admin before they appear in standard reports; the event
counts themselves show up regardless.)

## 5. What to do manually after the first submissions arrive

1. **Vet** — open the Instagram handle and clip. Real local comic or spam?
2. **Reply to the comedian on Instagram** (you have no other contact channel —
   by design) so they know a human saw it.
3. **Concierge the match** — you know the show from the email metadata; DM or
   email the producer/host: "a local comic with a tight 10 asked to be on
   {show} on {date} — want the intro?"
4. **Log the outcome somewhere lightweight** (a spreadsheet is fine): show,
   comedian, producer response, booked or not. This is the learning the MVP
   exists to produce.
5. **Interview both sides after the first few matches** — what the producer
   wanted to know before saying yes (that's the future
   `producer_verified/accepting` feature list), and what the comedian expected
   next (that's the future performer-side product).
6. **Tune the cohort** — if a series produces junk submissions, disable its
   allowlist entry; if producers of non-cohort local shows ask in, add them.

## 6. Deployment notes

- The WordPress plugin files (`wordpress/comedy-houston.{php,js,css}`) must be
  re-uploaded to the WP install (or synced however you normally deploy the
  plugin) — version bumped to **2.9.0** so browser caches bust.
- `events.json` in this repo is already stamped, so the CTA goes live as soon
  as (a) this branch is merged to `main` (the plugin reads events.json from
  GitHub raw `main`) and (b) the plugin is updated on the WP site.
- The GitHub Pages `index.html` is a **noindexed mirror** of the real site and
  deliberately does not carry the experiment (it has no backend to receive
  submissions and no traffic worth instrumenting). If the mirror ever becomes
  a real surface, the CTA needs a cross-origin POST to the WP REST endpoint.
