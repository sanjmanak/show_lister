#!/usr/bin/env node
// TEMPORARY source-feasibility probe, pass 2 — deep dive on donttellcomedy.com
// (client-rendered; pass 1 found no JSON-LD / __NEXT_DATA__ / event URLs).
// Goal: find where the Houston city page gets its show data from.

const { fetchPage } = require("./fetch-events.js");

(async () => {
  const url = "https://www.donttellcomedy.com/cities/houston/";
  const html = await fetchPage(url);
  console.log(`bytes: ${html.length}`);

  // 1. All script tags (src or inline size)
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
  console.log(`\nscript tags: ${scripts.length}`);
  for (const [, attrs, body] of scripts) {
    const src = (attrs.match(/src\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (src) console.log(`  src: ${src}`);
    else console.log(`  inline (${body.length} chars): ${body.slice(0, 160).replace(/\s+/g, " ")}`);
  }

  // 2. Hostnames referenced anywhere (find the API/backend)
  const hosts = {};
  for (const m of html.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    hosts[m[1].toLowerCase()] = (hosts[m[1].toLowerCase()] || 0) + 1;
  }
  console.log(`\nhostnames referenced:`);
  for (const [h, n] of Object.entries(hosts).sort((a, b) => b[1] - a[1])) console.log(`  ${h}: ${n}`);

  // 3. Show-data shaped content in the HTML: dates, times, neighborhoods
  for (const pat of [
    /"(?:shows?|events?|showtimes?|dates?)"\s*:/gi,
    /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/g,
    /(?:Aug|Sep|Oct|Nov)[a-z]*\.?\s+\d{1,2}/g,
    /\d{1,2}:\d{2}\s*(?:PM|AM)/gi,
  ]) {
    const ms = [...html.matchAll(pat)];
    console.log(`\npattern ${pat} -> ${ms.length} matches`);
    for (const m of ms.slice(0, 5)) {
      console.log(`  ctx: ${html.slice(Math.max(0, m.index - 200), m.index + 200).replace(/\s+/g, " ")}`);
    }
  }

  // 4. Relative hrefs (event links pass 1 missed)
  const hrefs = [...new Set([...html.matchAll(/href\s*=\s*["'](\/[^"']{2,80})["']/gi)].map((m) => m[1]))];
  console.log(`\nrelative hrefs (${hrefs.length}):`);
  for (const h of hrefs.slice(0, 40)) console.log(`  ${h}`);

  // 5. Firebase / common backend fingerprints
  for (const kw of ["firebase", "firestore", "algolia", "contentful", "sanity", "supabase", "graphql", "wized", "webflow", "gatsby", "nuxt", "sveltekit", "remix", "astro"]) {
    const i = html.toLowerCase().indexOf(kw);
    if (i !== -1) console.log(`\nfingerprint "${kw}" at ${i}: ${html.slice(i - 100, i + 200).replace(/\s+/g, " ")}`);
  }

  // 6. Fetch the largest same-site JS bundle and grep it for endpoints
  const bundle = [...html.matchAll(/src\s*=\s*["']([^"']+\.js[^"']*)["']/gi)]
    .map((m) => m[1])
    .filter((s) => !/googletag|gtm|analytics|facebook|hotjar/i.test(s));
  if (bundle.length) {
    console.log(`\njs bundles found: ${JSON.stringify(bundle.slice(0, 10))}`);
    for (const b of bundle.slice(0, 4)) {
      try {
        const abs = new URL(b, url).toString();
        const js = await fetchPage(abs);
        const eps = [...new Set([...js.matchAll(/["'](https?:\/\/[^"']{8,120}|\/api\/[^"']{1,80})["']/g)].map((m) => m[1]))]
          .filter((e) => !/\.(png|jpg|svg|css|woff)/.test(e));
        console.log(`\n--- bundle ${abs} (${js.length} chars) endpoints:`);
        for (const e of eps.slice(0, 40)) console.log(`  ${e}`);
        for (const kw of ["shows", "events", "getShows", "city", "houston"]) {
          const m = js.match(new RegExp(`.{80}${kw}.{120}`, "i"));
          if (m) console.log(`  kw "${kw}": ${m[0].replace(/\s+/g, " ")}`);
        }
      } catch (e) {
        console.log(`  bundle fetch failed ${b}: ${e.message}`);
      }
    }
  }
})();
