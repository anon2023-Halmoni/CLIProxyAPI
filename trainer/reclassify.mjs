// Replay tool (spec §8): re-run classification for one session or all
// ended sessions, then rebuild projections. Used constantly while the
// classifier prompt is being tuned.
//
//   node trainer/reclassify.mjs <session-id>
//   node trainer/reclassify.mjs --all
//   node trainer/reclassify.mjs --rebuild-mastery   (projection only, no LLM calls)

import { db } from "./lib/db.mjs";
import { processSession, rebuildMastery } from "./lib/classify.mjs";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node trainer/reclassify.mjs <session-id> | --all | --rebuild-mastery");
  process.exit(1);
}

if (arg === "--rebuild-mastery") {
  rebuildMastery();
  console.log("mastery projection rebuilt from misses/attempts.");
  process.exit(0);
}

const ids =
  arg === "--all"
    ? db.prepare("SELECT id FROM sessions WHERE ended_at IS NOT NULL ORDER BY started_at").all().map((r) => r.id)
    : [arg];

for (const id of ids) {
  process.stdout.write(`reclassifying ${id} ... `);
  try {
    const result = await processSession(id);
    console.log(`ok — ${result.attempts} attempts, ${result.misses} misses`);
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
  }
}
