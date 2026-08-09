#!/usr/bin/env node
// TEMPORARY probe, pass 3 — dump full Houston show cards from
// donttellcomedy.com (server-rendered HTML, no JSON anywhere) so we can spec
// a parser: date, time, neighborhood, price, ticket link shape.

const { fetchPage } = require("./fetch-events.js");

(async () => {
  const html = await fetchPage("https://www.donttellcomedy.com/cities/houston/");

  // Full context around each long-form date (the show cards)
  const re = /(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/g;
  let m, i = 0;
  while ((m = re.exec(html)) !== null && i < 8) {
    i++;
    console.log(`\n===== CARD ${i} (${m[0]}) =====`);
    console.log(html.slice(Math.max(0, m.index - 1500), m.index + 2500).replace(/\s+/g, " "));
  }

  // All hrefs containing show/checkout/ticket
  const hrefs = [...new Set([...html.matchAll(/href\s*=\s*["']([^"']*(?:show|checkout|ticket|event)[^"']*)["']/gi)].map((x) => x[1]))];
  console.log(`\n===== show/ticket hrefs (${hrefs.length}) =====`);
  for (const h of hrefs.slice(0, 30)) console.log(h);
})();
