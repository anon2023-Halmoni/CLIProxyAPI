// Case selection + remediation mapping (spec §6.3, §7.1).
// Deterministic — a query over mastery, not an agent.

import { db, allCases, now } from "./db.mjs";
import { REMEDIATION_DIRECTIVES } from "./prompts.mjs";

const MISS_PRIORITY = ["ANCHORING", "SALIENCE_FAILURE", "CUE_FAILURE", "KNOWLEDGE_GAP"];

/**
 * Select up to `count` cases for a session. Due (concept, miss_type)
 * rows drive selection; unseen cases fill the remainder; then
 * least-recently-seen. Each selection carries its remediation
 * directive and (possibly shortened) time limit.
 */
export function selectCases(count = 4) {
  const cases = allCases();
  if (cases.length === 0) return [];

  const dueRows = db
    .prepare("SELECT * FROM mastery WHERE next_due IS NOT NULL AND next_due <= ? ORDER BY next_due")
    .all(now());

  const lastSeenByCase = new Map(
    db
      .prepare("SELECT case_id, MAX(created_at) AS last FROM attempts GROUP BY case_id")
      .all()
      .map((r) => [r.case_id, r.last]),
  );

  const selected = [];
  const usedCaseIds = new Set();

  // 1. Due concepts, worst miss type first.
  const dueByConcept = new Map();
  for (const row of dueRows) {
    const existing = dueByConcept.get(row.concept_id);
    if (
      !existing ||
      MISS_PRIORITY.indexOf(row.miss_type) < MISS_PRIORITY.indexOf(existing.miss_type)
    ) {
      dueByConcept.set(row.concept_id, row);
    }
  }
  for (const [conceptId, row] of dueByConcept) {
    if (selected.length >= count) break;
    const candidates = cases
      .filter((c) => c.concept_ids.includes(conceptId) && !usedCaseIds.has(c.id))
      .sort((a, b) => (lastSeenByCase.get(a.id) || "") < (lastSeenByCase.get(b.id) || "") ? -1 : 1);
    if (candidates.length === 0) continue;
    const chosen = candidates[0];
    usedCaseIds.add(chosen.id);
    selected.push(withRemediation(chosen, row.miss_type));
  }

  // 2. Never-attempted cases.
  for (const c of cases) {
    if (selected.length >= count) break;
    if (usedCaseIds.has(c.id) || lastSeenByCase.has(c.id)) continue;
    usedCaseIds.add(c.id);
    selected.push(withRemediation(c, null));
  }

  // 3. Least-recently-seen fill.
  const remaining = cases
    .filter((c) => !usedCaseIds.has(c.id))
    .sort((a, b) => ((lastSeenByCase.get(a.id) || "") < (lastSeenByCase.get(b.id) || "") ? -1 : 1));
  for (const c of remaining) {
    if (selected.length >= count) break;
    usedCaseIds.add(c.id);
    selected.push(withRemediation(c, null));
  }

  return selected;
}

function withRemediation(caseRow, missType) {
  let timeLimitSeconds = caseRow.time_limit_s || 180;
  if (missType === "SALIENCE_FAILURE") timeLimitSeconds = Math.max(45, Math.round(timeLimitSeconds * 0.6));
  return {
    case: caseRow,
    missType,
    directive: REMEDIATION_DIRECTIVES[missType || "NONE"],
    timeLimitSeconds,
  };
}
