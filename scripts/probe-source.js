#!/usr/bin/env node
// TEMPORARY probe, pass 5 — run the real fetchDontTell() adapter against the
// live site and print the normalized events for pre-merge verification.
process.env.DONTTELL_PAGE_DELAY_MS = "1000";

const { fetchDontTell } = require("./fetch-events.js");

fetchDontTell()
  .then((events) => {
    console.log(`\n=== ${events.length} normalized events ===`);
    for (const e of events) console.log(JSON.stringify(e));
    const missingPrice = events.filter((e) => e.price_min === null).length;
    console.log(`\nprices: ${events.length - missingPrice}/${events.length} resolved`);
  })
  .catch((err) => {
    console.error("ADAPTER FAILED:", err);
    process.exit(1);
  });
