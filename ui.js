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

    // If OpenAI is not configured, fail soft and just return the template
    if (!process.env.OPENAI_API_KEY) {
      return res.json({ templateText });
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
    const finalText = String(out || "").trim() || templateText;

    return res.json({ templateText: finalText });
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
    return res.json({ templateText: finalText || templateText });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "convert-image failed" });
  }
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`UI server listening on 0.0.0.0:${PORT}`);
});
