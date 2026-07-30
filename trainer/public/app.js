// Client for the Clinical Reasoning Trainer.
// Latency clock starts when a case finishes streaming (spec §3.3);
// the session survives refresh by replaying the transcript endpoint.

const $ = (id) => document.getElementById(id);

const state = {
  sessionId: localStorage.getItem("trainer.sessionId") || null,
  answered: false,
  clockStart: null,
  timerHandle: null,
  timeLimitSeconds: null,
  streaming: false,
};

function headers() {
  const h = { "Content-Type": "application/json" };
  const key = localStorage.getItem("trainer.key");
  if (key) h["X-Trainer-Key"] = key;
  return h;
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: headers(), ...options });
  if (res.status === 401) {
    const key = prompt("Access key:");
    if (key) {
      localStorage.setItem("trainer.key", key);
      return api(path, options);
    }
  }
  return res;
}

// ---------------------------------------------------------------- views

function show(view) {
  $("home").classList.toggle("hidden", view !== "home");
  $("session").classList.toggle("hidden", view !== "session");
}

async function renderHome() {
  show("home");
  const res = await api("/api/state");
  if (!res.ok) return;
  const s = await res.json();

  $("brief-box").classList.toggle("hidden", !s.brief);
  if (s.brief) $("brief-text").textContent = s.brief.content;

  $("due-summary").textContent = s.due.length
    ? `${s.due.length} concept/miss-type pairs due for re-presentation`
    : "Nothing due — new material will be selected.";

  const tbody = $("mastery-table").querySelector("tbody");
  tbody.innerHTML = "";
  for (const m of s.mastery.filter((m) => m.misses > 0 || m.attempts > 0).slice(0, 40)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${m.concept_id}</td><td class="miss-${m.miss_type}">${m.miss_type.replaceAll("_", " ").toLowerCase()}</td><td>${m.misses}/${m.attempts}</td><td>${m.next_due ? new Date(m.next_due).toLocaleDateString() : "—"}</td>`;
    tbody.appendChild(tr);
  }

  $("cards-count").textContent = s.cardsTotal;
  $("cards-unexported").textContent = s.cardsUnexported;
  $("deadletter-box").classList.toggle("hidden", s.deadLetters === 0);
  $("deadletter-count").textContent = s.deadLetters;
  $("home-status").textContent = s.pendingJobs
    ? "Classifying your last session in the background…"
    : `Total spend so far: ${((s.usage.prompt + s.usage.completion) / 1000).toFixed(1)}k tokens`;
}

// ---------------------------------------------------------------- transcript

function addMsg(role, text, meta) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  if (meta) {
    const m = document.createElement("span");
    m.className = "meta";
    m.textContent = meta;
    div.appendChild(m);
  }
  $("transcript").appendChild(div);
  div.scrollIntoView({ block: "end" });
  return div;
}

function setProgress(index, count) {
  $("case-progress").textContent = index != null && index >= 0 ? `Case ${index + 1}/${count}` : "";
}

// ---------------------------------------------------------------- timer

function startTimer(seconds) {
  stopTimer();
  state.timeLimitSeconds = seconds;
  state.clockStart = Date.now();
  if (!seconds) return;
  $("timer").classList.remove("hidden", "urgent");
  const tick = () => {
    const elapsed = (Date.now() - state.clockStart) / 1000;
    const remaining = Math.max(0, seconds - elapsed);
    $("timer-fill").style.transform = `scaleX(${remaining / seconds})`;
    $("timer-text").textContent = `${Math.ceil(remaining)}s`;
    if (remaining / seconds < 0.25) $("timer").classList.add("urgent");
    if (remaining <= 0) {
      $("timer-text").textContent = "over time";
      stopTimer(false);
    }
  };
  tick();
  state.timerHandle = setInterval(tick, 500);
}

function stopTimer(hide = true) {
  if (state.timerHandle) clearInterval(state.timerHandle);
  state.timerHandle = null;
  if (hide) $("timer").classList.add("hidden");
}

// ---------------------------------------------------------------- streaming

async function streamPost(path, body, onDone) {
  state.streaming = true;
  $("send-btn").disabled = true;
  const bubble = addMsg("tutor", "");
  bubble.classList.add("streaming");
  try {
    const res = await api(path, { method: "POST", body: JSON.stringify(body || {}) });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      bubble.textContent = `[error: ${err.error || res.status}]`;
      return null;
    }
    if (res.headers.get("content-type")?.startsWith("application/json")) {
      // non-stream response (e.g. {finished:true})
      bubble.remove();
      return await res.json();
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = null;
    for (;;) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "content") {
          bubble.textContent += event.text;
          bubble.scrollIntoView({ block: "end" });
        } else if (event.type === "done") {
          done = event;
        } else if (event.type === "error") {
          bubble.textContent += `\n[error: ${event.message}]`;
        }
      }
    }
    if (done) onDone?.(done);
    return done;
  } finally {
    bubble.classList.remove("streaming");
    state.streaming = false;
    $("send-btn").disabled = false;
  }
}

// ---------------------------------------------------------------- session flow

async function startSession() {
  $("start-btn").disabled = true;
  try {
    const res = await api("/api/session/start", { method: "POST", body: JSON.stringify({}) });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "failed to start");
      return;
    }
    state.sessionId = data.sessionId;
    localStorage.setItem("trainer.sessionId", data.sessionId);
    $("transcript").innerHTML = "";
    show("session");
    await nextCase();
  } finally {
    $("start-btn").disabled = false;
  }
}

async function nextCase() {
  $("next-btn").classList.add("hidden");
  const done = await streamPost(`/api/session/${state.sessionId}/next`, {}, (d) => {
    setProgress(d.caseIndex, d.caseCount);
    state.answered = false;
    startTimer(d.timeLimitSeconds);
  });
  if (done?.finished) endSession();
}

async function sendMessage() {
  if (state.streaming) return;
  const text = $("input").value.trim();
  if (!text) return;
  $("input").value = "";

  const isCommit = !state.answered;
  const latencyMs = isCommit && state.clockStart ? Date.now() - state.clockStart : null;
  if (isCommit) {
    stopTimer();
    state.answered = true;
    addMsg("me", text, latencyMs ? `committed in ${(latencyMs / 1000).toFixed(1)}s` : null);
  } else {
    addMsg("me", text);
  }

  await streamPost(`/api/session/${state.sessionId}/turn`, { text, latency_ms: latencyMs }, () => {
    $("next-btn").classList.remove("hidden");
  });
}

async function endSession() {
  stopTimer();
  if (state.sessionId) {
    await api(`/api/session/${state.sessionId}/end`, { method: "POST", body: "{}" });
  }
  localStorage.removeItem("trainer.sessionId");
  state.sessionId = null;
  await renderHome();
}

async function resumeSession() {
  const res = await api(`/api/session/${state.sessionId}/transcript`);
  if (!res.ok) return false;
  const t = await res.json();
  if (t.ended) return false;
  $("transcript").innerHTML = "";
  for (const e of t.events) {
    if (e.type === "case_presented" || e.type === "feedback_given") addMsg("tutor", e.payload.text);
    else addMsg("me", e.payload.text, e.payload.latency_ms ? `committed in ${(e.payload.latency_ms / 1000).toFixed(1)}s` : null);
  }
  setProgress(t.caseIndex, t.caseCount);
  state.answered = !!t.answered;
  show("session");
  if (t.caseIndex == null || t.caseIndex < 0) await nextCase();
  else if (t.answered) $("next-btn").classList.remove("hidden");
  else startTimer(t.timeLimitSeconds); // refreshed mid-case: restart clock
  return true;
}

// ---------------------------------------------------------------- wiring

$("start-btn").addEventListener("click", startSession);
$("send-btn").addEventListener("click", sendMessage);
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$("next-btn").addEventListener("click", nextCase);
$("end-btn").addEventListener("click", () => {
  if (confirm("End session? It will be classified in the background.")) endSession();
});
$("anki-push").addEventListener("click", async () => {
  $("anki-status").textContent = "pushing…";
  const res = await api("/api/cards/anki-push", { method: "POST", body: "{}" });
  const data = await res.json();
  $("anki-status").textContent = res.ok ? `pushed ${data.pushed} card(s)` : data.error;
  renderHome();
});
$("tsv-link").addEventListener("click", (e) => {
  e.preventDefault();
  window.location = "/api/cards/export.tsv";
  setTimeout(renderHome, 1000);
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");

(async () => {
  if (state.sessionId && (await resumeSession())) return;
  localStorage.removeItem("trainer.sessionId");
  renderHome();
})();
