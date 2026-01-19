// -----------------------------
// Logging shims (never throw; never depend on params)
// -----------------------------
const _consoleLog = console.log.bind(console);
const _consoleErr = console.error.bind(console);

// Optional: if your UI runner wants to inject a callback, set:
// globalThis.__KINNSER_LOG_CB = (msg) => { ... }
function _emitToCallback(msg) {
  try {
    const cb = globalThis && globalThis.__KINNSER_LOG_CB;
    if (typeof cb === "function") cb(String(msg));
  } catch {}
}

function log(...args) {
  const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  _emitToCallback(msg);
  try { _consoleLog(...args); } catch {}
}

function logErr(...args) {
  const msg = args.map(a => String(a)).join(" ");
  _emitToCallback(msg);
  try { _consoleErr(...args); } catch {}
}

// Backwards-safe alias if you want to keep calling logErrSafe in other places
function logErrSafe(...args) { return logErr(...args); }

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
  path: path.resolve(__dirname, "../.env"),
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



/* =========================
 * Safe field setters (Render/headless hardened)
 * =======================*/
async function safeSetValue(locator, value, label = "field", timeoutMs = 60000) {
  const v = String(value ?? "");
  if (!locator) throw new Error(`safeSetValue: locator missing for ${label}`);

  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: 5000 }).catch(() => {});

  // Attempt fill (fastest)
  try {
    await locator.fill("", { timeout: timeoutMs }).catch(() => {});
    await locator.fill(v, { timeout: timeoutMs });
  } catch (e) {
    // Fallback: direct JS assignment (more reliable in some WellSky fields)
    await locator.evaluate((el, val) => {
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    }, v);
  }

  let persisted = (await locator.inputValue().catch(() => "")).trim();
  if (v.trim() && !persisted) {
    throw new Error(`ASSERT FAIL: ${label} did not persist after set`);
  }

  // Detect truncation (common in long PMH fields). Retry via JS and warn if still truncated.
  if (v.trim() && persisted && persisted !== v.trim()) {
    await locator.evaluate((el, val) => {
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    }, v);

    const persisted2 = (await locator.inputValue().catch(() => "")).trim();
    if (persisted2 && persisted2 !== v.trim()) {
      log(`⚠️ ${label} appears truncated: wanted ${v.trim().length} chars, got ${persisted2.length} chars`);
    }
    persisted = persisted2 || persisted;
  }

  return persisted;
}

async function safeFillLargeText(locator, value, label = "field", timeoutMs = 60000) {
  return safeSetValue(locator, String(value ?? ""), label, timeoutMs);
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
    log("⚠️ POPUP:", dialog.message());
    try {
      await dialog.accept();
      log("✅ Popup accepted");
    } catch (e) {
      log("⚠️ Popup already handled:", e.message);
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
  
  log("➡️ Navigating to login page:", BASE_URL);
  log("   Using username:", finalUsername);
  
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
    logErrSafe("❌ Could not find login fields on WellSky login page.");
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
    logErrSafe("❌ Could not find Log In button.");
    throw new Error("Log In button not found on WellSky login.");
  }
  
  await loginButton.click();
  await wait(2000);
  
  // --- SESSION CONFLICT / TERMINATE OTHER SESSION ---
  async function maybeTerminateOtherSession() {
    const candidates = [
      'input[value*="Terminate"]',
      'button:has-text("Terminate")',
      'text=/Terminate Other Session/i',
      'text=/already logged in/i',
      'text=/active session/i',
    ];
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        log("⚠️ Session lock detected. Terminating other session...");
        await loc.click().catch(() => {});
        await wait(2000);
        return true;
      }
    }
    return false;
  }
  await maybeTerminateOtherSession();
  
  log("✅ Login complete");
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
  log("➡️ Checking if we are already on the HotBox screen...");
  
  // 1) If we already see HotBox rows, just skip navigation
  if (await isAlreadyOnHotbox(page)) {
    log("🔥 Already on HotBox; skipping navigation.");
    return;
  }
  
  log("➡️ Navigating to HotBox (robust mode)...");
  
  await wait(1000);
  
  // 2) Try direct "HotBox" link in main page
  try {
    const hotboxLink = page.locator("a", { hasText: /hotbox/i }).first();
    if (await hotboxLink.isVisible().catch(() => false)) {
      await hotboxLink.click({ timeout: 5000 }).catch(() => {});
      await wait(1200);
      if (await isAlreadyOnHotbox(page)) {
        log("✅ HotBox opened via direct link.");
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
      log("✅ Clicked 'Go To' menu.");
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
          log("✅ HotBox opened via Go To menu.");
          return;
        }
      }
    } catch (e) {
      log("⚠️ Failed Go To navigation:", e.message);
    }
  } else {
    log("⚠️ Could not find a 'Go To' menu. Trying fallbacks...");
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
        log(`✅ HotBox opened via direct URL: ${url}`);
        return;
      }
    } catch {
      // ignore and try next
    }
  }
  
  throw new Error("Unable to navigate to HotBox (layout differs or access blocked).");
}


async function setHotboxShow100(page) {
  log("➡️ Setting Hotbox to Show 100 entries...");
  await wait(1200);
  
  const frame = await findHotboxFrame(page);
  
  try {
    await frame.waitForSelector("select[name='resultsTable_length']", {
      timeout: 1500,
    });
  } catch {
    log("⚠️ Dropdown not found in DOM within timeout");
    return;
  }
  
  const dropdown = frame.locator("select[name='resultsTable_length']").first();
  
  try {
    await dropdown.waitFor({ state: "visible", timeout: 1500 });
  } catch {
    log("⚠️ Dropdown never became visible");
    return;
  }
  
  try {
    await dropdown.selectOption("100");
    log("✅ Show 100 selected via selectOption");
  } catch (err) {
    log("⚠️ selectOption failed, retrying via click:", err.message);
    try {
      await dropdown.click();
      await wait(500);
      const option100 = frame.locator("option[value='100']").first();
      await option100.click();
      log("✅ Show 100 selected by clicking option");
    } catch (err2) {
      log("❌ Could not select '100' at all:", err2.message);
      return;
    }
  }
  
  await wait(1000);
}

/* =========================
 * Open Hotbox patient row
 * =======================*/

async function openHotboxPatientTask(page, patientName, visitDate, taskType) {
  log(
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
  log("🔎 Date variants for Hotbox search:", dateVariants);
  
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
        log(`✅ Hotbox row found using date "${dateStr}" (task fuzzy match)`);
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
        log("✅ Hotbox row found using patient-only fallback (date + task fuzzy match).");
        break;
      }
    }
  }
  
  if (!row) {
    log(
      `❌ No Hotbox row found for any date variant ${JSON.stringify(
        dateVariants
      )}, task "${taskType}", and name "${patientName}".`
                );
    throw new Error("Hotbox row not found for date + task + name (fuzzy match).");
  }
  
  log("✅ Matching row found. Clicking patient link ...");
  
  // Prefer clicking patient link, but fall back to first link in row if patient text differs.
  let link = row.locator(`a:has-text("${patientName}")`).first();
  let linkVisible = await link.isVisible().catch(() => false);
  
  if (!linkVisible) {
    link = row.locator("a").first();
    linkVisible = await link.isVisible().catch(() => false);
  }
  
  if (!linkVisible) {
    log(`❌ Could not find any clickable link in the matching row.`);
    throw new Error("Patient link not found in matching row.");
  }
  
  await link.click();
  await wait(1000);
  
  log("👤 Patient visit page opened (date + task + name matched).");
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
    log("⚠️ findTemplateScope: no template scope found. Pages:", urls);
  } catch {}
  return null;
}

async function selectTemplateGW2(context) {
  log("➡️ Selecting GW2...");
  
  await wait(2000);
  
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      const select = frame.locator("select[name='jump1']").first();
      
      if (await select.isVisible().catch(() => false)) {
        try {
          await select.selectOption({ label: "GW2" });
          log("✅ GW2 selected via label");
          await wait(1500);
          return;
        } catch {}
        
        try {
          await select.click();
          await frame.locator("option:has-text('GW2')").first().click();
          log("✅ GW2 selected via click");
          await wait(1500);
          return;
        } catch {}
      }
    }
  }
  
  log("⚠️ GW2 not found");
}

/* =========================
 * Visit basics (ID + times + date)
 * =======================*/

async function fillVisitBasics(context, { timeIn, timeOut, visitDate }) {
  log("➡️ Filling visit basics...");
  
  await wait(1000);
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    log("⚠️ Template frame not found");
    return;
  }
  
  try {
    const box = frame.getByLabel("Patient identity confirmed");
    if (await box.isVisible().catch(() => false)) {
      await box.check();
      log("☑️ ID confirmed");
    }
  } catch {}
  
  const timeInInput = await firstVisibleLocator(frame, [
    "#frm_timein",
    "input[name^='frm_timein']",
  ]);
  if (timeInInput) {
    await timeInInput.fill("");
    await timeInInput.type(timeIn, { delay: 40 });
    log("⏱ Time In filled:", timeIn);
    // Verify persisted value (prevents false positives when typing into a stale/hidden iframe)
    try {
      const v = (await timeInInput.inputValue().catch(() => "")).trim();
      if (!v) throw new Error("empty");
      log("✅ Verified Time In persisted:", v);
    } catch (e) {
      throw new Error("ASSERT FAIL: Time In did not persist in active form");
    }
  }
  
  const timeOutInput = await firstVisibleLocator(frame, [
    "#frm_timeout",
    "input[name^='frm_timeout']",
  ]);
  if (timeOutInput) {
    await timeOutInput.fill("");
    await timeOutInput.type(timeOut, { delay: 40 });
    log("⏱ Time Out filled:", timeOut);
    // Verify persisted value (prevents false positives when typing into a stale/hidden iframe)
    try {
      const v = (await timeOutInput.inputValue().catch(() => "")).trim();
      if (!v) throw new Error("empty");
      log("✅ Verified Time Out persisted:", v);
    } catch (e) {
      throw new Error("ASSERT FAIL: Time Out did not persist in active form");
    }
  }
  
  // Normalize visit date to MM/DD/YYYY before typing
  const normalizedDate = normalizeDateToMMDDYYYY(visitDate);
  log(
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
    log("📅 Visit Date filled:", normalizedDate);
    // Verify persisted value (prevents false positives when typing into a stale/hidden iframe)
    try {
      const v = (await dateInput.inputValue().catch(() => "")).trim();
      if (!v) throw new Error("empty");
      log("✅ Verified Visit Date persisted:", v);
    } catch (e) {
      throw new Error("ASSERT FAIL: Visit Date did not persist in active form");
    }
  }
  
  log("✅ Visit basics step finished");
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

function normalizeAssistanceText(raw = "") {
  const t = String(raw || "").trim();
  if (!t) return "";

  const low = t.toLowerCase();

  // Standardize key cases
  if (low.includes("family") || low.includes("spouse")) return "Family / Spouse";
  if (low.includes("caregiver") || low.includes("cg") || low.includes("staff"))
    return "Caregivers / facility staff";

  // Remove weird characters + collapse spaces
  return t.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
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
      noHazardsIdentified: false,
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
      bedMobilityFactors: "",
      transfersFactors: "",
      gaitFactors: "",
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

  // -------------------------
  // MEDICAL DX (structured parse from note; no OpenAI dependency)
  // -------------------------
  const medDxMatch =
    text.match(new RegExp('(?:^|\\n)\\s*medical\\s*(?:dx|diagnosis)\\s*:\\s*([^\\n\\r]+)', 'i')) ||
    text.match(new RegExp('(?:^|\\n)\\s*diagnosis\\s*\\(\\s*dx\\s*\\)\\s*:\\s*([^\\n\\r]+)', 'i')) ||
    text.match(new RegExp('(?:^|\\n)\\s*dx\\s*:\\s*([^\\n\\r]+)', 'i')) ||
    text.match(new RegExp('(?:^|\\n)\\s*diagnosis\\s*:\\s*([^\\n\\r]+)', 'i'));

  if (medDxMatch) {
    const rawDx = cleanInlineValue(medDxMatch[1] || "");
    const dx = (typeof sanitizeMedicalDiagnosis === "function")
      ? sanitizeMedicalDiagnosis(rawDx)
      : String(rawDx || "").trim();
    if (dx) result.medicalDiagnosis = dx;
  }
  result.living = result.living || {};
  
  function cleanInlineValue(raw) {
  let out = String(raw || "").trim();
  if (!out) return "";

  const stopTokens = [
    "safety narrative",
    "safety / sanitation hazards",
    "safety hazards",
    "sanitation hazards",
    "evaluation of living situation",
    "evaluation of living",
    "living situation",
    "patient lives",
    "assistance is available",
    "steps count",
    "steps / stairs",
    "dme",
    "other:",
    "hazard found",
    "no hazard",
    "no hazards identified",
    "no hazards"
  ];

  const lower = out.toLowerCase();
  for (const token of stopTokens) {
    const idx = lower.indexOf(token);
    if (idx > 0) {
      out = out.slice(0, idx).trim();
      break;
    }
  }

  out = out.split(/[.;|]/)[0].trim();
  out = out.replace(/\s+/g, " ").trim();
  return out;
}
  
  // ---------------------------------------------------------
  // Helper: map living situation text to 1 of 3 Kinnser options
  // ---------------------------------------------------------
  function inferPatientLivesValue(livingLine) {
    const s = (livingLine || "").toLowerCase().trim();
    
    const ALONE = "Alone";
    const WITH_OTHERS = "With other person(s) in the home";
    const CONGREGATE = "In congregate situation, e.g., assisted living";
    
    // 1) CONGREGATE (highest priority)
    const congregatePatterns = [
      /\bcongregate\b/,
      /\bassisted\s*living\b/,
      /\balf\b/,
      /\bboard\s*(and|&)\s*care\b/,
      /\bb\s*&\s*c\b/,
      /\broom\s*and\s*board\b/,
      /\bgroup\s*home\b/,
      /\bmemory\s*care\b/,
      /\bnursing\s*home\b/,
      /\bsnf\b/,
      /\bskilled\s*nursing\b/,
      /\bltc\b/,
      /\blong[-\s]*term\s*care\b/,
      /\bfacility\b/,
      /\bcare\s*home\b/,
      /\brcfe\b/,
      /\bresidential\s*care\b/,
      /\bretirement\s*home\b/
    ];
    if (congregatePatterns.some((re) => re.test(s))) return CONGREGATE;
    
    // 2) ALONE (explicit / strong indicators)
    const alonePatterns = [
      /\blives\s*alone\b/,
      /\bliving\s*alone\b/,
      /\balone\b/,
      /\bby\s*(my|him|her)?\s*self\b/,
      /\bon\s*(my|his|her)?\s*own\b/,
      /\bno\s*one\b/,
      /\bno\s*help\b/,
      /\bno\s*assistance\b/,
      /\bno\s*caregiver\b/,
      /\bwithout\s*help\b/
    ];
    
    if (alonePatterns.some((re) => re.test(s))) {
      // Guard: if someone else is mentioned too, treat as WITH OTHERS
      const withOthersGuard = [
        /\blives\s*with\b/,
        /\bwith\b/,
        /\bfamily\b/,
        /\bspouse\b/,
        /\bhusband\b/,
        /\bwife\b/,
        /\bpartner\b/,
        /\broommate(s)?\b/,
        /\bfriend\b/,
        /\bcaregiver\b/,
        /\bcg\b/,
        /\bstaff\b/,
        /\bshared?\s*(room|home)\b/,
        /\bshare\s*(a\s*)?(room|home)\b/
      ];
      if (!withOthersGuard.some((re) => re.test(s))) return ALONE;
    }
    
    // 3) WITH OTHER PERSON(S)
    const withOthersPatterns = [
      /\blives\s*with\b/,
      /\bwith\b/,
      /\bfamily\b/,
      /\bspouse\b/,
      /\bhusband\b/,
      /\bwife\b/,
      /\bpartner\b/,
      /\broommate(s)?\b/,
      /\bfriend\b/,
      /\bcaregiver\b/,
      /\bcg\b/,
      /\bstaff\b/,
      /\bshared?\s*(room|home)\b/,
      /\bshare\s*(a\s*)?(room|home)\b/
    ];
    if (withOthersPatterns.some((re) => re.test(s))) return WITH_OTHERS;
    
    return WITH_OTHERS;
  }
  
  // ---------------------------------------------------------
  // Explicit label: Current assistance types (AS-IS, cleaned) — highest priority
  // Example: "Current assistance types: Family/spouse"
  // ---------------------------------------------------------
  const currAsstMatch =
    text.match(new RegExp('(?:^\n|\n)\s*current\s*(types?\s*of\s*)?assistance\s*(types)?\s*:\s*([^\n\r]+)', 'i'));

  if (currAsstMatch) {
    const raw = cleanInlineValue(currAsstMatch[3] || "");
    if (raw) {
      // Keep EXACT user-entered text for Kinnser fill
      result.living.currentAssistanceTypes = raw;
      result.living.rawCurrentAssistanceLine = raw;
    }
  }

  // ---------------------------------------------------------
  // Safety Narrative: store ONLY content after the colon (no "Safety Narrative:" prefix)
  // ---------------------------------------------------------
  const safetyNarrMatch =
    text.match(new RegExp('(?:^|\n)\s*safety\s*narrative\s*:\s*([\s\S]+?)(?=\n\s*[a-zA-Z][^:\n]{0,60}\s*:\s*|\n{2,}|$)', 'i'));

  if (safetyNarrMatch) {
    let narrative = (safetyNarrMatch[1] || "").trim();
    narrative = narrative.replace(/^\s*safety\s*narrative\s*:\s*/i, "").trim();
    narrative = narrative.replace(/\s+/g, " ").trim();
    if (narrative) {
      result.living.safetyNarrative = narrative;
    }
  }

  // ---------------------------------------------------------
  // Living situation + helper extraction
  // ---------------------------------------------------------
  const livingMatch =
  text.match(/(?:^|\n)\s*living situation\s*:\s*([^\n\r]+)/i) ||
  // Capture full phrase after "lives" (e.g., "with family", "in apartment", "alone")
  text.match(/(?:^|\n)\s*lives\s+([^\n\r]+)/i);
  
  const helperMatch =
  text.match(/(?:^|\n)\s*person helping\s*:\s*([^\n\r]+)/i);
  
  if (livingMatch) {
    const livingLine = (livingMatch[1] || "").trim();
    result.living.rawLivingLine = livingLine;
    
    // Evaluation sentence: keep "in ..." or "with ..." if present; otherwise default to "in ..."
    const ll = livingLine.toLowerCase();
    result.living.evaluationText = `Pt lives ${
    (ll.startsWith("in") || ll.startsWith("with")) ? livingLine : "in " + livingLine
  }.`;
    
    // Kinnser-limited living situation (3 options only)
    result.living.patientLivesValue = inferPatientLivesValue(livingLine);
    
    // Existing helpers (must exist)
    result.living.assistanceAvailableValue = inferAssistanceValue(livingLine);
    
    const stepsInfo = parseStepsFromLiving(livingLine);
    result.living.stepsPresent = stepsInfo.stepsPresent;
    result.living.stepsCount = stepsInfo.stepsCount;
    
    // Pets (single check)
    if (ll.includes("pet")) result.living.hasPets = true;
    
    // Fallback inference for Current Assistance Types ONLY if explicit label absent
    if (!result.living.currentAssistanceTypes) {
      if (ll.includes("caregiver") || ll.includes("cg") || ll.includes("staff")) {
        result.living.currentAssistanceTypes = "Caregivers / facility staff";
      } else if (ll.includes("family") || ll.includes("spouse")) {
        result.living.currentAssistanceTypes = "Family/Spouse";
      }
    }
  }
  
  if (helperMatch) {
    const helperLine = (helperMatch[1] || "").trim();
    result.living.rawHelperLine = helperLine;
    
    const hl = helperLine.toLowerCase();
    
    // Pets (single check)
    if (hl.includes("pet")) result.living.hasPets = true;
    
    // Fallback inference for Current Assistance Types ONLY if explicit label absent
    if (!result.living.currentAssistanceTypes) {
      if (hl.includes("caregiver") || hl.includes("cg") || hl.includes("staff")) {
        result.living.currentAssistanceTypes = "Caregivers / facility staff";
      } else if (hl.includes("family") || hl.includes("spouse")) {
        result.living.currentAssistanceTypes = "Family/Spouse";
      }
    }
  }
  
  // Explicit "Steps Count:" overrides any inferred steps from livingLine
  const stepsCountMatch =
  text.match(/(?:^|\n)\s*steps\s*count\s*:\s*(\d+)\b/i) ||
  text.match(/(?:^|\n)\s*steps\s*cont\s*:\s*(\d+)\b/i) ||
  text.match(/(?:^|\n)\s*number\s*of\s*steps\s*:\s*(\d+)\b/i);
  
  if (stepsCountMatch) {
    result.living.stepsCount = String(stepsCountMatch[1] || "").trim();
    if (result.living.stepsCount) result.living.stepsPresent = true;
  }

  // Response to tx (preferred keyword) + Factors Contributing to Functional Impairment (fallback)
  // Bed Mobility
  const rttBed =
  text.match(/(?:^|\n)\s*response\s*to\s*tx\.?\s*:\s*bed\s*mobility\s*:\s*([^\n\r]+)/i) ||
  text.match(/(?:^|\n)\s*response\s*to\s*tx\.?\s*bed\s*mobility\s*:\s*([^\n\r]+)/i);
  if (rttBed) result.func.bedMobilityFactors = (rttBed[1] || "").trim();
  
  const fciBed =
  text.match(/(?:^|\n)\s*factors\s+contributing\s+to\s+functional\s+impairment\s*:\s*bed\s*mobility\s*:\s*([^\n\r]+)/i);
  if (!result.func.bedMobilityFactors && fciBed)
    result.func.bedMobilityFactors = (fciBed[1] || "").trim();
  
  // Transfers
  const rttTrans =
  text.match(/(?:^|\n)\s*response\s*to\s*tx\.?\s*:\s*(transfer|transfers)\s*:\s*([^\n\r]+)/i) ||
  text.match(/(?:^|\n)\s*response\s*to\s*tx\.?\s*(transfer|transfers)\s*:\s*([^\n\r]+)/i);
  if (rttTrans) result.func.transfersFactors = (rttTrans[2] || "").trim();
  
  const fciTrans =
  text.match(/(?:^|\n)\s*factors\s+contributing\s+to\s+functional\s+impairment\s*:\s*(transfer|transfers)\s*:\s*([^\n\r]+)/i);
  if (!result.func.transfersFactors && fciTrans)
    result.func.transfersFactors = (fciTrans[2] || "").trim();
  
  // Gait
  const rttGait =
  text.match(/(?:^|\n)\s*response\s*to\s*tx\.?\s*:\s*gait\s*:\s*([^\n\r]+)/i) ||
  text.match(/(?:^|\n)\s*response\s*to\s*tx\.?\s*gait\s*:\s*([^\n\r]+)/i);
  if (rttGait) result.func.gaitFactors = (rttGait[1] || "").trim();
  
  const fciGait =
  text.match(/(?:^|\n)\s*factors\s+contributing\s+to\s+functional\s+impairment\s*:\s*gait\s*:\s*([^\n\r]+)/i);
  if (!result.func.gaitFactors && fciGait)
    result.func.gaitFactors = (fciGait[1] || "").trim();
  
  
  // DME other (explicit label; some notes use "DME other:" instead of "DME:")
  const dmeOtherMatch =
  text.match(/(?:^|\n)\s*dme\s*other\s*:\s*([^\n\r]+)/i);
  if (dmeOtherMatch) {
    const line = (dmeOtherMatch[1] || "").trim();
    if (line) {
      result.dme.other = line;
      const lower = line.toLowerCase();
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
  }
  
  // ASSISTANCE AVAILABLE (explicit field)
  const asstAvailMatch =
  text.match(/(?:^|\n)\s*assistance available\s*:\s*([^\n\r]+)/i) ||
  text.match(/(?:^|\n)\s*assistance\s+is\s+available\s*:\s*([^\n\r]+)/i);
  
  if (asstAvailMatch) {
    const asstLine = (asstAvailMatch[1] || "").trim();
    // Prefer this explicit field over any inference from Living Situation line
    const inferred = inferAssistanceValue(asstLine);
    if (inferred && inferred !== "0") result.living.assistanceAvailableValue = inferred;
  }
  
  // STEPS/STAIRS present (explicit field)
  const stepsPresentMatch =
  text.match(/(?:^|\n)\s*steps\/stairs\s*present\s*:\s*(yes|no)\b/i) ||
  text.match(/(?:^|\n)\s*steps\s*\/\s*stairs\s*:\s*(yes|no)\b/i);
  
  if (stepsPresentMatch) {
    const yn = (stepsPresentMatch[1] || "").toLowerCase();
    result.living.stepsPresent = yn === "yes";
    if (!result.living.stepsPresent) result.living.stepsCount = "";
  }
  
  // NO HAZARDS identified (explicit field)
  const noHazMatch =
  text.match(/(?:^|\n)\s*no\s+safety\s+hazards\s+identified\s*:\s*(yes|no)\b/i) ||
  text.match(/(?:^|\n)\s*no\s+hazards\s+identified\s*:\s*(yes|no)\b/i);
  
  if (noHazMatch) {
    const yn = (noHazMatch[1] || "").toLowerCase();
    result.living.noHazardsIdentified = yn === "yes";
  }
  
  // VITALS COMMENT
  const vitalsCommentMatch =
  text.match(/(?:^|\n)\s*(blood pressure comment|bp comment|vitals comment|vs comments?|comments)\s*:\s*(.+)/i);
  if (vitalsCommentMatch) result.vitalsComment = (vitalsCommentMatch[2] || "").trim();
  
  // SUBJECTIVE
  const subjMatch = text.match(/(?:^|\n)\s*subjective\s*:\s*([^\n\r]+)/i);
  if (subjMatch) result.subjective = subjMatch[1].trim();
  
  
  // PAIN ASSESSMENT (explicit block)
  const painYesNo =
  text.match(/(?:^|\n)\s*pain\s*:\s*(yes|no)\b/i) ||
  text.match(/(?:^|\n)\s*pain\s+assessment\s*:\s*(yes|no)\b/i);
  
  if (painYesNo) {
    const yn = (painYesNo[1] || "").toLowerCase();
    result.pain.hasPain = yn === "yes";
  }
  
  // Pain Location
  // Prefer explicit "Primary Location Other:" (matches your required Kinnser workflow)
  const painLocOther = text.match(/(?:^|\n)\s*primary\s+location\s+other\s*:\s*([^\n\r]+)/i);
  if (painLocOther) {
    result.pain.primaryLocationText = painLocOther[1].trim();
  } else {
    // Fallbacks
    const painLocPrimary = text.match(/(?:^|\n)\s*primary\s+location\s*:\s*([^\n\r]+)/i);
    const painLoc = text.match(/(?:^|\n)\s*location\s*:\s*([^\n\r]+)/i);
    if (painLocPrimary) result.pain.primaryLocationText = painLocPrimary[1].trim();
    else if (painLoc) result.pain.primaryLocationText = painLoc[1].trim();
  }

  
  const painInt = text.match(/(?:^|\n)\s*intensity\s*\(?.*?\)?\s*:\s*([0-9]{1,2})\b/i);
  if (painInt) result.pain.intensityValue = String(painInt[1]).trim();
  
  const incBy = text.match(/(?:^|\n)\s*increased\s+by\s*:\s*([^\n\r]+)/i);
  if (incBy) result.pain.increasedBy = incBy[1].trim();
  
  const relBy = text.match(/(?:^|\n)\s*relieved\s+by\s*:\s*([^\n\r]+)/i);
  if (relBy) result.pain.relievedBy = relBy[1].trim();
  
  const intWith = text.match(/(?:^|\n)\s*interferes\s+with\s*:\s*([^\n\r]+)/i);
  if (intWith) result.pain.interferesWith = intWith[1].trim();
  
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
  
  // GOALS BLOCK (bounded; stops before Frequency/other headings)
	  
	function stripWithinVisits(line) {
	  return String(line || "")
	    .replace(/\s*\bwithin\s+(?:a\s+)?(?:total\s+of\s+)?\d{1,2}\s*visits?\b\.?/gi, "")
	    .replace(/\s{2,}/g, " ")
	    .trim();
	}
	
	function extractWithinVisits(line) {
	  const m = String(line || "").match(/\bwithin\s+(?:a\s+)?(?:total\s+of\s+)?(\d{1,2})\s*visits?\b/i);
	  return m ? `${m[1]} visits` : "";
	}
	
	function toLines(block) {
	  return String(block || "")
	    .split(/\r?\n/)
	    .map(s => s.trim())
	    .filter(Boolean)
	    .map(s => s.replace(/^[-•]+\s*/, "").trim());
	}
	
	// --- A) Try STG/LTG format first ---
	const stgBlock =
	  text.match(/(?:^|\n)\s*short[-\s]*term\s*goals?\s*\(stg\)\s*:\s*([\s\S]+?)(?=\n\s*long[-\s]*term\s*goals?\s*\(ltg\)\s*:|\n{2,}|$)/i);
	
	const ltgBlock =
	  text.match(/(?:^|\n)\s*long[-\s]*term\s*goals?\s*\(ltg\)\s*:\s*([\s\S]+?)(?=\n{2,}|$)/i);
	
	if (stgBlock || ltgBlock) {
	  const stgRawLines = toLines(stgBlock?.[1] || "");
	  const ltgRawLines = toLines(ltgBlock?.[1] || "");
	
	  // Extract visit counts from first line that contains "within X visits"
	  const stgWithin = extractWithinVisits(stgRawLines.find(l => /within\s+\d+\s*visits?/i.test(l)) || "");
	  const ltgWithin = extractWithinVisits(ltgRawLines.find(l => /within\s+\d+\s*visits?/i.test(l)) || "");
	
	  if (stgWithin) result.plan.shortTermVisits = stgWithin;
	  if (ltgWithin) result.plan.longTermVisits = ltgWithin;
	
	  const stgGoals = stgRawLines.map(stripWithinVisits).filter(Boolean);
	  const ltgGoals = ltgRawLines.map(stripWithinVisits).filter(Boolean);
	
	  // Build ordered goalTexts for Kinnser rows: STG then LTG
	  result.plan.goalTexts = [...stgGoals, ...ltgGoals].filter(Boolean);
	} else {
	  // --- B) Fallback to generic "Goals:" block (your original behavior) ---
	  const goalsBlock = text.match(
	    /(?:^|\n)\s*goals?\s*:\s*([\s\S]+?)(?=\n\s*(frequency|plan|dme|vital signs|bp|hr|rr|temp|living situation|person helping|assessment summary|clinical statement)\s*:|\n{2,}|$)/i
	  );
	
	  if (goalsBlock) {
	    const rawBlock = goalsBlock[1] || "";
	
	    // Capture visit counts (supports "within X visits" OR "total of X visits")
	    const visitMatches = [...rawBlock.matchAll(/\b(?:within\s+(?:a\s+)?(?:total\s+of\s+)?)?(\d{1,2})\s*visits?\b/gi)];
	    if (visitMatches[0]) result.plan.shortTermVisits = `${visitMatches[0][1]} visits`;
	    if (visitMatches[1]) result.plan.longTermVisits = `${visitMatches[1][1]} visits`;
	
	    const rawLines = rawBlock
	      .split(/\r?\n/)
	      .map((l) => l.trim())
	      .filter(Boolean);
	
	    const merged = [];
	
	    const isNewGoal = (line) =>
	      /^(STG|LTG)\s*:/i.test(line) ||
	      /^\d+\s*[:.)]/.test(line) ||
	      /^-\s+/.test(line) ||
	      /^Pt\s+will\b/i.test(line);
	
	    for (const line of rawLines) {
	      if (/^\s*frequency\s*:/i.test(line)) break;
	
	      if (!merged.length) merged.push(line);
	      else if (isNewGoal(line)) merged.push(line);
	      else {
	        merged[merged.length - 1] = `${merged[merged.length - 1]} ${line}`
	          .replace(/\s{2,}/g, " ")
	          .trim();
	      }
	    }
	
	    result.plan.goalTexts = merged
	      .map((l) => stripWithinVisits(l))
	      .filter(Boolean)
	      .filter((l) => !/^\s*frequency\s*:/i.test(l));
	  }
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
    log("🧾 Parsed frequency (code):", result.plan.frequency);
  } else {
    log("ℹ️ No frequency pattern found in AI note.");
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
			safetyNarrative: structured.living?.safetyNarrative || "",
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
    log("[Vitals Parser] Error parsing vitals:", err.message);
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
    logErrSafe("⚠️ OpenAI/JSON error; using defaults:", String((err && err.message) || err || ""));
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
    log("⚠️ sanitize/enforce skipped:", e.message);
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
  log("➡️ Filling vitals + narratives...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    log("⚠️ Template frame not found for vitals/narratives");
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
    log("🌡 Temp:", vitals.temperature);
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
        log("🌡 Temp type selected: Temporal");
      } catch {}
      
      // Fallback: value (default 4)
      if (!ok) {
        const val = String(vitals.temperatureTypeValue || "4");
        try {
          await tempTypeSelect.selectOption(val);
          ok = true;
          log("🌡 Temp type selected by value:", val);
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
          log(`🌡 Temp type fuzzy matched: "${hit.label}" (${hit.value})`);
        } else {
          log("⚠️ No 'Temporal' option found in temp type dropdown.");
        }
      }
    } else {
      log("⚠️ Temp type dropdown not found/visible.");
    }
  } catch (e) {
    log("⚠️ Temp type select error:", e.message);
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
    await safeFillLargeText(vsCommentInput, vsText, "frm_VSComments");
    log("💬 VS Comments filled.");
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
        await safeFillLargeText(relHist, relevantHistoryText, "frm_RlvntMedHist");
        log("🧾 Relevant Medical History filled.");
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
        await safeFillLargeText(cs, clinicalStatementText, "frm_EASI1");
        log("📝 Clinical statement filled (Initial Eval): frm_EASI1");
      } else {
        log("⚠️ Could not find frm_EASI1 on the template.");
      }
    }
  } else {
    log("🚫 Clinical statement skipped here (not Initial Evaluation).");
  }
  
  log("✅ Vitals + narratives finished.");
}

  /* =========================
   * Medical Dx
   * =======================*/
  
  async function fillMedDiagnosisAndSubjective(context, data) {
    log("➡️ Filling Medical Dx only (subjective removed)...");
    
    const frame = await findTemplateScope(context);
    if (!frame) {
      log("⚠️ Template frame not found for Dx");
      return;
    }
    
    // Medical Diagnosis ONLY
    if (data.medicalDiagnosis) {
      const medDxInput = await firstVisibleLocator(frame, ["#frm_MedDiagText"]);
      if (medDxInput) {
        await medDxInput.fill("");
        await medDxInput.type(data.medicalDiagnosis, { delay: 20 });
        log("🧾 Medical Dx filled:", data.medicalDiagnosis);
      }
    }
    
    // Subjective removed — do nothing
    log("🚫 Subjective skipped (intentionally not filled).");
  }

/* =========================
 * Subjective
 * =======================*/
async function fillSubjectiveOnly(context, data) {
  log("➡️ Filling Subjective only (no Medical Dx)...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    log("⚠️ Template frame not found for subjective");
    return;
  }
  
  if (data.subjective) {
    const subjArea = await firstVisibleLocator(frame, ["#frm_SubInfo"]);
    if (subjArea) {
      await safeFillLargeText(subjArea, data.subjective, "frm_SubInfo");
      log("🗣 Subjective filled");
    }
  }
}

/* =========================
 * Neuro / Physical assessment
 * =======================*/

async function fillNeuroPhysical(context, data) {
  log("➡️ Filling Neuro/Physical assessment...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    log("⚠️ Template frame not found for neuro/physical.");
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
        log(`🧠 ${key} filled.`);
      }
    } catch (e) {
      log(`⚠️ Could not fill ${key}:`, e.message);
    }
  }
}

/* =========================
 * Edema
 * =======================*/

async function fillEdemaSection(context, data) {
  log("➡️ Filling Edema section...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    log("⚠️ Template frame not found for edema.");
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
  log("➡️ Filling Pain Assessment (if present)...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    log("⚠️ Template frame not found for pain");
    return;
  }
  
  const pain = data?.pain || {};
  
  // If pain is present, make sure "No Pain Reported" is unchecked if the checkbox exists
  if (pain.hasPain) {
    try {
      const noPainBox = await firstVisibleLocator(frame, [
        "#frm_PainAsmtNoPain",
        "input[type='checkbox'][name*='NoPain']",
        "input[type='checkbox'][id*='NoPain']",
      ]);
      if (noPainBox) await noPainBox.uncheck().catch(() => {});
    } catch {}
  }
  
  
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
        log("☑️ 'No Pain Reported' checked (no pain in AI note).");
      } else {
        log("ℹ️ No explicit 'No Pain Reported' checkbox found.");
      }
    } catch (e) {
      log("⚠️ Could not set 'No Pain Reported':", e.message);
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
    // Primary Site: select "Other" THEN wait for "Other description" box to appear
    const siteSelect = frame.locator("#frm_PainAsmtSitePrim").first();
    if (await siteSelect.isVisible().catch(() => false)) {
      // select + fire change handlers
      if (locationText) {
        await siteSelect.selectOption({ label: "Other" }).catch(() => {});
        // Give Kinnser time to render the "Other description" textbox
        await wait(400);
      }
      await siteSelect.evaluate((el) => {
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      }).catch(() => {});
      await wait(600); // allow Kinnser JS to reveal the "Other" textbox
    }

    // "Other" description textbox (must pick "Other" first to render)
    // We support both known IDs AND a relative fallback to the first text input after the select.
    if (locationText) {
      const siteOther = await firstVisibleLocator(frame, [
        "#frm_PainAsmtSiteOtherDescPrim",
        "#frm_PaintAsmtSiteOtherDescPrim", // typo variant seen in some templates
        "input[id*='PainAsmtSiteOtherDescPrim']",
        "input[id*='PaintAsmtSiteOtherDescPrim']",
        "xpath=//*[@id='frm_PainAsmtSitePrim']/following::input[1]",
        "xpath=//*[@id='frm_PainAsmtSitePrim']/following::textarea[1]",
      ]);

      if (siteOther && (await siteOther.isVisible().catch(() => false))) {
        await safeSetValue(siteOther, locationText, "Pain Primary Location Other", 60000);
        log("📍 Pain location (Primary Other):", locationText);
      } else {
        log("⚠️ Primary pain 'Other' textbox not found after selecting Other.");
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
        log("📊 Pain intensity (Pre):", intensityVal);
      } else {
        log("⚠️ Could not find Pre intensity dropdown.");
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
        log("📊 Pain intensity (Post):", intensityVal);
      } else {
        log("ℹ️ Post intensity dropdown not found/visible (skipped).");
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
    
    log("✅ Pain section filled from AI");
  } catch (e) {
    log("⚠️ Error filling pain section:", e.message);
  }
}


/* =========================
 * LIVING SITUATION + SAFETY / HAZARDS
 * =======================*/

async function fillHomeSafetySection(context, data) {
  log("➡️ Filling Living Situation / Safety Hazards...");
  
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
      log(`⚠️ ${label} not ready:`, e.message);
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
      log(`✅ ${label} filled`);
    } catch (e) {
      log(`⚠️ ${label} skipped:`, e.message);
    }
  }
  
  async function safeType(locatorOrNull, value, label, typeDelay = 8) {
    const v = (value ?? "").toString().trim();
    if (!locatorOrNull || !v) return;
    try {
      if (!(await ensureReady(locatorOrNull, label, 2500))) return;
      await withTimeout(locatorOrNull.fill(""), 1400, `${label}.fill`);
      await withTimeout(locatorOrNull.type(v, { delay: typeDelay }), 2600, `${label}.type`);
      log(`✅ ${label} typed`);
    } catch (e) {
      // fallback to fill if type fails
      try {
        await safeFill(locatorOrNull, v, `${label} (fallback fill)`);
      } catch (_) {
        log(`⚠️ ${label} skipped:`, e.message);
      }
    }
  }
  
  async function safeCheck(locator, label) {
    try {
      if (!locator) return;
      if (!(await ensureReady(locator, label, 2000))) return;
      await withTimeout(locator.check({ force: true }), 1700, `${label}.check`);
      log(`✅ ${label} checked`);
    } catch (e) {
      log(`⚠️ ${label} skipped:`, e.message);
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
      log(`✅ ${label} unchecked`);
    } catch (e) {
      log(`⚠️ ${label} uncheck skipped:`, e.message);
    }
  }
  
  // =========================
  // ✅ Find frame with timeout
  // =========================
  let frame = null;
  try {
    frame = await withTimeout(findTemplateScope(context), 7500, "findTemplateScope(homeSafety)");
  } catch (e) {
    log("⚠️ Template frame timeout for home safety:", e.message);
    return;
  }
  
  if (!frame) {
    log("⚠️ Template frame not found for home safety");
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
          log(`ℹ️ ${label} fuzzy matched "${raw}" → "${hit.label}"`);
          return true;
        }
      }
      
      log(`⚠️ ${label} selectOption failed: no match for "${raw}"`);
      return false;
    } catch (e) {
      log(`⚠️ ${label} selectOption failed:`, e.message);
      return false;
    }
  }
  
  // ---- Patient lives dropdown (#frm_PatLives) ----
  try {
    const livesSelect = frame.locator("#frm_PatLives").first();
    const ok = await safeSelect(livesSelect, living.patientLivesValue, "Patient lives (#frm_PatLives)");
    if (ok) log("🏠 Patient lives set:", living.patientLivesValue);
  } catch (e) {
    log("⚠️ Could not set Patient lives:", e.message);
  }
  
  // ---- Assistance available dropdown (#frm_AsstAvail) ----
  try {
    const asstSelect = frame.locator("#frm_AsstAvail").first();
    const ok = await safeSelect(asstSelect, living.assistanceAvailableValue, "Assistance available (#frm_AsstAvail)");
    if (ok) log("👥 Assistance available set:", living.assistanceAvailableValue);
  } catch (e) {
    log("⚠️ Could not set Assistance available:", e.message);
  }
  
  // ---- Evaluation narrative (#frm_SafetySanHaz13) ----
 try {
	  const evalArea = await firstVisibleLocator(frame, ["#frm_SafetySanHaz13"]);
	  const narrative =
	    (living.safetyNarrative || "").trim() ||
	    (living.evaluationText || "").trim();

	  await safeType(evalArea, narrative, "Living/Safety narrative (#frm_SafetySanHaz13)");
	} catch (e) {
	  log("⚠️ Could not fill Evaluation of Living Situation:", e.message);
	}
  
  // ---- Current Types of Assistance (#frm_CurrTypAsst) ----
  try {
    const currAssist = await firstVisibleLocator(frame, ["#frm_CurrTypAsst", "#frm_CurrentTypesAsst", "#frm_CurrAsstTypes", "textarea[id*=\"CurrTyp\"]", "textarea[name*=\"CurrTyp\"]", "textarea[id*=\"Asst\"][id*=\"Type\"]", "textarea[name*=\"Asst\"][name*=\"Type\"]"]);
    await safeSetValue(
		  currAssist,
		  String(living.currentAssistanceTypes || "").trim(),
		  "Current assistance types (#frm_CurrTypAsst)",
		  60000
		);
  } catch (e) {
    log("⚠️ Could not fill Current Types of Assistance:", e.message);
  }
  
  // ---- Steps / Stairs (#frm_SafetySanHaz2 / #frm_SafetySanHaz3) ----
  try {
    if (living.stepsPresent) {
      const stepsCheckbox = frame.locator("#frm_SafetySanHaz2").first();
      await safeCheck(stepsCheckbox, "Steps/Stairs (#frm_SafetySanHaz2)");
      
      if (living.stepsCount) {
        const stepsText = await firstVisibleLocator(frame, ["#frm_SafetySanHaz3", "#frm_StepsCount", "input[id*=\"Steps\"][type=\"text\"]", "input[name*=\"Steps\"][type=\"text\"]"]);
        await safeType(stepsText, living.stepsCount, "Steps count (#frm_SafetySanHaz3)");
      }
    }
  } catch (e) {
    log("⚠️ Could not fill steps/stairs:", e.message);
  }
  
  // ---- Safety / Sanitation Hazards checkboxes ----
  try {
    const txt = String(living.evaluationText || "").toLowerCase();
    
    // If note explicitly says "No hazards identified", ensure that box is checked (unless we later detect hazards)
    const explicitNoHaz = living.noHazardsIdentified === true;
    
    
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
    
    
    // If explicitly "No hazards identified" and we did NOT detect any hazards, check the box and skip other hazard checks.
    if (explicitNoHaz && !anyHazard) {
      const noHazardsBox = frame.locator("#frm_SafetySanHaz1").first();
      await safeCheck(noHazardsBox, "No hazards identified (#frm_SafetySanHaz1)");
      log("✅ No hazards identified: checked (#frm_SafetySanHaz1)");
      log("✅ Living Situation / Safety Hazards finished.");
      return;
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
    log("⚠️ Error while setting hazard checkboxes:", e.message);
  }
  
  log("✅ Living Situation / Safety Hazards finished.");
}

/**
 * Backwards-compatible wrapper so ptEvaluationBot can still call fillLivingSituation.
 * Internally it just calls fillHomeSafetySection with the same data.
 */
async function fillLivingSituation(context, data) {
  log("ℹ️ fillLivingSituation() wrapper → calling fillHomeSafetySection()");
  await fillHomeSafetySection(context, data);
}

/* =========================
 * Treatment Goals + Pain Plan
 * =======================*/


async function fillTreatmentGoalsAndPainPlan(context, data) {
  log("➡️ Filling Treatment Goals + Pain Plan...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    log("⚠️ Template frame not found for goals/plan.");
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
    
    if (!box) {
      log("⚠️ Plan for next visit checkbox not found");
      return;
    }
    
    const checked = await box.isChecked().catch(() => false);
    if (!checked) {
      await box.check({ force: true }).catch(() => {});
      log("☑️ Plan for next visit checkbox checked");
    }
  }
  
  let goalTexts = [];
  

// Clean goal text: remove embedded "within X visits" or similar visit-count phrasing.
// (Visit counts belong in Time Frame column, not inside the goal sentence.)
function scrubGoalText(s) {
  return String(s || "")
    .replace(/\bwithin\s+(?:a\s+)?(?:total\s+of\s+)?\d{1,2}\s*visits?\b\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

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
      goalTexts[i] = scrubGoalText((aiGoalLines[i] && aiGoalLines[i].trim()) || defaultGoals[i]);
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
      log("📝 Plan for next visit text filled");
    } else {
      log("⚠️ Plan for next visit textbox not found");
    }
  } else {
    log("ℹ️ No plan.planText provided; plan box/text skipped.");
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
      
      log("✅ Pain treatment plan filled.");
    } catch (e) {
      log("⚠️ Could not fill pain treatment plan:", e.message);
    }
  } else {
    log("ℹ️ No pain detected: pain plan not filled.");
  }
}

/* =========================
 * DME
 * =======================*/

async function fillDMESection(context, data) {
  log("➡️ Filling DME section...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    log("⚠️ Template frame not found for DME.");
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
      log(`🧰 DME ${key}: ${flag ? "checked" : "unchecked"}`);
    } catch (e) {
      log(`⚠️ DME ${key} error:`, e.message);
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
  log("➡️ Filling Functional (FAPT) section...");
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    log("⚠️ Template frame not found for FAPT.");
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
  
  // =========================
  // Factors Contributing to Functional Impairment (Comments)
  // =========================
  try {
    const bedTxt = (func.bedMobilityFactors || "").trim();
    if (bedTxt) {
      const f = await firstVisibleLocator(frame, ["#frm_FAPTBedMobComments"]);
      if (f) {
        await f.fill("").catch(() => {});
        await f.type(bedTxt, { delay: 10 }).catch(() => {});
      }
    }
  } catch (e) {
    log("⚠️ Could not fill Bed Mobility factors:", e.message);
  }
  
  try {
    const transTxt = (func.transfersFactors || "").trim();
    if (transTxt) {
      const f = await firstVisibleLocator(frame, ["#frm_FAPT22"]);
      if (f) {
        await f.fill("").catch(() => {});
        await f.type(transTxt, { delay: 10 }).catch(() => {});
      }
    }
  } catch (e) {
    log("⚠️ Could not fill Transfer factors:", e.message);
  }
  
  try {
    const gaitTxt = (func.gaitFactors || "").trim();
    if (gaitTxt) {
      const f = await firstVisibleLocator(frame, ["#frm_FAPT35"]);
      if (f) {
        await f.fill("").catch(() => {});
        await f.type(gaitTxt, { delay: 10 }).catch(() => {});
      }
    }
  } catch (e) {
    log("⚠️ Could not fill Gait factors:", e.message);
  }
  
}


/* =========================
 * Frequency + Effective Date
 * =======================*/

async function fillFrequencyAndDate(context, data, visitDate) {
  log("➡️ Filling Frequency + Effective Date...");

  const frame = await findTemplateScope(context);
  if (!frame) {
    log("⚠️ Template frame not found for plan.");
    return;
  }

  const plan = data.plan || {};

  // --- Effective Date (frm_FreqDur1) ---
  try {
    const effField = await firstVisibleLocator(frame, ["#frm_FreqDur1"]);
    if (effField) {
      const effectiveRaw =
        plan.effectiveDate && plan.effectiveDate !== "skip"
          ? plan.effectiveDate
          : visitDate;

      const effective = normalizeDateToMMDDYYYY(effectiveRaw);

      log("📆 Effective date (raw → normalized):", effectiveRaw, "→", effective);

      await effField.fill("").catch(() => {});
      await effField.fill(effective).catch(() => {});
      await effField.evaluate((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      }).catch(() => {});
    }
  } catch (e) {
    log("⚠️ Could not fill Effective Date:", e?.message || String(e));
  }

  // --- Frequency (frm_FreqDur2) ---
  try {
    if (plan.frequency) {
      const rawFreq = String(plan.frequency || "").trim();

      const tokens = [...rawFreq.matchAll(/\b\d+w\d+\b/gi)]
        .map((m) => m[0].toLowerCase())
        .slice(0, 6);

      const normFreq = tokens.length
        ? tokens.join(", ")
        : rawFreq
            .replace(/[`"'<>]/g, "")
            .replace(/\s+/g, " ")
            .trim();

      log("🧾 Frequency raw → normalized:", rawFreq, "→", normFreq);

      const freqField = await firstVisibleLocator(frame, ["#frm_FreqDur2"]);
      if (freqField) {
        await freqField.fill("").catch(() => {});
        await freqField.fill(normFreq).catch(() => {});
        await freqField.evaluate((el) => {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        }).catch(() => {});
        log("📆 Frequency filled:", normFreq);
      }
    } else {
      log("ℹ️ No plan.frequency provided; skipping frequency fill.");
    }
  } catch (e) {
    log("⚠️ Could not fill Frequency:", e?.message || String(e));
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
  
  log("🧮 parseRomAndStrength parsed:", result);
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
    log("ℹ️ No romStrength data from AI.");
    return;
  }
  
  const frame = await findTemplateScope(context);
  if (!frame) {
    log("⚠️ Template frame not found for ROM/Strength.");
    return;
  }
  
  const { ue, le } = romStrength || {};
  
  log("🧮 ROM/Strength parsed:", romStrength);
  
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
  if (scope && typeof scope.pages === "function" && typeof scope.locator !== "function") {
    const pages = scope.pages();
    if (pages && pages.length) scope = pages[0];
  }

  function normalizeScope(s) {
    if (s && typeof s.locator === "function") return s; // Page/Frame
    if (s?.page && typeof s.page.locator === "function") return s.page;
    if (s?.frame && typeof s.frame.locator === "function") return s.frame;

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

  // Heuristic: does popup message look like a validation failure?
  function isBadDialogMessage(msg = "") {
    const m = String(msg || "").toLowerCase();
    return (
      m.includes("error") ||
      m.includes("required") ||
      m.includes("missing") ||
      m.includes("cannot") ||
      m.includes("unable") ||
      m.includes("invalid") ||
      m.includes("please correct") ||
      m.includes("must be") ||
      m.includes("failed")
    );
  }

  async function assertNoOnPageErrors(pageOrFrame) {
    // WellSky/Kinnser error containers — keep this tight to avoid false positives
    const errorSelectors = [
      ".validation-summary-errors",
      ".validation-summary",
      ".field-validation-error",
      "#error",
      "#errors",
      "text=/please correct/i",
      "text=/validation/i",
      "text=/required/i",
      "text=/unable to save/i",
      "text=/error occurred/i",
    ];

    for (const sel of errorSelectors) {
      const loc = pageOrFrame.locator(sel).first();
      const visible = await loc.isVisible().catch(() => false);
      if (!visible) continue;

      const txt = (await loc.innerText().catch(() => "")).trim();

      // Only fail if there is meaningful error text (avoid empty containers)
      if (txt && txt.length >= 3) {
        throw new Error(`SAVE_VALIDATION_ERROR: ${txt.slice(0, 500)}`);
      }
    }
  }

  async function tryClick(s, label) {
    const pageOrFrame = normalizeScope(s);

    // For dialog listening we need the underlying Page object
    const page = typeof pageOrFrame.page === "function" ? pageOrFrame.page() : pageOrFrame;

    for (const sel of saveSelectors) {
      const loc = pageOrFrame.locator(sel).first();
      const visible = await loc.isVisible().catch(() => false);
      if (!visible) continue;

      await loc.scrollIntoViewIfNeeded().catch(() => {});

      // Start listening for dialog BEFORE clicking.
      const dialogPromise =
        typeof page.waitForEvent === "function"
          ? page.waitForEvent("dialog", { timeout: 8000 }).catch(() => null)
          : Promise.resolve(null);

      try {
        await loc.click({ force: true, timeout: 8000 });
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

      log(`✅ Clicked Save (${label}) using selector: ${sel}`);

      // Wait a moment for Kinnser save routines
      try {
        if (typeof page.waitForLoadState === "function") {
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        }
      } catch {}

      // If a dialog appeared, inspect its message.
      const dlg = await dialogPromise;
      if (dlg) {
        const msg = dlg.message?.() || "";
        log(`⚠️ Save popup detected: ${msg}`);

        // The global dialog handler already accepts, but we try accepting safely anyway.
        try { await dlg.accept(); } catch {}

        if (isBadDialogMessage(msg)) {
          throw new Error(`SAVE_POPUP_ERROR: ${msg}`);
        }
      } else {
        // No dialog captured. Still allow time for any inline validation to render.
        await wait(1000);
      }

      // Check for inline page validation/errors after save
      await assertNoOnPageErrors(pageOrFrame);

      // Extra settle time for Kinnser to persist
      await wait(1500);
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

  throw new Error("SAVE_BUTTON_NOT_FOUND");
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

// bots/ptEvaluationBot.js
// PT INITIAL EVALUATION bot runner (GW2)

async function runPtEvaluationBot({
  kinnserUsername,
  kinnserPassword,
  patientName,
  visitDate,
  taskType,
  timeIn,
  timeOut,
  aiNotes,
}) {
  const { browser, context, page } = await launchBrowserContext();
  
  try {
    // 1) Login
    await loginToKinnser(page, { kinnserUsername, kinnserPassword });
    
    // 2) Hotbox
    await navigateToHotBox(page);
    await setHotboxShow100(page);
    
    // 3) Open Hotbox row
    await openHotboxPatientTask(page, patientName, visitDate, taskType);
    
    // 4) Select Template
    await selectTemplateGW2(context);
    
    // 5) Visit basics
    await fillVisitBasics(context, { timeIn, timeOut, visitDate });
    
    // 6) Parse AI notes (Eval)
    const aiData = await extractNoteDataFromAI(aiNotes, "Evaluation");
    
    // 7) Vitals + Relevant History + Clinical Statement
    // NOTE: your fillVitalsAndNarratives() already fills frm_RlvntMedHist + frm_EASI1 per your code
    await fillVitalsAndNarratives(context, aiData);
    
    // 8) Medical Dx (frm_MedDiagText)
    await fillMedDiagnosisAndSubjective(context, aiData);
    
    // 9) Subjective
    await fillSubjectiveOnly(context, aiData);
    
    // 10) Prior level + Patient goals
    await fillPriorLevelAndPatientGoals(context, aiData);
    
    // 11) Living situation / safety hazards
    await fillHomeSafetySection(context, aiData);
    
    // 12) Pain section
    await fillPainSection(context, aiData);
    
    // 13) Neuro / Physical assessment text fields
    await fillNeuroPhysical(context, aiData);
    
    // 14) Edema
    await fillEdemaSection(context, aiData);
    
    // 15) ROM/Strength
    await fillPhysicalRomStrength(context, aiData.romStrength);
    
    // 16) Functional (FAPT)
    await fillFunctionalSection(context, aiData);
    
    // 17) DME checkboxes + other
    await fillDMESection(context, aiData);
    
    // 18) Treatment goals + pain plan (if pain)
    await fillTreatmentGoalsAndPainPlan(context, aiData);
    
    // 19) Frequency + effective date
    await fillFrequencyAndDate(context, aiData, visitDate);
    
    await clickSave(page);
    await wait(2000);
    
  } finally {
    // await browser.close();
  }
}

module.exports = { runPtEvaluationBot };
