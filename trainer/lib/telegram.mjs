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

async function send(chatId, text, keyboard) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });
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
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: buffer + (final ? "" : " …"),
        });
      }
      lastEdit = Date.now();
    } catch (e) {
      if (!/message is not modified/.test(e.message)) console.error("telegram edit:", e.message);
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

async function presentNext(chatId, chat) {
  const result = await streamToMessage(chatId, (onDelta) => nextCase(chat.sessionId, onDelta));
  if (result.finished) {
    await finishSession(chatId, chat);
    return;
  }
  chat.clockStart = Date.now();
  await send(
    chatId,
    `Case ${result.caseIndex + 1}/${result.caseCount} — ⏱ ${result.timeLimitSeconds}s. One diagnosis, one immediate action. The clock is running.`,
  );
}

async function finishSession(chatId, chat) {
  endSession(chat.sessionId);
  chats.delete(chatId);
  await send(
    chatId,
    "Session ended. Classification runs in the background — /brief in a few minutes for the verdict, /cards for new Anki cards.",
    KB_START,
  );
}

async function handleCommand(chatId, chat, text) {
  const cmd = text.split(/[\s@]/)[0].toLowerCase();

  if (cmd === "/start" || cmd === "/help") {
    await send(
      chatId,
      `Clinical Reasoning Trainer.\n\nA case arrives as raw clinical material with a time limit. Reply with ONE diagnosis and ONE immediate action — your response time is measured. The tutor probes misses; answer it. Then next case.\n\nCommands:\n/new — start a session\n/end — end the current session\n/brief — latest post-session brief\n/status — mastery + due summary\n/cards — unexported card count\n\n(chat id: ${chatId})`,
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
    await send(chatId, brief ? brief.content : "No brief yet — finish a session first.");
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
    const lines = worst.map((w) => `• ${w.concept_id} — ${w.miss_type.toLowerCase().replaceAll("_", " ")} (${w.misses}/${w.attempts})`);
    await send(
      chatId,
      `${due} concept/miss pairs due.${pending ? " Classification in progress…" : ""}\n\nWeakest:\n${lines.join("\n") || "• nothing recorded yet"}`,
    );
    return;
  }
  if (cmd === "/cards") {
    const n = db.prepare("SELECT COUNT(*) n FROM cards WHERE exported_at IS NULL").get().n;
    await send(chatId, `${n} card(s) awaiting export. Export from the web app (Push to Anki / TSV) at your server.`);
    return;
  }
  await send(chatId, "Unknown command. /help");
}

async function handleMessage(chatId, text) {
  let chat = chats.get(chatId);

  if (text.startsWith("/")) return handleCommand(chatId, chat, text);

  if (!chat?.sessionId) {
    return send(chatId, "No session running. /new to start.", KB_START);
  }
  if (chat.busy) return send(chatId, "Hold on — the tutor is still responding.");
  chat.busy = true;
  try {
    const latencyMs = chat.clockStart ? Date.now() - chat.clockStart : null;
    chat.clockStart = null; // only the committed answer is timed
    const result = await streamToMessage(chatId, (onDelta) => userTurn(chat.sessionId, text, latencyMs, onDelta));
    if (latencyMs != null) {
      const limit = result.timeLimitSeconds;
      const overtime = limit && latencyMs > limit * 1000;
      await send(
        chatId,
        `⏱ committed in ${(latencyMs / 1000).toFixed(1)}s${overtime ? " — over the limit" : ""}. Answer the probe, or:`,
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

async function handleCallback(chatId, data, callbackId) {
  await tg("answerCallbackQuery", { callback_query_id: callbackId }).catch(() => {});
  let chat = chats.get(chatId);
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
            else if (cb) await handleCallback(chatId, cb.data, cb.id);
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
