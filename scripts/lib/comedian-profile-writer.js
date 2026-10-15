/**
 * Comedy Houston — the evergreen comedian profile, three OpenAI passes.
 *
 * Replaces the per-show "spotlight" article. A spotlight sold one date and
 * was deleted the week after; a profile is the body of /comedians/{slug}/
 * and has to still read true a year later, when the comedian is back for a
 * different show at a different club. So the prose carries NO show
 * logistics (date, venue, time, price, ticket link): the page renders those
 * live from events.json through the plugin's performer shortcode. The prose
 * is who the comedian is, what they have done, what they do on stage, and
 * the freshest verified news, dated explicitly so it ages honestly.
 *
 * Voice, fact rules and banned LLM tells are carried over from the spotlight
 * prompts; the fact-check and polish passes are the same editors with the
 * show-facts clauses removed.
 */

"use strict";

const openai = require("./openai");

function chat(prompt, systemPrompt, temperature) {
  return openai.chatCompletion({
    system: systemPrompt,
    user: prompt,
    temperature: temperature !== undefined ? temperature : 0.7,
    maxTokens: 8000,
    effort: "low",
  });
}

const VOICE_SYSTEM = `You are a working comedy writer whose byline appears in Vulture, The New Yorker's Talk of the Town, and the LA Times Calendar section. You write about comedians the way a fellow obsessive does — with specific references, dry confidence, and zero hype. You trust the reader. You never explain that something is funny; you describe what the comic actually does and let it land.

VOICE ANCHOR — match this register:
"Russell Brand is one of those comedians who, despite selling out theaters all over the world and starring in several films throughout the past decade, I have simply not paid much attention to. Brand often seemed to me too smug, self-referential, and, quite frankly, stupid to ever give him the benefit of the doubt. However, in the last few months, I've slowly come around to him. In April, Brand appeared on Norm MacDonald's video podcast Norm Macdonald Live, and I found that his lascivious, free-love persona contrasted well against MacDonald's particular brand of sexual repression. Like a kind of glammed up Trojan horse, he sneaks past our defenses and enlightens and entertains while pontificating on the news of the day."

Notice what that paragraph does: a real opinion, a specific recent appearance with a real co-host, an unexpected adjective ("lascivious"), one good metaphor (not three), and zero throat-clearing. That is the bar.`;

/**
 * @param {string} stageName   the name as it appears on the ticket and in
 *                             search ("Dave Chappelle", never the research's
 *                             "David Khari Webber Chappelle")
 * @param {string} research    the research JSON from the web-search call
 * @param {object} houston     { pastShows: [{date, venue}], upcomingVenues: [..] }
 */
function writeProfile(stageName, research, houston = {}) {
  const past = (houston.pastShows || [])
    .map((s) => `${s.venue} (${s.date})`)
    .join("; ");
  const prompt = `Write a 350-word evergreen profile of a comedian for a Houston comedy listings site. 400 words is a HARD CEILING. Tighter is fine. Padding is not.

THE COMEDIAN'S NAME (use EXACTLY this spelling, every time): ${stageName}
This is the stage name people search for and the name on the ticket. The research below may give a longer legal or birth name. NEVER use that form anywhere in the text. If you mention a birth name at all, it is one parenthetical aside, once, and the stage name still comes first.

VERIFIED RESEARCH (THIS IS YOUR ONLY SOURCE OF FACTS — anything not here is forbidden):
${research}

VERIFIED HOUSTON HISTORY (from our own listings; you may mention it in one sentence, or skip it):
${past || "No past Houston dates on record."}

WHAT THIS PAGE IS:
- It lives at a permanent URL ("${stageName} in Houston") and is shown every time this comedian plays Houston, this year and next. The page's show dates, venue, time, price and tickets are rendered by the site automatically ABOVE your text and update themselves.
- So your text must contain NO show logistics: no date, no venue name for an upcoming show, no time, no price, no "tonight", "this weekend", "this Friday", "next month", "upcoming", "returns to Houston on". Nothing that is only true for one show. It must still read correctly a year from now.
- Any news or recent event you mention MUST carry its month and year in the sentence ("In September 2026, ...", "a 2025 special"), never "recently", "this year", "last month" or "new".

ABSOLUTE FACT RULES:
- You may ONLY state facts that appear explicitly in the research above. Not "reasonable inferences." Not "well-known background." Only what is in the JSON.
- If the research has a "recent_hook" with content, lead with it (dated, see above). If it is empty, lead with the most specific career fact you have.
- If a credit, special, TV show, or quote is not in the research, it does not exist. Do not mention it.
- Anything in "unverifiable_claims_to_avoid" is poison. Never reference it.
- NEVER output the literal token "[VERIFY]" or any bracketed editor's note. If you are not sure about something, leave it out. Silence is better than a flag.
- NEVER paraphrase or reconstruct quotes. A quote may only appear if it is verbatim from "notable_bits_or_quotes" or "recent_hook.quote".

STRUCTURE:
- Paragraph 1: do NOT start with the comedian's name. Open on a detail, a quote from their material, a dated recent moment, or a specific career fact, then name them.
- Body: weave credentials (specials, TV, podcasts) into narrative, not a resume list. Describe their comedy style using specific, sensory language: timing, structure, targets, surprises. If the research has specific bits or quotes, use them. A real detail from a set is worth ten adjectives.
- One short paragraph on what the live show offers that a special doesn't (intimacy, crowd work, new material), written generally, not tied to one date.
- Optionally one sentence of Houston history from the verified list ("played Punch Line Houston in 2025").
- End on an opinion, not a call to action. No "get tickets", no "don't miss", no link.

SOURCE LINKS:
The research includes "source_urls" with verified URLs. Weave 2-4 as natural hyperlinks — link special titles to IMDB/Netflix, background to Wikipedia, interviews to their source. Natural anchor text, never "click here." Do NOT invent URLs.

BANNED PHRASES:
"Don't miss" / "Must-see" / "Get ready" / "Side-splitting" / "Rib-tickling" / "Comedic genius" / "Laugh-out-loud" / "Hilarity ensues" / "A night of laughs" / "Known for his/her unique style" / "Comedy fans will love" / "Brings his/her [X] to [Y]" / "Takes the stage" / "Sharp wit" / "Razor-sharp" / "Boundary-pushing" / "Unapologetic" / "Unfiltered" / "Raw and honest" / "In a world where..." / Any sentence that could apply to any comedian without changes

BANNED STRUCTURES (these are LLM tells — instant rejection):
- "X isn't just Y, it's Z" (and any "not just/but also" variant)
- Opening with weather, atmosphere, "the air crackles," "in the dim glow," "under the lights," or any scene-setting that doesn't reference THIS comedian
- Closing with "boundaries blur," "shared experience," "the magic of live comedy," or any abstract reassurance
- Rhetorical questions ("How does he do it?")
- Metaphor stacking — pick ONE metaphor for the whole piece or none. No "scalpel + canvas + mirror."
- Tricolons (three-item lists like "sharp, smart, and surprising")
- The word "scalpel." Ever.
- Any sentence whose structure is "abstract claim, abstract elaboration, abstract reassurance"

STYLE:
- No exclamation points, no emojis, no em dashes (use a comma, a period or a colon instead)
- Vary sentence length dramatically
- Maximum 2 uses of the comedian's full stage name; use last name or pronouns after
- At least 3 concrete, verifiable details from the research, ideally one per paragraph
- Every paragraph must contain at least one specific noun (a real credit, a year, a publication name, a tour name)
- Confident omission: if you don't have enough material for 350 words, write 250. Do not stretch.

OUTPUT: Return ONLY the HTML body: <p> paragraphs, optionally ONE <h2> subheading. No <h1>, no title, no <html>/<head>/<body> wrapper, no footer, no ticket link.`;

  return chat(prompt, VOICE_SYSTEM, 0.6);
}

function factCheckProfile(research, draft, stageName) {
  const systemPrompt = `You are a senior editorial fact-checker at a major publication. Your job is to compare a draft against verified source research and silently remove anything that is not supported. You are ruthless about accuracy. The output you produce is FINAL and will be published as-is with no human review. You never add content, only subtract or lightly rephrase for flow.`;

  const prompt = `RESEARCH DATA:
${research}

DRAFT (an evergreen profile of ${stageName}; the site renders show dates and tickets separately, so the text must contain none):
${draft}

Review this draft against the research data. For each claim:
1. If it appears in the research data → keep it
2. If it is NOT in the research and cannot be verified → REMOVE the entire sentence and lightly stitch the surrounding sentences for flow

Also remove:
- Any show logistics: a specific upcoming date, an upcoming venue, a time, a price, a ticket link, "tonight", "this weekend", "upcoming", "returns to Houston on". (A dated PAST Houston show from the verified Houston history list may stay.)
- Any undated "recently" / "this year" / "new" claim: if a date (month and year, or year) is in the research, insert it; if not, remove the sentence.
- Any use of a legal or birth name in place of "${stageName}" — replace it with the stage name.
- Any generic sentence that could describe any comedian (e.g., "audiences are in for a treat")
- Any adjective not backed by a specific reference
- Any fabricated quotes or bit descriptions not in the research
- Any of these banned phrases: "don't miss," "must-see," "side-splitting," "comedic genius," "hilarity ensues," "get ready," "a night of laughs"
- Any rhetorical question, any "isn't just X, it's Y" construction, any hype-only closing paragraph, any call to action
- Em dashes: replace each with a comma, a period or a colon.

CRITICAL — THIS IS THE FINAL VERSION:
- The output is published with NO human review.
- NEVER emit "[VERIFY]", "[CHECK]", "[CITATION NEEDED]", "[TODO]", or any bracketed editor's note. If something is shaky, just delete it. Silence > flag.
- Do not leave editor's comments, parenthetical asides to the writer, or self-references.

IMPORTANT:
- Do not add new content. Only subtract or lightly rephrase for flow after removing sentences.
- Keep the HTML structure intact (<p>, optional <h2>, <a href>). Return the cleaned HTML only.
- PRESERVE all hyperlinks (<a href="...">) that link to real source URLs.`;

  return chat(prompt, systemPrompt, 0.2);
}

function polishProfile(draft, stageName) {
  const systemPrompt = `You are a copy chief at a respected magazine. You take a fact-checked draft and tighten it for voice, rhythm, and specificity. You never add facts. You aggressively cut LLM-tells. The version you return is the version that publishes — no flags, no notes.`;

  const prompt = `Here is a fact-checked evergreen profile of ${stageName}. Score it silently against this rubric, then return ONLY the rewritten HTML:

RUBRIC (do not output, just apply):
- Specificity: every paragraph has at least one concrete noun
- Rhythm: short sentences mixed with long
- Voice: confident, dry, opinionated, not press-release
- No LLM tells: no "isn't just X it's Y," no rhetorical questions, no metaphor stacking, no scalpel/canvas/mirror, no "in a world where," no closing reassurance, no em dashes
- Evergreen: nothing that is only true for one show date; every news item carries its month/year
- Length: 400 words MAX. Cut the weakest paragraph entirely if over.

REWRITE RULES:
- Do NOT add any new facts, names, credits, quotes, or claims. You can only cut and rearrange existing content.
- The comedian is "${stageName}" (that exact spelling) wherever the name appears.
- Keep all <a href="..."> hyperlinks pointing to real sources.
- Keep the HTML structure: <p> paragraphs and at most one <h2>. No <h1>, no footer, no links to tickets.
- NEVER emit "[VERIFY]" or any bracketed editor's note. This is the final version.
- Return ONLY the HTML. No preamble, no explanation, no scoring.

DRAFT:
${draft}`;

  return chat(prompt, systemPrompt, 0.5);
}

/** Final safety net for the bracketed editor markers the prompts forbid. */
function stripEditorMarkers(html) {
  if (!html) return html;
  return html
    .replace(/\s*\[(?:VERIFY|CHECK|CITATION NEEDED|TODO|CONFIRM|FACT[- ]?CHECK)[^\]]*\]/gi, "")
    .replace(/[ \t]{2,}/g, " ");
}

/** Reader-facing copy never carries an em dash (site rule). */
function stripEmDashes(html) {
  if (!html) return html;
  return html.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ",");
}

/** Strip any <h1> the model emitted despite instructions; the page has its own. */
function stripH1(html) {
  return String(html || "").replace(/<h1[^>]*>[\s\S]*?<\/h1>\s*/gi, "").trim();
}

module.exports = { writeProfile, factCheckProfile, polishProfile, stripEditorMarkers, stripEmDashes, stripH1 };
