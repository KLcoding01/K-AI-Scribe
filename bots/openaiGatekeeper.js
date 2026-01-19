// bots/openaiGatekeeper.js
const OpenAI = require("openai");
const crypto = require("crypto");
const { scrubPHI } = require("./phiScrubber");

/**
 * HIPAA guardrail:
 * - Scrub first (template-safe)
 * - Then detect residual PHI values (NOT just labels)
 * - If residual PHI remains => hard block (fail closed)
 */

const rawKey = String(process.env.OPENAI_API_KEY || "").trim();
const client = rawKey ? new OpenAI({ apiKey: rawKey }) : null;

function sha12(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex").slice(0, 12);
}

/**
 * Residual PHI detection on SCRUBBED text.
 * IMPORTANT: Do NOT flag benign labels like "DOB:" if they are already redacted.
 */
function detectResidualPHI(scrubbedText = "") {
  const t = String(scrubbedText || "");
  
  const findings = [];
  
  // High-confidence anywhere
  const tests = [
    { type: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
    { type: "phone", re: /\b(?:\+?1[\s\-\.]?)?(?:\(\s*\d{3}\s*\)|\d{3})[\s\-\.]?\d{3}[\s\-\.]?\d{4}\b/ },
    { type: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
    
    // Strong addresses only
    { type: "address_street", re: /\b\d{1,6}\s+[A-Za-z0-9.\-'\s]{2,40}\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Circle|Cir|Terrace|Ter|Highway|Hwy|Parkway|Pkwy)\b/i },
    { type: "address_city_state_zip", re: /\b[A-Z][a-zA-Z.\-']+(?:\s+[A-Z][a-zA-Z.\-']+)*,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?\b/ },
    
    // High-confidence chart name
    { type: "name_last_first", re: /\b[A-Z][a-z]+,\s*[A-Z][a-z]+\b/ },
  ];
  
  for (const { type, re } of tests) {
    const m = t.match(re);
    if (m) findings.push({ type, match: String(m[0]).slice(0, 80) });
  }
  
  // Labeled field residuals (only if NOT already redacted)
  // Example: "DOB: 01/02/2026" should fail, but "DOB: [REDACTED_DOB]" should pass
  const labeledResiduals = [
    {
      type: "dob_value",
      re: /(^|\n)\s*(DOB|D\.O\.B\.|Date of Birth)\s*[:#\-]?\s*(?!\[REDACTED_DOB\]|\[REDACTED\]|\[DOB\]|\bMM\/YYYY\b)([^\n]+)/i
    },
    {
      type: "mrn_value",
      re: /(^|\n)\s*(MRN|M#|Member\s*ID|MemberID|Policy\s*#|Policy#|Acct\s*#|Acct#|Account\s*#|Account#|Chart\s*#|Chart#)\s*[:#\-]?\s*(?!\[REDACTED_ID\]|\[ID\]|\[REDACTED\])([^\n]+)/i
    },
    {
      type: "name_value",
      re: /(^|\n)\s*(Patient Name|Pt Name|Patient|Pt|Name|Member|Client)\s*[:#\-]?\s*(?!PT-XXXX|\[REDACTED\]|\[NAME\])([A-Z][^\n]+)/i
    },
    {
      type: "address_value",
      re: /(^|\n)\s*(Address|Home Address|Mailing Address|Street Address)\s*[:#\-]?\s*(?!\[ADDRESS\]|\[REDACTED\])([^\n]+)/i
    },
  ];
  
  for (const item of labeledResiduals) {
    const m = t.match(item.re);
    if (m) findings.push({ type: item.type, match: String(m[0]).slice(0, 80) });
  }
  
  return findings;
}

function sanitizeAndAssertNonPHI(rawText, { allowEmpty = false } = {}) {
  const input = String(rawText || "");
  const scrubbed = scrubPHI ? scrubPHI(input) : input;
  
  const findings = detectResidualPHI(scrubbed);
  if (findings.length) {
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

async function withAbort(timeoutMs, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call OpenAI with JSON Schema enforcement (best for strict pipelines).
 */
async function callOpenAI_NON_PHI({
  promptText,
  schema,
  model = process.env.OPENAI_MODEL || "gpt-4o-mini",
  timeoutMs = 90000,
  max_output_tokens = 4000,
  temperature = 0,
} = {}) {
  if (!client) {
    const err = new Error("OPENAI_DISABLED (missing OPENAI_API_KEY)");
    err.code = "OPENAI_DISABLED";
    throw err;
  }
  
  const safePrompt = sanitizeAndAssertNonPHI(promptText, { allowEmpty: false });
  
  return await withAbort(timeoutMs, (signal) =>
                         client.responses.create(
                                                 {
                                                   model,
                                                   input: safePrompt,
                                                   max_output_tokens,
                                                   temperature,
                                                   text: {
                                                     format: {
                                                       type: "json_schema",
                                                       strict: true,
                                                       schema,
                                                     },
                                                   },
                                                 },
                                                 { signal }
                                                 )
                         );
}

/**
 * Call OpenAI with json_object enforcement (simpler than schema).
 */
async function callOpenAI_NON_PHI_JSON_OBJECT({
  promptText,
  model = process.env.OPENAI_MODEL || "gpt-4o-mini",
  timeoutMs = 90000,
  max_output_tokens = 4000,
  temperature = 0,
} = {}) {
  if (!client) {
    const err = new Error("OPENAI_DISABLED (missing OPENAI_API_KEY)");
    err.code = "OPENAI_DISABLED";
    throw err;
  }
  
  const safePrompt = sanitizeAndAssertNonPHI(promptText, { allowEmpty: false });
  
  return await withAbort(timeoutMs, (signal) =>
                         client.responses.create(
                                                 {
                                                   model,
                                                   input: safePrompt,
                                                   max_output_tokens,
                                                   temperature,
                                                   text: { format: { type: "json_object" } },
                                                 },
                                                 { signal }
                                                 )
                         );
}

async function parseResponsesJSON(resp) {
  const msg = resp.output?.find((o) => o.type === "message");
  const outText = msg?.content?.find((c) => c.type === "output_text")?.text ?? "";
  if (!outText) return null;
  return JSON.parse(outText);
}

async function callOpenAI_NON_PHI_JSON(args) {
  const resp = await callOpenAI_NON_PHI(args);
  try {
    return await parseResponsesJSON(resp);
  } catch (e) {
    const err = new Error("OPENAI_JSON_PARSE_FAILED");
    err.code = "OPENAI_JSON_PARSE_FAILED";
    err.raw = String(e?.message || "").slice(0, 200);
    throw err;
  }
}

async function callOpenAI_NON_PHI_TEXT({
  promptText,
  model = process.env.OPENAI_MODEL || "gpt-4o-mini",
  timeoutMs = 60000,
  max_output_tokens = 1200,
  temperature = 0,
} = {}) {
  if (!client) {
    const err = new Error("OPENAI_DISABLED (missing OPENAI_API_KEY)");
    err.code = "OPENAI_DISABLED";
    throw err;
  }
  
  const safePrompt = sanitizeAndAssertNonPHI(promptText, { allowEmpty: false });
  
  return await withAbort(timeoutMs, (signal) =>
                         client.responses.create(
                                                 {
                                                   model,
                                                   input: safePrompt,
                                                   max_output_tokens,
                                                   temperature,
                                                 },
                                                 { signal }
                                                 )
                         );
}

module.exports = {
  sanitizeAndAssertNonPHI,
  callOpenAI_NON_PHI,
  callOpenAI_NON_PHI_JSON,
  callOpenAI_NON_PHI_TEXT,
  callOpenAI_NON_PHI_JSON_OBJECT,
  parseResponsesJSON,
};
