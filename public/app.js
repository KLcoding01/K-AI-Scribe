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
  const parts = t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : [t];
}

function isDemographicsOrHistoryLine(s = "") {
  const low = String(s || "").toLowerCase();
  return (
          /\b\d{1,3}\s*y\/?o\b/.test(low) ||
          /\byear\s*old\b/.test(low) ||
          /\bpmh\b/.test(low) ||
          /\bpast\s*medical\b/.test(low) ||
          /\bmedical\s*history\b/.test(low) ||
          /\bmedical\s*(?:dx|diagnosis)\b/.test(low) ||
          /\bpt\s+is\s+a\b/.test(low) ||
          /\bpresents?\s+with\s+pmh\b/.test(low) ||
          /\bhtn\b|\bhld\b|\bdm2\b|\bdiabetes\b|\bhx\b|\bcancer\b|\bprostate\b/.test(low) && /\bpmh\b|\bhistory\b|\bdiagnosis\b/.test(low)
          );
}

function scoreSubjectiveSentence(s = "") {
  const t = String(s || "").trim();
  const low = t.toLowerCase();
  
  // HARD BLOCK: demographics/history/diagnosis never belongs in Subjective
  if (isDemographicsOrHistoryLine(t)) return -999;
  
  // Hard exclusions (objective/treatment leakage)
  const exclude = [
    "therex", "theract", "gait training", "transfer training", "bed mobility",
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
  
  const re = /(^\s*Subjective\s*:?\s*\n)([\s\S]*?)(?=\n\s*(?:Vital\s*Signs|Pain\s*Assessment|Pain|Functional\s*Status|Functional\s*Assessment|Response\s*to\s*Treatment|Exercises|Teaching\s*Tools|Education|Assessment\s*Summary|Assessment|Goals|Plan|Frequency)\b|\s*$)/im;
  const m = templateText.match(re);
  
  if (!m) {
    const reInline = /(^\s*Subjective\s*:?\s*)(.*)$/im;
    if (reInline.test(templateText)) {
      const existing = (templateText.match(reInline)?.[2] || "").trim();
      const firstLine = existing.split("\n").map(x => x.trim()).filter(Boolean)[0] || "";
      if (existing && !looksGenericSubjective(firstLine)) return templateText;
      return templateText.replace(reInline, `$1${subj}`);
    }
    return templateText;
  }
  
  const existingBlock = (m[2] || "").trim();
  const firstLine = existingBlock.split("\n").map(x => x.trim()).filter(Boolean)[0] || "";
  
  if (existingBlock && !looksGenericSubjective(firstLine)) return templateText;
  return templateText.replace(re, `${m[1]}${subj}\n`);
}


// -------------------------
// Pt Visit ONLY — Medicare-justifiable Assessment generator + patch
// -------------------------
function normalizeClinicalTerms(s = "") {
  return String(s || "")
  .replace(/\bpatient\b/ig, "Pt")
  .replace(/\blow\s*back\s*pain\b/ig, "LBP")
  .replace(/\bchronic\s*low\s*back\s*pain\b/ig, "chronic LBP")
  .replace(/\bprostate\s*cancer\b/ig, "prostate cx")
  .replace(/\bradiation\s*therapy\b/ig, "radiation tx")
  .replace(/\s+/g, " ")
  .trim();
}

function buildVisitAssessmentFromDictation(dictationRaw = "") {
  const d0 = normalizeClinicalTerms(String(dictationRaw || "").trim());
  const d = d0;

  // Age/Gender to ensure user info is carried into Assessment
  const ageMatch = d.match(/\b(\d{1,3})\s*(?:y\/o|yo|yr\/o|yrs?\/o|year\s*old|years?\s*old|-\s*year\s*old)\b/i);
  const age = ageMatch ? String(ageMatch[1]) : "__";
  const gender = /\bfemale\b/i.test(d) ? "female" : (/\bmale\b/i.test(d) ? "male" : "__");

  // PMH
  let pmh = "__";
  const pmh1 = d.match(/\b(?:medical\s*history|pmh)\s*(?:,?\s*consists\s*of|consist\s*of|includes|include)\s*([^.\n\r]+)/i);
  if (pmh1 && pmh1[1]) pmh = pmh1[1].trim();

  pmh = pmh
    .replace(/\bhypertension\b/ig, "HTN")
    .replace(/\bhyperlipidemia\b/ig, "HLD")
    .replace(/\bdiabetes\s*(?:mellitus\s*)?(?:type\s*)?2\b/ig, "DM2")
    .replace(/\bdiabetes\s*type\s*2\b/ig, "DM2")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
  if (!pmh) pmh = "__";

  // Problems requested for visit summary
  let problems = "";
  const prob1 = d.match(/\bpt\s*visit\s*summary\s*for\s+([^.\n\r]+)/i);
  if (prob1 && prob1[1]) problems = prob1[1].trim();
  const prob2 = d.match(/\bvisit\s*summary\s*for\s+([^.\n\r]+)/i);
  if (!problems && prob2 && prob2[1]) problems = prob2[1].trim();
  problems = problems.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();

  // Fall details
  let fallClause = "";
  const daysAgo = d.match(/\b(\d+)\s*days?\s*ago\b/i);
  const hasFall = /\b(s\/p\s*fall|status\s*post[-\s]*fall|fell|falling)\b/i.test(d);
  const negXR = /\bnegative\s*for\s*(?:x-?ray|xray)\b/i.test(d);
  if (hasFall) {
    const when = daysAgo ? `${daysAgo[1]} days ago` : "recently";
    fallClause = `Pt reports s/p fall ${when}` + (negXR ? " and is negative for x-ray." : ".");
  }

  const s1 = `Pt demonstrates fair tolerance to skilled HH PT visit today with ${problems || "ongoing muscle weakness, unsteady gait, and limited functional mobility"} impacting safe participation in ADLs.`;
  const s2 = `Tx emphasized task-specific TherEx and TherAct for strength and activity tolerance, with functional mobility training for safe bed mobility and transfers, and VC/TC provided for technique, pacing, and safety.`;
  const s3 = `Gait and balance training were completed to improve household ambulation safety, AD management, and balance reactions to reduce fall risk.`;
  const s4 = fallClause
    ? `${fallClause} Pt continues to demonstrate impaired balance and unsafe gait mechanics, increasing fall risk with upright mobility within the home.`
    : `Pt continues to demonstrate impaired balance and unsafe gait mechanics, increasing fall risk with upright mobility within the home.`;
  const s5 = `Pt is a ${age} y/o ${gender} with PMH of ${pmh} and remains appropriate for continued skilled HH PT due to need for real-time clinical judgment and ongoing VC/TC for safety with mobility progression.`;
  const s6 = `Continued skilled HH PT remains medically necessary to progress toward goals, maximize functional potential, and improve safety per POC.`;

  return [s1, s2, s3, s4, s5, s6].join(" ");
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
// - Sentence 1 MUST be: "Pt is a <age/sex> presents with PMH consist of <pmh>."
// - Sentences 2–6 fixed in your Medicare-justifiable structure
// - Adds stronger, objective-sounding modifiers based on dictation cues (no invented metrics)
// -------------------------
function normEvalPmhList(pmh = "") {
  let p = String(pmh || "").trim();
  
  // Remove leading labels
  p = p.replace(/^\s*(pmh|past\s*medical\s*history)\s*[:\-]?\s*/i, "");
  
  // Normalize common items (light touch)
  p = p
  .replace(/hypertension/ig, "HTN")
  .replace(/hyperlipidemia/ig, "HLD")
  .replace(/diabetes\s*(type\s*2|ii|2)/ig, "DM2")
  .replace(/prostate\s*cancer/ig, "prostate cx");
  
  // Strip trailing punctuation
  p = p.replace(/[.]+$/g, "").trim();
  
  // Collapse whitespace
  p = p.replace(/\s+/g, " ").trim();
  
  return p;
}

function extractEvalDemo(dictation = "") {
  const d = String(dictation || "");
  // Common patterns: "78 y/o male", "78 yo male", "78 y.o. male"
  const m = d.match(/\b(\d{1,3})\s*(?:y\/?o|yo|y\.o\.)\s*(male|female)\b/i);
  if (!m) return { ageSex: "" };
  return { ageSex: `${m[1]} y/o ${m[2].toLowerCase()}` };
}

function extractEvalPmh(dictation = "") {
  const d = String(dictation || "");
  
  // Prefer explicit "PMH ..." line
  let pmh =
  (d.match(/\bPMH\s*(?:consists of|include[s]?|significant for)?\s*[:\-]?\s*([^\n\r.]+)/i)?.[1] || "").trim();
  
  // If not found, pull from a demographic sentence like "Pt is a 78 y/o male presents with PMH consist of HTN..."
  if (!pmh) {
    pmh = (d.match(/\bpresents?\s+with\s+PMH\s*(?:consists of|include[s]?|significant for)?\s*([^\n\r.]+)/i)?.[1] || "").trim();
  }
  
  return normEvalPmhList(pmh);
}

function buildEvalAssessmentSummaryFromDictation(dictationRaw = "") {
  const d0 = normalizeClinicalTerms(String(dictationRaw || "").trim());
  const d = d0;

  // Age: supports "68 y/o", "68-year-old", "68 year old"
  const ageMatch = d.match(/\b(\d{1,3})\s*(?:y\/o|yo|yr\/o|yrs?\/o|year\s*old|years?\s*old|-\s*year\s*old)\b/i);
  const age = ageMatch ? String(ageMatch[1]) : "__";

  const gender = /\bfemale\b/i.test(d) ? "female" : (/\bmale\b/i.test(d) ? "male" : "__");

  // Medical Diagnosis (HNP) — only if explicitly provided; otherwise "__"
  let medicalDx = "__";
  const md1 = d.match(/\bmedical\s*diagnosis\s*[:\-]\s*([^.\n\r]+)/i);
  if (md1 && md1[1]) medicalDx = md1[1].trim();
  const md2 = d.match(/\bwith\s+medical\s+dx\s+of\s+([^.\n\r]+)/i);
  if (medicalDx === "__" && md2 && md2[1]) medicalDx = md2[1].trim();

  // PMH — capture "medical history, consists of ..." OR "PMH consist(s) of ..."
  let pmh = "__";
  const pmh1 = d.match(/\b(?:medical\s*history|pmh)\s*(?:,?\s*consists\s*of|consist\s*of|includes|include)\s*([^.\n\r]+)/i);
  if (pmh1 && pmh1[1]) {
    pmh = pmh1[1].trim();
    // cleanup common trailing phrases
    pmh = pmh.replace(/\bwho\s+presents\s+with\b.*$/i, "").trim();
  }

  // Normalize PMH terms to your preferred abbreviations
  pmh = pmh
    .replace(/\bhypertension\b/ig, "HTN")
    .replace(/\bhyperlipidemia\b/ig, "HLD")
    .replace(/\bdiabetes\s*(?:mellitus\s*)?(?:type\s*)?2\b/ig, "DM2")
    .replace(/\bdiabetes\s*type\s*2\b/ig, "DM2")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
  if (!pmh) pmh = "__";

  // Problem list (from the "summary for ..." request) to ensure we include user-requested info
  let problems = "";
  const prob1 = d.match(/\b(?:pt\s*(?:evaluation|eval)\s*summary|pt\s*evaluation\s*summary|pt\s*eval\s*summary|pt\s*visit\s*summary|pt\s*visit\s*assessment)\s*for\s+([^.\n\r]+)/i);
  if (prob1 && prob1[1]) problems = prob1[1].trim();
  // fallback: "generate six sentences ... summary for ..."
  const prob2 = d.match(/\bsummary\s*for\s+([^.\n\r]+)/i);
  if (!problems && prob2 && prob2[1]) problems = prob2[1].trim();

  problems = problems
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();

  // Fall details: "s/p fall ... two days ago" + negative x-ray
  let fallClause = "";
  const daysAgo = d.match(/\b(\d+)\s*days?\s*ago\b/i);
  const hasFall = /\b(s\/p\s*fall|status\s*post[-\s]*fall|fell|falling)\b/i.test(d);
  const negXR = /\bnegative\s*for\s*(?:x-?ray|xray)\b/i.test(d);
  if (hasFall) {
    const when = daysAgo ? `${daysAgo[1]} days ago` : "recently";
    fallClause = `Pt reports s/p fall ${when}` + (negXR ? " and is negative for x-ray." : ".");
  }

  const impairmentsLine = problems
    ? `Objective findings are consistent with ${problems}, limiting safe participation in ADLs and household mobility.`
    : `Objective findings are consistent with muscle weakness and impaired functional mobility, limiting safe participation in ADLs and household mobility.`;

  // REQUIRED 6-sentence format (your style)
  const s1 = `Pt is a ${age} y/o ${gender} who presents with HNP of ${medicalDx} which consists of PMH of ${pmh}.`;
  const s2 = `Pt underwent PT initial evaluation with completion of home safety assessment, DME assessment, and initiation of HEP education, with education provided on fall prevention strategies, proper use of AD, pain and edema management as indicated, and establishment of PT POC and functional goals to progress pt toward PLOF.`;
  const s3 = impairmentsLine;
  const s4 = fallClause
    ? `${fallClause} Current deficits contribute to difficulty with transfers, upright tolerance, and initiation of mobility tasks, increasing overall fall risk once mobility is attempted.`
    : `Pain, weakness, and decreased activity tolerance contribute to difficulty with functional transfers, upright tolerance, and initiation of mobility tasks, increasing overall fall risk once mobility is attempted.`;
  const s5 = `Skilled HH PT is required to address pain management as indicated, improve strength, initiate safe bed mobility and transfer training, progress gait and balance training, and provide caregiver education to reduce complications and promote functional recovery.`;
  const s6 = `Continued skilled HH PT remains medically necessary to maximize functional potential, improve safety, and support progression toward the highest achievable level of independence within the home setting.`;

  return [s1, s2, s3, s4, s5, s6].join(" ");
}

// Replace/patch the "Assessment Summary:" block in eval templates.
function patchEvalAssessmentSummary(templateTextRaw = "", summaryTextRaw = "") {
  const templateText = String(templateTextRaw || "");
  const summary = String(summaryTextRaw || "").trim();
  if (!templateText || !summary) return templateText;
  
  const re = /(^\s*Assessment\s*Summary\s*:\s*)([\s\S]*?)(?=\n\s*(?:Goals|Plan|Frequency|Short-Term\s*Goals|Long-Term\s*Goals)\b|$)/im;
  if (re.test(templateText)) {
    return templateText.replace(re, `$1${summary}\n`);
  }
  return templateText + `\n\nAssessment Summary: ${summary}\n`;
}


(() => {
  const el = (id) => document.getElementById(id);
  
  const apiBase = window.location.origin;
  el("apiBasePill").textContent = `API: ${apiBase}`;
  
  let pollTimer = null;
  let activeJobId = null;
  

  const ACTIVE_JOB_STORAGE_KEY = "ks_active_job_id";
  function setBadge(text, kind = "") {
    const b = el("jobBadge");
    b.textContent = text;
    b.className = "badge" + (kind ? " " + kind : "");
  }
  
  function setStatus(text) {
    el("statusBox").textContent = text;
    el("statusBox").scrollTop = el("statusBox").scrollHeight;
  }
  
  async function httpJson(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const txt = await res.text();
    let body;
    try { body = txt ? JSON.parse(txt) : {}; } catch { body = { raw: txt }; }
    if (!res.ok) {
      const err = new Error(body?.error || body?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }
  
  async function testHealth() {
    try {
      setBadge("Checking…", "warn");
      const res = await fetch("/health");
      const txt = await res.text();
      setBadge("Healthy", "ok");
      setStatus(`GET /health\n\n${txt}`);
    } catch (e) {
      setBadge("Health failed", "bad");
      setStatus(`Health check failed:\n${e?.message || e}`);
    }
  }


  // ------------------------------
  // Persist job polling across refresh / phone sleep
  // ------------------------------
  function resumeExistingJobIfAny() {
    try {
      const stored = localStorage.getItem(ACTIVE_JOB_STORAGE_KEY);
      if (!stored) return;
      activeJobId = String(stored);
      setBadge("Resuming…", "warn");
      setStatus(`Resuming job polling…\njobId: ${activeJobId}`);
      if (el("btnStop")) el("btnStop").disabled = false;
      pollJob(activeJobId);
    } catch {}
  }

  // ------------------------------
  // Stop / Cancel active job
  // ------------------------------
  async function stopJob() {
    if (!activeJobId) {
      setBadge("No job", "warn");
      setStatus("No active job to stop.");
      return;
    }
    try {
      if (el("btnStop")) el("btnStop").disabled = true;
      setBadge("Canceling…", "warn");
      setStatus(`Requesting cancel…\njobId: ${activeJobId}`);
      await httpJson(`/cancel-job/${encodeURIComponent(activeJobId)}`, { method: "POST" });
      // polling will pick up canceled status
      await pollJob(activeJobId);
    } catch (e) {
      setBadge("Cancel failed", "bad");
      setStatus(`Cancel failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
      if (el("btnStop")) el("btnStop").disabled = false;
    }
  }

  // ------------------------------
  // Audio (.m4a) → transcription → template
  // Injects UI controls under the Image convert section.
  // ------------------------------
  function ensureAudioControls() {
    // Already added?
    if (el("audioFile") || el("btnConvertAudio")) return;

    const anchorBtn = el("btnConvertImage") || el("btnConvert");
    if (!anchorBtn) return;

    const wrap = document.createElement("div");
    wrap.style.marginTop = "14px";

    const label = document.createElement("div");
    label.textContent = "Convert from Audio (optional)";
    label.style.fontWeight = "600";
    label.style.marginBottom = "8px";

    const input = document.createElement("input");
    input.type = "file";
    input.id = "audioFile";
    input.accept = "audio/*,.m4a";
    input.style.width = "100%";
    input.style.marginBottom = "10px";
    // Attempt to match styling of image input if present
    const imgInput = el("imageFile");
    if (imgInput && imgInput.className) input.className = imgInput.className;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "btnConvertAudio";
    btn.textContent = "Convert Audio → Selected Template";
    // Match styling of existing buttons
    if (anchorBtn.className) btn.className = anchorBtn.className;

    wrap.appendChild(label);
    wrap.appendChild(input);
    wrap.appendChild(btn);

    // Insert after image convert button if present, else after dictation convert
    const insertAfter = el("btnConvertImage") || el("btnConvert");
    insertAfter.parentElement.insertBefore(wrap, insertAfter.nextSibling);
  }

  async function convertAudio() {
    const file = el("audioFile")?.files?.[0];
    if (!file) {
      setBadge("Audio convert failed", "bad");
      setStatus("Audio convert failed:\nPlease choose an audio file first (.m4a).");
      return;
    }
    try {
      if (el("btnConvertAudio")) el("btnConvertAudio").disabled = true;
      setBadge("Transcribing…", "warn");
      setStatus("Uploading audio and transcribing…");

      const audioDataUrl = await fileToDataUrl(file);

      const tr = await httpJson("/transcribe-audio", {
        method: "POST",
        body: JSON.stringify({
          audioDataUrl,
          filename: file.name || "voice.m4a",
        }),
      });

      const transcript = String(tr?.text || "").trim();
      if (!transcript) {
        setBadge("Transcribe failed", "bad");
        setStatus("Transcription returned empty text.");
        return;
      }

      // Put transcript into dictation box and reuse existing convert pipeline
      if (el("dictationNotes")) el("dictationNotes").value = transcript;
      setBadge("Converting…", "warn");
      setStatus("Transcribed. Converting transcript → selected template…");

      await convertDictation();
    } catch (e) {
      setBadge("Audio convert failed", "bad");
      setStatus(`Audio convert failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
    } finally {
      if (el("btnConvertAudio")) el("btnConvertAudio").disabled = false;
    }
  }

  // ------------------------------
  // Ensure Stop button exists next to Run
  // ------------------------------
  function ensureStopButton() {
    if (el("btnStop")) return;
    const runBtn = el("btnRun");
    if (!runBtn) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "btnStop";
    btn.textContent = "Stop";
    btn.disabled = true;
    if (runBtn.className) btn.className = runBtn.className;

    // slight spacing
    btn.style.marginLeft = "10px";

    runBtn.parentElement.insertBefore(btn, runBtn.nextSibling);
  }
  
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }
  
  async function pollJob(jobId) {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const job = await httpJson(`/job-status/${encodeURIComponent(jobId)}`);
        
        if (job.status === "completed") setBadge("Completed", "ok");
        else if (job.status === "failed") setBadge("Failed", "bad");
        else if (job.status === "canceled" || job.status === "cancelled") setBadge("Canceled", "warn");
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
        
        if (job.status === "completed" || job.status === "failed" || job.status === "canceled" || job.status === "cancelled") {
          try { localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY); } catch {}
          activeJobId = null;
          if (el("btnStop")) el("btnStop").disabled = true;
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
    setBadge("Idle");
    setStatus("No job yet.");
    activeJobId = null;
    try { localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY); } catch {}
    if (el("btnStop")) el("btnStop").disabled = true;
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
      try { localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, String(activeJobId)); } catch {}
      if (el("btnStop")) el("btnStop").disabled = false;
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
Gait: Unable
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

Neuro / Physical
Orientation: AOx3
Speech: Unremarkable
Vision:
Hearing:
Skin: Intact
Muscle Tone:
Coordination:
Sensation:
Endurance:
Posture:

Functional Assessment
Bed Mobility:
Bed Mobility AD:

Transfers:
Transfers AD:

Gait
Level Surfaces:
Distance:
Gait AD:

Uneven Surfaces:
Distance:
Uneven Surfaces AD:

Stairs:
Distance:
Stairs AD:

Weight Bearing: FWB

DME:

Edema:
Type:
Location:
Pitting Grade:

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
  ensureStopButton();
  ensureAudioControls();
  initTemplates();
  loadSavedCreds();
  resumeExistingJobIfAny();
  
  if (el("btnSaveCreds")) el("btnSaveCreds").addEventListener("click", saveCreds);
  if (el("btnClearCreds")) el("btnClearCreds").addEventListener("click", clearCreds);
  
  el("btnHealth").addEventListener("click", testHealth);
  el("btnRun").addEventListener("click", runAutomation);
  el("btnClear").addEventListener("click", clearForm);
  
  if (el("btnConvert")) el("btnConvert").addEventListener("click", convertDictation);
  if (el("btnConvertImage")) el("btnConvertImage").addEventListener("click", convertImage);
  if (el("btnConvertAudio")) el("btnConvertAudio").addEventListener("click", convertAudio);
  if (el("btnStop")) el("btnStop").addEventListener("click", stopJob);
  
  el("kinnserPassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runAutomation();
  });
})();
