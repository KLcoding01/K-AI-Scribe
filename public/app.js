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
  const d0 = normalizeClinicalTerms(String(dictationRaw || "").replace(/\r\n/g, "\n"));
  const low = d0.toLowerCase();
  
  const hasLBP = /\b(lbp|low back pain)\b/i.test(d0) || /\bchronic\b/i.test(low);
  const hasGait = /\b(gait|ambulat|walk|fww|walker|cane|ad)\b/i.test(low);
  const hasTransfers = /\b(transfer|sit\s*to\s*stand|bed\s*mobility|sup\s*to\s*sit|rolling)\b/i.test(low);
  const hasFallRisk = /\b(fall\s*risk|unsteady|unsafe|loss\s*of\s*balance|lob|fear\s*of\s*fall)\b/i.test(low);
  const hasWeak = /\b(weak|weakness|decondition|strength)\b/i.test(low);
  const hasBalance = /\b(balance|postur|stability)\b/i.test(low);
  const hasPainMgmt = /\b(pain\s*management|pain)\b/i.test(low);
  const hasCancer = /\b(prostate\s*cx|prostate|cancer|radiation)\b/i.test(low);
  
  const s1 = "Pt demonstrates fair tolerance to today’s skilled HH PT visit with intermittent rest breaks required for energy conservation and symptom monitoring.";
  const s2 = (() => {
    const parts = [];
    if (hasPainMgmt && hasLBP) parts.push("pain management for chronic LBP");
    else if (hasPainMgmt) parts.push("pain management strategies");
    if (hasTransfers) parts.push("functional mobility training for bed mobility and transfers");
    else parts.push("functional mobility training for safe transfers");
    if (hasGait) parts.push("gait training to improve household ambulation safety");
    else parts.push("upright tolerance training to improve mobility safety");
    return `Tx emphasized ${parts.join(", ")}, with VC/TC provided to improve sequencing, posture, and body mechanics.`;
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
  const d0 = normalizeClinicalTerms(String(dictationRaw || "").replace(/\r\n/g, "\n"));
  const low = d0.toLowerCase();
  
  const { ageSex } = extractEvalDemo(d0);
  const pmh = extractEvalPmh(d0);
  
  // Cue detection (no invented numbers)
  const bedbound = /\bbed\s*bound|bedbound\b/i.test(low);
  const unableAmb = /\bunable\s+to\s+(ambulat|walk)\b/i.test(low);
  const fearFall = /\bfear\s+of\s+fall|fearful\s+of\s+fall/i.test(low);
  const unsteady = /\bunsteady\b/i.test(low);
  const impairedBalance = /\bimpaired\s+balance|poor\s+balance|balance\s+deficit/i.test(low);
  const weakness = /\bweak|weakness|decondition/i.test(low);
  const painLBP = /\b(lbp|low back pain)\b/i.test(low);
  const radic = /\bradicul|radiat(ing|es|ed)?\b|numb|tingl/i.test(low);
  const transfers = /\btransfer|sit\s*to\s*stand|bed\s*mobility|rolling|sup\s*to\s*sit/i.test(low);
  const gait = /\bgait|ambulat|walk|fww|walker|cane|ad\b/i.test(low);
  
  // Sentence 1: STRICT format (demo + PMH)
  const s1BaseAge = ageSex ? `${ageSex}` : "";
  const s1BasePmh = pmh ? `${pmh}` : "multiple comorbidities";
  const s1 = `Pt is a ${s1BaseAge || "adult"} presents with PMH consist of ${s1BasePmh}.`
  .replace(/\s+/g, " ")
  .replace(/\bPt\s+is\s+a\s+adult\s+presents\b/i, "Pt presents");
  
  // Sentence 2: STRICT eval services (your exact line)
  const s2 =
  "Pt is seen for PT initial evaluation, home assessment, DME assessment, HEP training/education, fall safety precautions, fall prevention, proper use of AD, education on pain/edema management, and PT POC/goal planning to return to PLOF.";
  
  // Sentence 3: Objective deficits (more “objective-sounding” based on cues, no invented measures)
  let s3 = "Pt demonstrates gross strength deficit with difficulty with bed mobility, transfers, gait, and balance deficits leading to high fall risk.";
  if (bedbound || unableAmb) {
    s3 = "Pt demonstrates gross strength deficit with limited upright tolerance and difficulty with bed mobility and transfers; gait is currently unsafe/limited, contributing to high fall risk once mobility is attempted.";
  } else if (fearFall && gait) {
    s3 = "Pt demonstrates gross strength deficit with difficulty with transfers and gait due to fear of falling and impaired balance, contributing to high fall risk.";
  } else if ((unsteady || impairedBalance) && gait) {
    s3 = "Pt demonstrates gross strength deficit with difficulty with transfers and gait due to unsteady gait pattern and impaired balance reactions, contributing to high fall risk.";
  } else if (painLBP && radic) {
    s3 = "Pt demonstrates gross strength deficit with difficulty with transfers and gait due to chronic LBP with radiating symptoms, contributing to high fall risk.";
  }
  
  // Sentence 4: Weakness + balance justification (your strict sentence, with slight objective add-ons)
  let s4 = "Pt presents with weakness and impaired balance and will benefit from skilled HH PT to decrease fall/injury risk.";
  if (fearFall) s4 = "Pt presents with weakness, impaired balance, and fear of falling and will benefit from skilled HH PT to decrease fall/injury risk.";
  if (bedbound) s4 = "Pt presents with weakness and impaired balance with limited upright tolerance and will benefit from skilled HH PT to decrease fall/injury risk and reduce risk of further decline.";
  
  // Sentence 5: Skilled need (your strict sentence, with objective-sounding skilled elements)
  let s5 =
  "Pt is a good candidate and will benefit from skilled HH PT to address limitations and impairments as mentioned in order to improve overall functional mobility status, decrease fall risk, and improve QoL.";
  // Add skilled qualifiers (still not inventing metrics)
  const needsVC = (transfers || gait || impairedBalance || fearFall || unsteady);
  if (needsVC) {
    s5 =
    "Pt is a good candidate and will benefit from skilled HH PT to address limitations and impairments as mentioned, including progression of task-specific training with ongoing VC/TC for safety and sequencing, in order to improve overall functional mobility status, decrease fall risk, and improve QoL.";
  }
  
  // Sentence 6: STRICT medical necessity line (fixes your “Pt Continued…” issue)
  const s6 = "Continued skilled HH PT remains medically necessary.";
  
  // Final clean-up
  const clean = (s) => {
    let t = String(s || "").trim().replace(/\s+/g, " ");
    t = t.replace(/\bPt\s+Pt\b/ig, "Pt").replace(/\.\.+/g, ".");
    if (!/[.!?]$/.test(t)) t += ".";
    return t;
  };
  
  // IMPORTANT: exactly 6 sentences, in your format.
  return [clean(s1), clean(s2), clean(s3), clean(s4), clean(s5), clean(s6)].join(" ");
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
  const STORAGE_ACTIVE_JOB = "kinScribeActiveJobId";
  const STORAGE_ACTIVE_JOB_UPDATED = "kinScribeActiveJobUpdatedAt";

  function persistActiveJob(jobId) {
    try {
      if (!jobId) {
        localStorage.removeItem(STORAGE_ACTIVE_JOB);
        localStorage.removeItem(STORAGE_ACTIVE_JOB_UPDATED);
      } else {
        localStorage.setItem(STORAGE_ACTIVE_JOB, String(jobId));
        localStorage.setItem(STORAGE_ACTIVE_JOB_UPDATED, String(Date.now()));
      }
    } catch {}
  }

  function readPersistedJob() {
    try {
      const id = localStorage.getItem(STORAGE_ACTIVE_JOB);
      return id ? String(id) : "";
    } catch {
      return "";
    }
  }

  function ensureStopButton() {
    let btn = el("btnStopJob");
    if (!btn) {
      // Create if index.html doesn't have it yet
      const runBtn = el("btnRun");
      if (runBtn && runBtn.parentElement) {
        btn = document.createElement("button");
        btn.id = "btnStopJob";
        btn.type = "button";
        btn.textContent = "Stop";
        btn.className = "btn danger";
        btn.style.marginLeft = "8px";
        runBtn.parentElement.appendChild(btn);
      }
    }
    if (btn) {
      btn.onclick = () => stopJob();
      btn.disabled = !activeJobId;
    }
  }
  
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
        else if (job.status === "cancelled") setBadge("Cancelled", "bad");
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
        
        if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
          stopPolling();
          activeJobId = null;
          persistActiveJob("");
          ensureStopButton();
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
    persistActiveJob("");
    stopPolling();
    ensureStopButton();
  }
  

  async function stopJob() {
    if (!activeJobId) {
      setStatus("No active job to stop.");
      return;
    }
    try {
      ensureStopButton();
      const btn = el("btnStopJob");
      if (btn) btn.disabled = true;

      setBadge("Stopping…", "warn");
      setStatus(`Requesting stop for jobId: ${activeJobId} ...`);

      await httpJson(`/stop-job/${encodeURIComponent(activeJobId)}`, {
        method: "POST",
        body: JSON.stringify({}),
      });

      // Stop polling immediately; server will keep status updated if it can cancel
      setBadge("Cancelled", "bad");
      setStatus(`Stop requested for jobId: ${activeJobId}.`);
    } catch (e) {
      setBadge("Stop failed", "bad");
      setStatus(`Stop failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
    } finally {
      ensureStopButton();
    }
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
      persistActiveJob(activeJobId);
      ensureStopButton();
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
  // Voice memo / audio → transcript → template
  // - Adds controls dynamically (so you don't need to edit index.html)
  // - Works best on desktop + iOS Safari/Chrome with microphone permission
  // ------------------------------
  let _recStream = null;
  let _recorder = null;
  let _recChunks = [];
  let _lastAudioDataUrl = "";

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ""));
      r.onerror = () => reject(r.error || new Error("Audio read failed"));
      r.readAsDataURL(blob);
    });
  }

  function ensureVoiceControls() {
    // Attach near dictation box if present
    const dict = el("dictationNotes");
    if (!dict) return;

    let wrap = el("voiceWrap");
    if (wrap) return;

    wrap = document.createElement("div");
    wrap.id = "voiceWrap";
    wrap.style.margin = "8px 0";
    wrap.style.padding = "8px";
    wrap.style.border = "1px solid rgba(255,255,255,0.12)";
    wrap.style.borderRadius = "10px";

    const row1 = document.createElement("div");
    row1.style.display = "flex";
    row1.style.flexWrap = "wrap";
    row1.style.gap = "8px";
    row1.style.alignItems = "center";

    const btnRec = document.createElement("button");
    btnRec.id = "btnRec";
    btnRec.type = "button";
    btnRec.className = "btn";
    btnRec.textContent = "Record";

    const btnRecStop = document.createElement("button");
    btnRecStop.id = "btnRecStop";
    btnRecStop.type = "button";
    btnRecStop.className = "btn";
    btnRecStop.textContent = "Stop Recording";
    btnRecStop.disabled = true;

    const inputAudio = document.createElement("input");
    inputAudio.id = "audioFile";
    inputAudio.type = "file";
    inputAudio.accept = "audio/*";
    inputAudio.style.maxWidth = "220px";

    const btnTranscribe = document.createElement("button");
    btnTranscribe.id = "btnTranscribe";
    btnTranscribe.type = "button";
    btnTranscribe.className = "btn";
    btnTranscribe.textContent = "Transcribe";
    btnTranscribe.disabled = true;

    const btnAudioToTemplate = document.createElement("button");
    btnAudioToTemplate.id = "btnAudioToTemplate";
    btnAudioToTemplate.type = "button";
    btnAudioToTemplate.className = "btn";
    btnAudioToTemplate.textContent = "Audio → Template";
    btnAudioToTemplate.disabled = true;

    const btnClearAudio = document.createElement("button");
    btnClearAudio.id = "btnClearAudio";
    btnClearAudio.type = "button";
    btnClearAudio.className = "btn";
    btnClearAudio.textContent = "Clear Audio";
    btnClearAudio.disabled = true;

    const status = document.createElement("span");
    status.id = "voiceStatus";
    status.style.opacity = "0.9";
    status.style.fontSize = "13px";
    status.textContent = "Voice: idle";

    row1.appendChild(btnRec);
    row1.appendChild(btnRecStop);
    row1.appendChild(inputAudio);
    row1.appendChild(btnTranscribe);
    row1.appendChild(btnAudioToTemplate);
    row1.appendChild(btnClearAudio);
    row1.appendChild(status);

    wrap.appendChild(row1);

    dict.parentElement.insertBefore(wrap, dict);

    const setV = (t) => { status.textContent = t; };

    async function startRecording() {
      try {
        setV("Voice: requesting mic…");
        _recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        _recChunks = [];
        _lastAudioDataUrl = "";

        _recorder = new MediaRecorder(_recStream);
        _recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) _recChunks.push(e.data); };
        _recorder.onstop = async () => {
          try {
            const blob = new Blob(_recChunks, { type: _recorder && _recorder.mimeType ? _recorder.mimeType : "audio/webm" });
            _lastAudioDataUrl = await blobToDataUrl(blob);
            setV("Voice: recorded ✓");
            btnTranscribe.disabled = false;
            btnAudioToTemplate.disabled = false;
            btnClearAudio.disabled = false;
          } catch (e) {
            setV("Voice: record failed");
            setStatus(`Voice recording failed:\n${e?.message || e}`);
          } finally {
            try { if (_recStream) _recStream.getTracks().forEach(t => t.stop()); } catch {}
            _recStream = null;
            _recorder = null;
            _recChunks = [];
          }
        };

        _recorder.start(250);
        btnRec.disabled = true;
        btnRecStop.disabled = false;
        setV("Voice: recording…");
      } catch (e) {
        setV("Voice: mic denied");
        setStatus(`Microphone permission failed:\n${e?.message || e}`);
      }
    }

    function stopRecording() {
      try {
        if (_recorder && _recorder.state !== "inactive") _recorder.stop();
      } catch {}
      btnRec.disabled = false;
      btnRecStop.disabled = true;
      setV("Voice: processing…");
    }

    async function pickFileAudio() {
      const f = inputAudio.files && inputAudio.files[0];
      if (!f) return;
      try {
        setV("Voice: loading file…");
        _lastAudioDataUrl = await fileToDataUrl(f);
        setV("Voice: file loaded ✓");
        btnTranscribe.disabled = false;
        btnAudioToTemplate.disabled = false;
        btnClearAudio.disabled = false;
      } catch (e) {
        setV("Voice: file failed");
        setStatus(`Audio file load failed:\n${e?.message || e}`);
      }
    }

    async function transcribeOnly() {
      if (!_lastAudioDataUrl) return;
      try {
        btnTranscribe.disabled = true;
        btnAudioToTemplate.disabled = true;
        setBadge("Transcribing…", "warn");
        setV("Voice: transcribing…");

        const r = await httpJson("/transcribe-audio", {
          method: "POST",
          body: JSON.stringify({ audioDataUrl: _lastAudioDataUrl }),
        });

        const text = String(r.text || "").trim();
        if (!text) throw new Error("Empty transcript");

        // Append transcript into dictation
        const cur = (dict.value || "").trim();
        dict.value = (cur ? (cur + "\n") : "") + text;

        setBadge("Ready", "ok");
        setV("Voice: transcribed ✓");
        setStatus("Transcription added to Dictation. Click Convert Dictation (or Audio → Template).");
      } catch (e) {
        setBadge("Transcribe failed", "bad");
        setV("Voice: transcribe failed");
        setStatus(`Transcription failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
      } finally {
        btnTranscribe.disabled = false;
        btnAudioToTemplate.disabled = false;
      }
    }

    async function audioToTemplate() {
      if (!_lastAudioDataUrl) return;
      try {
        btnTranscribe.disabled = true;
        btnAudioToTemplate.disabled = true;
        setBadge("Converting…", "warn");
        setV("Voice: audio → template…");

        const taskType = (el("taskType")?.value || "").trim();
        const templateKey = (el("templateKey")?.value || "").trim();

        let templateText = "";
        if (templateKey && TEMPLATES[templateKey]) templateText = TEMPLATES[templateKey];
        else if ((taskType || "").toLowerCase().includes("evaluation") && TEMPLATES.pt_eval_default) templateText = TEMPLATES.pt_eval_default;
        else templateText = TEMPLATES.pt_visit_default || "";

        const r = await httpJson("/convert-audio", {
          method: "POST",
          body: JSON.stringify({ audioDataUrl: _lastAudioDataUrl, taskType, templateText }),
        });

        const transcript = String(r.dictation || "").trim();
        if (transcript) dict.value = transcript;

        // Reuse the existing client-side post-patch logic by calling convertDictation()
        await convertDictation();

        setV("Voice: template ready ✓");
      } catch (e) {
        setBadge("Audio convert failed", "bad");
        setV("Voice: convert failed");
        setStatus(`Audio conversion failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
      } finally {
        btnTranscribe.disabled = false;
        btnAudioToTemplate.disabled = false;
      }
    }

    function clearAudio() {
      _lastAudioDataUrl = "";
      inputAudio.value = "";
      btnTranscribe.disabled = true;
      btnAudioToTemplate.disabled = true;
      btnClearAudio.disabled = true;
      setV("Voice: cleared");
    }

    btnRec.onclick = startRecording;
    btnRecStop.onclick = stopRecording;
    inputAudio.onchange = pickFileAudio;
    btnTranscribe.onclick = transcribeOnly;
    btnAudioToTemplate.onclick = audioToTemplate;
    btnClearAudio.onclick = clearAudio;
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
  
  initTemplates();
  loadSavedCreds();
  ensureStopButton();
  ensureVoiceControls();

  // Resume polling if a job was already started and the page was closed/refreshed.
  const persisted = readPersistedJob();
  if (persisted) {
    activeJobId = persisted;
    setBadge("Resuming…", "warn");
    setStatus(`Resuming existing job…\njobId: ${activeJobId}`);
    ensureStopButton();
    pollJob(activeJobId);
  }
  
  if (el("btnSaveCreds")) el("btnSaveCreds").addEventListener("click", saveCreds);
  if (el("btnClearCreds")) el("btnClearCreds").addEventListener("click", clearCreds);
  
  el("btnHealth").addEventListener("click", testHealth);
  el("btnRun").addEventListener("click", runAutomation);
  el("btnClear").addEventListener("click", clearForm);
  
  if (el("btnConvert")) el("btnConvert").addEventListener("click", convertDictation);
  if (el("btnConvertImage")) el("btnConvertImage").addEventListener("click", convertImage);
  
  el("kinnserPassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runAutomation();
  });
})();
