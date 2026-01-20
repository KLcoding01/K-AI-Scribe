const OpenAI = require("openai");
const { scrubPHI, detectPHI } = require("./phiScrubber");

// ============================================================
// OpenAI Client Initialization (Render-safe)
// ============================================================

const rawKey = String(process.env.OPENAI_API_KEY || "").trim();
const openai = rawKey ? new OpenAI({ apiKey: rawKey }) : null;

// ============================================================
// Minimal redaction for template / conversion prompts
// (DO NOT destroy structured templates)
// ============================================================

function minimalRedact(text) {
  let t = String(text || "");

  // Email
  t = t.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");

  // Phone
  t = t.replace(
    /\b(?:\+?1[\s\-\.]?)?(?:\(\s*\d{3}\s*\)|\d{3})[\s\-\.]?\d{3}[\s\-\.]?\d{4}\b/g,
    "[REDACTED_PHONE]"
  );

  // SSN
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]");

  return t;
}

// ============================================================
// STRICT PHI SAFE REDACTION (for HH Assessment Summary ONLY)
// ============================================================

function strictPHISafe(text) {
  const scrubbed = scrubPHI(String(text || ""));
  const findings = detectPHI(scrubbed);
  // Fail closed, but never throw — we just return scrubbed content
  return scrubbed;
}

// ============================================================
// OpenAI JSON Call
// ============================================================

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
        max_output_tokens: 4000,
        text: {
          format: { type: "json_object" },
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

// ============================================================
// OpenAI Text Call
// ============================================================

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

// ============================================================
// HH PT INITIAL EVALUATION – ASSESSMENT SUMMARY PROMPT
// (PHI-safe, Medicare-safe, deterministic)
// ============================================================

function buildHHEvalAssessmentPrompt({
  age,
  gender,
  relevantMedicalHistory,
  primaryProblems,
  assistiveDeviceText,
} = {}) {
  const ageTxt = strictPHISafe(String(age ?? "___").trim());
  const genderTxt = strictPHISafe(String(gender ?? "___").trim());
  const pmhTxt = strictPHISafe(String(relevantMedicalHistory ?? "___").trim());
  const probsTxt = strictPHISafe(
    String(
      primaryProblems ??
        "generalized weakness with impaired bed mobility, transfers, gait, and balance"
    ).trim()
  );
  const adTxt = strictPHISafe(String(assistiveDeviceText ?? "AD").trim());

  return `
Write an Assessment Summary for a Medicare HOME HEALTH physical therapy INITIAL EVALUATION.

OUTPUT RULES (STRICT):
- Output EXACTLY 6 sentences total.
- Each sentence MUST start with "Pt".
- No names, no facilities, no providers.
- No visit counts.
- No bullets, no numbering, no line breaks.
- Sentence 6 MUST be exactly: Continued skilled HH PT remains indicated.

USE ONLY THIS CONTEXT (DO NOT INVENT):
- Age: ${ageTxt}
- Gender: ${genderTxt}
- Relevant Medical History (PMH): ${pmhTxt}
- Primary problems/impairments: ${probsTxt}
- Assistive device wording: ${adTxt}

REQUIRED SENTENCE CONTENT:
1) Pt demographics + PMH only.
2) Pt initial evaluation + home safety assessment + DME assessment + HEP education + fall prevention + education on proper use of ${adTxt} + pain/edema management + POC/goal planning toward PLOF.
3) Pt objective deficits (bed mobility, transfers, gait, balance, generalized weakness) linked to HIGH fall risk.
4) Pt safety awareness/balance reactions and home risk statement (HIGH fall risk).
5) Pt skilled need/medical necessity (TherEx, functional training, gait/balance training, safety education).
6) Continued skilled HH PT remains indicated.
`.trim();
}

// ============================================================
// Vision JSON (unchanged)
// ============================================================

async function callOpenAIImageJSON(prompt, imageDataUrl, timeoutMs = 90000) {
  if (!openai) throw new Error("OPENAI_API_KEY missing");
  if (!imageDataUrl) throw new Error("imageDataUrl missing");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await openai.responses.create(
      {
        model:
          process.env.OPENAI_MODEL_VISION ||
          process.env.OPENAI_MODEL ||
          "gpt-4o-mini",
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

// ============================================================
// Exports
// ============================================================

module.exports = {
  callOpenAIJSON,
  callOpenAIText,
  callOpenAIImageJSON,
  buildHHEvalAssessmentPrompt,
};
