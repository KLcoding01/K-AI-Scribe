// =========================
// Updated: 2026-01-20
// =========================

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

        if (job.status === "completed" || job.status === "failed") {
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
    el("aiNotes").value = "";
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

      // Choose template: dropdown first, else based on task type
      let templateText = "";
      if (templateKey && TEMPLATES[templateKey]) templateText = TEMPLATES[templateKey];
      else if ((taskType || "").toLowerCase().includes("evaluation") && TEMPLATES.pt_eval_default) templateText = TEMPLATES.pt_eval_default;
      else templateText = TEMPLATES.pt_visit_default || "";

      const resp = await httpJson("/convert-dictation", {
        method: "POST",
        body: JSON.stringify({ dictation, taskType, templateText }),
      });

      el("aiNotes").value = resp.templateText || "";
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

      el("aiNotes").value = resp.templateText || "";
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
Temp: ___
Temp Type: Temporal
BP: ___ / ___
Heart Rate: ___
Respirations: ___
Comments: Pt currently symptom-free with no adverse reactions noted. Cleared to continue with PT as planned.

Pain Assessment
Pain: No
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
5 sentences HH PT tx focusing on TherEx, TherAct, functional safety training, HEP review, and gait training. Tx tolerated fairly. Pt continues to demonstrate weakness and impaired balance with high fall risk. Continued skilled HH PT remains indicated to progress toward goals and improve functional independence.
`,
    pt_eval_default: `Medical Diagnosis:
PT Diagnosis: Muscle weakness, Functional Mobility Deficit, Impaired Gait/Balance, Impaired Activity Tolerance
Relevant Medical History:
Prior Level of Function: Needing assistance from family and ADLs.
Patient’s Goals: To improve mobility, strength, activity tolerance, decrease fall risk, and improve quality of life
Precautions: Fall risk

Patient Lives: With family in home
Assistance is Available: Around the clock
Current assistance types: Family
Steps/Stairs present: Yes/No
Steps Count:
No hazards identified: Yes/No
Evaluation of Living Situation: Pt lives in a SSH with family providing care around the clock. The home has hard surface flooring, bath tub/step in shower, 4 steps at entrance with rail. No hazard found.

Subjective: Pt agreeable to PT evaluation and treatment.

Temp:
Temp Type: Temporal
BP: / 
Heart Rate:
Respirations: 18
Comments: Pt is currently symptom-free and demonstrates no adverse reactions. Cleared to continue with physical therapy as planned.

Pain: Yes/No
Primary Location Other:
Intensity (0–10):
Increased by:
Relieved by:
Interferes with:

Edema: absent/present
Edema Type:
Pitting Grade:
Location:

DME other:

Orientation: AOx3, forgetful
Speech: Unremarkable
Vision: Unremarkable
Hearing: Unremarkable
Skin: Intact
Muscle Tone: Muscle weakness
Coordination: Fair
Sensation: NT
Endurance: Fair-
Posture: Forward head lean, round shoulder, increased mid T-spine kyphosis

Bed Mobility: SBA
Transfers: SBA
Gait: SBA x 50ft with FWW
Stairs:
Weight Bearing Status: FWB

Response to tx: Bed mobility: Forgetfulness, improper sequence/mechanics, decrease activity tolerance, weakness, decrease safety awareness.
Response to tx: Transfers: Forgetfulness, improper sequence/mechanics, decrease activity tolerance, weakness, decrease safety awareness.
Response to tx: Gait: Forgetfulness, improper sequence/mechanics, decrease activity tolerance, weakness, decrease safety awareness. Gait Analysis: Decreased step/stride length, slow cadence, wide BOS, forward trunk lean, decrease walking tolerance, decrease safety awareness and surrounding environment awareness.

Gross ROM for UE:
Gross strength for UE:
Gross ROM for LE:
Gross strength for LE:

Short-Term Goals (STG):
- Pt will perform bed mobility with Indep using appropriate sequencing and safety strategies.
- Pt will perform transfers bed from/to chair/toilet with Indep using appropriate AD and safe mechanics.
(within a total of 4 visits)

Long-Term Goals (LTG):
- Pt will ambulate 150 ft with FWW with Indep to improve household mobility and reduce fall risk.
- Pt/CG will be independent with HEP and fall-prevention strategies with safe technique and pacing.
- Pt will improve Tinetti Poma score to 20/28 or more to decrease fall risk.
(within a total of 7 visits)

Frequency: 1w1, 2w3
Assessment Summary: Generate 6 sentences for HH PT initial evaluation noting impairments, fall risk, skilled need, interventions, and medical necessity per POC.`
  };

  function initTemplates() {
    const dd = el("templateKey");
    if (!dd) return;
    dd.innerHTML = `
      <option value="">(None)</option>
      <option value="pt_eval_default">PT Evaluation (Default)</option>
      <option value="pt_visit_default">PT Visit (Default)</option>
    `;
    dd.addEventListener("change", () => {
      const key = dd.value;
      if (!key) return;
      el("aiNotes").value = TEMPLATES[key] || "";
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
