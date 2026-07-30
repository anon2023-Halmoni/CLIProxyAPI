// Telegram bot front-end. Long-polling — no public URL, no hosting;
// works from anywhere while the server runs at home.
//
// Enabled when TELEGRAM_BOT_TOKEN is set. Optional TELEGRAM_CHAT_ID
// locks the bot to one chat (recommended — anyone who finds the bot
// could otherwise burn your tokens). The bot replies with the chat id
// on first contact so you can pin it.
//
// Commit latency is measured server-side: from when the case message
// finishes sending to when the answer message arrives.

import { db } from "./db.mjs";
import { createSession, nextCase, userTurn, endSession } from "./engine.mjs";
import { transcribeAudio, transcriptionAvailable } from "./transcribe.mjs";
import { dueCards, nextDueAt, getCard as getReviewCard, gradeCard, previewInterval } from "./review.mjs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_CHAT = process.env.TELEGRAM_CHAT_ID || "";
const CASES_PER_SESSION = Number(process.env.TRAINER_CASES_PER_SESSION || 4);
const API = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

// chatId -> { sessionId, clockStart, busy }
const chats = new Map();

async function tg(method, params) {
  const res = await fetch(API(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
  return data.result;
}

// The tutor speaks markdown; Telegram wants HTML (parse_mode). Convert
// **bold**, *italic*, `code`, # headings and --- rules; escape the rest.
function mdToTelegramHtml(md) {
  let t = md
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  t = t.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/gm, "$1<i>$2</i>");
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  t = t.replace(/^\s*[-—_]{3,}\s*$/gm, "━━━━━━━━━━");
  return t;
}

// Send with HTML formatting; if Telegram rejects the entities (possible
// mid-stream with unbalanced markers), fall back to plain text.
async function send(chatId, text, keyboard) {
  const base = { chat_id: chatId, reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined };
  try {
    return await tg("sendMessage", { ...base, text: mdToTelegramHtml(text), parse_mode: "HTML" });
  } catch {
    return tg("sendMessage", { ...base, text });
  }
}

async function editMessage(chatId, messageId, text) {
  const base = { chat_id: chatId, message_id: messageId };
  try {
    await tg("editMessageText", { ...base, text: mdToTelegramHtml(text), parse_mode: "HTML" });
  } catch (e) {
    if (/message is not modified/.test(e.message)) return;
    await tg("editMessageText", { ...base, text });
  }
}

const KB_AFTER_FEEDBACK = [[{ text: "Next case →", callback_data: "next" }, { text: "End session", callback_data: "end" }]];
const KB_START = [[{ text: "Start session", callback_data: "new" }]];

// Stream a tutor turn into one Telegram message by editing it at most
// every EDIT_MS (Telegram rate-limits edits to ~1/s per chat).
const EDIT_MS = 1500;
async function streamToMessage(chatId, turnFactory) {
  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  let messageId = null;
  let buffer = "";
  let lastEdit = 0;
  let editing = false;

  const flush = async (final = false) => {
    if (editing || !buffer.trim()) return;
    const dueForEdit = Date.now() - lastEdit >= EDIT_MS;
    if (!final && !dueForEdit) return;
    editing = true;
    try {
      if (messageId === null) {
        const msg = await send(chatId, buffer + (final ? "" : " …"));
        messageId = msg.message_id;
      } else {
        await editMessage(chatId, messageId, buffer + (final ? "" : " …"));
      }
      lastEdit = Date.now();
    } catch (e) {
      console.error("telegram edit:", e.message);
    } finally {
      editing = false;
    }
  };

  const result = await turnFactory((text) => {
    buffer += text;
    flush(false); // fire-and-forget; throttled
  });

  if (!result.finished) {
    buffer = result.text; // authoritative final text
    // wait out any in-flight edit, then finalize
    while (editing) await new Promise((r) => setTimeout(r, 50));
    await flush(true);
  }
  return result;
}

// chat -> session survives restarts via the tg_chats table.
function bindChat(chatId, sessionId) {
  db.prepare("INSERT OR REPLACE INTO tg_chats (chat_id, session_id) VALUES (?, ?)").run(chatId, sessionId);
}

function restoreChat(chatId) {
  let chat = chats.get(chatId);
  if (chat) return chat;
  const row = db
    .prepare(
      `SELECT t.session_id FROM tg_chats t JOIN sessions s ON s.id = t.session_id
       WHERE t.chat_id = ? AND s.ended_at IS NULL`,
    )
    .get(chatId);
  if (!row) return null;
  chat = { sessionId: row.session_id, clockStart: null, busy: false };
  chats.set(chatId, chat);
  return chat;
}

function progressBar(index, count) {
  return "🟦".repeat(index + 1) + "⬜".repeat(Math.max(0, count - index - 1));
}

async function presentNext(chatId, chat) {
  const result = await streamToMessage(chatId, (onDelta) => nextCase(chat.sessionId, onDelta));
  if (result.finished) {
    await finishSession(chatId, chat);
    return;
  }
  chat.clockStart = Date.now();
  await send(
    chatId,
    `${progressBar(result.caseIndex, result.caseCount)}  **Case ${result.caseIndex + 1}/${result.caseCount}**\n⏱ **${result.timeLimitSeconds}s** — one diagnosis, one immediate action. The clock is running.`,
  );
}

async function finishSession(chatId, chat) {
  endSession(chat.sessionId);
  chats.delete(chatId);
  // tg_chats binding is kept so the classification result can be pushed here.
  await send(
    chatId,
    "🏁 **Session ended.** Classification runs in the background — I'll ping you here when the verdict lands.",
    KB_START,
  );
}

/** Called by the worker when a session's classification pipeline completes. */
export async function notifyClassified(sessionId, result) {
  if (!TOKEN) return;
  const row = db.prepare("SELECT chat_id FROM tg_chats WHERE session_id = ?").get(sessionId);
  if (!row) return; // web-only session
  const newCards = db
    .prepare(
      `SELECT COUNT(*) n FROM cards c JOIN misses m ON m.id = c.miss_id
       JOIN attempts a ON a.id = m.attempt_id WHERE a.session_id = ?`,
    )
    .get(sessionId).n;
  const brief = db.prepare("SELECT content FROM briefs WHERE session_id = ?").get(sessionId);
  await send(
    row.chat_id,
    `🧠 **Session classified** — ${result.misses}/${result.attempts} attempts missed.${newCards ? `\n🃏 ${newCards} new card(s) — /review.` : ""}${brief ? `\n\n${brief.content}` : ""}`,
  ).catch((e) => console.error("telegram notify:", e.message));
}

async function handleCommand(chatId, chat, text) {
  const cmd = text.split(/[\s@]/)[0].toLowerCase();

  if (cmd === "/start" || cmd === "/help") {
    await send(
      chatId,
      `🩺 **Clinical Reasoning Trainer**\n\nA case arrives as raw clinical material with a time limit. Reply with **one diagnosis and one immediate action** — your response time is measured. The tutor probes misses; answer it. Then next case.\n\n${
        transcriptionAvailable()
          ? "🎤 You can answer by voice note — it is transcribed and judged like a spoken viva answer."
          : "(Voice answers disabled — set GEMINI_API_KEY to enable.)"
      }\n\nCommands:\n/new — start a session\n/review — 🃏 review due flashcards\n/end — end the current session\n/brief — latest post-session brief\n/status — mastery + due summary\n/cards — card counts\n\n(chat id: ${chatId})`,
      KB_START,
    );
    return;
  }
  if (cmd === "/new") {
    if (chat?.sessionId) return send(chatId, "Session already running — /end it first.");
    try {
      const { sessionId } = createSession(CASES_PER_SESSION, "viva");
      const fresh = { sessionId, clockStart: null, busy: false };
      chats.set(chatId, fresh);
      bindChat(chatId, sessionId);
      await presentNext(chatId, fresh);
    } catch (e) {
      await send(chatId, `Could not start: ${e.message}`);
    }
    return;
  }
  if (cmd === "/end") {
    if (!chat?.sessionId) return send(chatId, "No session running.", KB_START);
    await finishSession(chatId, chat);
    return;
  }
  if (cmd === "/brief") {
    const brief = db.prepare("SELECT content, created_at FROM briefs ORDER BY created_at DESC LIMIT 1").get();
    await send(chatId, brief ? `🧠 **Next-session brief**\n\n${brief.content}` : "No brief yet — finish a session first.");
    return;
  }
  if (cmd === "/status") {
    const due = db
      .prepare("SELECT COUNT(*) n FROM mastery WHERE next_due <= strftime('%Y-%m-%dT%H:%M:%fZ','now')")
      .get().n;
    const worst = db
      .prepare("SELECT concept_id, miss_type, misses, attempts FROM mastery WHERE misses > 0 ORDER BY misses DESC LIMIT 6")
      .all();
    const pending = db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('pending','running')").get().n;
    const CHIP = { KNOWLEDGE_GAP: "🟨", CUE_FAILURE: "🟦", SALIENCE_FAILURE: "🟧", ANCHORING: "🟪" };
    const lines = worst.map(
      (w) => `${CHIP[w.miss_type] || "▫️"} \`${w.concept_id}\` — ${w.miss_type.toLowerCase().replaceAll("_", " ")} (${w.misses}/${w.attempts})`,
    );
    await send(
      chatId,
      `📊 **Status**\n${due} concept/miss pairs due.${pending ? " ⏳ Classification in progress…" : ""}\n\n**Weakest:**\n${lines.join("\n") || "▫️ nothing recorded yet"}\n\n🟨 knowledge gap · 🟦 cue failure · 🟧 salience · 🟪 anchoring`,
    );
    return;
  }
  if (cmd === "/cards") {
    const n = db.prepare("SELECT COUNT(*) n FROM cards WHERE exported_at IS NULL").get().n;
    const due = dueCards().length;
    await send(
      chatId,
      `🗂 **${due} card(s) due for review** — /review to start.\n${n} awaiting Anki export (web app: Push to Anki / TSV).`,
    );
    return;
  }
  if (cmd === "/review") {
    await sendReviewCard(chatId);
    return;
  }
  await send(chatId, "Unknown command. /help");
}

// Download a Telegram voice/audio file and transcribe it.
// Returns the transcript, or null after messaging the user about the failure.
async function transcribeTelegramAudio(chatId, fileId, mimeType) {
  try {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });
    const file = await tg("getFile", { file_id: fileId });
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);
    if (!res.ok) throw new Error(`file download failed (${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 20 * 1024 * 1024) throw new Error("voice note too large (>20MB)");
    return await transcribeAudio(buffer, mimeType || "audio/ogg");
  } catch (e) {
    await send(chatId, `Couldn't transcribe that: ${e.message}`);
    return null;
  }
}

async function handleMessage(chatId, text, receivedAt = Date.now()) {
  let chat = restoreChat(chatId);

  if (text.startsWith("/")) return handleCommand(chatId, chat, text);

  if (!chat?.sessionId) {
    return send(chatId, "No session running. /new to start.", KB_START);
  }
  if (chat.busy) return send(chatId, "Hold on — the tutor is still responding.");
  chat.busy = true;
  try {
    // receivedAt (not now) so voice transcription time never counts as thinking time
    const latencyMs = chat.clockStart ? receivedAt - chat.clockStart : null;
    chat.clockStart = null; // only the committed answer is timed
    const result = await streamToMessage(chatId, (onDelta) => userTurn(chat.sessionId, text, latencyMs, onDelta));
    if (latencyMs != null) {
      const limit = result.timeLimitSeconds;
      const overtime = limit && latencyMs > limit * 1000;
      await send(
        chatId,
        `${overtime ? "🟥" : "🟩"} ⏱ committed in **${(latencyMs / 1000).toFixed(1)}s**${overtime ? " — over the limit" : ""}. Answer the probe, or:`,
        KB_AFTER_FEEDBACK,
      );
    } else {
      await send(chatId, "Answer the probe, or:", KB_AFTER_FEEDBACK);
    }
  } catch (e) {
    await send(chatId, `Error: ${e.message}`);
  } finally {
    chat.busy = false;
  }
}

// --- flashcard review (/review) ---

async function sendReviewCard(chatId) {
  const due = dueCards();
  if (due.length === 0) {
    const next = nextDueAt();
    await send(
      chatId,
      `✅ **No cards due.**${next ? ` Next review ${new Date(next).toLocaleString("en-AU", { hour12: false })}.` : " Cards appear here when a session uncovers a knowledge gap."}`,
      KB_START,
    );
    return;
  }
  const card = due[0];
  await send(chatId, `🃏 **Card** (${due.length} due)\n\n${card.front}`, [
    [{ text: "Show answer", callback_data: `rv:s:${card.id}` }],
  ]);
}

async function handleReviewCallback(chatId, data, messageId) {
  const [, action, cardId, grade] = data.split(":");
  const card = getReviewCard(cardId);
  if (!card) return send(chatId, "Card no longer exists.");

  if (action === "s") {
    const remaining = dueCards().length;
    await editMessage(chatId, messageId, `🃏 **Card** (${remaining} due)\n\n${card.front}\n━━━━━━━━━━\n💡 ${card.back}`);
    await tg("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [
            { text: `🟥 Again ${previewInterval(card, "again")}`, callback_data: `rv:g:${card.id}:again` },
            { text: `🟧 Hard ${previewInterval(card, "hard")}`, callback_data: `rv:g:${card.id}:hard` },
          ],
          [
            { text: `🟩 Good ${previewInterval(card, "good")}`, callback_data: `rv:g:${card.id}:good` },
            { text: `🟦 Easy ${previewInterval(card, "easy")}`, callback_data: `rv:g:${card.id}:easy` },
          ],
        ],
      },
    }).catch((e) => console.error("review keyboard:", e.message));
    return;
  }

  if (action === "g") {
    const interval = gradeCard(cardId, grade);
    await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await editMessage(chatId, messageId, `🃏 ${card.front}\n━━━━━━━━━━\n💡 ${card.back}\n\n${{ again: "🟥", hard: "🟧", good: "🟩", easy: "🟦" }[grade]} → ${interval}`);
    await sendReviewCard(chatId);
  }
}

async function handleCallback(chatId, data, callbackId, messageId) {
  await tg("answerCallbackQuery", { callback_query_id: callbackId }).catch(() => {});
  if (data.startsWith("rv:")) return handleReviewCallback(chatId, data, messageId);
  let chat = restoreChat(chatId);
  if (data === "new") return handleCommand(chatId, chat, "/new");
  if (!chat?.sessionId) return send(chatId, "No session running. /new to start.", KB_START);
  if (chat.busy) return;
  chat.busy = true;
  try {
    if (data === "next") await presentNext(chatId, chat);
    else if (data === "end") await finishSession(chatId, chat);
  } catch (e) {
    await send(chatId, `Error: ${e.message}`);
  } finally {
    chat.busy = false;
  }
}

export function startTelegramBot() {
  if (!TOKEN) {
    console.log("telegram: disabled (no TELEGRAM_BOT_TOKEN)");
    return;
  }
  let offset = 0;
  let announced = false;

  (async function poll() {
    for (;;) {
      try {
        if (!announced) {
          const me = await tg("getMe", {});
          console.log(`telegram: polling as @${me.username}${ALLOWED_CHAT ? ` (locked to chat ${ALLOWED_CHAT})` : " (no chat lock — set TELEGRAM_CHAT_ID)"}`);
          // If the trainer has a public HTTPS URL, expose the full web app
          // as a Telegram Mini App via the chat menu button.
          const publicUrl = process.env.TRAINER_PUBLIC_URL || "";
          if (publicUrl.startsWith("https://")) {
            await tg("setChatMenuButton", {
              menu_button: { type: "web_app", text: "Open Trainer", web_app: { url: publicUrl } },
            }).catch((e) => console.error("telegram menu button:", e.message));
            console.log(`telegram: mini app menu button -> ${publicUrl}`);
          }
          announced = true;
        }
        const updates = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
        for (const u of updates) {
          offset = u.update_id + 1;
          const msg = u.message;
          const cb = u.callback_query;
          const chatId = String(msg?.chat?.id ?? cb?.message?.chat?.id ?? "");
          if (!chatId) continue;
          if (ALLOWED_CHAT && chatId !== ALLOWED_CHAT) {
            console.log(`telegram: ignoring chat ${chatId} (locked to ${ALLOWED_CHAT})`);
            continue;
          }
          // handle sequentially per update; failures must not kill the poll loop
          try {
            if (msg?.text) await handleMessage(chatId, msg.text.trim());
            else if (msg?.voice || msg?.audio) {
              const receivedAt = Date.now(); // clock stops when the voice note arrives
              const media = msg.voice || msg.audio;
              const transcript = await transcribeTelegramAudio(chatId, media.file_id, media.mime_type);
              if (transcript) {
                await send(chatId, `🎤 "${transcript}"`);
                await handleMessage(chatId, transcript, receivedAt);
              }
            } else if (cb) await handleCallback(chatId, cb.data, cb.id, cb.message?.message_id);
          } catch (e) {
            console.error("telegram update failed:", e);
          }
        }
      } catch (e) {
        console.error("telegram poll error:", e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
}
