#!/usr/bin/env node
// TEMPORARY probe, pass 4 — inspect a Don't Tell Comedy individual show page
// for price and any structured data, to spec the adapter's price extraction.

const { fetchPage, extractJsonLdBlocks } = require("./fetch-events.js");

(async () => {
  for (const url of [
    "https://www.donttellcomedy.com/shows/houston-20217/",
    "https://www.donttellcomedy.com/shows/houston-20904/",
  ]) {
    console.log(`\n\n===== ${url} =====`);
    let html;
    try {
      html = await fetchPage(url);
    } catch (e) {
      console.log(`FETCH FAILED: ${e.message}`);
      continue;
    }
    console.log(`bytes: ${html.length}, json-ld blocks: ${extractJsonLdBlocks(html).length}`);

    // Dollar amounts with context
    const prices = [...html.matchAll(/\$\s?\d{1,3}(?:\.\d{2})?/g)];
    console.log(`dollar amounts: ${prices.length}`);
    for (const m of prices.slice(0, 8)) {
      console.log(`  ${m[0]} ctx: ${html.slice(Math.max(0, m.index - 250), m.index + 250).replace(/\s+/g, " ")}`);
    }

    // Date/time confirmation on the page
    const dt = html.match(/data-show-date="[^"]+"|(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),\s+\w+\s+\d{1,2}/g);
    console.log(`date markers: ${JSON.stringify((dt || []).slice(0, 5))}`);
    const times = [...new Set((html.match(/\d{1,2}:\d{2}\s*[AP]M/gi) || []))].slice(0, 8);
    console.log(`times: ${JSON.stringify(times)}`);

    // Checkout / ticket-tier markup
    for (const kw of ["ticket", "checkout", "General Admission", "sold out", "price"]) {
      const i = html.toLowerCase().indexOf(kw.toLowerCase());
      if (i !== -1) console.log(`kw "${kw}" ctx: ${html.slice(Math.max(0, i - 200), i + 400).replace(/\s+/g, " ")}`);
    }
  }
})();
