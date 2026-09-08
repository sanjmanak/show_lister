/**
 * Comedy Houston — shared OpenAI plumbing.
 *
 * One place for the request shape so every script (weekly post, comedian
 * spotlights, show-tag classifier) talks to the API the same way. Zero
 * npm dependencies.
 *
 * Model policy (Sept 2026 refresh):
 *   OPENAI_MODEL        content model — research, writing, fact-check,
 *                       polish, captions. Default gpt-5.6-terra
 *                       ($2 in / $12 out per 1M), the successor to gpt-4o
 *                       ($2.50 / $10) at roughly the same cost.
 *   OPENAI_MODEL_LIGHT  cheap model for bulk classification. Default
 *                       gpt-5.6-luna ($0.20 / $1.20).
 *
 * Both envs override the defaults, so a bad model day is a secrets/env
 * change rather than a code change.
 *
 * Parameter shape differs by family:
 *   gpt-5.x / gpt-6.x  reasoning models: `max_completion_tokens`,
 *                      `reasoning_effort` (we default to "low" for prose,
 *                      "none" for JSON classification), temperature is
 *                      passed through only when the caller asks for it.
 *   gpt-4o / gpt-4.1   legacy: `max_tokens` + `temperature`.
 *
 * Responses API (web search): reasoning models use the current
 * `web_search` tool; gpt-4o keeps the legacy `web_search_preview`.
 */

"use strict";

const https = require("https");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-terra";
const OPENAI_MODEL_LIGHT = process.env.OPENAI_MODEL_LIGHT || "gpt-5.6-luna";

const CHAT_TIMEOUT_MS = 120_000;
const RESPONSES_TIMEOUT_MS = 180_000;

function isReasoningModel(model) {
  return /^(gpt-5|gpt-6|o[1-9])/i.test(model || "");
}

function postJson(path, body, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    if (!OPENAI_API_KEY) return reject(new Error("OPENAI_API_KEY is not set"));
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "api.openai.com",
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`${label} error ${res.statusCode}: ${data.slice(0, 500)}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse ${label} response: ${e.message}`));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`${label} request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Chat completion. Returns the assistant message text.
 *
 * opts: { model, system, user, temperature, maxTokens, effort, jsonMode }
 *   - temperature is only sent when provided (reasoning models accept it,
 *     but the default is fine for prose and omitting it is safest).
 *   - effort: "none" | "low" | "medium" | "high" (reasoning models only).
 */
async function chatCompletion(opts) {
  const model = opts.model || OPENAI_MODEL;
  const body = {
    model,
    messages: [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: opts.user },
    ],
  };
  const maxTokens = opts.maxTokens || 8000;
  if (isReasoningModel(model)) {
    body.max_completion_tokens = maxTokens;
    body.reasoning_effort = opts.effort || "low";
    if (opts.temperature !== undefined && body.reasoning_effort === "none") {
      body.temperature = opts.temperature;
    }
  } else {
    body.max_tokens = maxTokens;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
  }
  if (opts.jsonMode) body.response_format = { type: "json_object" };

  const parsed = await postJson("/v1/chat/completions", body, CHAT_TIMEOUT_MS, "OpenAI API");
  const content = parsed.choices && parsed.choices[0] && parsed.choices[0].message
    ? parsed.choices[0].message.content
    : "";
  const usage = parsed.usage || {};
  console.log(
    `  OpenAI usage (${model}) — prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens}, total: ${usage.total_tokens}`
  );
  return content || "";
}

/**
 * Responses API call with web search enabled. Returns the output text.
 * opts: { model, instructions, input, effort }
 */
async function webResearch(opts) {
  const model = opts.model || OPENAI_MODEL;
  const reasoning = isReasoningModel(model);
  const body = {
    model,
    instructions: opts.instructions,
    input: opts.input,
    tools: [{ type: reasoning ? "web_search" : "web_search_preview" }],
  };
  if (reasoning) body.reasoning = { effort: opts.effort || "low" };

  const parsed = await postJson("/v1/responses", body, RESPONSES_TIMEOUT_MS, "OpenAI Responses API");
  const text = (parsed.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("\n");
  if (parsed.usage) {
    console.log(
      `  OpenAI Responses usage (${model}) — input: ${parsed.usage.input_tokens}, output: ${parsed.usage.output_tokens}, total: ${parsed.usage.total_tokens}`
    );
  }
  return text;
}

/** Strip ```json / ``` fences the model sometimes wraps around output. */
function stripFences(text) {
  return String(text || "")
    .replace(/^```[a-z]*\s*\n?/i, "")
    .replace(/\n?```\s*$/g, "")
    .trim();
}

module.exports = {
  OPENAI_API_KEY,
  OPENAI_MODEL,
  OPENAI_MODEL_LIGHT,
  isReasoningModel,
  chatCompletion,
  webResearch,
  stripFences,
};
