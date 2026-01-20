const OpenAI = require("openai");
const { scrubPHI, detectPHI } = require("./phiScrubber");

// Robust key handling for hosted envs (Render)
const rawKey = String(process.env.OPENAI_API_KEY || "").trim();
const openai = rawKey ? new OpenAI({ apiKey: rawKey }) : null;

/**
 * Strip PHI label lines that can trigger upstream PHI_BLOCKED types=name_label
 * Drops whole lines that begin with obvious identifier labels.
 * This is safe because it removes only identifiers, not clinical content.
 */
function stripPHILabelLines(text) {
  const t = String(text || "");
  if (!t) return t;

  const lines = t.replace(/\r\n/g, "\n").split("\n");

  // Very conservative: only lines that START with these labels
  const labelLineRE =
    /^\s*(?:patient\s*)?(?:name|mrn|member\s*id|policy\s*#|acct\s*#|account\s*#|dob|date\s*of\s*birth|address|phone|email|physician|md|dr\.?|pcp|agency|facility|provider)\s*[:#-]/i;

  const kept = [];
  for (const line of lines) {
    if (labelLineRE.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

// ------------------------------------------------------------
// Minimal redaction for CONVERSION endpoints (do not destroy templates)
// - Only redact obviously identifying tokens
// - PLUS: strip PHI label lines to prevent name_label blocks
// ------------------------------------------------------------
function minimalRedact(text) {
  let t = String(text || "");

  // Prevent "name_label" blocks even when value is blank
  t = stripPHILabelLines(t);

  // Email
  t = t.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");

  // Phone (US-ish)
  t = t.replace(
    /\b(?:\+?1[\s\-\.]?)?(?:\(\s*\d{3}\s*\)|\d{3})[\s\-\.]?\d{3}[\s\-\.]?\d{4}\b/g,
    "[REDACTED_PHONE]"
  );

  // SSN
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]");

  return t;
}

/**
 * Strict PHI safe (used for HH Assessment Summary context fields):
 * - remove label lines
 * - scrub values
 * - keep conservative posture (no throwing, no PHI logs)
 */
function strictPHISafe(text) {
  let out = stripPHILabelLines(String(text || ""));
  out = scrubPHI(out);
  try { detectPHI(out); } catch {}
  return out;
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
// - avoids PHI labels/values by scrubbing each context field
// - sentence 6 required exact closing phrase
// ------------------------------------------------------------
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
Write an Assessment Summary for a Medicare home health physical therapy INITIAL EVALUATION.

Output EXACTLY 6 sentences total, in one paragraph, no line breaks, no numbering, no bullets.
Each sentence MUST start with "Pt".
Do NOT use he/she/they/his/her/their.
Do NOT include any names, facilities, providers, agencies, or identifiers.
Do NOT mention visit counts.
Sentence 6 MUST be exactly: Continued skilled HH PT remains indicated.

Use only this context (do not invent new diagnoses or demographics):
Age: ${ageTxt}
Gender: ${genderTxt}
Relevant Medical History (PMH): ${pmhTxt}
Primary problems/impairments: ${probsTxt}
Assistive device wording: ${adTxt}

Required content rules:
- Sentence 1: demographics + PMH only (use only provided PMH; do not add).
- Sentence 2: PT initial evaluation + home safety assessment + DME assessment + HEP education + fall prevention + education on proper use of ${adTxt} + pain/edema management + POC/goal planning toward PLOF.
- Sentence 3: objective deficits (bed mobility, transfers, gait, balance, generalized weakness) linked to HIGH fall risk.
- Sentence 4: safety awareness/balance reactions + home risk statement stating HIGH fall risk.
- Sentence 5: medical necessity with skilled interventions (TherEx, functional training, gait/balance training, safety education).
- Sentence 6: Continued skilled HH PT remains indicated.
`.trim();
}

// Vision JSON (unchanged behavior; prompt still passes through minimalRedact)
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
              { type: "input_text", text: minimalRedact(prompt) },
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

module.exports = {
  callOpenAIJSON,
  callOpenAIText,
  buildHHEvalAssessmentPrompt,
  callOpenAIImageJSON,
};
