// Minimal GLM (Z.ai) client for the Clinical Reasoning Trainer.
// Zero dependencies — plain fetch against the OpenAI-compatible endpoint.
//
// Env:
//   GLM_API_KEY   required
//   GLM_BASE_URL  optional, defaults to the coding-plan endpoint
//   GLM_MODEL     optional, defaults to glm-5.2

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Tiny .env loader so the demo runs without dotenv. Real deployment
// (Vercel/Supabase) injects env vars natively and skips this.
function loadDotEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, "..", ".env"), resolve(process.cwd(), ".env")]) {
    let text;
    try {
      text = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    break;
  }
}
loadDotEnv();

const BASE_URL = process.env.GLM_BASE_URL || "https://api.z.ai/api/coding/paas/v4";
const MODEL = process.env.GLM_MODEL || "glm-5.2";

function apiKey() {
  const key = process.env.GLM_API_KEY;
  if (!key) throw new Error("GLM_API_KEY is not set. Copy trainer/.env.example to trainer/.env and fill it in.");
  return key;
}

async function post(path, body, { stream = false } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GLM API ${res.status}: ${text.slice(0, 500)}`);
  }
  return res;
}

/**
 * Non-streaming chat completion. Thinking mode is on by default.
 * Returns { content, reasoning, usage, raw }.
 */
export async function chat(messages, { model = MODEL, thinking = true, maxTokens, temperature, responseFormat } = {}) {
  const body = {
    model,
    messages,
    thinking: { type: thinking ? "enabled" : "disabled" },
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (temperature !== undefined) body.temperature = temperature;
  if (responseFormat) body.response_format = responseFormat;

  const res = await post("/chat/completions", body);
  const json = await res.json();
  const msg = json.choices?.[0]?.message ?? {};
  return {
    content: msg.content ?? "",
    reasoning: msg.reasoning_content ?? "",
    usage: json.usage,
    raw: json,
  };
}

/**
 * Streaming chat completion. Thinking mode is on by default.
 * Calls onDelta({ type: "reasoning" | "content", text }) as tokens arrive.
 * Returns { content, reasoning, usage } once the stream ends.
 */
export async function streamChat(messages, { model = MODEL, thinking = true, maxTokens, temperature, onDelta } = {}) {
  const body = {
    model,
    messages,
    stream: true,
    thinking: { type: thinking ? "enabled" : "disabled" },
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (temperature !== undefined) body.temperature = temperature;

  const res = await post("/chat/completions", body, { stream: true });

  let content = "";
  let reasoning = "";
  let usage;
  let buffer = "";
  const decoder = new TextDecoder();

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.usage) usage = event.usage;
      const delta = event.choices?.[0]?.delta ?? {};
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onDelta?.({ type: "reasoning", text: delta.reasoning_content });
      }
      if (delta.content) {
        content += delta.content;
        onDelta?.({ type: "content", text: delta.content });
      }
    }
  }

  return { content, reasoning, usage };
}
