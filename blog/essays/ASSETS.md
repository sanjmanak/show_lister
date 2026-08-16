# Comedian Essay Series: Asset Kit

**Source of truth for pull quotes, captions, and images is `config/essays.json`.**
This file documents the promo system and the designer-facing graphic concepts.

House style: no em dashes in any reader-facing copy. Both
`scripts/publish-essays.js` and `scripts/generate-essay-graphics.js` fail the
run if one appears.

## The promo system (email-for-approval)

- WordPress publishes one essay per week (Wednesdays 10am CT) through Sep 16, 2026.
- The `essay-promo` workflow runs Wednesdays 11:30am CT. It renders quote cards
  for the newest live essay (three 1080x1080 squares plus one 1080x1920 story),
  commits them to `blog/essays/graphics/`, and EMAILS them with the caption for
  approval. Nothing auto-posts.
- Manual run: Actions tab, "Essay Promo Creative", optionally passing a slug to
  regenerate a specific essay's cards.
- Local library refresh: `node scripts/generate-essay-graphics.js --all`
  renders every essay's cards (24 files) without touching promo state.

## The recycling library

3 pull quotes x 6 essays = 18 distinct quote cards, all evergreen. After the
six-week launch run, keep a rotation going (one recycled card every week or
two, cycling essays and quotes) by dispatching the workflow with a slug, or by
reposting from `blog/essays/graphics/` directly. Captions live in
`config/essays.json` under `ig_caption`.

## Graphic concepts (beyond the quote cards)

1. **Clips essay**: "Anatomy of a Clip That Travels" timeline. 0:00 open ONE
   BEAT before the laugh / 0:03 room breaks / 0:08 now the setup / caption =
   second joke. Second timeline with a red X: "how you filmed it" (setup for
   45 seconds, laugh at 0:46, nobody left).
2. **Crowd work essay**: four-stage funnel in the brand gradient: crowd work
   clip, follower, ticket, hears your WRITTEN act. Footer: "She discovered you
   improvising and paid to hear your writing."
3. **Credits essay**: data card, "Who filled Houston's biggest rooms this
   year": Toyota Center / NRG Arena / stadium livestream show, each tagged with
   how the draw was built (YouTube specials, YouTube in Hindi, livestream).
   Footer: "0 of them needed a festival laurel."
4. **Stage time essay**: stat card, giant numbers. "A perfect month of open
   mics: ~100 new listeners. One mediocre reel: more by lunch." Sub-line:
   "Keep the mics. Add the second job."
5. **Show promotion essay**: side-by-side. LEFT (red X): lineup-grid flyer,
   nine tiny faces, "STACKED LINEUP". RIGHT (green check): laughing crowd photo
   plus "Comedy in the back of a taqueria · BYOB · 8 to 9:30 · $10". Header:
   "One of these sells tickets."
6. **Followers essay**: two-column RENTED vs OWNED card. Rented: 8,000
   followers / algorithm picks who sees you / reach drops yearly. Owned: 50
   emails / 100% delivery / they already paid once. Companion: printable QR
   stool-sign template ("Want to know when I'm back?") offered as a free
   download; every comic who uses it spreads the article.

Brand: bg `#0a0a0f`, card `#1a1a26`, accent `#ff4d6a`, secondary `#7c5cff`, Inter.
