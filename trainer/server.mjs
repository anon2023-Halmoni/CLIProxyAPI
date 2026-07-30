// Clinical Reasoning Trainer — single-process server.
//   node trainer/server.mjs        (default port 8787)
//
// Serves the PWA, exposes the session API, streams tutor turns as
// NDJSON, and runs the background job worker in-process. The events
// table is canonical; the interactive path never waits on
// classification (spec §7).

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  db,
  uuid,
  now,
  appendEvent,
  sessionEvents,
  seedCases,
  getCase,
  enqueueJob,
  claimJob,
  completeJob,
  failJob,
  recordUsage,
} from "./lib/db.mjs";
import { streamChat } from "./lib/glm.mjs";
import { TUTOR_SYSTEM_PROMPT, caseFileMessage } from "./lib/prompts.mjs";
import { selectCases } from "./lib/select.mjs";
import { processSession } from "./lib/classify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TRAINER_PORT || 8787);
const AUTH_KEY = process.env.TRAINER_KEY || "";
const CASES_PER_SESSION = Number(process.env.TRAINER_CASES_PER_SESSION || 4);

const seeded = seedCases();
if (seeded) console.log(`seeded ${seeded} cases`);

// ---------------------------------------------------------------- sessions
// In-memory live state, rebuildable from events (event sourcing).

const live = new Map(); // sessionId -> {messages, plan, idx, answered, presentedAt}

function requireLive(sessionId) {
  if (live.has(sessionId)) return live.get(sessionId);
  // Rebuild from events after a restart.
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  if (!session || session.ended_at) return null;
  const events = sessionEvents(sessionId);
  const planEvent = events.find((e) => e.type === "session_started");
  if (!planEvent) return null;
  const plan = planEvent.payload.plan.map((p) => ({
    ...p,
    case: getCase(p.caseId),
  }));
  const state = { messages: [{ role: "system", content: TUTOR_SYSTEM_PROMPT }], plan, idx: -1, answered: false, presentedAt: null };
  for (const e of events) {
    if (e.type === "case_presented") {
      const p = plan.find((x) => x.caseId === e.payload.case_id);
      state.idx = plan.indexOf(p);
      state.answered = false;
      state.messages.push({ role: "user", content: caseFileMessage(p.case, p.directive, p.timeLimitSeconds) });
      state.messages.push({ role: "assistant", content: e.payload.text });
    }
    if (e.type === "answer_submitted" || e.type === "probe_answered") {
      if (e.type === "answer_submitted") state.answered = true;
      state.messages.push({ role: "user", content: e.payload.text + (e.payload.latency_ms ? `\n\n[response latency: ${(e.payload.latency_ms / 1000).toFixed(1)}s]` : "") });
    }
    if (e.type === "feedback_given") state.messages.push({ role: "assistant", content: e.payload.text });
  }
  live.set(sessionId, state);
  return state;
}

// ---------------------------------------------------------------- worker

async function runJob(job) {
  if (job.type === "classify_session") {
    const result = await processSession(job.payload.sessionId);
    console.log(`classified session ${job.payload.sessionId}:`, result);
  } else {
    throw new Error(`unknown job type ${job.type}`);
  }
}

let workerBusy = false;
setInterval(async () => {
  if (workerBusy) return;
  const job = claimJob();
  if (!job) return;
  workerBusy = true;
  try {
    await runJob(job);
    completeJob(job.id);
  } catch (e) {
    console.error(`job ${job.id} (${job.type}) failed:`, e.message);
    failJob(job, e);
  } finally {
    workerBusy = false;
  }
}, 2000);

// ---------------------------------------------------------------- helpers

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function ndjsonStart(res) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
}

async function streamTutorTurn(res, sessionId, state, kind) {
  ndjsonStart(res);
  let full = "";
  try {
    const { content, usage } = await streamChat(state.messages, {
      maxTokens: 3072,
      onDelta: ({ type, text }) => {
        if (type === "content") res.write(JSON.stringify({ type: "content", text }) + "\n");
      },
    });
    full = content;
    recordUsage(sessionId, "tutor", process.env.GLM_MODEL || "glm-5.2", usage);
  } catch (e) {
    res.write(JSON.stringify({ type: "error", message: String(e.message) }) + "\n");
    res.end();
    return null;
  }
  state.messages.push({ role: "assistant", content: full });
  const current = state.plan[state.idx];
  appendEvent(sessionId, kind, { case_id: current?.caseId ?? null, text: full });
  res.write(
    JSON.stringify({
      type: "done",
      kind,
      caseIndex: state.idx,
      caseCount: state.plan.length,
      timeLimitSeconds: current?.timeLimitSeconds ?? null,
    }) + "\n",
  );
  res.end();
  return full;
}

function presentNextCase(state) {
  state.idx += 1;
  state.answered = false;
  if (state.idx >= state.plan.length) return false;
  const p = state.plan[state.idx];
  state.messages.push({ role: "user", content: caseFileMessage(p.case, p.directive, p.timeLimitSeconds) });
  return true;
}

// ---------------------------------------------------------------- routes

async function handleApi(req, res, url) {
  const path = url.pathname;

  if (path === "/api/session/start" && req.method === "POST") {
    const body = await readBody(req);
    const selections = selectCases(Number(body.cases) || CASES_PER_SESSION);
    if (selections.length === 0) return json(res, 500, { error: "no cases available" });
    const sessionId = uuid();
    db.prepare("INSERT INTO sessions (id, started_at, mode) VALUES (?, ?, ?)").run(sessionId, now(), body.mode || "viva");
    const plan = selections.map((s) => ({
      caseId: s.case.id,
      missType: s.missType,
      directive: s.directive,
      timeLimitSeconds: s.timeLimitSeconds,
    }));
    appendEvent(sessionId, "session_started", { plan, mode: body.mode || "viva" });
    live.set(sessionId, {
      messages: [{ role: "system", content: TUTOR_SYSTEM_PROMPT }],
      plan: plan.map((p, i) => ({ ...p, case: selections[i].case })),
      idx: -1,
      answered: false,
    });
    return json(res, 200, { sessionId, caseCount: plan.length });
  }

  const turnMatch = path.match(/^\/api\/session\/([0-9a-f-]+)\/(turn|next|end|transcript)$/);
  if (turnMatch) {
    const [, sessionId, action] = turnMatch;
    const state = requireLive(sessionId);

    if (action === "transcript" && req.method === "GET") {
      const events = sessionEvents(sessionId).filter((e) =>
        ["case_presented", "answer_submitted", "probe_answered", "feedback_given"].includes(e.type),
      );
      const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
      const current = state?.plan?.[state.idx];
      return json(res, 200, {
        ended: !!session?.ended_at,
        caseIndex: state?.idx ?? null,
        caseCount: state?.plan?.length ?? null,
        answered: state?.answered ?? null,
        timeLimitSeconds: current?.timeLimitSeconds ?? null,
        events: events.map((e) => ({ type: e.type, payload: e.payload })),
      });
    }

    if (!state) return json(res, 404, { error: "session not found or already ended" });

    if (action === "next" && req.method === "POST") {
      if (!presentNextCase(state)) {
        return json(res, 200, { finished: true });
      }
      return streamTutorTurn(res, sessionId, state, "case_presented");
    }

    if (action === "turn" && req.method === "POST") {
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) return json(res, 400, { error: "empty message" });
      const current = state.plan[state.idx];
      if (!current) return json(res, 400, { error: "no active case — call /next first" });

      if (!state.answered) {
        const latencyMs = Number(body.latency_ms) || null;
        const late = latencyMs != null && latencyMs > current.timeLimitSeconds * 1000;
        state.answered = true;
        const attemptId = uuid();
        db.prepare(
          "INSERT INTO attempts (id, session_id, case_id, answer_text, latency_ms, hedged) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(attemptId, sessionId, current.caseId, text, latencyMs, 0);
        appendEvent(sessionId, "answer_submitted", { case_id: current.caseId, text, latency_ms: latencyMs, late, attempt_id: attemptId });
        state.messages.push({
          role: "user",
          content: text + (latencyMs ? `\n\n[response latency: ${(latencyMs / 1000).toFixed(1)}s${late ? " — OVER the time limit" : ""}]` : ""),
        });
      } else {
        appendEvent(sessionId, "probe_answered", { case_id: current.caseId, text });
        state.messages.push({ role: "user", content: text });
      }
      return streamTutorTurn(res, sessionId, state, "feedback_given");
    }

    if (action === "end" && req.method === "POST") {
      db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(now(), sessionId);
      appendEvent(sessionId, "session_ended", {});
      enqueueJob("classify_session", { sessionId });
      live.delete(sessionId);
      return json(res, 200, { ok: true, queued: "classify_session" });
    }
  }

  if (path === "/api/state" && req.method === "GET") {
    const due = db
      .prepare("SELECT concept_id, miss_type, misses, attempts, next_due FROM mastery WHERE next_due <= ? ORDER BY next_due LIMIT 20")
      .all(now());
    const mastery = db
      .prepare("SELECT concept_id, miss_type, attempts, misses, next_due FROM mastery ORDER BY concept_id, miss_type")
      .all();
    const brief = db.prepare("SELECT * FROM briefs ORDER BY created_at DESC LIMIT 1").get();
    const deadLetters = db.prepare("SELECT COUNT(*) AS n FROM dead_letters WHERE resolved = 0").get().n;
    const pendingJobs = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')").get().n;
    const cardsTotal = db.prepare("SELECT COUNT(*) AS n FROM cards").get().n;
    const cardsUnexported = db.prepare("SELECT COUNT(*) AS n FROM cards WHERE exported_at IS NULL").get().n;
    const sessions = db
      .prepare("SELECT id, started_at, ended_at, processed_at FROM sessions ORDER BY started_at DESC LIMIT 10")
      .all();
    const usage = db
      .prepare("SELECT COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion FROM usage")
      .get();
    return json(res, 200, { due, mastery, brief, deadLetters, pendingJobs, cardsTotal, cardsUnexported, sessions, usage });
  }

  if (path === "/api/cards/export.tsv" && req.method === "GET") {
    const cards = db.prepare("SELECT * FROM cards WHERE exported_at IS NULL").all();
    const tsv = cards
      .map((c) => `${c.front.replaceAll(/[\t\n]/g, " ")}\t${c.back.replaceAll(/[\t\n]/g, " ")}`)
      .join("\n");
    db.prepare("UPDATE cards SET exported_at = ? WHERE exported_at IS NULL").run(now());
    res.writeHead(200, {
      "Content-Type": "text/tab-separated-values",
      "Content-Disposition": 'attachment; filename="clinical-reasoning-cards.tsv"',
    });
    return res.end(tsv);
  }

  if (path === "/api/cards/anki-push" && req.method === "POST") {
    const cards = db.prepare("SELECT * FROM cards WHERE exported_at IS NULL").all();
    if (cards.length === 0) return json(res, 200, { pushed: 0 });
    try {
      const resp = await fetch(process.env.ANKI_CONNECT_URL || "http://127.0.0.1:8765", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "addNotes",
          version: 6,
          params: {
            notes: cards.map((c) => ({
              deckName: process.env.ANKI_DECK || "Clinical Reasoning",
              modelName: "Basic",
              fields: { Front: c.front, Back: c.back },
              options: { allowDuplicate: false },
              tags: ["clinical-reasoning-trainer"],
            })),
          },
        }),
      });
      const result = await resp.json();
      if (result.error) return json(res, 502, { error: result.error });
      db.prepare("UPDATE cards SET exported_at = ? WHERE exported_at IS NULL").run(now());
      return json(res, 200, { pushed: cards.length });
    } catch (e) {
      return json(res, 502, { error: `AnkiConnect unreachable: ${e.message}. Is Anki open with the AnkiConnect add-on?` });
    }
  }

  return json(res, 404, { error: "not found" });
}

// ---------------------------------------------------------------- static

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = resolve(here, "public", rel);
  if (!file.startsWith(resolve(here, "public")) || !existsSync(file)) {
    res.writeHead(404);
    return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      if (AUTH_KEY && req.headers["x-trainer-key"] !== AUTH_KEY) {
        return json(res, 401, { error: "unauthorised — set X-Trainer-Key header" });
      }
      return await handleApi(req, res, url);
    }
    return serveStatic(res, url.pathname);
  } catch (e) {
    console.error(`${req.method} ${url.pathname} failed:`, e);
    if (!res.headersSent) json(res, 500, { error: String(e.message) });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Clinical Reasoning Trainer running at http://localhost:${PORT}`);
  if (AUTH_KEY) console.log("auth: TRAINER_KEY required");
});
