#!/usr/bin/env node
// TEMPORARY source-feasibility probe — runs on the Actions runner (which has
// open network, unlike the authoring sandbox) and prints what structured data
// two candidate event sources expose. Not part of the crawler; delete after
// the probe run is read.

const { fetchPage, extractJsonLdBlocks } = require("./fetch-events.js");

const TARGETS = [
  "https://www.donttellcomedy.com/cities/houston/",
  "https://www.eventbrite.com/cc/live-at-the-barbershop-houston-4846358",
  // Sitemap guesses for donttellcomedy (harmless 404s if absent):
  "https://www.donttellcomedy.com/sitemap.xml",
  "https://www.donttellcomedy.com/robots.txt",
];

function summarize(url, html) {
  console.log(`\n\n===== ${url} =====`);
  console.log(`bytes: ${html.length}`);

  // JSON-LD blocks
  const blocks = extractJsonLdBlocks(html);
  console.log(`json-ld blocks: ${blocks.length}`);
  blocks.forEach((b, i) => {
    const types = JSON.stringify([].concat(b["@type"] || (b["@graph"] ? "@graph" : "?")));
    const s = JSON.stringify(b);
    console.log(`  [${i}] @type=${types} size=${s.length}`);
    console.log(`      sample: ${s.slice(0, 800)}`);
  });

  // Next.js / embedded state
  for (const marker of ["__NEXT_DATA__", "window.__SERVER_DATA__", "__NUXT__", "window.__data", "self.__next_f"]) {
    const idx = html.indexOf(marker);
    if (idx !== -1) {
      console.log(`marker ${marker}: FOUND at ${idx}`);
      console.log(`  context: ${html.slice(idx, idx + 600).replace(/\s+/g, " ")}`);
    }
  }

  // Eventbrite organizer links / ids
  const orgLinks = [...new Set((html.match(/eventbrite\.com\/o\/[a-z0-9-]+-\d+/gi) || []))];
  if (orgLinks.length) console.log(`organizer /o/ links: ${JSON.stringify(orgLinks)}`);
  const orgIds = [...new Set((html.match(/"organizer(?:_id)?"\s*:\s*"?(\d{6,})"?/gi) || []))];
  if (orgIds.length) console.log(`organizer id fields: ${JSON.stringify(orgIds.slice(0, 10))}`);

  // Event-detail URLs on the page
  const eventLinks = [
    ...new Set(
      (html.match(/https?:\/\/[^"'\s\\]+\/(?:e|events?|shows?)\/[^"'\s\\<>]{3,120}/gi) || []).slice(0, 25)
    ),
  ];
  if (eventLinks.length) {
    console.log(`event-ish links (${eventLinks.length} unique, first 25):`);
    for (const l of eventLinks) console.log(`  ${l}`);
  }

  // API endpoints referenced
  const apiRefs = [...new Set((html.match(/["'](https?:\/\/[^"']*api[^"']{0,80}|\/api\/[^"']{1,80})["']/gi) || []).slice(0, 15))];
  if (apiRefs.length) console.log(`api-ish refs: ${JSON.stringify(apiRefs)}`);

  if (/\.xml|robots/.test(url)) {
    console.log(`raw head:\n${html.slice(0, 1500)}`);
  }
}

(async () => {
  for (const url of TARGETS) {
    try {
      const html = await fetchPage(url);
      summarize(url, html);
    } catch (err) {
      console.log(`\n\n===== ${url} =====`);
      console.log(`FETCH FAILED: ${err.message}`);
    }
  }
})();
