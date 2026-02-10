<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Kin-Scribe — Kinnser Automation</title>
  <style>
    :root{
      --bg:#f6f7fb;
      --card:#ffffff;
      --text:#111827;
      --muted:#6b7280;
      --line:#e5e7eb;
      --primary:#2563eb;
      --primary2:#1d4ed8;
      --bad:#b91c1c;
      --warn:#b45309;
      --ok:#047857;
      --chip:#f3f4f6;
    }
    *{ box-sizing:border-box; }
    body{ margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif; background:var(--bg); color:var(--text); }
    .wrap{ max-width: 1040px; margin: 22px auto; padding: 0 18px 42px; }
    .top{ display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; }
    h1{ margin:0; font-size:20px; font-weight:900; letter-spacing:-0.2px; }
    .pill{ font-size:12px; color:var(--muted); border:1px solid var(--line); padding:6px 10px; border-radius:999px; background:#fff; white-space:nowrap; }

    .card{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; box-shadow: 0 10px 30px rgba(0,0,0,0.06); }

    .grid{ display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:12px; }
    .span-3{ grid-column: 1 / -1; }
    .span-2{ grid-column: span 2; }
    @media (max-width: 980px){ .grid{ grid-template-columns: repeat(2, minmax(0, 1fr)); } .span-3{ grid-column: 1 / -1; } }
    @media (max-width: 680px){ .grid{ grid-template-columns: 1fr; } .span-2{ grid-column: 1 / -1; } }

    .field{ display:flex; flex-direction:column; gap:6px; min-width:0; }
    label{ font-size:12px; font-weight:800; color:var(--muted); }
    input, select, textarea{
      font-family:inherit; font-size:14px; padding:10px 12px;
      border-radius:10px; border:1px solid var(--line); background:#fff; outline:none;
      transition: box-shadow .12s, border-color .12s;
    }
    input:focus, select:focus, textarea:focus{ border-color:#93c5fd; box-shadow:0 0 0 4px rgba(37,99,235,0.12); }

    textarea{
      width:100%;
      min-height: 420px;
      resize:vertical;
      white-space:pre-wrap;
      overflow-wrap:anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      line-height:1.35;
    }

    .actions{ display:flex; justify-content:flex-end; gap:10px; margin-top:12px; flex-wrap:wrap; }
    button{
      padding:10px 14px; border-radius:999px; border:1px solid var(--line);
      background:#fff; cursor:pointer; font-weight:900; font-size:14px;
    }
    button.primary{ background:var(--primary); border-color:var(--primary); color:#fff; }
    button.primary:hover{ background:var(--primary2); }
    button.danger{ background:#fff; border-color: rgba(185,28,28,.35); color: var(--bad); }
    button.danger:hover{ border-color: rgba(185,28,28,.65); }
    button:disabled{ opacity:.55; cursor:not-allowed; }

    .sectionTitle{ margin-top: 4px; margin-bottom: 8px; font-weight:950; font-size:13px; color:#111827; letter-spacing:0.1px; }
    .hint{ margin-top:10px; color:var(--muted); font-size:12px; line-height:1.35; }

    .statusHeader{ display:flex; align-items:center; justify-content:space-between; gap:10px; }
    .badge{
      font-size:12px; font-weight:950; padding:6px 10px; border-radius:999px;
      border:1px solid var(--line); background:#fff; color:var(--muted);
    }
    .badge.ok{ border-color: rgba(4,120,87,.25); color:var(--ok); background:rgba(4,120,87,.06); }
    .badge.warn{ border-color: rgba(180,83,9,.25); color:var(--warn); background:rgba(180,83,9,.06); }
    .badge.bad{ border-color: rgba(185,28,28,.25); color:var(--bad); background:rgba(185,28,28,.06); }

    .statusBox{
      border:1px solid var(--line);
      background:#fafafa;
      border-radius:12px;
      padding:12px;
      height: 260px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size:12px;
      white-space:pre-wrap;
      overflow-wrap:anywhere;
      line-height:1.45;
      overflow-y: auto;
    }

    .rowInline{
      display:flex;
      gap:10px;
      align-items:center;
      flex-wrap:wrap;
    }
  </style>

  <!--
    Bootstrap script:
    - Persists jobId to localStorage when /run-automation returns jobId
    - Resumes polling after refresh (even if you left page / phone locked)
    - Adds audio upload -> /convert-audio -> inserts transcript into dictationNotes
    - Adds Stop button -> /stop-job
  -->
  <script>
    (function(){
      const LS_KEY = "kinscribe_active_jobId";

      function el(id){ return document.getElementById(id); }

      function setBadge(text, kind=""){
        const b = el("jobBadge");
        if (!b) return;
        b.textContent = text;
        b.className = "badge" + (kind ? " " + kind : "");
      }

      function setStatus(text){
        const s = el("statusBox");
        if (!s) return;
        s.textContent = text;
        s.scrollTop = s.scrollHeight;
      }

      async function httpJson(url, options={}){
        const res = await fetch(url, {
          ...options,
          headers: { "Content-Type": "application/json", ...(options.headers||{}) },
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

      let pollTimer = null;

      function stopPolling(){
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
      }

      async function pollJob(jobId){
        stopPolling();
        pollTimer = setInterval(async () => {
          try {
            const job = await httpJson(`/job-status/${encodeURIComponent(jobId)}`);

            if (job.status === "completed") setBadge("Completed", "ok");
            else if (job.status === "failed") setBadge("Failed", "bad");
            else if (job.status === "stopped") setBadge("Stopped", "bad");
            else setBadge(job.status || "running", "warn");

            const summaryLines = [
              `jobId: ${job.jobId}`,
              `status: ${job.status}`,
              `message: ${job.message || ""}`,
              `startedAt: ${job.startedAt ? new Date(job.startedAt).toISOString() : ""}`,
              `updatedAt: ${job.updatedAt ? new Date(job.updatedAt).toISOString() : ""}`,
              `finishedAt: ${job.finishedAt ? new Date(job.finishedAt).toISOString() : ""}`,
            ];

            const logText = Array.isArray(job.logs) ? job.logs.join("\n") : "";
            setStatus(summaryLines.join("\n") + (logText ? `\n\n${logText}` : ""));

            if (job.status === "completed" || job.status === "failed" || job.status === "stopped") {
              stopPolling();
              try { localStorage.removeItem(LS_KEY); } catch {}
            }
          } catch (e) {
            setBadge("Polling error", "bad");
            setStatus(`Polling failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
            stopPolling();
          }
        }, 1200);
      }

      // Wrap fetch: when /run-automation returns jobId, store it so we can resume later.
      const _fetch = window.fetch.bind(window);
      window.fetch = async function(input, init){
        const url = (typeof input === "string") ? input : (input && input.url ? input.url : "");
        const resp = await _fetch(input, init);
        try {
          if (url.includes("/run-automation")) {
            const clone = resp.clone();
            const txt = await clone.text();
            let body = null;
            try { body = txt ? JSON.parse(txt) : null; } catch {}
            if (body && body.jobId) {
              try { localStorage.setItem(LS_KEY, String(body.jobId)); } catch {}
              // start polling immediately (even if app.js also polls)
              pollJob(String(body.jobId));
            }
          }
        } catch {}
        return resp;
      };

      async function stopJob(){
        const jobId = (() => {
          try { return localStorage.getItem(LS_KEY) || ""; } catch { return ""; }
        })();
        if (!jobId) {
          setBadge("No active job", "warn");
          setStatus("No active jobId found to stop.");
          return;
        }
        try {
          setBadge("Stopping…", "warn");
          setStatus(`Stopping jobId: ${jobId} …`);
          await httpJson("/stop-job", { method:"POST", body: JSON.stringify({ jobId }) });
          setBadge("Stopped", "bad");
          setStatus(`Stopped jobId: ${jobId}`);
          try { localStorage.removeItem(LS_KEY); } catch {}
          stopPolling();
        } catch (e) {
          setBadge("Stop failed", "bad");
          setStatus(`Stop failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
        }
      }

      function fileToDataUrl(file){
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(reader.error || new Error("File read failed"));
          reader.readAsDataURL(file);
        });
      }

      async function convertAudio(){
        const file = el("audioFile")?.files?.[0];
        if (!file) {
          setBadge("Audio convert failed", "bad");
          setStatus("Audio convert failed:\nPlease choose an audio file first.");
          return;
        }
        try {
          el("btnConvertAudio").disabled = true;
          setBadge("Transcribing…", "warn");
          setStatus("Uploading audio → transcription…");

          const audioDataUrl = await fileToDataUrl(file);
          const resp = await httpJson("/convert-audio", {
            method: "POST",
            body: JSON.stringify({ audioDataUrl })
          });

          const text = String(resp.text || "").trim();
          if (!text) throw new Error("Empty transcription");

          const d = el("dictationNotes");
          if (d) {
            const prev = (d.value || "").trim();
            d.value = (prev ? (prev + "\n\n") : "") + text;
          }

          setBadge("Ready", "ok");
          setStatus("Audio transcription completed and added to Dictation.");
        } catch (e) {
          setBadge("Audio failed", "bad");
          setStatus(`Audio transcription failed:\n${e?.message || e}\n\n${JSON.stringify(e?.body || {}, null, 2)}`);
        } finally {
          el("btnConvertAudio").disabled = false;
        }
      }

      // Wire buttons after DOM loaded
      window.addEventListener("DOMContentLoaded", () => {
        const stopBtn = el("btnStop");
        if (stopBtn) stopBtn.addEventListener("click", stopJob);

        const audioBtn = el("btnConvertAudio");
        if (audioBtn) audioBtn.addEventListener("click", convertAudio);

        // Resume polling if a jobId exists (page refresh / phone sleep)
        let jobId = "";
        try { jobId = localStorage.getItem(LS_KEY) || ""; } catch {}
        if (jobId) {
          setBadge("Resuming…", "warn");
          setStatus(`Resuming jobId: ${jobId}\nPolling server for status…`);
          pollJob(jobId);
        }
      });
    })();
  </script>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <h1>Kin-Scribe — Kinnser Automation</h1>
      <div class="pill" id="apiBasePill">API: (detecting…)</div>
    </div>

    <div class="card">
      <div class="grid">
        <div class="field span-2">
          <label>Kinnser username</label>
          <input id="kinnserUsername" placeholder="Username" autocomplete="username" />
        </div>
        <div class="field">
          <label>Kinnser password</label>
          <input id="kinnserPassword" type="password" placeholder="Password" autocomplete="current-password" />
        </div>

        <div class="field span-3">
          <div class="actions" style="justify-content:flex-start;">
            <label style="display:flex;align-items:center;gap:8px;font-weight:800;color:var(--muted);font-size:12px;">
              <input type="checkbox" id="rememberCreds" />
              Remember Kinnser credentials on this computer
            </label>
            <button id="btnSaveCreds" type="button">Save</button>
            <button id="btnClearCreds" type="button">Clear</button>
            <a href="/logout" style="margin-left:auto;font-weight:900;font-size:12px;color:var(--muted);text-decoration:none;">Logout</a>
          </div>
        </div>

        <div class="field">
          <label>Patient name</label>
          <input id="patientName" placeholder="LAST, FIRST" />
        </div>
        <div class="field">
          <label>Visit date</label>
          <input id="visitDate" type="date" />
        </div>
        <div class="field">
          <label>Task type</label>
          <select id="taskType">
            <option>PT Visit</option>
            <option>PT Evaluation</option>
            <option>PT Re-Evaluation</option>
            <option>PT Discharge w/Discharge Summary</option>
          </select>
        </div>

        <div class="field">
          <label>Time in</label>
          <input id="timeIn" placeholder="16:30" />
        </div>
        <div class="field">
          <label>Time out</label>
          <input id="timeOut" placeholder="17:30" />
        </div>
        <div class="field">
          <label>Template</label>
          <select id="templateKey">
            <option value="">(None)</option>
          </select>
        </div>

        <div class="field span-3">
          <div class="sectionTitle">Voice memo / audio → Dictation</div>
          <div class="rowInline">
            <input id="audioFile" type="file" accept="audio/*" />
            <button id="btnConvertAudio" type="button">Transcribe Audio → Dictation</button>
          </div>
          <div class="hint">
            Upload an iPhone voice memo / audio file. The transcript will be appended to the Dictation box below.
          </div>
        </div>

        <div class="field span-3">
          <div class="sectionTitle">Free Dictation (raw input)</div>
          <textarea id="dictationNotes" placeholder="Dictate freely here… messy notes are OK." style="min-height:200px;"></textarea>
          <div class="actions" style="justify-content:flex-start; margin-top:10px;">
            <button id="btnConvert" type="button">Convert Dictation → Selected Template</button>
          </div>

          <div class="sectionTitle" style="margin-top:14px;">Convert from Image (optional)</div>
          <div class="field" style="gap:8px;">
            <input id="imageFile" type="file" accept="image/*" />
            <div class="actions" style="justify-content:flex-start; margin-top:4px;">
              <button id="btnConvertImage" type="button">Convert Image → Selected Template</button>
            </div>
          </div>
        </div>

        <div class="field span-3">
          <div class="sectionTitle">AI Notes (what you want autofilled)</div>
          <textarea id="aiNotes" placeholder="Paste or type your note here..."></textarea>
        </div>

        <div class="field span-3">
          <div class="statusHeader">
            <div class="sectionTitle" style="margin:0;">Status</div>
            <div class="badge" id="jobBadge">Idle</div>
          </div>

          <div class="statusBox" id="statusBox">No job yet.</div>

          <div class="actions">
            <button id="btnHealth" type="button">Test /health</button>
            <button id="btnClear" type="button">Clear</button>
            <button id="btnStop" type="button" class="danger">Stop</button>
            <button class="primary" id="btnRun" type="button">Run Automation</button>
          </div>

          <div class="hint">
            Job runs on the server. If you leave the page or your phone locks, it will continue until it completes.
            When you reopen this page, it will automatically resume status polling.
          </div>
        </div>
      </div>
    </div>
  </div>

  <script src="/app.js"></script>
</body>
</html>
