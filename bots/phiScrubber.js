// bots/phiScrubber.js

/**
 * HIPAA guardrail:
 * - scrubPHI() removes common identifiers (best-effort) WITHOUT destroying clinical phrasing/templates.
 * - detectPHI() flags residual PHI-like patterns so the gatekeeper can FAIL CLOSED.
 *
 * Design goals:
 * 1) Avoid over-redaction that breaks exercise names, clinical headings, and templates.
 * 2) Prefer scrubbing in "labeled contexts" (e.g., "Name:", "DOB:", "MRN:") rather than any Title-Case pair.
 * 3) Be conservative: it is better to miss some names than to destroy large portions of clinical content.
 *
 * NOTE:
 * - This is not a perfect de-identification system; it is a pragmatic guardrail.
 * - For template conversion/extraction, consider using an even lighter redactor (email/phone/ssn only).
 */

function normalize(text = "") {
  return String(text || "")
  .replace(/\r\n/g, "\n")
  .replace(/\r/g, "\n");
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function replaceLabeledLine(t, labelRe, replacementLine) {
  // Replaces "Label: <anything until end-of-line>" with a safe line.
  // Preserves the label, but overwrites the value.
  const re = new RegExp(`(^|\\n)\\s*(${labelRe.source})\\s*[:#\\-]?\\s*.*?(?=\\n|$)`, "gi");
  return t.replace(re, (m, p1, label) => `${p1}${label}: ${replacementLine}`);
}

function replaceLabeledValue(t, labels, valueReplacement) {
  // Replace occurrences like "Label: value" where Label is one of labels (case-insensitive).
  // Leaves label intact, replaces only the value up to EOL.
  const labelPattern = labels.map(escapeRegExp).join("|");
  const re = new RegExp(`(^|\\n)\\s*(${labelPattern})\\s*[:#\\-]?\\s*([^\\n]*)`, "gi");
  return t.replace(re, (m, p1, label) => `${p1}${label}: ${valueReplacement}`);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactInlineAfter(t, prefixRe, tokenRe, replacement) {
  // Example: "Email: foo@bar.com" -> "Email: [EMAIL]"
  // Only replaces tokens that appear after a known prefix.
  const re = new RegExp(`(${prefixRe.source})(\\s*)(${tokenRe.source})`, "gi");
  return t.replace(re, `$1$2${replacement}`);
}

// ------------------------------------------------------------
// Scrubber
// ------------------------------------------------------------

function scrubPHI(text = "") {
  let t = normalize(text);
  
  // ----------------------------
  // High-confidence identifiers (anywhere)
  // ----------------------------
  
  // Emails
  t = t.replace(
                /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
                "[EMAIL]"
                );
  
  // Phone numbers (US-ish)
  t = t.replace(
                /\b(?:\+?1[\s\-\.]?)?(?:\(\s*\d{3}\s*\)|\d{3})[\s\-\.]?\d{3}[\s\-\.]?\d{4}\b/g,
                "[PHONE]"
                );
  
  // SSN
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ID]");
  
  // ----------------------------
  // Labeled identifiers (preferred to avoid destroying clinical content)
  // ----------------------------
  
  // DOB line/value
  t = replaceLabeledValue(t, ["DOB", "D.O.B.", "Date of Birth"], "[REDACTED_DOB]");
  
  // SSN labeled (rare, but)
  t = replaceLabeledValue(t, ["SSN", "Social Security", "Social Security Number"], "[REDACTED_SSN]");
  
  // MRN / member / policy / account identifiers labeled
  t = replaceLabeledValue(
                          t,
                          ["MRN", "M#", "Member ID", "MemberID", "Policy #", "Policy#", "Acct #", "Acct#", "Account #", "Account#", "Chart #", "Chart#"],
                          "[REDACTED_ID]"
                          );
  
  // Patient name labeled
  t = replaceLabeledValue(
                          t,
                          // IMPORTANT: do NOT include bare "Pt" or "Patient" here.
                          // Many clinical narratives start sentences with "Pt ..." and we must not destroy
                          // normal clinical text or templates.
                          ["Patient Name", "Pt Name", "Name", "Member", "Client"],
                          "PT-XXXX"
                          );
  
  // Physician/clinician names labeled (optional, but typically PHI in notes)
  t = replaceLabeledValue(
                          t,
                          ["MD", "Dr", "Doctor", "Physician", "Provider", "Referring Provider", "Referring MD", "PCP"],
                          "[REDACTED_PROVIDER]"
                          );
  
  // ----------------------------
  // Address handling (avoid over-scrubbing: only do strong patterns)
  // ----------------------------
  
  // Full street address with suffix
  t = t.replace(
                /\b\d{1,6}\s+[A-Za-z0-9.\-'\s]{2,40}\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Circle|Cir|Terrace|Ter|Highway|Hwy|Parkway|Pkwy)\b\.?/gi,
                "[ADDRESS]"
                );
  
  // City, State ZIP
  t = t.replace(
                /\b[A-Z][a-zA-Z.\-']+(?:\s+[A-Z][a-zA-Z.\-']+)*,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?\b/g,
                "[ADDRESS]"
                );
  
  // Address labeled lines
  t = replaceLabeledValue(
                          t,
                          ["Address", "Home Address", "Mailing Address", "Street Address"],
                          "[ADDRESS]"
                          );
  
  // ----------------------------
  // Dates:
  // Only scrub in common PHI-labeled contexts to avoid breaking clinical narratives/templates.
  // Keep general dates like "Tx on 1/2/2026" unless explicitly labeled.
  // ----------------------------
  
  // Labeled date fields (more likely PHI):
  t = replaceLabeledValue(t, ["SOC Date", "Start of Care", "D/C Date", "Discharge Date", "Admission Date", "Eval Date", "Evaluation Date"], "MM/YYYY");
  
  // If someone writes "Date: 01/02/2026" on its own line
  t = replaceLabeledValue(t, ["Date"], "MM/YYYY");
  
  // Also scrub explicit DOB date formats if present after DOB label (already handled, but extra safety)
  t = redactInlineAfter(
                        t,
                        /\b(DOB|D\.O\.B\.|Date of Birth)\s*[:#\-]?\s*/i,
                        /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2}/i,
                        "MM/YYYY"
                        );
  
  // ----------------------------
  // "Last, First" name pattern:
  // Only scrub this common chart format because it’s high confidence and low collateral damage.
  // ----------------------------
  t = t.replace(/\b[A-Z][a-z]+,\s*[A-Z][a-z]+\b/g, "PT-XXXX");
  
  // ----------------------------
  // Avoid the prior "First Last" blanket rule.
  // Instead, scrub "First Last" ONLY when strongly implied by a label already handled above.
  // (If you need more aggressive name scrubbing, do it upstream with structured data, not regex.)
  // ----------------------------
  
  return t;
}

// ------------------------------------------------------------
// Detector (fail-closed tripwires)
// ------------------------------------------------------------

function detectPHI(text = "") {
  const t = normalize(text);
  const findings = [];
  
  const tests = [
    // High-confidence anywhere
    { type: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
    { type: "phone", re: /\b(?:\+?1[\s\-\.]?)?(?:\(\s*\d{3}\s*\)|\d{3})[\s\-\.]?\d{3}[\s\-\.]?\d{4}\b/ },
    { type: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
    
    // Address patterns (strong)
    { type: "address_street", re: /\b\d{1,6}\s+[A-Za-z0-9.\-'\s]{2,40}\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Circle|Cir|Terrace|Ter|Highway|Hwy|Parkway|Pkwy)\b/i },
    { type: "address_city_state_zip", re: /\b[A-Z][a-zA-Z.\-']+(?:\s+[A-Z][a-zA-Z.\-']+)*,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?\b/ },
    
    // Labeled identifiers (tripwire)
    { type: "dob_label", re: /\b(DOB|D\.O\.B\.|Date of Birth)\b\s*[:#\-]?\s*/i },
    { type: "mrn_label", re: /\b(MRN|Member\s*ID|MemberID|Policy\s*#|Policy#|Acct\s*#|Acct#|Account\s*#|Account#|Chart\s*#|Chart#|M#)\b\s*[:#\-]?\s*/i },
    { type: "name_label", re: /\b(Patient Name|Pt Name|Patient|Pt|Name|Member|Client)\b\s*[:#\-]?\s*[A-Z]/i },
    
    // High-confidence chart name format
    { type: "name_last_first", re: /\b[A-Z][a-z]+,\s*[A-Z][a-z]+\b/ },
  ];
  
  for (const { type, re } of tests) {
    const m = t.match(re);
    if (m) findings.push({ type, match: String(m[0]).slice(0, 80) });
  }
  
  return findings;
}

module.exports = { scrubPHI, detectPHI };
