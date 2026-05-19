// public/app.js

// === FRONT PAGE LOGIC ===
const btn = document.getElementById("start-button");
if (btn) {
  const urlInput = document.getElementById("doc-url");
  const keyInput = document.getElementById("gemini-key");
  const statusText = document.getElementById("status-text");

  let pollTimer = null;

  function setStatus(msg) {
    statusText.textContent = msg;
  }

  async function pollStatus() {
    try {
      const res = await fetch("/status");
      const data = await res.json();

      if (data.status === "running") {
        setStatus("Running: " + data.step);
        pollTimer = setTimeout(pollStatus, 2000);
      } else if (data.status === "done") {
        clearTimeout(pollTimer);
        setStatus("Done! Redirecting to dashboard...");
        setTimeout(() => { window.location.href = "/download_page.html"; }, 1200);
      } else if (data.status === "error") {
        clearTimeout(pollTimer);
        btn.disabled = false;
        setStatus("Error encountered: " + data.error);
      }
    } catch {
      clearTimeout(pollTimer);
      btn.disabled = false;
      setStatus("Could not safely reach the server.");
    }
  }

  btn.addEventListener("click", async () => {
    const docUrl = urlInput.value.trim();
    const geminiKey = keyInput.value.trim();

    if (!docUrl) {
      setStatus("Please paste a Google Doc URL or File ID first.");
      return;
    }

    btn.disabled = true;
    setStatus("Submitting target reference payload...");

    try {
      const res = await fetch("/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docUrl, geminiKey: geminiKey || undefined }),
      });

      if (!res.ok) {
        const err = await res.json();
        setStatus("Error: " + err.error);
        btn.disabled = false;
        return;
      }

      setStatus("Analysis stack initialized safely...");
      pollTimer = setTimeout(pollStatus, 2000);
    } catch {
      setStatus("Could not connect to service.");
      btn.disabled = false;
    }
  });
}

// === DOWNLOAD PAGE LOGIC ===
const downloadBtn = document.getElementById("download-btn");
if (downloadBtn) {
  downloadBtn.addEventListener("click", () => {
    window.location.href = "/download";
  });
}