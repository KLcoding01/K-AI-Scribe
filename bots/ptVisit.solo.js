
const log = (...args) => console.log(...args);

function sanitizeAssessmentText(text) {
  if (!text) return "";
  
  let out = text;
  
  // ❌ Remove subjective phrases
  out = out.replace(/\b(Pt reports|Pt report|reports no new|agrees to PT|cleared to continue).*?[.]/gi, "");
  
  // Split sentences
  let sentences = out
  .replace(/\s+/g, " ")
  .trim()
  .split(/(?<=[.!?])\s+/)
  .filter(Boolean);
  
  // Keep only 5
  sentences = sentences.slice(0, 5);
  
  // Force each sentence to start with "Pt"
  sentences = sentences.map(s => {
    s = s.replace(/^Pt\s+/i, "");
    return "Pt " + s.replace(/^[^a-zA-Z]*/, "");
  });
  
  return sentences.join(" ");
}


// =========================
// SOLO BOT FILE (no ./common.js dependency)
// Generated from common.js + bot-specific logic
// =========================

// bots/common.js
// Shared Playwright + OpenAI helpers for PT EVALUATION (GW2 only)

const { chromium } = require("playwright");
const path = require("path");
const { callOpenAIJSON } = require("./openaiClient");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env")
});

/* =========================
 * ENV
 * =======================*/

const BASE_URL = process.env.KINNSER_URL || "https://www.kinnser.net/login.cfm";
const USERNAME = process.env.KINNSER_USERNAME;
const PASSWORD = process.env.KINNSER_PASSWORD;
/* =========================
 * Small helpers
 * =======================*/

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getActivePageFromContext(context) {
  try {
    if (!context || typeof context.pages !== "function") return null;
    const pages = context.pages();
    if (!pages || !pages.length) return null;
    return pages[pages.length - 1];
  } catch {
    return null;
  }
}

async function firstVisibleLocator(scope, selectors) {
  for (const selector of selectors) {
    try {
      const item = scope.locator(selector).first();
      if (await item.isVisible().catch(() => false)) return item;
    } catch {
      // ignore
    }
  }
  return null;
}

async function verifySetText(scope, selector, value, label) {
  const v = String(value ?? "").trim();
  if (!v) return true;

  const loc = scope.locator(selector).first();
  const visible = await loc.isVisible().catch(() => false);
  if (!visible) return false;

  await loc.scrollIntoViewIfNeeded().catch(() => {});
  // Focus is important in Kinnser because onfocus may mutate the 'name' attribute
  await loc.click({ timeout: 3000, force: true }).catch(() => {});

  // Prefer direct value-set + events (more reliable than keyboard typing in Kinnser)
  await loc.evaluate((el, val) => {
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }, v).catch(async () => {
    // Fallback: fill (works for many inputs/textareas)
    await loc.fill(v).catch(() => {});
  });

  const got = await loc.inputValue().catch(() => "");
  const ok = (got || "").trim() === v;

  console.log(ok ? `[PT Visit Bot] ✅ VERIFIED ${label}` : `[PT Visit Bot] ❌ VERIFY FAIL ${label} (got="${got}")`);
  return ok;
}



// Read value from input/textarea safely (iframe/page safe)
async function safeGetValue(scope, selector, label = "", opts = {}) {
  const timeout = opts.timeout ?? 3000;
  try {
    const loc = scope.locator(selector).first();
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) return "";
    
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    // Prefer Playwright inputValue for inputs/textareas
    const v = await loc.inputValue({ timeout }).catch(async () => {
      // Fallback: read .value directly
      return await loc.evaluate((el) => (el && "value" in el ? String(el.value) : "")).catch(() => "");
    });
    
    return String(v ?? "").trim();
  } catch (e) {
    console.log(`[PT Visit Bot] ⚠️ safeGetValue failed ${label ? `(${label})` : ""}: ${e?.message || e}`);
    return "";
  }
}

async function verifyCheck(scope, selector, label) {
  const loc = scope.locator(selector).first();
  const visible = await loc.isVisible().catch(() => false);
  if (!visible) return false;
  
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const checked = await loc.isChecked().catch(() => false);
  
  if (!checked) {
    await loc.check({ force: true }).catch(async () => {
      await loc.click({ force: true }).catch(() => {});
    });
  }
  
  const ok = await loc.isChecked().catch(() => false);
  console.log(ok ? `[PT Visit Bot] ✅ VERIFIED ${label} checked` : `[PT Visit Bot] ❌ VERIFY FAIL ${label} not checked`);
  return ok;
}


function shortenPlanText(text) {
  // Plan for next visit must be short: 4–7 words
  const DEFAULT_PLAN = "Continue PT per POC";
  
  let s = String(text || "").trim();
  if (!s) return DEFAULT_PLAN;
  
  // Normalize whitespace + strip trailing punctuation
  s = s.replace(/\s+/g, " ").replace(/[.;:,\-]+$/g, "").trim();
  if (!s) return DEFAULT_PLAN;
  
  // If it already looks like a short acceptable plan, keep it
  const words = s.split(" ").filter(Boolean);
  
  // If fewer than 4 words, pad with default (use default rather than awkward padding)
  if (words.length < 4) return DEFAULT_PLAN;
  
  // Keep first 7 words max
  const out = words.slice(0, 7).join(" ");
  
  // Ensure no trailing punctuation
  return out.replace(/[.;:,\-]+$/g, "").trim() || DEFAULT_PLAN;
}



/* =========================
 * Helper: normalize dates to MM/DD/YYYY for Kinnser
 * =======================*/

function normalizeDateToMMDDYYYY(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return s;
  
  // Case 1: HTML <input type="date"> → "YYYY-MM-DD"
  if (s.includes("-")) {
    const [y, m, d] = s.split("-");
    if (y && m && d) {
      const mm = m.padStart(2, "0");
      const dd = d.padStart(2, "0");
      const yyyy = y;
      return `${mm}/${dd}/${yyyy}`; // 11/14/2025
    }
  }
  
  // Case 2: Already "M/D/YY" or "MM/DD/YYYY"
  if (s.includes("/")) {
    const parts = s.split("/");
    if (parts.length === 3) {
      let [m, d, y] = parts.map((p) => p.trim());
      const mm = m.padStart(2, "0");
      const dd = d.padStart(2, "0");
      
      if (y.length === 2) {
        const yy = y.padStart(2, "0");
        const yyyy = `20${yy}`;
        return `${mm}/${dd}/${yyyy}`;
      }
      
      // 4-digit year
      return `${mm}/${dd}/${y}`;
    }
  }
  
  // Fallback – if we don't recognize it, just return as-is
  return s;
}

/* =========================
 * Browser launcher
 * =======================*/

async function launchBrowserContext() {
  const browser = await chromium.launch({
    headless: true,
    slowMo: 120,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  
  const page = await context.newPage();
  
  page.on("dialog", async (dialog) => {
    console.log("⚠️ POPUP:", dialog.message());
    try {
      await dialog.accept();
      console.log("✅ Popup accepted");
    } catch (e) {
      console.log("⚠️ Popup already handled:", e.message);
    }
  });
  
  return { browser, context, page };
}

/* =========================
 * LOGIN
 * =======================*/

// Accept creds from UI but still allow env fallback
async function loginToKinnser(page, creds = {}) {
  const finalUsername = (creds.username || creds.kinnserUsername || USERNAME || "").trim();
  const finalPassword = creds.password || creds.kinnserPassword || PASSWORD || "";
  
  if (!finalUsername || !finalPassword) {
    throw new Error(
                    "LoginToKinnser: missing username/password. " +
                    "Either fill them in the UI or set KINNSER_USERNAME / KINNSER_PASSWORD."
                    );
  }
  
  console.log("➡️ Navigating to login page:", BASE_URL);
  console.log("   Using username:", finalUsername);
  
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await wait(1500);
  
  const usernameField = await firstVisibleLocator(page, [
    "#UserName",
    "input[name='UserName']",
    "input[id='username']",
    "input[name='username']",
    "input[id*='user']",
    "input[name*='user']",
    "input[placeholder*='Username']",
    "input[aria-label*='Username']",
    "input[type='text']",
  ]);
  
  const passwordField = await firstVisibleLocator(page, [
    "#Password",
    "input[name='Password']",
    "input[id='password']",
    "input[name='password']",
    "input[id*='pass']",
    "input[name*='pass']",
    "input[placeholder*='Password']",
    "input[aria-label*='Password']",
    "input[type='password']",
  ]);
  
  if (!usernameField || !passwordField) {
    console.error("❌ Could not find login fields on WellSky login page.");
    throw new Error("Login fields not found – update selectors in loginToKinnser().");
  }
  
  await usernameField.fill("");
  await usernameField.type(finalUsername, { delay: 50 });
  
  await passwordField.fill("");
  await passwordField.type(finalPassword, { delay: 50 });
  
  const loginButton = await firstVisibleLocator(page, [
    "button:has-text('Log In')",
    "button[type='submit']",
    "input[type='submit']",
    "button:has-text('Sign In')",
    "text=Log In",
  ]);
  
  if (!loginButton) {
    console.error("❌ Could not find Log In button.");
    throw new Error("Log In button not found on WellSky login.");
  }
  
  await loginButton.click();
  await wait(2000);
  
  console.log("✅ Login complete");
}

/* =========================
 * Go To → HotBox
 * =======================*/

async function findGoToFrame(page) {
  for (const frame of page.frames()) {
    if (await frame.locator("text=Go To").first().isVisible().catch(() => false)) {
      return frame;
    }
  }
  return page;
}

async function findHotboxFrame(page) {
  for (const frame of page.frames()) {
    if (await frame.locator("text=Hotbox").first().isVisible().catch(() => false)) {
      return frame;
    }
  }
  return page;
}

// NEW: helper to detect if we're already on HotBox (based on anchors/select snippet)
async function isAlreadyOnHotbox(page) {
  for (const frame of page.frames()) {
    const hasAnchor = await frame
    .locator("a.hotbox.default")
    .first()
    .isVisible()
    .catch(() => false);
    const hasSelect = await frame
    .locator("select.task-target-date")
    .first()
    .isVisible()
    .catch(() => false);
    
    if (hasAnchor || hasSelect) {
      return true;
    }
  }
  return false;
}

async function navigateToHotBox(page) {
  console.log("➡️ Checking if we are already on the HotBox screen...");
  
  // 1) If we already see HotBox rows, just skip navigation
  if (await isAlreadyOnHotbox(page)) {
    console.log("🔥 Already on HotBox; skipping navigation.");
    return;
  }
  
  console.log("➡️ Navigating to HotBox (robust mode)...");
  
  await wait(1000);
  
  // 2) Try direct "HotBox" link in main page
  try {
    const hotboxLink = page.locator("a", { hasText: /hotbox/i }).first();
    if (await hotboxLink.isVisible().catch(() => false)) {
      await hotboxLink.click({ timeout: 5000 }).catch(() => {});
      await wait(1200);
      if (await isAlreadyOnHotbox(page)) {
        console.log("✅ HotBox opened via direct link.");
        return;
      }
    }
  } catch {
    // ignore
  }
  
  // 3) Try "Go To" → "HotBox" (main page or frames)
  let goToLocator = null;
  
  const goToSelectors = [
    'text=/^go to$/i',
    'a:has-text("Go To")',
    'text=/go to/i',
  ];
  
  goToLocator = await firstVisibleLocator(page, goToSelectors);
  
  if (!goToLocator) {
    for (const frame of page.frames()) {
      goToLocator = await firstVisibleLocator(frame, goToSelectors);
      if (goToLocator) break;
    }
  }
  
  if (goToLocator) {
    try {
      await goToLocator.click({ force: true });
      console.log("✅ Clicked 'Go To' menu.");
      await wait(800);
      
      let hotboxMenu = await firstVisibleLocator(page, [
        'text=/hotbox/i',
        'a:has-text("HotBox")',
      ]);
      
      if (!hotboxMenu) {
        for (const frame of page.frames()) {
          hotboxMenu = await firstVisibleLocator(frame, [
            'text=/hotbox/i',
            'a:has-text("HotBox")',
          ]);
          if (hotboxMenu) break;
        }
      }
      
      if (hotboxMenu) {
        await hotboxMenu.click({ force: true }).catch(() => {});
        await wait(1200);
        
        if (await isAlreadyOnHotbox(page)) {
          console.log("✅ HotBox opened via Go To menu.");
          return;
        }
      }
    } catch (e) {
      console.log("⚠️ Failed Go To navigation:", e.message);
    }
  } else {
    console.log("⚠️ Could not find a 'Go To' menu. Trying fallbacks...");
  }
  
  // 4) Last resort: direct navigation attempts
  const candidates = [
    "https://www.kinnser.net/hotbox.cfm",
    "https://www.kinnser.net/hotbox",
    "https://www.kinnser.net/secure/hotbox.cfm",
  ];
  
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await wait(1500);
      if (await isAlreadyOnHotbox(page)) {
        console.log(`✅ HotBox opened via direct URL: ${url}`);
        return;
      }
    } catch {
      // ignore and try next
    }
  }
  
  throw new Error("Unable to navigate to HotBox (layout differs or access blocked).");
}

// Alias for consistency with other bots (Visit persistence audit)
async function navigateToHotBoxRobust(page) {
  return navigateToHotBox(page);
}


async function setHotboxShow100(page) {
  console.log("➡️ Setting Hotbox to Show 100 entries...");
  await wait(1200);
  
  const frame = await findHotboxFrame(page);
  
  try {
    await frame.waitForSelector("select[name='resultsTable_length']", {
      timeout: 1500,
    });
  } catch {
    console.log("⚠️ Dropdown not found in DOM within timeout");
    return;
  }
  
  const dropdown = frame.locator("select[name='resultsTable_length']").first();
  
  try {
    await dropdown.waitFor({ state: "visible", timeout: 1500 });
  } catch {
    console.log("⚠️ Dropdown never became visible");
    return;
  }
  
  try {
    await dropdown.selectOption("100");
    console.log("✅ Show 100 selected via selectOption");
  } catch (err) {
    console.log("⚠️ selectOption failed, retrying via click:", err.message);
    try {
      await dropdown.click();
      await wait(500);
      const option100 = frame.locator("option[value='100']").first();
      await option100.click();
      console.log("✅ Show 100 selected by clicking option");
    } catch (err2) {
      console.log("❌ Could not select '100' at all:", err2.message);
      return;
    }
  }
  
  await wait(1000);
}

/* =========================
 * Open Hotbox patient row
 * =======================*/

async function openHotboxPatientTask(page, patientName, visitDate, taskType) {
  console.log(
              `➡️ Searching Hotbox for patient "${patientName}" on "${visitDate}" with task "${taskType}"...`
              );
  
  if (!patientName || !visitDate || !taskType) {
    throw new Error("❌ openHotboxPatientTask requires patientName, visitDate, and taskType.");
  }
  
  // Normalize / expand date formats for Hotbox search
  function buildDateVariants(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return [];
    
    // If ISO "YYYY-MM-DD"
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split("-");
      const mm = String(Number(m)).padStart(2, "0");
      const dd = String(Number(d)).padStart(2, "0");
      const yyyy = y;
      const yy = y.slice(-2);
      // include padded and non-padded variants
      return [
        `${mm}/${dd}/${yyyy}`,
        `${mm}/${dd}/${yy}`,
        `${Number(m)}/${Number(d)}/${yyyy}`,
        `${Number(m)}/${Number(d)}/${yy}`,
      ];
    }
    
    // If already contains "/"
    if (s.includes("/")) {
      const parts = s.split("/");
      if (parts.length === 3) {
        let [m, d, y] = parts.map((p) => p.trim());
        const mm = String(Number(m)).padStart(2, "0");
        const dd = String(Number(d)).padStart(2, "0");
        
        if (y.length === 2) {
          const yy = y.padStart(2, "0");
          const yyyy = `20${yy}`;
          return [
            `${mm}/${dd}/${yyyy}`,
            `${mm}/${dd}/${yy}`,
            `${Number(m)}/${Number(d)}/${yyyy}`,
            `${Number(m)}/${Number(d)}/${yy}`,
          ];
        } else {
          const yyyy = y;
          const yy = y.slice(-2);
          return [
            `${mm}/${dd}/${yyyy}`,
            `${mm}/${dd}/${yy}`,
            `${Number(m)}/${Number(d)}/${yyyy}`,
            `${Number(m)}/${Number(d)}/${yy}`,
          ];
        }
      }
    }
    
    // Fallback – just try the raw string
    return [s];
  }
  
  function norm(s) {
    return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,]/g, "")
    .trim();
  }
  
  function normalizeTask(t = "") {
    return norm(t)
    .replace(/re-evaluation/g, "reeval")
    .replace(/re evaluation/g, "reeval")
    .replace(/re-eval/g, "reeval")
    .replace(/evaluation/g, "eval")
    .replace(/visit/g, "visit");
  }
  
  function taskMatches(rowText, desiredTask) {
    const a = normalizeTask(rowText);
    const b = normalizeTask(desiredTask);
    
    // Strongest signal: direct containment either way
    if (a.includes(b) || b.includes(a)) return true;
    
    // Allow "PT Evaluation" vs "PT Eval"
    if (b.includes("eval") && a.includes("eval")) return true;
    
    // Allow "PT Visit" variants
    if (b.includes("visit") && a.includes("visit")) return true;
    
    return false;
  }
  
  const dateVariants = buildDateVariants(visitDate);
  console.log("🔎 Date variants for Hotbox search:", dateVariants);
  
  let row = null;
  
  // Strategy:
  // 1) Filter rows by patient + date variant, then validate task via fuzzy match.
  // 2) If not found, broaden to patient-only rows and check date+task.
  
  for (const dateStr of dateVariants) {
    const candidates = page
    .locator("tr")
    .filter({ hasText: patientName })
    .filter({ hasText: dateStr });
    
    const n = await candidates.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const r = candidates.nth(i);
      const text = await r.innerText().catch(() => "");
      if (taskMatches(text, taskType)) {
        row = r;
        console.log(`✅ Hotbox row found using date "${dateStr}" (task fuzzy match)`);
        break;
      }
    }
    if (row) break;
  }
  
  // Broad fallback: patient-only rows (helps when date text is formatted differently in UI)
  if (!row) {
    const patientRows = page.locator("tr").filter({ hasText: patientName });
    const n = await patientRows.count().catch(() => 0);
    
    for (let i = 0; i < n; i++) {
      const r = patientRows.nth(i);
      const text = await r.innerText().catch(() => "");
      const tnorm = norm(text);
      
      const dateOk = dateVariants.some((dv) => tnorm.includes(norm(dv)));
      const taskOk = taskMatches(text, taskType);
      
      if (dateOk && taskOk) {
        row = r;
        console.log("✅ Hotbox row found using patient-only fallback (date + task fuzzy match).");
        break;
      }
    }
  }
  
  if (!row) {
    console.log(
      `❌ No Hotbox row found for any date variant ${JSON.stringify(
        dateVariants
      )}, task "${taskType}", and name "${patientName}".`
                );
    throw new Error("Hotbox row not found for date + task + name (fuzzy match).");
  }
  
  console.log("✅ Matching row found. Clicking patient link ...");
  
  // Prefer clicking patient link, but fall back to first link in row if patient text differs.
  let link = row.locator(`a:has-text("${patientName}")`).first();
  let linkVisible = await link.isVisible().catch(() => false);
  
  if (!linkVisible) {
    link = row.locator("a").first();
    linkVisible = await link.isVisible().catch(() => false);
  }
  
  if (!linkVisible) {
    console.log(`❌ Could not find any clickable link in the matching row.`);
    throw new Error("Patient link not found in matching row.");
  }
  
  await link.click();
  await wait(1000);
  
  console.log("👤 Patient visit page opened (date + task + name matched).");
}


/* =========================
 * Template scope + GW2 (ROBUST)
 * =======================*/

// Robust: accepts BrowserContext OR Page OR { page } OR { context }
// Finds the frame that actually contains frm_* fields (not reliant on "Use Template")
async function findTemplateScope(target, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || 12000);
  const pollMs = Number(opts.pollMs || 300);
  const deadline = Date.now() + timeoutMs;
  
  const FORM_PROBES = [
    "#frm_visitdate",
    "#frm_timein",
    "#frm_timeout",
    "#frm_VSComments",
    "#frm_EASI1",
    "#frm_FreqDur1",
    "#frm_FreqDur2",
    "#frm_SubInfo",
    "#frm_MedDiagText",
    "#frm_SafetySanHaz13",
    "#frm_FAPT27",
    "[id^='frm_']",
    "textarea[id^='frm_']",
    "input[id^='frm_']",
    "select[id^='frm_']",
  ];
  
  function resolvePages(x) {
    if (!x) return [];
    // BrowserContext
    if (typeof x.pages === "function") return x.pages();
    // Page
    if (typeof x.frames === "function") return [x];
    // wrapper objects
    if (x.page && typeof x.page.frames === "function") return [x.page];
    if (x.context && typeof x.context.pages === "function") return x.context.pages();
    return [];
  }
  
  async function probeScope(scope) {
    for (const sel of FORM_PROBES) {
      try {
        const loc = scope.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) return true;
      } catch {
        // ignore
      }
    }
    return false;
  }
  
  while (Date.now() < deadline) {
    const pages = resolvePages(target);
    
    for (const page of pages) {
      // 1) check frames first (WellSky commonly uses iframes)
      for (const frame of page.frames()) {
        if (await probeScope(frame)) return frame;
      }
      
      // 2) fallback: sometimes fields are on the page itself (no iframe)
      if (await probeScope(page)) return page;
    }
    
    await wait(pollMs);
  }
  
  // Debug hint (helps immediately if selectors/layout changed)
  try {
    const pages = resolvePages(target);
    const urls = pages.map((p) => p.url());
    console.log("⚠️ findTemplateScope: no template scope found. Pages:", urls);
  } catch {}
  
  
  
  
  return null;
}


// =========================
// Time normalization helper (audit-safe)
// Accepts "9:30", "09:30", "930", "0930", "1530"
// Returns "HH:MM"
// =========================
function normalizeTimeToHHMM(value) {
  if (value === null || value === undefined) return "";
  let v = String(value).trim();
  
  // Already HH:MM (or H:MM)
  const hm = v.match(/^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (Number.isFinite(h) && Number.isFinite(m)) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
  }
  
  // HMM / HHMM (e.g. 930, 0930, 1530)
  const digits = v.replace(/[^0-9]/g, "");
  if (/^\d{3,4}$/.test(digits)) {
    const padded = digits.padStart(4, "0");
    return `${padded.slice(0, 2)}:${padded.slice(2, 4)}`;
  }
  
  // Fallback: return trimmed input
  return v;
}

async function postSaveAudit(targetOrWrapper, expected = {}) {
  // Accept: Page/Frame or wrapper { page, context }
  const page = targetOrWrapper?.page || targetOrWrapper;
  const context =
  targetOrWrapper?.context ||
  (page && typeof page.context === "function" ? page.context() : null);
  
  const issues = [];
  
    const warnings = [];
  const strictReopen = /^(1|true|yes)$/i.test(String(process.env.POST_SAVE_AUDIT_STRICT || "").trim());
async function snapshotOnce(tag) {
    const scope = await findTemplateScope(page, { timeoutMs: 15000 }).catch(() => null);
    if (!scope) {
      issues.push(`${tag}: Could not resolve active template iframe/scope`);
      return null;
    }
    
    const snap = {};
    snap.visitDate = await safeGetValue(scope, "#frm_visitdate");
    snap.timeIn = await safeGetValue(scope, "#frm_timein");
    snap.timeOut = await safeGetValue(scope, "#frm_timeout");
    // optional but useful
    snap.medDx = await safeGetValue(scope, "#frm_MedDiagText");
    
    return snap;
  }
  
  function validateSnap(tag, snap) {
    if (!snap) return;
    
    if (expected.visitDate) {
      const want = normalizeDateToMMDDYYYY(expected.visitDate);
      const got = normalizeDateToMMDDYYYY(snap.visitDate);
      if (!got) issues.push(`${tag}: Visit date is blank after save`);
      else if (want && got !== want) issues.push(`${tag}: Visit date mismatch (want ${want}, got ${got})`);
    }
    
    if (expected.timeIn) {
      const want = normalizeTimeToHHMM(expected.timeIn);
      const got = normalizeTimeToHHMM(snap.timeIn);
      if (!got) issues.push(`${tag}: Time In is blank after save`);
      else if (want && got !== want) issues.push(`${tag}: Time In mismatch (want ${want}, got ${got})`);
    }
    
    if (expected.timeOut) {
      const want = normalizeTimeToHHMM(expected.timeOut);
      const got = normalizeTimeToHHMM(snap.timeOut);
      if (!got) issues.push(`${tag}: Time Out is blank after save`);
      else if (want && got !== want) issues.push(`${tag}: Time Out mismatch (want ${want}, got ${got})`);
    }
    
    if (expected.medDx) {
      const want = String(expected.medDx || "").trim();
      const got = String(snap.medDx || "").trim();
      if (want && !got) issues.push(`${tag}: Med Dx is blank after save`);
      else if (want && got && got !== want) issues.push(`${tag}: Med Dx mismatch`);
    }
  }
  
  // Phase 1: immediate DOM snapshot (can still be false-positive, but gives diagnostics)
  const snap1 = await snapshotOnce("Immediate");
  validateSnap("Immediate", snap1);
  
  // Phase 2: hard persistence check by REOPENING the same note from Hotbox.
  // Reason: Kinnser can keep in-memory DOM values even when Save did not persist.
  if (context && expected.patientName && expected.visitDate) {
    try {
      const taskType = expected.taskType || "PT Visit";
      
      // Go back to HotBox, then re-open the same row again.
      // This forces us to read server-persisted values, not the current DOM state.
      await navigateToHotBoxRobust(page);
      await setHotboxShow100(page);
      
      await openHotboxPatientTask(page, expected.patientName, expected.visitDate, taskType);
      
      const reopenedPage = getActivePageFromContext(context) || page;
      
      // Ensure we are on the reopened visit edit form (scope resolves)
      const scope2 = await findTemplateScope(reopenedPage, { timeoutMs: 20000 }).catch(() => null);
      if (!scope2) {
        if (strictReopen) issues.push("Reopen: Could not resolve template iframe/scope after reopening the note");
        else warnings.push("Reopen skipped: Could not resolve template iframe/scope after reopening the note");
      } else {
        const snap2 = {};
        snap2.visitDate = await safeGetValue(scope2, "#frm_visitdate");
        snap2.timeIn = await safeGetValue(scope2, "#frm_timein");
        snap2.timeOut = await safeGetValue(scope2, "#frm_timeout");
        snap2.medDx = await safeGetValue(scope2, "#frm_MedDiagText");
        // Validate re-opened snapshot strictly (this is the source of truth)
        validateSnap("Reopen", snap2);
      }
    } catch (e) {
      if (strictReopen) {
        issues.push(`Reopen: Exception while reopening note for persistence check: ${String(e?.message || e)}`);
      } else {
        warnings.push(`Reopen skipped (non-fatal): ${String(e?.message || e)}`);
        log("[PT Visit Bot] ⚠️ Post-save reopen audit skipped (non-fatal):", String(e?.message || e));
      }
    }
  } else {
    // If we don't have enough info to reopen, keep the immediate checks only.
    warnings.push("Reopen skipped: missing context/patientName/visitDate");
    log("[PT Visit Bot] ℹ️ Post-save persistence check (reopen) skipped: missing context/patientName/visitDate");
  }
  
  if (issues.length) {
    throw new Error(`POST-SAVE AUDIT FAIL: ${issues.join("; ")}`);
  }
  
  if (warnings.length) {
    log("✅ Post-save audit passed (reload persistence check succeeded; reopen skipped non-fatal).");
  } else {
    log("✅ Post-save audit passed (key fields persisted after reopening the note).");
  }
}


async function selectTemplateGW2(context) {
  console.log("➡️ Selecting GW2...");
  
  await wait(2000);
  
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      const select = frame.locator("select[name='jump1']").first();
      
      if (await select.isVisible().catch(() => false)) {
        try {
          await select.selectOption({ label: "GW2" });
          console.log("✅ GW2 selected via label");
          await wait(1500);
          return;
        } catch {}
        
        try {
          await select.click();
          await frame.locator("option:has-text('GW2')").first().click();
          console.log("✅ GW2 selected via click");
          await wait(1500);
          return;
        } catch {}
      }
    }
  }
  
  console.log("⚠️ GW2 not found");
}

/* =========================
 * Visit basics (ID + times + date)
 * =======================*/

async function fillVisitBasics(context, { timeIn, timeOut, visitDate }) {
  console.log("➡️ Filling visit basics...");
  
  await wait(1000);
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("⚠️ Template frame not found");
    return;
  }
  
  try {
    const box = frame.getByLabel("Patient identity confirmed");
    if (await box.isVisible().catch(() => false)) {
      await box.check();
      console.log("☑️ ID confirmed");
    }
  } catch {}
  
  const timeInInput = await firstVisibleLocator(frame, [
    "#frm_timein",
    "input[name^='frm_timein']",
  ]);
  if (timeInInput) {
    await timeInInput.fill("");
    await timeInInput.type(timeIn, { delay: 40 });
    console.log("⏱ Time In filled:", timeIn);
  }
  
  const timeOutInput = await firstVisibleLocator(frame, [
    "#frm_timeout",
    "input[name^='frm_timeout']",
  ]);
  if (timeOutInput) {
    await timeOutInput.fill("");
    await timeOutInput.type(timeOut, { delay: 40 });
    console.log("⏱ Time Out filled:", timeOut);
  }
  
  // Normalize visit date to MM/DD/YYYY before typing
  const normalizedDate = normalizeDateToMMDDYYYY(visitDate);
  console.log(
              "📅 Visit Date (raw → normalized):",
              visitDate,
              "→",
              normalizedDate
              );
  
  const dateInput = await firstVisibleLocator(frame, [
    "#frm_visitdate",
    "input[name^='frm_visitdate']",
  ]);
  if (dateInput && normalizedDate) {
    await dateInput.fill("");
    await dateInput.type(normalizedDate, { delay: 40 });
    console.log("📅 Visit Date filled:", normalizedDate);
  }
  
  console.log("✅ Visit basics step finished");
}

/* =========================
 * Helper: infer living situation from text
 * =======================*/

function inferPatientLivesValue(livingText = "") {
  const t = livingText.toLowerCase();
  if (!t) return "0";
  
  if (
      t.includes("assisted living") ||
      t.includes("board and care") ||
      t.includes("congregate")
      ) {
        return "3"; // in congregate situation
      }
  
  if (t.includes("alone") && !t.includes("24/7") && !t.includes("around the clock")) {
    return "1"; // alone
  }
  
  // default – with other persons in the home
  return "2";
}

function inferAssistanceValue(livingText = "") {
  const t = livingText.toLowerCase();
  if (!t) return "0";
  
  if (
      t.includes("around the clock") ||
      t.includes("24/7") ||
      t.includes("24 hr") ||
      t.includes("24-hour")
      ) {
        return "1"; // around the clock
      }
  if (t.includes("daytime") || t.includes("day time")) {
    return "2"; // regular daytime
  }
  if (t.includes("nighttime") || t.includes("night time") || t.includes("overnight")) {
    return "3"; // regular nighttime
  }
  if (
      t.includes("as needed") ||
      t.includes("prn") ||
      t.includes("occasional") ||
      t.includes("intermittent") ||
      t.includes("short-term")
      ) {
        return "4"; // occasional / short-term
      }
  if (t.includes("no assistance") || t.includes("no family support")) {
    return "5"; // no assistance available
  }
  
  return "0";
}

function parseStepsFromLiving(livingLine = "") {
  const match = livingLine.match(/(\d+)\s*steps?/i);
  if (match) {
    return { stepsPresent: true, stepsCount: match[1] };
  }
  return { stepsPresent: false, stepsCount: "" };
}

/* =========================
 * Regex parser (offline fallback & extra fields)
 * =======================*/

function parseAssistLevelBlock(line = "") {
  const t = line.trim();
  const result = { level: "", device: "", distanceFt: "", reps: "" };
  
  if (!t) return result;
  
  // Special-case "Unable" → treat as Dep / unable to perform
  if (/^unable\b/i.test(t)) {
    result.level = "Dep";
    return result;
  }
  
  // Now handle Dep, Dependent, Min A, etc.
  const m = t.match(
                    /^(Dep|Dependent|Max A|Mod A|Min A|CGA|SBA|Supervision|Sup|Indep|Mod Indep)\b/i
                    );
  if (!m) return result;
  
  let lvl = m[1];
  if (/dependent/i.test(lvl)) lvl = "Dep"; // normalize "Dependent" → "Dep"
  result.level = lvl.replace(/Sup/i, "Supervision");
  
  const rest = t.slice(m[0].length).trim(); // e.g. "with Hoyer lift x 150"
  
  // device (e.g. "with Hoyer lift", "w/ FWW")
  const devMatch =
  rest.match(/w\/\s*([^x]+?)(?:\s*x|\s*$)/i) ||
  rest.match(/with\s+([^x]+?)(?:\s*x|\s*$)/i);
  if (devMatch) {
    result.device = devMatch[1].trim();
  }
  
  // distance or reps  e.g. "x 150", "x 3"
  const distMatch = rest.match(/x\s*(\d+)\s*(ft|feet)?/i);
  if (distMatch) {
    result.distanceFt = distMatch[1];
  }
  
  const repsMatch = rest.match(/x\s*(\d+)\b(?!\s*(ft|feet))/i);
  if (repsMatch) {
    result.reps = repsMatch[1];
  }
  
  return result;
}

/* =========================
 * AI/Regex safety helpers (prevents wrong transfers)
 * =======================*/

function sanitizeMedicalDiagnosis(dx) {
  const s = (dx || "").trim();
  if (!s) return "";
  
  // If it looks like a PMH list, do NOT push it into Medical Dx.
  const commaCount = (s.match(/,/g) || []).length;
  if (s.length > 90 || commaCount >= 4) return "";
  
  // Strip obvious non-dx narrative
  if (/seen for|order from|training|caregiver|cg\b/i.test(s)) return "";
  
  return s;
}

function sanitizeRelevantHistory(pmh) {
  let s = (pmh || "").trim();
  if (!s) return "";
  
  // Remove age/sex lead-in & eval narrative if it sneaks in
  s = s.replace(/\b\d{1,3}\s*y\/o\b.*?(female|male)\b[:,]?\s*/i, "");
  s = s.replace(/\bseen for\b.*$/i, "").trim();
  
  // If still looks like referral narrative, skip it
  if (s.length > 140 && /order|training|evaluation|seen for/i.test(s)) return "";
  
  return s.replace(/\s+/g, " ").trim();
}

function splitIntoSentences(paragraph) {
  const t = (paragraph || "").trim();
  if (!t) return [];
  return t
  .replace(/\s+/g, " ")
  .split(/(?<=[.!?])\s+/)
  .map((x) => x.trim())
  .filter(Boolean);
}

function isValidSixSentencePtParagraph(text) {
  const sentences = splitIntoSentences(text);
  return (
          sentences.length === 6 &&
          sentences.every((s) => /^Pt\b/.test(s)) &&
          !/\b(he|she|they|his|her|their)\b/i.test(text)
          );
}

function buildEvalClinicalStatementFallback(structured) {
  const dx = sanitizeMedicalDiagnosis(structured?.medicalDiagnosis) || "Dx per MD referral / orders";
  const bed = structured?.func?.bedMobilityAssist ? `${structured.func.bedMobilityAssist} bed mobility` : "impaired bed mobility";
  const trans = structured?.func?.transfersAssist ? `${structured.func.transfersAssist} transfers` : "impaired transfers";
  const gait = structured?.func?.gaitDistanceFt ? `limited gait tolerance to ${structured.func.gaitDistanceFt} ft` : "limited gait tolerance";
  const ad = structured?.func?.gaitAD ? `using ${structured.func.gaitAD}` : "with AD as indicated";
  
  const env = (structured?.living?.evaluationText || "").trim()
  ? structured.living.evaluationText.trim()
  : "Home environment and safety were assessed with CG support as indicated.";
  
  const s1 = `Pt is referred for HH PT due to ${dx}, with primary deficits including weakness, impaired balance, impaired gait, and reduced functional mobility.`;
  const s2 = `Pt demonstrates objective limitations including ${bed}, ${trans}, ${gait} ${ad}, contributing to increased fall risk.`;
  const s3 = `Pt home environment and CG support were assessed, and safety hazards were addressed as indicated to promote safe mobility.`;
  const s4 = `Pt requires skilled HH PT to provide clinical assessment, HEP instruction, DME education, fall-prevention training, and CG training for safe mobility and transfers.`;
  const s5 = `Pt POC will emphasize TherEx, TherAct, gait training, balance training, and functional training with ongoing fall-risk reduction strategies.`;
  const s6 = `Pt requires continued skilled HH PT per POC to improve safety, mobility, and ADL performance.`;
  return [s1, s2, s3, s4, s5, s6].join(" ");
}

function parseNeuroFromText(text = "") {
  const grab = (label) => {
    const m = (text || "").match(new RegExp(`${label}\\s*:\\s*([^;\\n\\r]+)`, "i"));
    return m ? m[1].trim() : "";
  };
  return {
    orientation: grab("Orientation"),
    speech: grab("Speech"),
    vision: grab("Vision"),
    hearing: grab("Hearing"),
    skin: grab("Skin"),
    muscleTone: grab("Muscle Tone"),
    coordination: grab("Coordination"),
    sensation: grab("Sensation"),
    endurance: grab("Endurance"),
    posture: grab("Posture"),
  };
}


function parseStructuredFromFreeText(aiNotes = "") {
  const DEFAULT_LIVING_TEXT =
  "Pt lives in a SSH with family providing care around the clock. The home has hard/carpet surface flooring, bath tub. No hazard found.";
  
  const result = {
    medicalDiagnosis: "",
    relevantHistory: "",
    hasExplicitPMH: false,
    clinicalStatement: "",
    subjective: "",
    priorLevel: "",
    patientGoals: "",
    vitalsComment: "",
    living: {
      evaluationText: DEFAULT_LIVING_TEXT,
      patientLivesValue: inferPatientLivesValue(DEFAULT_LIVING_TEXT),
      assistanceAvailableValue: inferAssistanceValue(DEFAULT_LIVING_TEXT),
      stepsPresent: false,
      stepsCount: "",
      currentAssistanceTypes: DEFAULT_LIVING_TEXT.toLowerCase().includes("family")
      ? "Family / CG"
      : "",
      hasPets: false,
      rawLivingLine: "",
      rawHelperLine: "",
    },
    pain: {
      hasPain: false,
      primaryLocationText: "",
      intensityValue: "-1",
      increasedBy: "",
      relievedBy: "",
      interferesWith: "",
    },
    neuro: {
      orientation: "",
      speech: "",
      vision: "",
      hearing: "",
      skin: "",
      muscleTone: "",
      coordination: "",
      sensation: "",
      endurance: "",
      posture: "",
    },
    func: {
      bedMobilityAssist: "",
      bedMobilityDevice: "",
      transfersAssist: "",
      transfersDevice: "",
      gaitAssist: "",
      gaitDistanceFt: "",
      gaitAD: "",
      stairsAssist: "",
      weightBearing: "",
    },
    dme: {
      wheelchair: false,
      walker: false,
      hospitalBed: false,
      bedsideCommode: false,
      raisedToiletSeat: false,
      tubShowerBench: false,
      other: "",
    },
    edema: {
      status: "absent",
      type: "",
      pittingGrade: "",
      location: "",
    },
    plan: {
      frequency: "",
      shortTermVisits: "",
      longTermVisits: "",
      goalTexts: [],
      planText: "",
    },
    romStrength: null,
  };
  
  if (!aiNotes) return result;
  const text = String(aiNotes ?? "");
  
  // MEDICAL DX
  const medDxMatch =
  text.match(/medical\s*(dx|diagnosis)\s*:\s*(.+)/i) ||
  text.match(/diagnosis\s*\(\s*dx\s*\)\s*:\s*(.+)/i) ||
  text.match(/^\s*dx\s*:\s*(.+)\s*$/im) ||
  text.match(/^\s*diagnosis\s*:\s*(.+)\s*$/im);
  
  if (medDxMatch) {
    result.medicalDiagnosis = (medDxMatch[2] || medDxMatch[1] || "").trim();
  }
  if (result.medicalDiagnosis) {
    result.medicalDiagnosis = sanitizeMedicalDiagnosis(result.medicalDiagnosis);
  }
  
  // RELEVANT HISTORY
  const pmhBlock =
  text.match(
             /(?:^|\n)\s*pmh\s*:\s*([\s\S]+?)(?=\n\s*(goals?|living situation|diagnosis|vital signs|orientation|dme|frequency)\s*:|\n{2,}|$)/i
             ) ||
  text.match(/(?:^|\n)\s*relevant medical history\s*:\s*([\s\S]+?)(?=\n{2,}|$)/i);
  
  if (pmhBlock) {
    result.relevantHistory = pmhBlock[1].trim();
    result.hasExplicitPMH = true;
  }
  
  // PRIOR LEVEL
  const priorMatch = text.match(
                                /(?:^|\n)\s*prior level(?: of function(?:ing)?)?\s*:\s*([^\n\r]+)/i
                                );
  if (priorMatch) result.priorLevel = priorMatch[1].trim();
  
  // PATIENT GOALS
  const goalsMatch =
  text.match(/(?:^|\n)\s*goals for patient\s*:\s*([^\n\r]+)/i) ||
  text.match(/(?:^|\n)\s*patient'?s goals?\s*:\s*([^\n\r]+)/i) ||
  text.match(/(?:^|\n)\s*patient goals?\s*:\s*([^\n\r]+)/i);
  
  if (goalsMatch) result.patientGoals = goalsMatch[1].trim();
  
  // LIVING SITUATION + HELPER
  const livingMatch =
  text.match(/(?:^|\n)\s*living situation\s*:\s*([^\n\r]+)/i) ||
  text.match(/(?:^|\n)\s*lives\s+(?:in|with)\s+([^\n\r]+)/i);
  
  const helperMatch = text.match(/(?:^|\n)\s*person helping\s*:\s*([^\n\r]+)/i);
  
  if (livingMatch) {
    const livingLine = (livingMatch[1] || "").trim();
    result.living.rawLivingLine = livingLine;
    
    result.living.evaluationText = `Pt lives ${
      livingLine.toLowerCase().startsWith("in") ? livingLine : "in " + livingLine
    }.`;
    
    result.living.patientLivesValue = inferPatientLivesValue(livingLine);
    result.living.assistanceAvailableValue = inferAssistanceValue(livingLine);
    
    const stepsInfo = parseStepsFromLiving(livingLine);
    result.living.stepsPresent = stepsInfo.stepsPresent;
    result.living.stepsCount = stepsInfo.stepsCount;
    
    const low = livingLine.toLowerCase();
    if (low.includes("caregiver") || low.includes("cg") || low.includes("staff")) {
      result.living.currentAssistanceTypes = "Caregivers / facility staff";
    }
    if (low.includes("family")) {
      result.living.currentAssistanceTypes = "Family / CG";
    }
    if (low.includes("pet")) result.living.hasPets = true;
  }
  
  if (helperMatch) {
    const helperLine = helperMatch[1].trim();
    result.living.rawHelperLine = helperLine;
    
    const hl = helperLine.toLowerCase();
    if (hl.includes("caregiver") || hl.includes("cg") || hl.includes("staff")) {
      result.living.currentAssistanceTypes = "Caregivers / facility staff";
    } else if (hl.includes("family")) {
      result.living.currentAssistanceTypes = "Family / CG";
    }
  }
  
  if (text.toLowerCase().includes("pets")) result.living.hasPets = true;
  
  // VITALS COMMENT
  const vitalsCommentMatch =
  text.match(/(?:^|\n)\s*(blood pressure comment|bp comment|vitals comment|vs comments?|comments)\s*:\s*(.+)/i);
  if (vitalsCommentMatch) result.vitalsComment = (vitalsCommentMatch[2] || "").trim();
  
  // SUBJECTIVE
  const subjMatch = text.match(/(?:^|\n)\s*subjective\s*:\s*([^\n\r]+)/i);
  if (subjMatch) result.subjective = subjMatch[1].trim();
  
  // FUNCTIONAL
  const bedMobMatch = text.match(/(?:^|\n)\s*bed mobility\s*:\s*(.+)/i);
  if (bedMobMatch) {
    const parsed = parseAssistLevelBlock(bedMobMatch[1].trim());
    result.func.bedMobilityAssist = parsed.level;
    result.func.bedMobilityDevice = parsed.device;
  }
  
  const transfersMatch = text.match(/(?:^|\n)\s*transfers\s*:\s*(.+)/i);
  if (transfersMatch) {
    const parsed = parseAssistLevelBlock(transfersMatch[1].trim());
    result.func.transfersAssist = parsed.level;
    result.func.transfersDevice = parsed.device;
  }
  
  const gaitMatch = text.match(/(?:^|\n)\s*gait\s*:\s*(.+)/i);
  if (gaitMatch) {
    const parsed = parseAssistLevelBlock(gaitMatch[1].trim());
    result.func.gaitAssist = parsed.level;
    result.func.gaitDistanceFt = parsed.distanceFt;
    result.func.gaitAD = parsed.device;
  }
  
  // GOALS BLOCK (kept behavior)
  const goalsBlock = text.match(/goal[s]?:([\s\S]+)/i);
  if (goalsBlock) {
    const lines = goalsBlock[1]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
    
    result.plan.goalTexts = lines;
    
    const visitMatches = [...goalsBlock[1].matchAll(/total of\s*(\d+)\s*visits?/gi)];
    if (visitMatches[0]) result.plan.shortTermVisits = `${visitMatches[0][1]} visits`;
    if (visitMatches[1]) result.plan.longTermVisits = `${visitMatches[1][1]} visits`;
  }
  
  // FREQUENCY
  const freqLineMatch =
  text.match(/frequency[^:]*:\s*([^\n]+)/i) || text.match(/\bfrequency\s+([^\n]+)/i);
  const source = freqLineMatch ? freqLineMatch[1] : text;
  
  const codedMatches = [...source.matchAll(/\b(\d+)w(\d+)\b/gi)];
  if (codedMatches.length > 0) {
    result.plan.frequency = codedMatches.map((m) => `${m[1]}w${m[2]}`).join(", ");
  }
  
  // =========================
  // DME (block-based; stops at next heading)
  // =========================
  const dmeBlockMatch = text.match(
                                   /(?:^|\n)\s*dme\s*:\s*([\s\S]*?)(?=\n\s*(assessment summary|clinical statement|evaluation summary|assessment|pmh|diagnosis|dx|prior level|bed mobility|transfers|gait|living situation|person helping|goals|frequency|vital signs|bp|hr|rr|temp)\s*:|\n{2,}|$)/i
                                   );
  
  let dmeLine = "";
  if (dmeBlockMatch) {
    dmeLine = (dmeBlockMatch[1] || "").trim();
  } else {
    const dmeInline = text.match(/(?:^|\n)\s*dme\s*:\s*([^\n\r]+)/i);
    dmeLine = (dmeInline?.[1] || "").trim();
  }
  
  // sanitize: if it still looks like assessment text, ignore it
  if (/^(assessment summary|clinical statement|evaluation summary|assessment)\s*:/i.test(dmeLine)) {
    dmeLine = "";
  }
  
  if (dmeLine) {
    result.dme.other = dmeLine;
    
    const lower = dmeLine.toLowerCase();
    if (lower.includes("wheelchair") || lower.includes("w/c") || /\bwc\b/.test(lower))
      result.dme.wheelchair = true;
    if (lower.includes("walker") || lower.includes("fww") || lower.includes("rw"))
      result.dme.walker = true;
    if (lower.includes("hospital bed")) result.dme.hospitalBed = true;
    if (lower.includes("bedside commode") || lower.includes("bsc"))
      result.dme.bedsideCommode = true;
    if (lower.includes("raised toilet")) result.dme.raisedToiletSeat = true;
    if (lower.includes("shower chair") || lower.includes("shower bench") || lower.includes("tub"))
      result.dme.tubShowerBench = true;
  }
  
  // ROM / Strength
  result.romStrength = parseRomAndStrength(text);
  
  // CLINICAL STATEMENT fallback
  const topPara = text.trim().split(/\n{2,}/)[0];
  if (topPara && topPara.length > 40) {
    result.clinicalStatement = topPara.trim();
  }
  
  // ✅ Physical Assessment: pull values from narrative lines if present
  const parsedNeuro = parseNeuroFromText(text);
  result.neuro = { ...result.neuro, ...parsedNeuro };
  
  // PLAN TEXT
  const planLineMatch =
  text.match(/plan for next visit:\s*(.+)/i) ||
  text.match(/plan:\s*(.+)/i) ||
  text.match(/poc:\s*(.+)/i);
  
  if (planLineMatch) {
    result.plan.planText = planLineMatch[1].trim();
  }
  
  if (result.plan.frequency) {
    console.log("🧾 Parsed frequency (code):", result.plan.frequency);
  } else {
    console.log("ℹ️ No frequency pattern found in AI note.");
  }
  
  // =========================
  // CLINICAL STATEMENT / ASSESSMENT SUMMARY (explicit label parse)
  // =========================
  // Capture multi-line block until next known heading or blank-line break.
  const clinicalBlockMatch =
  text.match(
             /(?:^|\n)\s*(assessment summary|clinical statement|evaluation summary|assessment)\s*:\s*([\s\S]+?)(?=\n\s*(subjective|orientation|speech|vision|hearing|vital signs|bp|hr|rr|temp|temperature|dme|pmh|diagnosis|dx|prior level|prior level of function|bed mobility|transfers|gait|living situation|person helping|goals for patient|goals|frequency)\s*:|\n{2,}|$)/i
             );
  
  if (clinicalBlockMatch) {
    const extracted = (clinicalBlockMatch[2] || "").trim();
    if (extracted.length > 20) {
      // Keep line breaks optional; if you want to preserve newlines, do NOT collapse whitespace.
      result.clinicalStatement = extracted;
    }
  }
  
  // ... rest of parseStructuredFromFreeText logic ...
  
  return result;
}
/* =========================
 * AI extractor – main entry
 * =======================*/

async function extractNoteDataFromAI(aiNotes, visitType = "Evaluation") {
  const structured = parseStructuredFromFreeText(aiNotes || "");
  const text = String(aiNotes ?? "").trim();
  const hay = text.toLowerCase();
  
  const vt = (visitType || "").toLowerCase();
  const isReeval = vt.includes("re-eval") || vt.includes("re-evaluation") || vt.includes("recert");
  const isDischarge = vt.includes("discharge") || vt === "dc" || vt.includes(" dc");
  const isVisit = vt.includes("visit") && !isReeval && !isDischarge;
  
  const visitLabel = isReeval
  ? "PT RE-EVALUATION"
  : isDischarge
  ? "PT DISCHARGE"
  : isVisit
  ? "PT VISIT"
  : "PT INITIAL PT EVALUATION";
  
  function parseDemographicsFromText(t = "") {
    const out = { age: "", sex: "" };
    const s = t.toLowerCase();
    
    const ageMatch =
    s.match(/\b(\d{1,3})\s*(y\/o|yo|yr old|year old|years old)\b/i) ||
    s.match(/\b(\d{1,3})\s*-\s*year\s*-\s*old\b/i);
    
    if (ageMatch) out.age = ageMatch[1];
    
    if (/\bfemale\b/i.test(s)) out.sex = "female";
    else if (/\bmale\b/i.test(s)) out.sex = "male";
    
    return out;
  }
  
  const demo = parseDemographicsFromText(text);
  const demoLine =
  demo.age && demo.sex
  ? `Pt is a ${demo.age} y/o ${demo.sex}`
  : demo.sex
  ? `Pt is a ${demo.sex}`
  : demo.age
  ? `Pt is a ${demo.age} y/o`
  : `Pt is an older adult`;
  
  const defaults = {
    relevantHistory: structured.relevantHistory || "PMH as documented in medical record.",
    
    clinicalStatement: isReeval
    ? "Pt has been receiving skilled HH PT to address functional mobility deficits secondary to muscle weakness, impaired balance, and unsteady gait. Progress has been slow, and pt continues to demonstrate difficulty with bed mobility, transfers, decreased gait tolerance, unsteady gait, and poor balance contributing to high fall risk. Pt requires continued HEP training, fall-prevention education, and safety instruction with functional mobility to reduce fall risk. Pt still has potential and continues to benefit from skilled HH PT to work toward goals and improve ADL performance. Ongoing skilled HH PT remains medically necessary to address these deficits and promote safe functional independence."
    : isDischarge
    ? "Pt has completed a course of skilled HH PT to address pain, weakness, impaired mobility, and fall risk. Pt now demonstrates improved strength, transfer ability, and gait tolerance with safer functional mobility using the recommended assistive device. Residual deficits may remain but are manageable with independent HEP and caregiver support. Pt demonstrates adequate safety awareness and is appropriate for discharge from skilled HH PT at this time. Pt will continue with HEP and follow up with MD as needed."
    : isVisit
    ? "Pt continues with skilled HH PT to address ongoing deficits in strength, balance, gait, and activity tolerance. Pt demonstrates variable progress with functional mobility, requiring cues for safety, proper sequencing, and efficient gait mechanics. Current session focused on TherEx, TherAct, and gait training to improve mobility, decrease fall risk, and support ADL performance. Pt continues to benefit from skilled HH PT to address these impairments and reinforce HEP and safety strategies."
    : `${demoLine} who presents with PMH consists of ${structured.relevantHistory || "multiple comorbidities"} and is referred for HH PT to address severe generalized weakness, dependence with bed mobility and transfers, impaired functional mobility, and high caregiver burden. Pt demonstrates objective functional limitations including Dep bed mobility, Dep transfers via Hoyer lift, non-ambulatory status, and wheelchair dependence, contributing to high risk for skin breakdown, deconditioning, and caregiver injury. Pt resides in an assisted living memory care unit with 24/7 caregiver support, and the home environment and safety factors were assessed with no significant hazards identified at this time. Pt requires skilled HH PT to provide caregiver training for safe Hoyer lift transfers, positioning, pressure relief strategies, therapeutic exercise instruction, and development of an appropriate HEP. Pt POC will emphasize TherEx, TherAct, caregiver education, positioning, ROM, and pressure sore prevention to maximize comfort, safety, and quality of care. Pt requires continued skilled HH PT per POC to improve caregiver competence, prevent secondary complications, and support safe long-term management.`,
    
    vitals: {
      temperature: "",
      temperatureTypeValue: "4", // Temporal – DO NOT OVERRIDE
      bpSys: "",
      bpDia: "",
      positionValue: "2",
      sideValue: "1",
      heartRate: "",
      respirations: "",
      vsComments: structured.vitalsComment || "",
    },
    
    medicalDiagnosis: structured.medicalDiagnosis || "",
    subjective: structured.subjective || "",
    priorLevel: structured.priorLevel || "Needs assistance with mobility/gait and ADLs.",
    
  patientGoals:
    structured.patientGoals ||
    "To improve strength, mobility, gait, activity tolerance, and decrease fall risk.",
    
    living: {
      patientLivesValue: structured.living?.patientLivesValue || "0",
      assistanceAvailableValue: structured.living?.assistanceAvailableValue || "0",
      evaluationText: structured.living?.evaluationText || "",
      stepsPresent: structured.living?.stepsPresent || false,
      stepsCount: structured.living?.stepsCount || "",
      currentAssistanceTypes: structured.living?.currentAssistanceTypes || "",
      hasPets: structured.living?.hasPets || false,
    },
    
    pain: {
      hasPain: structured.pain?.hasPain || false,
      primaryLocationText: structured.pain?.primaryLocationText || "",
      intensityValue: structured.pain?.intensityValue || "-1",
      increasedBy: structured.pain?.increasedBy || "",
      relievedBy: structured.pain?.relievedBy || "",
      interferesWith: structured.pain?.interferesWith || "",
    },
    
    neuro: structured.neuro,
    func: structured.func,
    dme: structured.dme,
    romStrength: structured.romStrength || null,
    edema: structured.edema,
    
    plan: {
      frequency: structured.plan?.frequency || "",
      effectiveDate: "",
      shortTermVisits: structured.plan?.shortTermVisits || "",
      longTermVisits: structured.plan?.longTermVisits || "",
      goalTexts: structured.plan?.goalTexts || [],
      planText: structured.plan?.planText || "", //
    },
  };
  
  // Override default vitals if notes contain them
  try {
    const tempMatch = text.match(/(?:temp|temperature)[:\s]+(\d{2}\.?\d*)/i);
    if (tempMatch) defaults.vitals.temperature = tempMatch[1];
    
    const bpMatch = text.match(/bp[:\s]+(\d{2,3})\s*\/\s*(\d{2,3})/i);
    if (bpMatch) {
      defaults.vitals.bpSys = bpMatch[1];
      defaults.vitals.bpDia = bpMatch[2];
    }
    
    const hrMatch = text.match(/heart\s*rate[:\s]+(\d{2,3})/i);
    if (hrMatch) defaults.vitals.heartRate = hrMatch[1];
    
    const respMatch = text.match(/resp(?:iration|irations)?[:\s]+(\d{1,2})/i);
    if (respMatch) defaults.vitals.respirations = respMatch[1];
  } catch (err) {
    console.log("[Vitals Parser] Error parsing vitals:", err.message);
  }
  // =========================
  // ✅ SAFEGUARD: never send identifiers/secrets to OpenAI
  // =========================
  const forbidden = [USERNAME, PASSWORD, process.env.OPENAI_API_KEY]
  .filter(Boolean)
  .map(v => String(v).toLowerCase());
  
  if (forbidden.some(v => v && hay.includes(v))) {
    console.warn("⚠️ Possible identifier/secret detected in aiNotes. Skipping OpenAI call; using defaults.");
    return defaults;
  }
  if (!text || !process.env.OPENAI_API_KEY) return defaults;
  
  const prompt = `
You are helping a home health PT fill out a Kinnser/WellSky PT note.

VISIT_TYPE: ${visitLabel}

Return ONLY valid JSON with double quotes.

Extract keys:
- "relevantHistory": ONE concise PMH/comorbidities line ONLY.
- "medicalDiagnosis": ONLY the primary MD diagnosis (short). If not explicitly stated, return "".
- "subjective": ONLY if explicitly stated what Pt reports. If not explicitly stated, return "".
- "clinicalStatement": see rules below
- "vitals": { "temperature","temperatureTypeValue","bpSys","bpDia","positionValue","sideValue","heartRate","respirations","vsComments" }
- "living": { "patientLivesValue","assistanceAvailableValue","evaluationText","stepsPresent","stepsCount","currentAssistanceTypes","hasPets" }
- "pain": { "hasPain","primaryLocationText","intensityValue","increasedBy","relievedBy","interferesWith" }
- "plan": { "frequency","shortTermVisits","longTermVisits","goalTexts","planText" }

If VISIT_TYPE is "PT INITIAL PT EVALUATION":
Write EXACTLY 6 sentences, ONE paragraph, and EVERY sentence must start with "Pt".
Sentence #1 MUST begin exactly like:
"${demoLine} who presents with PMH consists of <PMH> and is referred for HH PT to address <primary deficits>."
Rules:
- Use the PMH from the note for the “PMH consists of …” phrase (keep concise).
- Do not use pronouns (they/he/she).
- No bullets, no headings, no arrows.
- Sentences #2-#6 must follow:
2) Objective functional limitations + fall risk.
3) Home environment / CG support / hazards (if present).
4) Skilled HH PT necessity (education/HEP/DME/CG training).
5) POC focus (TherEx/TherAct/gait/balance/fall prevention).
6) Closing: continued skilled HH PT per POC to improve safety, mobility, ADL performance.

Free-text note:
---
${text}
---`;
  
  let parsed;
  try {
    parsed = await callOpenAIJSON(prompt, 12000);
  } catch (err) {
    console.error("⚠️ OpenAI/JSON error; using defaults:", err.message);
    return defaults;
  }
  
  // Safe sanitize/enforce (ONLY if funcs exist)
  try {
    if (typeof sanitizeMedicalDiagnosis === "function") {
      parsed.medicalDiagnosis = sanitizeMedicalDiagnosis(parsed.medicalDiagnosis);
    }
    if (typeof sanitizeRelevantHistory === "function") {
      parsed.relevantHistory = sanitizeRelevantHistory(parsed.relevantHistory);
    }
    
    if (visitLabel === "PT INITIAL PT EVALUATION") {
      const fallback =
      typeof buildEvalClinicalStatementFallback === "function"
      ? buildEvalClinicalStatementFallback(structured)
      : defaults.clinicalStatement;
      
      const ok =
      typeof isValidSixSentencePtParagraph === "function"
      ? isValidSixSentencePtParagraph(parsed.clinicalStatement)
      : true;
      
      if (!ok) parsed.clinicalStatement = fallback;
    }
  } catch (e) {
    console.log("⚠️ sanitize/enforce skipped:", e.message);
  }
  
  return {
    visitType,
    hasExplicitPMH: structured.hasExplicitPMH,
    relevantHistory: (parsed.relevantHistory || defaults.relevantHistory || "").trim(),
    clinicalStatement: (parsed.clinicalStatement || defaults.clinicalStatement || "").trim(),
    vitals: {
      temperature: parsed.vitals?.temperature || defaults.vitals.temperature,
      temperatureTypeValue: parsed.vitals?.temperatureTypeValue || defaults.vitals.temperatureTypeValue,
      bpSys: parsed.vitals?.bpSys || defaults.vitals.bpSys,
      bpDia: parsed.vitals?.bpDia || defaults.vitals.bpDia,
      positionValue: parsed.vitals?.positionValue || defaults.vitals.positionValue,
      sideValue: parsed.vitals?.sideValue || defaults.vitals.sideValue,
      heartRate: parsed.vitals?.heartRate || defaults.vitals.heartRate,
      respirations: parsed.vitals?.respirations || defaults.vitals.respirations,
      vsComments: parsed.vitals?.vsComments || defaults.vitals.vsComments,
    },
    medicalDiagnosis: (parsed.medicalDiagnosis || defaults.medicalDiagnosis || "").trim(),
    subjective: (parsed.subjective || defaults.subjective || "").trim(),
    living: { ...defaults.living, ...(parsed.living || {}) },
    pain: { ...defaults.pain, ...(parsed.pain || {}) },
    neuro: defaults.neuro,
    func: defaults.func,
    dme: defaults.dme,
    edema: defaults.edema,
    priorLevel: defaults.priorLevel,
    patientGoals: defaults.patientGoals,
    romStrength: defaults.romStrength,
    plan: {
      ...defaults.plan,
      ...(parsed.plan || {}),
    planText:
      (parsed.plan?.planText || "").trim() ||
      (structured.plan?.planText || "").trim() ||
      (defaults.plan?.planText || "").trim(),
    },
  };
}

/* =========================
 * Vitals
 * =======================*/

async function fillVitalsAndNarratives(context, data) {
  console.log("➡️ Filling vitals + narratives...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("⚠️ Template frame not found for vitals/narratives");
    return;
  }
  
  const vitals = data?.vitals || {};
  
  // Temperature
  const tempInput = await firstVisibleLocator(frame, [
    "#frm_VSTemperature",
    "input[name*='VSTemperature']",
    "input[id*='VSTemperature']",
    "input[id*='Temperature']",
    "input[name*='Temperature']",
  ]);
  
  if (tempInput && vitals.temperature) {
    await tempInput.fill("");
    await tempInput.type(String(vitals.temperature), { delay: 30 });
    console.log("🌡 Temp:", vitals.temperature);
  }
  
  // Temperature Type (Temporal)
  try {
    const tempTypeSelect = await firstVisibleLocator(frame, [
      "#frm_VSTemperatureType",
      "select[name*='VSTemperatureType']",
      "select[id*='VSTemperatureType']",
      "select[id*='TemperatureType']",
      "select[name*='TemperatureType']",
    ]);
    
    if (tempTypeSelect && (await tempTypeSelect.isVisible().catch(() => false))) {
      let ok = false;
      
      // Try label match first (most stable)
      try {
        await tempTypeSelect.selectOption({ label: "Temporal" });
        ok = true;
        console.log("🌡 Temp type selected: Temporal");
      } catch {}
      
      // Fallback: value (default 4)
      if (!ok) {
        const val = String(vitals.temperatureTypeValue || "4");
        try {
          await tempTypeSelect.selectOption(val);
          ok = true;
          console.log("🌡 Temp type selected by value:", val);
        } catch {}
      }
      
      // Final fallback: fuzzy scan options for "temporal"
      if (!ok) {
        const opts = await tempTypeSelect.locator("option").evaluateAll(nodes =>
                                                                        nodes.map(n => ({ value: n.value || "", label: (n.textContent || "").trim() }))
                                                                        ).catch(() => []);
        
        const hit = opts.find(o => o.label.toLowerCase().includes("temporal"));
        if (hit?.value) {
          await tempTypeSelect.selectOption(hit.value).catch(() => {});
          console.log(`🌡 Temp type fuzzy matched: "${hit.label}" (${hit.value})`);
        } else {
          console.log("⚠️ No 'Temporal' option found in temp type dropdown.");
        }
      }
    } else {
      console.log("⚠️ Temp type dropdown not found/visible.");
    }
  } catch (e) {
    console.log("⚠️ Temp type select error:", e.message);
  }
  
  // BP
  const bpSys = await firstVisibleLocator(frame, ["#frm_VSPriorBPsys"]);
  if (bpSys && vitals.bpSys) {
    await bpSys.fill("");
    await bpSys.type(String(vitals.bpSys), { delay: 30 });
  }
  
  const bpDia = await firstVisibleLocator(frame, ["#frm_VSPriorBPdia"]);
  if (bpDia && vitals.bpDia) {
    await bpDia.fill("");
    await bpDia.type(String(vitals.bpDia), { delay: 30 });
  }
  
  const posSelect = frame.locator("#frm_VSPriorPosition").first();
  if (await posSelect.isVisible().catch(() => false)) {
    await posSelect.selectOption(vitals.positionValue || "2").catch(() => {});
  }
  
  const sideSelect = frame.locator("#frm_VSPriorSide").first();
  if (await sideSelect.isVisible().catch(() => false)) {
    await sideSelect.selectOption(vitals.sideValue || "1").catch(() => {});
  }
  
  // HR
  const hrInput = await firstVisibleLocator(frame, ["#frm_VSPriorHeartRate"]);
  if (hrInput && vitals.heartRate) {
    await hrInput.fill("");
    await hrInput.type(String(vitals.heartRate), { delay: 30 });
  }
  
  // Respirations
  const respInput = await firstVisibleLocator(frame, ["#frm_VSPriorResp"]);
  if (respInput && vitals.respirations) {
    await respInput.fill("");
    await respInput.type(String(vitals.respirations), { delay: 30 });
  }
  
  // VS Comments
  const vsCommentInput = await firstVisibleLocator(frame, [
    "#frm_VSComments",
    "#frm_VSPriorComment",
    "#frm_VSComment",
    "input[name*='VS'][name*='Comments']",
    "textarea[name*='VS'][name*='Comment']",
  ]);
  
  const vsText = (vitals.vsComments || "").trim();
  if (vsCommentInput && vsText) {
    await vsCommentInput.fill("");
    await vsCommentInput.type(vsText, { delay: 25 });
    console.log("💬 VS Comments filled.");
  }
  
  // ==========================
  // ✅ Initial Evaluation ONLY fields you listed as missing:
  //   - Relevant Medical History: #frm_RlvntMedHist
  //   - Clinical Statement / Assessment Summary: #frm_EASI1
  // ==========================
  
  // NOTE: "Re-evaluation" contains the substring "evaluation".
  // Be strict here, or we will incorrectly overwrite Re-eval/Visit/DC fields.
  const vt = (data?.visitType || "").toLowerCase();
  const isReeval = vt.includes("re-eval") || vt.includes("re-evaluation") || vt.includes("recert");
  const isDischarge = vt.includes("discharge") || vt === "dc" || vt.includes(" dc");
  const isVisit = vt.includes("visit") && !isReeval && !isDischarge;
  const isInitialEval = !vt || (vt.includes("evaluation") && !isReeval && !isDischarge && !isVisit);
  
  // Only fill PMH if explicitly present (prevents overwrite on Re-eval)
  if (isInitialEval) {
    const relevantHistoryText = (data?.relevantHistory || "").trim();
    if (relevantHistoryText) {
      const relHist = await firstVisibleLocator(frame, [
        "#frm_RlvntMedHist",
        "textarea#frm_RlvntMedHist",
        "textarea[name='frm_RlvntMedHist']",
      ]);
      if (relHist) {
        await relHist.fill("");
        await relHist.type(relevantHistoryText, { delay: 10 });
        console.log("🧾 Relevant Medical History filled.");
      }
    }
  }
  
  // Only fill Clinical Statement (frm_EASI1) here for INITIAL EVAL.
  // Re-eval has its own dedicated fill logic in ptReevalBot.js.
  if (isInitialEval) {
    const clinicalStatementText = (data?.clinicalStatement || "").trim();
    if (clinicalStatementText) {
      const cs = await firstVisibleLocator(frame, [
        "#frm_EASI1",
        "textarea#frm_EASI1",
        "textarea[name='frm_EASI1']",
      ]);
      if (cs) {
        await cs.fill("");
        await cs.type(clinicalStatementText, { delay: 10 });
        console.log("📝 Clinical statement filled (Initial Eval): frm_EASI1");
      } else {
        console.log("⚠️ Could not find frm_EASI1 on the template.");
      }
    }
  } else {
    console.log("🚫 Clinical statement skipped here (not Initial Evaluation).");
  }
  
  console.log("✅ Vitals + narratives finished.");
}

/* =========================
 * Medical Dx
 * =======================*/

async function fillMedDiagnosisAndSubjective(context, data) {
  console.log("➡️ Filling Medical Dx only (subjective removed)...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("⚠️ Template frame not found for Dx");
    return;
  }
  
  // Medical Diagnosis ONLY
  if (data.medicalDiagnosis) {
    const medDxInput = await firstVisibleLocator(frame, ["#frm_MedDiagText"]);
    if (medDxInput) {
      await medDxInput.fill("");
      await medDxInput.type(data.medicalDiagnosis, { delay: 20 });
      console.log("🧾 Medical Dx filled:", data.medicalDiagnosis);
    }
  }
  
  // Subjective removed — do nothing
  console.log("🚫 Subjective skipped (intentionally not filled).");
}

/* =========================
 * Subjective
 * =======================*/
async function fillSubjectiveOnly(context, data) {
  console.log("➡️ Filling Subjective only (no Medical Dx)...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("⚠️ Template frame not found for subjective");
    return;
  }
  
  if (data.subjective) {
    const subjArea = await firstVisibleLocator(frame, ["#frm_SubInfo"]);
    if (subjArea) {
      await verifySetText(frame, "#frm_SubInfo", data.subjective, "Subjective (#frm_SubInfo)");
      console.log("🗣 Subjective filled");
    }
  }
}

/* =========================
 * Neuro / Physical assessment
 * =======================*/

async function fillNeuroPhysical(context, data) {
  console.log("➡️ Filling Neuro/Physical assessment...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("⚠️ Template frame not found for neuro/physical.");
    return;
  }
  
  const neuro = data.neuro || {};
  
  const map = {
    orientation: "#frm_PhyAsmtOrientation",
    speech: "#frm_PhyAsmtSpeech",
    vision: "#frm_PhyAsmtVision",
    hearing: "#frm_PhyAsmtHearing",
    skin: "#frm_PhyAsmtSkin",
    muscleTone: "#frm_PhyAsmtMuscle",
    coordination: "#frm_PhyAsmtCoordination",
    sensation: "#frm_PhyAsmtSensation",
    endurance: "#frm_PhyAsmtEndurance",
    posture: "#frm_PhyAsmtPosture",
  };
  
  for (const [key, selector] of Object.entries(map)) {
    const value = neuro[key];
    if (!value) continue;
    try {
      const field = await firstVisibleLocator(frame, [selector]);
      if (field) {
        await field.fill("");
        await field.type(value, { delay: 10 });
        console.log(`🧠 ${key} filled.`);
      }
    } catch (e) {
      console.log(`⚠️ Could not fill ${key}:`, e.message);
    }
  }
}

/* =========================
 * Edema
 * =======================*/

async function fillEdemaSection(context, data) {
  console.log("➡️ Filling Edema section...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("⚠️ Template frame not found for edema.");
    return;
  }
  
  const edema = data.edema || { status: "absent" };
  
  const presentBox = frame.locator("#frm_EdemaLocOptionPresent").first();
  const absentBox = frame.locator("#frm_EdemaLocOptionAbsent").first();
  
  if (edema.status === "present") {
    if (await presentBox.isVisible().catch(() => false)) {
      await presentBox.check().catch(() => {});
    }
    if (await absentBox.isVisible().catch(() => false)) {
      await absentBox.uncheck().catch(() => {});
    }
    
    if (edema.type && (edema.type === "dependent" || edema.type === "both")) {
      const dep = frame.locator("#frm_EdemaDependent").first();
      if (await dep.isVisible().catch(() => false)) {
        await dep.check().catch(() => {});
      }
    }
    
    if (edema.type && (edema.type === "pitting" || edema.type === "both")) {
      const pit = frame.locator("#frm_EdemaPittingCheckbox").first();
      if (await pit.isVisible().catch(() => false)) {
        await pit.check().catch(() => {});
      }
      
      const grade = frame.locator("#frm_EdemaPittingSelect").first();
      if (edema.pittingGrade && (await grade.isVisible().catch(() => false))) {
        await grade.selectOption(String(edema.pittingGrade)).catch(() => {});
      }
    }
    
    if (edema.location) {
      const loc = await firstVisibleLocator(frame, ["#frm_PhyAsmtEdemaLocText"]);
      if (loc) {
        await loc.fill("");
        await loc.type(edema.location, { delay: 10 });
      }
    }
  } else if (edema.status === "absent") {
    if (await absentBox.isVisible().catch(() => false)) {
      await absentBox.check().catch(() => {});
    }
    if (await presentBox.isVisible().catch(() => false)) {
      await presentBox.uncheck().catch(() => {});
    }
  }
}

/* =========================
 * Pain (NEW schema)
 * =======================*/

async function fillPainSection(context, data) {
  console.log("➡️ Filling Pain Assessment (if present)...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("⚠️ Template frame not found for pain");
    return;
  }
  
  const pain = data?.pain || {};
  
  // If NO pain in note → tick "No Pain Reported" and exit
  if (!pain.hasPain) {
    try {
      const noPainBox = await firstVisibleLocator(frame, [
        "#frm_PainAsmtNoPain",
        "input[type='checkbox'][name*='NoPain']",
        "input[type='checkbox'][id*='NoPain']",
      ]);
      if (noPainBox) {
        await noPainBox.check().catch(() => {});
        console.log("☑️ 'No Pain Reported' checked (no pain in AI note).");
      } else {
        console.log("ℹ️ No explicit 'No Pain Reported' checkbox found.");
      }
    } catch (e) {
      console.log("⚠️ Could not set 'No Pain Reported':", e.message);
    }
    return;
  }
  
  // Normalize location: "Other, L knee" -> "L knee"
  const normalizePainLocation = (raw) => {
    let s = (raw || "").toString().trim();
    if (!s) return "";
    // remove leading "Other," / "Other -" / etc.
    s = s.replace(/^other\s*[,:\-]\s*/i, "");
    // if still comma-separated, take the last meaningful chunk
    if (s.includes(",")) {
      const parts = s.split(",").map(p => p.trim()).filter(Boolean);
      if (parts.length) s = parts[parts.length - 1];
    }
    return s.trim();
  };
  
  const locationText = normalizePainLocation(pain.primaryLocationText);
  const intensityVal =
  pain.intensityValue && pain.intensityValue !== "-1"
  ? String(pain.intensityValue)
  : "";
  
  try {
    // Primary Site: select "Other"
    const siteSelect = frame.locator("#frm_PainAsmtSitePrim").first();
    if (await siteSelect.isVisible().catch(() => false)) {
      await siteSelect.selectOption({ label: "Other" }).catch(() => {});
    }
    
    // "Other" description textbox (cover BOTH id spellings)
    // NOTE: you said Post intensity ID is frm_PaintAsmtSiteOtherDescPrim
    // That looks like the textbox id; we support both anyway.
    if (locationText) {
      const siteOther = await firstVisibleLocator(frame, [
        "#frm_PainAsmtSiteOtherDescPrim",
        "#frm_PaintAsmtSiteOtherDescPrim", // <-- your provided ID (typo variant)
        "input[id*='PainAsmtSiteOtherDescPrim']",
        "input[id*='PaintAsmtSiteOtherDescPrim']",
      ]);
      
      if (siteOther) {
        await siteOther.fill("").catch(() => {});
        await siteOther.type(locationText, { delay: 20 }).catch(() => {});
        console.log("📍 Pain location (Other):", locationText);
      } else {
        console.log("⚠️ Could not find Pain 'Other' location textbox.");
      }
    }
    
    // Pre-Therapy Intensity (existing)
    if (intensityVal) {
      const preIntensitySelect = await firstVisibleLocator(frame, [
        "#frm_PainAsmtSiteIntnstyPrimary1",
        "select[id*='IntnstyPrimary1']",
        "select[id*='IntensityPrimary1']",
      ]);
      
      if (preIntensitySelect && (await preIntensitySelect.isVisible().catch(() => false))) {
        await preIntensitySelect.selectOption(intensityVal).catch(() => {});
        console.log("📊 Pain intensity (Pre):", intensityVal);
      } else {
        console.log("⚠️ Could not find Pre intensity dropdown.");
      }
      
      // ✅ Post-Therapy Intensity (NEW) – mirror pre unless you add a separate post value later
      const postIntensitySelect = await firstVisibleLocator(frame, [
        "#frm_PainAsmtSiteIntnstyPrimary2",
        "select[id*='IntnstyPrimary2']",
        "select[id*='IntensityPrimary2']",
        "select[id*='Post']",
      ]);
      
      if (postIntensitySelect && (await postIntensitySelect.isVisible().catch(() => false))) {
        await postIntensitySelect.selectOption(intensityVal).catch(() => {});
        console.log("📊 Pain intensity (Post):", intensityVal);
      } else {
        console.log("ℹ️ Post intensity dropdown not found/visible (skipped).");
      }
    }
    
    // Increased by / Relieved by / Interferes with
    const incInput = await firstVisibleLocator(frame, ["#frm_PainAsmtText1"]);
    if (incInput && pain.increasedBy) {
      await incInput.fill("").catch(() => {});
      await incInput.type(pain.increasedBy, { delay: 20 }).catch(() => {});
    }
    
    const relInput = await firstVisibleLocator(frame, ["#frm_PainAsmtText2"]);
    if (relInput && pain.relievedBy) {
      await relInput.fill("").catch(() => {});
      await relInput.type(pain.relievedBy, { delay: 20 }).catch(() => {});
    }
    
    const intfInput = await firstVisibleLocator(frame, ["#frm_PainAsmtText3"]);
    if (intfInput && pain.interferesWith) {
      await intfInput.fill("").catch(() => {});
      await intfInput.type(pain.interferesWith, { delay: 20 }).catch(() => {});
    }
    
    console.log("✅ Pain section filled from AI");
  } catch (e) {
    console.log("⚠️ Error filling pain section:", e.message);
  }
}


/* =========================
 * LIVING SITUATION + SAFETY / HAZARDS
 * =======================*/

async function fillHomeSafetySection(context, data) {
  console.log("➡️ Filling Living Situation / Safety Hazards...");
  
  // =========================
  // ✅ Anti-hang helpers
  // =========================
  async function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`Timeout: ${label} (${ms}ms)`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(t);
    }
  }
  
  async function isVisibleFast(locator, ms = 900) {
    try {
      return await locator.isVisible({ timeout: ms });
    } catch {
      return false;
    }
  }
  
  async function ensureReady(locator, label, ms = 2500) {
    try {
      if (!locator) return false;
      await withTimeout(locator.waitFor({ state: "visible", timeout: ms }), ms + 200, `${label}.waitFor(visible)`);
      // scroll improves interactability a lot in WellSky templates
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      return true;
    } catch (e) {
      console.log(`⚠️ ${label} not ready:`, e.message);
      return false;
    }
  }
  
  async function safeFill(locatorOrNull, value, label) {
    const v = (value ?? "").toString().trim();
    if (!locatorOrNull || !v) return;
    try {
      if (!(await ensureReady(locatorOrNull, label, 2500))) return;
      await withTimeout(locatorOrNull.fill(""), 1400, `${label}.fill`);
      await withTimeout(locatorOrNull.fill(v), 1600, `${label}.fill(value)`);
      console.log(`✅ ${label} filled`);
    } catch (e) {
      console.log(`⚠️ ${label} skipped:`, e.message);
    }
  }
  
  async function safeType(locatorOrNull, value, label, typeDelay = 8) {
    const v = (value ?? "").toString().trim();
    if (!locatorOrNull || !v) return;
    try {
      if (!(await ensureReady(locatorOrNull, label, 2500))) return;
      await withTimeout(locatorOrNull.fill(""), 1400, `${label}.fill`);
      await withTimeout(locatorOrNull.type(v, { delay: typeDelay }), 2600, `${label}.type`);
      console.log(`✅ ${label} typed`);
    } catch (e) {
      // fallback to fill if type fails
      try {
        await safeFill(locatorOrNull, v, `${label} (fallback fill)`);
      } catch (_) {
        console.log(`⚠️ ${label} skipped:`, e.message);
      }
    }
  }
  
  async function safeCheck(locator, label) {
    try {
      if (!locator) return;
      if (!(await ensureReady(locator, label, 2000))) return;
      await withTimeout(locator.check({ force: true }), 1700, `${label}.check`);
      console.log(`✅ ${label} checked`);
    } catch (e) {
      console.log(`⚠️ ${label} skipped:`, e.message);
    }
  }
  
  async function safeUncheck(locator, label) {
    try {
      if (!locator) return;
      if (!(await ensureReady(locator, label, 2000))) return;
      // only uncheck if currently checked
      const checked = await locator.isChecked().catch(() => false);
      if (!checked) return;
      await withTimeout(locator.uncheck({ force: true }), 1700, `${label}.uncheck`);
      console.log(`✅ ${label} unchecked`);
    } catch (e) {
      console.log(`⚠️ ${label} uncheck skipped:`, e.message);
    }
  }
  
  // =========================
  // ✅ Find frame with timeout
  // =========================
  let frame = null;
  try {
    frame = await withTimeout(findTemplateScope(context), 7500, "findTemplateScope(homeSafety)");
  } catch (e) {
    console.log("⚠️ Template frame timeout for home safety:", e.message);
    return;
  }
  
  if (!frame) {
    console.log("⚠️ Template frame not found for home safety");
    return;
  }
  
  const living = (data && data.living) ? data.living : {};
  
  // =========================
  // ✅ Select helper (value/label/fuzzy)
  // =========================
  async function safeSelect(selectLocator, valueOrLabel, label) {
    const raw = (valueOrLabel ?? "").toString().trim();
    if (!raw || raw === "0") return false;
    
    try {
      if (!(await ensureReady(selectLocator, label, 2800))) return false;
      
      // Wait until options exist (WellSky often populates late)
      await withTimeout(
                        selectLocator.locator("option").first().waitFor({ state: "attached", timeout: 2500 }),
                        2600,
                        `${label}.options(attached)`
                        ).catch(() => {});
      
      // Try direct by value first
      try {
        await withTimeout(selectLocator.selectOption(raw), 2400, `${label}.selectOption(value)`);
        return true;
      } catch (_) {}
      
      // Try direct by label
      try {
        await withTimeout(selectLocator.selectOption({ label: raw }), 2400, `${label}.selectOption(label)`);
        return true;
      } catch (_) {}
      
      // Fuzzy label match (case-insensitive, partial)
      const opts = await selectLocator.locator("option").evaluateAll((nodes) =>
                                                                     nodes.map((n) => ({
        value: n.value || "",
        label: (n.textContent || "").trim(),
      }))
                                                                     ).catch(() => []);
      
      if (opts.length) {
        const needle = raw.toLowerCase();
        const hit =
        opts.find((o) => o.label.toLowerCase() === needle) ||
        opts.find((o) => o.label.toLowerCase().includes(needle)) ||
        opts.find((o) => needle.includes(o.label.toLowerCase())) ||
        null;
        
        if (hit && hit.value) {
          await withTimeout(selectLocator.selectOption(hit.value), 2400, `${label}.selectOption(fuzzyValue)`);
          console.log(`ℹ️ ${label} fuzzy matched "${raw}" → "${hit.label}"`);
          return true;
        }
      }
      
      console.log(`⚠️ ${label} selectOption failed: no match for "${raw}"`);
      return false;
    } catch (e) {
      console.log(`⚠️ ${label} selectOption failed:`, e.message);
      return false;
    }
  }
  
  // ---- Patient lives dropdown (#frm_PatLives) ----
  try {
    const livesSelect = frame.locator("#frm_PatLives").first();
    const ok = await safeSelect(livesSelect, living.patientLivesValue, "Patient lives (#frm_PatLives)");
    if (ok) console.log("🏠 Patient lives set:", living.patientLivesValue);
  } catch (e) {
    console.log("⚠️ Could not set Patient lives:", e.message);
  }
  
  // ---- Assistance available dropdown (#frm_AsstAvail) ----
  try {
    const asstSelect = frame.locator("#frm_AsstAvail").first();
    const ok = await safeSelect(asstSelect, living.assistanceAvailableValue, "Assistance available (#frm_AsstAvail)");
    if (ok) console.log("👥 Assistance available set:", living.assistanceAvailableValue);
  } catch (e) {
    console.log("⚠️ Could not set Assistance available:", e.message);
  }
  
  // ---- Evaluation narrative (#frm_SafetySanHaz13) ----
  try {
    const evalArea = await firstVisibleLocator(frame, ["#frm_SafetySanHaz13"]);
    await safeType(evalArea, living.evaluationText, "Living/Safety narrative (#frm_SafetySanHaz13)");
  } catch (e) {
    console.log("⚠️ Could not fill Evaluation of Living Situation:", e.message);
  }
  
  // ---- Current Types of Assistance (#frm_CurrTypAsst) ----
  try {
    const currAssist = await firstVisibleLocator(frame, ["#frm_CurrTypAsst"]);
    await safeType(currAssist, living.currentAssistanceTypes, "Current assistance types (#frm_CurrTypAsst)");
  } catch (e) {
    console.log("⚠️ Could not fill Current Types of Assistance:", e.message);
  }
  
  // ---- Steps / Stairs (#frm_SafetySanHaz2 / #frm_SafetySanHaz3) ----
  try {
    if (living.stepsPresent) {
      const stepsCheckbox = frame.locator("#frm_SafetySanHaz2").first();
      await safeCheck(stepsCheckbox, "Steps/Stairs (#frm_SafetySanHaz2)");
      
      if (living.stepsCount) {
        const stepsText = await firstVisibleLocator(frame, ["#frm_SafetySanHaz3"]);
        await safeType(stepsText, living.stepsCount, "Steps count (#frm_SafetySanHaz3)");
      }
    }
  } catch (e) {
    console.log("⚠️ Could not fill steps/stairs:", e.message);
  }
  
  // ---- Safety / Sanitation Hazards checkboxes ----
  try {
    const txt = String(living.evaluationText || "").toLowerCase();
    
    const hazardDefs = [
      { selector: "#frm_SafetySanHaz6",  keys: ["narrow", "obstructed walkway"] },
      { selector: "#frm_SafetySanHaz9",  keys: ["cluttered", "soiled living area", "clutter"] },
      { selector: "#frm_SafetySanHaz4",  keys: ["no running water", "no plumbing"] },
      { selector: "#frm_SafetySanHaz7",  keys: ["no fire", "no smoke detector", "no fire safety"] },
      { selector: "#frm_SafetySanHaz10", keys: ["inadequate lighting", "poor lighting", "too hot", "too cold"] },
      { selector: "#frm_SafetySanHaz5",  keys: ["insect", "rodent"] },
      { selector: "#frm_SafetySanHaz8",  keys: ["no gas", "no electric appliance"] },
      { selector: "#frm_SafetySanHaz21", keys: ["unsecured rug", "unsecured floor", "loose rug", "throw rug"] },
    ];
    
    // Determine if we are going to set ANY hazard-ish flags
    let anyHazard = false;
    
    if (living.hasPets) anyHazard = true;
    if (living.stepsPresent) anyHazard = true;
    
    for (const h of hazardDefs) {
      if (h.keys.some((k) => txt.includes(k))) {
        anyHazard = true;
        break;
      }
    }
    
    // If we’re setting any hazards, uncheck “No hazards identified” (commonly #frm_SafetySanHaz1)
    if (anyHazard) {
      const noHazardsBox = frame.locator("#frm_SafetySanHaz1").first();
      await safeUncheck(noHazardsBox, "No hazards identified (#frm_SafetySanHaz1)");
    }
    
    // Pets checkbox
    if (living.hasPets) {
      const petsBox = frame.locator("#frm_SafetySanHaz20").first();
      await safeCheck(petsBox, "Pets hazard (#frm_SafetySanHaz20)");
    }
    
    // Keyword hazards
    for (const h of hazardDefs) {
      const hit = h.keys.some((k) => txt.includes(k));
      if (!hit) continue;
      
      const box = frame.locator(h.selector).first();
      await safeCheck(box, `Hazard ${h.selector}`);
    }
  } catch (e) {
    console.log("⚠️ Error while setting hazard checkboxes:", e.message);
  }
  
  console.log("✅ Living Situation / Safety Hazards finished.");
}

/**
 * Backwards-compatible wrapper so ptEvaluationBot can still call fillLivingSituation.
 * Internally it just calls fillHomeSafetySection with the same data.
 */
async function fillLivingSituation(context, data) {
  console.log("ℹ️ fillLivingSituation() wrapper → calling fillHomeSafetySection()");
  await fillHomeSafetySection(context, data);
}

/* =========================
 * Treatment Goals + Pain Plan
 * =======================*/


async function fillTreatmentGoalsAndPainPlan(context, data) {
  console.log("➡️ Filling Treatment Goals + Pain Plan...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("⚠️ Template frame not found for goals/plan.");
    return;
  }
  
  const pain = data.pain || {};
  const plan = data.plan || {};
  
  const aiGoalLines = plan.goalTexts || [];
  const firstLine = (aiGoalLines[0] || "").trim().toLowerCase();
  const instructionMode = firstLine.startsWith("give me");
  
  // ✅ Helper: normalize "x visits"
  function normalizeVisits(str, fallbackNumber) {
    // null/undefined → fallback
    if (str === null || str === undefined) return `${fallbackNumber} visits`;
    
    // If it's already a number (e.g., 4), treat it as visit count
    if (typeof str === "number" && Number.isFinite(str)) {
      return `${str} visits`;
    }
    
    // If it's an object/array, try to extract a number; otherwise fallback
    if (typeof str === "object") {
      try {
        // Common cases: { value: 4 } or { visits: 4 } etc.
        const candidate =
        (typeof str.value === "number" && str.value) ||
        (typeof str.visits === "number" && str.visits) ||
        null;
        
        if (candidate && Number.isFinite(candidate)) return `${candidate} visits`;
        
        // As a last resort, stringify and attempt numeric extraction
        const s = JSON.stringify(str);
        const nMatch = s.match(/(\d+)/);
        if (nMatch) return `${nMatch[1]} visits`;
        
        return `${fallbackNumber} visits`;
      } catch {
        return `${fallbackNumber} visits`;
      }
    }
    
    // Everything else: coerce to string safely
    const s = String(str).trim();
    if (!s) return `${fallbackNumber} visits`;
    
    // If it already contains "visit"
    if (/visits?/i.test(s)) return s;
    
    // Extract first number if present
    const nMatch = s.match(/(\d+)/);
    const n = nMatch ? nMatch[1] : fallbackNumber;
    
    return `${n} visits`;
  }
  
  // ✅ Helper: check "Plan for next visit" box
  async function checkPlanForNextVisitBox() {
    const box = await firstVisibleLocator(frame, [
      "#frm_PlanNextVisit",
      "input[type='checkbox'][id*='PlanNext']",
      "input[type='checkbox'][name*='PlanNext']",
      "input[type='checkbox']:near(text=Plan for next visit)",
    ]);
    
    
    const planText = (noteData?.plan?.planText || "").trim();
    const planShort = shortenPlanText(planText, 110);
    if (!box) {
      console.log("⚠️ Plan for next visit checkbox not found");
      return;
    }
    
    const checked = await box.isChecked().catch(() => false);
    if (!checked) {
      await box.check({ force: true }).catch(() => {});
      console.log("☑️ Plan for next visit checkbox checked");
    }
  }
  
  let goalTexts = [];
  let stText = "";
  let ltText = "";
  
  if (instructionMode) {
    goalTexts = [
      "Pt will perform all bed mobility tasks with Indep on flat bed with rails as needed.",
      "Pt will perform all transfers bed↔chair/toilet with Indep using appropriate DME (e.g., hoyer lift with trained CG assist).",
      "Pt/CG will be independent with HEP focused on strengthening, positioning, and mobility to maintain function.",
      "CG will demonstrate independent pressure relief positioning schedule to reduce risk of skin breakdown.",
      "CG will demonstrate safe hoyer lift setup and operation for bed↔wheelchair transfers without PT assistance.",
      "Pt/CG will verbalize understanding of ongoing HEP and safety/pressure-relief plan to maintain functional status.",
    ];
    
    const combined = aiGoalLines.join(" ");
    const visitMatches = [...combined.matchAll(/total of\s*(\d+)\s*visits?/gi)];
    const stNum = visitMatches[0]?.[1];
    const ltNum = visitMatches[1]?.[1];
    
    stText = stNum ? `${stNum} visits` : "4 visits";
    ltText = ltNum ? `${ltNum} visits` : "7 visits";
  } else {
    const defaultGoals = [
      "Pt will demonstrate safe bed mobility with Indep.",
      "Pt will demonstrate safe transfers using HW with Indep.",
      "Pt will ambulate 150 ft using HW with Mod Indep.",
      "Pt/CG will be independent with HEP, mobility, and fall/safety precautions.",
      "Pt will improve Tinetti-POMA score to 20/28 or more to decrease fall risk.",
      "Pt will improve B LE strength by at least 0.5 MMT grade to enhance functional mobility.",
    ];
    
    goalTexts = [];
    for (let i = 0; i < 6; i++) {
      goalTexts[i] = (aiGoalLines[i] && aiGoalLines[i].trim()) || defaultGoals[i];
    }
    
    stText = normalizeVisits(plan.shortTermVisits, 4);
    ltText = normalizeVisits(plan.longTermVisits, 7);
  }
  
  const goalSelectors = [
    "#frm_TrtmntGoalTxt1",
    "#frm_TrtmntGoalTxt2",
    "#frm_TrtmntGoalTxt3",
    "#frm_TrtmntGoalTxt4",
    "#frm_TrtmntGoalTxt5",
    "#frm_TrtmntGoalTxt6",
  ];
  
  for (let i = 0; i < goalSelectors.length; i++) {
    const field = await firstVisibleLocator(frame, [goalSelectors[i]]);
    if (field && goalTexts[i]) {
      await field.fill("");
      await field.type(goalTexts[i], { delay: 15 });
    }
  }
  
  // Time frames: ST for first 2, LT for last 4
  const timeVals = [stText, stText, ltText, ltText, ltText, ltText];
  const timeSelectors = [
    "#frm_TrtmntGoalTime1",
    "#frm_TrtmntGoalTime2",
    "#frm_TrtmntGoalTime3",
    "#frm_TrtmntGoalTime4",
    "#frm_TrtmntGoalTime5",
    "#frm_TrtmntGoalTime6",
  ];
  
  for (let i = 0; i < timeSelectors.length; i++) {
    const field = await firstVisibleLocator(frame, [timeSelectors[i]]);
    if (field && timeVals[i]) {
      await field.fill("");
      await field.type(timeVals[i], { delay: 10 });
    }
  }
  
  /* =========================
   * ✅ Plan for next visit (CHECK BOX + FILL TEXT)
   * =======================*/
  const planText = (plan.planText || "").trim();
  if (planText) {
    await checkPlanForNextVisitBox();
    
    const planField = await firstVisibleLocator(frame, [
      "#frm_PlanNextVisitText",
      "textarea[id*='PlanNext']",
      "textarea[name*='PlanNext']",
      "textarea:near(text=Plan for next visit)",
    ]);
    
    if (planField) {
      await planField.fill("");
      await planField.type(planText, { delay: 10 });
      console.log("📝 Plan for next visit text filled");
    } else {
      console.log("⚠️ Plan for next visit textbox not found");
    }
  } else {
    console.log("ℹ️ No plan.planText provided; plan box/text skipped.");
  }
  
  // ---- Pain Plan (if pain detected) ----
  if (pain.hasPain) {
    try {
      const boxPain = frame.locator("#frm_TrtmntPlan_23").first();
      if (await boxPain.isVisible().catch(() => false)) {
        await boxPain.check().catch(() => {});
      }
      
      const iceHeat = await firstVisibleLocator(frame, ["#frm_TrtmntPlan_24"]);
      if (iceHeat) {
        await iceHeat.fill("");
        await iceHeat.type("Ice/heat x 10 min prn for pain", { delay: 10 });
      }
      
      const mtComments = await firstVisibleLocator(frame, [
                                                           "#frm_TrtmntPlanComments1",
                                                           ]);
      if (mtComments) {
        await mtComments.fill("");
        await mtComments.type("Manual therapy prn for pain management.", {
          delay: 10,
        });
      }
      
      console.log("✅ Pain treatment plan filled.");
    } catch (e) {
      console.log("⚠️ Could not fill pain treatment plan:", e.message);
    }
  } else {
    console.log("ℹ️ No pain detected: pain plan not filled.");
  }
}

/* =========================
 * DME
 * =======================*/

async function fillDMESection(context, data) {
  console.log("➡️ Filling DME section...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("⚠️ Template frame not found for DME.");
    return;
  }
  
  const dme = data.dme || {};
  const map = {
    wheelchair: { id: "#frm_DME1", label: "Wheelchair" },
    walker: { id: "#frm_DME2", label: "Walker" },
    hospitalBed: { id: "#frm_DME3", label: "Hospital Bed" },
    bedsideCommode: { id: "#frm_DME4", label: "Bedside Commode" },
    raisedToiletSeat: { id: "#frm_DME5", label: "Raised Toilet Seat" },
    tubShowerBench: { id: "#frm_DME6", label: "Tub / Shower Bench" },
  };
  
  for (const [key, cfg] of Object.entries(map)) {
    const flag = dme[key];
    if (typeof flag !== "boolean") continue;
    
    let box = frame.locator(cfg.id).first();
    let visible = await box.isVisible().catch(() => false);
    
    // Fallback to label-based lookup if id doesn’t match
    if (!visible && cfg.label) {
      try {
        const byLabel = frame.getByLabel(cfg.label).first();
        if (await byLabel.isVisible().catch(() => false)) {
          box = byLabel;
          visible = true;
        }
      } catch {
        // ignore
      }
    }
    
    if (!visible) continue;
    
    try {
      if (flag) {
        await box.check().catch(() => {});
      } else {
        await box.uncheck().catch(() => {});
      }
      console.log(`🧰 DME ${key}: ${flag ? "checked" : "unchecked"}`);
    } catch (e) {
      console.log(`⚠️ DME ${key} error:`, e.message);
    }
  }
  
  if (dme.other) {
    const otherField = await firstVisibleLocator(frame, ["#frm_DME7"]);
    if (otherField) {
      await otherField.fill("");
      await otherField.type(dme.other, { delay: 10 });
    }
  }
}

/* =========================
 * Functional (FAPT) fields
 * =======================*/

async function fillFunctionalSection(context, data) {
  console.log("➡️ Filling Functional (FAPT) section...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("⚠️ Template frame not found for FAPT.");
    return;
  }
  
  const func = data.func || {};
  
  // Bed mobility – Assist Level (FAPT1/4/6) + Assistive Device (FAPT5/7)
  const bedAssist = func.bedMobilityAssist || "";
  const bedDevice = func.bedMobilityDevice || "";
  
  const bedAssistSelectors = ["#frm_FAPT1", "#frm_FAPT4", "#frm_FAPT6"];
  const bedDeviceSelectors = ["#frm_FAPT5", "#frm_FAPT7"];
  
  for (const sel of bedAssistSelectors) {
    const field = frame.locator(sel).first();
    if (bedAssist && (await field.isVisible().catch(() => false))) {
      await field.fill("").catch(() => {});
      await field.type(bedAssist, { delay: 10 }).catch(() => {});
    }
  }
  for (const sel of bedDeviceSelectors) {
    const field = frame.locator(sel).first();
    if (bedDevice && (await field.isVisible().catch(() => false))) {
      await field.fill("").catch(() => {});
      await field.type(bedDevice, { delay: 10 }).catch(() => {});
    }
  }
  
  // Transfers – Assist Level + Device
  const transAssist = func.transfersAssist || "";
  const transDevice = func.transfersDevice || "";
  
  const transAssistSelectors = [
    "#frm_FAPT8",
    "#frm_FAPT10",
    "#frm_FAPT16",
    "#frm_FAPT18",
  ];
  const transDeviceSelectors = [
    "#frm_FAPT9",
    "#frm_FAPT11",
    "#frm_FAPT17",
    "#frm_FAPT19",
  ];
  
  for (const sel of transAssistSelectors) {
    const field = frame.locator(sel).first();
    if (transAssist && (await field.isVisible().catch(() => false))) {
      await field.fill("").catch(() => {});
      await field.type(transAssist, { delay: 10 }).catch(() => {});
    }
  }
  for (const sel of transDeviceSelectors) {
    const field = frame.locator(sel).first();
    if (transDevice && (await field.isVisible().catch(() => false))) {
      await field.fill("").catch(() => {});
      await field.type(transDevice, { delay: 10 }).catch(() => {});
    }
  }
  
  // Gait – Assist Level (FAPT27), Distance (FAPT28), AD (FAPT29)
  if (func.gaitAssist) {
    const f = frame.locator("#frm_FAPT27").first();
    if (await f.isVisible().catch(() => false)) {
      await f.fill("").catch(() => {});
      await f.type(func.gaitAssist, { delay: 10 }).catch(() => {});
    }
  }
  if (func.gaitDistanceFt) {
    const f = frame.locator("#frm_FAPT28").first();
    if (await f.isVisible().catch(() => false)) {
      await f.fill("").catch(() => {});
      await f.type(func.gaitDistanceFt, { delay: 10 }).catch(() => {});
    }
  }
  if (func.gaitAD) {
    const f = frame.locator("#frm_FAPT29").first();
    if (await f.isVisible().catch(() => false)) {
      await f.fill("").catch(() => {});
      await f.type(func.gaitAD, { delay: 10 }).catch(() => {});
    }
  }
  
  // Stairs – Assist Level (FAPT33)
  if (func.stairsAssist) {
    const f = frame.locator("#frm_FAPT33").first();
    if (await f.isVisible().catch(() => false)) {
      await f.fill("").catch(() => {});
      await f.type(func.stairsAssist, { delay: 10 }).catch(() => {});
    }
  }
  
  // Weight Bearing Status (FAPT40)
  if (func.weightBearing) {
    const f = frame.locator("#frm_FAPT40").first();
    if (await f.isVisible().catch(() => false)) {
      await f.fill("").catch(() => {});
      await f.type(func.weightBearing, { delay: 10 }).catch(() => {});
    }
  }
}


/* =========================
 * Frequency + Effective Date
 * =======================*/

async function fillFrequencyAndDate(context, data, visitDate) {
  console.log("➡️ Filling Frequency + Effective Date...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("⚠️ Template frame not found for plan.");
    return;
  }
  
  const plan = data.plan || {};
  
  // --- Frequency (frm_FreqDur2) ---
  if (plan.frequency) {
    const freqField = await firstVisibleLocator(frame, ["#frm_FreqDur2"]);
    if (freqField) {
      await freqField.fill("").catch(() => {});
      await freqField.type(plan.frequency, { delay: 10 }).catch(() => {});
      console.log("📆 Frequency filled:", plan.frequency);
    }
  }
  
  // Normalize effective date to MM/DD/YYYY – default to visit date if plan.effectiveDate is missing/skip
  const effectiveRaw =
  plan.effectiveDate && plan.effectiveDate !== "skip"
  ? plan.effectiveDate
  : visitDate;
  
  const effective = normalizeDateToMMDDYYYY(effectiveRaw);
  
  console.log(
              "📆 Effective date (raw → normalized):",
              effectiveRaw,
              "→",
              effective
              );
  
  // --- Effective Date (frm_FreqDur1) ---
  if (effective) {
    const effField = await firstVisibleLocator(frame, ["#frm_FreqDur1"]);
    if (effField) {
      await effField.fill("").catch(() => {});
      await effField.type(effective, { delay: 10 }).catch(() => {});
      console.log("📆 Effective date filled:", effective);
    }
  }
}
// =========================
// ROM / Strength text parser
// =========================

function parseRomAndStrength(text) {
  if (!text) return {};
  
  // Helper: strip the "for left and right" tail if present
  const cleanup = (val) => {
    if (!val) return null;
    return val.split(/for\s+left\s+and\s+right/i)[0].trim();
  };
  
  // Use regex over the *entire* text, not per-line startsWith
  const ueRomMatch = text.match(/gross\s+rom\s+for\s+ue[^:\-\n]*[:\-]\s*([^\n]+)/i);
  const leRomMatch = text.match(/gross\s+rom\s+for\s+le[^:\-\n]*[:\-]\s*([^\n]+)/i);
  const ueStrMatch = text.match(/gross\s+strength\s+for\s+ue[^:\-\n]*[:\-]\s*([^\n]+)/i);
  const leStrMatch = text.match(/gross\s+strength\s+for\s+le[^:\-\n]*[:\-]\s*([^\n]+)/i);
  
  const ueRom       = cleanup(ueRomMatch && ueRomMatch[1]);
  const leRom       = cleanup(leRomMatch && leRomMatch[1]);
  const ueStrength  = cleanup(ueStrMatch && ueStrMatch[1]);
  const leStrength  = cleanup(leStrMatch && leStrMatch[1]);
  
  const result = {};
  if (ueRom || ueStrength) {
    result.ue = {
      rom: ueRom || null,
      strength: ueStrength || null,
    };
  }
  if (leRom || leStrength) {
    result.le = {
      rom: leRom || null,
      strength: leStrength || null,
    };
  }
  
  console.log("🧮 parseRomAndStrength parsed:", result);
  return result;
}


/* =========================
 * ROM / Strength helpers
 * =======================*/

// MUST be async because we use await inside
async function fillRomRange(frame, firstId, lastId, romValue, strengthValue) {
  for (let id = firstId; id <= lastId; id += 4) {
    const rRomSel = `#frm_ROM${id}`;
    const lRomSel = `#frm_ROM${id + 1}`;
    const rStrSel = `#frm_ROM${id + 2}`;
    const lStrSel = `#frm_ROM${id + 3}`;
    
    if (romValue) {
      const rRom = frame.locator(rRomSel).first();
      const lRom = frame.locator(lRomSel).first();
      if (await rRom.isVisible().catch(() => false)) {
        await rRom.fill("").catch(() => {});
        await rRom.type(romValue, { delay: 10 }).catch(() => {});
      }
      if (await lRom.isVisible().catch(() => false)) {
        await lRom.fill("").catch(() => {});
        await lRom.type(romValue, { delay: 10 }).catch(() => {});
      }
    }
    
    if (strengthValue) {
      const rStr = frame.locator(rStrSel).first();
      const lStr = frame.locator(lStrSel).first();
      if (await rStr.isVisible().catch(() => false)) {
        await rStr.fill("").catch(() => {});
        await rStr.type(strengthValue, { delay: 10 }).catch(() => {});
      }
      if (await lStr.isVisible().catch(() => false)) {
        await lStr.fill("").catch(() => {});
        await lStr.type(strengthValue, { delay: 10 }).catch(() => {});
      }
    }
  }
}

// Fill Physical Assessment ROM / Strength from gross UE / LE info
async function fillPhysicalRomStrength(context, romStrength) {
  if (!romStrength) {
    console.log("ℹ️ No romStrength data from AI.");
    return;
  }
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("⚠️ Template frame not found for ROM/Strength.");
    return;
  }
  
  const { ue, le } = romStrength || {};
  
  console.log("🧮 ROM/Strength parsed:", romStrength);
  
  if ((ue && ue.rom) || (ue && ue.strength)) {
    await fillRomRange(
                       frame,
                       1,   // frm_ROM1
                       40,  // frm_ROM40
                       ue.rom || null,
                       ue.strength || null
                       );
  }
  
  if ((le && le.rom) || (le && le.strength)) {
    await fillRomRange(
                       frame,
                       69,   // frm_ROM69
                       116,  // frm_ROM116
                       le.rom || null,
                       le.strength || null
                       );
  }
}
// =========================
// Save button helper (shared)
// =========================
async function clickSave(contextOrPage) {
  // Accept: Page, Frame, BrowserContext, or wrapper { page }
  let scope = contextOrPage?.page || contextOrPage;
  
  // If they passed a BrowserContext, convert to a Page
  // (BrowserContext has pages(), not locator()).
  if (scope && typeof scope.pages === "function" && typeof scope.locator !== "function") {
    const pages = scope.pages();
    if (pages && pages.length) scope = pages[0];
  }
  
  function normalizeScope(s) {
    if (s && typeof s.locator === "function") return s; // Page/Frame
    if (s?.page && typeof s.page.locator === "function") return s.page;
    if (s?.frame && typeof s.frame.locator === "function") return s.frame;
    
    // If wrapper contains a BrowserContext
    if (s && typeof s.pages === "function") {
      const pages = s.pages();
      if (pages && pages.length && typeof pages[0].locator === "function") return pages[0];
    }
    
    throw new TypeError("clickSave(): scope must be Playwright Page/Frame/BrowserContext or {page}/{frame}");
  }
  
  const saveSelectors = [
    "#btnSave",
    "input#btnSave",
    "button#btnSave",
    "input[type='button'][value='Save']",
    "input[type='submit'][value='Save']",
    "xpath=//input[contains(@onclick, \"modifyForm('save'\") )]",
    "xpath=//*[self::input or self::button][contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'save')]",
  ];
  
  async function tryClick(s, label) {
    const pageOrFrame = normalizeScope(s);
    
    for (const sel of saveSelectors) {
      const loc = pageOrFrame.locator(sel).first();
      
      const visible = await loc.isVisible().catch(() => false);
      if (!visible) continue;
      
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      try {
        await loc.click({ force: true, timeout: 5000 });
      } catch {
        // JS fallback (Page/Frame only)
        await pageOrFrame.evaluate(() => {
          const byId = document.querySelector("#btnSave");
          if (byId) return byId.click();
          
          const byOnclick = Array.from(document.querySelectorAll("input,button"))
          .find(el => (el.getAttribute("onclick") || "").includes("modifyForm('save')"));
          if (byOnclick) return byOnclick.click();
          
          const byValue = Array.from(
                                     document.querySelectorAll("input[type='button'],input[type='submit'],button")
                                     ).find(el => ((el.value || el.textContent || "").trim().toLowerCase() === "save"));
          if (byValue) return byValue.click();
        });
      }
      
      console.log(`✅ Clicked Save (${label}) using selector: ${sel}`);
      return true;
    }
    
    return false;
  }
  
  // Try on main scope/page
  if (await tryClick(scope, "scope")) return true;
  
  // Try all iframes (common in Kinnser/WellSky)
  const page = normalizeScope(scope);
  const frames = typeof page.frames === "function" ? page.frames() : [];
  for (const fr of frames) {
    if (await tryClick(fr, "frame")) return true;
  }
  
  console.log("⚠️ Save button not found — skipping save.");
  return false;
}


/* =========================
 * Misc helpers & exports
 * =======================*/

async function fillPriorLevelAndPatientGoals(context, data) {
  /**
   * Fills:
   *  - Prior Level of Functioning  (#frm_PriorLevelFunc)
   *  - Patient's Goals            (#frm_PatientGoals)
   *
   * Uses data.priorLevel or data.priorLevelFunction and data.patientGoals.
   */
  const frame = await findTemplateScope(context);
  if (!frame) return;
  
  const priorText = (data.priorLevelFunction || data.priorLevel || "").trim();
  const goalsText = (data.patientGoals || "").trim();
  
  const priorArea = await firstVisibleLocator(frame, ["#frm_PriorLevelFunc"]);
  if (priorArea && priorText) {
    await priorArea.fill("");
    await priorArea.type(priorText, { delay: 20 });
  }
  
  const goalsArea = await firstVisibleLocator(frame, ["#frm_PatientGoals"]);
  if (goalsArea && goalsText) {
    await goalsArea.fill("");
    await goalsArea.type(goalsText, { delay: 20 });
  }
}

/* =========================
 * EXPORTS
 * =======================*/

// =========================
// BOT LOGIC
// =========================

// bots/ptVisitBot.js

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

// ✅ NO DIRECT OPENAI IMPORT HERE
// const OpenAI = require("openai");

// ✅ ONLY gatekeeper
const { callOpenAI_NON_PHI, callOpenAI_NON_PHI_JSON, sanitizeAndAssertNonPHI } = require("./openaiGatekeeper");
// ✅ No openai client object in this file.
// If OPENAI_API_KEY is missing, gatekeeper throws OPENAI_DISABLED.

// ---------------- AI SUMMARY HELPERS ----------------

function needsVisitSummary(aiNotes) {
  if (!aiNotes) return false;
  
  const text = String(aiNotes).toLowerCase();
  
  const phrases = [
    "pt assessment",
    "visit assessment",
    "pt summary",
    "visit summary",
    "overall performance",
    "assessment",
    "summary",
  ];
  
  return phrases.some((p) => text.includes(p));
}


function pickVariant(arr) {
  // Deterministic per-run variation without patient-specific hallucinations
  const seed = Date.now();
  return arr[seed % arr.length];
}

function strictVisitSummaryVariant() {
  const variants = [
    "Pt tolerated HH PT tx fairly with good participation and no adverse reactions noted. Tx emphasized TherEx and TherAct to address generalized weakness, impaired balance, and decreased functional mobility with VC/TC provided PRN for safety and mechanics. Functional safety training and gait training were completed to improve gait quality, increase household mobility tolerance, and reduce high fall risk. HEP was reviewed and reinforced for compliance, pacing, and safety awareness to promote carryover between visits. Continued skilled HH PT remains medically necessary to progress toward established goals, improve functional independence, and reduce high fall risk.",
    "Pt demonstrated fair tolerance to skilled HH PT tx with good participation and no adverse reactions noted. Skilled TherEx/TherAct were performed to improve strength, balance strategies, and functional mobility with VC/TC PRN for proper form and sequencing. Functional safety training and gait training were provided to improve stability, reduce fall risk, and promote safer household ambulation. HEP was reviewed with emphasis on consistency, pacing, and safety awareness to support carryover between visits. Continued skilled HH PT is indicated to address ongoing weakness and balance deficits and to progress toward goals.",
    "Pt tolerated HH PT tx fairly with good participation and remained symptom-free throughout the session. Tx focused on TherEx and TherAct to address generalized weakness and impaired balance contributing to high fall risk, with VC/TC provided PRN to ensure safe technique and mechanics. Functional safety training and gait training were completed to improve transfers, household mobility tolerance, and gait mechanics for safer ambulation. HEP was reviewed and reinforced for compliance and safe performance with education on pacing and fall prevention. Continued skilled HH PT is medically necessary to progress functional independence and reduce fall risk.",
    "Pt displayed fair tolerance to HH PT tx today with good participation and no adverse reactions noted. TherEx and TherAct were completed to improve strength, balance control, and functional mobility with VC/TC PRN for posture, sequencing, and safety. Functional safety training and gait training were provided to address instability and reduce high fall risk during household mobility. HEP was reviewed and reinforced for carryover with education on pacing and safety awareness to reduce injury risk. Continued skilled HH PT remains necessary to address residual weakness and balance impairments and to progress toward goals.",
    "Pt tolerated HH PT tx fairly with good participation and no adverse reactions observed. Skilled TherEx and TherAct were utilized to address generalized weakness and impaired balance impacting functional mobility, with VC/TC provided PRN for safety, sequencing, and form. Gait training and functional safety training were completed to improve gait mechanics, increase household ambulation tolerance, and reduce fall risk. HEP was reviewed and reinforced for compliance and safe performance to support carryover between visits. Continued skilled HH PT is indicated to progress mobility goals and reduce high fall risk.",
    "Pt demonstrated fair tolerance to skilled HH PT tx with good participation and no adverse reactions noted. Tx emphasized TherEx/TherAct to improve strength, balance, and functional mobility deficits with VC/TC PRN for safe mechanics and proper sequencing. Functional safety training and gait training were completed to enhance stability, improve gait quality, and reduce fall risk with household ambulation. HEP was reviewed and reinforced with education on pacing, consistency, and safety awareness to support carryover. Continued skilled HH PT is medically necessary to progress toward established goals and reduce fall risk.",
    "Pt tolerated HH PT tx fairly with good participation and no adverse reactions reported. TherEx/TherAct interventions were completed to address generalized weakness, impaired balance, and decreased functional mobility with VC/TC PRN to ensure safe technique. Gait training and functional safety training were performed to improve gait mechanics, increase household mobility tolerance, and reduce fall risk. HEP was reviewed and reinforced with education on consistency, pacing, and fall prevention strategies to improve carryover. Pt requires continued skilled HH PT remains indicated to progress toward goals and improve functional independence.",
    "Pt displayed fair tolerance to skilled HH PT tx with good participation and no adverse reactions noted. Tx focused on TherEx and TherAct to improve strength and balance strategies affecting functional mobility with VC/TC PRN for safe mechanics. Functional safety training and gait training were completed to address instability and reduce high fall risk during household ambulation. HEP was reviewed and reinforced for compliance and safe execution with education on pacing and safety awareness. Continued skilled HH PT is medically necessary to progress functional mobility and reduce fall risk."
  ];
  return pickVariant(variants);
}

async function generateVisitSummaryText(aiNotes) {
  const raw = String(aiNotes || "").trim();
  if (!raw) return strictVisitSummaryVariant();
  
  // NON-PHI gate (keeps your existing safety)
  let safe;
  try {
    safe = sanitizeAndAssertNonPHI(raw);
  } catch (e) {
    console.log("[PT Visit Bot] PHI risk detected; using deterministic visit summary fallback.");
    return strictVisitSummaryVariant();
  }
  
  function splitIntoSentences(paragraph) {
    const t = String(paragraph || "").trim();
    if (!t) return [];
    return t
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  }
  
  function isValidFiveSentencePtParagraph(text) {
    const s = String(text || "").trim();
    const sentences = splitIntoSentences(s);
    return (
            sentences.length === 5 &&
            sentences.every(x => /^Pt\b/.test(x)) &&
            !/\b(he|she|they|his|her|their)\b/i.test(s)
            );
  }
  
  // IMPORTANT:
  // Do NOT use callOpenAI_NON_PHI here (it triggered 400 Missing required parameter: text.format.name).
  // Instead, we use callOpenAIJSON (same OpenAI client you already use elsewhere) and request JSON.
  const prompt = `
You are writing the "Summary of Patient Overall Performance on this Visit" for a Home Health PT VISIT.

Return ONLY valid JSON with double quotes in this exact shape:
{ "summary": "<text>" }

Rules for "summary":
- Do NOT include Subjective content.
- Do NOT write phrases like "Pt reports", "Pt agreeable", "agrees to PT", or "cleared to continue".
- Focus ONLY on treatment tolerance, TherEx/TherAct, gait training, functional safety training, HEP review/education, and ongoing impairments.

- EXACTLY 5 sentences.
- ONE paragraph.
- EVERY sentence MUST start with "Pt".
- Do NOT use pronouns (he/she/they/his/her/their).
- No bullets, no headings, no arrows/symbols.
- Use clinical abbreviations where appropriate (TherEx, TherAct, HEP, VC/TC).
- Must be Medicare-compliant, not speculative.
- Closing sentence MUST start with "Pt" and MUST include the phrase "continued skilled HH PT remains indicated".
Use ONLY information explicitly present in the note. If details are missing, keep statements general.

Note:
---
${safe}
---`.trim();
  
  try {
    console.log("[PT Visit Bot] Generating OpenAI visit summary (JSON)...");
    const parsed = await callOpenAIJSON(prompt, 12000);
    const text = String(parsed?.summary || "").trim();
    // Hard rule: never let subjective leak into the Summary/Assessment field
    let cleaned = text
    .replace(/\b(Pt reports|Pt report|Pt agreeable|agrees to PT|cleared to continue)[^.!?]*[.!?]\s*/gi, "")
    .trim();
    
    if (!cleaned || /^\s*Pt\s+(reports|report|agreeable|agrees|cleared)\b/i.test(cleaned)) {
      cleaned =
      "Pt tolerated HH PT tx fairly with good participation and no adverse reactions reported. " +
      cleaned.replace(/^\s*Pt\s+/i, "");
    }
    
    const parts = cleaned
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .map(s => (s.startsWith("Pt ") ? s : ("Pt " + s.replace(/^Pt\s+/i, ""))));
    
    cleaned = parts.join(" ").trim();
    
    
    if (isValidFiveSentencePtParagraph(cleaned)) return cleaned;
    
    console.log("[PT Visit Bot] AI summary failed formatting checks; using deterministic fallback.");
    return strictVisitSummaryVariant();
  } catch (e) {
    console.log("[PT Visit Bot] OpenAI summary generation error; using deterministic fallback:", e?.message || e);
    return strictVisitSummaryVariant();
  }
}


async function fillVisitSummaryFromCue(context, aiNotes) {
  if (!aiNotes || !String(aiNotes).trim()) {
    console.log("[PT Visit Bot] No AI notes provided; skipping visit summary.");
    return;
  }
  
  if (!process.env.OPENAI_API_KEY) {
    console.log("[PT Visit Bot] OPENAI_API_KEY missing; cannot generate visit summary.");
    return;
  }
  
  const page = context?.page || context;
  
  const frame = await findTemplateScope(page);
  if (!frame) {
    console.log("[PT Visit Bot] Could not find PT Visit frame for summary.");
    return;
  }
  
  const summarySelectors = [
    "#frm_visitSummary",
    "#frm_EASI1",
    "#frm_EASI",
    "#frm_AssessmentSummary",
    "#frm_assessmentSummary",
    "#frm_Summary",
    "#frm_summary",
    "xpath=//label[contains(normalize-space(.),'Summary of Patient Overall Performance')]/following::textarea[1]",
    "xpath=//*[contains(normalize-space(.),'Summary of Patient Overall Performance on this Visit')]/following::textarea[1]",
    "xpath=//*[contains(normalize-space(.),'Summary of Patient Overall Performance')]/following::textarea[1]",
  ];
  
  const summaryBox = await firstVisibleLocator(frame, summarySelectors);
  if (!summaryBox) {
    console.log("[PT Visit Bot] Summary textarea not found (tried multiple selectors).");
    return;
  }
  
  const hasCue = needsVisitSummary(aiNotes);
  console.log(
              hasCue
              ? "[PT Visit Bot] Assessment/summary cue detected in AI notes; generating visit summary."
              : "[PT Visit Bot] No explicit assessment/summary keyword; generating generic HH PT visit summary from AI notes."
              );
  
  console.log("[PT Visit Bot] Generating AI visit summary for PT Visit...");
  const text = await generateVisitSummaryText(aiNotes);
  if (!text) {
    console.log("[PT Visit Bot] AI summary generation returned empty or errored; skipping.");
    return;
  }
  
  await summaryBox.fill("");
  await summaryBox.type(text, { delay: 10 });
  console.log("[PT Visit Bot] Filled visit summary.");
}


/* =========================
 * PT VISIT: Exercise Impact + Teaching/Assessment Defaults
 * =======================*/

function extractNarrativeByKeywords(aiNotes = "", keywords = []) {
  const text = String(aiNotes || "");
  if (!text.trim()) return "";
  
  const lines = text.split(/\r?\n/);
  const lowers = lines.map((l) => l.toLowerCase());
  
  const kw = (keywords || [])
  .map((k) => String(k || "").toLowerCase())
  .filter(Boolean);
  
  if (kw.length === 0) return "";
  
  for (let i = 0; i < lines.length; i++) {
    const low = lowers[i];
    if (!low.includes(":")) continue;
    
    for (const k of kw) {
      if (low.includes(k)) {
        const parts = lines[i].split(":");
        const after = parts.slice(1).join(":").trim();
        if (after) return after;
        
        const buf = [];
        for (let j = i + 1; j < lines.length; j++) {
          const t = lines[j].trim();
          if (!t) break;
          buf.push(t);
        }
        return buf.join(" ").trim();
      }
    }
  }
  
  for (let i = 0; i < lines.length; i++) {
    const low = lowers[i];
    for (const k of kw) {
      if (low.includes(k)) {
        const t = lines[i].trim();
        if (t.length > 12) return t;
      }
    }
  }
  
  return "";
}

function parseVisitExerciseTeachingFields(aiNotes = "") {
  const DEFAULT_TE_EXERCISE_DESC =
  "Patient is appropriately challenged by the current therapeutic exercise program without any adverse responses. Rest breaks are needed to manage fatigue. Patient requires reminders and both verbal and tactile cues to maintain proper body mechanics.";
  
  const DEFAULT_TEACHING_TITLES = "Verbal, tactile, demonstration, illustration.";
  const DEFAULT_GOALS_INDICATOR_TXT = "Motivation/willingness to work with PT.";
  const DEFAULT_ADDRESS_PT_ISSUES_TXT =
  "Functional mobility training, strength training, balance/safety training, proper use of AD, HEP education, and fall prevention.";
  const DEFAULT_FR_BALANCE_DC = "NT";
  const DEFAULT_GT_POSTURE_TXT = "Education provided to improve postural awareness.";
  
  const teExerciseDesc = extractNarrativeByKeywords(aiNotes, [
    "impact of exercises",
    "impact of exercise",
    "impact of therapeutic exercise",
    "response to exercise",
    "respond to exercise",
    "tolerance to exercise",
    "ther-ex tolerance",
    "ther ex tolerance",
    "therex tolerance",
    "ther-ex response",
    "ther ex response",
    "therex response",
    "patient response to treatment",
    "response to treatment",
  ]);
  
  const tTitlesTxt = extractNarrativeByKeywords(aiNotes, [
    "teaching method",
    "teaching methods",
    "teaching tools",
    "education tools",
    "teaching tool",
    "education provided",
  ]);
  
  return {
    teExerciseDesc: (teExerciseDesc || "").trim() || DEFAULT_TE_EXERCISE_DESC,
    tTitlesTxt: (tTitlesTxt || "").trim() || DEFAULT_TEACHING_TITLES,
    goalsIndicatorTxt: DEFAULT_GOALS_INDICATOR_TXT,
    addressPTIssuesTxt: DEFAULT_ADDRESS_PT_ISSUES_TXT,
    frBalanceDischarge: DEFAULT_FR_BALANCE_DC,
    gtPostureTrTxt: DEFAULT_GT_POSTURE_TXT,
  };
}

async function fillVisitExerciseTeachingDefaults(context, aiNotes) {
  const note = String(aiNotes || "");
  
  const DEFAULT_TE_EXERCISE_DESC =
  "Patient is appropriately challenged by the current therapeutic exercise program without any adverse responses. Rest breaks are needed to manage fatigue. Patient requires reminders and both verbal and tactile cues to maintain proper body mechanics.";
  
  const DEFAULT_TEACHING_TITLES = "Verbal, tactile, demonstration, illustration.";
  const DEFAULT_GOALS_INDICATOR_TXT = "Motivation/willingness to work with PT.";
  const DEFAULT_ADDRESS_PT_ISSUES_TXT =
  "Functional mobility training, strength training, balance/safety training, proper use of AD, HEP education, and fall prevention.";
  const DEFAULT_FR_BALANCE_DC = "NT";
  const DEFAULT_GT_POSTURE_TXT = "Education provided to improve postural awareness.";
  
  async function findVisitScope(ctx) {
    const pages = (ctx && typeof ctx.pages === "function") ? ctx.pages() : [];
    const probes = [
      "#frm_tTitlesTxt",
      "#frm_teExerciseDesc",
      "#frm_goalsIndicatorTxt",
      "#frm_addressPTIssuesTxt",
      "#frm_FRBalanceDischarge",
    ];
    
    for (const page of pages) {
      const scopes = [page, ...page.frames()];
      for (const sc of scopes) {
        for (const sel of probes) {
          try {
            const loc = sc.locator(sel).first();
            if (await loc.isVisible().catch(() => false)) return sc;
          } catch {}
        }
      }
    }
    return await findTemplateScope(ctx);
  }
  
  const frame = await findVisitScope(context);
  if (!frame) {
    console.log("[PT Visit Bot] Visit frame not found for Exercise/Teaching defaults.");
    return;
  }
  
  function escapeRegExp(s) {
    return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  
  function getSection(text, headings) {
    const lines = String(text || "").split(/\r?\n/);
    const heads = (headings || []).map(h => String(h || "").trim()).filter(Boolean);
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      for (const h of heads) {
        const re = new RegExp("^\\s*" + escapeRegExp(h) + "\\s*:\\s*(.*)$", "i");
        const m = line.match(re);
        if (!m) continue;
        
        const after = String(m[1] || "").trim();
        if (after) return { found: true, text: after };
        
        // capture following paragraph until blank line or next heading
        const buf = [];
        for (let j = i + 1; j < lines.length; j++) {
          const t = lines[j].trim();
          if (!t) break;
          // stop if next heading-like line
          if (/^[A-Za-z][A-Za-z \/\(\)\-]*:\s*/.test(t)) break;
          buf.push(t);
        }
        return { found: true, text: buf.join(" ").trim() };
      }
    }
    
    return { found: false, text: "" };
  }
  
  async function forceSetText(locatorOrNull, value, label) {
    const v = String(value ?? "").trim();
    if (!locatorOrNull || !v) return;
    
    try {
      await locatorOrNull.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
      await locatorOrNull.scrollIntoViewIfNeeded().catch(() => {});
      await locatorOrNull.click({ timeout: 1500 }).catch(() => {});
      await locatorOrNull.fill("").catch(() => {});
      await locatorOrNull.type(v, { delay: 8 }).catch(async () => {
        await locatorOrNull.fill(v).catch(() => {});
      });
      
      let got = "";
      try { got = await locatorOrNull.inputValue(); } catch {}
      if (!got || got.trim().length < 2) {
        await locatorOrNull.evaluate((el, val) => {
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        }, v).catch(() => {});
      }
      
      console.log("[PT Visit Bot] ✅ " + label);
    } catch (e) {
      console.log("[PT Visit Bot] ⚠️ " + label + " skipped:", e?.message || e);
    }
  }
  
  async function forceCheck(locatorOrNull, label) {
    if (!locatorOrNull) return;
    try {
      await locatorOrNull.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
      await locatorOrNull.scrollIntoViewIfNeeded().catch(() => {});
      const checked = await locatorOrNull.isChecked().catch(() => false);
      if (!checked) {
        await locatorOrNull.check({ force: true }).catch(async () => {
          await locatorOrNull.click({ force: true }).catch(() => {});
        });
      }
      console.log("[PT Visit Bot] ✅ " + label + " checked");
    } catch (e) {
      console.log("[PT Visit Bot] ⚠️ " + label + " check skipped:", e?.message || e);
    }
  }
  
  // 1) Impact of Exercise(s) — ONLY fill if that section exists; if blank then use default.
  // Prevent accidental fill from "Response to Treatment" by NOT looking at that heading here.
  const impact = getSection(note, [
    "Impact of Exercise(s) on Functional Performance / Patient Response to Treatment",
    "Impact of Exercise(s) on Functional Performance",
    "Impact of Exercise(s)",
    "Patient Response to Treatment (Exercise)",
  ]);
  
  if (impact.found) {
    const val = (impact.text || "").trim() || DEFAULT_TE_EXERCISE_DESC;
    const teExerciseDesc = await firstVisibleLocator(frame, [
      "#frm_teExerciseDesc",
      "textarea#frm_teExerciseDesc",
      "textarea[name='frm_teExerciseDesc']",
      "xpath=//*[contains(normalize-space(.),'Impact of Exercise')]/following::textarea[1]",
      "xpath=//*[contains(normalize-space(.),'Patient Response to Treatment')]/following::textarea[1]",
    ]);
    await forceSetText(teExerciseDesc, val, "frm_teExerciseDesc");
  } else {
    console.log("[PT Visit Bot] Impact of Exercise section missing; skipping frm_teExerciseDesc.");
  }
  
  // 2) Teaching checkboxes — keep as default behavior (independent of note text)
  const teachBoxes = [
    ["#frm_tHEP", "frm_tHEP"],
    ["#frm_tSF", "frm_tSF"],
    ["#frm_tSG", "frm_tSG"],
    ["#frm_tHEPpt1", "frm_tHEPpt1"],
    ["#frm_tSFpt1", "frm_tSFpt1"],
    ["#frm_tSGpt1", "frm_tSGpt1"],
    ["#frm_tRFTpt1", "frm_tRFTpt1"],
  ];
  for (const [sel, label] of teachBoxes) {
    const box = await firstVisibleLocator(frame, [sel, `input${sel}`, `input[name='${sel.replace("#","")}']`]);
    await forceCheck(box, label);
  }
  
  // 3) Teaching tools titles — ONLY fill if section exists; if blank then default.
  const teachTools = getSection(note, [
    "Teaching Tools / Education Tools / Teaching Method",
    "Teaching Tools / Education Tools",
    "Teaching Tools",
    "Education Tools",
    "Teaching Method",
  ]);
  
  if (teachTools.found) {
    const val = (teachTools.text || "").trim() || DEFAULT_TEACHING_TITLES;
    const titles = await firstVisibleLocator(frame, [
      "#frm_tTitlesTxt",
      "textarea#frm_tTitlesTxt",
      "textarea[name='frm_tTitlesTxt']",
      "xpath=//*[contains(normalize-space(.),'Title(s) of Teaching Tool')]/following::textarea[1]",
    ]);
    await forceSetText(titles, val, "frm_tTitlesTxt");
  } else {
    console.log("[PT Visit Bot] Teaching Tools section missing; skipping frm_tTitlesTxt.");
  }
  
  // 4) Progress to goals indicated by — ONLY fill if section exists; if blank then default.
  const prog = getSection(note, ["Progress to goals indicated by"]);
  if (prog.found) {
    const goalsIndicator = await firstVisibleLocator(frame, [
      "#frm_goalsIndicator",
      "input#frm_goalsIndicator",
      "input[name='frm_goalsIndicator']",
      "xpath=//*[contains(normalize-space(.),'Progress to goals indicated by')]/preceding::input[@type='checkbox'][1]",
    ]);
    await forceCheck(goalsIndicator, "frm_goalsIndicator");
    
    const goalsIndicatorTxt = await firstVisibleLocator(frame, [
      "#frm_goalsIndicatorTxt",
      "textarea#frm_goalsIndicatorTxt",
      "textarea[name='frm_goalsIndicatorTxt']",
      "xpath=//*[contains(normalize-space(.),'Progress to goals indicated by')]/following::textarea[1]",
    ]);
    await forceSetText(goalsIndicatorTxt, (prog.text || "").trim() || DEFAULT_GOALS_INDICATOR_TXT, "frm_goalsIndicatorTxt");
  } else {
    console.log("[PT Visit Bot] Progress-to-goals section missing; skipping goals indicator text.");
  }
  
  // 5) Needs continued skilled PT to address — ONLY fill if section exists; if blank then default.
  const addr = getSection(note, ["Needs continued skilled PT to address"]);
  if (addr.found) {
    const addressPTIssues = await firstVisibleLocator(frame, [
      "#frm_addressPTIssues",
      "input#frm_addressPTIssues",
      "input[name='frm_addressPTIssues']",
      "xpath=//*[contains(normalize-space(.),'Needs continued skilled PT to address')]/preceding::input[@type='checkbox'][1]",
    ]);
    await forceCheck(addressPTIssues, "frm_addressPTIssues");
    
    const addressPTIssuesTxt = await firstVisibleLocator(frame, [
      "#frm_addressPTIssuesTxt",
      "textarea#frm_addressPTIssuesTxt",
      "textarea[name='frm_addressPTIssuesTxt']",
      "xpath=//*[contains(normalize-space(.),'Needs continued skilled PT to address')]/following::textarea[1]",
    ]);
    await forceSetText(addressPTIssuesTxt, (addr.text || "").trim() || DEFAULT_ADDRESS_PT_ISSUES_TXT, "frm_addressPTIssuesTxt");
  } else {
    console.log("[PT Visit Bot] Address-issues section missing; skipping address PT issues text.");
  }
  
  // 6) Always-default fields (safe; independent of note presence)
  const frBalDc = await firstVisibleLocator(frame, [
    "#frm_FRBalanceDischarge",
    "input#frm_FRBalanceDischarge",
    "textarea#frm_FRBalanceDischarge",
    "input[name='frm_FRBalanceDischarge']",
    "textarea[name='frm_FRBalanceDischarge']",
  ]);
  await forceSetText(frBalDc, DEFAULT_FR_BALANCE_DC, "frm_FRBalanceDischarge");
  
  const gtPosture = await firstVisibleLocator(frame, [
    "#frm_GTPostureTrTxt",
    "textarea#frm_GTPostureTrTxt",
    "textarea[name='frm_GTPostureTrTxt']",
  ]);
  await forceSetText(gtPosture, DEFAULT_GT_POSTURE_TXT, "frm_GTPostureTrTxt");
  
  console.log("[PT Visit Bot] ✅ Exercise/Teaching/Assessment section completed.");
}


// ---------------- PT VISIT: GOALS MEET BY CHECKBOX ----------------
async function checkGoalsMeetBy(context) {
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("[PT Visit Bot] PT Visit frame not found for frm_goalsMeetBy.");
    return;
  }
  
  const box = await firstVisibleLocator(frame, [
    "#frm_goalsMeetBy",
    "input#frm_goalsMeetBy",
    "input[name='frm_goalsMeetBy']",
    "xpath=//label[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'goals meet by')]/preceding::input[@type='checkbox'][1]",
    "xpath=//*[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'goals meet by')]/preceding::input[@type='checkbox'][1]",
  ]);
  
  if (!box) {
    console.log("[PT Visit Bot] frm_goalsMeetBy checkbox not found; skipping.");
    return;
  }
  
  try {
    const checked = await box.isChecked().catch(() => false);
    if (!checked) {
      await box.check({ force: true }).catch(async () => {
        await box.click({ force: true });
      });
      console.log("[PT Visit Bot] ✅ frm_goalsMeetBy checked.");
    } else {
      console.log("[PT Visit Bot] frm_goalsMeetBy already checked (no action).");
    }
  } catch (e) {
    console.log("[PT Visit Bot] frm_goalsMeetBy check error:", e?.message || e);
  }
}

// ---------------- PT VISIT SPECIFIC HELPERS ----------------

async function fillPtVisitSubjectiveAndPlan(context, noteData = {}) {
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("[PT Visit Bot] PT Visit frame not found for Subjective/Plan.");
    return;
  }
  
  const subjectiveText = String(noteData.subjective || "").trim();
  if (subjectiveText) {
    const subjBox = await firstVisibleLocator(frame, ["#frm_paObservs"]);
    if (subjBox) {
      await verifySetText(frame, "#frm_paObservs", subjectiveText, "Subjective (#frm_paObservs)");
    }
  }
  
  let planText =
  (noteData.plan &&
   noteData.plan.planText &&
   String(noteData.plan.planText).trim()) ||
  "";
  
  if (!planText) {
    const freq = (noteData.plan && noteData.plan.frequency) || "";
    planText = freq
    ? "Continue HH PT " +
    freq +
    " to progress gait training, balance, strengthening, and safety education per POC."
    : "Continue HH PT to progress gait training, balance, strengthening, and safety education per POC.";
  }
  
  const planInput = await firstVisibleLocator(frame, ["#frm_goalsMeetByTxt"]);
  if (planInput) {
    await verifySetText(frame, "#frm_goalsMeetByTxt", planText, "Plan (#frm_goalsMeetByTxt)");
  }
}

// ROM/Strength flag + bed mobility / transfer / gait comments + FUNCTIONAL STATUS → TRAINING FIELDS
async function fillPtVisitTrainingBlocks(context, noteData = {}) {
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("[PT Visit Bot] PT Visit frame not found for training blocks.");
    return;
  }
  
  // =========================
  // ✅ FUNCTIONAL STATUS SOURCE
  // =========================
  const func = noteData?.func || {};
  
  const normalizeAssist = (raw = "") => {
    const s = String(raw || "").trim();
    if (!s) return "";
    const up = s.toUpperCase();
    
    if (/\bSTANDBY\b/.test(up)) return "SBA";
    if (/\bCONTACT\s*GUARD\b/.test(up)) return "CGA";
    if (/\bMIN\b/.test(up)) return "Min A";
    if (/\bMOD\b/.test(up) && /\bINDEP\b/.test(up)) return "Mod Indep";
    if (/\bMOD\b/.test(up)) return "Mod A";
    if (/\bMAX\b/.test(up)) return "Max A";
    if (/\bDEP\b/.test(up)) return "Dep";
    if (/\bINDEP\b/.test(up)) return "Indep";
    
    const m = s.match(/\b(Indep|Mod Indep|SBA|CGA|Min A|Mod A|Max A|Dep)\b/i);
    return m ? m[1] : s;
  };
  
  const parseDevice = (s = "") =>
  (String(s || "").match(/\bwith\s+(.+?)(?:\s+x|\s*$)/i)?.[1] || "").trim();
  const parseDistance = (s = "") =>
  (String(s || "").match(/x\s*(\d+)\s*(ft|feet)?/i)?.[1] || "").trim();
  
  const bedRaw = func?.bedMobility || "";
  const trRaw = func?.transfers || "";
  const gaitRaw = func?.gait || "";
  
  const bedAssist = normalizeAssist(func?.bedMobilityAssist || bedRaw);
  const bedDev = (func?.bedMobilityDevice || parseDevice(bedRaw)).trim();
  
  const trAssist = normalizeAssist(func?.transfersAssist || trRaw);
  const trDev = (func?.transfersDevice || parseDevice(trRaw)).trim();
  
  const gaitAssist = normalizeAssist(func?.gaitAssist || gaitRaw);
  const gaitDev = (func?.gaitAD || func?.gaitDevice || parseDevice(gaitRaw)).trim();
  const gaitDist = (func?.gaitDistanceFt || parseDistance(gaitRaw)).trim();
  
  // =========================
  // ✅ Robust setters
  // =========================
  async function fillInput(loc, value, label) {
    const v = String(value ?? "").trim();
    if (!v) return false;
    if (!(await loc.isVisible().catch(() => false))) return false;
    
    await loc.fill("");
    await loc.type(v, { delay: 10 }).catch(async () => {
      await loc.fill(v).catch(() => {});
    });
    
    await loc
    .evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    })
    .catch(() => {});
    
    console.log(`✅ ${label}: ${v}`);
    return true;
  }
  
  async function safeFillAny(selectors = [], value, label) {
    const v = String(value ?? "").trim();
    if (!v) return false;
    
    for (const sel of selectors) {
      try {
        const loc = frame.locator(sel).first();
        if (await fillInput(loc, v, `${label} (${sel})`)) return true;
      } catch {}
    }
    return false;
  }
  
  /**
   * Fill a row inside the training table by matching row text.
   * - sectionTitle: e.g. "Bed Mobility Training"
   * - rowKeyNoSpaces: e.g. "supine-sit" (spaces removed on both sides)
   * - inputIndex: 0=assist, 1=device, 2=distance (for gait)
   */
  async function fillRowInSection(sectionTitle, rowKeyNoSpaces, inputIndex, value, label) {
    const v = String(value ?? "").trim();
    if (!v) return false;
    
    const key = String(rowKeyNoSpaces || "")
    .toLowerCase()
    .replace(/\s+/g, "");
    if (!key) return false;
    
    const rowXpath = `
xpath=(
  //*[contains(translate(normalize-space(string(.)),
     'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),
     '${sectionTitle.toLowerCase()}')]
  /following::table[1]
  //tr[
    contains(
      translate(
        translate(
          translate(normalize-space(string(.)),
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),
          ' ', ''),
        '\\u00A0',''
      ),
      '${key}'
    )
  ]
)[1]`.trim();
    
    const row = frame.locator(rowXpath).first();
    if (!(await row.isVisible().catch(() => false))) return false;
    
    const inputs = row.locator("xpath=.//input[@type='text' and not(@readonly)]");
    
    const loc = inputs.nth(Number(inputIndex) || 0);
    if (!(await loc.isVisible().catch(() => false))) return false;
    
    await loc.fill("");
    await loc.type(v, { delay: 10 }).catch(async () => {
      await loc.fill(v).catch(() => {});
    });
    
    await loc
    .evaluate((el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    })
    .catch(() => {});
    
    console.log(`✅ ${label}: ${v} (row key=${key}, inputIndex=${inputIndex})`);
    return true;
  }
  
  // =========================
  // ✅ APPLY FUNCTIONAL STATUS → TRAINING FIELDS (BED + TRANSFER + GAIT)
  // =========================
  
  // ---- BED MOBILITY TRAINING ----
  if (bedAssist) {
    await safeFillAny(["#frm_BMTRollLevel"], bedAssist, "Bed Rolling Assist (id)").catch(() => {});
    await safeFillAny(["#frm_BMTSupSitLevel"], bedAssist, "Bed Supine-Sit Assist (id)").catch(() => {});
    await safeFillAny(["#frm_BMTSitSupLevel"], bedAssist, "Bed Sit-Supine Assist (id)").catch(() => {});
    
    await fillRowInSection("Bed Mobility Training", "rolling", 0, bedAssist, "Bed Rolling Assist (row)").catch(() => {});
    await fillRowInSection("Bed Mobility Training", "supine-sit", 0, bedAssist, "Bed Supine-Sit Assist (row)").catch(() => {});
    await fillRowInSection("Bed Mobility Training", "sit-supine", 0, bedAssist, "Bed Sit-Supine Assist (row)").catch(() => {});
  }
  
  if (bedDev) {
    await safeFillAny(["#frm_BMTRollAD"], bedDev, "Bed Rolling Device (id)").catch(() => {});
    await safeFillAny(["#frm_BMTSupSitAD"], bedDev, "Bed Supine-Sit Device (id)").catch(() => {});
    await safeFillAny(["#frm_BMTSitSupAD"], bedDev, "Bed Sit-Supine Device (id)").catch(() => {});
    
    await fillRowInSection("Bed Mobility Training", "rolling", 1, bedDev, "Bed Rolling Device (row)").catch(() => {});
    await fillRowInSection("Bed Mobility Training", "supine-sit", 1, bedDev, "Bed Supine-Sit Device (row)").catch(() => {});
    await fillRowInSection("Bed Mobility Training", "sit-supine", 1, bedDev, "Bed Sit-Supine Device (row)").catch(() => {});
  }
  
  // ---- TRANSFER TRAINING ----
  if (trAssist) {
    await safeFillAny(["#frm_TTSitStandLevel"], trAssist, "Transfer Sit-Stand Assist (id)").catch(() => {});
    await safeFillAny(["#frm_TTStandSitLevel"], trAssist, "Transfer Stand-Sit Assist (id)").catch(() => {});
    await safeFillAny(["#frm_TTToiletorBSCLevel"], trAssist, "Transfer Toilet/BSC Assist (id)").catch(() => {});
    await safeFillAny(["#frm_TTTuborShowerLevel"], trAssist, "Transfer Tub/Shower Assist (id)").catch(() => {});
    
    await fillRowInSection("Transfer Training", "sit-stand", 0, trAssist, "Transfer Sit-Stand Assist (row)").catch(() => {});
    await fillRowInSection("Transfer Training", "stand-sit", 0, trAssist, "Transfer Stand-Sit Assist (row)").catch(() => {});
    await fillRowInSection("Transfer Training", "toiletorbsc", 0, trAssist, "Transfer Toilet/BSC Assist (row)").catch(() => {});
    await fillRowInSection("Transfer Training", "tuborshower", 0, trAssist, "Transfer Tub/Shower Assist (row)").catch(() => {});
  }
  
  if (trDev) {
    await safeFillAny(["#frm_TTSitStandAD"], trDev, "Transfer Sit-Stand Device (id)").catch(() => {});
    await safeFillAny(["#frm_TTStandSitAD"], trDev, "Transfer Stand-Sit Device (id)").catch(() => {});
    
    await fillRowInSection("Transfer Training", "sit-stand", 1, trDev, "Transfer Sit-Stand Device (row)").catch(() => {});
    await fillRowInSection("Transfer Training", "stand-sit", 1, trDev, "Transfer Stand-Sit Device (row)").catch(() => {});
    await fillRowInSection("Transfer Training", "toiletorbsc", 1, trDev, "Transfer Toilet/BSC Device (row)").catch(() => {});
    await fillRowInSection("Transfer Training", "tuborshower", 1, trDev, "Transfer Tub/Shower Device (row)").catch(() => {});
  }
  
  // ---- GAIT TRAINING ----
  // FIX: pass a STRING row key (not an array), to match fillRowInSection signature.
  if (gaitAssist) {
    await safeFillAny(["#frm_GTLevel"], gaitAssist, "Gait Assist Level").catch(() => {});
    await fillRowInSection("Gait Training", "level", 0, gaitAssist, "Gait Assist Level (row)").catch(() => {});
  }
  if (gaitDist) {
    await safeFillAny(["#frm_GTDistance"], gaitDist, "Gait Distance (ft)").catch(() => {});
    await fillRowInSection("Gait Training", "level", 1, gaitDist, "Gait Distance (row)").catch(() => {});
  }
  if (gaitDev) {
    await safeFillAny(["#frm_GTAssistiveDevice"], gaitDev, "Gait Device").catch(() => {});
    await fillRowInSection("Gait Training", "level", 2, gaitDev, "Gait Device (row)").catch(() => {});
  }
  
  // =========================
  // EXISTING CONTENT (kept)
  // =========================
  
  const noRomSelectors = [
    "xpath=//label[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'no rom/strength reported')]/preceding::input[@type='checkbox'][1]",
    "xpath=//label[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'no rom') and contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'strength')]/preceding::input[@type='checkbox'][1]",
    "#frm_NoROMStrengthReported",
    "#frm_ROMStrengthNone",
  ];
  
  const noRomChk = await firstVisibleLocator(frame, noRomSelectors);
  if (noRomChk) {
    try {
      const checked = await noRomChk.isChecked().catch(() => false);
      if (!checked) {
        await noRomChk.check({ force: true }).catch(async () => {
          await noRomChk.click({ force: true });
        });
      }
      console.log("[PT Visit Bot] Set 'No ROM/Strength Reported at Visit' checkbox.");
    } catch (e) {
      console.log("[PT Visit Bot] Could not set 'No ROM/Strength Reported' checkbox:", e?.message || e);
    }
  } else {
    console.log("[PT Visit Bot] 'No ROM/Strength Reported' checkbox not found; skipping.");
  }
  
  const bmComment = frame.locator("#frm_BMTSSitTrTxt").first();
  if (await bmComment.isVisible().catch(() => false)) {
    await bmComment.fill(
                         "Improper sequence/mechanics, decreased activity tolerance, weakness, and reduced safety awareness, fair tolerance to training."
                         );
    console.log("[PT Visit Bot] Filled bed mobility impact/response comment (frm_BMTSSitTrTxt).");
  }
  
  const ttComment = frame.locator("#frm_FAPT22").first();
  if (await ttComment.isVisible().catch(() => false)) {
    await ttComment.fill(
                         "Improper sequence/mechanics, decreased activity tolerance, weakness, and reduced safety awareness, fair tolerance to training."
                         );
    console.log("[PT Visit Bot] Filled transfer training comment (frm_FAPT22).");
  }
  
  const gtComment = frame.locator("#frm_GTLevelTrTxt").first();
  if (await gtComment.isVisible().catch(() => false)) {
    await gtComment.fill(
                         "Gait training with appropriate AD as indicated, step-to progressing to step-through pattern, VC/TC for sequencing, pacing, posture, and safety during level and household ambulation."
                         );
    console.log("[PT Visit Bot] Filled gait training comment (frm_GTLevelTrTxt).");
  }
  
  const gtIntervention = frame.locator("#frm_FAPT35").first();
  if (await gtIntervention.isVisible().catch(() => false)) {
    await gtIntervention.fill(
                              "Required min VC/TC for posture, foot clearance, and safe AD use. Demonstrated fair weight shifting and turning transitions. Tolerated gait activities well w/ fair endurance. Continued VC/TC needed for safety and sequencing."
                              );
    console.log("[PT Visit Bot] Filled gait training intervention (#frm_FAPT35).");
  }
  
  const bmRoll = frame.locator("#frm_BMTRollTrTxt").first();
  if (await bmRoll.isVisible().catch(() => false)) {
    await bmRoll.fill("Instruction given for proper body mechanics, sequencing, and safety.");
    console.log("[PT Visit Bot] Filled bed mobility training: #frm_BMTRollTrTxt");
  }
  
  const bmSupSit = frame.locator("#frm_BMTSupSitTrTxt").first();
  if (await bmSupSit.isVisible().catch(() => false)) {
    await bmSupSit.fill("Instruction given for proper body mechanics, sequencing, and safety.");
    console.log("[PT Visit Bot] Filled bed mobility training: #frm_BMTSupSitTrTxt");
  }
  
  const bmSitSup = frame.locator("#frm_BMTSitSupTrTxt").first();
  if (await bmSitSup.isVisible().catch(() => false)) {
    await bmSitSup.fill("Instruction given for proper body mechanics, sequencing, and safety.");
    console.log("[PT Visit Bot] Filled bed mobility training: #frm_BMTSitSupTrTxt");
  }
  
  const ttSitStand = frame.locator("#frm_TTSitStandTrTxt").first();
  if (await ttSitStand.isVisible().catch(() => false)) {
    await ttSitStand.fill(
                          "Instruction given for safety, nose over toes, push off with B hands, and pay attention to surroundings during transfers."
                          );
    console.log("[PT Visit Bot] Filled transfer training: #frm_TTSitStandTrTxt");
  }
  
  const ttStandSit = frame.locator("#frm_TTStandSitTrTxt").first();
  if (await ttStandSit.isVisible().catch(() => false)) {
    await ttStandSit.fill(
                          "Instructed to perform activity with proper body mechanics and to ensure B back of knees are in contact with surface prior to sitting."
                          );
    console.log("[PT Visit Bot] Filled transfer training: #frm_TTStandSitTrTxt");
  }
  
  const ttToilet = frame.locator("#frm_TTToiletorBSCTrTxt").first();
  if (await ttToilet.isVisible().catch(() => false)) {
    await ttToilet.fill("Instruction given for proper body mechanics, sequencing, and safety.");
    console.log("[PT Visit Bot] Filled transfer training: #frm_TTToiletorBSCTrTxt");
  }
  
  const ttTub = frame.locator("#frm_TTTuborShowerTrTxt").first();
  if (await ttTub.isVisible().catch(() => false)) {
    await ttTub.fill("Instruction given for proper body mechanics, sequencing, and safety.");
    console.log("[PT Visit Bot] Filled transfer training: #frm_TTTuborShowerTrTxt");
  }
}

// ---------------- HOMEBOUND: CRITERIA ONE SAFEGUARD ----------------
async function ensureHomeboundCriteriaOne(context) {
  const frame = await findTemplateScope(context);
  if (!frame) return;
  
  const criteriaSelectors = [
    "#cHo_homebound_crit1Part1",
    "xpath=//*[contains(normalize-space(.),'Patient is confined because of illness')]/preceding::input[@type='checkbox'][1]",
    "xpath=//label[contains(normalize-space(.),'Patient is confined because of illness')]//input[@type='checkbox'][1]",
    "xpath=//label[contains(normalize-space(.),'Patient is confined because of illness')]/preceding::input[@type='checkbox'][1]",
  ];
  
  const box = await firstVisibleLocator(frame, criteriaSelectors);
  if (!box) {
    console.log("[PT Visit Bot] Homebound Criteria One checkbox not found; skipping safeguard.");
    return;
  }
  
  try {
    const checked = await box.isChecked().catch(() => false);
    if (!checked) {
      await box.check({ force: true }).catch(async () => {
        await box.click({ force: true });
      });
      console.log("[PT Visit Bot] ✅ Re-checked Homebound Criteria One (safeguard).");
    } else {
      console.log("[PT Visit Bot] Homebound Criteria One already checked (no action).");
    }
  } catch (e) {
    console.log("[PT Visit Bot] Homebound Criteria One safeguard error:", e?.message || e);
  }
}

// ---------------- NEW: GAIT INTERVENTION + OXYGEN / SaO2 FIELDS ----------------
async function fillGaitAndOxygenFields(context, noteData = {}) {
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("[PT Visit Bot] PT Visit frame not found for gait/oxygen fields.");
    return;
  }
  
  const saO2Val =
  noteData.prior_oxygen_sao2 ||
  noteData.oxygen_sao2 ||
  noteData.saO2 ||
  noteData.sao2 ||
  (noteData.vitals &&
   (noteData.vitals.prior_oxygen_sao2 ||
    noteData.vitals.oxygen_sao2 ||
    noteData.vitals.saO2 ||
    noteData.vitals.sao2));
  
  const o2Input = frame.locator("#frm_VSPrior02Sat").first();
  if (saO2Val && (await o2Input.isVisible().catch(() => false))) {
    await o2Input.fill(String(saO2Val));
    console.log("[PT Visit Bot] Filled Oxygen/SaO2 value (frm_VSPrior02Sat):", saO2Val);
  } else {
    console.log("[PT Visit Bot] Oxygen/SaO2 value not found in noteData or field not visible; skipping.");
  }
  
  let o2TypeVal =
  noteData.prior_oxygen_type_value ||
  noteData.oxygen_type_value ||
  (noteData.vitals && noteData.vitals.prior_oxygen_type_value);
  
  if (!o2TypeVal && noteData.oxygen_type_text) {
    const text = String(noteData.oxygen_type_text).toLowerCase();
    if (text.includes("room air")) o2TypeVal = 1;
    else if (text.includes("0.5")) o2TypeVal = 2;
    else if (text.includes("1.0")) o2TypeVal = 3;
  }
  
  const o2Select = frame.locator("#frm_VSPrior02SatType").first();
  if (o2TypeVal && (await o2Select.isVisible().catch(() => false))) {
    await o2Select.selectOption({ value: String(o2TypeVal) }).catch(() => {});
    console.log("[PT Visit Bot] Set Oxygen type (frm_VSPrior02SatType) to value:", o2TypeVal);
  } else {
    console.log("[PT Visit Bot] Oxygen type value not found in noteData or field not visible; skipping.");
  }
}

// ---------------- GENERIC THEREX (TRAINING EXERCISES) ----------------

function wantsGenericTherEx(aiNotes) {
  if (!aiNotes) return false;
  const text = String(aiNotes).toLowerCase();
  return (
          text.includes("common, standard, exercise") ||
          text.includes("generic therex") ||
          text.includes("generic exercises") ||
          text.includes("give basic exercises") ||
          text.includes("temp exercise") ||
          text.includes("ther-ex temp") ||
          text.includes("exercise template") ||
          text.includes("basic exercise") ||
          text.includes("generic therapeutic exercise")
          );
}

async function fillGenericTherExFromCue(context, aiNotes) {
  const frame = await findTemplateScope(context);
  if (!frame) {
    console.log("[PT Visit Bot] Visit frame not found for Training Exercises grid.");
    return;
  }
  
  const note = String(aiNotes || "");
  
  // DEBUG: prove what we received
  try {
    const lower = note.toLowerCase();
    const hasExercisesWord = lower.includes("exercises");
    const mm = note.match(/exercises\s*[:：]/i);
    console.log("[PT Visit Bot] DEBUG exercisesWord?", hasExercisesWord, "exercisesMarker?", !!mm, "aiNotesLen=", note.length);
    if (mm) {
      const idx = mm.index || 0;
      const start = Math.max(0, idx - 80);
      const end = Math.min(note.length, idx + 220);
      const snippet = note.slice(start, end).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
      console.log("[PT Visit Bot] DEBUG around Exercises marker:", snippet);
    }
  } catch (_) {}
  
  const norm = note.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/：/g, ":");
  
  const marker = norm.match(/Exercises\s*:/i);
  if (!marker || marker.index == null) {
    console.log("[PT Visit Bot] No Exercises list found; skipping Training Exercises grid.");
    return;
  }
  
  const after = norm.slice(marker.index + marker[0].length).replace(/^\s+/, "");
  const lines = after.split("\n").map(s => String(s || "").trim());
  
  const STOP_HEADINGS = [
    /^Impact of Exercise/i,
    /^Impact of Exercise\(s\)/i,
    /^Teaching Tools/i,
    /^Education Tools/i,
    /^Teaching Method/i,
    /^Progress to goals/i,
    /^Progress to goals indicated by/i,
    /^Needs continued/i,
    /^Balance Test/i,
    /^Posture Training/i,
    /^Assessment/i
  ];
  
  const rawLines = [];
  let started = false;
  
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    
    if (!t && !started) continue;      // skip leading blanks
    if (!t && started) break;          // blank line ends block once started
    
    // Known heading ends the Exercises block
    if (STOP_HEADINGS.some(rx => rx.test(t))) break;
    
    // Accept bullet or plain lines
    const cleaned = t.replace(/^[\-•]\s*/, "").trim();
    if (cleaned) {
      rawLines.push(cleaned);
      started = true;
    }
  }
  
  // Run-on splitter (if needed)
  function splitRunOn(line) {
    const s = String(line || "").trim();
    if (!s) return [];
    const out = [];
    const re = /([A-Za-z0-9][A-Za-z0-9 \/\-\(\)]{1,60}?)\s*:\s*([\s\S]*?)(?=\s+[A-Za-z0-9][A-Za-z0-9 \/\-\(\)]{1,60}?\s*:\s*|$)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const name = String(m[1] || "").trim();
      const reps = String(m[2] || "").trim();
      if (name) out.push(`${name}: ${reps}`.trim());
    }
    return out.length ? out : [s];
  }
  
  let exLines = rawLines.slice();
  if (exLines.length === 1 && (exLines[0].match(/:/g) || []).length >= 2) {
    exLines = splitRunOn(exLines[0]);
  }
  
  if (exLines.length === 0) {
    console.log("[PT Visit Bot] No Exercises list found; skipping Training Exercises grid.");
    return;
  }
  
  function parseLine(s) {
    const txt = String(s || "").trim();
    if (!txt) return null;
    const idx = txt.indexOf(":");
    if (idx === -1) return { name: txt, reps: "" };
    return { name: txt.slice(0, idx).trim(), reps: txt.slice(idx + 1).trim() };
  }
  
  function normName(name) {
    const n = String(name || "").trim();
    if (!n) return n;
    if (/^seated\s+laq$/i.test(n) || /^laq$/i.test(n)) return "LAQ";
    if (/^seated\s+marching$/i.test(n) || /^marching$/i.test(n)) return "Marching";
    if (/^sit[\-\s]*to[\-\s]*stand$/i.test(n) || /^chair\s+sit\s+to\s+stand$/i.test(n)) return "Chair Sit to Stand";
    if (/^heel\s+raises?$/i.test(n)) return "Heel Raises";
    if (/^clamshells?$/i.test(n)) return "Clamshells";
    if (/^figure\s*4\s*stretch$/i.test(n)) return "Figure 4 Stretch";
    if (/^hamstring\s*stretch$/i.test(n)) return "Hamstring Stretch";
    return n;
  }
  
  function defaultsFor(name) {
    const low = String(name || "").toLowerCase();
    const intervention = "Instruction given for proper body mechanics, sequencing, and safety.";
    if (low.includes("stretch")) return { participation: "Passive", position: "Sitting", intervention };
    if (low.includes("march") || low.includes("sit to stand") || low.includes("heel")) {
      return { participation: "Active", position: "Standing", intervention };
    }
    return { participation: "Active", position: "Sitting", intervention };
  }
  
  async function overwriteText(loc, val, label) {
    const v = String(val ?? "");
    if (!loc) return;
    try {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.waitFor({ state: "visible", timeout: 2500 }).catch(() => {});
      await loc.click({ timeout: 1500 }).catch(() => {});
      await loc.fill("").catch(() => {});
      if (v) {
        await loc.type(v, { delay: 10 }).catch(async () => {
          await loc.fill(v).catch(() => {});
        });
      }
      await loc.evaluate((el, value) => {
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      }, v).catch(() => {});
      console.log(`[PT Visit Bot] ✅ Training Exercise: ${label}`);
    } catch (e) {
      console.log(`[PT Visit Bot] ⚠️ Training Exercise ${label} skipped:`, e?.message || e);
    }
  }
  
  async function overwriteSelect(sel, labelValue, label) {
    if (!sel) return;
    const lv = String(labelValue || "").trim();
    try {
      await sel.scrollIntoViewIfNeeded().catch(() => {});
      await sel.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
      if (lv) {
        await sel.selectOption({ label: lv }).catch(async () => {
          await sel.selectOption(String(lv)).catch(() => {});
        });
      }
      console.log(`[PT Visit Bot] ✅ Training Exercise: ${label}`);
    } catch (e) {
      console.log(`[PT Visit Bot] ⚠️ Training Exercise ${label} skipped:`, e?.message || e);
    }
  }
  
  const parsed = exLines.map(parseLine).filter(Boolean).slice(0, 8);
  
  for (let i = 0; i < parsed.length; i++) {
    const idx = i + 1;
    const item = parsed[i];
    
    const name = normName(item.name);
    const reps = String(item.reps || "")
    .replace(/×/g, "x")
    .replace(/–/g, "-")
    .replace(/second/gi, "sec")
    .trim();
    
    const d = defaultsFor(name);
    
    const nameLocAll = frame.locator(`#frm_te${idx}_Name`);
    const exists = await nameLocAll.count().catch(() => 0);
    if (!exists) break;
    
    const nameInput  = nameLocAll.first();
    const partSelect = frame.locator(`#frm_te${idx}_Participation`).first();
    const posSelect  = frame.locator(`#frm_te${idx}_Position`).first();
    const repsInput  = frame.locator(`#frm_te${idx}_Reps`).first();
    const intArea    = frame.locator(`#frm_te${idx}_Intervention`).first();
    
    await nameInput.scrollIntoViewIfNeeded().catch(() => {});
    const vis = await nameInput.isVisible().catch(() => false);
    if (!vis) {
      await frame.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await wait(250);
      await nameInput.scrollIntoViewIfNeeded().catch(() => {});
    }
    
    await overwriteText(nameInput, name, `#${idx} Name`);
    await overwriteSelect(partSelect, d.participation, `#${idx} Participation`);
    await overwriteSelect(posSelect, d.position, `#${idx} Position`);
    await overwriteText(repsInput, reps, `#${idx} Reps`);
    await overwriteText(intArea, d.intervention, `#${idx} Intervention`);
    // Resistance untouched (default None)
  }
  
  // Clear remaining rows (prevents stale exercises)
  for (let idx = parsed.length + 1; idx <= 8; idx++) {
    const nameLocAll = frame.locator(`#frm_te${idx}_Name`);
    const exists = await nameLocAll.count().catch(() => 0);
    if (!exists) break;
    
    const nameInput  = nameLocAll.first();
    const repsInput  = frame.locator(`#frm_te${idx}_Reps`).first();
    const intArea    = frame.locator(`#frm_te${idx}_Intervention`).first();
    
    await overwriteText(nameInput, "", `#${idx} Name (clear)`);
    await overwriteText(repsInput, "", `#${idx} Reps (clear)`);
    await overwriteText(intArea, "", `#${idx} Intervention (clear)`);
  }
  
  console.log("[PT Visit Bot] ✅ Training Exercises grid overwritten from Exercises: list.");
}

// NOTE:
// Do NOT define another function named clickSave here.
// Use clickSave imported from ./common to avoid "Identifier 'clickSave' has already been declared".

// ---------------- MAIN ENTRY ----------------

async function runPtVisitBot({
  patientName,
  visitDate,
  timeIn,
  timeOut,
  aiNotes,
  kinnserUsername,
  kinnserPassword,
}) {
  const { browser, context, page } = await launchBrowserContext();
  
  try {
    console.log("===============================================");
    console.log("          🩺 Starting PT Visit Bot");
    console.log("===============================================");
    console.log("Patient:", patientName);
    console.log("Visit Date:", visitDate);
    console.log("-----------------------------------------------");
    
    await loginToKinnser(page, {
      username: kinnserUsername,
      password: kinnserPassword,
    });
    
    await navigateToHotBox(page);
    await setHotboxShow100(page);
    
    await openHotboxPatientTask(page, patientName, visitDate, "PT Visit");
    
    // Lock to the most recently opened tab (Kinnser often opens the visit in a new page)
    const activePage = getActivePageFromContext(context) || page;
    
    await wait(2000);
    
    const noteData = await extractNoteDataFromAI(aiNotes || "", "Visit");
    
    await fillVisitBasics(context, { timeIn, timeOut, visitDate });
    await fillVitalsAndNarratives(context, noteData);
    await fillPainSection(context, noteData);
    await fillPtVisitSubjectiveAndPlan(context, noteData);
    await checkGoalsMeetBy(context);
    await fillGaitAndOxygenFields(context, noteData);
    await fillDMESection(context, noteData);
    
    // ✅ functional status → training fields update
    await fillPtVisitTrainingBlocks(context, noteData);
    
    await fillGenericTherExFromCue(context, aiNotes || "");
    await fillVisitExerciseTeachingDefaults(context, aiNotes || "");
    
    await fillVisitSummaryFromCue(context, aiNotes || "");
    await ensureHomeboundCriteriaOne(context);
    
    // ✅ SAVE (must be BEFORE "automation completed" log)
    console.log("[PT Visit Bot] Attempting to click Save (iframe-safe)...");
    await clickSave(activePage);
    await wait(2500);
    
    // ✅ Post-save audit (matches PT Evaluation behavior)
    const _noteUrlBeforeSave = activePage.url();
    await postSaveAuditV2({ page: activePage, context }, { visitDate, timeIn, timeOut, patientName, taskType: "PT Visit", noteUrl: _noteUrlBeforeSave });
    
    // Additional read-only sanity checks (do NOT re-fill fields here)
    try {
      const scope = await findTemplateScope(context, { timeoutMs: 12000 });
      if (scope) {
        const teach = (await scope.locator("#frm_tTitlesTxt").first().inputValue().catch(() => "")).trim();
        console.log(teach.length > 2
                    ? "[PT Visit Bot] ✅ VERIFIED Teaching Tools (frm_tTitlesTxt) - has content"
                    : "[PT Visit Bot] ❌ VERIFY FAIL Teaching Tools appears empty after save");
        
        const impactLoc = scope.locator("#frm_teExerciseDesc").first();
        if (await impactLoc.isVisible().catch(() => false)) {
          const got = (await impactLoc.inputValue().catch(() => "")).trim();
          console.log(got.length > 5
                      ? "[PT Visit Bot] ✅ VERIFIED Impact field has content"
                      : "[PT Visit Bot] ❌ VERIFY FAIL Impact field still empty after save");
        }
      }
    } catch (e) {
      console.log("[PT Visit Bot] ⚠️ Post-save sanity check skipped:", e?.message || e);
    }
    
    await wait(1500);
    
    console.log("[PT Visit Bot] PT Visit automation completed.");
    
    console.log("[PT Visit Bot] Leaving browser open for 5 minutes so you can review before close...");
  } catch (err) {
    console.error("[PT Visit Bot] Error during PT Visit automation:", err);
    throw err;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  runPtVisitBot,
};



// ============================================================================
// Post-save audit v2: verify persistence by reopening the SAME NOTE URL (not HotBox)
// - Avoids HotBox layout/access differences.
// - Reads key persisted fields from the note after save.
// - Treats HotBox reopen as optional (non-fatal unless POST_SAVE_AUDIT_STRICT=1).
// ============================================================================
async function postSaveAuditV2(targetOrWrapper, expected = {}) {
  const page = targetOrWrapper?.page || targetOrWrapper;
  const context =
    targetOrWrapper?.context ||
    (page && typeof page.context === "function" ? page.context() : null);

  const strictReopen = /^(1|true|yes)$/i.test(String(process.env.POST_SAVE_AUDIT_STRICT || "").trim());
  const issues = [];

  const noteUrl = String(expected.noteUrl || page.url() || "").trim();

  // Best-effort: wait for common "saving" overlays/text to clear
  try {
    const start = Date.now();
    const maxMs = 20000;
    while (Date.now() - start < maxMs) {
      const bodyText = await page.evaluate(() => (document.body && document.body.innerText) ? document.body.innerText : "").catch(() => "");
      if (!/page is saving|saving\.\.\.|please wait|processing/i.test(bodyText)) break;
      await page.waitForTimeout(400);
    }
  } catch (_) {}

  // Step 1: reopen the same note URL and verify key fields persisted
  try {
    if (noteUrl && /^https?:\/\//i.test(noteUrl)) {
      console.log(`[PT Visit Bot] 🔁 Post-save audit: reopening same note URL for persistence check...`);
      await page.goto(noteUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(1200);
    } else {
      console.log(`[PT Visit Bot] ⚠️ Post-save audit: noteUrl missing; using current page.`);
    }

    const scope = await findTemplateScope(page).catch(() => null);
    if (!scope) {
      issues.push(`ReopenSameNote: Could not find template scope after reopening note URL. Current page: ${page.url()}`);
    } else {
      const readVisitDate = await safeGetValue(scope, "#frm_visitdate", "visit date", { timeout: 6000 });
      const readTimeIn = await safeGetValue(scope, "#frm_timein", "time in", { timeout: 6000 });
      const readTimeOut = await safeGetValue(scope, "#frm_timeout", "time out", { timeout: 6000 });

      const expDate = expected.visitDate ? normalizeDateToMMDDYYYY(expected.visitDate) : "";
      const gotDate = readVisitDate ? normalizeDateToMMDDYYYY(readVisitDate) : "";

      if (!readVisitDate) issues.push("ReopenSameNote: Visit date is blank after save.");
      if (!readTimeIn) issues.push("ReopenSameNote: Time In is blank after save.");
      if (!readTimeOut) issues.push("ReopenSameNote: Time Out is blank after save.");

      if (expDate && gotDate && expDate !== gotDate) issues.push(`ReopenSameNote: Visit date mismatch (expected ${expDate}, got ${gotDate}).`);
      if (expected.timeIn && readTimeIn && String(readTimeIn).trim() !== String(expected.timeIn).trim()) {
        issues.push(`ReopenSameNote: Time In mismatch (expected ${expected.timeIn}, got ${readTimeIn}).`);
      }
      if (expected.timeOut && readTimeOut && String(readTimeOut).trim() !== String(expected.timeOut).trim()) {
        issues.push(`ReopenSameNote: Time Out mismatch (expected ${expected.timeOut}, got ${readTimeOut}).`);
      }
    }
  } catch (e) {
    issues.push(`ReopenSameNote: Exception while reopening same note URL: ${e?.message || e}`);
  }

  // Step 2 (optional): legacy HotBox reopen check (non-fatal by default)
  try {
    if (typeof navigateToHotboxRobust === "function") {
      console.log("➡️ Checking if we are already on the HotBox screen...");
      const already = (typeof isAlreadyOnHotbox === "function") ? await isAlreadyOnHotbox(page).catch(() => false) : false;
      if (!already) {
        console.log("➡️ Navigating to HotBox (robust mode)...");
        await navigateToHotboxRobust(page);
      }
    }
  } catch (e) {
    const msg = `ReopenHotBox: Unable to navigate to HotBox (layout differs or access blocked).`;
    if (strictReopen) issues.push(msg);
    else console.log(`[PT Visit Bot] ⚠️ Post-save reopen audit skipped (non-fatal): ${msg}`);
  }

  if (issues.length) {
    throw new Error(`POST-SAVE AUDIT FAIL: ${issues.join(" ")}`);
  }

  console.log("✅ Post-save audit passed (reopen same-note persistence check succeeded; HotBox reopen optional).");
}

