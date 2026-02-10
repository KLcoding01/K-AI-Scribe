// Updated: 2026-02-09
global.logErr = global.logErr || ((...args) => { try { console.error(...args); } catch {} });

// ui.js — Kin-Scribe Web UI + API server (Render-friendly)
// ============================================================
// - Serves static UI from /public
// - Exposes:
//    POST /run-automation
//    POST /stop-job
//    GET  /job-status/:jobId
//    POST /convert-dictation
//    POST /convert-image
//    POST /convert-audio   (Voice memo -> transcription)
// - Runs automations inside a Worker so STOP can terminate instantly.

const express = require("express");
const path = require("path");
const { Worker } = require("worker_threads");

const { callOpenAIText, callOpenAIImageJSON } = require("./bots/openaiClient");

// OpenAI JSON helper: prefer root openaiClient if present, else use bots/openaiClient.
// If neither exposes callOpenAIJSON, fall back to parsing callOpenAIText output.
let _callOpenAIJSON = null;
try {
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
  const raw = await callOpenAIText(prompt, timeoutMs);
  const s = String(raw || "").trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
    throw new Error("callOpenAIJSONSafe: unable to parse JSON from callOpenAIText output");
  }
}

// ------------------------------------------------------------
// EXPIRATION CHECK – blocks use after Mar 1, 2026
// ------------------------------------------------------------
const EXPIRATION_DATE = new Date("2026-03-01T00:00:00Z");
const NOW = new Date();
if (NOW > EXPIRATION_DATE) {
  console.log("❌ Application expired on Mar 01, 2026.");
  throw new Error("Software expiration reached — contact support for renewal.");
}

const app = express();

// ---- Job status store ----
const JOBS = new Map(); // jobId -> { status, message, startedAt, finishedAt, updatedAt, logs[] }
let ACTIVE_JOB_ID = null; // prevents overlapping automations
const JOB_TTL_MS = 1000 * 60 * 30; // 30 minutes
const JOB_LOG_MAX = 800; // max log lines stored per job

// jobId -> Worker
const WORKERS = new Map();

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

  if ((next.status === "completed" || next.status === "failed" || next.status === "stopped") && !next.finishedAt) {
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

// Note: audio uploads (base64) can be large
app.use(express.json({ limit: "35mb" }));
app.use(express.urlencoded({ extended: true, limit: "35mb" }));

// Serve UI assets
app.use(express.static(path.join(__dirname, "public")));

// Health endpoints
app.get("/health", (req, res) => res.status(200).send("ok"));
app.get("/status", (req, res) => res.status(200).json({ status: "ok" }));

app.get("/job-status/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = JOBS.get(jobId);
  if (!job) return res.status(404).json({ jobId, status: "unknown", message: "Job not found" });
  res.json({ jobId, ...job });
});

// Root: serve UI
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ------------------------------------------------------------
// STOP JOB (terminates Worker)
// Body: { jobId }
// ------------------------------------------------------------
app.post("/stop-job", async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || "").trim();
    if (!jobId) return res.status(400).json({ error: "Missing jobId" });

    const job = JOBS.get(jobId);
    const w = WORKERS.get(jobId);

    if (!job) return res.status(404).json({ error: "Job not found" });
    if (!w) {
      // If there's no worker, job is likely finished.
      return res.json({ ok: true, jobId, status: job.status, message: "No active worker (already finished?)" });
    }

    appendJobLog(jobId, "🛑 Stop requested by user.");
    setJob(jobId, { status: "stopped", message: "Stopped by user" });

    try { await w.terminate(); } catch {}
    WORKERS.delete(jobId);

    if (ACTIVE_JOB_ID === jobId) ACTIVE_JOB_ID = null;

    return res.json({ ok: true, jobId, status: "stopped", message: "Stopped" });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "stop-job failed" });
  }
});

// ------------------------------------------------------------
// RUN AUTOMATION (Worker-based, so it continues server-side + stoppable)
// ------------------------------------------------------------
app.post("/run-automation", async (req, res) => {
  const jobId = `job_${Date.now()}_${Math.random().toString(16).slice(2)}`;

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

  // Return immediately so UI can poll (even if user closes tab/locks phone)
  res.json({ status: "running", message: "Started", jobId });

  // Merge auth from env
  const merged = {
    ...req.body,
    kinnserUsername: req.body.kinnserUsername || process.env.KINNSER_USERNAME,
    kinnserPassword: req.body.kinnserPassword || process.env.KINNSER_PASSWORD,
    jobId,
  };

  (async () => {
    let w = null;
    try {
      if (!merged.patientName || !merged.visitDate || !merged.taskType) {
        throw new Error("Missing required fields: patientName, visitDate, taskType");
      }
      if (!merged.kinnserUsername || !merged.kinnserPassword) {
        throw new Error("Missing KINNSER_USERNAME / KINNSER_PASSWORD (set in environment)");
      }

      appendJobLog(jobId, "➡️ Starting automation (Worker)…");
      appendJobLog(jobId, `taskType: ${merged.taskType}`);

      // Worker code: require index.js and run runKinnserBot(payload)
      const workerCode = `
        const { parentPort, workerData } = require("worker_threads");

        function safeSend(msg) {
          try { parentPort && parentPort.postMessage(msg); } catch {}
        }

        // Mirror console logs to parent
        const _log = console.log.bind(console);
        const _err = console.error.bind(console);
        console.log = (...args) => { safeSend({ type: "log", line: args.map(String).join(" ") }); _log(...args); };
        console.error = (...args) => { safeSend({ type: "log", line: args.map(String).join(" ") }); _err(...args); };

        // Provide optional global callback for bots that use it
        try {
          globalThis.__KINNSER_LOG_CB = (msg) => safeSend({ type: "log", line: String(msg ?? "") });
        } catch {}

        (async () => {
          try {
            const { runKinnserBot } = require("./index.js");
            const payload = workerData && workerData.payload ? workerData.payload : {};
            // status callback (if bot calls it)
            payload.statusCb = (status, message) => safeSend({ type: "status", status, message });
            await runKinnserBot(payload);
            safeSend({ type: "done" });
          } catch (e) {
            safeSend({ type: "error", message: e && e.message ? String(e.message) : String(e) });
          } finally {
            try { if (globalThis.__KINNSER_LOG_CB) delete globalThis.__KINNSER_LOG_CB; } catch {}
          }
        })();
      `;

      w = new Worker(workerCode, {
        eval: true,
        workerData: { payload: merged },
      });
      WORKERS.set(jobId, w);

      w.on("message", (m) => {
        if (!m || typeof m !== "object") return;
        if (m.type === "log") {
          appendJobLog(jobId, m.line);
        } else if (m.type === "status") {
          setJob(jobId, { status: String(m.status || "running"), message: String(m.message || "") });
        } else if (m.type === "done") {
          // Only mark completed if not stopped
          const cur = JOBS.get(jobId);
          if (cur && cur.status !== "stopped") {
            setJob(jobId, { status: "completed", message: "Autofill completed" });
            appendJobLog(jobId, "✅ Completed: Autofill completed");
          }
        } else if (m.type === "error") {
          const cur = JOBS.get(jobId);
          if (cur && cur.status !== "stopped") {
            setJob(jobId, { status: "failed", message: String(m.message || "Job failed") });
            appendJobLog(jobId, `❌ Failed: ${String(m.message || "Job failed")}`);
          }
        }
      });

      w.on("error", (err) => {
        const cur = JOBS.get(jobId);
        if (cur && cur.status !== "stopped") {
          setJob(jobId, { status: "failed", message: err?.message ? String(err.message) : "Worker error" });
          appendJobLog(jobId, `❌ Worker error: ${err?.message ? String(err.message) : "Worker error"}`);
        }
      });

      w.on("exit", (code) => {
        // Clean-up
        WORKERS.delete(jobId);
        if (ACTIVE_JOB_ID === jobId) ACTIVE_JOB_ID = null;

        const cur = JOBS.get(jobId);
        // If it exited without a terminal state, fail-soft
        if (cur && !cur.finishedAt && cur.status !== "stopped") {
          if (code === 0) {
            setJob(jobId, { status: "completed", message: "Autofill completed" });
            appendJobLog(jobId, "✅ Completed: Autofill completed");
          } else {
            setJob(jobId, { status: "failed", message: `Worker exited (${code})` });
            appendJobLog(jobId, `❌ Worker exited (${code})`);
          }
        }
      });
    } catch (e) {
      setJob(jobId, { status: "failed", message: e?.message ? String(e.message) : "Job failed" });
      appendJobLog(jobId, `❌ Failed: ${e?.message ? String(e.message) : "Job failed"}`);
      try { if (w) await w.terminate(); } catch {}
      try { WORKERS.delete(jobId); } catch {}
      if (ACTIVE_JOB_ID === jobId) ACTIVE_JOB_ID = null;
    }
  })();
});

// ------------------------------------------------------------
// Voice memo / audio -> transcription (Whisper)
// Body: { audioDataUrl, language? }
// Returns: { text }
// ------------------------------------------------------------
app.post("/convert-audio", async (req, res) => {
  try {
    const audioDataUrl = String(req.body?.audioDataUrl || "").trim();
    const language = String(req.body?.language || "").trim(); // optional e.g. "en"

    if (!audioDataUrl) return res.status(400).json({ error: "Missing audioDataUrl" });
    if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: "Missing OPENAI_API_KEY" });

    // Expect: data:audio/<type>;base64,....
    const m = audioDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: "audioDataUrl must be a base64 data URL" });

    const mime = m[1];
    const b64 = m[2];
    const buf = Buffer.from(b64, "base64");

    // Use Node's built-in FormData/Blob (Node 18+ / 22 OK)
    const fd = new FormData();
    const ext = (mime.includes("webm") ? "webm" : mime.includes("mpeg") ? "mp3" : mime.includes("wav") ? "wav" : "m4a");
    const fileName = `voice.${ext}`;
    fd.append("file", new Blob([buf], { type: mime || "application/octet-stream" }), fileName);
    fd.append("model", "whisper-1");
    if (language) fd.append("language", language);

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = data?.error?.message || `OpenAI transcription failed (HTTP ${resp.status})`;
      return res.status(500).json({ error: msg, raw: data });
    }

    return res.json({ text: String(data?.text || "").trim() });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "convert-audio failed" });
  }
});

// ------------------------------------------------------------
// Offline/template-only dictation filler (no OpenAI)
// ------------------------------------------------------------
function stripMarkdownNoise(s) {
  let t = String(s || "");
  t = t.replace(/\*\*/g, "");
  t = t.replace(/’/g, "'");
  return t;
}

function simpleFillTemplate(dictationText, templateText) {
  const dictation = String(dictationText || "").replace(/\r\n/g, "\n");
  const template = String(templateText || "").replace(/\r\n/g, "\n");

  const lines = dictation.split("\n");
  const blocks = new Map();
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

    let j = i + 1;
    while (j < outLines.length && !headingRe.test(outLines[j])) {
      outLines.splice(j, 1);
    }
    if (replLines.length > 1) outLines.splice(i + 1, 0, ...replLines.slice(1));
  }

  return outLines.join("\n").trimEnd() + "\n";
}

function normalizeNewlines(s) {
  return String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function templateLooksPreserved(outText, templateText) {
  const out = normalizeNewlines(outText);
  const tpl = normalizeNewlines(templateText);

  const firstTplLine = tpl.split("\n").map(l => l.trimEnd()).find(l => l.trim() !== "");
  if (firstTplLine && !out.includes(firstTplLine)) return false;

  const tplHeadings = tpl
    .split("\n")
    .map(l => l.trimEnd())
    .filter(l => l.trim() && l.trim().endsWith(":") && l.trim().length <= 80);

  if (tplHeadings.length === 0) return true;

  let hit = 0;
  for (const h of tplHeadings) if (out.includes(h)) hit++;
  return (hit / tplHeadings.length) >= 0.7;
}

// ------------------------------------------------------------
// OpenAI-only: generate 6-sentence Medicare-justifiable HH PT Eval Assessment Summary
// (kept as-is from your current file, with minimal touch)
// ------------------------------------------------------------
function buildHHSummaryFallback({ age = "", gender = "", medicalDx = "", pmh = "", problems = "" }) {
  const a = String(age || "").trim();
  const g = String(gender || "").trim();
  const dx = String(medicalDx || "").trim();
  const p = String(pmh || "").trim();
  const prob = String(problems || "").trim();

  const ageTok = a ? a : "__";
  const genderTok = g ? g : "__";
  const dxTok = dx ? dx : (prob ? prob : "__");
  const pmhTok = p ? p : "__";

  const s1 = `Pt is a ${ageTok} y/o ${genderTok} who presents with HNP of ${dxTok} which consists of PMH of ${pmhTok}.`;
  const s2 = `Pt underwent PT initial evaluation with completion of home safety assessment, DME assessment, and initiation of HEP education, with education provided on fall prevention strategies, proper use of AD, pain and edema management as indicated, and establishment of PT POC and functional goals to progress pt toward PLOF.`;
  const s3 = `Objective findings demonstrate impaired bed mobility, transfers, and gait with AD, poor balance reactions, and generalized weakness contributing to limited household mobility and dependence with ADLs, placing pt at high fall risk.`;
  const s4 = `Pt demonstrates decreased safety awareness and delayed balance reactions within the home environment, with environmental risk factors that further increase fall risk.`;
  const s5 = `Skilled HH PT is medically necessary to provide TherEx, functional mobility training, gait and balance training, and skilled safety education to improve strength, mobility, and functional independence while reducing risk of falls and injury.`;
  const s6 = `Continued skilled HH PT remains indicated.`;

  return [s1, s2, s3, s4, s5, s6].join(" ");
}

function getDesiredSentenceSpec(hay) {
  const t = String(hay || "");
  let min = 6, max = 6;

  const range = t.match(/\b(\d{1,2})\s*(?:-|to)\s*(\d{1,2})\s*sentences?\b/i);
  if (range) {
    min = parseInt(range[1], 10);
    max = parseInt(range[2], 10);
  } else {
    const exact = t.match(/\bexactly\s*(\d{1,2})\s*sentences?\b/i);
    if (exact) {
      min = max = parseInt(exact[1], 10);
    } else {
      const single = t.match(/\b(\d{1,2})\s*sentences?\b/i);
      if (single) min = max = parseInt(single[1], 10);
    }
  }

  if (!Number.isFinite(min)) min = 6;
  if (!Number.isFinite(max)) max = 6;
  min = Math.max(5, Math.min(9, min));
  max = Math.max(5, Math.min(9, max));
  if (max < min) [min, max] = [max, min];
  return { min, max };
}

function validateHHSummary(text, spec = { min: 6, max: 6 }) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, reason: "empty" };
  if (/\n/.test(t)) return { ok: false, reason: "contains line breaks" };
  if (/\b(the\s+patient|patient)\b/i.test(t)) return { ok: false, reason: "contains the word patient" };
  if (/\b(he|she|they|his|her|their)\b/i.test(t)) return { ok: false, reason: "contains pronouns" };

  const sentences = t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const n = sentences.length;

  const min = Number(spec?.min || 6);
  const max = Number(spec?.max || 6);

  if (n < min || n > max) return { ok: false, reason: `sentence count ${n} (need ${min}-${max})` };

  if (sentences[n - 1] !== "Continued skilled HH PT remains indicated.") {
    return { ok: false, reason: "last sentence not exact required string" };
  }

  if (!/^Pt\s+is\s+a\b/.test(sentences[0] || "")) return { ok: false, reason: "sentence 1 must start with 'Pt is a'" };
  if (!/\bpresents\s+with\b/i.test(sentences[0] || "")) return { ok: false, reason: "sentence 1 must include 'presents with'" };
  if (!/\bpmh\b/i.test(sentences[0] || "")) return { ok: false, reason: "sentence 1 must include PMH wording" };

  if (!/^Pt\s+underwent\b/.test(sentences[1] || "")) return { ok: false, reason: "sentence 2 must start with 'Pt underwent'" };
  if (!/^Objective\s+findings\b/.test(sentences[2] || "")) return { ok: false, reason: "sentence 3 must start with 'Objective findings'" };
  if (!/^Pt\s+demonstrates\b/.test(sentences[3] || "")) return { ok: false, reason: "sentence 4 must start with 'Pt demonstrates'" };

  if (n === 5) {
    const s4 = sentences[3] || "";
    if (!/\bskilled\s+hh\s+pt\b/i.test(s4) || !/\b(medically\s+necessary|medical\s+necessity)\b/i.test(s4)) {
      return { ok: false, reason: "5-sentence mode requires skilled need/medical necessity in sentence 4" };
    }
    return { ok: true, reason: "ok" };
  }

  if (!/^Skilled\s+HH\s+PT\b/.test(sentences[4] || "")) return { ok: false, reason: "sentence 5 must start with 'Skilled HH PT'" };

  for (let i = 5; i < n - 1; i++) {
    if (!/^Pt\b/.test(sentences[i])) return { ok: false, reason: `sentence ${i + 1} must start with 'Pt'` };
  }

  return { ok: true, reason: "ok" };
}

async function generateHHEvalAssessmentSummary({ dictation, problemsHint = "" }) {
  const text = String(dictation || "").trim();
  const sentenceSpec = getDesiredSentenceSpec(text);
  const hint = String(problemsHint || "").trim();

  const problems = hint || (() => {
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

  // NOTE: your original prompt references variables (ageForPrompt, etc.) that are not defined in your file.
  // To keep behavior stable and avoid breaking, we use your deterministic fallback if prompt parsing fails.
  // We still attempt to generate via OpenAI safely, but will fall back if anything throws.
  try {
    const prompt = `Return ONLY valid JSON with double quotes.
You must output exactly one key: "clinicalStatement"

GLOBAL RULES:
- Write an Assessment Summary for a Medicare HOME HEALTH PHYSICAL THERAPY INITIAL EVALUATION.
- Sentence count: output between ${sentenceSpec.min} and ${sentenceSpec.max} sentences total.
- One paragraph only. No line breaks, no numbering, no bullets, no quotes.
- Do NOT use he/she/they/his/her/their.
- Do NOT include the word "patient".
- Do NOT include any proper names.

REQUIRED STRUCTURE:
- Last sentence must be EXACTLY: Continued skilled HH PT remains indicated.

PROBLEMS: ${problems}

Now generate the assessment summary following ALL rules exactly.`.trim();

    const parsed = await callOpenAIJSONSafe(prompt, 12000);
    let cs = (parsed && parsed.clinicalStatement ? String(parsed.clinicalStatement) : "").trim();

    const v = validateHHSummary(cs, sentenceSpec);
    if (!v.ok) throw new Error(`invalid summary: ${v.reason}`);
    return cs;
  } catch {
    // Deterministic fallback (never blank)
    const ageMatch = String(dictation || "").match(/(\d{1,3})\s*y\/o/i);
    const age = ageMatch ? ageMatch[1] : "";
    const gender = /\bfemale\b/i.test(dictation || "") ? "female" : (/\bmale\b/i.test(dictation || "") ? "male" : "");
    const pmhMatch = String(dictation || "").match(/(?:^|\n)\s*(?:relevant\s*medical\s*history|pmh)\s*:\s*([^\n\r]+)/i);
    const pmh = pmhMatch ? pmhMatch[1].trim() : "";
    const mdMatch = String(dictation || "").match(/(?:^|\n)\s*medical\s*diagnosis\s*:\s*([^\n\r]+)/i);
    const medicalDx = mdMatch ? mdMatch[1].trim() : "";
    return buildHHSummaryFallback({ age, gender, medicalDx, pmh, problems });
  }
}

// ------------------------------------------------------------
// Convert Dictation → Selected Template
// ------------------------------------------------------------
app.post("/convert-dictation", async (req, res) => {
  try {
    const dictation = String(req.body?.dictation || "").trim();
    const taskType = String(req.body?.taskType || "").trim();
    const templateText = String(req.body?.templateText || "").trim();

    if (!dictation) return res.status(400).json({ error: "Missing dictation" });
    if (!templateText) return res.status(400).json({ error: "Missing templateText" });

    if (!process.env.OPENAI_API_KEY) {
      const filled = simpleFillTemplate(dictation, templateText);
      return res.json({ templateText: filled });
    }

    const prompt = `
You are converting messy PT dictation into the provided WellSky/Kinnser note template.

RULES:
- Output MUST be the template text filled in.
- Preserve ALL headings and section order exactly as shown.
- Preserve ALL whitespace and blank lines exactly as shown in the TEMPLATE. Do NOT remove spacing or indentation.
- Do NOT rename, reword, or add headings/labels. Use the TEMPLATE text verbatim and only fill in blanks.
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
    const candidate = String(out || "");
    let finalText = candidate || simpleFillTemplate(dictation, templateText) || templateText;

    if (candidate && templateText && !templateLooksPreserved(candidate, templateText)) {
      appendJobLog(req.body?.jobId || "convert", "⚠️ Model output did not preserve template headings; using deterministic template fill.");
      finalText = simpleFillTemplate(dictation, templateText) || templateText;
    }

    // Optional Assessment Summary enforcement (kept behavior)
    let patchedText = finalText;
    try {
      const outText = stripMarkdownNoise(patchedText || "");
      const asmtMatch = outText.match(/(?:^|\n)\s*Assessment Summary\s*:\s*([^\n\r]+)/i);
      const asmtLine = asmtMatch ? asmtMatch[1].trim() : "";
      const spec = getDesiredSentenceSpec(`${String(dictation || "")}\n${String(templateText || "")}`);

      if (asmtLine) {
        const vOut = validateHHSummary(asmtLine, spec);
        if (!vOut.ok && process.env.OPENAI_API_KEY) {
          const cs = await generateHHEvalAssessmentSummary({ dictation: `${dictation}\n${templateText}` });
          if (cs) {
            patchedText = String(patchedText || "").replace(
              /(^|\n)(\*\*)?Assessment Summary(\*\*)?\s*:\s*([^\n\r]*)/i,
              (m0, p1) => `${p1}Assessment Summary: ${cs}`
            );
          }
        }
      }
    } catch {}

    return res.json({ templateText: patchedText });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "convert-dictation failed" });
  }
});

// ------------------------------------------------------------
// Convert Image → Selected Template (Vision)
// ------------------------------------------------------------
app.post("/convert-image", async (req, res) => {
  try {
    const imageDataUrl = String(req.body?.imageDataUrl || "").trim();
    const taskType = String(req.body?.taskType || "").trim();
    const templateText = String(req.body?.templateText || "").trim();

    if (!imageDataUrl) return res.status(400).json({ error: "Missing imageDataUrl" });
    if (!templateText) return res.status(400).json({ error: "Missing templateText" });

    if (!process.env.OPENAI_API_KEY) return res.json({ templateText });

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
    const finalText = String(obj?.templateText || "");
    return res.json({ templateText: finalText || templateText });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "convert-image failed" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`UI server listening on 0.0.0.0:${PORT}`);
});
