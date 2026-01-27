
// -------------------------
// Sanitize AI Notes
// -------------------------
function sanitizeNotes(text) {
  // Preserve template spacing EXACTLY (indentation, multiple spaces, and blank lines).
  // Only normalize line endings and a couple of common invisible characters.
  let t = String(text ?? "");

  // Normalize CRLF -> LF (keeps all spacing/indentation intact)
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Replace non‑breaking spaces with regular spaces (optional but helps consistency)
  t = t.replace(/\u00A0/g, " ");

  // Do NOT collapse spaces/tabs, and do NOT strip indentation after newlines.
  // Do NOT collapse multiple blank lines (your templates may intentionally include them).

  return t;
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
      
      // Choose template: dropdown first, else based on task type
      let templateText = "";
      if (templateKey && TEMPLATES[templateKey]) templateText = TEMPLATES[templateKey];
      else if ((taskType || "").toLowerCase().includes("evaluation") && TEMPLATES.pt_eval_default) templateText = TEMPLATES.pt_eval_default;
      else templateText = TEMPLATES.pt_visit_default || "";
      
      const resp = await httpJson("/convert-dictation", {
        method: "POST",
        body: JSON.stringify({ dictation, taskType, templateText }),
      });
      
      el("aiNotes").value = sanitizeNotes(resp.templateText || "");
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
PT Diagnosis: Muscle weakness, Functional Mobility Deficit, Unsteady Gait/Balance, Impaired Activity Tolerance 
Precautions: Fall Risk
Relevant Medical History: 
Prior Level of Function: Need some assistance with functional mobility, gait, and ADLs.
Patient Goals: To improve mobility, strength, activity tolerance, decrease fall risk, and return to PLOF.

Vital Signs
Temp: 97.6
Temp Type: Temporal
BP:  / 
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
Orientation: AOx2 
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
Bed Mobility: DEP
Bed Mobility AD:
Transfers: DEP
Transfers AD:

Gait
Level Surfaces
Gait: Unable
Gait Distance:
Gait AD:

Uneven Surfaces: Unable
Uneven Surfaces Distance:
Uneven Surfaces AD:

Stairs: Unable
Stairs Distance:
Stairs AD:

Weight Bearing: FWB

DME Other: FWW and Transport Chair

Edema: Absent
Type:
Location:
Pitting Grade:

Assessment Summary: Pt presents for HH PT evaluation with chronic low back and knee pain, generalized weakness, and significant functional decline in the setting of multiple comorbidities. Pt is currently bed bound and demonstrates markedly impaired bed mobility, decreased strength, and limited tolerance to positional changes, placing pt at high risk for further deconditioning and skin breakdown. Pain and weakness contribute to difficulty with functional transfers, upright tolerance, and initiation of mobility tasks. Current impairments significantly limit safe participation in ADLs and increase overall fall risk once mobility is attempted. Skilled HH PT is required to address pain management, improve strength, initiate safe bed mobility and transfer training, and provide caregiver education to reduce complications and promote functional recovery. Continued skilled HH PT remains medically necessary to maximize functional potential, improve safety, and support progression toward the highest achievable level of independence within the home setting.

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
BP:  /
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
BP:  /
Heart Rate:
Respirations: 18
Comments: Pt is currently symptom-free and demonstrates no adverse reactions. Cleared to continue with physical therapy as planned.

Pain:

ROM / Strength:

Neuro / Physical
Orientation: AOx
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
