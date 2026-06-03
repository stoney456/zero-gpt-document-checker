// scripts/main.js

// === FRONT PAGE LOGIC ===
const btn = document.getElementById("start-button");
if (btn) {
  const urlInput   = document.getElementById("doc-url");
  const statusText = document.getElementById("status-text");

  function setStatus(msg) {
    statusText.textContent = msg;
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

// === LOADING PAGE LOGIC ===
const loadingContainer = document.getElementById("loading-page-container");
if (loadingContainer) {
  const statusText        = document.getElementById("status-text");
  const loadingStatusText = document.getElementById("loading-status-text");
  const cancelBtn         = document.getElementById("cancel-button");
  let pollTimer = null;
 
  // Map server step messages to step numbers
  const stepMap = [
    { keyword: "Extracting",  stepId: "step-1" },
    { keyword: "charts",      stepId: "step-2" },
    { keyword: "Compiling",   stepId: "step-3" },
  ];
 
  function updateSteps(stepMessage) {
    let activeIndex = -1;
    stepMap.forEach((s, i) => {
      if (stepMessage.includes(s.keyword)) activeIndex = i;
    });
 
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
        pollTimer = setTimeout(pollStatus, 2000);
 
      } else if (data.status === "done") {
        clearTimeout(pollTimer);
 
        // Mark all steps as done
        stepMap.forEach((s) => {
          const el = document.getElementById(s.stepId);
          if (!el) return;
          el.classList.remove("active");
          el.classList.add("done");
          el.querySelector(".step-icon").textContent = "✓";
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
 
  pollStatus();
}


// === DOWNLOAD PAGE LOGIC ===
const downloadBtn = document.getElementById("download-button");
if (downloadBtn) {
  downloadBtn.addEventListener("click", () => {
    window.location.href = "/download";
  });
}