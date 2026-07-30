// SQLite persistence layer. Schema mirrors CLAUDE.md §5, adapted to SQLite:
// uuids are TEXT (crypto.randomUUID), timestamps are ISO-8601 TEXT,
// arrays/objects are JSON TEXT. The events table is canonical and
// append-only; mastery/cards/briefs are rebuildable projections.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.TRAINER_DATA_DIR || resolve(here, "..", "data");
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(resolve(dataDir, "trainer.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (session_id, seq)
);
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  started_at   TEXT,
  ended_at     TEXT,
  mode         TEXT,
  processed_at TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  id          TEXT PRIMARY KEY,
  session_id  TEXT REFERENCES sessions(id),
  case_id     TEXT,
  answer_text TEXT,
  action_text TEXT,
  latency_ms  INTEGER,
  hedged      INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS misses (
  id             TEXT PRIMARY KEY,
  attempt_id     TEXT REFERENCES attempts(id),
  miss_type      TEXT NOT NULL,
  confidence     REAL,
  cue_set        TEXT,
  discriminator  TEXT,
  anchored_to    TEXT,
  target_concept TEXT,
  evidence       TEXT,
  remediation    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS mastery (
  concept_id    TEXT,
  miss_type     TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  misses        INTEGER NOT NULL DEFAULT 0,
  last_seen     TEXT,
  next_due      TEXT,
  interval_days REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (concept_id, miss_type)
);
CREATE TABLE IF NOT EXISTS cases (
  id             TEXT PRIMARY KEY,
  stem           TEXT,
  obs            TEXT,
  correct_dx     TEXT,
  correct_action TEXT,
  discriminators TEXT,
  near_misses    TEXT,
  concept_ids    TEXT,
  time_limit_s   INTEGER,
  provenance     TEXT DEFAULT 'generated'
);
CREATE TABLE IF NOT EXISTS cards (
  id           TEXT PRIMARY KEY,
  miss_id      TEXT REFERENCES misses(id),
  front        TEXT,
  back         TEXT,
  content_hash TEXT UNIQUE,
  exported_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS briefs (
  session_id TEXT PRIMARY KEY,
  content    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | dead
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  run_after  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS dead_letters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type   TEXT,
  payload    TEXT,
  error      TEXT,
  resolved   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT,
  kind              TEXT,
  model             TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  reasoning_tokens  INTEGER,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);

export const uuid = () => randomUUID();
export const now = () => new Date().toISOString();

// --- events (canonical, append-only) ---

export function appendEvent(sessionId, type, payload) {
  const { max } = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS max FROM events WHERE session_id = ?")
    .get(sessionId);
  db.prepare("INSERT INTO events (session_id, seq, type, payload) VALUES (?, ?, ?, ?)").run(
    sessionId,
    max + 1,
    type,
    JSON.stringify(payload),
  );
  return max + 1;
}

export function sessionEvents(sessionId) {
  return db
    .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY seq")
    .all(sessionId)
    .map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
}

// --- usage (§10: cost per session is a metric, not a surprise) ---

export function recordUsage(sessionId, kind, model, usage) {
  if (!usage) return;
  db.prepare(
    "INSERT INTO usage (session_id, kind, model, prompt_tokens, completion_tokens, reasoning_tokens) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    sessionId ?? null,
    kind,
    model ?? null,
    usage.prompt_tokens ?? 0,
    usage.completion_tokens ?? 0,
    usage.completion_tokens_details?.reasoning_tokens ?? 0,
  );
}

// --- cases ---

export function seedCases() {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM cases").get();
  if (n > 0) return n;
  const seed = JSON.parse(readFileSync(resolve(here, "..", "cases", "seed.json"), "utf8"));
  const ins = db.prepare(
    `INSERT INTO cases (id, stem, obs, correct_dx, correct_action, discriminators, near_misses, concept_ids, time_limit_s, provenance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of seed) {
    ins.run(
      c.id || uuid(),
      c.stem,
      JSON.stringify(c.obs ?? {}),
      c.correct_dx,
      c.correct_action,
      JSON.stringify(c.discriminators ?? []),
      JSON.stringify(c.near_misses ?? []),
      JSON.stringify(c.concept_ids ?? []),
      c.time_limit_s ?? 180,
      c.provenance ?? "generated",
    );
  }
  return seed.length;
}

export function getCase(id) {
  const c = db.prepare("SELECT * FROM cases WHERE id = ?").get(id);
  if (!c) return null;
  return {
    ...c,
    obs: JSON.parse(c.obs || "{}"),
    discriminators: JSON.parse(c.discriminators || "[]"),
    near_misses: JSON.parse(c.near_misses || "[]"),
    concept_ids: JSON.parse(c.concept_ids || "[]"),
  };
}

export function allCases() {
  return db.prepare("SELECT id FROM cases").all().map((r) => getCase(r.id));
}

// --- jobs (§8: idempotent, retried, dead-lettered) ---

export function enqueueJob(type, payload) {
  db.prepare("INSERT INTO jobs (type, payload) VALUES (?, ?)").run(type, JSON.stringify(payload));
}

export function claimJob() {
  const job = db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'pending'
       AND (run_after IS NULL OR run_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ORDER BY id LIMIT 1`,
    )
    .get();
  if (!job) return null;
  db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(
    now(),
    job.id,
  );
  return { ...job, payload: JSON.parse(job.payload), attempts: job.attempts + 1 };
}

export function completeJob(id) {
  db.prepare("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?").run(now(), id);
}

export function failJob(job, err) {
  const message = String(err?.stack || err).slice(0, 2000);
  if (job.attempts >= 3) {
    db.prepare("UPDATE jobs SET status = 'dead', last_error = ?, updated_at = ? WHERE id = ?").run(
      message,
      now(),
      job.id,
    );
    db.prepare("INSERT INTO dead_letters (job_type, payload, error) VALUES (?, ?, ?)").run(
      job.type,
      JSON.stringify(job.payload),
      message,
    );
  } else {
    const backoffSeconds = 2 ** job.attempts * 5;
    const runAfter = new Date(Date.now() + backoffSeconds * 1000).toISOString();
    db.prepare(
      "UPDATE jobs SET status = 'pending', last_error = ?, run_after = ?, updated_at = ? WHERE id = ?",
    ).run(message, runAfter, now(), job.id);
  }
}
