#!/usr/bin/env node

/**
 * Comedy Houston — Per-Comedian SEO Blog Post Generator (MVP)
 *
 * Reads events.json, identifies headliners, and generates individual
 * 600-word blog posts for each notable comedian. Outputs to blog/comedians/.
 *
 * Three-call pipeline per comedian:
 *   1. Deep research via OpenAI Responses API (web search)
 *   2. Write the blog post via OpenAI Chat
 *   3. Fact-check pass via OpenAI Chat (editor role)
 *
 * Zero npm dependencies — uses only built-in Node modules.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const http = require("http");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

// WordPress publishing config (optional — skipped if not set)
const WP_SITE_URL = process.env.WP_SITE_URL || "";          // e.g. https://www.comedyhouston.com
const WP_APP_USER = process.env.WP_APP_USER || "";           // e.g. Comedy Houston Field Team
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || "";   // Application Password from WP
const WP_ENABLED = !!(WP_SITE_URL && WP_APP_USER && WP_APP_PASSWORD);

const OUTPUT_DIR = path.resolve(__dirname, "..");
const EVENTS_JSON_PATH = path.join(OUTPUT_DIR, "events.json");
const COMEDIANS_DIR = path.join(OUTPUT_DIR, "blog", "comedians");

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function getCurrentWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { monday, sunday };
}

function formatDateForDisplay(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatWeekRange(monday, sunday) {
  const opts = { month: "long", day: "numeric" };
  const start = monday.toLocaleDateString("en-US", opts);
  const end = sunday.toLocaleDateString("en-US", { ...opts, year: "numeric" });
  return `${start} – ${end}`;
}

/** Turn "Ali Siddiq: The Domino Effect Tour" into "ali-siddiq-domino-effect-tour" */
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

// ---------------------------------------------------------------------------
// Load and filter events
// ---------------------------------------------------------------------------

function loadThisWeeksEvents() {
  if (!fs.existsSync(EVENTS_JSON_PATH)) {
    throw new Error(`events.json not found at ${EVENTS_JSON_PATH}`);
  }

  const raw = JSON.parse(fs.readFileSync(EVENTS_JSON_PATH, "utf8"));
  const events = raw.events || [];

  const { monday, sunday } = getCurrentWeekRange();
  const mondayStr = monday.toISOString().slice(0, 10);
  const sundayStr = sunday.toISOString().slice(0, 10);

  const filtered = events.filter((ev) => {
    if (!ev.date) return false;
    return ev.date >= mondayStr && ev.date <= sundayStr;
  });

  filtered.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (a.time || "").localeCompare(b.time || "");
  });

  console.log(
    `Found ${filtered.length} events for the week of ${mondayStr} to ${sundayStr}`
  );
  return { events: filtered, monday, sunday };
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions API
// ---------------------------------------------------------------------------

function callOpenAI(prompt, systemPrompt, temperature) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      temperature: temperature !== undefined ? temperature : 0.7,
      max_tokens: 8000,
    });

    const options = {
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          return reject(
            new Error(`OpenAI API error ${res.statusCode}: ${data.slice(0, 500)}`)
          );
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices[0].message.content;
          const usage = parsed.usage;
          console.log(
            `  OpenAI usage — prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens}, total: ${usage.total_tokens}`
          );
          resolve(content);
        } catch (e) {
          reject(new Error(`Failed to parse OpenAI response: ${e.message}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// OpenAI Responses API (with web search)
// ---------------------------------------------------------------------------

function callOpenAIResponses(input, instructions) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: OPENAI_MODEL,
      instructions: instructions,
      input: input,
      tools: [{ type: "web_search_preview" }],
    });

    const options = {
      hostname: "api.openai.com",
      path: "/v1/responses",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          return reject(
            new Error(`OpenAI Responses API error ${res.statusCode}: ${data.slice(0, 500)}`)
          );
        }
        try {
          const parsed = JSON.parse(data);
          const textOutput = parsed.output
            .filter((item) => item.type === "message")
            .flatMap((item) => item.content)
            .filter((c) => c.type === "output_text")
            .map((c) => c.text)
            .join("\n");

          if (parsed.usage) {
            console.log(
              `  OpenAI Responses usage — input: ${parsed.usage.input_tokens}, output: ${parsed.usage.output_tokens}, total: ${parsed.usage.total_tokens}`
            );
          }
          resolve(textOutput);
        } catch (e) {
          reject(new Error(`Failed to parse Responses API response: ${e.message}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Step 0: Identify headliners (reuses existing pattern)
// ---------------------------------------------------------------------------

function identifyTopComedians(events) {
  const eventNames = events
    .filter((ev) => {
      const name = ev.name.toLowerCase();
      return (
        !name.includes("open mic") &&
        !name.includes("showcase") &&
        !name.includes("karaoke") &&
        !name.includes("showdown") &&
        !name.includes("dating")
      );
    })
    .map((ev) => ev.name);

  const unique = [...new Set(eventNames)];

  const prompt = `Here is a list of comedy show names happening in Houston this week. Identify ALL that feature recognizable comedians — anyone with Netflix/HBO/Comedy Central specials, TV appearances, major podcast appearances, sold-out tours, large social media followings (100k+), etc.

Shows:
${unique.map((n) => `- ${n}`).join("\n")}

Return ONLY a JSON array of objects with "name" (the comedian's name, not the event title) and "show" (the event title exactly as listed). Example:
[{"name": "Ali Siddiq", "show": "Ali Siddiq: The Domino Effect Tour"}]

If there are no recognizable names, return an empty array [].
Return ONLY the JSON array, no other text.`;

  return callOpenAI(prompt, "You are a comedy expert. Return only valid JSON.", 0.3);
}

// ---------------------------------------------------------------------------
// Step 1: Deep research (per comedian)
// ---------------------------------------------------------------------------

function researchComedian(name) {
  const input = `Research the comedian ${name} thoroughly. I need VERIFIED facts only.

Return a JSON object with these fields (leave null/empty if you cannot verify):
{
  "full_name": "",
  "hometown": "",
  "career_start_year": null,
  "specials": [{"title": "", "platform": "", "year": null}],
  "podcast_appearances": [{"show": "", "year_approx": null}],
  "tv_appearances": [{"show": "", "context": ""}],
  "comedy_style": {
    "tone": "",
    "structure": "",
    "recurring_themes": [],
    "comparable_to": ""
  },
  "live_reputation": "",
  "recent_activity_2025_2026": "",
  "instagram_handle": "",
  "notable_bits_or_quotes": [],
  "background_story": "",
  "source_urls": [
    {"label": "Wikipedia", "url": ""},
    {"label": "Netflix special page or IMDB", "url": ""},
    {"label": "Notable interview or article", "url": ""},
    {"label": "Podcast episode or appearance", "url": ""}
  ]
}

For source_urls: include 3-6 real, working URLs you found during research. These should be the actual pages you pulled facts from — Wikipedia, IMDB, Netflix, YouTube specials, podcast episodes, magazine interviews, etc. Only include URLs you actually visited and verified. Leave the array empty if you cannot find reliable sources.

CRITICAL: Only include facts you can verify via web search. If you cannot find a special title, do not invent one. If you cannot find podcast appearances, leave the array empty. Accuracy over completeness.

Return ONLY the JSON object, no other text.`;

  const instructions =
    "You are a comedy research assistant. Search the web thoroughly to find accurate, current information about this comedian. Return ONLY verified facts in valid JSON format. Never fabricate credits, special titles, or appearances. If something cannot be verified, omit it.";

  return callOpenAIResponses(input, instructions);
}

// ---------------------------------------------------------------------------
// Step 2: Write the blog post
// ---------------------------------------------------------------------------

function writeBlogPost(comedianName, venue, city, date, time, price, ticketUrl, imageUrl, research) {
  const priceStr = price || "See venue for pricing";
  const timeStr = time || "See venue for time";

  const systemPrompt = `You are a professional entertainment journalist and comedy critic. Your writing appears in major city publications and national culture outlets. You write with authority, specificity, and rhythm. You avoid generic phrasing, filler, and clichés. Every sentence must feel intentional and human. You never invent facts. You only use verified details provided in the input.`;

  const prompt = `Write a 600-word blog post promoting a live comedy show.

INPUT DATA:
Comedian: ${comedianName}
Venue: ${venue}
City: ${city}
Date: ${formatDateForDisplay(date)}
Time: ${timeStr}
Price: ${priceStr}
Ticket URL: ${ticketUrl}
${imageUrl ? `Image URL: ${imageUrl}` : ""}

VERIFIED RESEARCH (DO NOT EXCEED OR INVENT):
${research}

STRUCTURE:
1. SEO TITLE — Include comedian name + city + venue. Publication headline tone, not marketing copy. Return it as an <h1> tag.

2. OPENING — Sharp, specific hook anchored to something real: a bit, a perspective, recent momentum, or reputation. No "get ready," "don't miss," or "comedy fans will love."

3. WHO THEY ARE — Weave credentials into narrative. Mention specific specials with year and platform. Give context for why those credits matter. No bullet-style listing.

4. COMEDY STYLE — Describe how they actually perform: timing, tone, structure, persona. Use concrete language. Reference themes from known material if available. Never use "hilarious," "unique," or "relatable" without backing it up.

5. WHAT TO EXPECT LIVE — Describe the live experience: crowd work, pacing, energy, room feel. Make it feel observed, not guessed.

6. EVENT DETAILS — Weave in date, venue, time, price naturally. Not a hard break from the narrative.

7. CTA — One short closing sentence pointing to tickets. No hype.

8. SIGN-OFF — End the post with this exact HTML (do not modify):
<div class="post-footer">
  <p>For more Houston comedy shows, visit <a href="https://comedyhouston.com">ComedyHouston.com</a> — updated twice daily with every show in the city.</p>
  <p>Have a question or want to list your show? <a href="https://comedyhouston.com/contact/">Contact us</a>.</p>
</div>

SOURCE LINKS (IMPORTANT):
The research data includes a "source_urls" array with verified URLs. You MUST weave 3-4 of these as natural hyperlinks into the article body. For example:
- When mentioning a Netflix special, link the special title to its IMDB/Netflix page
- When mentioning their background, link to their Wikipedia page
- When mentioning a podcast appearance, link to the episode
- When mentioning an interview or article, link to it
Use natural anchor text — link the relevant phrase, not "click here." If fewer than 3 source URLs are available, use what you have. Do NOT invent URLs.

BANNED PHRASES (remove if they appear):
- "Don't miss"
- "Known for his/her unique style"
- "A night of laughs"
- "Comedy fans will enjoy/love"
- "Get ready"
- "Side-splitting"
- "Rib-tickling"
- "Comedic genius"
- "Laugh-out-loud"
- "Must-see"
- "Hilarity ensues"
- Any sentence that could apply to any comedian without changes

STYLE:
- No exclamation points
- No emojis
- Vary sentence length for rhythm
- Maximum 3 uses of the comedian's full name; use pronouns or last name after that
- At least 3 concrete, verifiable details from the research
- Write like a human critic, not a marketer

OUTPUT: Return ONLY the HTML blog post content. Use semantic HTML: <h1> for the SEO title, <p> for paragraphs. No <html>/<head>/<body> wrapper. Include a single <a class="ticket-link" href="${ticketUrl}">Get Tickets</a> link in the CTA paragraph.`;

  return callOpenAI(prompt, systemPrompt, 0.6);
}

// ---------------------------------------------------------------------------
// Step 3: Fact-check / editorial pass
// ---------------------------------------------------------------------------

function factCheckPost(research, draft) {
  const systemPrompt = `You are a senior editorial fact-checker at a major publication. Your job is to compare a draft article against verified source research and remove anything that is not supported. You are ruthless about accuracy. You never add content, only subtract.`;

  const prompt = `RESEARCH DATA:
${research}

DRAFT ARTICLE:
${draft}

Review this article against the research data. For each claim in the article:
1. If it appears in the research data → keep it
2. If it's a reasonable inference from the research → keep it
3. If it's NOT in the research and cannot be verified → REMOVE the entire sentence

Also remove:
- Any generic sentence that could describe any comedian (e.g., "audiences are in for a treat")
- Any adjective not backed by a specific reference
- Any fabricated quotes or bit descriptions not in the research
- Any of these banned phrases: "don't miss," "must-see," "side-splitting," "comedic genius," "hilarity ensues," "get ready," "a night of laughs"

IMPORTANT:
- Do not add new content. Only subtract or lightly rephrase for flow after removing sentences.
- Keep the HTML structure intact. Return the cleaned HTML.
- PRESERVE all hyperlinks (<a href="...">) that link to real source URLs (Wikipedia, IMDB, Netflix, YouTube, etc.). These are sourced references and should NOT be removed.
- PRESERVE the <div class="post-footer"> section at the end exactly as-is. Do not modify or remove it.`;

  return callOpenAI(prompt, systemPrompt, 0.2);
}

// ---------------------------------------------------------------------------
// Instagram graphic HTML templates (3 sizes per comedian)
// ---------------------------------------------------------------------------

const IMAGES_DIR = path.join(COMEDIANS_DIR, "images");

/**
 * Generate an Instagram graphic HTML template for a comedian.
 * Sizes: square (1080×1080), portrait (1080×1350), story (1080×1920)
 */
function generateComedianGraphicHTML(name, venue, dateStr, imageUrl, size) {
  const displayDate = formatDateForDisplay(dateStr);
  const safeName = name
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const safeVenue = (venue || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const safeDate = displayDate
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const safeImage = (imageUrl || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");

  const dims = {
    square:   { w: 1080, h: 1080 },
    portrait: { w: 1080, h: 1350 },
    story:    { w: 1080, h: 1920 },
  };
  const { w, h } = dims[size];

  // Adjust layout per size
  const photoHeight = size === "story" ? "60%" : size === "portrait" ? "65%" : "70%";
  const gradientStart = size === "story" ? "55%" : size === "portrait" ? "58%" : "60%";
  const nameFontSize = size === "story" ? "56px" : "48px";
  const detailFontSize = size === "story" ? "24px" : "20px";
  const brandFontSize = "13px";
  const bottomPadding = size === "story" ? "60px" : "40px";
  const objectPosition = size === "square" ? "center 20%" : "center 15%";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${w}px;
      height: ${h}px;
      font-family: 'Inter', sans-serif;
      overflow: hidden;
      position: relative;
      background: #0a0a0f;
    }
    .photo {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: ${photoHeight};
      object-fit: cover;
      object-position: ${objectPosition};
    }
    .gradient {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      height: ${100 - parseInt(gradientStart)}%;
      background: linear-gradient(
        to bottom,
        rgba(10, 10, 15, 0) 0%,
        rgba(10, 10, 15, 0.6) 25%,
        rgba(10, 10, 15, 0.92) 60%,
        rgba(10, 10, 15, 1) 100%
      );
    }
    .content {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      padding: 0 48px ${bottomPadding};
      z-index: 2;
    }
    .accent-line {
      width: 40px;
      height: 3px;
      background: #ff4d6a;
      margin-bottom: 16px;
    }
    .name {
      font-size: ${nameFontSize};
      font-weight: 800;
      color: #ffffff;
      letter-spacing: -0.02em;
      line-height: 1.1;
      margin-bottom: 12px;
    }
    .details {
      font-size: ${detailFontSize};
      font-weight: 500;
      color: rgba(255, 255, 255, 0.75);
      line-height: 1.5;
    }
    .brand {
      position: absolute;
      bottom: ${size === "story" ? "24px" : "16px"};
      left: 48px;
      font-size: ${brandFontSize};
      font-weight: 600;
      letter-spacing: 2px;
      color: #ff4d6a;
      opacity: 0.7;
      z-index: 2;
    }
  </style>
</head>
<body>
  ${imageUrl ? `<img class="photo" src="${safeImage}" alt="${safeName}">` : ""}
  <div class="gradient"></div>
  <div class="content">
    <div class="accent-line"></div>
    <div class="name">${safeName}</div>
    <div class="details">${safeVenue}<br>${safeDate}</div>
  </div>
  <div class="brand">COMEDYHOUSTON.COM</div>
</body>
</html>`;
}

/**
 * Write all 3 Instagram graphic HTML files for a comedian.
 * Returns array of { htmlPath, pngPath, size, slug } objects.
 */
function writeComedianGraphics(name, venue, date, imageUrl, slug) {
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }

  const sizes = ["square", "portrait", "story"];
  const results = [];

  for (const size of sizes) {
    const html = generateComedianGraphicHTML(name, venue, date, imageUrl, size);
    const htmlFile = `${slug}-${size}.html`;
    const pngFile = `${slug}-${size}.png`;
    const htmlPath = path.join(IMAGES_DIR, htmlFile);
    fs.writeFileSync(htmlPath, html);
    results.push({
      htmlPath,
      pngPath: path.join(IMAGES_DIR, pngFile),
      pngFile,
      size,
      slug,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Per-comedian Instagram caption
// ---------------------------------------------------------------------------

function generateComedianCaption(comedianName, venue, dateStr, instagramHandle, research) {
  const displayDate = formatDateForDisplay(dateStr);

  const prompt = `Write an Instagram caption promoting a single comedian's upcoming show.

COMEDIAN: ${comedianName}
VENUE: ${venue}
DATE: ${displayDate}
INSTAGRAM: ${instagramHandle || "(not found)"}

RESEARCH (use ONLY verified details from this):
${research}

STRUCTURE:
1. HOOK (1 sentence): Lead with one specific, real credit — a special title, a show they were on, a podcast they host. Make it feel like insider knowledge. Address Houston directly.

2. THE PITCH (2-3 sentences): Why this comedian is worth seeing live. Use 1-2 concrete details from the research. Describe their style or energy in plain language. Frame it as a personal recommendation.

3. SHOW DETAILS (1 line): ${venue} · ${displayDate}

4. CTA (1 sentence): Link in bio for tickets. Tag someone you'd bring.

5. HASHTAGS (new line): #HoustonComedy #StandUp #LiveComedy #DateNightHouston #ThingsToDoInHouston #${comedianName.replace(/[^a-zA-Z0-9]/g, "")}

6. TAGS (new line): ${instagramHandle ? instagramHandle : "(skip — no handle available)"}

RULES:
- Total caption body (sections 1-4): 80-120 words
- NO emojis except 🎤 once (optional). Zero is also fine.
- Every claim must come from the research. No invented credits.
- NO hyperbole. No "masterclass." No "redefine comedy."
- NO AI filler: "But wait," "This isn't just X," "Don't just hear about it"
- Write at a 6th grade reading level. Short sentences. Plain words.
- The voice is a friend who follows comedy recommending a show.
- If an Instagram handle is provided, include it EXACTLY as given. Never invent handles.`;

  return callOpenAI(
    prompt,
    "You are writing an Instagram caption for a local comedy publication. Your influences are Seth Godin (minimal, say less, mean more) and Roy H. Williams aka the Wizard of Ads (speak to one person, be honest, earn trust). Clean, modern copy that converts because it's genuine — not because it's loud. No AI voice. No marketing fluff."
  );
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapInHTML(blogContent, comedianName, venue, date, generatedAt, imageUrl) {
  const title = `${comedianName} at ${venue} — ${formatDateForDisplay(date)}`;
  const description = `${comedianName} performs live at ${venue} in Houston, TX on ${formatDateForDisplay(date)}. Get show details, comedian background, and ticket info.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(title)} | Comedy Houston</title>
  <meta name="description" content="${escapeHTML(description)}">
  <meta property="og:title" content="${escapeHTML(title)}">
  <meta property="og:description" content="${escapeHTML(description)}">
  <meta property="og:type" content="article">
${imageUrl ? `  <meta property="og:image" content="${escapeHTML(imageUrl)}">` : ""}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg-primary: #0a0a0f;
      --bg-card: #1a1a26;
      --border: #2a2a3a;
      --text-primary: #f0f0f5;
      --text-secondary: #9999aa;
      --text-muted: #666677;
      --accent: #ff4d6a;
      --accent-hover: #ff6b83;
      --accent-secondary: #7c5cff;
      --radius: 12px;
      --transition: 0.2s ease;
    }

    html { scroll-behavior: smooth; -webkit-font-smoothing: antialiased; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.7;
      min-height: 100vh;
    }

    a { color: var(--accent); text-decoration: none; transition: color var(--transition); }
    a:hover { color: var(--accent-hover); text-decoration: underline; }

    .container {
      max-width: 760px;
      margin: 0 auto;
      padding: 40px 24px 80px;
    }

    .header-nav {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 40px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }

    .header-nav a { color: var(--text-secondary); font-size: 0.9rem; font-weight: 500; }

    .header-nav .brand {
      font-size: 1.1rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--accent), var(--accent-secondary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .header-nav .sep { color: var(--text-muted); }

    .hero-image {
      width: 100%;
      max-height: 400px;
      object-fit: cover;
      border-radius: var(--radius);
      margin-bottom: 32px;
    }

    article h1 {
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.2;
      margin-bottom: 8px;
    }

    .meta {
      color: var(--text-secondary);
      font-size: 0.9rem;
      margin-bottom: 32px;
    }

    article h2 {
      font-size: 1.3rem;
      font-weight: 700;
      margin-top: 32px;
      margin-bottom: 12px;
      color: var(--accent);
    }

    article p {
      margin-bottom: 16px;
      color: var(--text-secondary);
    }

    article strong { color: var(--text-primary); }

    .ticket-link {
      display: inline-block;
      margin-top: 8px;
      padding: 10px 24px;
      background: var(--accent);
      color: #fff !important;
      border-radius: 6px;
      font-size: 0.95rem;
      font-weight: 600;
      transition: background var(--transition);
    }

    .ticket-link:hover {
      background: var(--accent-hover);
      text-decoration: none !important;
    }

    .event-details {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      margin: 24px 0;
    }

    .event-details p {
      margin-bottom: 6px;
      color: var(--text-secondary);
      font-size: 0.95rem;
    }

    .event-details strong { color: var(--text-primary); }

    .post-footer {
      margin-top: 40px;
      padding: 24px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }

    .post-footer p {
      margin-bottom: 8px;
      color: var(--text-secondary);
      font-size: 0.95rem;
    }

    .post-footer p:last-child { margin-bottom: 0; }

    .footer {
      margin-top: 60px;
      padding-top: 24px;
      border-top: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 0.85rem;
      text-align: center;
    }

    @media (max-width: 640px) {
      article h1 { font-size: 1.5rem; }
      .container { padding: 24px 16px 60px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <nav class="header-nav">
      <a href="/" class="brand">Comedy Houston</a>
      <span class="sep">/</span>
      <a href="/blog/">Blog</a>
      <span class="sep">/</span>
      <a href="/blog/comedians/">Comedians</a>
    </nav>

${imageUrl ? `    <img src="${escapeHTML(imageUrl)}" alt="${escapeHTML(comedianName)}" class="hero-image">` : ""}

    <article>
${blogContent}
    </article>

    <div class="meta" style="margin-top: 24px;">
      Published ${generatedAt} by Comedy Houston
    </div>

    <footer class="footer">
      <p>
        <a href="/">Browse all shows</a> &middot;
        <a href="/blog/">Weekly roundup</a> &middot;
        Powered by Comedy Houston
      </p>
    </footer>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Generate index page for blog/comedians/
// ---------------------------------------------------------------------------

function generateComediansIndex(posts) {
  const postLinks = posts
    .map(
      (p) =>
        `      <li><a href="${p.filename}">${escapeHTML(p.comedianName)}</a> — ${escapeHTML(p.venue)}, ${formatDateForDisplay(p.date)}</li>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Houston Comedian Spotlights | Comedy Houston</title>
  <meta name="description" content="In-depth profiles of comedians performing live in Houston this week.">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', sans-serif;
      background: #0a0a0f;
      color: #f0f0f5;
      line-height: 1.7;
      min-height: 100vh;
    }
    a { color: #ff4d6a; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 760px; margin: 0 auto; padding: 40px 24px 80px; }
    h1 { font-size: 2rem; font-weight: 800; margin-bottom: 8px; }
    .subtitle { color: #9999aa; margin-bottom: 32px; }
    ul { list-style: none; }
    li {
      padding: 12px 0;
      border-bottom: 1px solid #2a2a3a;
      color: #9999aa;
    }
    li a { font-weight: 600; font-size: 1.05rem; }
    .nav { margin-bottom: 40px; padding-bottom: 20px; border-bottom: 1px solid #2a2a3a; }
    .nav a { color: #9999aa; font-size: 0.9rem; font-weight: 500; }
    .brand {
      font-size: 1.1rem; font-weight: 800;
      background: linear-gradient(135deg, #ff4d6a, #7c5cff);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .sep { color: #666677; margin: 0 4px; }
  </style>
</head>
<body>
  <div class="container">
    <nav class="nav">
      <a href="/" class="brand">Comedy Houston</a>
      <span class="sep">/</span>
      <a href="/blog/">Blog</a>
      <span class="sep">/</span>
      <a href="/blog/comedians/">Comedians</a>
    </nav>
    <h1>Comedian Spotlights</h1>
    <p class="subtitle">In-depth profiles of comedians performing live in Houston this week.</p>
    <ul>
${postLinks}
    </ul>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// WordPress REST API helpers
// ---------------------------------------------------------------------------

/** Make an HTTP/HTTPS request and return the parsed JSON response. */
function wpRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const fullUrl = WP_SITE_URL.replace(/\/$/, "") + urlPath;
    const parsed = new URL(fullUrl);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString("base64");

    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        "User-Agent": "ComedyHouston-BlogBot/1.0",
      },
    };

    if (bodyStr) {
      options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          return reject(
            new Error(`WordPress API ${res.statusCode}: ${data.slice(0, 500)}`)
          );
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse WP response: ${e.message}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** Download an image from a URL and return the raw Buffer + content type. */
function downloadImage(imageUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(imageUrl);
    const lib = parsed.protocol === "https:" ? https : http;

    lib.get(imageUrl, { headers: { "User-Agent": "ComedyHouston-BlogBot/1.0" } }, (res) => {
      // Follow redirects (up to 3)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode >= 400) {
        return reject(new Error(`Image download failed: HTTP ${res.statusCode}`));
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          buffer: Buffer.concat(chunks),
          contentType: res.headers["content-type"] || "image/jpeg",
        });
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

/** Upload an image to WordPress media library, return the media ID. */
function wpUploadImage(imageBuffer, contentType, filename) {
  return new Promise((resolve, reject) => {
    const fullUrl = WP_SITE_URL.replace(/\/$/, "") + "/wp-json/wp/v2/media";
    const parsed = new URL(fullUrl);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const auth = Buffer.from(`${WP_APP_USER}:${WP_APP_PASSWORD}`).toString("base64");

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname,
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": imageBuffer.length,
        "User-Agent": "ComedyHouston-BlogBot/1.0",
      },
    };

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          return reject(
            new Error(`WP media upload ${res.statusCode}: ${data.slice(0, 500)}`)
          );
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.id);
        } catch (e) {
          reject(new Error(`Failed to parse WP media response: ${e.message}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(imageBuffer);
    req.end();
  });
}

/**
 * Publish a blog post to WordPress.
 * Returns the post URL on success.
 */
/** Look up a WordPress category ID by slug. Returns the ID or 0. */
async function wpGetCategoryBySlug(slug) {
  try {
    const categories = await wpRequest("GET", `/wp-json/wp/v2/categories?slug=${encodeURIComponent(slug)}`, null);
    if (Array.isArray(categories) && categories.length > 0) {
      return categories[0].id;
    }
  } catch (err) {
    console.warn(`    Could not look up category "${slug}": ${err.message}`);
  }
  return 0;
}

async function publishToWordPress(comedianName, venue, date, slug, htmlContent, imageUrl) {
  console.log("  Step 4: Publishing to WordPress...");

  // Extract just the article body (strip the <h1> — WordPress uses the title field)
  let wpContent = htmlContent;
  let wpTitle = `${comedianName} at ${venue} — ${formatDateForDisplay(date)}`;

  // Try to extract <h1> from content to use as WP title
  const h1Match = wpContent.match(/<h1[^>]*>(.*?)<\/h1>/i);
  if (h1Match) {
    wpTitle = h1Match[1].replace(/<[^>]+>/g, ""); // strip any inner HTML tags
    wpContent = wpContent.replace(/<h1[^>]*>.*?<\/h1>/i, "").trim();
  }

  // Upload featured image if available
  let featuredMediaId = 0;
  let wpImageUrl = "";
  if (imageUrl) {
    try {
      console.log("    Downloading featured image...");
      const { buffer, contentType } = await downloadImage(imageUrl);
      const ext = contentType.includes("png") ? "png" : "jpg";
      const imgFilename = `${slug}.${ext}`;
      console.log("    Uploading to WordPress media library...");
      featuredMediaId = await wpUploadImage(buffer, contentType, imgFilename);
      console.log(`    Featured image uploaded (media ID: ${featuredMediaId})`);

      // Get the uploaded image URL from WP for embedding in content
      try {
        const media = await wpRequest("GET", `/wp-json/wp/v2/media/${featuredMediaId}`, null);
        wpImageUrl = media.source_url || "";
      } catch (_) {
        wpImageUrl = imageUrl; // fallback to original URL
      }
    } catch (err) {
      console.warn(`    Featured image upload failed: ${err.message}. Publishing without image.`);
    }
  }

  // Inject the image at the top of the post content
  if (wpImageUrl) {
    const imgTag = `<figure class="wp-block-image size-large"><img src="${wpImageUrl}" alt="${comedianName.replace(/"/g, '&quot;')}" class="wp-image-${featuredMediaId}"/></figure>\n\n`;
    wpContent = imgTag + wpContent;
  }

  // Look up the "Shows" category (slug: comedy-shows)
  const categoryId = await wpGetCategoryBySlug("comedy-shows");

  // Create the post
  const postData = {
    title: wpTitle,
    content: wpContent,
    status: "publish",
    slug: slug,
    comment_status: "closed",
  };

  if (featuredMediaId) {
    postData.featured_media = featuredMediaId;
  }

  if (categoryId) {
    postData.categories = [categoryId];
    console.log(`    Category: Shows (ID: ${categoryId})`);
  } else {
    console.warn("    Warning: 'comedy-shows' category not found — posting as Uncategorized.");
  }

  const post = await wpRequest("POST", "/wp-json/wp/v2/posts", postData);
  console.log(`    Published: ${post.link}`);
  return post.link;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Comedy Houston — Per-Comedian Blog Post Generator ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`WordPress publishing: ${WP_ENABLED ? "ENABLED (" + WP_SITE_URL + ")" : "DISABLED (no WP credentials set)"}`);
  console.log("");

  if (!OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY environment variable is not set.");
    process.exit(1);
  }

  // Load events
  const { events, monday, sunday } = loadThisWeeksEvents();
  if (events.length === 0) {
    console.log("No events found for this week. Skipping.");
    process.exit(0);
  }

  const weekRange = formatWeekRange(monday, sunday);
  console.log(`Week range: ${weekRange}`);
  console.log("");

  // Ensure output directory exists
  if (!fs.existsSync(COMEDIANS_DIR)) {
    fs.mkdirSync(COMEDIANS_DIR, { recursive: true });
  }

  // Step 0: Identify headliners
  console.log("Step 0: Identifying headliners...");
  let headliners = [];
  try {
    const raw = await identifyTopComedians(events);
    const jsonStr = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    headliners = JSON.parse(jsonStr);
    // Deduplicate by name
    const seen = new Set();
    headliners = headliners.filter((c) => {
      const key = c.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Hard cap: max 5 comedian posts per week
    if (headliners.length > 5) {
      console.log(`Found ${headliners.length} headliners — capping at 5.`);
      headliners = headliners.slice(0, 5);
    }
    console.log(`Processing ${headliners.length} headliner(s): ${headliners.map((c) => c.name).join(", ")}`);
  } catch (err) {
    console.error(`Failed to identify headliners: ${err.message}`);
    process.exit(1);
  }
  console.log("");

  if (headliners.length === 0) {
    console.log("No recognizable headliners this week. Skipping.");
    process.exit(0);
  }

  // Process each headliner
  const generatedPosts = [];

  for (const headliner of headliners) {
    console.log(`━━━ Processing: ${headliner.name} ━━━`);

    // Find the matching event(s) — use the first one for details
    const matchedEvent = events.find(
      (ev) => ev.name === headliner.show || ev.name.toLowerCase().includes(headliner.name.toLowerCase())
    );

    if (!matchedEvent) {
      console.log(`  Could not match event for ${headliner.name}. Skipping.`);
      console.log("");
      continue;
    }

    const venue = matchedEvent.venue || "Houston Venue";
    const date = matchedEvent.date;
    const time = matchedEvent.time;
    const ticketUrl = matchedEvent.ticket_url || "";
    const imageUrl = matchedEvent.image_url || "";
    const priceMin = matchedEvent.price_min;
    const priceMax = matchedEvent.price_max;
    let price = "";
    if (priceMin !== null && priceMax !== null && priceMin !== priceMax) {
      price = `$${priceMin} – $${priceMax}`;
    } else if (priceMin !== null) {
      price = `$${priceMin}`;
    } else if (priceMax !== null) {
      price = `Up to $${priceMax}`;
    }

    // Step 1: Deep research
    console.log("  Step 1: Researching via web search...");
    let research = "";
    try {
      research = await researchComedian(headliner.name);
      console.log("  Research complete.");
    } catch (err) {
      console.warn(`  Research failed: ${err.message}. Writing with limited data.`);
      research = JSON.stringify({ full_name: headliner.name, note: "Research unavailable" });
    }

    // Step 2: Write the blog post
    console.log("  Step 2: Writing blog post...");
    let draft = "";
    try {
      draft = await writeBlogPost(
        headliner.name, venue, "Houston, TX", date, time, price, ticketUrl, imageUrl, research
      );
      draft = draft.replace(/^```html\s*\n?/i, "").replace(/\n?```\s*$/g, "").trim();
      console.log("  Draft complete.");
    } catch (err) {
      console.error(`  Blog writing failed: ${err.message}. Skipping ${headliner.name}.`);
      console.log("");
      continue;
    }

    // Step 3: Fact-check pass
    console.log("  Step 3: Fact-checking...");
    let finalContent = draft;
    try {
      finalContent = await factCheckPost(research, draft);
      finalContent = finalContent.replace(/^```html\s*\n?/i, "").replace(/\n?```\s*$/g, "").trim();
      console.log("  Fact-check complete.");
    } catch (err) {
      console.warn(`  Fact-check failed: ${err.message}. Using unedited draft.`);
    }

    // Generate filename
    const dateSlug = date; // YYYY-MM-DD
    const nameSlug = slugify(headliner.name);
    const venueSlug = slugify(venue);
    const filename = `${nameSlug}-${venueSlug}-${dateSlug}.html`;
    const postSlug = `${nameSlug}-${venueSlug}-${dateSlug}`;

    // Wrap in HTML template
    const generatedAt = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const html = wrapInHTML(finalContent, headliner.name, venue, date, generatedAt, imageUrl);

    // Write file to GitHub Pages
    const filePath = path.join(COMEDIANS_DIR, filename);
    fs.writeFileSync(filePath, html);
    console.log(`  Wrote: blog/comedians/${filename}`);

    // Step 4: Generate Instagram graphics (3 sizes)
    console.log("  Step 4: Generating Instagram graphic templates...");
    let graphicFiles = [];
    try {
      graphicFiles = writeComedianGraphics(headliner.name, venue, date, imageUrl, postSlug);
      for (const gf of graphicFiles) {
        console.log(`    Wrote: blog/comedians/images/${path.basename(gf.htmlPath)}`);
      }
    } catch (err) {
      console.warn(`  Instagram graphics failed: ${err.message}`);
    }

    // Step 5: Generate Instagram caption
    console.log("  Step 5: Generating Instagram caption...");
    let caption = "";
    let instagramHandle = "";
    // Try to extract Instagram handle from research
    try {
      const researchObj = JSON.parse(research);
      instagramHandle = researchObj.instagram_handle || "";
    } catch (_) {
      // Research wasn't valid JSON or didn't have handle — that's fine
    }
    try {
      caption = await generateComedianCaption(headliner.name, venue, date, instagramHandle, research);
      const captionPath = path.join(COMEDIANS_DIR, `${postSlug}-caption.txt`);
      fs.writeFileSync(captionPath, caption);
      console.log(`  Wrote: blog/comedians/${postSlug}-caption.txt`);
    } catch (err) {
      console.warn(`  Caption generation failed: ${err.message}`);
    }

    let wpLink = "";

    // Publish to WordPress if configured
    if (WP_ENABLED) {
      try {
        wpLink = await publishToWordPress(
          headliner.name, venue, date, postSlug, finalContent, imageUrl
        );
      } catch (err) {
        console.error(`  WordPress publish failed: ${err.message}`);
        console.log("  Post saved to GitHub Pages only.");
      }
    }
    console.log("");

    generatedPosts.push({
      comedianName: headliner.name,
      venue: venue,
      date: date,
      filename: filename,
      imageUrl: imageUrl,
      ticketUrl: ticketUrl,
      slug: postSlug,
      wpLink: wpLink,
      caption: caption,
      graphicFiles: graphicFiles.map((gf) => gf.pngFile),
    });
  }

  // Generate index page
  if (generatedPosts.length > 0) {
    const indexHTML = generateComediansIndex(generatedPosts);
    fs.writeFileSync(path.join(COMEDIANS_DIR, "index.html"), indexHTML);
    console.log(`Wrote: blog/comedians/index.html`);

    // Write manifest JSON (used by Phase 2 WordPress publishing)
    const manifest = {
      generated_at: new Date().toISOString(),
      week_range: weekRange,
      posts: generatedPosts,
    };
    fs.writeFileSync(
      path.join(COMEDIANS_DIR, "manifest.json"),
      JSON.stringify(manifest, null, 2)
    );
    console.log(`Wrote: blog/comedians/manifest.json`);

    // Write email summary for the workflow email step
    const names = generatedPosts.map((p) => p.comedianName);
    const totalImages = generatedPosts.reduce((n, p) => n + (p.graphicFiles || []).length, 0);
    const subject = `Comedy Houston — Comedian Spotlights: ${names.join(", ")} (${totalImages} posts)`;

    let emailBody = `Here are this week's comedian spotlight assets — ready to post on Instagram.\n\n`;

    for (const post of generatedPosts) {
      emailBody += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      emailBody += `${post.comedianName} — ${post.venue}, ${formatDateForDisplay(post.date)}\n`;
      if (post.wpLink) {
        emailBody += `Blog post: ${post.wpLink}\n`;
      } else {
        emailBody += `Blog post: https://sanjmanak.github.io/show_lister/blog/comedians/${post.filename}\n`;
      }
      emailBody += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      if (post.caption) {
        emailBody += `INSTAGRAM CAPTION (copy & paste):\n\n${post.caption}\n\n`;
      }
      emailBody += `Images attached: ${(post.graphicFiles || []).join(", ") || "none"}\n\n`;
    }

    emailBody += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    emailBody += `All ${totalImages} images are attached — 3 sizes per comedian (square, portrait, story).\n`;
    emailBody += `Browse all shows: https://comedyhouston.com\n`;

    fs.writeFileSync(path.join(COMEDIANS_DIR, "email-subject.txt"), subject);
    fs.writeFileSync(path.join(COMEDIANS_DIR, "email-body.txt"), emailBody);
    console.log(`Wrote: blog/comedians/email-subject.txt`);
    console.log(`Wrote: blog/comedians/email-body.txt`);
  }

  console.log("");
  console.log(`Done. Generated ${generatedPosts.length} comedian post(s).`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
