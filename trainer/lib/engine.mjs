// Session engine — shared by the web server and the Telegram bot.
// Owns live session state (rebuildable from events) and the tutor turns.
//
// Model split (benchmarked 2026-07-30): the tutor runs thinking-OFF for
// ~1s time-to-first-token; background jobs use thinking-ON glm-5.2.

import {
  db,
  uuid,
  now,
  appendEvent,
  sessionEvents,
  getCase,
  enqueueJob,
  recordUsage,
} from "./db.mjs";
import { streamChat } from "./glm.mjs";
import { TUTOR_SYSTEM_PROMPT, caseFileMessage } from "./prompts.mjs";
import { selectCases } from "./select.mjs";

export const TUTOR_MODEL = process.env.GLM_TUTOR_MODEL || "glm-5.2";
export const TUTOR_THINKING = (process.env.GLM_TUTOR_THINKING || "off") === "on";

const live = new Map(); // sessionId -> {messages, plan, idx, answered}

export function createSession(caseCount = 4, mode = "viva") {
  const selections = selectCases(caseCount);
  if (selections.length === 0) throw new Error("no cases available");
  const sessionId = uuid();
  db.prepare("INSERT INTO sessions (id, started_at, mode) VALUES (?, ?, ?)").run(sessionId, now(), mode);
  const plan = selections.map((s) => ({
    caseId: s.case.id,
    missType: s.missType,
    directive: s.directive,
    timeLimitSeconds: s.timeLimitSeconds,
  }));
  appendEvent(sessionId, "session_started", { plan, mode });
  live.set(sessionId, {
    messages: [{ role: "system", content: TUTOR_SYSTEM_PROMPT }],
    plan: plan.map((p, i) => ({ ...p, case: selections[i].case })),
    idx: -1,
    answered: false,
  });
  return { sessionId, caseCount: plan.length };
}

export function requireLive(sessionId) {
  if (live.has(sessionId)) return live.get(sessionId);
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  if (!session || session.ended_at) return null;
  const events = sessionEvents(sessionId);
  const planEvent = events.find((e) => e.type === "session_started");
  if (!planEvent) return null;
  const plan = planEvent.payload.plan.map((p) => ({ ...p, case: getCase(p.caseId) }));
  const state = {
    messages: [{ role: "system", content: TUTOR_SYSTEM_PROMPT }],
    plan,
    idx: -1,
    answered: false,
  };
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
      state.messages.push({
        role: "user",
        content:
          e.payload.text +
          (e.payload.latency_ms ? `\n\n[response latency: ${(e.payload.latency_ms / 1000).toFixed(1)}s]` : ""),
      });
    }
    if (e.type === "feedback_given") state.messages.push({ role: "assistant", content: e.payload.text });
  }
  live.set(sessionId, state);
  return state;
}

async function tutorTurn(sessionId, state, kind, onDelta) {
  const { content, usage } = await streamChat(state.messages, {
    model: TUTOR_MODEL,
    thinking: TUTOR_THINKING,
    maxTokens: 3072,
    onDelta: ({ type, text }) => {
      if (type === "content") onDelta?.(text);
    },
  });
  recordUsage(sessionId, "tutor", TUTOR_MODEL, usage);
  state.messages.push({ role: "assistant", content });
  const current = state.plan[state.idx];
  appendEvent(sessionId, kind, { case_id: current?.caseId ?? null, text: content });
  return {
    text: content,
    kind,
    caseIndex: state.idx,
    caseCount: state.plan.length,
    timeLimitSeconds: current?.timeLimitSeconds ?? null,
  };
}

/** Advance to the next case and stream its presentation. Returns {finished:true} after the last case. */
export async function nextCase(sessionId, onDelta) {
  const state = requireLive(sessionId);
  if (!state) throw new Error("session not found or already ended");
  state.idx += 1;
  state.answered = false;
  if (state.idx >= state.plan.length) return { finished: true };
  const p = state.plan[state.idx];
  state.messages.push({ role: "user", content: caseFileMessage(p.case, p.directive, p.timeLimitSeconds) });
  return tutorTurn(sessionId, state, "case_presented", onDelta);
}

/** Submit a candidate message. First message per case = committed answer (with latency); later ones = probe answers. */
export async function userTurn(sessionId, text, latencyMs, onDelta) {
  const state = requireLive(sessionId);
  if (!state) throw new Error("session not found or already ended");
  const current = state.plan[state.idx];
  if (!current) throw new Error("no active case — call nextCase first");

  if (!state.answered) {
    const late = latencyMs != null && latencyMs > current.timeLimitSeconds * 1000;
    state.answered = true;
    const attemptId = uuid();
    db.prepare(
      "INSERT INTO attempts (id, session_id, case_id, answer_text, latency_ms, hedged) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(attemptId, sessionId, current.caseId, text, latencyMs ?? null, 0);
    appendEvent(sessionId, "answer_submitted", {
      case_id: current.caseId,
      text,
      latency_ms: latencyMs ?? null,
      late,
      attempt_id: attemptId,
    });
    state.messages.push({
      role: "user",
      content:
        text +
        (latencyMs
          ? `\n\n[response latency: ${(latencyMs / 1000).toFixed(1)}s${late ? " — OVER the time limit" : ""}]`
          : ""),
    });
  } else {
    appendEvent(sessionId, "probe_answered", { case_id: current.caseId, text });
    state.messages.push({ role: "user", content: text });
  }
  return tutorTurn(sessionId, state, "feedback_given", onDelta);
}

export function endSession(sessionId) {
  db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(now(), sessionId);
  appendEvent(sessionId, "session_ended", {});
  enqueueJob("classify_session", { sessionId });
  live.delete(sessionId);
}

export function transcript(sessionId) {
  const state = requireLive(sessionId);
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  const events = sessionEvents(sessionId).filter((e) =>
    ["case_presented", "answer_submitted", "probe_answered", "feedback_given"].includes(e.type),
  );
  const current = state?.plan?.[state.idx];
  return {
    ended: !!session?.ended_at,
    caseIndex: state?.idx ?? null,
    caseCount: state?.plan?.length ?? null,
    answered: state?.answered ?? null,
    timeLimitSeconds: current?.timeLimitSeconds ?? null,
    events: events.map((e) => ({ type: e.type, payload: e.payload })),
  };
}
