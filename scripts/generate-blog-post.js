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
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const OUTPUT_DIR = path.resolve(__dirname, "..");
const EVENTS_JSON_PATH = path.join(OUTPUT_DIR, "events.json");
const BLOG_DIR = path.join(OUTPUT_DIR, "blog");
const BLOG_HTML_PATH = path.join(BLOG_DIR, "index.html");

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
      max_tokens: 4000,
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
// Build the prompt
// ---------------------------------------------------------------------------

function buildPrompt(events, weekRange) {
  const eventList = events
    .map((ev) => {
      const parts = [`- **${ev.name}**`];
      parts.push(`  Venue: ${ev.venue}`);
      parts.push(`  Date: ${formatDateForDisplay(ev.date)}`);
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
          ev.description.length > 200
            ? ev.description.slice(0, 200) + "..."
            : ev.description;
        parts.push(`  Description: ${desc}`);
      }
      if (ev.ticket_url) parts.push(`  Tickets: ${ev.ticket_url}`);
      return parts.join("\n");
    })
    .join("\n\n");

  return `Write a blog post about Houston comedy shows for the week of ${weekRange}.

Here are the ${events.length} events happening this week:

${eventList}

Requirements:
- Write in a fun, engaging, conversational tone that makes people excited to go out and laugh
- Group events by day of the week (Monday, Tuesday, etc.)
- For each event, mention the show name, venue, time, and price if available
- Include ticket links as hyperlinks where available
- If there are notable headliners or special events, highlight them
- Start with a brief intro paragraph about the Houston comedy scene this week
- End with a short outro encouraging people to get tickets early
- Output ONLY the blog post content in HTML (just the article body — no <html>, <head>, or <body> tags)
- Use semantic HTML: <h2> for the title, <h3> for day headings, <p> for paragraphs, <a> for links
- Keep it concise but informative — aim for a 2-3 minute read`;
}

const SYSTEM_PROMPT = `You are a Houston comedy scene blogger. You write weekly roundup posts for ComedyHouston.com that help locals find the best comedy shows each week. Your tone is enthusiastic but not over-the-top, knowledgeable about the Houston comedy scene and its venues (Houston Improv, The Riot, The Secret Group, etc.), and practical — you always include dates, times, prices, and ticket links so readers can take action. You write in clean, semantic HTML.`;

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function wrapInHTML(blogContent, weekRange, generatedAt) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>This Week in Houston Comedy — ${weekRange}</title>
  <meta name="description" content="Your weekly roundup of every comedy show in Houston for ${weekRange}. Find shows at Houston Improv, The Riot, The Secret Group, and more.">
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

  // Build prompt and call OpenAI
  const prompt = buildPrompt(events, weekRange);
  console.log(`Sending ${events.length} events to OpenAI (${OPENAI_MODEL})...`);

  const blogContent = await callOpenAI(prompt, SYSTEM_PROMPT);
  console.log("Blog post generated successfully.");
  console.log("");

  // Ensure blog directory exists
  if (!fs.existsSync(BLOG_DIR)) {
    fs.mkdirSync(BLOG_DIR, { recursive: true });
  }

  // Write the HTML file
  const generatedAt = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const html = wrapInHTML(blogContent, weekRange, generatedAt);
  fs.writeFileSync(BLOG_HTML_PATH, html);
  console.log(`Wrote ${BLOG_HTML_PATH}`);
  console.log("");
  console.log("Done!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
