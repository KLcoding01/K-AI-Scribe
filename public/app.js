// app.js (FULL FILE)
// - ELITE Subjective extractor: blocks demographics/PMH from Subjective (eval/visit)
// - Pt Visit ONLY: Medicare-justifiable 6-sentence Assessment generator + patch
// - ELITE PT Evaluation: strict 6-sentence Assessment Summary generator in your required format
// - Keeps spacing/formatting intact; client-side post-patch only (no server changes)

'use strict';

// -------------------------
// Sanitize AI Notes
// -------------------------
function sanitizeNotes(text) {
  let t = String(text ?? "");
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  t = t.replace(/\u00A0/g, " ");
  return t;
}


// -------------------------
// Vitals extraction + stripping (dictation hygiene)
// -------------------------
function extractVitalsFromText(raw = "") {
  const t = String(raw || "");
  const bp = t.match(/\b(?:bp|blood\s*pressure)\s*[:=]?\s*(\d{2,3})\s*\/\s*(\d{2,3})\b/i);
  const hr = t.match(/\b(?:heart\s*rate|hr)\s*[:=]?\s*(\d{2,3})\b/i);
  const rr = t.match(/\b(?:resp(?:irations?)?|rr)\s*[:=]?\s*(\d{1,2})\b/i);
  const temp = t.match(/\b(?:temp(?:erature)?)\s*[:=]?\s*(\d{2,3}(?:\.\d)?)\b/i);

  return {
    bpSys: bp ? String(bp[1]) : "",
    bpDia: bp ? String(bp[2]) : "",
    heartRate: hr ? String(hr[1]) : "",
    respirations: rr ? String(rr[1]) : "",
    temperature: temp ? String(temp[1]) : "",
  };
}

function patchVitalsInTemplate(templateTextRaw = "", vitals = {}) {
  let t = String(templateTextRaw || "");
  if (!t) return t;

  const v = vitals || {};
  if (v.temperature) t = t.replace(/(\bTemp\s*:\s*)([^\n\r]*)/i, `$1${v.temperature}`);
  if (v.bpSys || v.bpDia) {
    const bpVal = `${v.bpSys || ""}${(v.bpSys || v.bpDia) ? " / " : ""}${v.bpDia || ""}`.trim();
    t = t.replace(/(\bBP\s*:\s*)([^\n\r]*)/i, `$1${bpVal}`);
  }
  if (v.heartRate) t = t.replace(/(\bHeart\s*Rate\s*:\s*)([^\n\r]*)/i, `$1${v.heartRate}`);
  if (v.respirations) t = t.replace(/(\bRespirations\s*:\s*)([^\n\r]*)/i, `$1${v.respirations}`);

  return t;
}


// -------------------------
// Subjective capture (ELITE) — blocks demographics/PMH/diagnosis from Subjective
// -------------------------
function looksGenericSubjective(text = "") {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return true;
  if (t.length < 10) return true;
  if (t === "." || t === "-" || t === "n/a" || t === "na") return true;

  const genericPhrases = [
    "pt agrees to pt evaluation",
    "pt agrees to pt re-evaluation",
    "pt agrees to pt tx",
    "pt agrees to therapy",
    "agrees to pt",
    "agrees to therapy",
    "no new complaints",
    "denies pain today",
    "tolerated tx well",
    "tolerated treatment well",
    "no adverse reactions",
    "no adverse reaction",
    "no change since last visit",
    "no changes since last visit",
    "subjective:",
  ];

  return genericPhrases.some(p => t.includes(p));
}

function normalizeSubjectTokens(s = "") {
  let t = String(s || "");
  t = t.replace(/\bpatient\b/ig, "Pt");
  t = t.replace(/\bcomplains of\b/ig, "c/o");
  t = t.replace(/\bc\/o\b/ig, "c/o");
  t = t.replace(/\bPt\s+Pt\b/ig, "Pt");
  t = t.replace(/\s+/g, " ").trim();
  if (t && !/[.!?]$/.test(t)) t += ".";
  return t;
}

function stripJunkFromDictation(raw = "") {
  const text = String(raw || "").replace(/\r\n/g, "\n");

  const lines = text
    .split("\n")
    .map(l => String(l || "").trim())
    .filter(Boolean)
    // Remove prompt/instruction lines
    .filter(l => !/^\s*(generate|write|create|revise|condense|make|fix)\b/i.test(l));

  let joined = lines.join(" ");

  // Strip vitals fragments
  joined = joined
    .replace(/\b(?:bp|blood\s*pressure)\s*[:=]?\s*\d{2,3}\s*\/\s*\d{2,3}\b/ig, "")
    .replace(/\b(?:heart\s*rate|hr)\s*[:=]?\s*\d{2,3}\b/ig, "")
    .replace(/\b(?:resp(?:irations?)?|rr)\s*[:=]?\s*\d{1,2}\b/ig, "")
    .replace(/\b(?:temp(?:erature)?)\s*[:=]?\s*\d{2,3}(?:\.\d)?\b/ig, "");

  // Remove headings if pasted
  joined = joined.replace(/\b(subjective|assessment summary|assessment|plan|goals|vital signs|pain assessment)\s*[:\-]?\b/ig, " ");

  return joined.replace(/\s+/g, " ").trim();
}

function splitSentencesSmart(text = "") {
  const t = String(text || "").trim();
  if (!t) return [];
  // split on . ! ? but keep abbreviations simple
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z(]|Pt\b|pt\b|CG\b|cg\b)/g);
  return parts.map(s => s.trim()).filter(Boolean);
}

function scoreSubjectiveSentence(sentence = "") {
  const t = String(sentence || "").trim();
  const low = t.toLowerCase();
  if (!t) return -999;

  // Hard exclude demographics / PMH / dx style lines
  const exclude = [
    "y/o", "year old", "female", "male", "pmh", "history", "diagnosis", "dx", "medical diagnosis",
    "htn", "dm", "hld", "cad", "ckd", "copd", "cva", "afib", "bph", "cancer", "prostate",
    "gait training", "transfer training", "bed mobility",
    "vc", "tc", "mmt", "mmts", "rom", "tinetti", "poma", "stairs",
    "educated", "education", "instructed",
    "assessment summary", "assessment:", "plan", "goals",
    "skilled", "medically necessary", "vital signs", "bp", "hr", "rr", "temp"
  ];
  if (exclude.some(k => low.includes(k))) return -500;

  let score = 0;

  // Strong subjective verbs/phrases
  if (/\b(pt\s*)?(reports?|states?|verbalizes?|verbalized|noted|denies|c\/o|complains?|endorses?)\b/i.test(t)) score += 10;
  if (/\b(caregiver|cg|family|daughter|son|wife|husband)\s+reports?\b/i.test(t)) score += 10;

  // Symptom/tolerance cues
  if (/\b(pain|sore|stiff|dizzy|fatigue|tired|weak|numb|tingl|radicul|fear of falling|falls)\b/i.test(t)) score += 4;

  // Starts like a subjective statement
  if (/^(pt|caregiver|cg|family|daughter|son|wife|husband)\b/i.test(t)) score += 2;

  // Penalize generic consent-only lines
  if (/(agrees to (pt|therapy)|no new complaints|tolerated)/i.test(t)) score -= 4;

  // Penalize very short fragments
  if (t.length < 20) score -= 2;

  return score;
}

// ELITE extractor: returns 1–2 true subjective sentences max, excludes demographics/PMH
function extractSubjectiveFromDictation(dictationRaw = "") {
  const raw = String(dictationRaw || "").trim();
  if (!raw) return "Pt agrees to PT evaluation and treatment.";

  const cleaned = stripJunkFromDictation(raw);
  if (!cleaned) return "Pt agrees to PT evaluation and treatment.";

  const norm = normalizeSubjectTokens(cleaned);
  const sentences = splitSentencesSmart(norm);

  const scored = sentences
    .map(s => ({ s: s.trim(), score: scoreSubjectiveSentence(s) }))
    .filter(x => x.s && x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return "Pt agrees to PT evaluation and treatment.";

  const picked = [];
  for (const item of scored) {
    if (picked.length >= 2) break;
    if (!picked.includes(item.s)) picked.push(item.s);
  }

  return normalizeSubjectTokens(picked.join(" "));
}

// Patch Subjective in template robustly:
// - Supports "Subjective:" OR "Subjective" (no colon) headers
// - Replaces content until next heading-like line
// - Only overwrites if existing Subjective looks generic/placeholder
function patchSubjectiveInTemplate(templateTextRaw = "", subjectiveTextRaw = "") {
  const templateText = String(templateTextRaw || "");
  const subj = String(subjectiveTextRaw || "").trim();
  if (!templateText || !subj) return templateText;

  const re = /(^\s*Subjective\s*:?\s*\n)([\s\S]*?)(?=\n\s*(?:Vital\s*Signs|Pain|Pain\s*Assessment|Functional\s*Status|Living\s*Situation|Neuro|ROM|Strength|Assessment|Goals|Plan)\b|$)/im;
  if (!re.test(templateText)) {
    // Fallback: if there's "Subjective:" on same line
    const re2 = /(^\s*Subjective\s*:?\s*)([^\n\r]*)/im;
    if (re2.test(templateText)) {
      const current = (templateText.match(re2) || [])[2] || "";
      if (!looksGenericSubjective(current)) return templateText;
      return templateText.replace(re2, `$1${subj}`);
    }
    return templateText;
  }

  const m = templateText.match(re);
  const currentBlock = (m && m[2]) ? String(m[2]).trim() : "";
  if (currentBlock && !looksGenericSubjective(currentBlock)) return templateText;

  return templateText.replace(re, `$1${subj}\n`);
}


// -------------------------
// PT Visit Assessment generator + patch (ELITE 6 sentences)
// -------------------------
function buildVisitAssessmentFromDictation(dictationRaw = "") {
  const d = String(dictationRaw || "").toLowerCase();

  const hasWeak = /\bweak|weakness\b/i.test(d);
  const hasBalance = /\bbalance|unsteady|fall risk|fear of falling\b/i.test(d);
  const hasPainMgmt = /\bpain\b/i.test(d);
  const hasLBP = /\blow back|lbp|lumbar\b/i.test(d);
  const hasCancer = /\bprostate\b|\bcx\b|\bcancer\b/i.test(d);
  const hasFallRisk = /\bfall risk\b/i.test(d) || hasBalance;

  const s1 = (() => {
    if (hasLBP) return "Pt demonstrates fair tolerance to PT tx today with improved participation following skilled interventions to address chronic LBP and mobility limitations.";
    if (hasPainMgmt) return "Pt demonstrates fair tolerance to PT tx today with improved participation following skilled interventions to address pain and functional limitations.";
    return "Pt demonstrates fair tolerance to PT tx today with improved participation following skilled interventions to address mobility limitations.";
  })();

  const s2 = (() => {
    const focus = [];
    if (hasWeak) focus.push("strengthening");
    if (hasBalance) focus.push("balance/safety training");
    focus.push("functional mobility training");
    return `Skilled PT provided ${focus.join(", ")}, with VC/TC for pacing, posture, and body mechanics.`;
  })();

  const s3 = (() => {
    const deficits = [];
    if (hasWeak) deficits.push("LE weakness");
    if (hasBalance) deficits.push("impaired balance reactions");
    deficits.push("reduced activity tolerance");
    const defText = deficits.length ? deficits.join(", ") : "ongoing strength and balance deficits";
    return `Pt demonstrates gradual functional improvement; however, ${defText} continue to limit task carryover and increase fall risk during mobility.`;
  })();

  const s4 = (() => {
    if (hasCancer) {
      return "Gait and safety training incorporated pacing, AD management, and environmental scanning due to medical complexity and fatigue/safety concerns associated with prostate cx and radiation tx.";
    }
    return "Gait and safety training incorporated pacing, AD management, and environmental scanning to reduce fall/injury risk during mobility within the home.";
  })();

  const s5 = (() => {
    const risk = hasFallRisk ? "high fall risk" : "increased fall risk";
    const painClause = (hasLBP || hasPainMgmt) ? "manage pain flare-ups, " : "";
    return `Pt continues to require skilled PT for real-time clinical judgment to ${painClause}progress exercise dosing, and provide ongoing VC/TC for safety due to ${risk} and variable tolerance.`;
  })();

  const s6 = "Continued skilled HH PT remains medically necessary to progress toward goals, maximize functional independence, and prevent decline/hospitalization.";

  const clean = (s) => {
    let t = String(s || "").trim().replace(/\s+/g, " ");
    t = t.replace(/\bPt\s+Pt\b/ig, "Pt").replace(/\.\.+/g, ".");
    if (!/[.!?]$/.test(t)) t += ".";
    return t;
  };

  return [clean(s1), clean(s2), clean(s3), clean(s4), clean(s5), clean(s6)].join(" ");
}

function patchVisitAssessmentInTemplate(templateTextRaw = "", assessmentTextRaw = "") {
  const templateText = String(templateTextRaw || "");
  const assess = String(assessmentTextRaw || "").trim();
  if (!templateText || !assess) return templateText;

  const re = /(^\s*Assessment\s*:\s*)([\s\S]*?)(?=\n\s*(?:Plan|Goals|Frequency|Effective\s*Date)\b|$)/im;
  if (re.test(templateText)) {
    return templateText.replace(re, `$1${assess}\n`);
  }

  return templateText + `\n\nAssessment:\n${assess}\n`;
}


// -------------------------
// ELITE PT Evaluation Assessment Summary generator (STRICT FORMAT)
// -------------------------
function buildEvalAssessmentSummaryFromDictation(dictationRaw = "") {
  const d = String(dictationRaw || "");
  const ageMatch = d.match(/(\d{1,3})\s*y\/o/i);
  const age = ageMatch ? ageMatch[1] : "__";
  const gender = /\bfemale\b/i.test(d) ? "female" : (/\bmale\b/i.test(d) ? "male" : "__");

  const pmhMatch = d.match(/(?:pmh|relevant\s*medical\s*history)\s*[:\-]?\s*([^\n\r]+)/i);
  const pmh = pmhMatch ? pmhMatch[1].trim() : "__";

  const mdMatch = d.match(/medical\s*diagnosis\s*[:\-]?\s*([^\n\r]+)/i);
  const md = mdMatch ? mdMatch[1].trim() : "__";

  const s1 = `Pt is a ${age} y/o ${gender} who presents with HNP of ${md} which consists of PMH of ${pmh}.`;
  const s2 = "Pt underwent PT initial evaluation with completion of home safety assessment, DME assessment, and initiation of HEP education, with education provided on fall prevention strategies, proper use of AD, pain and edema management as indicated, and establishment of PT POC and functional goals to progress pt toward PLOF.";
  const s3 = "Objective findings demonstrate impaired bed mobility, transfers, and gait with AD, poor balance reactions, and generalized weakness contributing to limited household mobility and dependence with ADLs, placing pt at high fall risk.";
  const s4 = "Pt demonstrates decreased safety awareness and delayed balance reactions within the home environment, with environmental risk factors that further increase fall risk.";
  const s5 = "Skilled HH PT is medically necessary to provide TherEx, functional mobility training, gait and balance training, and skilled safety education to improve strength, mobility, and functional independence while reducing risk of falls and injury.";
  const s6 = "Continued skilled HH PT remains indicated.";

  return [s1, s2, s3, s4, s5, s6].join(" ");
}

function patchEvalAssessmentSummary(templateTextRaw = "", summaryTextRaw = "") {
  const templateText = String(templateTextRaw || "");
  const summary = String(summaryTextRaw || "").trim();
  if (!templateText || !summary) return templateText;

  const re = /(^|\n)(Assessment Summary\s*:\s*)([^\n\r]*)/i;
  if (re.test(templateText)) {
    return templateText.replace(re, (m0, p1, p2) => `${p1}${p2}${summary}`);
  }
  return templateText + `\n\nAssessment Summary: ${summary}\n`;
}


// -------------------------
// UI + API
// -------------------------
(() => {
  const LS_ACTIVE_JOB_ID = "ks_active_job_id";

  function el(id) { return document.getElementById(id); }

  const badge = el("badge");
  const statusBox = el("status");

  function setBadge(text, kind) {
    if (!badge) return;
    badge.textContent = text || "";
    badge.className = "badge" + (kind ? ` ${kind}` : "");
  }

  function setStatus(text) {
    if (!statusBox) return;
    statusBox.textContent = text || "";
  }

  async function httpJson(url, opts = {}) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    const bodyText = await res.text().catch(() => "");
    let body = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = bodyText; }
    if (!res.ok) {
      const err = new Error((body && body.error) ? body.error : `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  async function testHealth() {
    try {
      setBadge("Checking…", "warn");
      const r = await httpJson("/health", { method: "GET" });
      setBadge("OK", "ok");
      setStatus(JSON.stringify(r, null, 2));
    } catch (e) {
      setBadge("Health failed", "bad");
      setStatus(`Health failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
    }
  }

  // ------------------------------
  // Job polling (resume-safe)
  // ------------------------------
  let pollTimer = null;
  let activeJobId = null;

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function pollJob(jobId) {
    stopPolling();
    if (!jobId) return;

    pollTimer = setInterval(async () => {
      try {
        const job = await httpJson(`/job-status/${encodeURIComponent(jobId)}`, { method: "GET" });

        if (job.status === "completed") setBadge("Completed", "ok");
        else if (job.status === "failed") setBadge("Failed", "bad");
        else if (job.status === "stopped") setBadge("Stopped", "warn");
        else setBadge(job.status || "running", "warn");

        const summaryLines = [
          `jobId: ${job.jobId}`,
          `status: ${job.status}`,
          `message: ${job.message || ""}`,
          `startedAt: ${job.startedAt ? new Date(job.startedAt).toISOString() : ""}`,
          `updatedAt: ${job.updatedAt ? new Date(job.updatedAt).toISOString() : ""}`,
          `finishedAt: ${job.finishedAt ? new Date(job.finishedAt).toISOString() : ""}`,
        ];

        const logText = Array.isArray(job.logs) ? job.logs.join("\n") : (job.log || "");
        setStatus(summaryLines.join("\n") + (logText ? `\n\n${logText}` : ""));

        if (job.status === "completed" || job.status === "failed" || job.status === "stopped") {
          try { localStorage.removeItem(LS_ACTIVE_JOB_ID); } catch {}
          stopPolling();
        }
      } catch (e) {
        setBadge("Polling error", "bad");
        setStatus(`Polling failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
        stopPolling();
      }
    }, 1200);
  }

  function clearForm() {
    el("patientName").value = "";
    el("visitDate").value = "";
    el("timeIn").value = "";
    el("timeOut").value = "";
    el("aiNotes").value = sanitizeNotes("");
    if (el("dictationNotes")) el("dictationNotes").value = "";
    if (el("imageFile")) el("imageFile").value = "";
    if (el("audioFile")) el("audioFile").value = "";
    setBadge("Idle");
    setStatus("No job yet.");
    activeJobId = null;
    try { localStorage.removeItem(LS_ACTIVE_JOB_ID); } catch {}
    stopPolling();
  }

  async function runAutomation() {
    const kinnserUsername = el("kinnserUsername").value.trim();
    const kinnserPassword = el("kinnserPassword").value;
    const patientName = el("patientName").value.trim();
    const visitDate = el("visitDate").value;
    const taskType = el("taskType").value;
    const timeIn = el("timeIn").value.trim();
    const timeOut = el("timeOut").value.trim();
    const aiNotes = el("aiNotes").value || "";

    if (!patientName || !visitDate || !taskType) {
      setBadge("Missing fields", "bad");
      setStatus("Please fill Patient name, Visit date, and Task type.");
      return;
    }

    if (!kinnserUsername || !kinnserPassword) {
      setBadge("Missing login", "bad");
      setStatus("Please enter Kinnser username and password.");
      return;
    }

    try {
      el("btnRun").disabled = true;
      setBadge("Starting…", "warn");
      setStatus("Submitting job…");

      const body = {
        kinnserUsername,
        kinnserPassword,
        patientName,
        visitDate,
        taskType,
        timeIn,
        timeOut,
        aiNotes: aiNotes.replace(/\r\n/g, "\n"),
      };

      const resp = await httpJson("/run-automation", {
        method: "POST",
        body: JSON.stringify(body),
      });

      activeJobId = resp.jobId;
      try { localStorage.setItem(LS_ACTIVE_JOB_ID, activeJobId); } catch {}
      setBadge("Running", "warn");
      setStatus(`Job started.\njobId: ${activeJobId}`);
      await pollJob(activeJobId);
    } catch (e) {
      setBadge("Start failed", "bad");
      setStatus(`Start failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
    } finally {
      el("btnRun").disabled = false;
    }
  }

  async function stopAutomation() {
    if (!activeJobId) {
      setBadge("No active job", "warn");
      setStatus("No running job to stop.");
      return;
    }
    try {
      if (el("btnStop")) el("btnStop").disabled = true;
      setBadge("Stopping…", "warn");
      setStatus(`Requesting stop for jobId: ${activeJobId} …`);
      const resp = await httpJson("/stop-job", {
        method: "POST",
        body: JSON.stringify({ jobId: activeJobId }),
      });
      setBadge("Stop requested", "warn");
      setStatus(`Stop requested.\n${JSON.stringify(resp || {}, null, 2)}`);
      await pollJob(activeJobId);
    } catch (e) {
      setBadge("Stop failed", "bad");
      setStatus(`Stop failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
    } finally {
      if (el("btnStop")) el("btnStop").disabled = false;
    }
  }

  async function resumeActiveJobIfAny() {
    try {
      const saved = localStorage.getItem(LS_ACTIVE_JOB_ID) || "";
      if (!saved) return;
      activeJobId = saved;
      setBadge("Resuming…", "warn");
      setStatus(`Resuming existing job.\njobId: ${activeJobId}`);
      await pollJob(activeJobId);
    } catch {}
  }

  async function convertDictation() {
    const dictation = (el("dictationNotes")?.value || "").trim();
    if (!dictation) {
      setBadge("Convert failed", "bad");
      setStatus("Convert failed:\nPlease enter dictation first.");
      return;
    }

    try {
      el("btnConvert").disabled = true;
      setBadge("Converting…", "warn");
      setStatus("Converting dictation → selected template…");

      const taskType = (el("taskType")?.value || "").trim();
      const templateKey = (el("templateKey")?.value || "").trim();

      let templateText = "";
      if (templateKey && TEMPLATES[templateKey]) templateText = TEMPLATES[templateKey];
      else if ((taskType || "").toLowerCase().includes("evaluation") && TEMPLATES.pt_eval_default) templateText = TEMPLATES.pt_eval_default;
      else templateText = TEMPLATES.pt_visit_default || "";

      const resp = await httpJson("/convert-dictation", {
        method: "POST",
        body: JSON.stringify({ dictation, taskType, templateText }),
      });

      let outText = String(resp.templateText || "");

      // Subjective: always patch from dictation if AI output subjective looks generic
      const subjFromDictation = extractSubjectiveFromDictation(dictation);
      outText = patchSubjectiveInTemplate(outText, subjFromDictation);

      // Pt Visit ONLY: patch Assessment
      if ((taskType || "").toLowerCase().includes("visit")) {
        const visitAssess = buildVisitAssessmentFromDictation(dictation);
        outText = patchVisitAssessmentInTemplate(outText, visitAssess);
      }

      // PT Evaluation ONLY: patch vitals + Assessment Summary strict 6 sentences
      if ((taskType || "").toLowerCase().includes("evaluation")) {
        const vitals = extractVitalsFromText(dictation);
        outText = patchVitalsInTemplate(outText, vitals);

        const evalSummary = buildEvalAssessmentSummaryFromDictation(dictation);
        outText = patchEvalAssessmentSummary(outText, evalSummary);
      }

      el("aiNotes").value = sanitizeNotes(outText);
      setBadge("Ready", "ok");
      setStatus("Conversion completed. Review AI Notes, then click Run Automation.");
    } catch (e) {
      setBadge("Convert failed", "bad");
      setStatus(`Convert failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
    } finally {
      el("btnConvert").disabled = false;
    }
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("File read failed"));
      reader.readAsDataURL(file);
    });
  }

  async function convertImage() {
    const file = el("imageFile")?.files?.[0];
    if (!file) {
      setBadge("Image convert failed", "bad");
      setStatus("Image convert failed:\nPlease choose an image file first.");
      return;
    }

    try {
      el("btnConvertImage").disabled = true;
      setBadge("Converting…", "warn");
      setStatus("Converting image → selected template…");

      const imageDataUrl = await fileToDataUrl(file);

      const taskType = (el("taskType")?.value || "").trim();
      const templateKey = (el("templateKey")?.value || "").trim();

      let templateText = "";
      if (templateKey && TEMPLATES[templateKey]) templateText = TEMPLATES[templateKey];
      else if ((taskType || "").toLowerCase().includes("evaluation") && TEMPLATES.pt_eval_default) templateText = TEMPLATES.pt_eval_default;
      else templateText = TEMPLATES.pt_visit_default || "";

      const resp = await httpJson("/convert-image", {
        method: "POST",
        body: JSON.stringify({ imageDataUrl, taskType, templateText }),
      });

      el("aiNotes").value = sanitizeNotes(resp.templateText || "");
      setBadge("Ready", "ok");
      setStatus("Image conversion completed. Review AI Notes, then click Run Automation.");
    } catch (e) {
      setBadge("Image convert failed", "bad");
      setStatus(`Image convert failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
    } finally {
      el("btnConvertImage").disabled = false;
    }
  }

  // Voice memo / audio → dictation → template
  async function convertAudio() {
    const file = el("audioFile")?.files?.[0];
    if (!file) {
      setBadge("Audio convert failed", "bad");
      setStatus("Audio convert failed:\nPlease choose an audio file first (Voice Memo .m4a/.mp3/.wav).");
      return;
    }

    try {
      if (el("btnConvertAudio")) el("btnConvertAudio").disabled = true;
      setBadge("Transcribing…", "warn");
      setStatus("Uploading audio → transcribing → converting into template…");

      const audioDataUrl = await fileToDataUrl(file);

      const taskType = (el("taskType")?.value || "").trim();
      const templateKey = (el("templateKey")?.value || "").trim();

      let templateText = "";
      if (templateKey && TEMPLATES[templateKey]) templateText = TEMPLATES[templateKey];
      else if ((taskType || "").toLowerCase().includes("evaluation") && TEMPLATES.pt_eval_default) templateText = TEMPLATES.pt_eval_default;
      else templateText = TEMPLATES.pt_visit_default || "";

      const resp = await httpJson("/convert-audio", {
        method: "POST",
        body: JSON.stringify({ audioDataUrl, taskType, templateText }),
      });

      if (el("dictationNotes") && resp.dictation) el("dictationNotes").value = sanitizeNotes(resp.dictation || "");
      el("aiNotes").value = sanitizeNotes(resp.templateText || "");
      setBadge("Ready", "ok");
      setStatus("Audio conversion completed. Review AI Notes, then click Run Automation.");
    } catch (e) {
      setBadge("Audio convert failed", "bad");
      setStatus(`Audio convert failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
    } finally {
      if (el("btnConvertAudio")) el("btnConvertAudio").disabled = false;
    }
  }

  // ------------------------------
  // Templates (client-side)
  // ------------------------------
  const TEMPLATES = {
    pt_visit_default: `Subjective:
Pt reports no new complaints and agrees to PT tx today.

Vital Signs
Temp:
Temp Type: Temporal
BP:
Heart Rate:
Respirations:
Comments: Pt currently symptom-free with no adverse reactions noted. Cleared to continue with PT as planned.

Pain Assessment
Pain: No/Yes/Skip
Location Other:
Intensity (0–10):
Increased by:
Relieved by:
Interferes with:

Functional Status
Bed Mobility:
Transfers:
Gait:

Response to Treatment:
Pt tolerated tx well with no adverse reactions noted.

Exercises:
Seated LAQ: 2 x 10 reps
Seated marching: 2 x 10 reps
Sit-to-stand: 2 x 10 reps
Heel raises: 2 x 10 reps
Clamshells: 2 x 10 reps
Figure 4 stretch: 3 x 30-sec hold each
Hamstring stretch: 3 x 30-sec hold each

Impact of Exercise(s) on Functional Performance / Patient Response to Treatment:
Patient is appropriately challenged by the current therapeutic exercise program without any adverse responses. Rest breaks are needed to manage fatigue. Patient requires reminders and both verbal and tactile cues to maintain proper body mechanics.

Teaching Tools / Education Tools / Teaching Method:
Verbal, tactile, demonstration, illustration.

Progress to goals indicated by:
Motivation/willingness to work with PT.

Needs continued skilled PT to address:
Functional mobility training, strength training, balance/safety training, proper use of AD, HEP education, and fall prevention.

Balance Test:
NT

Posture Training:
Education provided to improve postural awareness.

Assessment:
(autofilled after Convert)
`,
    pt_eval_default: `Medical Diagnosis: 
PT Diagnosis: Muscle weakness, Functional Mobility Deficit, Unsteady Gait/Balance, Impaired Activity Tolerance 
Precautions: Fall Risk
Relevant Medical History: 
Prior Level of Function: Need some assistance with functional mobility, gait, and ADLs.
Patient Goals: To improve mobility, strength, activity tolerance, decrease fall risk, and return to PLOF.

Vital Signs
Temp: 97.6
Temp Type: Temporal
BP:
Heart Rate:
Respirations: 18
Comments: Pt is currently symptom-free and demonstrates no adverse reactions. Cleared to continue with physical therapy as planned. 

Subjective: Pt agrees to PT evaluation.

Pain: Yes/No
Primary Location Other: 
Intensity (0–10): 
Increased by: 
Relieved by: 
Interferes with:

Living Situation
Patient Lives: With other in home
Assistance Available: around the clock
Current Assistance Types: Family/daughter
Steps/Stairs Present: No
Steps Count:

Neuro / Physical
Orientation: AOx3 
Speech: Unremarkable
Vision: Blurred vision
Hearing: B HOH
Skin: Intact
Muscle Tone: Muscle Weakness
Coordination: Fair-
Sensation: NT
Endurance: Poor
Posture: Forward head lean, slouch posture, rounded shoulders, increased mid T-spine kyphosis

Functional Status
Bed Mobility:
Bed Mobility AD:
Transfers:
Transfers AD:

Gait
Level Surfaces
Gait:
Gait Distance:
Gait AD:

Uneven Surfaces:
Uneven Surfaces Distance:
Uneven Surfaces AD:

Stairs: 
Stairs Distance:
Stairs AD:

Weight Bearing: FWB

DME Other: FWW and Transport Chair

Edema: Absent
Type:
Location:
Pitting Grade:

Assessment Summary:

Goals
Short-Term Goals (2)
STG 1: Pt will demonstrate safe bed mobility with Indep within 4 visits.
STG 2: Pt will demonstrate safe transfers with Indep within 4 visits.

Long-Term Goals (3)
LTG 1: Pt will ambulate 150 ft using FWW with Indep within 7 visits.
LTG 2: Pt will demonstrate Indep with HEP, fall/safety precautions, improved safety awareness, and improved activity tolerance with ADLs within 7 visits.
LTG 3: Pt will improve B LE strength by ≥0.5 MMT grade to enhance functional mobility within 7 visits.
LTG 4: Pt will improve Tinetti Poma score to 20/28 or more to decrease fall risk within 7 visits.

Plan
Frequency: 1w1, 2w3
Effective Date: `
    ,
    pt_discharge_default: `Vital Signs
Temp:
Temp Type: Temporal
BP:
Heart Rate:
Respirations: 18
Comments: Pt is currently symptom-free and demonstrates no adverse reactions. Cleared to continue with physical therapy as planned.
Pain:

ROM / Strength:

Functional Assessment
Rolling:
Sup to Sit:
Sit to Sup:

Transfers
Sit to Stand:
Stand to Sit:
Toilet/BSC:
Tub/Shower:

Gait – Level:
Distance:
Gait – Unlevel:
Steps/stairs:

Balance
Sitting: Movement/mobility within position
Standing: Movement/mobility within position

Evaluation and Testing Description: PT discharge, home environment assessment, and DME assessment have been completed. Pt was instructed and educated on the importance of adhering to a daily HEP to maintain strength, mobility, and function. Fall prevention strategies and home safety measures were reviewed and reinforced. Pt demonstrated understanding and is safe to continue independently at home.
Treatment / Skilled Intervention: MMT, ROM, balance assessment, functional independence measure test, gait analysis, fall/safety prevention assessment.

Goals
Goals Met:
Goals not Met:
Goals Summary:

Page 2

Reason For Discharge
Reason for discharge: PT POC completed and goals partially met.

Condition at Discharge
Current Status: Independent / Dependent / Needs Assistance / Needs Supervision
Physical and Psychological Status: Pt presents with a pleasant demeanor and is able to follow simple physical therapy instructions to perform functional tasks when prompted.
Course of Illness and Treatment
Services Provided: Skilled physical therapy services were provided to address deficits in strength, balance, mobility, and functional independence. Interventions included TherEx, TherAct, gait and balance training, functional mobility training, and patient/caregiver education with VC/TC as needed to promote safety and carryover. Services were directed toward reducing fall risk, improving ADLs, and progressing the pt toward PLOF per established POC.
Frequency/Duration: See IE.
Patient Progress/Response: Pt demonstrates good tolerance to HH PT and has successfully met established goals. Pt is now independent with HEP and demonstrates good understanding of proper form and safety techniques. Improved overall mobility, strength, and balance noted during sessions. Education reinforced on continuation of HEP to maintain progress and prevent decline. No adverse reactions observed, and Pt verbalized confidence managing exercises independently. Continued PT not indicated at this time unless functional decline occurs.
Post Discharge Goals: Pt will continue with daily HEP to maintain strength, flexibility, and activity tolerance; continue Indep with transfers and ambulation without assistive device as able; maintain safety during stair use; and seek follow-up with PCP if new symptoms or changes in mobility occur.
Information Provided: Pt/family/caregiver reviewed fall and safety precautions for ADLs and functional mobility, and received training and review HEP with emphasis on safety and proper body mechanics.
Treatment Preferences: Pt prefers to continue a home-based exercise routine and safe functional training under PT guidance, focusing on improving mobility and activity tolerance. Patient is agreeable to ongoing HEP and family/caregiver support as needed.`
    ,
    pt_reeval_default: `Subjective
Pt agrees to PT Re-evaluation.

Vital Signs
Temp:
Temp Type: Temporal
BP:
Heart Rate:
Respirations: 18
Comments: Pt is currently symptom-free and demonstrates no adverse reactions. Cleared to continue with physical therapy as planned.

Pain:

ROM / Strength:

Functional Assessment
Rolling:
Sup to Sit:
Sit to Sup:

Transfers
Sit to Stand:
Stand to Sit:
Toilet/BSC:
Tub/Shower:

Gait – Level:
Distance:
Gait – Unlevel:
Steps/stairs:

Balance
Sitting: Movement/mobility within position
Standing: Movement/mobility within position

Assessment Summary:

Goals
Short-Term Goals
STG 1:
STG 2:

Long-Term Goals
LTG 1:
LTG 2:
LTG 3:
LTG 4:

Plan
Frequency:
Effective Date: `
  };

  function initTemplates() {
    const dd = el("templateKey");
    if (!dd) return;
    dd.innerHTML = `
      <option value="">(None)</option>
      <option value="pt_eval_default">PT Evaluation (Default)</option>
      <option value="pt_visit_default">PT Visit (Default)</option>
      <option value="pt_reeval_default">PT Re-Evaluation (Default)</option>
      <option value="pt_discharge_default">PT Discharge (Default)</option>
    `;
    dd.addEventListener("change", () => {
      const key = dd.value;
      if (!key) return;
      el("aiNotes").value = sanitizeNotes(TEMPLATES[key] || "");
      setBadge("Template loaded", "ok");
      setStatus(`Loaded template: ${key}`);
    });
  }

  // ------------------------------
  // Remember Kinnser credentials (localStorage)
  // ------------------------------
  function loadSavedCreds() {
    try {
      const u = localStorage.getItem("ks_kinnser_user") || "";
      const p = localStorage.getItem("ks_kinnser_pass") || "";
      if (u) el("kinnserUsername").value = u;
      if (p) el("kinnserPassword").value = p;
      if (el("rememberCreds") && (u || p)) el("rememberCreds").checked = true;
    } catch {}
  }

  function saveCreds() {
    try {
      if (!el("rememberCreds") || !el("rememberCreds").checked) {
        setBadge("Not saved", "warn");
        setStatus("Check 'Remember Kinnser credentials' first.");
        return;
      }
      localStorage.setItem("ks_kinnser_user", el("kinnserUsername").value.trim());
      localStorage.setItem("ks_kinnser_pass", el("kinnserPassword").value);
      setBadge("Saved", "ok");
      setStatus("Saved Kinnser credentials on this computer.");
    } catch {
      setBadge("Save failed", "bad");
      setStatus("Failed to save credentials.");
    }
  }

  function clearCreds() {
    try {
      localStorage.removeItem("ks_kinnser_user");
      localStorage.removeItem("ks_kinnser_pass");
      if (el("rememberCreds")) el("rememberCreds").checked = false;
      setBadge("Cleared", "ok");
      setStatus("Cleared saved Kinnser credentials.");
    } catch {}
  }

  initTemplates();
  loadSavedCreds();
  resumeActiveJobIfAny();

  if (el("btnSaveCreds")) el("btnSaveCreds").addEventListener("click", saveCreds);
  if (el("btnClearCreds")) el("btnClearCreds").addEventListener("click", clearCreds);

  el("btnHealth").addEventListener("click", testHealth);
  el("btnRun").addEventListener("click", runAutomation);
  el("btnClear").addEventListener("click", clearForm);

  if (el("btnConvert")) el("btnConvert").addEventListener("click", convertDictation);
  if (el("btnConvertImage")) el("btnConvertImage").addEventListener("click", convertImage);
  if (el("btnConvertAudio")) el("btnConvertAudio").addEventListener("click", convertAudio);
  if (el("btnStop")) el("btnStop").addEventListener("click", stopAutomation);

  el("kinnserPassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runAutomation();
  });
})();
