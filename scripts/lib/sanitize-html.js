/**
 * Minimal HTML sanitizer for AI-generated blog post bodies.
 *
 * Zero dependencies — the rest of the pipeline keeps npm out of the hot path,
 * and pulling in `sanitize-html` (+ htmlparser2 + dom-serializer + …) to scrub
 * four LLM calls a week is overkill for a 400-visit/mo project. A regex pass
 * that strips the specific injection shapes OpenAI might produce is enough.
 *
 * What this catches:
 *   - <script>…</script> blocks (any case, any attribute)
 *   - <iframe>, <object>, <embed>, <link>, <style> tags
 *   - on* event-handler attributes (onclick, onerror, onload, …)
 *   - javascript: / data: / vbscript: URLs in href/src
 *   - stray HTML comments (<!--…-->), which occasionally smuggle editor notes
 *
 * What this does NOT do:
 *   - Parse/balance the DOM. If the model emits an unclosed <p>, we pass it
 *     through. Browsers recover gracefully from that; they do NOT recover
 *     gracefully from a <script> tag.
 *   - Block URLs to arbitrary external hosts. The AI is supposed to link to
 *     Wikipedia/IMDB/Netflix/YouTube; a host allowlist here would break that.
 *
 * Returns `{ html, removed }` — removed is a list of short diagnostic strings
 * describing anything stripped, so the caller can fail loudly / log in CI.
 */

const DANGEROUS_TAGS = [
  "script",
  "iframe",
  "object",
  "embed",
  "link",
  "style",
  "meta",
  "base",
  "form",
  "input",
  "button",
  "textarea",
];

function sanitizeAiHtml(input) {
  if (typeof input !== "string") {
    return { html: "", removed: ["non-string input"] };
  }

  let html = input;
  const removed = [];

  // 1. Strip full dangerous-tag blocks (open + content + close). Non-greedy
  //    so we don't eat the whole document if there's a second <script> later.
  for (const tag of DANGEROUS_TAGS) {
    const blockRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    const selfClosingRe = new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi");
    const before = html;
    html = html.replace(blockRe, "");
    html = html.replace(selfClosingRe, "");
    if (html !== before) removed.push(`<${tag}>`);
  }

  // 2. Strip on* event-handler attributes. Match attribute with either
  //    single-, double-, or unquoted value.
  const onAttrRe = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
  if (onAttrRe.test(html)) {
    removed.push("on*= handler");
    html = html.replace(onAttrRe, "");
  }

  // 3. Neutralize javascript:/data:/vbscript: URLs inside href/src attributes.
  //    Replace the scheme with "#removed:" so the link still parses as an
  //    anchor but points nowhere. Better than deleting the whole <a>, which
  //    would leave orphaned link text.
  const badSchemeRe = /(href|src)\s*=\s*(["'])\s*(?:javascript|data|vbscript):[^"']*\2/gi;
  if (badSchemeRe.test(html)) {
    removed.push("javascript:/data:/vbscript: URL");
    html = html.replace(badSchemeRe, '$1=$2#removed$2');
  }

  // 4. Strip HTML comments. The final-pass regex already removes [VERIFY] /
  //    [CHECK] bracket markers; this catches the variant where the model
  //    wraps editor notes in <!-- … --> so humans can't see them.
  const commentRe = /<!--[\s\S]*?-->/g;
  if (commentRe.test(html)) {
    removed.push("HTML comment");
    html = html.replace(commentRe, "");
  }

  return { html, removed };
}

/**
 * Stamp rel="sponsored nofollow noopener" + target="_blank" on monetized
 * outbound ticket links in AI-generated post bodies. The LLM prompt asks for
 * <a class="ticket-link"> but never reliably emits rel attributes, and Google
 * requires sponsored/nofollow on paid affiliate links. Matches by class OR by
 * known ticket-vendor host, and replaces any rel/target already present.
 */
const TICKET_HOST_RE = /(?:ticketmaster|livenation|eventbrite|ticketweb|axs|frontgatetickets)\./i;

function addSponsoredRelToTicketLinks(html) {
  if (typeof html !== "string" || html === "") return html;
  return html.replace(/<a\b([^>]*)>/gi, (match, attrs) => {
    const hrefMatch = attrs.match(/href\s*=\s*"([^"]*)"/i);
    const isTicketLink =
      /class\s*=\s*"[^"]*\bticket-link\b[^"]*"/i.test(attrs) ||
      (hrefMatch && TICKET_HOST_RE.test(hrefMatch[1]));
    if (!isTicketLink) return match;
    const cleaned = attrs
      .replace(/\s+rel\s*=\s*"[^"]*"/gi, "")
      .replace(/\s+target\s*=\s*"[^"]*"/gi, "")
      .replace(/\s+$/, "");
    return `<a${cleaned} target="_blank" rel="sponsored nofollow noopener">`;
  });
}

module.exports = { sanitizeAiHtml, addSponsoredRelToTicketLinks };
