// Temporary: verify candidate models + parameter shapes. Deleted after use.
const https = require("https");
const key = process.env.OPENAI_API_KEY || "";
function req(path, body) {
  return new Promise((res, rej) => {
    const b = body ? JSON.stringify(body) : null;
    const r = https.request({ hostname: "api.openai.com", path, method: b ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}) } },
      (rs) => { let d = ""; rs.on("data", (c) => (d += c)); rs.on("end", () => res({ status: rs.statusCode, body: d })); });
    r.on("error", rej); if (b) r.write(b); r.end();
  });
}
(async () => {
  const m = await req("/v1/models");
  const all = (JSON.parse(m.body).data || []).map((x) => x.id).filter((x) => /^gpt-(4o|4\.1|5|6)/.test(x)).sort();
  console.log("models:", all.join(" "));
  const tests = [
    { model: "gpt-5.6-terra", messages: [{ role: "user", content: "Reply with the single word OK" }], max_completion_tokens: 200, reasoning_effort: "low", temperature: 0.6 },
    { model: "gpt-5.6-terra", messages: [{ role: "user", content: "Reply with the single word OK" }], max_completion_tokens: 200, reasoning_effort: "low" },
    { model: "gpt-5.6-terra", messages: [{ role: "user", content: "Reply with the single word OK" }], max_completion_tokens: 200, reasoning_effort: "none", temperature: 0.6 },
    { model: "gpt-5.6-luna", messages: [{ role: "user", content: "Reply with the single word OK" }], max_completion_tokens: 200, reasoning_effort: "none", response_format: { type: "json_object" } },
    { model: "gpt-5.6-luna", messages: [{ role: "user", content: "Return JSON {\"ok\":true}" }], max_completion_tokens: 200, reasoning_effort: "none", response_format: { type: "json_object" } },
  ];
  for (const body of tests) {
    const r = await req("/v1/chat/completions", body);
    let out = r.body;
    try { const p = JSON.parse(r.body); out = JSON.stringify({ content: p.choices && p.choices[0].message.content, usage: p.usage, error: p.error && p.error.message }); } catch (_) {}
    console.log(`chat ${body.model} effort=${body.reasoning_effort} temp=${body.temperature ?? "-"} rf=${body.response_format ? "json" : "-"} -> ${r.status} ${out.slice(0, 300)}`);
  }
  for (const body of [
    { model: "gpt-5.6-terra", input: "In one sentence: what is the most recent stand-up special by comedian Ali Siddiq? Cite the source URL.", tools: [{ type: "web_search" }], reasoning: { effort: "low" } },
    { model: "gpt-5.6-terra", input: "In one sentence: what is the most recent stand-up special by comedian Ali Siddiq? Cite the source URL.", tools: [{ type: "web_search_preview" }] },
  ]) {
    const r = await req("/v1/responses", body);
    let out = r.body;
    try { const p = JSON.parse(r.body); const txt = (p.output || []).filter((i) => i.type === "message").flatMap((i) => i.content).filter((c) => c.type === "output_text").map((c) => c.text).join(" "); out = JSON.stringify({ text: txt.slice(0, 200), usage: p.usage, error: p.error && p.error.message }); } catch (_) {}
    console.log(`responses ${body.model} tool=${body.tools[0].type} -> ${r.status} ${out.slice(0, 400)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
