// Speech-to-text for voice answers. Z.ai exposes no ASR model to
// coding-plan keys (probed 2026-07-30: all ASR model names return 1211),
// so this uses the Google Gemini API, which accepts Telegram's OGG/Opus
// voice notes directly. Free key: https://aistudio.google.com/apikey

const GEMINI_MODEL = process.env.GEMINI_ASR_MODEL || "gemini-2.5-flash";

const PROMPT =
  "Transcribe this audio verbatim. It is a medical student speaking a clinical answer — expect drug names, doses and abbreviations (IM, IV, BGL, GCS, mcg, mg). Return ONLY the transcript text, no preamble, no quotes.";

export function transcriptionAvailable() {
  return !!process.env.GEMINI_API_KEY;
}

/**
 * Transcribe an audio buffer. mimeType e.g. "audio/ogg" (Telegram voice),
 * "audio/webm", "audio/mp4", "audio/wav". Returns the transcript string.
 */
export async function transcribeAudio(buffer, mimeType) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "Voice answers need GEMINI_API_KEY in trainer/.env — free key at https://aistudio.google.com/apikey",
    );
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } },
              { text: PROMPT },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini transcription ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const transcript = (json.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();
  if (!transcript) throw new Error("Gemini returned an empty transcript");
  return transcript;
}
