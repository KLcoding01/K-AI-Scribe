// bots/openaiClient.js
const {
  callOpenAI_NON_PHI_TEXT,
  callOpenAI_NON_PHI_JSON_OBJECT,
  parseResponsesJSON,
  sanitizeAndAssertNonPHI,
} = require("./openaiGatekeeper");

// Lightweight helper: robustly extract message text from Responses API
function extractResponseText(resp) {
  return (
          resp.output?.find((o) => o.type === "message")
          ?.content?.find((c) => c.type === "output_text")
          ?.text ?? ""
          );
}

/**
 * Backwards-compatible call used by ptEvaluation.solo.js:
 * - Accepts (prompt, timeoutMs, opts)
 * - Returns parsed JSON object
 */
async function callOpenAIJSON(prompt, timeoutMs = 90000, opts = {}) {
  const model = opts.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const max_output_tokens = typeof opts.max_output_tokens === "number" ? opts.max_output_tokens : 4000;
  
  const resp = await callOpenAI_NON_PHI_JSON_OBJECT({
    promptText: prompt,
    model,
    timeoutMs,
    max_output_tokens,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0,
  });
  
  return (await parseResponsesJSON(resp)) || {};
}

/**
 * Plain text convenience call.
 */
async function callOpenAIText(prompt, timeoutMs = 60000, opts = {}) {
  const model = opts.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const max_output_tokens = typeof opts.max_output_tokens === "number" ? opts.max_output_tokens : 1200;
  
  const resp = await callOpenAI_NON_PHI_TEXT({
    promptText: prompt,
    model,
    timeoutMs,
    max_output_tokens,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0,
  });
  
  return extractResponseText(resp);
}

/**
 * Vision JSON: accepts image data URL + prompt, returns parsed JSON object.
 * NOTE: We scrub/detect on promptText only. The image is not text-scrubbed.
 */
async function callOpenAIImageJSON(prompt, imageDataUrl, timeoutMs = 90000, opts = {}) {
  if (!imageDataUrl) throw new Error("imageDataUrl missing");
  
  // If gatekeeper blocks on prompt text, it will throw here:
  const safePrompt = sanitizeAndAssertNonPHI(prompt, { allowEmpty: false });
  
  const OpenAI = require("openai");
  const rawKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!rawKey) throw new Error("OPENAI_API_KEY missing");
  
  const openai = new OpenAI({ apiKey: rawKey });
  
  const model = opts.model || process.env.OPENAI_MODEL_VISION || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const max_output_tokens = typeof opts.max_output_tokens === "number" ? opts.max_output_tokens : 4000;
  const temperature = typeof opts.temperature === "number" ? opts.temperature : 0;
  
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const resp = await openai.responses.create(
                                               {
                                                 model,
                                                 input: [
                                                         {
                                                           role: "user",
                                                           content: [
                                                             { type: "input_text", text: safePrompt },
                                                             { type: "input_image", image_url: imageDataUrl },
                                                           ],
                                                         },
                                                         ],
                                                 max_output_tokens,
                                                 temperature,
                                                 text: { format: { type: "json_object" } },
                                               },
                                               { signal: controller.signal }
                                               );
    
    return (await parseResponsesJSON(resp)) || {};
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  callOpenAIJSON,
  callOpenAIText,
  callOpenAIImageJSON,
};
