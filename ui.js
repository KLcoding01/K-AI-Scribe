// Updated: 2026-01-20
global.logErr = global.logErr || ((...args) => { try { console.error(...args); } catch {} });

// ui.js — Kin-Scribe Web UI + API server (Render-friendly)
// ============================================================
// - Serves static UI from /public
// - Exposes POST /run-automation and GET /job-status/:jobId
// - Captures per-job logs from bots via logCb (no need to scrape Render logs)

const express = require("express");
const path = require("path");
const { runKinnserBot } = require("./index.js");


const { callOpenAIText, callOpenAIImageJSON } = require("./bots/openaiClient");
//
// EXPIRATION CHECK – blocks use after Feb 1, 2026
//
const EXPIRATION_DATE = new Date("2026-02-01T00:00:00Z");
const NOW = new Date();
if (NOW > EXPIRATION_DATE) {
  console.log("❌ Application expired on Feb 01, 2026.");
  throw new Error("Software expiration reached — contact support for renewal.");
}

const app = express();

// ---- Job status store ----
const JOBS = new Map(); // jobId -> { status, message, startedAt, finishedAt, updatedAt, logs[] }
let ACTIVE_JOB_ID = null; // prevents overlapping automations
const JOB_TTL_MS = 1000 * 60 * 30; // 30 minutes
const JOB_LOG_MAX = 600; // max log lines stored per job

function setJob(jobId, patch) {
  const prev = JOBS.get(jobId) || {
    status: "queued",
    message: "Queued",
    startedAt: Date.now(),
    finishedAt: null,
    updatedAt: Date.now(),
    logs: [],
  };

  const next = {
    ...prev,
    ...patch,
    updatedAt: Date.now(),
  };

  // Auto-finish timestamps for terminal states
  if ((next.status === "completed" || next.status === "failed") && !next.finishedAt) {
    next.finishedAt = Date.now();
  }

  JOBS.set(jobId, next);
  console.log(`[${jobId}] STATUS => ${next.status}: ${next.message || ""}`);
}

function appendJobLog(jobId, line) {
  const job = JOBS.get(jobId);
  if (!job) return;
  const logs = Array.isArray(job.logs) ? job.logs : [];
  logs.push(String(line ?? ""));
  // trim
  if (logs.length > JOB_LOG_MAX) logs.splice(0, logs.length - JOB_LOG_MAX);
  JOBS.set(jobId, { ...job, logs, updatedAt: Date.now() });
}

// Cleanup finished jobs
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of JOBS.entries()) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      JOBS.delete(id);
    }
  }
}, 60 * 1000);

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve UI assets
app.use(express.static(path.join(__dirname, "public")));


function loadPublicTemplates() {
  try {
    const fs = require("fs");
    const path = require("path");
    const p = path.join(__dirname, "public", "app.js");
    const js = fs.readFileSync(p, "utf8");

    function grab(key) {
      // match: key: `...`
      const re = new RegExp(key + String.raw`\s*:\s*\`([\s\S]*?)\``, "m");
      const m = js.match(re);
      return m ? String(m[1] || "").trim() : "";
    }

    return {
      pt_visit_default: grab("pt_visit_default"),
      pt_eval_default: grab("pt_eval_default"),
    };
  } catch {
    return { pt_visit_default: "", pt_eval_default: "" };
  }
}

// Health endpoints
app.get("/health", (req, res) => res.status(200).send("ok"));
app.get("/status", (req, res) => res.status(200).json({ status: "ok" }));

app.get("/job-status/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = JOBS.get(jobId);
  if (!job) {
    return res.status(404).json({ jobId, status: "unknown", message: "Job not found" });
  }
  res.json({ jobId, ...job });
});

// Root: serve UI
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/run-automation", async (req, res) => {
  const jobId = `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  // Single-run guard
  if (ACTIVE_JOB_ID) {
    return res.status(409).json({
      error: "Another automation is still running",
      activeJobId: ACTIVE_JOB_ID,
    });
  }

  ACTIVE_JOB_ID = jobId;
  setJob(jobId, {
    status: "running",
    message: "Started",
    startedAt: Date.now(),
    finishedAt: null,
    logs: [],
  });

  // Return immediately so UI can poll
  res.json({ status: "running", message: "Started", jobId });

  // Background job
  (async () => {
    try {
      const merged = {
        ...req.body,
        kinnserUsername: req.body.kinnserUsername || process.env.KINNSER_USERNAME,
        kinnserPassword: req.body.kinnserPassword || process.env.KINNSER_PASSWORD,
        jobId,
        statusCb: (status, message) => setJob(jobId, { status, message }),
};

      if (!merged.patientName || !merged.visitDate || !merged.taskType) {
        throw new Error("Missing required fields: patientName, visitDate, taskType");
      }
      if (!merged.kinnserUsername || !merged.kinnserPassword) {
        throw new Error("Missing KINNSER_USERNAME / KINNSER_PASSWORD (set in environment)");
      }

      appendJobLog(jobId, "➡️ Starting automation...");
      appendJobLog(jobId, `taskType: ${merged.taskType}`);

      // Live UI logs: mirror ALL console output into job logs (single source of truth)
      const _origLog = console.log.bind(console);
      const _origErr = console.error.bind(console);
      console.log = (...args) => {
        try { appendJobLog(jobId, args.map(String).join(' ')); } catch {}
        _origLog(...args);
      };
      console.error = (...args) => {
        try { appendJobLog(jobId, args.map(String).join(' ')); } catch {}
        _origErr(...args);
      };

      await runKinnserBot(merged);

      setJob(jobId, { status: "completed", message: "Autofill completed" });
      appendJobLog(jobId, "✅ Completed: Autofill completed");
    } catch (e) {
      setJob(jobId, { status: "failed", message: e?.message ? String(e.message) : "Job failed" });
      appendJobLog(jobId, `❌ Failed: ${e?.message ? String(e.message) : "Job failed"}`);
    } finally {
      try { console.log = _origLog; console.error = _origErr; } catch {}
      ACTIVE_JOB_ID = null;
    }
  })();
});

// ------------------------------------------------------------
// Offline/template-only dictation filler (no OpenAI)
// - For lines like: "Temp: 97.5" it overwrites the matching template line.
// - For multi-line blocks like "Subjective:" it captures until next Heading:
// - Preserves template headings/order; never invents new headings.
// ------------------------------------------------------------
function simpleFillTemplate(dictationText, templateText) {
  const dictation = String(dictationText || "").replace(/\r\n/g, "\n");
  const template = String(templateText || "").replace(/\r\n/g, "\n");

  // Parse dictation into blocks keyed by heading (case-insensitive)
  const lines = dictation.split("\n");
  const blocks = new Map(); // keyLower -> { heading, valueLines[] }
  let curKey = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const m = raw.match(/^([A-Za-z][A-Za-z0-9\s\/\-\(\)']{0,80})\s*:\s*(.*)$/);
    if (m) {
      const heading = m[1].trim();
      const rest = (m[2] ?? "").trimEnd();
      curKey = heading.toLowerCase().replace(/’/g, "'");
      if (!blocks.has(curKey)) blocks.set(curKey, { heading, valueLines: [] });
      blocks.get(curKey).valueLines.push(rest);
      continue;
    }
    if (curKey) blocks.get(curKey).valueLines.push(raw);
  }

  function renderBlock(b) {
    if (!b) return "";
    const arr = (b.valueLines || []).slice();
    while (arr.length && arr[0] === "") arr.shift();
    while (arr.length && arr[arr.length - 1].trim() === "") arr.pop();
    return arr.join("\n").trimEnd();
  }

  const outLines = template.split("\n");

  const headingRe = /^([A-Za-z][A-Za-z0-9\s\/\-\(\)’']{0,80})\s*:\s*(.*)$/;

  for (let i = 0; i < outLines.length; i++) {
    const line = outLines[i];
    const m = line.match(headingRe);
    if (!m) continue;

    const headingRaw = m[1].trim();
    const keyLower = headingRaw.toLowerCase().replace(/’/g, "'");

    const b = blocks.get(keyLower);
    if (!b) continue;

    const replacement = renderBlock(b);
    const isMulti = replacement.includes("\n") || (m[2] ?? "").trim() === "";

    if (!isMulti) {
      outLines[i] = `${headingRaw}: ${replacement}`.trimEnd();
      continue;
    }

    const replLines = replacement ? replacement.split("\n") : [""];
    outLines[i] = `${headingRaw}: ${replLines[0] || ""}`.trimEnd();

    // Remove existing non-heading lines until next heading
    let j = i + 1;
    while (j < outLines.length && !headingRe.test(outLines[j])) {
      outLines.splice(j, 1);
    }

    if (replLines.length > 1) outLines.splice(i + 1, 0, ...replLines.slice(1));
  }

  return outLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
// ------------------------------------------------------------
    // OpenAI-only: generate 6-sentence Medicare-justifiable HH PT Eval Assessment Summary
    // Triggered ONLY when the user explicitly prompts via "Assessment Summary:" containing "Generate 6 sentences"
function buildHHSummaryFallback({ age = "", gender = "", pmh = "", problems = "" }) {
  const a = String(age || "").trim();
  const g = String(gender || "").trim();
  const p = String(pmh || "").trim();
  const prob = String(problems || "").trim() || "muscle weakness, impaired functional mobility, and high fall risk";

  const demo = (a && g) ? `${a} y/o ${g}` : (a ? `${a} y/o` : (g ? `${g}` : ""));
  const s1 = `Pt is ${demo ? "a " + demo + " " : "a "}who presents with primary impairments of ${prob}${p ? ", with PMH of " + p : ""}.`.replace(/\s+/g, " ").trim();
  const s2 = `Pt is seen for PT initial evaluation, home safety assessment, DME assessment, HEP training/education, fall safety precautions and fall prevention education, education on proper use of AD, education on pain and edema management as indicated, and PT POC/goal planning to return toward PLOF.`;
  const s3 = `Pt demonstrates objective deficits including weakness, impaired balance, impaired gait, and impaired functional mobility with difficulty in bed mobility, transfers, and gait contributing to high fall risk.`;
  const s4 = `Pt demonstrates decreased safety awareness and impaired balance reactions with environmental risk factors in the home, and Pt is at high fall risk.`;
  const s5 = `Pt requires skilled HH PT for TherEx, functional training, gait and balance training, and safety education with clinical monitoring and progression to reduce fall and injury risk and improve ADL performance.`;
  const s6 = `Continued skilled HH PT remains indicated.`;
  return [s1, s2, s3, s4, s5, s6].join(" ");
}

function validateHHSummary(text) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, reason: "empty" };
  if (/\n/.test(t)) return { ok: false, reason: "contains line breaks" };
  if (/\b(the\s+patient|patient)\b/i.test(t)) return { ok: false, reason: "contains the word patient" };

  const sentences = t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

  if (sentences.length < 6 || sentences.length > 8) {
    return { ok: false, reason: `sentence count ${sentences.length} (need 6-8)` };
  }

  for (let i = 0; i < sentences.length; i++) {
    if (!/^Pt\b/.test(sentences[i])) return { ok: false, reason: `sentence ${i+1} does not start with Pt` };
  }

  if (sentences[5] !== "Continued skilled HH PT remains indicated.") {
    return { ok: false, reason: "sentence 6 not exact required string" };
  }

  if (/\b(he|she|they|his|her|their)\b/i.test(t)) {
    return { ok: false, reason: "contains pronouns" };
  }

  return { ok: true, reason: "ok" };
}


async function generateHHEvalAssessmentSummary({ dictation, problemsHint = "" }) {
      const text = String(dictation || "").trim();
      const hint = String(problemsHint || "").trim();

      // Extract a lightweight problems string from dictation (do NOT include names/PHI)
      const problems = hint || (()=>{
        const hits = [];
        const add = (re, label) => { if (re.test(text)) hits.push(label); };
        add(/muscle\s*weakness/i, "muscle weakness");
        add(/functional\s*mobility|mobility\s*deficit|transfer/i, "impaired functional mobility");
        add(/gait|ambulat/i, "impaired gait");
        add(/balance|unsteady|fall\s*risk|falls?/i, "impaired balance and high fall risk");
        add(/activity\s*tolerance|endurance/i, "reduced activity tolerance");
        const uniq = Array.from(new Set(hits));
        return uniq.length ? uniq.join(", ") : "muscle weakness, impaired functional mobility, and high fall risk";
      })();

      const prompt = `Return ONLY valid JSON with double quotes.

You must output exactly one key:
- "clinicalStatement"

GLOBAL RULES:
- Write an Assessment Summary for a Medicare HOME HEALTH PHYSICAL THERAPY INITIAL EVALUATION.
- Output EXACTLY 6–8 sentences total, in ONE paragraph.
- No line breaks, no numbering, no bullets, no quotes.
- Each sentence MUST start with "Pt".
- Do NOT use he/she/they/his/her/their.
- Do NOT include the word "patient".
- Do NOT include any proper names (people, agencies, facilities).
- Do NOT invent diagnoses, PMH, or conditions not explicitly provided.

REQUIRED SENTENCE STRUCTURE (follow strictly):
Sentence 1: Pt demographics (age/sex ONLY if explicitly provided in dictation) + relevant PMH (use ONLY PMH provided; do not add or infer).
Sentence 2: Pt PT initial evaluation summary INCLUDING home safety assessment, DME assessment, HEP education, fall safety/fall prevention education, education on proper AD use, education on pain and/or edema management if applicable, and PT plan of care/goal planning toward return to PLOF.
Sentence 3: Pt objective functional deficits including bed mobility, transfers, gait, balance, generalized weakness, and linkage to high fall risk.
Sentence 4: Pt safety awareness, balance reactions, environmental/home risk factors, and explicit statement of high fall risk.
Sentence 5: Pt skilled need and medical necessity describing skilled interventions (TherEx, functional training, gait/balance training, safety education) required to improve function and reduce fall/injury risk.
Sentence 6: Continued skilled HH PT remains indicated.
Sentences 7–8 (ONLY if needed to reach clarity): Additional objective or skilled-need details consistent with Medicare HH PT documentation; do not repeat prior content.

CLINICAL CONTEXT:
- Primary impairments/problems: ${problems}

STYLE EXAMPLE (do not copy verbatim; follow structure):
Pt is a __ y/o __ who presents with __ and PMH of __. Pt is seen for PT initial evaluation, home safety assessment, DME assessment, HEP education, fall prevention education, AD use education, pain/edema management education as indicated, and PT POC/goal planning toward PLOF. Pt demonstrates deficits in bed mobility, transfers, gait, balance, and weakness contributing to high fall risk. Pt demonstrates decreased safety awareness and impaired balance reactions and Pt is at high fall risk. Pt requires skilled HH PT for TherEx, functional training, gait and balance training, and safety education. Continued skilled HH PT remains indicated.

Now generate the assessment summary following ALL rules exactly.`.trim();

      // callOpenAIJSON is already required/available in ui.js for convert routes
      const parsed = await callOpenAIJSON(prompt, 12000);
let cs = (parsed && parsed.clinicalStatement ? String(parsed.clinicalStatement) : "").trim();

// Validate and do one repair attempt if needed
let v = validateHHSummary(cs);
if (!v.ok) {
  const repairPrompt = `Return ONLY valid JSON with double quotes.

You must output exactly one key:
- "clinicalStatement"

The previous output FAILED validation for this reason: ${v.reason}

Rewrite the assessment summary so it passes ALL rules:
- Medicare HOME HEALTH PHYSICAL THERAPY INITIAL EVALUATION
- Output EXACTLY 6–8 sentences total, one paragraph, no line breaks, no numbering, no bullets, no quotes.
- Each sentence MUST start with "Pt".
- Do NOT use he/she/they/his/her/their.
- Do NOT include the word "patient".
- Sentence 6 MUST be exactly: Continued skilled HH PT remains indicated.
- Do NOT include any proper names (people, agencies, facilities).
- Do NOT invent diagnoses, PMH, or conditions not explicitly provided.
- Follow this sentence structure:
  1) demographics (only if explicitly provided) + PMH (only provided)
  2) initial eval + home safety + DME + HEP + fall prevention + AD use + pain/edema education if applicable + POC/goal planning toward PLOF
  3) objective deficits (bed mobility/transfers/gait/balance/weakness) + high fall risk linkage
  4) safety awareness/balance reactions/home risk + explicit high fall risk
  5) skilled need/medical necessity with TherEx, functional training, gait/balance training, safety education
  6) Continued skilled HH PT remains indicated.
  7–8) optional only if needed, no repetition

CLINICAL CONTEXT:
- Primary impairments/problems: ${problems}

BAD OUTPUT (for reference only; do not repeat):
${cs}`.trim();

  const repaired = await callOpenAIJSON(repairPrompt, 12000);
  cs = (repaired && repaired.clinicalStatement ? String(repaired.clinicalStatement) : "").trim();
  v = validateHHSummary(cs);
}

// If still invalid, return deterministic fallback (never blank)
if (!v.ok) {
  const ageMatch = String(dictation || "").match(/(\d{1,3})\s*y\/o/i);
  const age = ageMatch ? ageMatch[1] : "";
  const gender = /\bfemale\b/i.test(dictation || "") ? "female" : (/\bmale\b/i.test(dictation || "") ? "male" : "");
  const pmhMatch = String(dictation || "").match(/(?:^|\n)\s*(?:relevant\s*medical\s*history|pmh)\s*:\s*([^\n\r]+)/i);
  const pmh = pmhMatch ? pmhMatch[1].trim() : "";
  return buildHHSummaryFallback({ age, gender, pmh, problems });
}

return cs;
}


// ------------------------------------------------------------
// Convert Dictation → Selected Template (PT Visit / PT Eval)
// Expects: { dictation, taskType, templateText }
// Returns: { templateText }
// ------------------------------------------------------------
app.post("/convert-dictation", async (req, res) => {
  try {
    const dictation = String(req.body?.dictation || "").trim();
    const taskType = String(req.body?.taskType || "").trim();
    const templateText = String(req.body?.templateText || "").trim();

    if (!dictation) return res.status(400).json({ error: "Missing dictation" });
    if (!templateText) return res.status(400).json({ error: "Missing templateText" });

    // If OpenAI is not configured, do a deterministic best-effort fill
    if (!process.env.OPENAI_API_KEY) {
      const filled = simpleFillTemplate(dictation, templateText);
      return res.json({ templateText: filled });
    }

    const prompt = `
You are converting messy PT dictation into the provided WellSky/Kinnser note template.

RULES:
- Output MUST be the template text filled in.
- Preserve ALL headings and section order exactly as shown.
- Fill in values using ONLY the dictation. If unknown, leave the placeholder blank (keep ___ or empty after colon).
- Do NOT add new headings. Do NOT add extra commentary outside the template.
- Keep Exercises lines as one exercise per line if present.
- Keep style professional and Medicare-appropriate.

TASK TYPE: ${taskType || "PT Visit"}

TEMPLATE:
${templateText}

DICTATION:
${dictation}
`.trim();

    const out = await callOpenAIText(prompt, 60000).catch(() => "");
    const finalText = String(out || "").trim() || simpleFillTemplate(dictation, templateText) || templateText;// ------------------------------------------------------------
// Optional: OpenAI generation for HH PT Eval Assessment Summary (6 sentences)
// Only runs when user explicitly prompts in dictation:
//   "Assessment Summary: Generate 6 sentences ..."
// ------------------------------------------------------------
let patchedText = finalText;

try {
  const triggerHay = `${String(dictation || "")}\n${String(templateText || "")}`;
  const wantsAssessmentGen = /\b(?:assessment\s*summary|clinical\s*statement|hh\s*pt\s*(?:initial\s*)?evaluation\s*(?:summary|assessment)|hh\s*pt\s*eval\s*(?:summary|assessment)|hh\s*pt\s*summary)\b[\s\S]*?\b(?:generate|write|give\s*me|create)\b[\s\S]*?\b(?:5\s*-\s*6|5\s*to\s*6|6|5)\s*sentences?\b/i.test(triggerHay);
if (wantsAssessmentGen && process.env.OPENAI_API_KEY) {
    // If PT Diagnosis line exists, use it as a problems hint (non-PHI)
    const ptDxLine = (String(triggerHay).match(/(?:^|\n)\s*pt\s*diagnosis\s*:\s*([^\n\r]+)/i) || [])[1] || "";
    const problemsHint = ptDxLine ? ptDxLine.replace(/[^\x20-\x7E]/g, "").trim() : "";

    const cs = await generateHHEvalAssessmentSummary({ dictation: triggerHay, problemsHint });

    // Replace ONLY the Assessment Summary line content in the template (preserve heading)
    if (cs) {
      patchedText = patchedText.replace(
        /(^|\n)(Assessment Summary\s*:\s*)([^\n\r]*)/i,
        (m0, p1, p2) => `${p1}${p2}${cs}`
      );
    }
  }
} catch (e) {
  // Fail-soft: keep deterministic filled template
  console.warn("[convert-dictation] Assessment Summary generation skipped:", (e && e.message) ? e.message : String(e));
}



    return res.json({ templateText: patchedText });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "convert-dictation failed" });
  }
});

// ------------------------------------------------------------
// Convert Image → Selected Template (Vision)
// Expects: { imageDataUrl, taskType, templateText }
// Returns: { templateText }
// ------------------------------------------------------------
app.post("/convert-image", async (req, res) => {
  try {
    const imageDataUrl = String(req.body?.imageDataUrl || "").trim();
    const taskType = String(req.body?.taskType || "").trim();
    const templateText = String(req.body?.templateText || "").trim();

    if (!imageDataUrl) return res.status(400).json({ error: "Missing imageDataUrl" });
    if (!templateText) return res.status(400).json({ error: "Missing templateText" });

    if (!process.env.OPENAI_API_KEY) {
      return res.json({ templateText });
    }

    const prompt = `
You are extracting PT documentation from an image and formatting it into the provided WellSky/Kinnser template.

RULES:
- Return ONLY valid JSON: {"templateText":"..."} (double quotes)
- The "templateText" value MUST be the template filled in.
- Preserve headings/section order exactly.
- If unknown, leave placeholders blank (keep ___ or empty).
- Do NOT add extra headings or extra commentary.

TASK TYPE: ${taskType || "PT Visit"}

TEMPLATE:
${templateText}
`.trim();

    const obj = await callOpenAIImageJSON(prompt, imageDataUrl, 90000).catch(() => ({}));
    const finalText = String(obj?.templateText || "").trim();
// ------------------------------------------------------------
// Optional: OpenAI generation for HH PT Eval Assessment Summary (6–8 sentences)
// Runs ONLY when an explicit trigger phrase is present in either:
//  - the user's extracted text (vision output), OR
//  - the selected template line for Assessment Summary.
// ------------------------------------------------------------
let patchedText = finalText;

try {
  const triggerHay = `${String(finalText || "")}\n${String(templateText || "")}`;
  const wantsAssessmentGen =
    /\b(?:assessment\s*summary|clinical\s*statement|hh\s*pt\s*(?:initial\s*)?evaluation\s*(?:summary|assessment)|hh\s*pt\s*eval\s*(?:summary|assessment)|hh\s*pt\s*summary)\b[\s\S]*?\b(?:generate|write|give\s*me|create)\b[\s\S]*?\b(?:5\s*-\s*6|5\s*to\s*6|6|5)\s*sentences?\b/i
      .test(triggerHay);

  if (wantsAssessmentGen && process.env.OPENAI_API_KEY) {
    const ptDxLine = (triggerHay.match(/(?:^|\n)\s*pt\s*diagnosis\s*:\s*([^\n\r]+)/i) || [])[1] || "";
    const problemsHint = ptDxLine ? ptDxLine.replace(/[^\x20-\x7E]/g, "").trim() : "";

    const cs = await generateHHEvalAssessmentSummary({ dictation: triggerHay, problemsHint });

    if (cs) {
      patchedText = patchedText.replace(
        /(^|\n)(Assessment Summary\s*:\s*)([^\n\r]*)/i,
        (m0, p1, p2) => `${p1}${p2}${cs}`
      );
    }
  }
} catch (e) {
  console.warn("[convert-image] Assessment Summary generation skipped:", (e && e.message) ? e.message : String(e));
}

    return res.json({ templateText: finalText || templateText });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "convert-image failed" });
  }
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`UI server listening on 0.0.0.0:${PORT}`);
});
