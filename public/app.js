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
  
  // Supports:
  // - "78 y/o male", "78 yo male", "78 y.o. male"
  // - "78-year-old female" (including iOS hyphens: \u2010\u2011\u2012\u2013\u2014\u2015\u2212)
  // - "78 year old female"
  // - "female 78 y/o" or "woman 78-year-old" (fallback)
  let age = "";
  let sex = "";
  
  // Pattern A: age then sex
  let m =
  d.match(/\b(\d{1,3})\s*(?:y\/?o|yo|y\.o\.)\s*(male|female)\b/i) ||
  d.match(/\b(\d{1,3})\s*(?:[\-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]|\s)?\s*year\s*(?:[\-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]|\s)?\s*old\s*(male|female|woman|man)\b/i);
  
  if (m) {
    age = String(m[1] || "").trim();
    sex = String(m[2] || "").trim().toLowerCase();
  } else {
    // Pattern B: sex then age
    m =
    d.match(/\b(male|female|woman|man)\s*(?:,|:)?\s*(\d{1,3})\s*(?:y\/?o|yo|y\.o\.)\b/i) ||
    d.match(/\b(male|female|woman|man)\s*(?:,|:)?\s*(\d{1,3})\s*(?:[\-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]|\s)?\s*year\s*(?:[\-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]|\s)?\s*old\b/i);
    
    if (m) {
      sex = String(m[1] || "").trim().toLowerCase();
      age = String(m[2] || "").trim();
    }
  }
  
  if (sex === "woman") sex = "female";
  if (sex === "man") sex = "male";
  
  const parts = [];
  if (age) parts.push(`${age} y/o`);
  if (sex) parts.push(sex);
  return { ageSex: parts.join(" ").trim() };
}


function extractEvalPmh(dictation = "") {
  const d = String(dictation || "");

  // Prefer explicit "PMH ..." line
  let pmh =
    (d.match(/\bPMH\s*(?:consists of|include[s]?|significant for)?\s*[:\-]?\s*([^\n\r.]+)/i)?.[1] || "").trim();

  // Common variants in dictation: "medical history consists of ..."
  if (!pmh) {
    pmh =
      (d.match(/\b(?:medical\s+history|history)\s*(?:consists of|include[s]?)\s*[:\-]?\s*([^\n\r.]+)/i)?.[1] || "").trim();
  }

  // Another variant: "presents with medical history consists of ..."
  if (!pmh) {
    pmh =
      (d.match(/\bpresents?\s+with\s+(?:PMH|medical\s+history|history)\s*(?:consists of|include[s]?)?\s*([^\n\r.]+)/i)?.[1] || "").trim();
  }

  // Another: "Pt is a ... who presents with ... consists of ..."
  if (!pmh) {
    pmh =
      (d.match(/\bwho\s+presents?\s+with\s+(?:PMH|medical\s+history|history)\s*(?:consists of|include[s]?)?\s*([^\n\r.]+)/i)?.[1] || "").trim();
  }

  return normEvalPmhList(pmh);
}


function buildEvalAssessmentSummaryFromDictation(dictationRaw = "") {
  const d0 = normalizeClinicalTerms(String(dictationRaw || "").replace(/\r\n/g, "\n"));
  const low = d0.toLowerCase();
  
  const { ageSex } = extractEvalDemo(d0);
  const pmh = extractEvalPmh(d0);
  
  // --- Key cue extraction (ONLY what is explicitly in dictation; no invented metrics) ---
  const painLBP = /\b(lbp|low back pain|lower back pain)\b/i.test(low);
  const chronic = /\bchronic\b/i.test(low);
  const weakness = /\bweak|weakness|decondition|atrophy\b/i.test(low);
  const unsteady = /\bunsteady\b/i.test(low);
  const impairedBalance = /\bimpaired\s+balance|poor\s+balance|balance\s+deficit\b/i.test(low);
  const fallRisk = /\bhigh\s+fall\s+risk|fall\s+risk\b/i.test(low) || (unsteady && impairedBalance);
  
  // Assistance level
  let assist = "";
  if (/\bstandby\s+assist\b/i.test(low) || /\bsba\b/i.test(low)) assist = "SBA";
  else if (/\bcontact\s+guard\b/i.test(low) || /\bcga\b/i.test(low)) assist = "CGA";
  else if (/\bmin(?:imal)?\s+assist\b/i.test(low) || /\bmina\b/i.test(low)) assist = "MinA";
  else if (/\bmod(?:erate)?\s+assist\b/i.test(low) || /\bmoda\b/i.test(low)) assist = "ModA";
  else if (/\bmax(?:imal)?\s+assist\b/i.test(low) || /\bmaxa\b/i.test(low)) assist = "MaxA";
  
  // AD
  let ad = "";
  if (/\bspc\b/i.test(low) || /\bsingle\s+point\s+cane\b/i.test(low)) ad = "SPC";
  else if (/\bfww\b/i.test(low) || /\bfront\s+wheeled\s+walker\b/i.test(low)) ad = "FWW";
  else if (/\b4ww\b/i.test(low) || /\brollator\b/i.test(low)) ad = "4WW";
  else if (/\bcane\b/i.test(low)) ad = "cane";
  else if (/\bwalker\b/i.test(low)) ad = "walker";
  
  // Distance (ft)
  let gaitDist = "";
  const distMatch = d0.match(/\b(\d{1,4})\s*(?:feet|ft)\b/i);
  if (distMatch) gaitDist = `${distMatch[1]} ft`;
  
  // Fall / injury context
  const hasFall = /\b(fall|tripp(?:ed|ing))\b/i.test(low);
  const weeksMatch = d0.match(/\b(\d+)\s*week(?:s)?\s*ago\b/i);
  const daysMatch = d0.match(/\b(\d+)\s*day(?:s)?\s*ago\b/i);
  const xrayNeg = /\bnegative\s+for\s+x-?ray|\bx-?ray\s+negative\b/i.test(low);
  const agreeable = /\bagreeable\s+to\s+pt\b/i.test(low) || /\bagrees?\s+to\s+pt\b/i.test(low);
  
  // Sentence 1: STRICT FORMAT (demo + PMH)
  const s1BaseAge = ageSex ? `${ageSex}` : "adult";
  const s1BasePmh = pmh ? `${pmh}` : "multiple comorbidities";
  let s1 = `Pt is a ${s1BaseAge} presents with PMH consist of ${s1BasePmh}.`;
  s1 = s1.replace(/\s+/g, " ").replace(/\bPt\s+is\s+a\s+adult\s+presents\b/i, "Pt presents");
  
  // Sentence 2: your required eval services line (keep unchanged)
  const s2 =
  "Pt is seen for PT initial evaluation, home assessment, DME assessment, HEP training/education, fall safety precautions, fall prevention, proper use of AD, education on pain/edema management, and PT POC/goal planning to return to PLOF.";
  
  // Sentence 3: Impairments + gait details (use dictation details when present)
  let gaitDetail = "";
  if (assist || gaitDist || ad) {
    const parts = [];
    if (assist) parts.push(assist);
    if (gaitDist) parts.push(gaitDist);
    if (ad) parts.push(`using ${ad}`);
    gaitDetail = ` with ${parts.join(" ")} for gait/ambulation`;
  }
  
  let s3 = "Pt demonstrates gross strength deficit with difficulty with transfers and gait due to unsteady gait pattern and impaired balance reactions, contributing to high fall risk.";
  if (painLBP && weakness && (unsteady || impairedBalance)) {
    s3 = `Pt demonstrates gross strength deficit with ${chronic ? "chronic " : ""}${painLBP ? "LBP" : "pain"} and unsteady gait pattern with impaired balance reactions${gaitDetail}, contributing to high fall risk.`;
  } else if ((unsteady || impairedBalance) && weakness) {
    s3 = `Pt demonstrates gross strength deficit with unsteady gait pattern and impaired balance reactions${gaitDetail}, contributing to high fall risk.`;
  } else if (weakness && gaitDetail) {
    s3 = `Pt demonstrates gross strength deficit limiting functional mobility${gaitDetail}, contributing to increased fall risk.`;
  } else if (painLBP && gaitDetail) {
    s3 = `Pt demonstrates ${chronic ? "chronic " : ""}LBP with difficulty with transfers and gait${gaitDetail}, contributing to increased fall risk.`;
  }
  
  // Sentence 4: Problem/benefit line (objective only — NO subjective wording)
  let fallClause = "";
  
  // Build purely clinical context (NOT subjective)
  if (hasFall) {
    const when = weeksMatch
    ? `${weeksMatch[1]} week(s) ago`
    : (daysMatch ? `${daysMatch[1]} day(s) ago` : "recently");
    
    fallClause = ` History of fall/trip ${when}.`;
    
    if (xrayNeg) {
      fallClause += " Imaging negative for acute fracture.";
    }
  }
  
  // NOTE:
  // We intentionally DO NOT include:
  // - agreeable
  // - Pt reports
  // - subjective phrasing
  
  let s4 =
  "Pt presents with weakness and impaired balance and will benefit from skilled HH PT to decrease fall and injury risk.";
  
  if (painLBP && weakness) {
    s4 =
    "Pt presents with chronic LBP with associated weakness and impaired balance and will benefit from skilled HH PT to decrease fall and injury risk.";
  }
  
  // Append clinical fall context
  s4 = s4.replace(/\.\s*$/, ".") + fallClause;
  
  // Sentence 5: keep your required skilled-need line (VC/TC)
  const s5 =
  "Pt is a good candidate and will benefit from skilled HH PT to address limitations and impairments as mentioned, including progression of task-specific training with ongoing VC/TC for safety and sequencing, in order to improve overall functional mobility status, decrease fall risk, and improve QoL.";
  
  // Sentence 6: medical necessity (required)
  const s6 = "Continued skilled HH PT remains medically necessary.";
  
  const clean = (x) => {
    let t = String(x || "").trim().replace(/\s+/g, " ");
    // Ensure period
    if (!/[.!?]$/.test(t)) t += ".";
    return t;
  };
  
  let out = [clean(s1), clean(s2), clean(s3), clean(s4), clean(s5), clean(s6)].join(" ");
  
  // Fix common duplication artifacts
  out = out.replace(/\bconsist\s+of\s+consist\s+of\b/ig, "consist of");
  out = out.replace(/\bPMH\s+consist\s+of\s+consist\s+of\b/ig, "PMH consist of");
  out = out.replace(/\bPt\s+Pt\b/g, "Pt");
  
  return out;
}

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
        
        if (job.status === "completed" || job.status === "failed") stopPolling();
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
  
  
  // -------------------------
  // Voice Memo / Audio → Dictation (Upload + Transcribe + Convert)
  // -------------------------
  function ensureVoiceMemoControls() {
    const dictEl = el("dictationNotes");
    if (!dictEl) return;
    if (document.getElementById("voiceMemoBox")) return;
    
    const box = document.createElement("div");
    box.id = "voiceMemoBox";
    box.style.margin = "10px 0";
    box.style.padding = "10px";
    box.style.border = "1px solid #e5e7eb";
    box.style.borderRadius = "10px";
    box.style.background = "#fff";
    
    box.innerHTML = `
      <div style="font-weight:700;margin-bottom:8px;">Voice Memo / Audio</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
        <input id="audioFile" type="file" accept="audio/*" />
        <button id="btnAudioTranscribe" type="button">Transcribe → Dictation</button>
        <button id="btnAudioToTemplate" type="button">Upload & Convert → Template</button>
        <span id="audioMemoStatus" style="opacity:.75;"></span>
      </div>
      <div style="margin-top:8px;opacity:.8;font-size:12px;">
        Tip: On iPhone, export Voice Memo as an audio file and upload it here.
      </div>
    `;
    
    dictEl.parentElement.insertBefore(box, dictEl);
  }
  
  async function fileToBase64(file) {
    // Use FileReader DataURL to avoid btoa() issues with larger binaries (common with .m4a).
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        const b64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : "";
        resolve(b64);
      };
      reader.readAsDataURL(file);
    });
  }
  
  
  async function apiFetch(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
    if (!res.ok) {
      const errMsg = (data && (data.error || data.message)) ? (data.error || data.message) : `HTTP ${res.status}`;
      const err = new Error(errMsg);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }
  
  async function transcribeUploadedAudio() {
    const f = document.getElementById("audioFile")?.files?.[0] || null;
    const st = document.getElementById("audioMemoStatus");
    if (!f) {
      if (st) st.textContent = "Select an audio file first.";
      return "";
    }
    
    try {
      if (st) st.textContent = "Uploading for transcription…";
      setBadge("Transcribing…", "warn");
      
      const b64 = await fileToBase64(f);
      const resp = await apiFetch("/transcribe-audio", {
        audio_base64: b64,
        mime_type: f.type || (String(f.name||"").toLowerCase().endsWith(".m4a") ? "audio/mp4" : "audio/mpeg"),
        filename: f.name || "audio"
      });
      
      const text = String(resp?.text || "").trim();
      if (!text) {
        if (st) st.textContent = "Transcription returned empty text.";
        setBadge("Transcribe failed", "bad");
        return "";
      }
      
      const cur = (el("dictationNotes").value || "").trim();
      el("dictationNotes").value = (cur ? (cur + "\n") : "") + text;
      
      if (st) st.textContent = "Transcribed and inserted into Dictation.";
      setBadge("Transcribed", "ok");
      return text;
    } catch (e) {
      if (st) st.textContent = "Transcription failed.";
      setBadge("Transcribe failed", "bad");
      setStatus(`Transcribe failed:\n${e?.message || e}\n${e?.body ? JSON.stringify(e.body, null, 2) : ""}`);
      return "";
    }
  }
  
  async function uploadAndConvertAudioToTemplate() {
    const text = await transcribeUploadedAudio();
    if (!text) return;
    await convertDictation();
  }
  
  initTemplates();
  loadSavedCreds();
  
  // Voice memo controls
  ensureVoiceMemoControls();
  const _btnAT = document.getElementById("btnAudioTranscribe");
  const _btnA2T = document.getElementById("btnAudioToTemplate");
  if (_btnAT) _btnAT.addEventListener("click", transcribeUploadedAudio);
  if (_btnA2T) _btnA2T.addEventListener("click", uploadAndConvertAudioToTemplate);
  
  
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
