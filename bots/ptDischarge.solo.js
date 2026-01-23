// =========================
// SOLO BOT FILE (no ./common.js dependency)
// PT DISCHARGE (robust, matches PT Visit sequence)
// - Login (same selectors as PT Visit)
// - Navigate to HotBox (robust)
// - Open HotBox row (fuzzy match)
// - Fill visit basics: date + time in/out (before any other fields)
// - Fill Discharge Page 1 -> Save & Continue -> wait Page 2 -> Fill -> Save
// - No GW2 selection
// - No runtime OpenAI (fill strictly from aiNotes/template text)
// =========================

const { chromium } = require("playwright");
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const BASE_URL = process.env.KINNSER_URL || "https://www.kinnser.net/login.cfm";
const USERNAME = process.env.KINNSER_USERNAME;
const PASSWORD = process.env.KINNSER_PASSWORD;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* =========================
 * Browser launcher (match PT Visit)
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
      console.log("⚠️ Popup already handled:", e?.message || e);
    }
  });

  return { browser, context, page };
}

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

/* =========================
 * LOGIN (match PT Visit selectors)
 * =======================*/
async function loginToKinnser(page, creds = {}) {
  const finalUsername = (creds.username || creds.kinnserUsername || USERNAME || "").trim();
  const finalPassword = creds.password || creds.kinnserPassword || PASSWORD || "";

  if (!finalUsername || !finalPassword) {
    throw new Error(
      "LoginToKinnser: missing username/password. Either fill them in the UI or set KINNSER_USERNAME / KINNSER_PASSWORD."
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

  // Session conflict / terminate other session (copied behavior)
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
        console.log("⚠️ Session lock detected. Terminating other session...");
        await loc.click().catch(() => {});
        await wait(2000);
        return true;
      }
    }
    return false;
  }
  await maybeTerminateOtherSession();

  console.log("✅ Login complete");
}

/* =========================
 * Go To → HotBox (match PT Visit)
 * =======================*/
async function findHotboxFrame(page) {
  for (const frame of page.frames()) {
    if (await frame.locator("text=Hotbox").first().isVisible().catch(() => false)) return frame;
  }
  return page;
}

async function isAlreadyOnHotbox(page) {
  for (const frame of page.frames()) {
    const hasAnchor = await frame.locator("a.hotbox.default").first().isVisible().catch(() => false);
    const hasSelect = await frame.locator("select.task-target-date").first().isVisible().catch(() => false);
    if (hasAnchor || hasSelect) return true;
  }
  return false;
}

async function navigateToHotBox(page) {
  console.log("➡️ Checking if we are already on the HotBox screen...");

  if (await isAlreadyOnHotbox(page)) {
    console.log("🔥 Already on HotBox; skipping navigation.");
    return;
  }

  console.log("➡️ Navigating to HotBox (robust mode)...");
  await wait(1000);

  // Direct Hotbox link
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
  } catch {}

  // Go To → HotBox (page or frames)
  const goToSelectors = ['text=/^go to$/i', 'a:has-text("Go To")', "text=/go to/i"];
  let goToLocator = await firstVisibleLocator(page, goToSelectors);
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

      let hotboxMenu = await firstVisibleLocator(page, ['text=/hotbox/i', 'a:has-text("HotBox")']);
      if (!hotboxMenu) {
        for (const frame of page.frames()) {
          hotboxMenu = await firstVisibleLocator(frame, ['text=/hotbox/i', 'a:has-text("HotBox")']);
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
      console.log("⚠️ Failed Go To navigation:", e?.message || e);
    }
  }

  // Last resort direct URLs
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
    } catch {}
  }

  throw new Error("Unable to navigate to HotBox (layout differs or access blocked).");
}

async function setHotboxShow100(page) {
  console.log("➡️ Setting Hotbox to Show 100 entries...");
  await wait(1200);

  const frame = await findHotboxFrame(page);

  try {
    await frame.waitForSelector("select[name='resultsTable_length']", { timeout: 1500 });
  } catch {
    console.log("⚠️ Hotbox 'Show' dropdown not found within timeout");
    return;
  }

  const dropdown = frame.locator("select[name='resultsTable_length']").first();

  try {
    await dropdown.waitFor({ state: "visible", timeout: 1500 });
  } catch {
    console.log("⚠️ Hotbox 'Show' dropdown never became visible");
    return;
  }

  try {
    await dropdown.selectOption("100");
    console.log("✅ Show 100 selected via selectOption");
  } catch (err) {
    console.log("⚠️ selectOption failed, retrying via click:", err?.message || err);
    try {
      await dropdown.click();
      await wait(500);
      await frame.locator("option[value='100']").first().click();
      console.log("✅ Show 100 selected by clicking option");
    } catch (err2) {
      console.log("❌ Could not select '100':", err2?.message || err2);
    }
  }

  await wait(1000);
}

/* =========================
 * Open HotBox patient row (fuzzy task match)
 * =======================*/
async function openHotboxPatientTask(page, patientName, visitDate, taskType) {
  console.log(`➡️ Searching Hotbox for patient "${patientName}" on "${visitDate}" with task "${taskType}"...`);

  if (!patientName || !visitDate || !taskType) {
    throw new Error("openHotboxPatientTask requires patientName, visitDate, and taskType.");
  }

  function buildDateVariants(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return [];

    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split("-");
      const mm = String(Number(m)).padStart(2, "0");
      const dd = String(Number(d)).padStart(2, "0");
      const yyyy = y;
      const yy = y.slice(-2);
      return [`${mm}/${dd}/${yyyy}`, `${mm}/${dd}/${yy}`, `${Number(m)}/${Number(d)}/${yyyy}`, `${Number(m)}/${Number(d)}/${yy}`];
    }

    if (s.includes("/")) {
      const parts = s.split("/");
      if (parts.length === 3) {
        let [m, d, y] = parts.map((p) => p.trim());
        const mm = String(Number(m)).padStart(2, "0");
        const dd = String(Number(d)).padStart(2, "0");
        if (y.length === 2) {
          const yy = y.padStart(2, "0");
          const yyyy = `20${yy}`;
          return [`${mm}/${dd}/${yyyy}`, `${mm}/${dd}/${yy}`, `${Number(m)}/${Number(d)}/${yyyy}`, `${Number(m)}/${Number(d)}/${yy}`];
        } else {
          const yyyy = y;
          const yy = y.slice(-2);
          return [`${mm}/${dd}/${yyyy}`, `${mm}/${dd}/${yy}`, `${Number(m)}/${Number(d)}/${yyyy}`, `${Number(m)}/${Number(d)}/${yy}`];
        }
      }
    }

    return [s];
  }

  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.]/g, "")
      .trim();
  }

  function normalizeTask(t = "") {
    return norm(t)
      .replace(/re-evaluation/g, "reeval")
      .replace(/re evaluation/g, "reeval")
      .replace(/re-eval/g, "reeval")
      .replace(/evaluation/g, "eval")
      .replace(/visit/g, "visit")
      .replace(/discharge/g, "discharge");
  }

  function taskMatches(rowText, desiredTask) {
    const a = normalizeTask(rowText);
    const b = normalizeTask(desiredTask);

    if (a.includes(b) || b.includes(a)) return true;
    if (b.includes("eval") && a.includes("eval")) return true;
    if (b.includes("visit") && a.includes("visit")) return true;
    if (b.includes("discharge") && a.includes("discharge")) return true;
    return false;
  }

  const dateVariants = buildDateVariants(visitDate);
  console.log("🔎 Date variants for Hotbox search:", dateVariants);

  let row = null;

  for (const dateStr of dateVariants) {
    const candidates = page.locator("tr").filter({ hasText: patientName }).filter({ hasText: dateStr });
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
    throw new Error(`Hotbox row not found for date variants ${JSON.stringify(dateVariants)} and task "${taskType}".`);
  }

  console.log("✅ Matching row found. Clicking patient link...");

  let link = row.locator(`a:has-text("${patientName}")`).first();
  let linkVisible = await link.isVisible().catch(() => false);
  if (!linkVisible) {
    link = row.locator("a").first();
    linkVisible = await link.isVisible().catch(() => false);
  }
  if (!linkVisible) throw new Error("Patient link not found in matching row.");

  await link.click();
  await wait(1000);

  console.log("👤 Note opened (Hotbox row matched).");
}

/* =========================
 * Template scope (iframe-aware)
 * =======================*/
async function findTemplateScope(target, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || 12000);
  const pollMs = Number(opts.pollMs || 300);
  const deadline = Date.now() + timeoutMs;

  const FORM_PROBES = [
    "#frm_visitdate",
    "#frm_timein",
    "#frm_timeout",
    "#frm_VSComments",
    "#frm_DischargeDate",
    "[id^='frm_']",
    "textarea[id^='frm_']",
    "input[id^='frm_']",
    "select[id^='frm_']",
  ];

  function resolvePages(x) {
    if (!x) return [];
    if (typeof x.pages === "function") return x.pages(); // BrowserContext
    if (typeof x.frames === "function") return [x]; // Page
    if (x.page && typeof x.page.frames === "function") return [x.page];
    if (x.context && typeof x.context.pages === "function") return x.context.pages();
    return [];
  }

  async function probeScope(scope) {
    for (const sel of FORM_PROBES) {
      try {
        const loc = scope.locator(sel).first();
        if (await loc.isVisible().catch(() => false)) return true;
      } catch {}
    }
    return false;
  }

  while (Date.now() < deadline) {
    const pages = resolvePages(target);

    for (const page of pages) {
      for (const frame of page.frames()) {
        if (await probeScope(frame)) return frame;
      }
      if (await probeScope(page)) return page;
    }

    await wait(pollMs);
  }

  return null;
}

/* =========================
 * Normalize date/time like PT Visit
 * =======================*/
function normalizeDateToMMDDYYYY(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return s;

  if (s.includes("-")) {
    const [y, m, d] = s.split("-");
    if (y && m && d) return `${m.padStart(2, "0")}/${d.padStart(2, "0")}/${y}`;
  }

  if (s.includes("/")) {
    const parts = s.split("/");
    if (parts.length === 3) {
      let [m, d, y] = parts.map((p) => p.trim());
      const mm = m.padStart(2, "0");
      const dd = d.padStart(2, "0");
      if (y.length === 2) return `${mm}/${dd}/20${y.padStart(2, "0")}`;
      return `${mm}/${dd}/${y}`;
    }
  }

  return s;
}

function normalizeTimeToHHMM(value) {
  if (value === null || value === undefined) return "";
  let v = String(value).trim();

  const hm = v.match(/^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (Number.isFinite(h) && Number.isFinite(m)) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  const digits = v.replace(/[^0-9]/g, "");
  if (/^\d{3,4}$/.test(digits)) {
    const padded = digits.padStart(4, "0");
    return `${padded.slice(0, 2)}:${padded.slice(2, 4)}`;
  }

  return v;
}

async function fillVisitBasics(target, { timeIn, timeOut, visitDate }) {
  console.log("➡️ Filling visit basics (date/time)...");
  await wait(1000);

  const frame = await findTemplateScope(target, { timeoutMs: 15000 });
  if (!frame) throw new Error("Template scope not found for visit basics.");

  const ti = normalizeTimeToHHMM(timeIn);
  const to = normalizeTimeToHHMM(timeOut);
  const vd = normalizeDateToMMDDYYYY(visitDate);

  const timeInInput = await firstVisibleLocator(frame, ["#frm_timein", "input[name^='frm_timein']"]);
  if (timeInInput && ti) {
    await timeInInput.fill("");
    await timeInInput.type(ti, { delay: 40 });
    console.log("⏱ Time In filled:", ti);
  }

  const timeOutInput = await firstVisibleLocator(frame, ["#frm_timeout", "input[name^='frm_timeout']"]);
  if (timeOutInput && to) {
    await timeOutInput.fill("");
    await timeOutInput.type(to, { delay: 40 });
    console.log("⏱ Time Out filled:", to);
  }

  const dateInput = await firstVisibleLocator(frame, ["#frm_visitdate", "input[name^='frm_visitdate']"]);
  if (dateInput && vd) {
    await dateInput.fill("");
    await dateInput.type(vd, { delay: 40 });
    console.log("📅 Visit Date filled:", vd);
  }

  console.log("✅ Visit basics finished");
}

/* =========================
 * Parse aiNotes (Discharge template)
 * =======================*/
function pickLine(text, labelRegex) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    if (labelRegex.test(line)) return line;
  }
  return "";
}

function parseAfterColon(line) {
  const m = String(line || "").match(/:\s*(.*)\s*$/);
  return m ? m[1].trim() : "";
}

function parseBP(bpText) {
  const t = String(bpText || "");
  const m = t.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
  if (!m) return { sys: "", dia: "" };
  return { sys: m[1], dia: m[2] };
}

function parseYesNoBlank(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "";
  if (v === "yes" || v === "y") return "yes";
  if (v === "no" || v === "n") return "no";
  return v;
}

function toMMDDYYYY(s) {
  return normalizeDateToMMDDYYYY(s);
}

function parseDischargeTemplate(aiNotes, visitDate) {
  const t = String(aiNotes || "");
  const visitDateMMDD = toMMDDYYYY(visitDate);

  const temp = parseAfterColon(pickLine(t, /^\s*temp\s*:/i));
  const tempType = parseAfterColon(pickLine(t, /^\s*temp\s*type\s*:/i));
  const bpRaw = pickLine(t, /^\s*bp\s*:/i);
  const bp = parseBP(bpRaw);
  const hr = parseAfterColon(pickLine(t, /^\s*heart\s*rate\s*:/i));
  const rr = parseAfterColon(pickLine(t, /^\s*resp(irations)?\s*:/i));
  const vsComments = parseAfterColon(pickLine(t, /^\s*comments\s*:/i));

  const painVal = parseYesNoBlank(parseAfterColon(pickLine(t, /^\s*pain\s*:/i)));

  function p(label) {
    return parseAfterColon(pickLine(t, new RegExp(`^\\s*${label}\\s*:`, "i")));
  }

  const rolling = p("Rolling");
  const supToSit = p("Sup\\s*to\\s*Sit");
  const sitToSup = p("Sit\\s*to\\s*Sup");

  const sitToStand = p("Sit\\s*to\\s*Stand");
  const standToSit = p("Stand\\s*to\\s*Sit");
  const toiletBSC = p("Toilet\\s*\\/\\s*BSC");
  const tubShower = p("Tub\\s*\\/\\s*Shower");

  const gaitLevel = p("Gait\\s*[-–]?\\s*Level");
  const distance = p("Distance");
  const gaitUnlevel = p("Gait\\s*[-–]?\\s*Unlevel");
  const steps = p("Steps\\/stairs");

  const sittingBal = p("Sitting");
  const standingBal = p("Standing");

  const evalTestDesc = p("Evaluation and Testing Description");
  const skilledIntervention = p("Treatment\\s*\\/\\s*Skilled Intervention");

  const goalsMetYN = parseYesNoBlank(p("Goals Met"));
  const goalsNotMetYN = parseYesNoBlank(p("Goals not Met"));
  const goalsSummary = p("Goals Summary");

  const dischargeDateLine = p("Discharge Date");
  const dischargeDate = dischargeDateLine ? toMMDDYYYY(dischargeDateLine) : visitDateMMDD;

  const reasonForDC = p("Reason for discharge");
  const currentStatus = p("Current Status");
  const phyPsych = p("Physical and Psychological Status");

  const servicesProvided = p("Services Provided");
  const frequencyDuration = p("Frequency\\/Duration");
  const progressResponse = p("Patient Progress\\/Response");

  const postDischargeGoals = p("Post Discharge Goals");
  const infoProvided = p("Information Provided");
  const treatmentPrefs = p("Treatment Preferences");

  return {
    temp,
    tempType,
    bpSys: bp.sys,
    bpDia: bp.dia,
    hr,
    rr,
    vsComments,
    painVal,

    rolling,
    supToSit,
    sitToSup,

    sitToStand,
    standToSit,
    toiletBSC,
    tubShower,

    gaitLevel,
    distance,
    gaitUnlevel,
    steps,

    sittingBal,
    standingBal,

    evalTestDesc,
    skilledIntervention,

    goalsMetCheck: goalsMetYN === "yes",
    goalsNotMetCheck: goalsNotMetYN === "yes",
    goalsSummary,

    dischargeDate,
    reasonForDC,
    currentStatus,
    phyPsych,

    servicesProvided,
    frequencyDuration,
    progressResponse,

    postDischargeGoals,
    infoProvided,
    treatmentPrefs,
  };
}

/* =========================
 * Field fillers (2 pages)
 * =======================*/
async function safeFillById(scope, id, value) {
  const v = String(value ?? "").trim();
  if (!v) return false;

  const loc = scope.locator(`#${id}`).first();
  const visible = await loc.isVisible().catch(() => false);
  if (!visible) return false;

  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const tag = await loc.evaluate((el) => (el?.tagName ? el.tagName.toLowerCase() : "")).catch(() => "");
  if (!tag) return false;

  if (tag === "select") {
    await loc.selectOption({ label: v }).catch(async () => {
      await loc.selectOption({ value: v }).catch(() => {});
    });
  } else {
    await loc.fill("").catch(() => {});
    await loc.type(v, { delay: 20 }).catch(async () => {
      await loc.fill(v).catch(() => {});
    });
  }

  return true;
}

async function safeCheckById(scope, id, shouldCheck) {
  if (!shouldCheck) return false;
  const loc = scope.locator(`#${id}`).first();
  const visible = await loc.isVisible().catch(() => false);
  if (!visible) return false;

  const type = await loc.getAttribute("type").catch(() => "");
  if (type !== "checkbox" && type !== "radio") return false;

  const checked = await loc.isChecked().catch(() => false);
  if (!checked) {
    await loc.check({ force: true }).catch(async () => {
      await loc.click({ force: true }).catch(() => {});
    });
  }
  return true;
}

async function fillDischargePage1(activePageOrContext, data) {
  console.log("➡️ Filling Discharge Page 1...");
  const frame = await findTemplateScope(activePageOrContext, { timeoutMs: 20000 });
  if (!frame) throw new Error("Template scope not found on Discharge Page 1.");

  // Auto-check homebound (always)
  await safeCheckById(frame, "frm_hsHomedYes", true);
  await safeCheckById(frame, "frm_hsResWeak", true);
  await safeCheckById(frame, "frm_hsLeaveUnattd", true);

  // Vitals
  await safeFillById(frame, "frm_VSTemperature", data.temp);
  await safeFillById(frame, "frm_VSTemperatureType", data.tempType);
  await safeFillById(frame, "frm_VSPriorBPsys", data.bpSys);
  await safeFillById(frame, "frm_VSPriorBPdia", data.bpDia);
  await safeFillById(frame, "frm_VSPriorHeartRate", data.hr);
  await safeFillById(frame, "frm_VSPriorResp", data.rr);
  await safeFillById(frame, "frm_VSComments", data.vsComments);

  // Pain: blank => do nothing; No => check; Yes => leave alone
  if (data.painVal === "no") await safeCheckById(frame, "frm_PainAsmtNoPain", true);

  // Functional
  await safeFillById(frame, "frm_BMRollingALDC", data.rolling);
  await safeFillById(frame, "frm_BMSupSitALDC", data.supToSit);
  await safeFillById(frame, "frm_BMSitSupALDC", data.sitToSup);

  await safeFillById(frame, "frm_TransSitStandALDC", data.sitToStand);
  await safeFillById(frame, "frm_TransStandSitALDC", data.standToSit);
  await safeFillById(frame, "frm_TransToiletBSCALDC", data.toiletBSC);
  await safeFillById(frame, "frm_TransTubShowerALDC", data.tubShower);

  await safeFillById(frame, "frm_GaitLevelALDC", data.gaitLevel);
  await safeFillById(frame, "frm_GaitLevelAmtDC", data.distance);
  await safeFillById(frame, "frm_GaitUnLevelALDC", data.gaitUnlevel);
  await safeFillById(frame, "frm_GaitStepsStairsALDC", data.steps);

  await safeFillById(frame, "frm_BalanceSitALDC", data.sittingBal);
  await safeFillById(frame, "frm_BalanceStandALDC", data.standingBal);

  await safeFillById(frame, "frm_BalanceEvalTestDC", data.evalTestDesc);
  await safeFillById(frame, "frm_trtmntSIV", data.skilledIntervention);

  // Goals: only check when explicitly Yes
  await safeCheckById(frame, "frm_GoalsAllMetDC", !!data.goalsMetCheck);
  await safeCheckById(frame, "frm_GoalsPartMegDC", !!data.goalsNotMetCheck);
  await safeFillById(frame, "frm_GoalsSummaryDC", data.goalsSummary);

  // Auto-check disposition
  await safeCheckById(frame, "frm_DCDispositionHomeExer", true);
  await safeCheckById(frame, "frm_DCPTOnly", true);

  console.log("✅ Discharge Page 1 filled");
}

async function clickSaveAndContinue(activePage) {
  console.log("➡️ Save & Continue...");
  // Button is usually on the page (not inside template iframe); search page + frames
  const selectors = [
    "input[name='sc'][value*='Save']",
    "input[value*='Save'][name='sc']",
    "text=Save & Continue",
    "button:has-text('Save & Continue')",
  ];

  let btn = await firstVisibleLocator(activePage, selectors);
  if (!btn) {
    for (const frame of activePage.frames()) {
      btn = await firstVisibleLocator(frame, selectors);
      if (btn) break;
    }
  }
  if (!btn) throw new Error("Save & Continue button not found on Discharge Page 1.");

  await btn.click({ force: true }).catch(async () => {
    await btn.click().catch(() => {});
  });

  await wait(1200);
}

async function waitForPage2(activePageOrContext) {
  console.log("➡️ Waiting for Page 2 marker (#frm_DischargeDate)...");
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const scope = await findTemplateScope(activePageOrContext, { timeoutMs: 1500 }).catch(() => null);
    if (scope) {
      const has = await scope.locator("#frm_DischargeDate").first().isVisible().catch(() => false);
      if (has) {
        console.log("✅ Page 2 detected");
        return;
      }
    }
    await wait(400);
  }
  console.log("⚠️ Page 2 marker not detected within 30s; continuing.");
}

async function fillDischargePage2(activePageOrContext, data) {
  console.log("➡️ Filling Discharge Page 2...");
  const frame = await findTemplateScope(activePageOrContext, { timeoutMs: 20000 });
  if (!frame) throw new Error("Template scope not found on Discharge Page 2.");

  await safeFillById(frame, "frm_DischargeDate", data.dischargeDate);
  await safeFillById(frame, "frm_OtherDCReason", data.reasonForDC);

  await safeFillById(frame, "frm_CurrentStatus", data.currentStatus);
  await safeFillById(frame, "frm_PhyPsych", data.phyPsych);

  await safeCheckById(frame, "frm_physical_therapy", true);
  await safeFillById(frame, "frm_physical_therapy_services", data.servicesProvided);
  await safeFillById(frame, "frm_physical_therapy_frequency", data.frequencyDuration);
  await safeFillById(frame, "frm_physical_therapy_progress", data.progressResponse);

  // Outcomes auto-check
  await safeCheckById(frame, "frm_ImprovedCond", true);
  await safeCheckById(frame, "frm_ImprovedKnow", true);
  await safeCheckById(frame, "frm_ImprovedInd", true);
  await safeCheckById(frame, "frm_ImprovedFunc", true);

  await safeFillById(frame, "frm_PostDischargeGoals", data.postDischargeGoals);

  // Discharge Information auto-check
  const mustCheck = [
    "frm_DischargeInsY",
    "frm_MedFollowupY",
    "frm_MedFollowupVerbalY",
    "frm_MedicationRevN",
    "frm_ComprehendInstructionsY",
    "frm_CallAgencyY",
    "frm_InformedPriorY",
    "frm_DischargeInsPatient",
    "frm_MedFollowupPatient",
    "frm_MedFollowupVerbalPatient",
    "frm_ComprehendInstructionsPatient",
    "frm_CallAgencyPatient",
    "frm_InformedPriorPatient",
  ];
  for (const id of mustCheck) await safeCheckById(frame, id, true);

  // Continuing needs auto-check
  const contChecks = [
    "frm_ToPatient",
    "frm_LiveArrangeDCHome",
    "frm_CareCoordDCPhysNotifiedPrDCDate",
    "frm_CareCoordDCPhysNotifiedDCSumm",
    "frm_CareCoordDCOrderSummComplete",
    "frm_CareCoordDCSchedNotified",
  ];
  for (const id of contChecks) await safeCheckById(frame, id, true);

  await safeFillById(frame, "frm_InfoProvided", data.infoProvided);
  await safeFillById(frame, "frm_TreatmentPreferences", data.treatmentPrefs);

  console.log("✅ Discharge Page 2 filled");
}

async function clickSave(activePage) {
  console.log("➡️ Saving (final)...");
  const selectors = ["input[value='Save']", "button:has-text('Save')", "text=Save", "input[name='btnSave']", "#btnSave"];

  let btn = await firstVisibleLocator(activePage, selectors);
  if (!btn) {
    for (const frame of activePage.frames()) {
      btn = await firstVisibleLocator(frame, selectors);
      if (btn) break;
    }
  }
  if (!btn) throw new Error("Save button not found on Discharge Page 2.");

  await btn.click({ force: true }).catch(async () => {
    await btn.click().catch(() => {});
  });

  await wait(1500);
  console.log("✅ Save clicked");
}

/* =========================
 * MAIN ENTRY
 * =======================*/
async function runPtDischargeBot({
  patientName,
  visitDate,
  timeIn,
  timeOut,
  aiNotes,
  kinnserUsername,
  kinnserPassword,
  taskType,
}) {
  const { browser, context, page } = await launchBrowserContext();

  try {
    console.log("===============================================");
    console.log("          🧾 Starting PT Discharge Bot");
    console.log("===============================================");
    console.log("Patient:", patientName);
    console.log("Visit Date:", visitDate);
    console.log("Task:", taskType || "PT Discharge w/Discharge Summary");
    console.log("-----------------------------------------------");

    await loginToKinnser(page, {
      username: kinnserUsername,
      password: kinnserPassword,
    });

    await navigateToHotBox(page);
    await setHotboxShow100(page);

    const desiredTask = taskType || "PT Discharge w/Discharge Summary";
    await openHotboxPatientTask(page, patientName, visitDate, desiredTask);

    // Kinnser often opens the note in a new tab
    await wait(1200);
    const activePage = getActivePageFromContext(context) || page;

    // 1) Fill date/time FIRST (as requested)
    await fillVisitBasics(activePage, { timeIn, timeOut, visitDate });

    // 2) Parse + fill discharge fields
    const data = parseDischargeTemplate(aiNotes || "", visitDate);

    await fillDischargePage1(activePage, data);
    await clickSaveAndContinue(activePage);

    await waitForPage2(activePage);
    await fillDischargePage2(activePage, data);
    await clickSave(activePage);

    console.log("✅ PT Discharge bot finished successfully");
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { runPtDischargeBot };
