// bots/phiScrubber.js

/**
 * HIPAA guardrail:
 * - scrubPHI() removes common identifiers (best-effort)
 * - detectPHI() flags residual PHI-like patterns so gatekeeper can FAIL CLOSED
 *
 * NOTE: This is intentionally conservative.
 */

function scrubPHI(text = "") {
  let t = String(text || "");
  
  // Normalize whitespace
  t = t.replace(/\r\n/g, "\n");
  
  // Emails
  t = t.replace(
                /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
                "[EMAIL]"
                );
  
  // Phone numbers (US)
  t = t.replace(
                /\b(?:\+1[\s-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g,
                "[PHONE]"
                );
  
  // SSN
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ID]");
  
  // MRN / Member ID / Account-like (simple but useful heuristics)
  t = t.replace(/\b(MRN|Member\s*ID|Policy\s*#|Acct\s*#|Account\s*#)\s*[:#]?\s*[A-Z0-9\-]{5,}\b/gi, "[ID]");
  t = t.replace(/\b(?:MRN|M#)\s*[:#]?\s*\d{5,}\b/gi, "[ID]");
  
  // Dates (numeric)
  t = t.replace(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g, "MM/YYYY");
  // ISO dates
  t = t.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "MM/YYYY");
  // Month-name dates (e.g., Dec 5, 2025 / December 5 2025)
  t = t.replace(
                /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{2,4})?\b/gi,
                "MM/YYYY"
                );
  
  // Addresses (heuristics)
  t = t.replace(
                /\b\d{1,6}\s+[A-Za-z0-9.\-'\s]{2,40}\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Circle|Cir)\b\.?/gi,
                "[ADDRESS]"
                );
  // City, State ZIP (heuristic)
  t = t.replace(/\b[A-Z][a-zA-Z.\-']+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?\b/g, "[ADDRESS]");
  
  /**
   * Names:
   * We only scrub in common chart-style patterns, to reduce over-redaction.
   * - "Last, First"
   * - "First Last" with an optional middle initial
   */
  t = t.replace(/\b[A-Z][a-z]+,\s*[A-Z][a-z]+\b/g, "PT-XXXX");
  t = t.replace(/\b[A-Z][a-z]+\s+[A-Z]\.\s+[A-Z][a-z]+\b/g, "PT-XXXX");
  t = t.replace(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g, (m) => {
    // avoid common non-name phrases (conservative allowlist)
    const lower = m.toLowerCase();
    const allow = [
      "home health",
      "physical therapy",
      "occupational therapy",
      "skilled nursing",
      "therapy visit",
      "therapy session",
      "assistive device",
      "gait training",
      "transfer training",
      "bed mobility",
      "range of",
      "blood pressure",
      "heart rate",
      "respiratory rate",
      "temporal artery",
    ];
    if (allow.some(a => lower === a)) return m;
    return "PT-XXXX";
  });
  
  // Ages like "87 y/o" are not identifiers by themselves; keep.
  // But DOB explicitly:
  t = t.replace(/\bDOB\s*[:#]?\s*.+?(?=\n|$)/gi, "DOB: [REDACTED]");
  
  return t;
}

/**
 * detectPHI returns an array of findings.
 * If non-empty => gatekeeper should BLOCK.
 */
function detectPHI(text = "") {
  const t = String(text || "");
  const findings = [];
  
  const tests = [
    { type: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
    { type: "phone", re: /\b(?:\+1[\s-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/ },
    { type: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
    { type: "address", re: /\b\d{1,6}\s+[A-Za-z0-9.\-'\s]{2,40}\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Circle|Cir)\b/i },
    { type: "dob", re: /\bDOB\b\s*[:#]?\s*/i },
    { type: "mrn", re: /\b(?:MRN|Member\s*ID|Policy\s*#|Acct\s*#|Account\s*#|M#)\b/i },
    // A very conservative "Last, First" name pattern
    { type: "name_last_first", re: /\b[A-Z][a-z]+,\s*[A-Z][a-z]+\b/ },
  ];
  
  for (const { type, re } of tests) {
    const m = t.match(re);
    if (m) findings.push({ type, match: String(m[0]).slice(0, 60) });
  }
  
  return findings;
}

module.exports = { scrubPHI, detectPHI };
