# Clinical Reasoning Trainer

Label-free, timed, action-forcing clinical case training. See the repo-root
`CLAUDE.md` for the full specification. Zero npm dependencies — everything
runs on Node ≥ 22.

## Setup

1. Copy `trainer/.env.example` to `trainer/.env` and set `GLM_API_KEY`.
2. Run the server:

   ```
   node trainer/server.mjs
   ```

3. Open http://localhost:8787 — on a phone, use your computer's LAN address
   and "Add to Home Screen" to install the PWA.

## Using it

- **Start session** presents cases chosen by the mastery model (due misses
  first, with their remediation applied, then unseen cases).
- A case streams in and the clock starts. Type **one diagnosis and one
  immediate action** and hit Commit — your latency is recorded and judged.
- Answer the tutor's probes, then **Next case**. **End session** queues
  background classification; nothing interactive waits on it.
- Back on the home screen: the next-session brief, the mastery table, and
  generated cards appear once classification finishes (watch the
  "classifying…" status).
- Cards: **Push to Anki** (requires Anki open with the AnkiConnect add-on;
  deck name via `ANKI_DECK`, default "Clinical Reasoning") or **Download
  TSV** and import manually (File → Import, fields separated by tabs).

## Commands

| Command | Purpose |
|---|---|
| `node trainer/server.mjs` | Run the app (port via `TRAINER_PORT`, default 8787) |
| `node trainer/viva.mjs` | Terminal-only viva, no persistence |
| `node trainer/reclassify.mjs <session-id>` | Re-run classification for one session |
| `node trainer/reclassify.mjs --all` | Replay classification over every ended session |
| `node trainer/reclassify.mjs --rebuild-mastery` | Rebuild the mastery projection only (no LLM calls) |

## Environment

| Var | Default | Purpose |
|---|---|---|
| `GLM_API_KEY` | — | required |
| `GLM_BASE_URL` | Z.ai coding endpoint | pay-as-you-go keys use `https://api.z.ai/api/paas/v4` |
| `GLM_MODEL` | `glm-5.2` | |
| `TRAINER_PORT` | 8787 | |
| `TRAINER_KEY` | unset | if set, the API requires this key (the PWA prompts once) |
| `TRAINER_CASES_PER_SESSION` | 4 | |
| `TRAINER_DATA_DIR` | `trainer/data` | SQLite location |
| `ANKI_CONNECT_URL` | `http://127.0.0.1:8765` | |
| `ANKI_DECK` | `Clinical Reasoning` | |

## Data

Everything lives in `trainer/data/trainer.db` (SQLite, gitignored). The
`events` table is canonical and append-only; `mastery`, `cards` and `briefs`
are projections and can be rebuilt at any time with `reclassify`.

Case content is model-generated and **unverified until you review it** —
check every threshold in `trainer/cases/seed.json` against current
Australian guidelines before trusting it. Exam preparation only; not
clinical decision support.
