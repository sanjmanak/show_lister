# Roadmap

Open threads and planned work, so decisions made in passing don't get lost.
Items list their trigger where one exists. House style for anything
reader-facing: no em dashes.

## Triggered: make the repo private (trigger: ~100 organic visitors/day)

Decided Aug 2026. The repo is public today, which is fine while attention is
low, and public repos get unlimited free Actions minutes. Once organic search
traffic reaches roughly 100/day, the playbook (ARCHITECTURE.md, config,
workflow logs, which are publicly readable on public repos) is worth
protecting. Migration order matters because two production paths depend on
public URLs:

1. Create a small PUBLIC repo (e.g. `comedy-houston-data`) and add a sync step
   to the events/blog workflows that pushes `events.json` and the blog/creative
   images there.
2. Repoint the WP plugin (it already has `github_user` / `repo` settings) and
   the scripts' image base URLs at the public repo.
3. Verify one full daily cycle green (events refresh, Tonight post, IG fetch).
4. Flip the main repo private and upgrade GitHub to Pro (~$4/mo, 3,000 Actions
   min/month; our usage is roughly 1,200 to 2,400 min/month, so Free's 2,000
   would be dicey).

Interim zero-cost option if needed sooner: move ARCHITECTURE.md and strategy
docs to a private repo while code stays public.

## Near-term (days to weeks)

- **Meta pixel follow-through**: pixel 822551924791710 and domain verification
  are live sitewide (plugin v2.13.0, Aug 16 2026). Remaining: register
  `TicketClick` and `Lead` as custom conversions in Events Manager once events
  accumulate; build first URL-rule audiences (site visitors, /services/
  visitors, TicketClick firers) alongside Eventbrite purchasers.
- **Essay series is on rails through Sep 16**: WP publishes one essay each
  Wednesday 10am CT; the essay-promo workflow emails quote-card creative for
  approval at 11:30am CT the same day. Nothing to do except approve and post.

## After the essay launch run (post Sep 16, 2026)

- **Evergreen quote-card rotation**: 18 recyclable cards exist (3 pull quotes x
  6 essays, in `blog/essays/graphics/` and regenerable via
  `generate-essay-graphics.js --all`). Keep one recycled card going out every
  week or two by dispatching essay-promo with a slug. Candidate upgrade:
  automate the rotation on a cron.
- **Promo auto-post upgrade**: when email-for-approval feels routine, swap the
  email step for the existing Instagram posting path so essay creative posts
  itself like the weekly roundup does.

## Flywheel gaps (identified Aug 2026, no dates yet)

- **Owned audience**: make email capture an explicit goal on every loop. Fan
  newsletter growth, plus a separate comedian list.
- **Supply-side database**: performer-interest submissions currently live in
  the creative@ inbox. Pull them into a structured list (even a sheet) with
  handle, clip, set length, tags. This is the seed of the marketplace pitch:
  "vetted Houston comics who want spots."
- **Cross-link sanjaycomedy.com**: still zero links between the two sites
  (flagged in the July 2026 audit). Face behind the corporate funnel; essay
  content on both sides should feed each other.
- **"For comedians" block on the open-mic page**: highest-intent comedian
  traffic on the site currently has no route to the essays or the performer
  feature.
- **Data moat content**: recurring data-backed pieces only we can write (what
  sold in Houston, price trends). Candidate: annual "State of Houston Comedy"
  report as a press magnet.
- **City template**: nearly everything is config-driven (venues.json,
  landing-pages.json, sources). Whether or not we expand beyond Houston, keep
  city-specific things in config, not code, so the machine stays replicable.
