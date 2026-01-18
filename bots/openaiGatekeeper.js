// bots/openaiGatekeeper.js
const OpenAI = require("openai");
const crypto = require("crypto");
const { scrubPHI, detectPHI } = require("./phiScrubber");

/**
 * IMPORTANT HIPAA SAFEGUARD
 * - We never send raw notes to OpenAI.
 * - We scrub first, then detect again.
 * - If anything still looks like PHI => hard block (fail closed).
 */

const client = process.env.OPENAI_API_KEY
? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
: null;

function sha12(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex").slice(0, 12);
}

function sanitizeAndAssertNonPHI(rawText, { allowEmpty = false } = {}) {
  const input = String(rawText || "");
  
  const scrubbed = scrubPHI ? scrubPHI(input) : input;
  
  const findings = detectPHI ? detectPHI(scrubbed) : [];
  if (findings && findings.length) {
    const types = findings.map(f => f.type || "unknown").join(",");
    const msg = `PHI_BLOCKED types=${types} hash=${sha12(scrubbed)}`;
    const err = new Error(msg);
    err.code = "PHI_BLOCKED";
    err.findings = findings;
    throw err;
  }
  
  if (!allowEmpty && !scrubbed.trim()) return "";
  
  return scrubbed;
}

/**
 * Call OpenAI but ONLY after PHI scrubbing + re-check.
 * Use Responses API with text.format for structured JSON.
 */
async function callOpenAI_NON_PHI({
  promptText,
  schema,
  model = process.env.OPENAI_MODEL || "gpt-4o-mini",
}) {
  if (!client) {
    const err = new Error("OPENAI_DISABLED (missing OPENAI_API_KEY)");
    err.code = "OPENAI_DISABLED";
    throw err;
  }
  
  const safePrompt = sanitizeAndAssertNonPHI(promptText, { allowEmpty: false });
  
  return await client.responses.create({
    model,
    input: safePrompt,
    text: {
      format: {
        type: "json_schema",
        strict: true,
        schema,
      },
    },
  });
}

/**
 * Convenience helper: get parsed JSON object from Responses output.
 */
async function callOpenAI_NON_PHI_JSON(args) {
  const resp = await callOpenAI_NON_PHI(args);
  
  const msg = resp.output?.find(o => o.type === "message");
  const outText = msg?.content?.find(c => c.type === "output_text")?.text;
  
  if (!outText) return null;
  
  try {
    return JSON.parse(outText);
  } catch (e) {
    const err = new Error("OPENAI_JSON_PARSE_FAILED");
    err.code = "OPENAI_JSON_PARSE_FAILED";
    err.raw = outText.slice(0, 500);
    throw err;
  }
}



/**
 * Non-PHI TEXT call (no structured JSON format).
 * Use for visit summaries where we want plain text output.
 */
async function callOpenAI_NON_PHI_TEXT({
  promptText,
  model = process.env.OPENAI_MODEL || "gpt-4o-mini",
}) {
  if (!client) {
    const err = new Error("OPENAI_DISABLED (missing OPENAI_API_KEY)");
    err.code = "OPENAI_DISABLED";
    throw err;
  }

  const safePrompt = sanitizeAndAssertNonPHI(promptText, { allowEmpty: false });

  return await client.responses.create({
    model,
    input: safePrompt,
    // IMPORTANT: no text.format => avoids 'text.format.*' required params
    max_output_tokens: 1200,
  });
}

module.exports = {
  callOpenAI_NON_PHI,
  callOpenAI_NON_PHI_TEXT,
  callOpenAI_NON_PHI_JSON,
  sanitizeAndAssertNonPHI,
};
