#!/usr/bin/env node

/**
 * Comedy Houston — Weekly Blog Post Generator
 * Reads events.json, filters to this week's events, calls OpenAI to write
 * a blog post, and outputs blog/index.html.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

const OUTPUT_DIR = path.resolve(__dirname, "..");
const EVENTS_JSON_PATH = path.join(OUTPUT_DIR, "events.json");
const BLOG_DIR = path.join(OUTPUT_DIR, "blog");
const BLOG_HTML_PATH = path.join(BLOG_DIR, "index.html");
const BLOG_HERO_HTML_PATH = path.join(BLOG_DIR, "weekly-hero.html");

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Get Monday 00:00 and Sunday 23:59 of the current week (Central Time). */
function getCurrentWeekRange() {
  // Work in UTC but label as Central for display
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ...

  // Monday of this week
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);

  // Sunday of this week
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

  // Sort by date then time
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
// OpenAI API call
// ---------------------------------------------------------------------------

function callOpenAI(prompt, systemPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
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
            `OpenAI usage — prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens}, total: ${usage.total_tokens}`
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
              `OpenAI Responses usage — input: ${parsed.usage.input_tokens}, output: ${parsed.usage.output_tokens}, total: ${parsed.usage.total_tokens}`
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
// Research comedians via web search
// ---------------------------------------------------------------------------

function researchComedians(comedianNames) {
  const input = `Search the web for current information about these comedians who are performing in Houston this week:

${comedianNames.map((name) => `- ${name}`).join("\n")}

For EACH comedian, find:
1. Their most notable credits — specific Netflix/HBO/Comedy Central special TITLES, TV show names, podcast names, movie titles
2. Any recent activity (2025–2026): new specials, tour announcements, recent podcast appearances, viral moments
3. Their comedy style and what makes their live show special

Return a 3-4 sentence research summary for each comedian. Use SPECIFIC NAMES AND TITLES, not generic descriptions. If you can't find reliable info about someone, say so.`;

  const instructions =
    "You are a comedy research assistant. Search the web to find accurate, current information about each comedian. Cite specific show titles, special names, and verifiable facts. If you cannot find information about a comedian, say so rather than guessing.";

  return callOpenAIResponses(input, instructions);
}

// ---------------------------------------------------------------------------
// Identify top comedians via OpenAI
// ---------------------------------------------------------------------------

function identifyTopComedians(events) {
  const eventNames = events
    .filter((ev) => {
      const name = ev.name.toLowerCase();
      // Skip open mics, showcases, karaoke, and generic recurring events
      return (
        !name.includes("open mic") &&
        !name.includes("showcase") &&
        !name.includes("karaoke") &&
        !name.includes("showdown") &&
        !name.includes("dating")
      );
    })
    .map((ev) => ev.name);

  // Deduplicate names (same comedian may have multiple dates)
  const unique = [...new Set(eventNames)];

  const prompt = `Here is a list of comedy show names happening in Houston this week. Pick the top 5 that feature the most well-known, nationally recognized comedians. Only pick comedians you genuinely know are famous (Netflix specials, TV appearances, major podcasts, sold-out tours, etc.). If there are fewer than 5 recognizable names, only return however many you're confident about (minimum 0).

Shows:
${unique.map((n) => `- ${n}`).join("\n")}

Return ONLY a JSON array of objects with "name" (the comedian's name, not the event title) and "show" (the event title exactly as listed). Example:
[{"name": "Ali Siddiq", "show": "Ali Siddiq"}, {"name": "Greg Fitzsimmons", "show": "Greg Fitzsimmons"}]

Return ONLY the JSON array, no other text.`;

  return callOpenAI(prompt, "You are a comedy expert. Return only valid JSON.");
}

// ---------------------------------------------------------------------------
// HTML hero creative (replaces DALL-E)
// ---------------------------------------------------------------------------

function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateHeroCreativeHTML(comedianNames, weekRange) {
  const nameItems = comedianNames
    .map((name) => `      <div class="lineup-name">${escapeHTML(name)}</div>`)
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 1200px;
      height: 630px;
      font-family: 'Inter', sans-serif;
      background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 50%, #16213e 100%);
      color: #f0f0f5;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      overflow: hidden;
      position: relative;
    }
    .bg-accent {
      position: absolute;
      width: 400px;
      height: 400px;
      border-radius: 50%;
      filter: blur(120px);
      opacity: 0.15;
    }
    .bg-accent-1 { background: #ff4d6a; top: -100px; right: -50px; }
    .bg-accent-2 { background: #7c5cff; bottom: -100px; left: -50px; }
    .header-label {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 4px;
      text-transform: uppercase;
      color: #ff4d6a;
      margin-bottom: 12px;
      z-index: 1;
    }
    .title {
      font-size: 42px;
      font-weight: 900;
      letter-spacing: -1px;
      margin-bottom: 32px;
      z-index: 1;
      text-align: center;
    }
    .lineup {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      z-index: 1;
      margin-bottom: 32px;
    }
    .lineup-name {
      font-size: 28px;
      font-weight: 700;
      color: #ffffff;
      padding: 4px 20px;
      border-left: 3px solid #ff4d6a;
    }
    .week-range {
      font-size: 18px;
      font-weight: 500;
      color: #9999aa;
      z-index: 1;
    }
    .brand {
      position: absolute;
      bottom: 24px;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 2px;
      color: #666677;
      z-index: 1;
    }
  </style>
</head>
<body>
  <div class="bg-accent bg-accent-1"></div>
  <div class="bg-accent bg-accent-2"></div>
  <div class="header-label">This Week In</div>
  <div class="title">Houston Comedy</div>
  <div class="lineup">
${nameItems}
  </div>
  <div class="week-range">${escapeHTML(weekRange)}</div>
  <div class="brand">COMEDYHOUSTON.COM</div>
</body>
</html>`;
}

function generateInlineHeroHTML(comedianNames, weekRange) {
  const nameItems = comedianNames
    .map((name) => `        <div class="hero-name">${escapeHTML(name)}</div>`)
    .join("\n");

  return `    <div class="hero-creative">
      <div class="hero-label">This Week In</div>
      <div class="hero-title">Houston Comedy</div>
      <div class="hero-lineup">
${nameItems}
      </div>
      <div class="hero-dates">${escapeHTML(weekRange)}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Build the prompt
// ---------------------------------------------------------------------------

function buildPrompt(events, weekRange, comedianResearch) {
  const eventList = events
    .map((ev, idx) => {
      const parts = [`- **${ev.name}** [EVENT_ID: ${idx}]`];
      parts.push(`  Venue: ${ev.venue}`);
      parts.push(`  Date: ${formatDateForDisplay(ev.date)}`);
      if (ev.day_of_week) parts.push(`  Day: ${ev.day_of_week}`);
      if (ev.time) parts.push(`  Time: ${ev.time}`);
      if (ev.price_min !== null) {
        const price =
          ev.price_min === ev.price_max || ev.price_max === null
            ? `$${ev.price_min}`
            : `$${ev.price_min} – $${ev.price_max}`;
        parts.push(`  Price: ${price}`);
      }
      if (ev.description) {
        const desc =
          ev.description.length > 300
            ? ev.description.slice(0, 300) + "..."
            : ev.description;
        parts.push(`  Description: ${desc}`);
      }
      if (ev.ticket_url) parts.push(`  Tickets: ${ev.ticket_url}`);
      if (ev.image_url) parts.push(`  Image: ${ev.image_url}`);
      return parts.join("\n");
    })
    .join("\n\n");

  const researchSection = comedianResearch
    ? `\n\nCOMEDIAN RESEARCH (from web search — use this for accurate, current blurbs):\n\n${comedianResearch}\n`
    : "";

  return `Write a blog post about Houston comedy shows for the week of ${weekRange}.

Here are the ${events.length} events happening this week:

${eventList}
${researchSection}
Requirements:

COMEDIAN DEEP DIVES (this is the MOST IMPORTANT part — this is what makes this blog post worth reading):

You MUST identify the most well-known, nationally recognized comedians performing this week and write a DETAILED two-sentence blurb for each one. These blurbs are the heart of the blog post.

Rules for the blurbs:
- Pick between 2 and 4 comedians you GENUINELY RECOGNIZE as having a notable presence (Netflix specials, HBO specials, Comedy Central specials, late night TV appearances, major podcasts like Joe Rogan / Kill Tony / Tigerbelly, viral clips, sitcom roles, movies, comedy albums, tours, etc.)
- For EACH one, write EXACTLY two sentences that are specific and personal:
  - Sentence 1: What they're specifically known for — name the ACTUAL special titles, show names, podcast names, movie titles, etc. Be concrete. Not "known for his relatable humor" but "broke out with his Netflix hour 'The Domino Effect' and his legendary storytelling segments on 'This Is Not Happening'"
  - Sentence 2: What the audience can expect at the live show — their style, energy, what makes their live performance different or special. For example: "His live sets are marathon storytelling sessions that feel like sitting around a campfire with the funniest person you've ever met — raw, unpredictable, and impossible to look away from."
- Write these blurbs using a <p class="blurb"> tag inside the show-info div
- If a comedian appears multiple times in the week (e.g., Thursday + Friday + Saturday), write the full blurb ONLY on their first appearance. For subsequent dates, write one sentence like "Another chance to catch [Name] — see Thursday's listing for why you don't want to miss this."
- If you DON'T genuinely recognize a comedian, DO NOT write a blurb. Do NOT fabricate credits. Just present the event details. Silence is better than filler.
- For open mic nights, showcases, karaoke, or multi-act variety shows — write one sentence about the vibe/format of the event instead of comedian blurbs.

MINIMUM OUTPUT: At least 2 comedians with 2-sentence blurbs (4 sentences total across the post).
MAXIMUM OUTPUT: No more than 4 comedians with 2-sentence blurbs (8 sentences total).
If there genuinely are fewer than 2 recognizable names this week, that's OK — just say so in the intro.

INTRO PARAGRAPH:
- Open with an engaging 2-3 sentence intro that specifically names the biggest acts of the week and why they're a big deal
- Don't be generic ("Houston is bursting with laughs!"). Instead: "Ali Siddiq brings his raw prison-to-stage storytelling to the Improv this week, and if you haven't seen Greg Fitzsimmons' razor-sharp crowd work, Friday at Punch Line is your shot."
- Set the tone like you're texting a friend who asked "what's good in comedy this week?"

IMAGES:
- For EVERY event that has an Image URL listed above, you MUST embed it using this exact HTML structure:
  <div class="show-card">
    <img src="THE_IMAGE_URL" alt="EVENT NAME" class="show-img" loading="lazy">
    <div class="show-info">
      ...show details here...
    </div>
  </div>
- For events without an image, use the same structure but skip the <img> tag
- The image and show info should appear side-by-side (the CSS handles this)

STRUCTURE:
- Group events by day of the week (Monday, Tuesday, etc.) — only include days that have events
- Use <h2> for the blog post title
- Use <h3> for each day heading (e.g., "Thursday" or "Friday Night")
- Within each day, use a <div class="show-card"> for each event
- For each event's show-info div, include: show name in <strong>, venue, time, price (each on a line with <br>), the <p class="blurb"> if applicable, and a "Get Tickets" link
- End with a short 1-2 sentence outro encouraging people to grab tickets early, mentioning which shows are most likely to sell out

FORMAT:
- Output ONLY the blog post content in HTML (just the article body — no <html>, <head>, or <body> tags)
- Use semantic HTML: <h2>, <h3>, <p>, <a>, <strong>
- Wrap ticket links in <a class="ticket-link" href="URL">Get Tickets</a>
- Comedian blurbs go in <p class="blurb"> tags
- Keep it conversational and knowledgeable — you're a comedy nerd who actually follows these comedians, not a marketing intern generating copy`;
}

const SYSTEM_PROMPT = `You are a Houston comedy scene blogger who ACTUALLY follows stand-up comedy closely. You write the weekly roundup for ComedyHouston.com. You have deep, specific knowledge of the comedy world:

- You know specific Netflix/HBO/Comedy Central special TITLES (not just "they have a special")
- You know which podcasts comedians host or have appeared on (Joe Rogan, Kill Tony, Tigerbelly, Your Mom's House, WTF with Marc Maron, etc.)
- You know breakout moments: Last Comic Standing seasons, Comedy Central roasts, viral clips, late night sets
- You know comedians' STYLES: storytelling vs. one-liners vs. crowd work vs. observational vs. dark humor

CRITICAL RULES:
1. When you write a blurb about a comedian, you MUST include at least one SPECIFIC, VERIFIABLE credit (a named special, a named show, a named podcast). "Known for his hilarious style" is BANNED. "Known for his Netflix hour 'The Domino Effect'" is correct.
2. If you cannot name a specific credit for a comedian, DO NOT write a blurb. Just list the event details.
3. Never describe a comedian as "a rising star" or "up-and-coming" or "known for relatable humor" — these are empty filler phrases. Either you know specific things about them or you stay silent.
4. Write like you're texting a friend, not writing marketing copy. No exclamation points in every sentence. Be genuine.

You write in clean, semantic HTML using the CSS classes specified in the prompt. You always include practical details (day, time, venue, price, ticket links) and embed event images when provided.`;

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function wrapInHTML(blogContent, weekRange, generatedAt, inlineHeroHTML) {

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>This Week in Houston Comedy — ${weekRange}</title>
  <meta name="description" content="Your weekly roundup of every comedy show in Houston for ${weekRange}. Find shows at Houston Improv, The Riot, The Secret Group, and more.">
  <meta property="og:image" content="weekly-hero.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg-primary: #0a0a0f;
      --bg-secondary: #12121a;
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

    .header-nav a {
      color: var(--text-secondary);
      font-size: 0.9rem;
      font-weight: 500;
    }

    .header-nav .brand {
      font-size: 1.1rem;
      font-weight: 800;
      background: linear-gradient(135deg, var(--accent), var(--accent-secondary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .header-nav .sep { color: var(--text-muted); }

    .hero-creative {
      background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 50%, #16213e 100%);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 48px 32px;
      margin-bottom: 32px;
      text-align: center;
      position: relative;
      overflow: hidden;
    }

    .hero-creative::before,
    .hero-creative::after {
      content: '';
      position: absolute;
      width: 300px;
      height: 300px;
      border-radius: 50%;
      filter: blur(100px);
      opacity: 0.15;
    }

    .hero-creative::before {
      background: var(--accent);
      top: -100px;
      right: -50px;
    }

    .hero-creative::after {
      background: var(--accent-secondary);
      bottom: -100px;
      left: -50px;
    }

    .hero-label {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 3px;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 8px;
      position: relative;
      z-index: 1;
    }

    .hero-title {
      font-size: 2rem;
      font-weight: 900;
      letter-spacing: -1px;
      margin-bottom: 24px;
      position: relative;
      z-index: 1;
    }

    .hero-lineup {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      margin-bottom: 24px;
      position: relative;
      z-index: 1;
    }

    .hero-name {
      font-size: 1.2rem;
      font-weight: 700;
      padding: 2px 16px;
      border-left: 3px solid var(--accent);
    }

    .hero-dates {
      font-size: 0.95rem;
      font-weight: 500;
      color: var(--text-secondary);
      position: relative;
      z-index: 1;
    }

    article h2 {
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

    article h3 {
      font-size: 1.3rem;
      font-weight: 700;
      margin-top: 36px;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
      color: var(--accent);
    }

    article p {
      margin-bottom: 16px;
      color: var(--text-secondary);
    }

    article strong { color: var(--text-primary); }

    article ul, article ol {
      margin-bottom: 16px;
      padding-left: 24px;
      color: var(--text-secondary);
    }

    article li { margin-bottom: 8px; }

    .show-card {
      display: flex;
      gap: 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      margin-bottom: 20px;
      transition: border-color var(--transition);
    }

    .show-card:hover {
      border-color: #3a3a4f;
    }

    .show-img {
      width: 180px;
      min-width: 180px;
      height: 180px;
      object-fit: cover;
      border-radius: 8px;
      flex-shrink: 0;
    }

    .show-info {
      flex: 1;
      min-width: 0;
    }

    .show-info p {
      margin-bottom: 8px;
      font-size: 0.95rem;
    }

    .show-info strong {
      font-size: 1.1rem;
    }

    .show-info .blurb {
      font-style: italic;
      color: var(--text-secondary);
      margin-top: 4px;
      margin-bottom: 10px;
      font-size: 0.9rem;
      line-height: 1.5;
    }

    .show-info .details {
      color: var(--text-muted);
      font-size: 0.88rem;
    }

    .ticket-link {
      display: inline-block;
      margin-top: 10px;
      padding: 6px 16px;
      background: var(--accent);
      color: #fff !important;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 600;
      transition: background var(--transition);
    }

    .ticket-link:hover {
      background: var(--accent-hover);
      text-decoration: none !important;
    }

    @media (max-width: 640px) {
      .show-card {
        flex-direction: column;
        gap: 14px;
      }

      .show-img {
        width: 100%;
        min-width: unset;
        height: 200px;
      }
    }

    .footer {
      margin-top: 60px;
      padding-top: 24px;
      border-top: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 0.85rem;
      text-align: center;
    }

    @media (max-width: 640px) {
      article h2 { font-size: 1.5rem; }
      article h3 { font-size: 1.15rem; }
      .container { padding: 24px 16px 60px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <nav class="header-nav">
      <a href="/" class="brand">Comedy Houston</a>
      <span class="sep">/</span>
      <a href="/blog/">Weekly Blog</a>
    </nav>
${inlineHeroHTML}

    <article>
${blogContent}
    </article>

    <div class="meta" style="margin-top: 24px;">
      Generated on ${generatedAt}
    </div>

    <footer class="footer">
      <p>
        <a href="/">Browse all shows</a> &middot;
        Powered by Comedy Houston &middot;
        Updated weekly
      </p>
    </footer>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Comedy Houston — Weekly Blog Post Generator ===");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log("");

  if (!OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY environment variable is not set.");
    process.exit(1);
  }

  // Load and filter events
  const { events, monday, sunday } = loadThisWeeksEvents();

  if (events.length === 0) {
    console.log("No events found for this week. Skipping blog generation.");
    process.exit(0);
  }

  const weekRange = formatWeekRange(monday, sunday);
  console.log(`Week range: ${weekRange}`);
  console.log("");

  // Ensure blog directory exists
  if (!fs.existsSync(BLOG_DIR)) {
    fs.mkdirSync(BLOG_DIR, { recursive: true });
  }

  // Step 1: Identify top comedians
  console.log("Identifying top comedians...");
  let topComedianNames = [];

  try {
    const topComediansRaw = await identifyTopComedians(events);
    // Parse JSON from the response (handle potential markdown wrapping)
    const jsonStr = topComediansRaw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const topComedians = JSON.parse(jsonStr);
    topComedianNames = topComedians.map((c) => c.name).slice(0, 5);
    console.log(`Top comedians identified: ${topComedianNames.join(", ")}`);
    console.log("");
  } catch (err) {
    console.warn(`Warning: Could not identify top comedians: ${err.message}`);
    console.log("");
  }

  // Step 2: Research comedians via web search
  let comedianResearch = "";
  if (topComedianNames.length > 0) {
    console.log("Researching comedians via web search...");
    try {
      comedianResearch = await researchComedians(topComedianNames);
      console.log("Comedian research completed.");
      console.log("");
    } catch (err) {
      console.warn(`Warning: Comedian research failed: ${err.message}`);
      console.warn("Continuing without web research.");
      console.log("");
    }
  }

  // Step 3: Generate hero creative HTML (replaces DALL-E)
  let inlineHeroHTML = "";
  if (topComedianNames.length > 0) {
    const heroHTML = generateHeroCreativeHTML(topComedianNames, weekRange);
    fs.writeFileSync(BLOG_HERO_HTML_PATH, heroHTML);
    console.log(`Wrote hero creative HTML: ${BLOG_HERO_HTML_PATH}`);
    inlineHeroHTML = generateInlineHeroHTML(topComedianNames, weekRange);
    console.log("");
  }

  // Step 4: Generate the blog post (with research context)
  const prompt = buildPrompt(events, weekRange, comedianResearch);
  console.log(`Sending ${events.length} events to OpenAI (${OPENAI_MODEL})...`);

  const blogContent = await callOpenAI(prompt, SYSTEM_PROMPT);
  console.log("Blog post generated successfully.");
  console.log("");

  // Write the HTML file
  const generatedAt = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const html = wrapInHTML(blogContent, weekRange, generatedAt, inlineHeroHTML);
  fs.writeFileSync(BLOG_HTML_PATH, html);
  console.log(`Wrote ${BLOG_HTML_PATH}`);
  console.log("");
  console.log("Done!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
