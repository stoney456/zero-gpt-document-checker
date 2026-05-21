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

// === LOADING PAGE LOGIC ===
const loadingContainer = document.getElementById("loading-page-container");
if (loadingContainer) {
  const statusText = document.getElementById("status-text");
  let pollTimer = null;

  function setStatus(msg) {
    statusText.textContent = msg;
  }

  async function pollStatus() {
    try {
      const res  = await fetch("/status");
      const data = await res.json();

      if (data.status === "running") {
        setStatus("Running: " + data.step);
        pollTimer = setTimeout(pollStatus, 2000);

      } else if (data.status === "done") {
        clearTimeout(pollTimer);
        setStatus("Done! Redirecting to download...");
        setTimeout(() => { window.location.href = "/download_page.html"; }, 1200);

      } else if (data.status === "error") {
        clearTimeout(pollTimer);
        setStatus("Error encountered: " + data.error);
      }
    } catch {
      clearTimeout(pollTimer);
      setStatus("Could not safely reach the server.");
    }
  }

  // Start polling as soon as the loading page loads
  pollStatus();
}

// === DOWNLOAD PAGE LOGIC ===
const downloadBtn = document.getElementById("download-btn");
if (downloadBtn) {
  downloadBtn.addEventListener("click", () => {
    window.location.href = "/download";
  });
}