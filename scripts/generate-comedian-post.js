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
const http = require("http");

// Shared image pipeline — single source of truth for URL blocklists,
// HEAD validation, real-dimension parsing, and the inverted preference
// rule that keeps the event image as the floor. See
// scripts/lib/image-utils.js for the full rationale.
const imageUtils = require("./lib/image-utils");
const {
  findBestHeadshot,
  evaluateHeadshotCandidate,
  pickDisplayImage,
  isUsableImageUrl,
} = imageUtils;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

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
// Two-stage headshot finder — now lives in scripts/lib/image-utils.js
//   Stage A: OpenAI finds candidate pages (official site, bio, press)
//   Stage B: Shared lib fetches pages, extracts image URLs, runs the
//            strict-gate pipeline (URL blocklist + HEAD + real-dimensions
//            + aspect ratio) and returns only candidates that beat the
//            event image as a quality floor.
// ---------------------------------------------------------------------------

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
  "recent_hook": {
    "summary": "",
    "quote": "",
    "source_publication": "",
    "source_url": "",
    "date": ""
  },
  "instagram_handle": "",
  "notable_bits_or_quotes": [],
  "unverifiable_claims_to_avoid": [],
  "background_story": "",
  "headshot_page_urls": [],
  "source_urls": [
    {"label": "Wikipedia", "url": ""},
    {"label": "Netflix special page or IMDB", "url": ""},
    {"label": "Notable interview or article", "url": ""},
    {"label": "Podcast episode or appearance", "url": ""}
  ]
}

For recent_hook: This is the SINGLE MOST IMPORTANT field. Find the freshest piece of news about this comedian — ideally from the last 90 days, no older than 12 months. A new tour announcement, a recent podcast/interview, an album, a Netflix release, a public comment, a project in development. Include a real verbatim quote if you can find one, with the publication name, URL, and date. If you cannot find anything from the last 12 months, leave it null — do NOT pad with old material. The blog post will be built around this hook, so it must be specific and recent.

For unverifiable_claims_to_avoid: List any "facts" you encountered during research that appeared in low-quality sources, fan wikis, or AI-generated summaries that you could NOT independently verify (e.g. "supposedly appeared in X show"). The writer will be told to never use these.

For headshot_page_urls: Find 2-4 web pages that are likely to contain a clean, professional headshot or portrait photo of this comedian. Our code will fetch these pages and extract the actual image. Prioritize in this order:
  1. The comedian's official website (especially /bio, /about, /press, or homepage)
  2. Their Wikipedia page (if they have one)
  3. A press/media/EPK page
  4. A profile page on a major platform (IMDB, comedy club bio page)
Return the full page URLs as an array of strings. Do NOT try to return direct image file URLs — just the pages where a photo is likely to exist. If no relevant pages are found, leave as an empty array [].

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

  const systemPrompt = `You are a working comedy writer whose byline appears in Vulture, The New Yorker's Talk of the Town, and the LA Times Calendar section. You write about comedians the way a fellow obsessive does — with specific references, dry confidence, and zero hype. You trust the reader. You never explain that something is funny; you describe what the comic actually does and let it land.

VOICE ANCHOR — match this register:
"Russell Brand is one of those comedians who, despite selling out theaters all over the world and starring in several films throughout the past decade, I have simply not paid much attention to. Brand often seemed to me too smug, self-referential, and, quite frankly, stupid to ever give him the benefit of the doubt. However, in the last few months, I've slowly come around to him. In April, Brand appeared on Norm MacDonald's video podcast Norm Macdonald Live, and I found that his lascivious, free-love persona contrasted well against MacDonald's particular brand of sexual repression. Like a kind of glammed up Trojan horse, he sneaks past our defenses and enlightens and entertains while pontificating on the news of the day."

Notice what that paragraph does: a real opinion, a specific recent appearance with a real co-host, an unexpected adjective ("lascivious"), one good metaphor (not three), and zero throat-clearing. That is the bar.`;

  const prompt = `Write a 400-word blog post about a comedian's upcoming live show. 400 words is a HARD CEILING. Tighter is fine. Padding is not.

INPUT DATA:
Comedian: ${comedianName}
Venue: ${venue}
City: ${city}
Date: ${formatDateForDisplay(date)}
Time: ${timeStr}
Price: ${priceStr}
Ticket URL: ${ticketUrl}
${imageUrl ? `Image URL: ${imageUrl}` : ""}

VERIFIED RESEARCH (THIS IS YOUR ONLY SOURCE OF FACTS — anything not here is forbidden):
${research}

ABSOLUTE FACT RULES:
- You may ONLY state facts that appear explicitly in the research above. Not "reasonable inferences." Not "well-known background." Only what is in the JSON.
- If the research has a "recent_hook" with content, the post MUST be built around it. Lead with the hook. It is the reason this specific show in ${formatDateForDisplay(date)} matters.
- If a credit, special, TV show, or quote is not in the research, it does not exist. Do not mention it.
- Anything in "unverifiable_claims_to_avoid" is poison. Never reference it.
- NEVER output the literal token "[VERIFY]" or any bracketed editor's note. The published post must read as final. If you are not sure about something, just leave it out. Silence is better than a flag.
- NEVER paraphrase or reconstruct quotes. A quote may only appear if it is verbatim from "notable_bits_or_quotes" or "recent_hook.quote".

TITLE (critical — this drives both clicks AND search rankings):
Write an <h1> tag with a headline that a Variety or Vulture editor would approve.
SEO REQUIREMENTS — the title MUST contain ALL THREE of these:
  1. The comedian's full name (exactly as provided)
  2. The venue name
  3. The word "Houston"
These are non-negotiable for long-tail search. Someone will Google "${comedianName} Houston" or "${comedianName} ${venue}" and this title must match.

CREATIVE REQUIREMENTS — the title must also:
- Be specific to THIS comedian — it should not work for any other performer
- Reference something concrete: a special title, a signature bit, a career moment, a cultural reference
- NEVER use the pattern "[Name] Brings [X] to [City/Venue]" — this is the #1 banned title format
- NEVER use "Brings," "Takes the Stage," "Comes to," "Heads to," "Hits," or "Lands at"
- Instead, try structures like:
  • "The Quiet Precision of Sam Tallent, Live at Punch Line Houston"
  • "After 'Running the Light,' Sam Tallent Returns to Punch Line Houston"
  • "Why Matthew Broussard's Math-Comedy Works — See for Yourself at The Gordy in Houston"
  • "Isabel Hagen's Viola and Punchlines: A Night at The Riot Houston"
  • "Shawn Gardini: Philadelphia's Best-Kept Comedy Secret at The Gordy Houston"

OPENING (first paragraph):
Do NOT start with the comedian's name. Start with a scene, a detail, a quote from their material, a cultural observation, or a specific moment from their career. Pull the reader into the world of this comedian before naming them. Think of how a New Yorker profile opens — obliquely, with texture, then sharpens into focus.

BODY:
- Weave credentials (specials, TV, podcasts) into narrative, not a resume list
- Describe their comedy style using specific, sensory language. Not "sharp wit" but how the wit actually manifests — the timing, the structure, the targets, the surprises
- If the research mentions specific bits, quotes, or material — use them. A real detail from a set is worth ten adjectives.
- Include what the live show offers that a special doesn't — intimacy, improvisation, the unpredictable moments
- Weave in date, venue, time, price naturally — embedded in the narrative, not a separate info block

CTA: One short closing sentence. No hype. Point to tickets.

SIGN-OFF — End the post with this exact HTML (do not modify):
<div class="post-footer">
  <p>For more Houston comedy shows, visit <a href="https://comedyhouston.com">ComedyHouston.com</a> — updated twice daily with every show in the city.</p>
  <p>Have a question or want to list your show? <a href="https://comedyhouston.com/contact/">Contact us</a>.</p>
</div>

SOURCE LINKS:
The research includes "source_urls" with verified URLs. Weave 3-4 as natural hyperlinks — link special titles to IMDB/Netflix, background to Wikipedia, interviews to their source. Natural anchor text, never "click here." Do NOT invent URLs.

BANNED PHRASES:
"Don't miss" / "Must-see" / "Get ready" / "Side-splitting" / "Rib-tickling" / "Comedic genius" / "Laugh-out-loud" / "Hilarity ensues" / "A night of laughs" / "Known for his/her unique style" / "Comedy fans will love" / "Brings his/her [X] to [Y]" / "Takes the stage" / "Sharp wit" / "Razor-sharp" / "Boundary-pushing" / "Unapologetic" / "Unfiltered" / "Raw and honest" / "In a world where..." / Any sentence that could apply to any comedian without changes

BANNED STRUCTURES (these are LLM tells — instant rejection):
- "X isn't just Y, it's Z" (and any "not just/but also" variant)
- Opening with weather, atmosphere, "the air crackles," "in the dim glow," "under the lights," or any scene-setting that doesn't reference THIS comedian
- Closing with "boundaries blur," "shared experience," "the magic of live comedy," or any abstract reassurance
- Rhetorical questions ("How does he do it?")
- Metaphor stacking — pick ONE metaphor for the whole post or none. No "scalpel + canvas + mirror."
- Tricolons (three-item lists like "sharp, smart, and surprising")
- The word "scalpel." Ever. It is the LLM's favorite comedy implement and a giveaway.
- Any sentence whose structure is "abstract claim, abstract elaboration, abstract reassurance"
- A standalone CTA paragraph at the end ("Don't miss your chance...")

STYLE:
- No exclamation points, no emojis
- Vary sentence length dramatically — a three-word sentence after a long one creates rhythm. Read it back in your head.
- Maximum 2 uses of the comedian's full name; use last name or pronouns after
- At least 3 concrete, verifiable details from the research, ideally one per paragraph
- Every paragraph must contain at least one specific noun (a real credit, a venue detail, a year, a publication name, a tour name) — no all-abstract paragraphs
- Confident omission: if you don't have enough material for 400 words, write 320. Do not stretch.
- The reader should feel the writer has an actual opinion, not a press release

OUTPUT: Return ONLY the HTML blog post content. Use semantic HTML: <h1> for the SEO title, <p> for paragraphs. No <html>/<head>/<body> wrapper. Include a single <a class="ticket-link" href="${ticketUrl}">Get Tickets</a> link in the CTA paragraph.`;

  return callOpenAI(prompt, systemPrompt, 0.6);
}

// ---------------------------------------------------------------------------
// Step 3: Fact-check / editorial pass
// ---------------------------------------------------------------------------

function factCheckPost(research, draft) {
  const systemPrompt = `You are a senior editorial fact-checker at a major publication. Your job is to compare a draft article against verified source research and silently remove anything that is not supported. You are ruthless about accuracy. The output you produce is FINAL and will be published as-is to WordPress with no human review. You never add content, only subtract or lightly rephrase for flow.`;

  const prompt = `RESEARCH DATA:
${research}

DRAFT ARTICLE:
${draft}

Review this article against the research data. For each claim:
1. If it appears in the research data → keep it
2. If it is NOT in the research and cannot be verified → REMOVE the entire sentence and lightly stitch the surrounding sentences for flow

Also remove:
- Any generic sentence that could describe any comedian (e.g., "audiences are in for a treat")
- Any adjective not backed by a specific reference
- Any fabricated quotes or bit descriptions not in the research
- Any of these banned phrases: "don't miss," "must-see," "side-splitting," "comedic genius," "hilarity ensues," "get ready," "a night of laughs"
- Any rhetorical question, any "isn't just X, it's Y" construction, any closing CTA paragraph

CRITICAL — THIS IS THE FINAL VERSION:
- The output goes straight to WordPress. There is NO human review.
- NEVER emit "[VERIFY]", "[CHECK]", "[CITATION NEEDED]", "[TODO]", or any bracketed editor's note. If something is shaky, just delete it. Silence > flag.
- Do not leave editor's comments, parenthetical asides to the writer, or self-references.
- The post should read as a finished, confident piece by a working journalist.

IMPORTANT:
- Do not add new content. Only subtract or lightly rephrase for flow after removing sentences.
- Keep the HTML structure intact. Return the cleaned HTML.
- PRESERVE all hyperlinks (<a href="...">) that link to real source URLs.
- PRESERVE the <div class="post-footer"> section at the end exactly as-is.`;

  return callOpenAI(prompt, systemPrompt, 0.2);
}

// ---------------------------------------------------------------------------
// Step 4: Polish pass — voice & rhythm critique, no new facts
// ---------------------------------------------------------------------------

function polishPost(draft) {
  const systemPrompt = `You are a copy chief at a respected magazine. You take a fact-checked draft and tighten it for voice, rhythm, and specificity. You never add facts. You aggressively cut LLM-tells. The version you return is the version that publishes — no flags, no notes.`;

  const prompt = `Here is a fact-checked draft. Score it silently against this rubric, then return ONLY the rewritten HTML:

RUBRIC (do not output, just apply):
- Specificity: every paragraph has at least one concrete noun
- Rhythm: short sentences mixed with long
- Voice: confident, dry, opinionated, not press-release
- No LLM tells: no "isn't just X it's Y," no rhetorical questions, no metaphor stacking, no scalpel/canvas/mirror, no "in a world where," no closing reassurance
- Length: 400 words MAX in the body. Cut the weakest paragraph entirely if over.

REWRITE RULES:
- Do NOT add any new facts, names, credits, quotes, or claims. You can only cut and rearrange existing content.
- Keep the <h1> title.
- Keep all <a href="..."> hyperlinks pointing to real sources.
- Keep the <div class="post-footer"> at the end exactly as-is.
- NEVER emit "[VERIFY]" or any bracketed editor's note. This is the final version.
- Return ONLY the HTML. No preamble, no explanation, no scoring.

DRAFT:
${draft}`;

  return callOpenAI(prompt, systemPrompt, 0.5);
}

// Final safety net: strip any [VERIFY]-style editor markers that slipped through
function stripEditorMarkers(html) {
  if (!html) return html;
  // Remove tokens like [VERIFY], [VERIFY date], [CHECK], [CITATION NEEDED], [TODO ...]
  let cleaned = html.replace(/\s*\[(?:VERIFY|CHECK|CITATION NEEDED|TODO|CONFIRM|FACT[- ]?CHECK)[^\]]*\]/gi, "");
  // Collapse any double spaces created by the removal
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
  return cleaned;
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

  // --- Size-specific layout tuning ---
  // Square: tight crop, text fills bottom third
  // Portrait: more breathing room, slight pullback
  // Story: full vertical, photo top 55%, details fill bottom
  const config = {
    square: {
      photoHeight: "68%",
      gradientHeight: "55%",
      objectPosition: "center 20%",
      nameFontSize: "80px",
      dateFontSize: "36px",
      venueFontSize: "29px",
      brandFontSize: "20px",
      bottomPadding: "48px",
      sidePadding: "56px",
      accentWidth: "52px",
      accentHeight: "4px",
    },
    portrait: {
      photoHeight: "62%",
      gradientHeight: "52%",
      objectPosition: "center 15%",
      nameFontSize: "84px",
      dateFontSize: "38px",
      venueFontSize: "31px",
      brandFontSize: "20px",
      bottomPadding: "56px",
      sidePadding: "56px",
      accentWidth: "52px",
      accentHeight: "4px",
    },
    story: {
      photoHeight: "55%",
      gradientHeight: "55%",
      objectPosition: "center 15%",
      nameFontSize: "88px",
      dateFontSize: "40px",
      venueFontSize: "33px",
      brandFontSize: "22px",
      bottomPadding: "64px",
      sidePadding: "60px",
      accentWidth: "56px",
      accentHeight: "5px",
    },
  };
  const c = config[size];

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
      height: ${c.photoHeight};
      object-fit: cover;
      object-position: ${c.objectPosition};
    }
    .gradient {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      height: ${c.gradientHeight};
      background: linear-gradient(
        to bottom,
        rgba(10, 10, 15, 0) 0%,
        rgba(10, 10, 15, 0.55) 30%,
        rgba(10, 10, 15, 0.88) 55%,
        rgba(10, 10, 15, 1) 75%
      );
    }
    .content {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      padding: 0 ${c.sidePadding} ${c.bottomPadding};
      z-index: 2;
    }
    .accent-line {
      width: ${c.accentWidth};
      height: ${c.accentHeight};
      background: #ff4d6a;
      margin-bottom: 20px;
    }
    .name {
      font-size: ${c.nameFontSize};
      font-weight: 900;
      color: #ffffff;
      letter-spacing: -0.03em;
      line-height: 1.05;
      margin-bottom: 16px;
      text-shadow: 0 2px 20px rgba(0, 0, 0, 0.5);
    }
    .date {
      font-size: ${c.dateFontSize};
      font-weight: 700;
      color: rgba(255, 255, 255, 0.95);
      line-height: 1.3;
      margin-bottom: 6px;
    }
    .venue {
      font-size: ${c.venueFontSize};
      font-weight: 500;
      color: rgba(255, 255, 255, 0.7);
      line-height: 1.3;
      margin-bottom: 24px;
    }
    .brand {
      font-size: ${c.brandFontSize};
      font-weight: 700;
      letter-spacing: 3px;
      color: #ff4d6a;
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
    <div class="date">${safeDate}</div>
    <div class="venue">${safeVenue}</div>
    <div class="brand">COMEDYHOUSTON.COM</div>
  </div>
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

/**
 * Build the "Also performing in Houston this week" internal-linking section.
 * Pure templating off the manifest — no LLM call. Run as a second pass after
 * all comedian posts are generated so each post can link to the others.
 *
 * SEO purpose: every per-comedian page becomes part of a topical cluster
 * instead of an island. Google uses internal links as the #1 signal for
 * crawl priority and topical authority on a young site.
 */
function buildAlsoThisWeekSection(currentSlug, allPosts) {
  const others = allPosts.filter((p) => p.slug !== currentSlug);
  if (others.length === 0) return "";

  const items = others
    .map((p) => {
      const url = p.wpLink || `https://comedyhouston.com/${p.slug}/`;
      const dateLabel = formatDateForDisplay(p.date);
      return `    <li><a href="${escapeHTML(url)}"><strong>${escapeHTML(p.comedianName)}</strong></a> — ${escapeHTML(p.venue)}, ${escapeHTML(dateLabel)}</li>`;
    })
    .join("\n");

  return `
<hr />
<h3>Also performing in Houston this week</h3>
<p>If you're already booking your weekend, here's the rest of this week's headliners:</p>
<ul>
${items}
</ul>
<p><a href="https://comedyhouston.com/this-week/"><strong>See the full weekly roundup →</strong></a></p>
`;
}

function wrapInHTML(blogContent, comedianName, venue, date, generatedAt, imageUrl, ticketUrl) {
  const title = `${comedianName} at ${venue} — ${formatDateForDisplay(date)} | Houston Comedy`;
  const description = `${comedianName} performs live at ${venue} in Houston, TX on ${formatDateForDisplay(date)}. Get show details, comedian background, and ticket info at ComedyHouston.com.`;

  // JSON-LD structured data for search engine rich snippets.
  // @graph with both Person and ComedyEvent so Google can build a knowledge
  // panel for the comedian AND show the event in event-rich-result carousels
  // for local intent queries like "comedy houston this weekend".
  const personNode = {
    "@type": "Person",
    "name": comedianName,
    "jobTitle": "Comedian",
    ...(imageUrl ? { "image": imageUrl } : {}),
  };
  const eventNode = {
    "@type": "ComedyEvent",
    "name": `${comedianName} Live at ${venue}`,
    "description": description,
    "startDate": date,
    "eventStatus": "https://schema.org/EventScheduled",
    "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
    "location": {
      "@type": "Place",
      "name": venue,
      "address": { "@type": "PostalAddress", "addressLocality": "Houston", "addressRegion": "TX", "addressCountry": "US" }
    },
    "performer": { "@type": "Person", "name": comedianName },
    ...(imageUrl ? { "image": imageUrl } : {}),
    ...(ticketUrl ? { "offers": { "@type": "Offer", "url": ticketUrl, "availability": "https://schema.org/InStock", "priceCurrency": "USD" } } : {}),
  };
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [personNode, eventNode],
  });

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
  <meta property="og:site_name" content="Comedy Houston">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="https://comedyhouston.com/${escapeHTML(comedianName.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}">
  <script type="application/ld+json">${jsonLd}</script>
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
          // Surface as much detail as possible — status, a relevant subset of
          // headers, and the first 1500 chars of the body. This makes it
          // possible to tell apart "WP rejected the credentials" (401 with a
          // rest_not_logged_in code) from "Hostinger/LiteSpeed blocked us"
          // (401/403 with HTML body, no JSON code) from "WP rejected the
          // payload" (400 with rest_invalid_param) from rate-limiting (429).
          const relevantHeaders = {
            "content-type": res.headers["content-type"],
            "www-authenticate": res.headers["www-authenticate"],
            "x-litespeed-cache": res.headers["x-litespeed-cache"],
            "cf-ray": res.headers["cf-ray"],
            server: res.headers["server"],
          };
          return reject(
            new Error(
              `WordPress API ${res.statusCode} ${method} ${urlPath} | ` +
              `headers=${JSON.stringify(relevantHeaders)} | ` +
              `body=${data.slice(0, 1500)}`
            )
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

/**
 * Preflight WordPress auth check. Calls /wp-json/wp/v2/users/me once before
 * we start publishing posts. If the credentials, IP, or host firewall are
 * broken, we want to find out *now* with a loud, specific error — not after
 * silently writing 25 posts to GitHub Pages only.
 *
 * Returns true on success, false on failure (caller decides whether to
 * proceed). On failure, the underlying detailed error is logged.
 */
async function wpPreflight() {
  console.log("Preflight: checking WordPress auth via /wp-json/wp/v2/users/me ...");
  try {
    const me = await wpRequest("GET", "/wp-json/wp/v2/users/me?context=edit", null);
    console.log(`  WP auth OK — authenticated as "${me.name}" (id=${me.id}, slug=${me.slug})`);
    return true;
  } catch (err) {
    console.error("  WP PREFLIGHT FAILED — publishing will be skipped this run.");
    console.error(`  ${err.message}`);
    console.error("  Common causes:");
    console.error("    • WP_APP_PASSWORD secret in GitHub is stale (regenerate in WP → Users → Application Passwords)");
    console.error("    • WP_APP_USER does not match the user the password belongs to");
    console.error("    • Hostinger / LiteSpeed / security plugin is blocking the GitHub Actions runner IP (check hPanel security logs)");
    console.error("    • LiteSpeed Cache is stripping the Authorization header (exclude /wp-json/ from cache)");
    return false;
  }
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

  // If a per-comedian post with this slug already exists (e.g. the workflow
  // is being re-run on the same Monday), update it in place instead of
  // creating a duplicate. WordPress's REST API does NOT dedupe by slug — it
  // would auto-suffix the new slug to "...-2" and leave the old post live,
  // breaking SEO and any social links that already point at the original.
  // (Mirrors the fix applied to the weekly roundup in f6dabb1.)
  let existingPost = null;
  try {
    const found = await wpRequest(
      "GET",
      `/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&status=publish,draft,future,private`,
      null
    );
    if (Array.isArray(found) && found.length > 0) {
      existingPost = found[0];
    }
  } catch (err) {
    console.warn(`    Slug lookup failed (will create new post): ${err.message}`);
  }

  let post;
  if (existingPost) {
    console.log(`    Existing post found (ID ${existingPost.id}) — updating in place.`);
    post = await wpRequest("POST", `/wp-json/wp/v2/posts/${existingPost.id}`, postData);
    console.log(`    Updated: ${post.link}`);
  } else {
    post = await wpRequest("POST", "/wp-json/wp/v2/posts", postData);
    console.log(`    Published: ${post.link}`);
  }
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

  // Preflight WordPress auth once, up front. If it fails, we still generate
  // posts to GitHub Pages but we skip publishing — and the failure reason is
  // logged loudly so it's the first thing visible in the workflow log.
  let wpReady = WP_ENABLED;
  if (WP_ENABLED) {
    wpReady = await wpPreflight();
    if (!wpReady) {
      console.warn("WordPress publishing DISABLED for this run due to preflight failure.\n");
    }
  }

  // Ensure output directory exists
  if (!fs.existsSync(COMEDIANS_DIR)) {
    fs.mkdirSync(COMEDIANS_DIR, { recursive: true });
  }

  // Clean up previous run's generated files (images, captions, email files)
  // This prevents stale content from being emailed or committed
  console.log("Cleaning up previous run's files...");
  const imagesDir = path.join(COMEDIANS_DIR, "images");
  if (fs.existsSync(imagesDir)) {
    const oldFiles = fs.readdirSync(imagesDir);
    for (const f of oldFiles) {
      fs.unlinkSync(path.join(imagesDir, f));
    }
    console.log(`  Removed ${oldFiles.length} old file(s) from blog/comedians/images/`);
  }
  // Remove old caption files
  const oldCaptions = fs.readdirSync(COMEDIANS_DIR).filter((f) => f.endsWith("-caption.txt"));
  for (const f of oldCaptions) {
    fs.unlinkSync(path.join(COMEDIANS_DIR, f));
  }
  if (oldCaptions.length > 0) console.log(`  Removed ${oldCaptions.length} old caption file(s)`);
  // Remove old email files
  for (const f of ["email-subject.txt", "email-body.txt"]) {
    const p = path.join(COMEDIANS_DIR, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  console.log("");

  // Step 0: Identify headliners
  console.log("Step 0: Identifying headliners...");
  let headliners = [];

  // Prefer the handoff file written by generate-blog-post.js earlier on
  // Monday — this guarantees the weekly roundup and the per-comedian posts
  // cover the exact same comedians (and saves one OpenAI call).
  const handoffPath = path.join(__dirname, "..", "blog", "top-comedians.json");
  if (fs.existsSync(handoffPath)) {
    try {
      const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
      if (
        handoff &&
        handoff.week_range === weekRange &&
        Array.isArray(handoff.comedians) &&
        handoff.comedians.length > 0
      ) {
        headliners = handoff.comedians.slice(0, 5);
        console.log(
          `Using ${headliners.length} headliner(s) from blog handoff: ${headliners.map((c) => c.name).join(", ")}`
        );
        console.log("");
      } else {
        console.log("Handoff file exists but week_range doesn't match — falling back to OpenAI.");
      }
    } catch (e) {
      console.warn(`Could not read handoff file: ${e.message}`);
    }
  }

  if (headliners.length > 0) {
    // Skip the OpenAI call entirely; headliners came from the handoff.
  } else
  try {
    const raw = await identifyTopComedians(events);
    const jsonStr = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    try {
      headliners = JSON.parse(jsonStr);
    } catch (parseErr) {
      // OpenAI sometimes wraps or prefixes the JSON with prose. Fall back to
      // extracting the first top-level JSON array before giving up.
      console.warn(`  JSON parse failed: ${parseErr.message}. Attempting array extraction…`);
      const match = jsonStr.match(/\[[\s\S]*\]/);
      if (!match) throw parseErr;
      headliners = JSON.parse(match[0]);
    }
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
    const eventImageUrl = matchedEvent.image_url || "";
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

    // Image selection (inverted preference):
    //
    //   1. Event image (Ticketmaster/Eventbrite) is the FLOOR.
    //   2. If the blog-post handoff already picked a displayImage for this
    //      comedian via the strict gate, reuse it — no re-scrape, guaranteed
    //      visual consistency with the weekly hero.
    //   3. Otherwise try to upgrade via headshot scrape + strict gate.
    //
    // graphicImageUrl = what we render into the Instagram graphics (square,
    // portrait, story). It MUST be an http URL, not a data URI, because the
    // headless screenshot reads it over HTTP.
    let graphicImageUrl = eventImageUrl;

    // Look up the pre-validated handoff pick (if any) for this headliner.
    const handoffPick = (headliner.displayImage && !headliner.displayImage.startsWith("data:"))
      ? headliner.displayImage
      : null;
    if (handoffPick) {
      console.log(`  Handoff: using pre-validated displayImage (source=${headliner.imageSource || "unknown"}).`);
      graphicImageUrl = handoffPick;
    } else {
      // Fall back to scraping. This path runs when the comedian was
      // identified by generate-comedian-post.js's own OpenAI call (no
      // handoff file, or a week_range mismatch). Reuse the shared
      // strict-gate pipeline — same quality bar as the weekly hero.
      try {
        const cleanResearch = research.replace(/^```json\s*\n?/i, "").replace(/\n?```\s*$/g, "").trim();
        const researchObj = JSON.parse(cleanResearch);
        const pageUrls = researchObj.headshot_page_urls || [];
        if (pageUrls.length > 0) {
          console.log(`  Found ${pageUrls.length} candidate page(s) — running strict-gate headshot scrape...`);
          const headshot = await findBestHeadshot(pageUrls, headliner.name);
          if (headshot) {
            console.log(`  Strict-gate accepted scraped headshot: ${headshot}`);
            graphicImageUrl = headshot;
          } else {
            console.log("  No scraped candidate beat the strict gate — keeping event image.");
          }
        } else {
          console.log("  No headshot candidate pages in research — keeping event image.");
        }
      } catch (_) {
        console.log("  Could not parse research for headshot pages — keeping event image.");
      }
    }

    // Final safety: if whatever we ended up with is an obvious placeholder
    // URL or fails the URL-shape check, drop back to the event image. This
    // mirrors the hero policy: event image is the floor, never falls below.
    if (!graphicImageUrl || !isUsableImageUrl(graphicImageUrl)) {
      graphicImageUrl = eventImageUrl;
    }

    // Step 2: Write the blog post
    console.log("  Step 2: Writing blog post...");
    let draft = "";
    try {
      draft = await writeBlogPost(
        headliner.name, venue, "Houston, TX", date, time, price, ticketUrl, eventImageUrl, research
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

    // Step 4: Polish pass — voice, rhythm, length (no new facts)
    console.log("  Step 4: Polish pass...");
    try {
      const polished = await polishPost(finalContent);
      const cleanedPolish = polished.replace(/^```html\s*\n?/i, "").replace(/\n?```\s*$/g, "").trim();
      if (cleanedPolish && cleanedPolish.length > 200) {
        finalContent = cleanedPolish;
        console.log("  Polish complete.");
      } else {
        console.warn("  Polish output too short — keeping fact-checked draft.");
      }
    } catch (err) {
      console.warn(`  Polish failed: ${err.message}. Using fact-checked draft.`);
    }

    // Final safety net: strip any [VERIFY]/editor markers that slipped through.
    // The published post must have NO bracketed editor flags.
    finalContent = stripEditorMarkers(finalContent);

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
    const html = wrapInHTML(finalContent, headliner.name, venue, date, generatedAt, eventImageUrl, ticketUrl);

    // Write file to GitHub Pages
    const filePath = path.join(COMEDIANS_DIR, filename);
    fs.writeFileSync(filePath, html);
    console.log(`  Wrote: blog/comedians/${filename}`);

    // Step 4: Generate Instagram graphics (3 sizes)
    console.log("  Step 4: Generating Instagram graphic templates...");
    let graphicFiles = [];
    try {
      graphicFiles = writeComedianGraphics(headliner.name, venue, date, graphicImageUrl, postSlug);
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
      const cleanRes = research.replace(/^```json\s*\n?/i, "").replace(/\n?```\s*$/g, "").trim();
      const researchObj = JSON.parse(cleanRes);
      instagramHandle = researchObj.instagram_handle || "";
    } catch (_) {
      // Research wasn't valid JSON or didn't have handle — that's fine
    }
    // Normalize handle to always be "@name" so the LLM can't emit it bare
    // (bare handles break the poster's user_tags extraction, so the
    // comedian never gets tagged in the IG photo).
    if (instagramHandle) {
      instagramHandle = "@" + instagramHandle.replace(/^@+/, "").trim();
      if (instagramHandle === "@") instagramHandle = "";
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

    // Publish to WordPress if configured AND preflight passed
    if (wpReady) {
      try {
        wpLink = await publishToWordPress(
          headliner.name, venue, date, postSlug, finalContent, eventImageUrl
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
      imageUrl: eventImageUrl,
      graphicImageUrl: graphicImageUrl,
      ticketUrl: ticketUrl,
      slug: postSlug,
      wpLink: wpLink,
      caption: caption,
      instagramHandle: instagramHandle, // "@name" or "" — poster uses this to tag the comedian in the IG photo
      graphicFiles: graphicFiles.map((gf) => gf.pngFile),
      // Stash the post body and metadata so the second pass below can append
      // the internal-linking section and re-publish without re-running the
      // 4-call OpenAI pipeline.
      _finalContent: finalContent,
      _generatedAt: generatedAt,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Second pass: internal linking ("Also performing this week" footer block)
  // ─────────────────────────────────────────────────────────────────────────
  // Now that every comedian post has been written and (optionally) published,
  // we know all the slugs and WP URLs. Walk the manifest a second time and
  // append a cross-link section to each post pointing at the OTHER comedians
  // this week. Re-write the GitHub Pages HTML and re-publish to WordPress
  // (slug-dedupe handles the in-place update).
  if (generatedPosts.length > 1) {
    console.log("");
    console.log("━━━ Second pass: adding internal links between comedian posts ━━━");
    for (const post of generatedPosts) {
      try {
        const linkSection = buildAlsoThisWeekSection(post.slug, generatedPosts);
        const linkedContent = post._finalContent + linkSection;

        // Rewrite GitHub Pages HTML
        const linkedHtml = wrapInHTML(
          linkedContent,
          post.comedianName,
          post.venue,
          post.date,
          post._generatedAt,
          post.imageUrl,
          post.ticketUrl
        );
        fs.writeFileSync(path.join(COMEDIANS_DIR, post.filename), linkedHtml);

        // Re-publish to WordPress (slug-dedupe will UPDATE the existing post
        // in place — no -2 suffixed duplicate). Skip if WP isn't ready or
        // the first publish never created a post.
        if (wpReady && post.wpLink) {
          await publishToWordPress(
            post.comedianName, post.venue, post.date, post.slug, linkedContent, post.imageUrl
          );
        }
        console.log(`  Linked: ${post.comedianName}`);
      } catch (err) {
        console.warn(`  Internal link pass failed for ${post.comedianName}: ${err.message}`);
      }
    }
    console.log("");
  }

  // Strip the internal-only fields before they hit manifest.json
  for (const post of generatedPosts) {
    delete post._finalContent;
    delete post._generatedAt;
  }

  // Generate index page
  if (generatedPosts.length > 0) {
    const indexHTML = generateComediansIndex(generatedPosts);
    fs.writeFileSync(path.join(COMEDIANS_DIR, "index.html"), indexHTML);
    console.log(`Wrote: blog/comedians/index.html`);

    // Write manifest JSON (used by Phase 2 WordPress publishing)
    // `manifest_version` is a monotonic stamp that changes every time this
    // script runs — the IG poster uses it to detect mid-week manifest
    // regeneration and prune state entries whose slugs no longer exist.
    const manifest = {
      generated_at: new Date().toISOString(),
      manifest_version: Date.now(),
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

  // ─────────────────────────────────────────────────────────────────────────
  // Sitemap generation — write sitemap.xml at repo root.
  // Submitting this to Google Search Console once means new comedian posts
  // get crawled within days instead of weeks. The sitemap is regenerated on
  // every comedian-posts run so it always reflects the current week.
  // ─────────────────────────────────────────────────────────────────────────
  if (generatedPosts.length > 0) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const baseUrl = "https://comedyhouston.com";
      const urls = [
        { loc: `${baseUrl}/`, priority: "1.0", changefreq: "daily" },
        { loc: `${baseUrl}/this-week/`, priority: "0.9", changefreq: "weekly" },
      ];
      for (const post of generatedPosts) {
        const url = post.wpLink || `${baseUrl}/${post.slug}/`;
        urls.push({ loc: url, priority: "0.8", changefreq: "weekly" });
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`
  )
  .join("\n")}
</urlset>
`;
      fs.writeFileSync(path.join(OUTPUT_DIR, "sitemap.xml"), xml);
      console.log(`Wrote: sitemap.xml (${urls.length} URLs)`);
    } catch (err) {
      console.warn(`Sitemap generation failed: ${err.message}`);
    }
  }

  console.log("");
  console.log(`Done. Generated ${generatedPosts.length} comedian post(s).`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
