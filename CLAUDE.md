# Clinical Reasoning Trainer — Engineering Specification

**Version** 0.1 · **Status** Draft for build · **Owner** JP
**Purpose of this document:** single source of truth for the system. Lives at the repo root as `CLAUDE.md`. Every coding session begins by reading it. Every architectural decision gets written back into it.

---

## 1. Problem statement

The user can produce clinical knowledge on demand but fails to retrieve and act on it when it appears as an undifferentiated presentation. This is **not** a memorisation deficit. It is a retrieval-indexing and salience deficit.

Four distinct failure modes, each requiring a different remediation. The system's entire value depends on distinguishing them:

| Code | Miss type | Description | Remediation |
|---|---|---|---|
| `KNOWLEDGE_GAP` | Fact absent | Did not hold the fact, threshold, or criterion | Supply the fact; generate a card |
| `CUE_FAILURE` | Present, not retrieved | Held the fact but nothing in the stimulus triggered it | Re-present with different surface features, same underlying case |
| `SALIENCE_FAILURE` | Retrieved, under-acted | Named it correctly but under-escalated or mis-timed the response | Raise stakes; run the consequence forward; force a timed committed action |
| `ANCHORING` | Gestalt over discriminator | Committed on vibe; discriminator never checked. **Right answer via wrong reasoning is graded incorrect.** | Contrastive pair — the near-miss that isn't it |

**Topic tagging cannot drive any of these remediations.** "Struggled with sepsis" is not an actionable record. The miss type is the unit of storage. This is the central design commitment of the system.

---

## 2. Scope

**In scope**

- Label-free, timed, action-forcing clinical case presentation
- Adversarial tutoring that refuses approximate answers
- Automated post-session classification of misses by type
- A persistent mastery model driving what is presented next
- Card generation exported to the user's existing Anki deck

**Out of scope — explicitly rejected**

| Rejected | Reason |
|---|---|
| Dual alternating front agents | Describes double-buffering to hide latency. Streaming already solves time-to-first-token. Two agents either share full state (no saving) or diverge into a tutor with amnesia. |
| Rebuilding spaced repetition | Anki already exists and is already in the user's workflow. Terminate the pipeline in it. Removes ~60% of the build. |
| Per-turn background extraction | Triples token spend for marginal gain. Batch at end of session. |
| Native Android app | Android background execution (Doze, process death, WorkManager constraints) is hostile to this workload. PWA, thin client, all work server-side. |
| LLM-based scheduling | Scheduling is FSRS — deterministic. "What next" is a SQL query over the mastery table, not an agent. |
| Clinical decision support | This is an exam-preparation tool. See §11. |

---

## 3. Design principles

1. **Never name the topic.** The moment a stem says "a patient with suspected sepsis," the exercise becomes recognition and trains nothing. Input is a handover, a phone call, a set of observations. No label.
2. **Force commitment before revelation.** The user must state a diagnosis and a next action before any feedback is shown. No hedging accepted; no partial credit for a differential with eight items.
3. **Clock on everything.** Salience is time-coupled. An answer produced in four minutes is a different answer to the same words produced in twenty seconds.
4. **Refuse the vibe answer.** Default model behaviour is to accept a near-miss and helpfully complete it. That behaviour *is* the pathology being trained out. The tutor must demand the discriminator and ask why not the nearest competing diagnoses.
5. **Nothing observes anything.** No agent "watches" the chat. The chat *emits events*; workers *consume* them from a queue. Producer/consumer.
6. **Blackboard, not messaging.** Agents never call each other. They read and write shared database state. Agent-to-agent messaging is where these systems rot.
7. **Append-only log is canonical.** Everything else is a derived projection and can be rebuilt.
8. **Structured output or fail loudly.** Every background agent returns JSON validated against a schema. No prose parsing, no regex over model output.
9. **Idempotent jobs.** Jobs retry. Dedupe on content hash or you get four copies of the same card.
10. **Don't LLM what a function does.**

---

## 4. Architecture

```
┌──────────────┐
│  PWA client  │  streams tutor turns, submits answers + latency
└──────┬───────┘
       │ HTTPS
┌──────▼───────────────────────────────────────────┐
│  API layer                                       │
│  · /session/start  /turn  /session/end           │
└──────┬───────────────────────────────────────────┘
       │ append
┌──────▼──────────┐        emit event         ┌──────────────┐
│  events         │──────────────────────────▶│  job queue   │
│  (append-only)  │                           └──────┬───────┘
└─────────────────┘                                  │
                                                     ▼
                    ┌────────────────────────────────────────┐
                    │  Workers (background, batched)          │
                    │  1. Classifier  → miss records          │
                    │  2. Projector   → mastery table         │
                    │  3. Card writer → deck queue            │
                    │  4. Briefer     → next-session brief    │
                    └────────────────┬───────────────────────┘
                                     ▼
                    ┌────────────────────────────────────────┐
                    │  Projections (rebuildable)              │
                    │  mastery · cards · briefs               │
                    └────────────────────────────────────────┘
```

**Event sourcing / CQRS.** The conversation log is append-only and canonical. Mastery state, card deck and next-session brief are *projections*. When the classifier prompt improves — and it will, repeatedly — replay the log and rebuild them. This is why classification is not done inline.

---

## 5. Data model

Postgres. Minimum viable set.

```sql
-- canonical, append-only, never updated
events (
  id            bigserial primary key,
  session_id    uuid not null,
  seq           int not null,
  type          text not null,      -- case_presented | answer_submitted
                                    -- | probe_answered | feedback_given
                                    -- | session_ended
  payload       jsonb not null,
  created_at    timestamptz default now(),
  unique (session_id, seq)
);

sessions (
  id            uuid primary key,
  started_at    timestamptz,
  ended_at      timestamptz,
  mode          text,               -- viva | resus | written
  processed_at  timestamptz         -- null = classification pending
);

-- one row per case attempt
attempts (
  id            uuid primary key,
  session_id    uuid references sessions,
  case_id       uuid references cases,
  answer_text   text,
  action_text   text,
  latency_ms    int,
  hedged        boolean,
  created_at    timestamptz
);

-- classifier output. THE core table.
misses (
  id              uuid primary key,
  attempt_id      uuid references attempts,
  miss_type       text not null,    -- KNOWLEDGE_GAP | CUE_FAILURE
                                    -- | SALIENCE_FAILURE | ANCHORING
  confidence      numeric,
  cue_set         text[],           -- cues that should have fired
  discriminator   text,             -- the feature that separates it
  anchored_to     text,             -- competing dx wrongly committed to
  target_concept  text,             -- canonical concept id, not free text
  evidence        text,             -- quote from user's own answer
  created_at      timestamptz
);

-- projection, rebuildable
mastery (
  concept_id      text,
  miss_type       text,
  attempts        int,
  misses          int,
  last_seen       timestamptz,
  next_due        timestamptz,      -- FSRS output
  primary key (concept_id, miss_type)
);

cases (
  id              uuid primary key,
  stem            text,             -- label-free presentation
  obs             jsonb,            -- vitals, timings
  correct_dx      text,
  correct_action  text,
  discriminators  jsonb,
  near_misses     text[],           -- for contrastive re-presentation
  concept_ids     text[],
  time_limit_s    int
);

cards (
  id              uuid primary key,
  miss_id         uuid references misses,
  front           text,
  back            text,
  content_hash    text unique,      -- idempotency
  exported_at     timestamptz
);
```

Note `mastery` is keyed on **(concept, miss_type)** — not concept alone. The same concept can be mastered as knowledge and failed as salience. These are separately tracked and separately remediated.

---

## 6. Agent contracts

### 6.1 Front agent — the tutor

Single agent. Streams. Holds the session.

Draft system prompt:

```
You are a senior clinician running a viva. You are not an assistant.

RULES — absolute:
1. Present cases as raw clinical material: a handover, a phone
   call from a nurse, a set of observations. NEVER name the
   diagnosis, the syndrome, the system, or the topic. Never say
   "this is a case of" or "consider whether".
2. Demand a committed answer: one diagnosis, one immediate
   action, before you reveal anything. If the candidate gives a
   list, or hedges, or asks what you think — push back once and
   require commitment.
3. Do not complete their thinking. If the answer is close but
   the discriminating feature was never named, treat it as
   wrong and say so. Ask: what separates this from [near-miss]?
4. If the answer is right but the reasoning was gestalt, mark it
   incorrect and say why. Reaching the right answer for the
   wrong reason is a fail.
5. Probe after every miss: ask the direct factual question
   ("what is the lactate threshold?") to establish whether the
   knowledge was absent or merely not retrieved. This probe is
   required — the classifier depends on it.
6. Escalate. If they under-call urgency, run the clock forward
   and show the deterioration.
7. Be brief. No praise. No preamble. No summarising back.

Australian guidelines. Adult acute care unless stated.
```

**Rule 5 is load-bearing.** Without the probe, `KNOWLEDGE_GAP` and `CUE_FAILURE` are indistinguishable downstream and the whole taxonomy collapses.

### 6.2 Background agent — the classifier

Runs once at `session_ended`. Batched over all attempts in the session.

**Input per attempt:** case stem, obs, correct dx/action, user's answer, user's action, probe question and probe answer, latency, hedge flag.

**Decision procedure — apply in order, first match wins:**

```
1. Was the stated diagnosis or action correct?
   NO  → 2
   YES → 4

2. Probe: when asked the fact directly, did they have it?
   NO  → KNOWLEDGE_GAP
   YES → 3

3. Did they commit early to a competing diagnosis and never
   test the discriminator?
   YES → ANCHORING (record anchored_to)
   NO  → CUE_FAILURE (record cue_set that should have fired)

4. Correct — but was urgency, timeframe or escalation
   under-called relative to the reference action?
   YES → SALIENCE_FAILURE
   NO  → 5

5. Was the discriminating feature explicitly named in their
   reasoning?
   NO  → ANCHORING (right answer, wrong route — still a miss)
   YES → no miss recorded
```

**Required output — strict JSON, one object per attempt, no prose, no markdown fences:**

```json
{
  "attempt_id": "uuid",
  "miss_type": "CUE_FAILURE",
  "confidence": 0.82,
  "target_concept": "sepsis.recognition.qsofa",
  "cue_set": ["RR 24", "altered mentation", "nurse concern"],
  "discriminator": "RR is the earliest deranged parameter; it was in the stem and never mentioned",
  "anchored_to": null,
  "evidence": "verbatim fragment from the candidate's answer",
  "remediation": "RE_PRESENT_VARIED_SURFACE"
}
```

Validate against schema. On validation failure: retry once, then dead-letter and flag for review. Never write unvalidated output to `misses`.

`target_concept` must resolve against a controlled concept list. Free-text concepts are the failure mode that turns the mastery table back into useless topic tagging.

### 6.3 Remediation mapping

Deterministic. A function, not an agent.

| Miss type | Next presentation |
|---|---|
| `KNOWLEDGE_GAP` | Card generated. Concept re-tested directly at next FSRS interval. |
| `CUE_FAILURE` | Same underlying case, different surface: different age, sex, setting, presenting complaint. Cue set preserved. |
| `SALIENCE_FAILURE` | Same case, shortened time limit, consequence run forward on failure to escalate. |
| `ANCHORING` | Contrastive pair — the case and its near-miss presented in adjacent sessions, discriminator required explicitly. |

---

## 7. Session flow

1. Client requests session → API queries `mastery` for due concepts (FSRS), selects cases, applies remediation mapping.
2. Tutor streams case. Clock starts. `case_presented` appended.
3. User commits answer + action. Latency captured client-side. `answer_submitted` appended.
4. Tutor probes if wrong. `probe_answered` appended.
5. Tutor gives feedback. `feedback_given` appended.
6. Repeat 2–5.
7. `session_ended` appended → enqueue classification job.
8. Worker classifies → writes `misses` → projector updates `mastery` → card writer emits `cards` → briefer writes next-session brief.
9. Cards exported to Anki (`.apkg` or AnkiConnect).

Steps 8–9 are asynchronous and invisible to the user. Nothing in the interactive path waits on them.

---

## 8. Job pipeline

- **Queue:** Postgres-backed (`pg-boss` or Supabase cron). One user, ~10 sessions/week. Nothing exotic required. Redis/SQS is over-engineering at this volume.
- **Idempotency:** every job keyed on `session_id`. Cards deduped on `content_hash`. Re-running classification for a session deletes and rewrites that session's `misses` rows in a transaction — never appends duplicates.
- **Retries:** 3 attempts, exponential backoff, then dead-letter table with a visible flag in the UI.
- **Replay:** a `reclassify(session_id)` command must exist from day one. It will be used constantly while the classifier prompt is being tuned.

---

## 9. Stack

**As built (v1, 2026-07-30).** The Supabase/Vercel/Next.js column was the original plan; v1 ships as a self-hosted, zero-dependency Node server so the product works with one command and no accounts. The architecture (event sourcing, queue, projections) is unchanged; only the hosting substrate moved. Revisit when multi-device sync is actually needed.

| Layer | v1 choice (as built) | Original plan (deferred) | Rationale for v1 |
|---|---|---|---|
| Client | Vanilla-JS PWA served by the app server, installs to home screen; plus a Telegram bot (`trainer/lib/telegram.mjs`, long-polling — no public URL needed) sharing the same session engine (`trainer/lib/engine.mjs`). Telegram Mini App deferred: it needs a public HTTPS URL (`TRAINER_PUBLIC_URL` enables the bot menu button when one exists). | Next.js on Vercel | No build step, no framework; bot reaches the phone anywhere with zero hosting |
| Server | Single Node ≥22 process (`trainer/server.mjs`) | Vercel functions | One command to run; streams NDJSON |
| DB | SQLite via built-in `node:sqlite` (`trainer/data/trainer.db`) | Supabase Postgres | Zero setup; same schema shape, migratable later |
| Queue | `jobs` table + in-process worker, retries + dead-letter table | pg-boss | Same semantics at 1-user volume |
| Model API | Z.ai GLM-5.2, split by path: tutor = thinking OFF (~1.0s TTFT vs 2.5s, benchmarked 2026-07-30 across all 8 Z.ai models; glm-4.x with thinking are unusable interactively at 14–44s TTFT); background classifier/cards = thinking ON | Anthropic API | Direct API, no proxy layer. Coding-plan key → base URL `https://api.z.ai/api/coding/paas/v4` (pay-as-you-go keys use `/api/paas/v4`). OpenAI-compatible; reasoning arrives in `reasoning_content`. Client: `trainer/lib/glm.mjs`. Key in `.env` (`GLM_API_KEY`), never committed. |
| Scheduling | Deterministic interval replay (grow ×2.5 on clean, shrink ×0.25 on miss, per (concept, miss_type)) | FSRS proper | Same shape (deterministic, SQL-driven); swap in real FSRS weights later without schema change |
| Cards | In-chat Telegram review (`/review`, FSRS-style scheduler in `trainer/lib/review.mjs`) **plus** Anki via AnkiConnect push or TSV export | Anki only ("don't rebuild SRS") | Owner decision 2026-07-30: reviewing where the training happens beats switching apps; scheduler is ~60 lines, deterministic, and Anki export remains for the existing deck |

---

## 10. Cost control

- Background agents bill against the **API**, not the chat subscription. Different key, different meter.
- Set a hard spend cap in Console before the first API call is made.
- Batch classification at session end. Never per-turn.
- Log token spend per session to a `usage` table from milestone 1. Cost per session is a metric, not a surprise.

---

## 11. Clinical and safety constraints

- This is an **exam-preparation tool for a medical student**. It is not clinical decision support and must never be represented as such. No patient data enters it, ever.
- Generated case content and thresholds must be anchored to current Australian guidelines and are **unverified until reviewed by the user**. Model-generated numerical thresholds are a known failure point — every threshold entering the `cases` table is reviewed before use.
- Cards carry a provenance field: generated, reviewed, or verified against a named source.

---

## 12. Build order

Ship each milestone working before starting the next. Resist building the four-agent version first.

| M | Deliverable | Done when | Status (2026-07-30) |
|---|---|---|---|
| **M0** | Repo, `CLAUDE.md`, `.env`, spend cap set | `git log` has a first commit; secrets are not in it | ✅ (SQLite instead of Supabase; no cap needed on coding-plan billing) |
| **M1** | Cases, tutor streams them, answers stored in `events` | A full turn survives a page refresh | ✅ verified — survives full server restart, not just refresh |
| **M2** | Classifier runs at session end, writes valid `misses` rows | JSON validates; bad output dead-letters instead of crashing | ✅ verified — validation + retry + dead-letter table |
| **M3** | `mastery` projection + `reclassify` command | Changing the classifier prompt and replaying changes the mastery table | ✅ `trainer/reclassify.mjs <id> \| --all \| --rebuild-mastery` |
| **M4** | Case selection driven by mastery + remediation mapping | A `CUE_FAILURE` produces a surface-varied re-presentation | ✅ verified — due `ANCHORING` selected its case with contrastive directive |
| **M5** | Card generation → Anki export | Cards land in the existing deck without duplicates | ✅ `KNOWLEDGE_GAP` → card, content-hash dedupe, AnkiConnect + TSV (AnkiConnect path untested — needs Anki running) |
| **M6** | Auth, PWA manifest, install to home screen | Runs from the phone home screen | ✅ manifest + service worker + optional `TRAINER_KEY`; install untested on a real phone |

Everything before M3 is throwaway scaffolding. Build it ugly and hardcoded.

---

## 13. Working discipline

For a non-professional developer directing an agent:

- **Commit before every session and after anything that works.** This is the only undo.
- **Update this document when a decision changes.** A decision not written here will be re-litigated next week.
- **Never accept a file you cannot narrate the purpose of.** Not line by line — but if you can't say what it is *for*, make the agent explain before it moves on.
- **Secrets in `.env`, never committed.**
- **One milestone per branch.**

---

## 14. Known limitation

The system can simulate time pressure and consequence. It cannot supply real consequence. The affective tag that makes a deranged respiratory rate *feel* urgent is welded on by actual deterioration and an actual registrar's reaction. This tool builds the cue-index and the callout discipline; the salience half is completed on placement. Design accordingly and do not over-claim.
