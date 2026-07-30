// Clinical Reasoning Trainer — single-process server.
//   node trainer/server.mjs        (default port 8787)
//
// Serves the PWA, exposes the session API (NDJSON streaming), runs the
// background job worker, and — when TELEGRAM_BOT_TOKEN is set — the
// Telegram bot. The events table is canonical; the interactive path
// never waits on classification (spec §7).

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { db, now, seedCases, enqueueJob, claimJob, completeJob, failJob } from "./lib/db.mjs";
import { createSession, nextCase, userTurn, endSession, transcript } from "./lib/engine.mjs";
import { processSession } from "./lib/classify.mjs";
import { startTelegramBot } from "./lib/telegram.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TRAINER_PORT || 8787);
const AUTH_KEY = process.env.TRAINER_KEY || "";
const CASES_PER_SESSION = Number(process.env.TRAINER_CASES_PER_SESSION || 4);

const seeded = seedCases();
if (seeded) console.log(`seeded ${seeded} cases`);

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

async function streamTurn(res, turnPromiseFactory) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  try {
    const result = await turnPromiseFactory((text) =>
      res.write(JSON.stringify({ type: "content", text }) + "\n"),
    );
    if (result.finished) {
      res.write(JSON.stringify({ type: "done", finished: true }) + "\n");
    } else {
      res.write(
        JSON.stringify({
          type: "done",
          kind: result.kind,
          caseIndex: result.caseIndex,
          caseCount: result.caseCount,
          timeLimitSeconds: result.timeLimitSeconds,
        }) + "\n",
      );
    }
  } catch (e) {
    res.write(JSON.stringify({ type: "error", message: String(e.message) }) + "\n");
  }
  res.end();
}

// ---------------------------------------------------------------- routes

async function handleApi(req, res, url) {
  const path = url.pathname;

  if (path === "/api/session/start" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { sessionId, caseCount } = createSession(Number(body.cases) || CASES_PER_SESSION, body.mode || "viva");
      return json(res, 200, { sessionId, caseCount });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  const m = path.match(/^\/api\/session\/([0-9a-f-]+)\/(turn|next|end|transcript)$/);
  if (m) {
    const [, sessionId, action] = m;

    if (action === "transcript" && req.method === "GET") return json(res, 200, transcript(sessionId));

    if (action === "next" && req.method === "POST")
      return streamTurn(res, (onDelta) => nextCase(sessionId, onDelta));

    if (action === "turn" && req.method === "POST") {
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) return json(res, 400, { error: "empty message" });
      return streamTurn(res, (onDelta) => userTurn(sessionId, text, Number(body.latency_ms) || null, onDelta));
    }

    if (action === "end" && req.method === "POST") {
      endSession(sessionId);
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
  startTelegramBot();
});
