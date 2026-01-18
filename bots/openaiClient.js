const OpenAI = require("openai");
const { scrubPHI } = require("./phiScrubber");

// Robust key handling for hosted envs (Render)
// - trims whitespace
// - accepts any non-empty key (some org keys may not start with "sk-" depending on provider)
// - fails closed if missing
const rawKey = String(process.env.OPENAI_API_KEY || "").trim();

const openai = rawKey
? new OpenAI({ apiKey: rawKey })
: null;

// ------------------------------------------------------------
// Minimal redaction for CONVERSION endpoints (do not destroy templates)
// - Only redact obviously identifying tokens
// - DO NOT replace general headings with PT-XXXX
// ------------------------------------------------------------
function minimalRedact(text) {
  let t = String(text || "");

  // Email
  t = t.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");

  // Phone (very loose US patterns)
  t = t.replace(/\b(?:\+?1[\s\-\.]?)?(?:\(\s*\d{3}\s*\)|\d{3})[\s\-\.]?\d{3}[\s\-\.]?\d{4}\b/g, "[REDACTED_PHONE]");

  // SSN
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]");

  return t;
}

// INCREASED timeoutMs to 90000 (90 seconds) to handle large notes
async function callOpenAIJSON(prompt, timeoutMs = 90000) {
  if (!openai) throw new Error("OPENAI_API_KEY missing");
  
  const safePrompt = minimalRedact(prompt);
const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const resp = await openai.responses.create(
                                               {
                                                 model: process.env.OPENAI_MODEL || "gpt-4o-mini",
                                                 input: safePrompt,
                                                 // Give the AI room to process long notes
                                                 max_output_tokens: 4000,
                                                 text: {
                                                   format: {
                                                     type: "json_object",
                                                   },
                                                 },
                                               },
                                               { signal: controller.signal }
                                               );
    
    const text =
    resp.output?.find((o) => o.type === "message")
    ?.content?.find((c) => c.type === "output_text")
    ?.text ?? "";
    
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

// INCREASED default timeout here as well
async function callOpenAIText(prompt, timeoutMs = 60000) {
  if (!openai) throw new Error("OPENAI_API_KEY missing");
  
  const safePrompt = minimalRedact(prompt);
const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const resp = await openai.responses.create(
                                               {
                                                 model: process.env.OPENAI_MODEL || "gpt-4o-mini",
                                                 input: safePrompt,
                                                 max_output_tokens: 4000,
                                               },
                                               { signal: controller.signal }
                                               );
    
    return (
            resp.output?.find((o) => o.type === "message")
            ?.content?.find((c) => c.type === "output_text")
            ?.text ?? ""
            );
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------
// HH PT Evaluation Assessment Summary Prompt (6 sentences exact)
// - Randomized sentence openers (chosen in JS, not by the model)
// - Always ends with: "Continued skilled HH PT remains indicated."
// ------------------------------------------------------------
function buildHHEvalAssessmentPrompt({
  age,
  gender,
  relevantMedicalHistory,
  primaryProblems,
  assistiveDeviceText,
} = {}) {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const ageTxt = String(age ?? "").trim();
  const genderTxt = String(gender ?? "").trim();
  const pmhTxt = String(relevantMedicalHistory ?? "").trim();
  const probsTxt = String(primaryProblems ?? "generalized weakness with impaired bed mobility, transfers, gait, and balance").trim();
  const adTxt = String(assistiveDeviceText ?? "AD").trim();

  const s1Open = pick([
    "Pt is a",
    "Pt is a pleasant",
    "Pt is a",
    "Pt is a",
  ]);

  const s2Open = pick([
    "Pt is seen today for",
    "Pt was evaluated today for",
    "Pt is seen for",
    "Today, pt is seen for",
  ]);

  const s3Open = pick([
    "Currently, pt demonstrates",
    "At this time, pt presents with",
    "Pt currently demonstrates",
    "Pt presents with",
  ]);

  const s4Open = pick([
    "Pt exhibits",
    "Pt demonstrates",
    "Pt displays",
    "Pt shows",
  ]);

  const s5Open = pick([
    "Skilled HH PT services are medically necessary to",
    "Skilled HH PT is medically necessary to",
    "Skilled PT services are required to",
    "Skilled HH PT intervention is indicated to",
  ]);

  // Prompt forces EXACTLY 6 sentences. Sentence 6 must be the exact required closing phrase.
  // No numbering, no bullets, no line breaks.
  return `
Write an Assessment Summary for a Medicare home health physical therapy INITIAL EVALUATION.
Output EXACTLY 6 sentences total, in one paragraph, no line breaks, no numbering, no bullets, no quotes.
Sentence 6 MUST be exactly: Continued skilled HH PT remains indicated.

Use this patient context (do not invent new diagnoses or demographics):
- Age: ${ageTxt || "___"}
- Gender: ${genderTxt || "___"}
- Relevant Medical History (PMH): ${pmhTxt || "___"}
- Primary problems/impairments: ${probsTxt}
- Assistive device wording: ${adTxt}

Required content rules:
- Sentence 1: demographics + PMH (use only provided PMH; do not add).
- Sentence 2: must include PT initial evaluation + home safety assessment + DME assessment + HEP education + fall safety precautions/fall prevention + education on proper use of ${adTxt} + education on pain/edema management + PT POC/goal planning to return toward PLOF.
- Sentence 3: objective functional deficits (bed mobility, transfers, gait, balance, generalized weakness) and high fall risk linkage.
- Sentence 4: safety awareness/balance reactions and home risk statement (high fall risk).
- Sentence 5: skilled need/medical necessity statement describing skilled interventions (TherEx, functional training, gait/balance training, safety education) to improve function and reduce fall/injury risk.
- Do NOT mention any visit counts (no "within 4 visits", no total visits).
- Keep language professional, objective, and Medicare-appropriate.

Sentence openers (use exactly these starters for sentences 1–5):
1) ${s1Open}
2) ${s2Open}
3) ${s3Open}
4) ${s4Open}
5) ${s5Open}
`.trim();
}

module.exports = {
  callOpenAIJSON,
  callOpenAIText,
  buildHHEvalAssessmentPrompt,

};


// Vision JSON: accepts an image data URL (data:image/png;base64,...) and a text prompt
async function callOpenAIImageJSON(prompt, imageDataUrl, timeoutMs = 90000) {
  if (!openai) throw new Error("OPENAI_API_KEY missing");
  if (!imageDataUrl) throw new Error("imageDataUrl missing");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await openai.responses.create(
      {
        model: process.env.OPENAI_MODEL_VISION || process.env.OPENAI_MODEL || "gpt-4o-mini",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: imageDataUrl },
            ],
          },
        ],
        max_output_tokens: 4000,
        text: { format: { type: "json_object" } },
      },
      { signal: controller.signal }
    );

    const text =
      resp.output?.find((o) => o.type === "message")
        ?.content?.find((c) => c.type === "output_text")
        ?.text ?? "";

    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

module.exports.callOpenAIImageJSON = callOpenAIImageJSON;
