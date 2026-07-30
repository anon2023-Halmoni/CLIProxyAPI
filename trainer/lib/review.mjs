// In-chat flashcard review with FSRS-style scheduling (deliberate spec
// deviation, owner decision 2026-07-30: cards are reviewable directly in
// Telegram; Anki export remains available). Deterministic — grades map
// to interval multipliers; "again" re-queues in 10 minutes and counts a
// lapse. Swap in full FSRS weights later without schema change.

import { db, now } from "./db.mjs";

const GROWTH = { hard: 1.2, good: 2.5, easy: 3.5 };
const MAX_INTERVAL_DAYS = 365;
const AGAIN_MINUTES = 10;

export function dueCards() {
  return db
    .prepare(
      `SELECT * FROM cards
       WHERE due_at IS NULL OR due_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
       ORDER BY due_at IS NOT NULL, due_at`,
    )
    .all();
}

export function nextDueAt() {
  const row = db
    .prepare("SELECT MIN(due_at) AS next FROM cards WHERE due_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')")
    .get();
  return row?.next ?? null;
}

export function getCard(id) {
  return db.prepare("SELECT * FROM cards WHERE id = ?").get(id);
}

/** Preview the interval a grade would give, as a human string. */
export function previewInterval(card, grade) {
  if (grade === "again") return `${AGAIN_MINUTES}m`;
  const days = nextIntervalDays(card, grade);
  return days < 1 ? `${Math.round(days * 24)}h` : `${Math.round(days * 10) / 10}d`;
}

function nextIntervalDays(card, grade) {
  const current = card.interval_days ?? null;
  if (current == null || card.reps === 0) {
    // first grading of a new card
    return { hard: 0.5, good: 1, easy: 3 }[grade];
  }
  return Math.min(MAX_INTERVAL_DAYS, Math.max(0.5, current * GROWTH[grade]));
}

/** Apply a grade. Returns the human interval string. */
export function gradeCard(id, grade) {
  const card = getCard(id);
  if (!card) throw new Error("card not found");
  if (!["again", "hard", "good", "easy"].includes(grade)) throw new Error(`bad grade ${grade}`);

  let intervalDays, dueAt;
  if (grade === "again") {
    intervalDays = 0;
    dueAt = new Date(Date.now() + AGAIN_MINUTES * 60000).toISOString();
  } else {
    intervalDays = nextIntervalDays(card, grade);
    dueAt = new Date(Date.now() + intervalDays * 86400000).toISOString();
  }

  db.prepare(
    `UPDATE cards SET due_at = ?, interval_days = ?, reps = reps + 1,
     lapses = lapses + ? WHERE id = ?`,
  ).run(dueAt, grade === "again" ? card.interval_days ?? 0 : intervalDays, grade === "again" ? 1 : 0, id);

  return previewInterval(card, grade);
}
