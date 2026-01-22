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

// OpenAI JSON helper: prefer root openaiClient if present, else use bots/openaiClient.
// If neither exposes callOpenAIJSON, fall back to parsing callOpenAIText output.
let _callOpenAIJSON = null;
try {
  // Some builds keep this at repo root
  ({ callOpenAIJSON: _callOpenAIJSON } = require("./openaiClient"));
} catch (e1) {
  try {
    ({ callOpenAIJSON: _callOpenAIJSON } = require("./bots/openaiClient"));
  } catch (e2) {
    _callOpenAIJSON = null;
  }
}

async function callOpenAIJSONSafe(prompt, timeoutMs = 12000) {
  if (typeof _callOpenAIJSON === "function") {
    return await _callOpenAIJSON(prompt, timeoutMs);
  }
  // Fallback: use text call and parse JSON
  const raw = await callOpenAIText(prompt, timeoutMs);
  const s = String(raw || "").trim();
  try {
    return JSON.parse(s);
  } catch {
    // Attempt to extract JSON object substring
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(s.slice(start, end + 1));
    }
    throw new Error("callOpenAIJSONSafe: unable to parse JSON from callOpenAIText output");
  }
}


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
      pt_reeval_default: grab("pt_reeval_default"),
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
function stripMarkdownNoise(s) {
  let t = String(s || "");
  // remove bold markers like **Heading:**
  t = t.replace(/\*\*/g, "");
  // normalize smart quotes
  t = t.replace(/’/g, "'");
  return t;
}

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
function splitSentencesOnePara(t) {
  const s = String(t || "").trim();
  if (!s) return [];
  return s.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
}

function normalizeTaskType(taskType) {
  const t = String(taskType || "").toLowerCase();
  if (t.includes("re-evaluation") || t.includes("re-eval") || t.includes("reeval") || t.includes("re eval")) return "reeval";
  if (t.includes("visit")) return "visit";
  if (t.includes("evaluation") || t.includes("eval")) return "eval";
  return "visit";
}

function extractContextTokens(hay) {
  const text = String(hay || "");
  const ageMatch = text.match(/(\d{1,3})\s*y\/o/i);
  const age = ageMatch ? ageMatch[1] : "";
  const gender = /\bfemale\b/i.test(text) ? "female" : (/\bmale\b/i.test(text) ? "male" : "");
  const pmhMatch = text.match(/(?:^|\n)\s*(?:relevant\s*medical\s*history|pmh)\s*:\s*([^\n\r]+)/i);
  const pmh = pmhMatch ? pmhMatch[1].trim() : "";
  const mdMatch = text.match(/(?:^|\n)\s*medical\s*diagnosis\s*:\s*([^\n\r]+)/i);
  const medicalDx = mdMatch ? mdMatch[1].trim() : "";

  // lightweight problems (non-PHI)
  const hits = [];
  const add = (re, label) => { if (re.test(text)) hits.push(label); };
  add(/muscle\s*weakness/i, "muscle weakness");
  add(/generalized\s*weakness/i, "generalized weakness");
  add(/functional\s*mobility|mobility\s*deficit|transfer/i, "impaired functional mobility");
  add(/bed\s*mobility/i, "impaired bed mobility");
  add(/gait|ambulat/i, "impaired gait");
  add(/balance|unsteady|fall\s*risk|falls?/i, "impaired balance and fall risk");
  add(/activity\s*tolerance|endurance/i, "reduced activity tolerance");
  add(/pain/i, "pain");
  const problems = Array.from(new Set(hits)).join(", ") || "generalized weakness with impaired functional mobility and fall risk";

  return { age, gender, pmh, medicalDx, problems };
}

function getDesiredSentenceSpec(hay) {
  const t = String(hay || "");

  // Default: 6 sentences
  let min = 6;
  let max = 6;

  // Range like "5-9 sentences" or "5 to 9 sentences"
  const range = t.match(/\b(\d{1,2})\s*(?:-|to)\s*(\d{1,2})\s*sentences?\b/i);
  if (range) {
    min = parseInt(range[1], 10);
    max = parseInt(range[2], 10);
  } else {
    // Exact like "exactly 7 sentences"
    const exact = t.match(/\bexactly\s*(\d{1,2})\s*sentences?\b/i);
    if (exact) {
      min = max = parseInt(exact[1], 10);
    } else {
      // Loose like "7 sentences"
      const single = t.match(/\b(\d{1,2})\s*sentences?\b/i);
      if (single) {
        min = max = parseInt(single[1], 10);
      }
    }
  }

  // Clamp to sane bounds
  if (!Number.isFinite(min)) min = 6;
  if (!Number.isFinite(max)) max = 6;
  min = Math.max(4, Math.min(10, min));
  max = Math.max(4, Math.min(10, max));
  if (max < min) [min, max] = [max, min];

  return { min, max };
}

// Shared rules across all 3 summary types
function validateCommonSummaryRules(text, spec) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, reason: "empty" };
  if (/\n/.test(t)) return { ok: false, reason: "contains line breaks" };
  if (/\b(the\s+patient|patient)\b/i.test(t)) return { ok: false, reason: "contains the word patient" };
  if (/\b(he|she|they|his|her|their)\b/i.test(t)) return { ok: false, reason: "contains pronouns" };

  const sentences = splitSentencesOnePara(t);
  const n = sentences.length;
  const min = Number(spec?.min || 6);
  const max = Number(spec?.max || 6);
  if (n < min || n > max) return { ok: false, reason: `sentence count ${n} (need ${min}-${max})` };

  return { ok: true, sentences };
}

function validateEvalSummary(text, spec) {
  const base = validateCommonSummaryRules(text, spec);
  if (!base.ok) return base;
  const { sentences } = base;
  const n = sentences.length;

  // Required fixed last sentence
  if (sentences[n - 1] !== "Continued skilled HH PT remains indicated.") {
    return { ok: false, reason: "last sentence not exact required string" };
  }

  // Required starters (your strict eval structure)
  if (!/^Pt\s+is\s+a\b/.test(sentences[0] || "")) return { ok: false, reason: "sentence 1 must start with 'Pt is a'" };
  if (!/\bpresents\s+with\b/i.test(sentences[0] || "")) return { ok: false, reason: "sentence 1 must include 'presents with'" };
  if (!/\bpmh\b/i.test(sentences[0] || "")) return { ok: false, reason: "sentence 1 must include PMH wording" };

  if (!/^Pt\s+underwent\b/.test(sentences[1] || "")) return { ok: false, reason: "sentence 2 must start with 'Pt underwent'" };
  if (!/^Objective\s+findings\b/.test(sentences[2] || "")) return { ok: false, reason: "sentence 3 must start with 'Objective findings'" };
  if (!/^Pt\s+demonstrates\b/.test(sentences[3] || "")) return { ok: false, reason: "sentence 4 must start with 'Pt demonstrates'" };

  if (n >= 6) {
    if (!/^Skilled\s+HH\s+PT\b/.test(sentences[4] || "")) return { ok: false, reason: "sentence 5 must start with 'Skilled HH PT'" };
  }

  // Any extra sentences (6+): should start with Pt (except the Skilled HH PT sentence and closing sentence)
  for (let i = 5; i < n - 1; i++) {
    if (!/^Pt\b/.test(sentences[i])) return { ok: false, reason: `sentence ${i+1} must start with 'Pt'` };
  }

  return { ok: true, reason: "ok" };
}

function validateReevalSummary(text, spec) {
  const base = validateCommonSummaryRules(text, spec);
  if (!base.ok) return base;
  const { sentences } = base;
  const n = sentences.length;

  // Keep the same exact closing line for consistency
  if (sentences[n - 1] !== "Continued skilled HH PT remains indicated.") {
    return { ok: false, reason: "last sentence not exact required string" };
  }

  // Re-eval is less rigid than eval, but still structured.
  if (!/^Pt\b/.test(sentences[0] || "")) return { ok: false, reason: "sentence 1 must start with 'Pt'" };
  if (!/\b(re-?evaluation|re-?eval|reassessment)\b/i.test(sentences[1] || "")) {
    return { ok: false, reason: "sentence 2 must reference PT re-evaluation/reassessment" };
  }
  // Ensure progress + ongoing deficits appear somewhere
  const joined = sentences.join(" ");
  if (!/\b(progress|improv|partial|met|not\s+met|plateau|continues)\b/i.test(joined)) {
    return { ok: false, reason: "must include progress/status toward goals" };
  }
  if (!/\b(fall\s*risk|unsteady|balance)\b/i.test(joined)) {
    return { ok: false, reason: "must include fall risk/balance risk statement" };
  }

  return { ok: true, reason: "ok" };
}

function validateVisitSummary(text, spec) {
  const base = validateCommonSummaryRules(text, spec);
  if (!base.ok) return base;
  const { sentences } = base;
  const n = sentences.length;

  // Keep same closing line
  if (sentences[n - 1] !== "Continued skilled HH PT remains indicated.") {
    return { ok: false, reason: "last sentence not exact required string" };
  }

  // Visit summary should cover tolerance, interventions, education/HEP, and skilled need
  const joined = sentences.join(" ");
  if (!/\b(tolerat|participat|symptom)\b/i.test(joined)) return { ok: false, reason: "must include tolerance/response statement" };
  if (!/\b(therex|theract|gait|balance|functional)\b/i.test(joined)) return { ok: false, reason: "must include skilled interventions performed" };
  if (!/\b(hep|education|safety|fall)\b/i.test(joined)) return { ok: false, reason: "must include HEP/safety education" };
  if (!/\b(medically\s+necessary|skilled)\b/i.test(joined)) return { ok: false, reason: "must include skilled need/medical necessity" };

  return { ok: true, reason: "ok" };
}

function buildFallbackSummary(kind, ctx, spec) {
  const ageTok = ctx.age ? ctx.age : "__";
  const genderTok = ctx.gender ? ctx.gender : "__";
  const dxTok = ctx.medicalDx ? ctx.medicalDx : "__";
  const pmhTok = ctx.pmh ? ctx.pmh : "__";
  const probs = ctx.problems || "generalized weakness with impaired functional mobility and fall risk";

  if (kind === "visit") {
    const s1 = `Pt tolerated HH PT tx fairly with good participation and remained symptom-free throughout the session.`;
    const s2 = `Tx focused on TherEx and TherAct to address ${probs} contributing to fall risk, with VC/TC provided PRN to ensure safe technique and mechanics.`;
    const s3 = `Functional training and gait and balance activities were completed to improve transfers and household mobility tolerance for safer ambulation as appropriate.`;
    const s4 = `HEP was reviewed and reinforced for compliance with education on pacing, fall prevention, and safety with functional mobility.`;
    const s5 = `Continued skilled HH PT remains indicated.`;
    return [s1, s2, s3, s4, s5].join(" ");
  }

  if (kind === "reeval") {
    const s1 = `Pt is a ${ageTok} y/o ${genderTok} who continues to present with ${probs} impacting safe functional mobility and ADLs.`;
    const s2 = `Pt is seen today for PT re-evaluation with reassessment of functional status, home safety considerations, and appropriateness of DME/AD use, with reinforcement of HEP and fall prevention education.`;
    const s3 = `Objective findings continue to demonstrate limitations in bed mobility, transfers, gait, balance reactions, and activity tolerance, supporting ongoing fall risk within the home environment.`;
    const s4 = `Pt has demonstrated partial progress toward established goals, however deficits persist and require continued skilled progression and monitoring.`;
    const s5 = `Skilled HH PT is medically necessary to provide TherEx, functional mobility training, gait and balance training, and skilled safety education to progress function and reduce fall risk.`;
    const s6 = `Continued skilled HH PT remains indicated.`;
    return [s1, s2, s3, s4, s5, s6].join(" ");
  }

  // default eval fallback (matches your strict structure)
  const s1 = `Pt is a ${ageTok} y/o ${genderTok} who presents with HNP of ${dxTok} which consists of PMH of ${pmhTok}.`;
  const s2 = `Pt underwent PT initial evaluation with completion of home safety assessment, DME assessment, and initiation of HEP education, with education provided on fall prevention strategies, proper use of AD, pain and edema management as indicated, and establishment of PT POC and functional goals to progress pt toward PLOF.`;
  const s3 = `Objective findings demonstrate impaired bed mobility, transfers, and gait with AD, poor balance reactions, and generalized weakness contributing to limited household mobility and dependence with ADLs, placing pt at high fall risk.`;
  const s4 = `Pt demonstrates decreased safety awareness and delayed balance reactions within the home environment, with environmental risk factors that further increase fall risk.`;
  const s5 = `Skilled HH PT is medically necessary to provide TherEx, functional mobility training, gait and balance training, and skilled safety education to improve strength, mobility, and functional independence while reducing risk of falls and injury.`;
  const s6 = `Continued skilled HH PT remains indicated.`;
  return [s1, s2, s3, s4, s5, s6].join(" ");
}

async function generateHHAssessmentSummary({ kind = "eval", dictation, problemsHint = "" }) {
  const text = String(dictation || "").trim();
  const spec = getDesiredSentenceSpec(text);

  const ctx = extractContextTokens(text);
  if (problemsHint) ctx.problems = String(problemsHint || "").trim();

  // default sentence counts per kind unless user explicitly asks different
  if (!/\bsentences?\b/i.test(text)) {
    if (kind === "visit") { spec.min = 5; spec.max = 5; }
    if (kind === "eval")  { spec.min = 6; spec.max = 6; }
    if (kind === "reeval"){ spec.min = 6; spec.max = 6; }
  }

  const ageForPrompt = ctx.age ? ctx.age : "__";
  const genderForPrompt = ctx.gender ? ctx.gender : "__";
  const medicalDxForPrompt = ctx.medicalDx ? ctx.medicalDx : "__";
  const pmhForPrompt = ctx.pmh ? ctx.pmh : "__";
  const problems = ctx.problems;

  let prompt = "";
  if (kind === "visit") {
    prompt = `Return ONLY valid JSON with double quotes.

You must output exactly one key:
- "clinicalStatement"

GLOBAL RULES:
- Write a Medicare-appropriate HOME HEALTH PHYSICAL THERAPY VISIT assessment summary.
- Sentence count: output between ${spec.min} and ${spec.max} sentences total.
- One paragraph only. No line breaks, no numbering, no bullets, no quotes.
- Do NOT use he/she/they/his/her/their.
- Do NOT include the word "patient".
- Do NOT include any proper names (people, agencies, facilities).

REQUIRED CONTENT:
- Include pt tolerance/response.
- Include skilled interventions performed (TherEx, TherAct, gait/balance/functional training as appropriate) and mention VC/TC PRN.
- Include HEP review/education + fall prevention/safety education.
- Include skilled need/medical necessity.
- Last sentence must be EXACTLY: Continued skilled HH PT remains indicated.

CONTEXT (use only; do not invent):
- Problems/impairments: ${problems}

Now generate the visit assessment summary following ALL rules exactly.`.trim();
  } else if (kind === "reeval") {
    prompt = `Return ONLY valid JSON with double quotes.

You must output exactly one key:
- "clinicalStatement"

GLOBAL RULES:
- Write an Assessment Summary for a Medicare HOME HEALTH PHYSICAL THERAPY RE-EVALUATION.
- Sentence count: output between ${spec.min} and ${spec.max} sentences total.
- One paragraph only. No line breaks, no numbering, no bullets, no quotes.
- Do NOT use he/she/they/his/her/their.
- Do NOT include the word "patient".
- Do NOT include any proper names (people, agencies, facilities).
- Use ONLY the provided diagnosis/PMH; do not add or invent.

REQUIRED CONTENT:
- Sentence 1: demographics + PMH/medical context if available (do not invent).
- Sentence 2: MUST reference PT re-evaluation/reassessment + home safety considerations + DME/AD use + HEP/fall prevention education + POC progression.
- Sentence 3: objective ongoing deficits (bed mobility, transfers, gait, balance, weakness/endurance) + fall risk linkage.
- Sentence 4: progress status toward goals (partially met, progressing, not met, etc.) + remaining barriers.
- Sentence 5: skilled need/medical necessity with TherEx, functional training, gait/balance training, safety education.
- Last sentence must be EXACTLY: Continued skilled HH PT remains indicated.

CONTEXT (use only; do not invent):
- Age: ${ageForPrompt}
- Gender: ${genderForPrompt}
- Medical Dx: ${medicalDxForPrompt}
- PMH: ${pmhForPrompt}
- Problems: ${problems}

Now generate the re-eval assessment summary following ALL rules exactly.`.trim();
  } else {
    // eval (your strict structure)
    prompt = `Return ONLY valid JSON with double quotes.

You must output exactly one key:
- "clinicalStatement"

GLOBAL RULES:
- Write an Assessment Summary for a Medicare HOME HEALTH PHYSICAL THERAPY INITIAL EVALUATION.
- Sentence count: output between ${spec.min} and ${spec.max} sentences total.
- One paragraph only. No line breaks, no numbering, no bullets, no quotes.
- Do NOT use he/she/they/his/her/their.
- Do NOT include the word "patient".
- Do NOT include any proper names (people, agencies, facilities).
- Use ONLY the provided diagnosis/PMH; do not add or invent.

REQUIRED STRUCTURE (follow strictly; must match these starters):
1) Must start with: "Pt is a" and must be written EXACTLY in this style:
   "Pt is a ${ageForPrompt} y/o ${genderForPrompt} who presents with HNP of ${medicalDxForPrompt} which consists of PMH of ${pmhForPrompt}."
   - If age or gender is unknown, use "__" in its place (do not omit "y/o").
   - If PMH is unknown, use "__".
2) Must start with: "Pt underwent" and include PT initial evaluation + home safety assessment + DME assessment + initiation of HEP education + fall prevention + proper AD use education + pain/edema management education as indicated + establish PT POC/goals toward PLOF.
3) Must start with: "Objective findings" and include deficits in bed mobility, transfers, gait with AD, balance reactions, generalized weakness, and high fall risk linkage with ADL limitations.
4) Must start with: "Pt demonstrates" and include decreased safety awareness/balance reactions + home/environment risk statement (high fall risk).
5) If total sentences >= 6: Sentence 5 must start with: "Skilled HH PT" and include Medicare medical necessity describing TherEx, functional mobility training, gait and balance training, and skilled safety education to improve function and reduce fall/injury risk.
Optional extra sentences (if >6 total): any additional sentences before the last must start with "Pt" and add non-redundant objective or skilled-need details.
Last sentence must be EXACTLY: Continued skilled HH PT remains indicated.

PROVIDED CONTEXT (use exactly; do not invent):
- Medical Diagnosis (HNP): ${medicalDxForPrompt}
- PMH: ${pmhForPrompt}
- Problems (for objective/skilled need support): ${problems}

Now generate the assessment summary following ALL rules exactly.`.trim();
  }

  const parsed = await callOpenAIJSONSafe(prompt, 12000);
  let cs = (parsed && parsed.clinicalStatement ? String(parsed.clinicalStatement) : "").trim();

  const validator =
    kind === "visit" ? validateVisitSummary :
    kind === "reeval" ? validateReevalSummary :
    validateEvalSummary;

  let v = validator(cs, spec);

  if (!v.ok) {
    const repairPrompt = `Return ONLY valid JSON with double quotes.

You must output exactly one key:
- "clinicalStatement"

The previous output FAILED validation for this reason: ${v.reason}

Rewrite the summary so it passes ALL rules, including:
- Output ${spec.min}–${spec.max} sentences total, one paragraph, no line breaks.
- Do NOT use the word "patient" or any pronouns.
- Last sentence MUST be exactly: Continued skilled HH PT remains indicated.
- Keep content appropriate for: ${kind === "visit" ? "HH PT VISIT" : (kind === "reeval" ? "HH PT RE-EVALUATION" : "HH PT INITIAL EVALUATION")}
- Do NOT invent diagnoses or PMH.

CONTEXT:
- Age: ${ageForPrompt}
- Gender: ${genderForPrompt}
- Medical Dx: ${medicalDxForPrompt}
- PMH: ${pmhForPrompt}
- Problems: ${problems}

BAD OUTPUT (for reference only; do not repeat):
${cs}`.trim();

    const repaired = await callOpenAIJSONSafe(repairPrompt, 12000);
    cs = (repaired && repaired.clinicalStatement ? String(repaired.clinicalStatement) : "").trim();
    v = validator(cs, spec);
  }

  if (!v.ok) {
    return buildFallbackSummary(kind, ctx, spec);
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
    // Optional: OpenAI generation for HH PT Assessment Summary (Eval/Re-eval/Visit) (6 sentences)
    // Only runs when user explicitly prompts in dictation:
    //   "Assessment Summary: Generate 6 sentences ..."
    // ------------------------------------------------------------
    let patchedText = finalText;
    
    try {
      const triggerHay = `${String(dictation || "")}\n${String(templateText || "")}`;
      
      // Explicit triggers (user prompt)
      const explicitTrigger =
      /\b(?:assessment\s*summary|clinical\s*statement|hh\s*pt\s*(?:initial\s*)?evaluation\s*(?:summary|assessment)|hh\s*pt\s*eval\s*(?:summary|assessment)|hh\s*pt\s*summary)\b[\s\S]*?\b(?:generate|write|create|compose|draft|build|produce|summarize|summarise|give\s*me|make|formulate|construct)\b[\s\S]*?\b(?:6|5\s*-\s*6|5\s*to\s*6)\s*sentences?\b/i
      .test(triggerHay);
      
      // Auto-rewrite trigger: if Assessment Summary exists but is not in required format OR contains banned words
      const existingAsmtLine =
      (triggerHay.match(/(?:^|\n)\s*assessment\s*summary\s*:\s*([^\n\r]+)/i) || [])[1] || "";
      
      const looksNonCompliant =
      !!existingAsmtLine &&
      (
       /\b(the\s+patient|patient)\b/i.test(existingAsmtLine) ||
       /\b(he|she|they|his|her|their)\b/i.test(existingAsmtLine) ||
       !(normalizeTaskType(taskType)==='visit' ? validateVisitSummary(existingAsmtLine, getDesiredSentenceSpec(triggerHay)).ok : (normalizeTaskType(taskType)==='reeval' ? validateReevalSummary(existingAsmtLine, getDesiredSentenceSpec(triggerHay)).ok : validateEvalSummary(existingAsmtLine, getDesiredSentenceSpec(triggerHay)).ok))
       );
      
      const wantsAssessmentGen = explicitTrigger || looksNonCompliant;
      if (wantsAssessmentGen && process.env.OPENAI_API_KEY) {
        // If PT Diagnosis line exists, use it as a problems hint (non-PHI)
        const ptDxLine = (String(triggerHay).match(/(?:^|\n)\s*pt\s*diagnosis\s*:\s*([^\n\r]+)/i) || [])[1] || "";
        const problemsHint = ptDxLine ? ptDxLine.replace(/[^\x20-\x7E]/g, "").trim() : "";
        
        const cs = await generateHHAssessmentSummary({ kind: normalizeTaskType(taskType), dictation: triggerHay, problemsHint });
        
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
    
    
    
    // ------------------------------------------------------------
    // Final enforcement: if OUTPUT Assessment Summary is non-compliant,
    // overwrite it with generated/validated (or fallback) summary.
    // This catches cases where dictation/template had markdown (**) or
    // upstream OpenAI conversion inserted a noncompliant summary.
    // ------------------------------------------------------------
    try {
      const outText = stripMarkdownNoise(patchedText || "");
      const asmtMatch = outText.match(/(?:^|\n)\s*Assessment Summary\s*:\s*([^\n\r]+)/i);
      const asmtLine = asmtMatch ? asmtMatch[1].trim() : "";
      const spec = getDesiredSentenceSpec(`${String(dictation || "")}\n${String(templateText || "")}`);
      
      if (asmtLine) {
        const vOut = (normalizeTaskType(taskType)==='visit' ? validateVisitSummary(asmtLine, spec) : (normalizeTaskType(taskType)==='reeval' ? validateReevalSummary(asmtLine, spec) : validateEvalSummary(asmtLine, spec)));
        if (!vOut.ok) {
          const triggerHay2 = stripMarkdownNoise(`${String(dictation || "")}\n${String(templateText || "")}`);
          
          let cs = "";
          if (process.env.OPENAI_API_KEY) {
            cs = await generateHHAssessmentSummary({ kind: normalizeTaskType(taskType), dictation: triggerHay2 });
          }
          if (!cs) {
            const ageMatch = String(triggerHay2).match(/(\d{1,3})\s*y\/o/i);
            const age = ageMatch ? ageMatch[1] : "";
            const gender = /\bfemale\b/i.test(triggerHay2) ? "female" : (/\bmale\b/i.test(triggerHay2) ? "male" : "");
            const pmhMatch = String(triggerHay2).match(/(?:^|\n)\s*(?:relevant\s*medical\s*history|pmh)\s*:\s*([^\n\r]+)/i);
            const pmh = pmhMatch ? pmhMatch[1].trim() : "";
            const mdMatch = String(triggerHay2).match(/(?:^|\n)\s*medical\s*diagnosis\s*:\s*([^\n\r]+)/i);
            const medicalDx = mdMatch ? mdMatch[1].trim() : "";
            cs = buildHHSummaryFallback({ age, gender, medicalDx, pmh, problems: "" });
          }
          
          if (cs) {
            // Replace in patchedText (keep original formatting around headings)
            patchedText = String(patchedText || "").replace(
                                                            /(^|\n)(\*\*)?Assessment Summary(\*\*)?\s*:\s*([^\n\r]*)/i,
                                                            (m0, p1) => `${p1}Assessment Summary: ${cs}`
                                                            );
          }
        }
      }
    } catch (e) {
      console.warn("[convert-dictation] final enforcement skipped:", (e && e.message) ? e.message : String(e));
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
    // Optional: OpenAI generation for HH PT Assessment Summary (Eval/Re-eval/Visit) (6–8 sentences)
    // Runs ONLY when an explicit trigger phrase is present in either:
    //  - the user's extracted text (vision output), OR
    //  - the selected template line for Assessment Summary.
    // ------------------------------------------------------------
    let patchedText = finalText;
    
    try {
      const triggerHay = `${String(finalText || "")}\n${String(templateText || "")}`;
      // Explicit triggers (user prompt)
      const explicitTrigger =
      /\b(?:assessment\s*summary|clinical\s*statement|hh\s*pt\s*(?:initial\s*)?evaluation\s*(?:summary|assessment)|hh\s*pt\s*eval\s*(?:summary|assessment)|hh\s*pt\s*summary)\b[\s\S]*?\b(?:generate|write|create|compose|draft|build|produce|summarize|summarise|give\s*me|make|formulate|construct)\b[\s\S]*?\b(?:6|5\s*-\s*6|5\s*to\s*6)\s*sentences?\b/i
      .test(triggerHay);
      
      // Auto-rewrite trigger: if Assessment Summary exists but is not in required format OR contains banned words
      const existingAsmtLine =
      (triggerHay.match(/(?:^|\n)\s*assessment\s*summary\s*:\s*([^\n\r]+)/i) || [])[1] || "";
      
      const looksNonCompliant =
      !!existingAsmtLine &&
      (
       /\b(the\s+patient|patient)\b/i.test(existingAsmtLine) ||
       /\b(he|she|they|his|her|their)\b/i.test(existingAsmtLine) ||
       !(normalizeTaskType(taskType)==='visit' ? validateVisitSummary(existingAsmtLine, getDesiredSentenceSpec(triggerHay)).ok : (normalizeTaskType(taskType)==='reeval' ? validateReevalSummary(existingAsmtLine, getDesiredSentenceSpec(triggerHay)).ok : validateEvalSummary(existingAsmtLine, getDesiredSentenceSpec(triggerHay)).ok))
       );
      
      const wantsAssessmentGen = explicitTrigger || looksNonCompliant;
      if (wantsAssessmentGen && process.env.OPENAI_API_KEY) {
        const ptDxLine = (triggerHay.match(/(?:^|\n)\s*pt\s*diagnosis\s*:\s*([^\n\r]+)/i) || [])[1] || "";
        const problemsHint = ptDxLine ? ptDxLine.replace(/[^\x20-\x7E]/g, "").trim() : "";
        
        const cs = await generateHHAssessmentSummary({ kind: normalizeTaskType(taskType), dictation: triggerHay, problemsHint });
        
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
