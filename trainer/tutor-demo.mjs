// M1-flavoured smoke test: the tutor (spec §6.1) running on GLM-5.2 with
// thinking mode, streaming a label-free case to the terminal.
//
// Usage: node trainer/tutor-demo.mjs

import { streamChat } from "./lib/glm.mjs";

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

Australian guidelines. Adult acute care unless stated.`;

const messages = [
  { role: "system", content: TUTOR_SYSTEM_PROMPT },
  { role: "user", content: "Begin. Present the first case." },
];

let inReasoning = false;
const { usage } = await streamChat(messages, {
  maxTokens: 1024,
  onDelta: ({ type, text }) => {
    if (type === "reasoning") {
      if (!inReasoning) {
        process.stdout.write("\n[thinking] ");
        inReasoning = true;
      }
      process.stdout.write(text.replaceAll("\n", " "));
    } else {
      if (inReasoning) {
        process.stdout.write("\n\n[tutor]\n");
        inReasoning = false;
      }
      process.stdout.write(text);
    }
  },
});

process.stdout.write("\n\n---\n");
console.log("usage:", JSON.stringify(usage));
