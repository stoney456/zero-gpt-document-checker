// scripts/server.js
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// ROOT always points to the project root regardless of where node is run from
const ROOT    = path.dirname(path.dirname(path.resolve(__filename)));
const STATIC  = path.join(ROOT, 'static');
const STYLES  = path.join(ROOT, 'styles');
const ASSETS  = path.join(ROOT, 'assets');
const SCRIPTS = path.join(ROOT, 'scripts');

// Global job state tracker
const jobs = {};
let currentJobId = null;
let currentProc = null; // To track the currently running child process for cancellation


/**
 * Reads a file and sends it as a response with the correct content type.
 */
function sendFileContent(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.setHeader('Content-Type', contentType);
    res.send(content);
  } catch (err) {
    res.status(404).send('File not found: ' + filePath);
  }
}

/**
 * Extracts a clean Google Document ID from a full URL or returns the input as-is.
 */
function extractDocId(input) {
  const match = input.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : input.trim();
}

/**
 * Wraps a spawned child process in a Promise.
 * Resolves on exit code 0, rejects otherwise.
 */
function runScript(command, args) {
  return new Promise((resolve, reject) => {
    // Use shell: false so we get the actual process PID for killing
    const proc = spawn(command, args, { 
      cwd: ROOT, 
      shell: true, 
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    currentProc = proc;

    proc.stdout.on('data', (data) => console.log(`[Script]: ${data.toString().trim()}`));
    proc.stderr.on('data', (data) => console.error(`[Script Err]: ${data.toString().trim()}`));

    proc.on('close', (code) => {
      currentProc = null;
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`Script exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      currentProc = null;
      reject(new Error(`Failed to spawn process: ${err.message}`));
    });
  });
}

// ── HTML routes ───────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  sendFileContent(res, path.join(STATIC, 'front_page.html'), 'text/html');
});

app.get('/front_page.html', (req, res) => {
  sendFileContent(res, path.join(STATIC, 'front_page.html'), 'text/html');
});

app.get('/loading_page.html', (req, res) => {
  sendFileContent(res, path.join(STATIC, 'loading_page.html'), 'text/html');
});

app.get('/download_page.html', (req, res) => {
  sendFileContent(res, path.join(STATIC, 'download_page.html'), 'text/html');
});

// ── JS / CSS / Asset routes ───────────────────────────────────────────────────

app.get('/main.js', (req, res) => {
  sendFileContent(res, path.join(SCRIPTS, 'main.js'), 'application/javascript');
});

app.get('/styles/:file', (req, res) => {
  sendFileContent(res, path.join(STYLES, req.params.file), 'text/css');
});

app.get('/assets/:file', (req, res) => {
  const ext = path.extname(req.params.file).toLowerCase();
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
  sendFileContent(res, path.join(ASSETS, req.params.file), types[ext] || 'application/octet-stream');
});

// ── Debug route ───────────────────────────────────────────────────────────────

app.get('/debug', (req, res) => {
  res.json({
    root: ROOT,
    static: STATIC,
    staticExists: fs.existsSync(STATIC),
    frontPageExists: fs.existsSync(path.join(STATIC, 'front_page.html')),
    files: fs.readdirSync(STATIC),
  });
});

// ── POST /analyze — start the pipeline ───────────────────────────────────────

app.post('/analyze', (req, res) => {
  const { docUrl } = req.body;

  if (!docUrl) {
    return res.status(400).json({ error: 'Missing Google Doc URL.' });
  }

  if (currentJobId && jobs[currentJobId]?.status === 'running') {
    return res.status(409).json({ error: 'A job is already running.' });
  }

  const cleanDocId = extractDocId(docUrl);
  console.log(`[Parser]: Extracted Document ID: ${cleanDocId}`);

  const jobId = Date.now().toString();
  const jobDir = path.join(ROOT, 'output', jobId);

  fs.mkdirSync(jobDir, { recursive: true });

  jobs[jobId] = { status: 'running', step: 'Extracting revision history from Google Docs...' };
  currentJobId = jobId;

  res.json({ status: 'started', jobId });

  (async () => {
    try {
      // ── Step 1: analysis.js ──────────────────────────────────────────────
      await runScript('node', [
        path.join(SCRIPTS, 'analysis.js'),
        cleanDocId,
        '--output', path.join(jobDir, 'report'),
      ]);

      // ── Step 2: charts.py ────────────────────────────────────────────────
      jobs[jobId].step = 'Generating contribution charts...';
      await runScript('python', [
        'charts.py',
        '--summary',   path.join(jobDir, 'report-summary.csv'),
        '--revisions', path.join(jobDir, 'report-revisions.csv'),
        '--output',    jobDir,
      ]);

      // ── Step 3: report.py ────────────────────────────────────────────────
      jobs[jobId].step = 'Compiling PDF report...';
      const reportArgs = [
        'report.py',
        '--charts',  `"${jobDir}"`,
        '--output',  `"${path.join(jobDir, 'report.pdf')}"`,
        '--title',   '"Academic Contribution & Plagiarism Report"',
      ];

      const analysisFile = path.join(jobDir, 'report-ai-analysis.txt');
      if (fs.existsSync(analysisFile)) {
        reportArgs.push('--analysis', `"${analysisFile}"`);
      }

      await runScript('python', reportArgs);

      jobs[jobId].status = 'done';
      jobs[jobId].step = 'Complete';
      console.log(`[Pipeline]: Job ${jobId} complete.`);

    } catch (err) {
      console.error(`[Pipeline Error] Job ${jobId}:`, err.message);
      jobs[jobId].status = 'error';
      jobs[jobId].error = err.message || 'An unexpected error occurred.';
    }
  })();
});
// POST /cancel - cancel currently running jobs (if any)
app.post('/cancel', (req, res) => {
  if (!currentJobId || !jobs[currentJobId] || jobs[currentJobId].status !== 'running') {
    return res.json({ message: 'No running job to cancel.' });
  }

  if (currentProc) {
    try {
      // Kill entire process tree by PID on Windows
      spawn('taskkill', ['/pid', String(currentProc.pid), '/f', '/t'], { shell: true });
    } catch (e) {
      console.error('taskkill failed:', e.message);
    }
    currentProc = null;
  }

  jobs[currentJobId].status = 'cancelled';
  jobs[currentJobId].step = 'Cancelled by user.';
  console.log(`[Pipeline]: Job ${currentJobId} cancelled.`);

  res.json({ message: 'Job cancelled.' });
});

// ── GET /status ───────────────────────────────────────────────────────────────

app.get('/status', (req, res) => {
  if (!currentJobId || !jobs[currentJobId]) {
    return res.json({ status: 'idle' });
  }
  res.json(jobs[currentJobId]);
});

// ── GET /download ─────────────────────────────────────────────────────────────

app.get('/download', (req, res) => {
  if (!currentJobId) {
    return res.status(404).send('No active job found.');
  }

  const pdfPath = path.join(ROOT, 'output', currentJobId, 'report.pdf');

  if (fs.existsSync(pdfPath)) {
    res.download(pdfPath, 'Academic_Contribution_Report.pdf');
  } else {
    res.status(404).send('PDF not found. The pipeline may have failed.');
  }
});

// ── START ─────────────────────────────────────────────────────────────────────

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Serving HTML from: ${STATIC}`);
  console.log(`Static folder exists: ${fs.existsSync(STATIC)}`);
  console.log(`front_page.html exists: ${fs.existsSync(path.join(STATIC, 'front_page.html'))}`);
});