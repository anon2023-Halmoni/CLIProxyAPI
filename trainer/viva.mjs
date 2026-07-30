// Interactive viva in the terminal — the tutor (spec §6.1) on GLM-5.2.
//
// Usage:
//   node trainer/viva.mjs              # run a viva
//   node trainer/viva.mjs --thinking   # also show the model's reasoning
//
// Type your committed answer and press Enter. Your response latency is
// measured from the moment the tutor finishes speaking (spec §3.3:
// clock on everything). Type "quit" to end the session.

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { streamChat } from "./lib/glm.mjs";

const SHOW_THINKING = process.argv.includes("--thinking");

const TUTOR_SYSTEM_PROMPT = `You are a senior clinician running a viva. You are not an assistant.

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
8. When the candidate says they are done, give a one-paragraph
   performance summary: each case, what was missed, and whether
   the miss was absent knowledge, an unrecognised cue, under-
   escalation, or anchoring.

Australian guidelines. Adult acute care unless stated.`;

const messages = [
  { role: "system", content: TUTOR_SYSTEM_PROMPT },
  { role: "user", content: "Begin. Present the first case." },
];

async function tutorTurn() {
  let inReasoning = false;
  stdout.write("\n");
  await streamChat(messages, {
    maxTokens: 2048,
    onDelta: ({ type, text }) => {
      if (type === "reasoning") {
        if (!SHOW_THINKING) return;
        if (!inReasoning) {
          stdout.write("\x1b[2m[thinking] ");
          inReasoning = true;
        }
        stdout.write(text.replaceAll("\n", " "));
      } else {
        if (inReasoning) {
          stdout.write("\x1b[0m\n\n");
          inReasoning = false;
        }
        stdout.write(text);
      }
    },
  }).then(({ content }) => {
    messages.push({ role: "assistant", content });
  });
  stdout.write("\n");
}

const rl = readline.createInterface({ input: stdin, output: stdout });

await tutorTurn();
for (;;) {
  const clockStart = Date.now();
  let answer;
  try {
    answer = (await rl.question("\n> ")).trim();
  } catch {
    break; // stdin closed (Ctrl+D or piped input ended)
  }
  if (!answer) continue;
  if (["quit", "exit", "q"].includes(answer.toLowerCase())) break;
  const latencySeconds = ((Date.now() - clockStart) / 1000).toFixed(1);
  stdout.write(`\x1b[2m[${latencySeconds}s]\x1b[0m\n`);
  messages.push({
    role: "user",
    content: `${answer}\n\n[response latency: ${latencySeconds}s]`,
  });
  await tutorTurn();
}
rl.close();
