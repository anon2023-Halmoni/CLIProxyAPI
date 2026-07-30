// Session-end pipeline (spec §7.8): classify -> project mastery ->
// write cards -> write brief. Runs as one idempotent job; re-running
// for a session deletes and rewrites that session's misses in a
// transaction and never appends duplicates.

import { createHash } from "node:crypto";
import { db, uuid, now, sessionEvents, getCase, recordUsage } from "./db.mjs";
import { chat } from "./glm.mjs";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  classifierUserMessage,
  CARD_WRITER_SYSTEM_PROMPT,
  BRIEFER_SYSTEM_PROMPT,
} from "./prompts.mjs";

// Background work is latency-insensitive: use the strongest model with
// thinking ON (the tutor path runs thinking-off for time-to-first-token).
const HEAVY_MODEL = process.env.GLM_HEAVY_MODEL || "glm-5.2";

const MISS_TYPES = ["KNOWLEDGE_GAP", "CUE_FAILURE", "SALIENCE_FAILURE", "ANCHORING"];
const REMEDIATIONS = {
  KNOWLEDGE_GAP: "GENERATE_CARD",
  CUE_FAILURE: "RE_PRESENT_VARIED_SURFACE",
  SALIENCE_FAILURE: "SHORTEN_CLOCK_RUN_CONSEQUENCE",
  ANCHORING: "CONTRASTIVE_PAIR",
  NONE: "NONE",
};

// --- validation (§3.8: structured output or fail loudly) ---

export function validateMiss(obj, allowedConcepts) {
  const errors = [];
  if (typeof obj !== "object" || obj === null) return ["output is not a JSON object"];
  if (obj.miss_type === "NONE") return [];
  if (!MISS_TYPES.includes(obj.miss_type)) errors.push(`miss_type invalid: ${obj.miss_type}`);
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1)
    errors.push("confidence must be a number 0..1");
  if (!allowedConcepts.includes(obj.target_concept))
    errors.push(`target_concept "${obj.target_concept}" not in allowed list [${allowedConcepts.join(", ")}]`);
  if (obj.miss_type && REMEDIATIONS[obj.miss_type] && obj.remediation !== REMEDIATIONS[obj.miss_type])
    errors.push(`remediation must be ${REMEDIATIONS[obj.miss_type]} for ${obj.miss_type}`);
  if (typeof obj.evidence !== "string" || obj.evidence.length === 0)
    errors.push("evidence must be a non-empty quote");
  return errors;
}

function parseStrictJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

// --- classifier ---

async function classifyAttempt(sessionId, attempt, caseRow, transcript) {
  const messages = [
    { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
    { role: "user", content: classifierUserMessage(caseRow, attempt, transcript) },
  ];

  for (let round = 0; round < 2; round++) {
    const { content, usage, raw } = await chat(messages, { model: HEAVY_MODEL, thinking: true, maxTokens: 2048 });
    recordUsage(sessionId, "classifier", raw?.model, usage);
    let parsed, errors;
    try {
      parsed = parseStrictJson(content);
      errors = validateMiss(parsed, caseRow.concept_ids);
    } catch (e) {
      errors = [`invalid JSON: ${e.message}`];
    }
    if (errors.length === 0) return parsed;
    if (round === 0) {
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: `Your output failed validation: ${errors.join("; ")}. Output the corrected strict JSON object only.`,
      });
    } else {
      throw new Error(`classifier output failed validation after retry: ${errors.join("; ")}`);
    }
  }
}

function transcriptForCase(events, caseId) {
  const lines = [];
  for (const e of events) {
    if (e.payload.case_id !== caseId) continue;
    if (e.type === "case_presented") lines.push({ role: "examiner", text: e.payload.text });
    if (e.type === "answer_submitted")
      lines.push({ role: "candidate", text: e.payload.text, latency_ms: e.payload.latency_ms, committed_answer: true });
    if (e.type === "probe_answered") lines.push({ role: "candidate", text: e.payload.text });
    if (e.type === "feedback_given") lines.push({ role: "examiner", text: e.payload.text });
  }
  return lines;
}

// --- mastery projection (rebuildable, deterministic replay) ---

const GROW = 2.5;
const SHRINK = 0.25;
const MAX_INTERVAL_DAYS = 60;

export function rebuildMastery() {
  const rows = db
    .prepare(
      `SELECT a.id AS attempt_id, a.case_id, a.created_at,
              m.miss_type, m.target_concept
       FROM attempts a LEFT JOIN misses m ON m.attempt_id = a.id
       ORDER BY a.created_at, a.id`,
    )
    .all();

  // attempt -> its misses; replay chronologically
  const byAttempt = new Map();
  for (const r of rows) {
    if (!byAttempt.has(r.attempt_id))
      byAttempt.set(r.attempt_id, { case_id: r.case_id, created_at: r.created_at, misses: [] });
    if (r.miss_type) byAttempt.get(r.attempt_id).misses.push({ type: r.miss_type, concept: r.target_concept });
  }

  const state = new Map(); // "concept|type" -> {attempts, misses, interval, lastSeen, nextDue}
  const key = (c, t) => `${c}|${t}`;

  for (const a of byAttempt.values()) {
    const caseRow = getCase(a.case_id);
    if (!caseRow) continue;
    const missedHere = new Map(a.misses.map((m) => [key(m.concept, m.type), true]));
    for (const concept of caseRow.concept_ids) {
      for (const type of MISS_TYPES) {
        const k = key(concept, type);
        const s = state.get(k) || { attempts: 0, misses: 0, interval: 1, lastSeen: null, nextDue: null };
        s.attempts += 1;
        s.lastSeen = a.created_at;
        if (missedHere.has(k)) {
          s.misses += 1;
          s.interval = Math.max(0.5, s.interval * SHRINK);
        } else {
          s.interval = Math.min(MAX_INTERVAL_DAYS, s.interval * GROW);
        }
        s.nextDue = new Date(new Date(a.created_at).getTime() + s.interval * 86400000).toISOString();
        state.set(k, s);
      }
    }
  }

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM mastery");
    const ins = db.prepare(
      "INSERT INTO mastery (concept_id, miss_type, attempts, misses, last_seen, next_due, interval_days) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const [k, s] of state) {
      const [concept, type] = k.split("|");
      ins.run(concept, type, s.attempts, s.misses, s.lastSeen, s.nextDue, s.interval);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// --- card writer (§6.3: KNOWLEDGE_GAP -> card; deduped on content hash) ---

async function writeCards(sessionId) {
  const gaps = db
    .prepare(
      `SELECT m.* FROM misses m
       JOIN attempts a ON a.id = m.attempt_id
       WHERE a.session_id = ? AND m.miss_type = 'KNOWLEDGE_GAP'
       AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.miss_id = m.id)`,
    )
    .all(sessionId);

  for (const miss of gaps) {
    const attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(miss.attempt_id);
    const caseRow = getCase(attempt.case_id);
    const { content, usage, raw } = await chat(
      [
        { role: "system", content: CARD_WRITER_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            missing_fact_context: {
              target_concept: miss.target_concept,
              discriminator: miss.discriminator,
              evidence_of_gap: miss.evidence,
              correct_diagnosis: caseRow?.correct_dx,
              correct_action: caseRow?.correct_action,
            },
          }),
        },
      ],
      { model: HEAVY_MODEL, thinking: true, maxTokens: 1024 },
    );
    recordUsage(sessionId, "card_writer", raw?.model, usage);
    let card;
    try {
      card = parseStrictJson(content);
    } catch {
      continue; // card generation is best-effort; the miss record is what matters
    }
    if (!card.front || !card.back) continue;
    const hash = createHash("sha256").update(`${card.front}\n${card.back}`).digest("hex");
    try {
      db.prepare("INSERT INTO cards (id, miss_id, front, back, content_hash) VALUES (?, ?, ?, ?, ?)").run(
        uuid(),
        miss.id,
        card.front,
        card.back,
        hash,
      );
    } catch {
      // UNIQUE(content_hash) violation -> duplicate card, skip (idempotency)
    }
  }
}

// --- briefer ---

async function writeBrief(sessionId) {
  const misses = db
    .prepare(
      `SELECT m.miss_type, m.target_concept, m.discriminator, m.evidence
       FROM misses m JOIN attempts a ON a.id = m.attempt_id WHERE a.session_id = ?`,
    )
    .all(sessionId);
  const due = db
    .prepare("SELECT concept_id, miss_type, next_due FROM mastery ORDER BY next_due LIMIT 10")
    .all();
  const { content, usage, raw } = await chat(
    [
      { role: "system", content: BRIEFER_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ session_misses: misses, upcoming_due: due }) },
    ],
    { model: HEAVY_MODEL, maxTokens: 1024, thinking: false },
  );
  recordUsage(sessionId, "briefer", raw?.model, usage);
  db.prepare(
    "INSERT INTO briefs (session_id, content) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET content = excluded.content, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  ).run(sessionId, content.trim());
}

// --- the pipeline ---

export async function processSession(sessionId) {
  const events = sessionEvents(sessionId);
  const attempts = db
    .prepare("SELECT * FROM attempts WHERE session_id = ? ORDER BY created_at")
    .all(sessionId);

  // Classify every attempt first (LLM calls happen outside the transaction).
  const results = [];
  for (const attempt of attempts) {
    const caseRow = getCase(attempt.case_id);
    if (!caseRow) continue;
    const transcript = transcriptForCase(events, attempt.case_id);
    const verdict = await classifyAttempt(sessionId, attempt, caseRow, transcript);
    results.push({ attempt, verdict });
  }

  // Rewrite this session's misses atomically (§8 idempotency).
  db.exec("BEGIN");
  try {
    db.prepare(
      "DELETE FROM misses WHERE attempt_id IN (SELECT id FROM attempts WHERE session_id = ?)",
    ).run(sessionId);
    const ins = db.prepare(
      `INSERT INTO misses (id, attempt_id, miss_type, confidence, cue_set, discriminator, anchored_to, target_concept, evidence, remediation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const { attempt, verdict } of results) {
      if (verdict.miss_type === "NONE") continue;
      ins.run(
        uuid(),
        attempt.id,
        verdict.miss_type,
        verdict.confidence ?? null,
        JSON.stringify(verdict.cue_set ?? null),
        verdict.discriminator ?? null,
        verdict.anchored_to ?? null,
        verdict.target_concept,
        verdict.evidence ?? null,
        verdict.remediation ?? null,
      );
    }
    db.prepare("UPDATE sessions SET processed_at = ? WHERE id = ?").run(now(), sessionId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  rebuildMastery();
  await writeCards(sessionId);
  await writeBrief(sessionId);
  return { attempts: results.length, misses: results.filter((r) => r.verdict.miss_type !== "NONE").length };
}
