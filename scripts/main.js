// scripts/main.js

//FRONT PAGE LOGIC
const btn = document.getElementById("start-button");
if (btn) {
  const urlInput   = document.getElementById("doc-url");
  const statusText = document.getElementById("status-text");

  function setStatus(msg) {
    if (statusText) {
      statusText.textContent = msg;
    }
  }

  btn.addEventListener("click", async () => {
    const docUrl = urlInput.value.trim();

    if (!docUrl) {
      setStatus("Please paste a Google Doc URL or File ID first.");
      return;
    }

    btn.disabled = true;
    setStatus("Submitting...");

    try {
      const res = await fetch("/analyze", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ docUrl }),
      });

      console.log("Response status:", res.status, "ok:", res.ok);

      if (!res.ok) {
        const err = await res.json();
        setStatus("Error: " + err.error);
        btn.disabled = false;
        return;
      }

      setStatus("Redirecting...");
      window.location.replace("/loading_page.html");

    } catch (err) {
      console.error("Fetch error:", err);
      setStatus("Could not connect to service.");
      btn.disabled = false;
    }
  });

}
// COPY ACCOUNT TO CLIPBOARD LOGIC
 function copyAccount(btn) {
  // .firstChild.textContent grabs just the email string, ignoring the button element
  const email = document.getElementById('service-account').firstChild.textContent.trim();
  
  navigator.clipboard.writeText(email).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 2000);
  });
}

function setStatus(msg) {
  const statusText = document.getElementById("status-text");
  if (statusText) statusText.textContent = msg;
}

// LOADING PAGE LOGIC
const loadingContainer = document.getElementById("loading-page-container");
if (loadingContainer) {
  const statusText        = document.getElementById("status-text");
  const loadingStatusText = document.getElementById("loading-status-text");
  const cancelBtn         = document.getElementById("cancel-button");
  let pollTimer = null;
 
  // Map server step messages to step numbers
  const stepMap = [
    { keyword: "Extracting", stepId: "step-1" },
    { keyword: "AI",         stepId: "step-2" },
    { keyword: "charts",     stepId: "step-3" },
    { keyword: "Compiling",  stepId: "step-4" },
  ];
 
  function updateSteps(stepMessage) {
    let activeIndex = -1;
    for (let i = stepMap.length - 1; i >= 0; i--) {
        if (stepMessage.includes(stepMap[i].keyword)) {
            activeIndex = i;
            break; // Stop evaluating once the active step is found
        }
    }
 
    stepMap.forEach((s, i) => {
      const el = document.getElementById(s.stepId);
      if (!el) return;
      el.classList.remove("active", "done");
      if (i < activeIndex) {
        el.classList.add("done");
        el.querySelector(".step-icon").textContent = "✓";
      } else if (i === activeIndex) {
        el.classList.add("active");
        el.querySelector(".step-icon").textContent = i + 1;
      }
    });
  }
 
  async function cancelJob() {
    clearTimeout(pollTimer);
    try {
      await fetch("/cancel", { method: "POST" });
    } catch {
      // ignore errors — we're navigating away anyway
    }
    window.location.href = "/front_page.html";
  }
 
  // Cancel button click
  if (cancelBtn) {
    cancelBtn.addEventListener("click", cancelJob);
  }
 
  async function pollStatus() {
    try {
      const res  = await fetch("/status");
      const data = await res.json();

      if (data.status === "running") {
        statusText.textContent = data.step;
        updateSteps(data.step);

        let activeIndex = -1;
        for (let i = stepMap.length - 1; i >= 0; i--) {
          if (data.step.includes(stepMap[i].keyword)) {
            activeIndex = i;
            break;
          }
        }
        updateProgressBars(activeIndex, data.progress);

        pollTimer = setTimeout(pollStatus, 2000);

      } else if (data.status === "done") {
        clearTimeout(pollTimer);

        // Mark all steps as done
        stepMap.forEach((s, i) => {
          const el = document.getElementById(s.stepId);
          if (!el) return;
          el.classList.remove("active");
          el.classList.add("done");
          el.querySelector(".step-icon").textContent = "✓";

          const fill = document.getElementById(`progress-${i + 1}`);
          if (fill) {
            fill.classList.remove("indeterminate");
            fill.style.width = "100%";
          }
        });

        statusText.textContent = "Done!";
        loadingStatusText.textContent = "Redirecting to download...";
        setTimeout(() => { window.location.href = "/download_page.html"; }, 1200);

      } else if (data.status === "cancelled") {
        clearTimeout(pollTimer);
        window.location.href = "/front_page.html";

      } else if (data.status === "error") {
        clearTimeout(pollTimer);
        statusText.textContent = "Error: " + data.error;
        loadingStatusText.textContent = "Please go back and try again.";
        if (cancelBtn) cancelBtn.textContent = "Go back";
      }

    } catch {
      clearTimeout(pollTimer);
      statusText.textContent = "Could not reach the server.";
    }
  }
  // Progress bar logic
  function updateProgressBars(activeIndex, progress) {
    stepMap.forEach((s, i) => {
      const fill = document.getElementById(`progress-${i + 1}`);
      if (!fill) return;

      if (i < activeIndex) {
        // Step already completed
        fill.classList.remove("indeterminate");
        fill.style.width = "100%";
      } else if (i === activeIndex) {
        // Step currently in progress
        if (s.keyword === "AI") {
          fill.classList.add("indeterminate");
          fill.style.width = "";
        } else {
          fill.classList.remove("indeterminate");
          fill.style.width = progress ? `${(progress.current / progress.total) * 100}%` : "0%";
        }
      } else {
        // Step not started yet
        fill.classList.remove("indeterminate");
        fill.style.width = "0%";
      }
    });
  }

  pollStatus();
}

// DOWNLOAD PAGE LOGIC
const downloadBtn = document.getElementById("download-button");
if (downloadBtn) {
  downloadBtn.addEventListener("click", () => {
    window.location.href = "/download";
  });
}

// History Page Download
const historyList = document.getElementById("history-list");
if (historyList) {
  (async () => {
    try {
      const res = await fetch("/history");
      const data = await res.json();

      if (!data.jobs || !data.jobs.length) {
        historyList.innerHTML = "<p>No past analyses found.</p>";
        return;
      }

      data.jobs.forEach((job) => {
        const card = document.createElement("div");
        card.className = "history-card";

        const folderId = job.id;
        const googleDocId = job.doc_id || 'Unknown Doc ID';

        const fileLinks = [
          { url: job.downloadUrl,     label: "PDF Report" },
          { url: job.csvSummaryUrl,   label: "Summary CSV" },
          { url: job.csvRevisionsUrl, label: "Revisions CSV" },
          { url: job.aiAnalysisUrl,   label: "AI Analysis" },
        ]
        .filter(f => f.url)
        .map(f => `<a href="${f.url}" class="download-link" target="_blank">${f.label}</a>`)
        .join("");
        // For each analysis, a section is added with relevant information and files
        card.innerHTML = `
          <h3>${job.title} (${folderId})</h3>
          <p class="history-meta">Generated: ${job.generated_at}</p>
          <p class="history-meta">Google Doc ID: ${googleDocId}</p>
          <div class="download-links">${fileLinks}</div>
          <button class="delete-button" data-id="${folderId}" type="button">Delete</button>
        `;
        historyList.appendChild(card);

        // Delete button behaviour
      
        card.querySelector('.delete-button').addEventListener('click', async (e) => {
        const jobId = e.currentTarget.dataset.id;
        if (!confirm('Delete this analysis? This cannot be undone.')) return;
        try {
          const r = await fetch(`/history/${jobId}`, { method: 'DELETE' });
          const result = await r.json();
          if (result.success) card.remove();
          else alert('Delete failed: ' + result.error);
        } catch {
          alert('Delete failed.');
        }
      });
      });
    } catch {
      historyList.innerHTML = "<p>Could not load history.</p>";
    }
  })();
}
