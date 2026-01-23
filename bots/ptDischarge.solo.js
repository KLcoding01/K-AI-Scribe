// =========================
// SOLO BOT FILE (no ./common.js dependency)
// PT DISCHARGE (2-page flow, no GW2 selection)
// - Page 1: fill + Save & Continue
// - Page 2: fill + Save
// Rules per Kelvin:
// - Auto-check Homebound/Residual Weakness/Unable unattended (not needed in template)
// - Pain: if blank => do nothing; if "No" => check NoPain; if "Yes" => leave alone
// - Goals Met / Goals not Met: check only when template explicitly says "Yes"; if blank => skip
// - Auto-check Discharge to HEP + Discharge PT Only (not needed in template)
// - Page 2: Discharge Date = template Discharge Date, else use visitDate (converted to mm/dd/yyyy)
// - Auto-check Outcomes + Discharge Information + Continuing needs checkboxes (not needed in template)
// - No runtime OpenAI; copy-through from aiNotes/template text only
// =========================

const { chromium } = require("playwright");
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env")
});

const BASE_URL = process.env.KINNSER_URL || "https://www.kinnser.net/login.cfm";
const USERNAME = String(process.env.KINNSER_USERNAME || "");
const PASSWORD = String(process.env.KINNSER_PASSWORD || "");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function logStep(job, msg) {
  if (job && typeof job.log === "function") job.log(msg);
  else console.log(msg);
}

async function firstVisibleLocator(scope, selectors) {
  for (const selector of selectors) {
    try {
      const item = scope.locator(selector).first();
      if (await item.isVisible().catch(() => false)) return item;
    } catch {}
  }
  return null;
}

async function safeClick(scope, selectors, opts = {}) {
  const loc = await firstVisibleLocator(scope, Array.isArray(selectors) ? selectors : [selectors]);
  if (!loc) throw new Error(`Could not find clickable element for selectors: ${JSON.stringify(selectors)}`);
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.click({ timeout: opts.timeout || 20000 }).catch(async () => {
    await loc.click({ timeout: opts.timeout || 20000, force: true });
  });
  return true;
}

async function safeFillById(page, id, value) {
  const v = value == null ? "" : String(value);
  const loc = page.locator(`#${id}`).first();
  if (!(await loc.count().catch(() => 0))) return false;

  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const tag = await loc.evaluate((el) => (el && el.tagName ? el.tagName.toLowerCase() : "")).catch(() => "");
  if (!tag) return false;

  if (tag === "input" || tag === "textarea") {
    await loc.fill(v).catch(async () => {
      await loc.click().catch(() => {});
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.type(v).catch(() => {});
    });
    return true;
  }

  if (tag === "select") {
    await loc.selectOption({ label: v }).catch(async () => {
      await loc.selectOption({ value: v }).catch(() => {});
    });
    return true;
  }

  return false;
}

async function safeCheckById(page, id, shouldCheck) {
  const loc = page.locator(`#${id}`).first();
  if (!(await loc.count().catch(() => 0))) return false;

  const type = await loc.getAttribute("type").catch(() => "");
  if (type !== "checkbox" && type !== "radio") return false;

  const checked = await loc.isChecked().catch(() => false);
  if (shouldCheck && !checked) {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ timeout: 15000 }).catch(async () => {
      await loc.click({ timeout: 15000, force: true }).catch(() => {});
    });
  }
  return true;
}

async function waitForPage2(page, job) {
  logStep(job, "➡️ Waiting for Discharge Page 2 to load...");
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const url = page.url() || "";
    if (/page=2/i.test(url)) break;
    const hasDate = await page.locator("#frm_DischargeDate").count().catch(() => 0);
    if (hasDate) break;
    await wait(300);
  }
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  const hasDate2 = await page.locator("#frm_DischargeDate").count().catch(() => 0);
  if (!hasDate2) logStep(job, "⚠️ Page 2 marker (#frm_DischargeDate) not found yet; continuing.");
  else logStep(job, "✅ Page 2 loaded");
}

/* =========================
 * Parse template text
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
  const t = String(s || "").trim();
  if (!t) return "";
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t)) return t;
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = m[1];
    const mo = String(m[2]).padStart(2, "0");
    const d = String(m[3]).padStart(2, "0");
    return `${mo}/${d}/${y}`;
  }
  return t;
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
  const frequencyDuration = p("Frequency\/Duration");
  const progressResponse = p("Patient Progress\/Response");

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
    treatmentPrefs
  };
}

/* =========================
 * Navigation (HotBox)
 * =======================*/
async function login(page, job) {
  logStep(job, `➡️ Navigating to login page: ${BASE_URL}`);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  const popupOk = await firstVisibleLocator(page, ["text=OK", "button:has-text('OK')", "input[value='OK']"]);
  if (popupOk) {
    await popupOk.click().catch(() => {});
    logStep(job, "✅ Popup accepted");
  }

  const userLoc = await firstVisibleLocator(page, ["#username", "input[name='username']", "input[type='text']"]);
  const passLoc = await firstVisibleLocator(page, ["#password", "input[name='password']", "input[type='password']"]);
  if (!userLoc || !passLoc) throw new Error("Login fields not found.");

  await userLoc.fill(USERNAME);
  await passLoc.fill(PASSWORD);

  await safeClick(page, ["input[type='submit']", "button:has-text('Login')", "text=Login"]);
  await page.waitForLoadState("domcontentloaded");
  logStep(job, "✅ Login complete");
}

async function openHotBox(page, job) {
  logStep(job, "➡️ Navigating to HotBox...");
  const hot = await firstVisibleLocator(page, ["text=Hotbox", "text=HotBox", "a:has-text('Hotbox')", "a:has-text('HotBox')"]);
  if (hot) {
    await hot.click().catch(() => {});
    await page.waitForLoadState("domcontentloaded");
    logStep(job, "✅ HotBox opened");
    return;
  }

  const goTo = await firstVisibleLocator(page, ["text=Go To", "a:has-text('Go To')", "button:has-text('Go To')"]);
  if (goTo) {
    await goTo.click().catch(() => {});
    const hot2 = await firstVisibleLocator(page, ["text=Hotbox", "text=HotBox"]);
    if (hot2) {
      await hot2.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded");
      logStep(job, "✅ HotBox opened via Go To");
      return;
    }
  }
  logStep(job, "ℹ️ HotBox link not found; proceeding assuming already on task list.");
}

async function openTaskFromHotBox(page, job, opts) {
  const patientName = String(opts.patientName || "").trim();
  const taskType = String(opts.taskType || "PT Discharge").trim();
  const visitDate = String(opts.visitDate || "").trim();

  logStep(job, `➡️ Opening task from HotBox: patient="${patientName}" date="${visitDate}" task="${taskType}"`);

  const rowSelectors = [
    patientName ? `tr:has-text("${patientName}"):has-text("${taskType}")` : "",
    patientName ? `tr:has-text("${patientName}"):has-text("${visitDate}")` : "",
    `tr:has-text("${taskType}")`
  ].filter(Boolean);

  let row = null;
  for (const rs of rowSelectors) {
    const loc = page.locator(rs).first();
    if (await loc.count().catch(() => 0)) {
      row = loc;
      break;
    }
  }
  if (!row) throw new Error(`Could not find HotBox row for task "${taskType}".`);

  const link = await firstVisibleLocator(row, ["a", "td a"]);
  if (!link) throw new Error("Task row found but no link to open the form.");

  await link.click().catch(async () => {
    await link.click({ force: true }).catch(() => {});
  });

  await page.waitForLoadState("domcontentloaded");
  logStep(job, "✅ Task opened");
}

/* =========================
 * Fill Page 1
 * =======================*/
async function fillPage1(page, job, data) {
  logStep(job, "➡️ Filling PT Discharge Page 1...");

  await safeCheckById(page, "frm_hsHomedYes", true);
  await safeCheckById(page, "frm_hsResWeak", true);
  await safeCheckById(page, "frm_hsLeaveUnattd", true);

  if (data.temp) await safeFillById(page, "frm_VSTemperature", data.temp);
  if (data.tempType) await safeFillById(page, "frm_VSTemperatureType", data.tempType);
  if (data.bpSys) await safeFillById(page, "frm_VSPriorBPsys", data.bpSys);
  if (data.bpDia) await safeFillById(page, "frm_VSPriorBPdia", data.bpDia);
  if (data.hr) await safeFillById(page, "frm_VSPriorHeartRate", data.hr);
  if (data.rr) await safeFillById(page, "frm_VSPriorResp", data.rr);
  if (data.vsComments) await safeFillById(page, "frm_VSComments", data.vsComments);

  if (data.painVal === "no") await safeCheckById(page, "frm_PainAsmtNoPain", true);

  if (data.rolling) await safeFillById(page, "frm_BMRollingALDC", data.rolling);
  if (data.supToSit) await safeFillById(page, "frm_BMSupSitALDC", data.supToSit);
  if (data.sitToSup) await safeFillById(page, "frm_BMSitSupALDC", data.sitToSup);

  if (data.sitToStand) await safeFillById(page, "frm_TransSitStandALDC", data.sitToStand);
  if (data.standToSit) await safeFillById(page, "frm_TransStandSitALDC", data.standToSit);
  if (data.toiletBSC) await safeFillById(page, "frm_TransToiletBSCALDC", data.toiletBSC);
  if (data.tubShower) await safeFillById(page, "frm_TransTubShowerALDC", data.tubShower);

  if (data.gaitLevel) await safeFillById(page, "frm_GaitLevelALDC", data.gaitLevel);
  if (data.distance) await safeFillById(page, "frm_GaitLevelAmtDC", data.distance);
  if (data.gaitUnlevel) await safeFillById(page, "frm_GaitUnLevelALDC", data.gaitUnlevel);
  if (data.steps) await safeFillById(page, "frm_GaitStepsStairsALDC", data.steps);

  if (data.sittingBal) await safeFillById(page, "frm_BalanceSitALDC", data.sittingBal);
  if (data.standingBal) await safeFillById(page, "frm_BalanceStandALDC", data.standingBal);

  if (data.evalTestDesc) await safeFillById(page, "frm_BalanceEvalTestDC", data.evalTestDesc);
  if (data.skilledIntervention) await safeFillById(page, "frm_trtmntSIV", data.skilledIntervention);

  if (data.goalsMetCheck) await safeCheckById(page, "frm_GoalsAllMetDC", true);
  if (data.goalsNotMetCheck) await safeCheckById(page, "frm_GoalsPartMegDC", true);
  if (data.goalsSummary) await safeFillById(page, "frm_GoalsSummaryDC", data.goalsSummary);

  await safeCheckById(page, "frm_DCDispositionHomeExer", true);
  await safeCheckById(page, "frm_DCPTOnly", true);

  logStep(job, "✅ Page 1 filled");
}

async function clickSaveAndContinue(page, job) {
  logStep(job, "➡️ Save & Continue...");
  const btn = await firstVisibleLocator(page, [
    "input[name='sc'][value*='Save']",
    "input[value*='Save'][name='sc']",
    "text=Save & Continue",
    "button:has-text('Save & Continue')"
  ]);
  if (!btn) throw new Error("Save & Continue button not found on Discharge Page 1.");
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click().catch(async () => {
    await btn.click({ force: true }).catch(() => {});
  });
  await wait(900);
}

/* =========================
 * Fill Page 2
 * =======================*/
async function fillPage2(page, job, data) {
  logStep(job, "➡️ Filling PT Discharge Page 2...");

  if (data.dischargeDate) await safeFillById(page, "frm_DischargeDate", data.dischargeDate);
  if (data.reasonForDC) await safeFillById(page, "frm_OtherDCReason", data.reasonForDC);

  if (data.currentStatus) await safeFillById(page, "frm_CurrentStatus", data.currentStatus);
  if (data.phyPsych) await safeFillById(page, "frm_PhyPsych", data.phyPsych);

  await safeCheckById(page, "frm_physical_therapy", true);
  if (data.servicesProvided) await safeFillById(page, "frm_physical_therapy_services", data.servicesProvided);
  if (data.frequencyDuration) await safeFillById(page, "frm_physical_therapy_frequency", data.frequencyDuration);
  if (data.progressResponse) await safeFillById(page, "frm_physical_therapy_progress", data.progressResponse);

  await safeCheckById(page, "frm_ImprovedCond", true);
  await safeCheckById(page, "frm_ImprovedKnow", true);
  await safeCheckById(page, "frm_ImprovedInd", true);
  await safeCheckById(page, "frm_ImprovedFunc", true);

  if (data.postDischargeGoals) await safeFillById(page, "frm_PostDischargeGoals", data.postDischargeGoals);

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
    "frm_InformedPriorPatient"
  ];
  for (const id of mustCheck) await safeCheckById(page, id, true);

  const contChecks = [
    "frm_ToPatient",
    "frm_LiveArrangeDCHome",
    "frm_CareCoordDCPhysNotifiedPrDCDate",
    "frm_CareCoordDCPhysNotifiedDCSumm",
    "frm_CareCoordDCOrderSummComplete",
    "frm_CareCoordDCSchedNotified"
  ];
  for (const id of contChecks) await safeCheckById(page, id, true);

  if (data.infoProvided) await safeFillById(page, "frm_InfoProvided", data.infoProvided);
  if (data.treatmentPrefs) await safeFillById(page, "frm_TreatmentPreferences", data.treatmentPrefs);

  logStep(job, "✅ Page 2 filled");
}

async function clickSave(page, job) {
  logStep(job, "➡️ Saving (final)...");
  const btn = await firstVisibleLocator(page, [
    "input[value='Save']",
    "button:has-text('Save')",
    "text=Save",
    "input[name='btnSave']",
    "#btnSave"
  ]);
  if (!btn) throw new Error("Save button not found on Discharge Page 2.");
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click().catch(async () => {
    await btn.click({ force: true }).catch(() => {});
  });
  await wait(1200);
  logStep(job, "✅ Save clicked");
}

async function runPtDischargeBot({ patientName, visitDate, aiNotes, taskType }, job) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await login(page, job);
    await openHotBox(page, job);
    await openTaskFromHotBox(page, job, {
      patientName,
      visitDate,
      taskType: taskType || "PT Discharge"
    });

    const data = parseDischargeTemplate(aiNotes, visitDate);

    await fillPage1(page, job, data);
    await clickSaveAndContinue(page, job);

    await waitForPage2(page, job);
    await fillPage2(page, job, data);
    await clickSave(page, job);

    logStep(job, "✅ PT Discharge bot finished successfully");
  } catch (err) {
    logStep(job, `❌ PT Discharge bot failed: ${err && err.message ? err.message : String(err)}`);
    throw err;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { runPtDischargeBot };
