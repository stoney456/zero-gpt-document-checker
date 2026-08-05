// scripts/server.js
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const ws = require('ws');

// SUPABASE CONNECTION
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: {
    transport: ws,
  },
});


const app = express();
app.use(express.json());

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
];

async function getGoogleAuthClient() {
  const serviceKeyEnv = process.env.GOOGLE_SERVICE_KEY;
  if (serviceKeyEnv && serviceKeyEnv.trim().startsWith('{')) {
    try {
      const credentials = JSON.parse(serviceKeyEnv);
      const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
      return auth.getClient();
    } catch (err) {
      console.error('[History] GOOGLE_SERVICE_KEY is invalid JSON, falling back to service-key.json');
    }
  }

  const serviceAccountPath = path.join(__dirname, 'service-key.json');
  if (fs.existsSync(serviceAccountPath)) {
    const auth = new google.auth.GoogleAuth({ keyFile: serviceAccountPath, scopes: SCOPES });
    return auth.getClient();
  }

  throw new Error('No Google credentials found for history title lookup.');
}

async function resolveDocumentTitle(docId) {
  if (!docId) return null;
  try {
    const authClient = await getGoogleAuthClient();
    const drive = google.drive({ version: 'v3', auth: authClient });
    const res = await drive.files.get({ fileId: docId, fields: 'name' });
    return res.data?.name || null;
  } catch (err) {
    console.warn('[History] Could not resolve document title for', docId, err.message);
    return null;
  }
}

// ROOT always points to the project root regardless of where node is run from
const ROOT    = path.dirname(path.dirname(path.resolve(__filename)));
const STATIC  = path.join(ROOT, 'static');
const STYLES  = path.join(ROOT, 'styles');
const ASSETS  = path.join(ROOT, 'assets');
const SCRIPTS = path.join(ROOT, 'scripts');

// Job Queue
const MAX_CONCURRENT_JOBS = parseInt(process.env.QUEUE_CONCURRENCY, 10) || 1;

const jobs = {};   // in-memory cache: jobId -> { status, step, progress, error, proc, meta }
const queue = [];  // jobIds waiting to run, FIFO
let activeCount = 0;
let currentJobId = null;

async function upsertJobRow(jobId, patch) {
  try {
    const { error } = await supabase.from('job_queue').upsert({
      id: jobId,
      updated_at: new Date().toISOString(),
      ...patch,
    });
    if (error) console.error('[Queue] Failed to persist job', jobId, error.message);
  } catch (err) {
    console.error('[Queue] Failed to persist job', jobId, err.message);
  }
}

function updateJob(jobId, patch) {
  jobs[jobId] = { ...(jobs[jobId] || {}), ...patch };
  const dbPatch = {};
  if (patch.status !== undefined) dbPatch.status = patch.status;
  if (patch.step !== undefined) dbPatch.step = patch.step;
  if (patch.error !== undefined) dbPatch.error = patch.error;
  if (patch.progress !== undefined) {
    dbPatch.progress_current = patch.progress ? patch.progress.current : null;
    dbPatch.progress_total   = patch.progress ? patch.progress.total   : null;
  }
  if (Object.keys(dbPatch).length) upsertJobRow(jobId, dbPatch);
}

function queuePosition(jobId) {
  const idx = queue.indexOf(jobId);
  return idx === -1 ? null : idx + 1;
}

function processQueue() {
  while (activeCount < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const jobId = queue.shift();
    if (!jobs[jobId] || jobs[jobId].status === 'cancelled') continue;
    activeCount++;
    currentJobId = jobId;
    const { cleanDocId, jobDir } = jobs[jobId].meta;
    updateJob(jobId, { status: 'running', step: 'Extracting revision history from Google Docs...', progress: null });
    runPipeline(jobId, cleanDocId, jobDir).finally(() => {
      activeCount--;
      processQueue();
    });
  }
}

async function restoreQueueOnBoot() {
  try {
    const { data, error } = await supabase
      .from('job_queue')
      .select('id, doc_id, status')
      .in('status', ['queued', 'running'])
      .order('created_at', { ascending: true });
    if (error) throw error;

    for (const row of data || []) {
      const jobDir = path.join(ROOT, 'output', row.id);
      jobs[row.id] = {
        status: 'queued',
        step: 'Waiting in queue (recovered after restart)...',
        progress: null,
        meta: { cleanDocId: row.doc_id, jobDir },
      };
      queue.push(row.id);
      updateJob(row.id, { status: 'queued', step: jobs[row.id].step });
    }
    if (queue.length) {
      console.log(`[Queue] Restored ${queue.length} job(s) from Supabase after restart.`);
      processQueue();
    }
  } catch (err) {
    console.error('[Queue] Could not restore queue on boot:', err.message);
  }
}


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
function runScript(command, args, onData, jobId) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: ROOT,
      shell: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    if (jobId && jobs[jobId]) {
      jobs[jobId].proc = proc;
    }

    const handleChunk = (data) => {
      const text = data.toString().trim();
      const match = text.match(/\[Progress\]\s*(\d+)\/(\d+)/);
      if (match && onData) {
        onData({ progress: { current: parseInt(match[1], 10), total: parseInt(match[2], 10) } });
      }
      if (onData) onData({ text });
    };
    proc.stdout.on('data', (data) => { console.log(`[Script]: ${data.toString().trim()}`); handleChunk(data); });
    proc.stderr.on('data', (data) => { console.error(`[Script Err]: ${data.toString().trim()}`); handleChunk(data); });
    proc.on('close', (code) => {
      if (jobId && jobs[jobId]) {
        jobs[jobId].proc = null;
      }
      if (code === 0 || code === null) resolve();
      else reject(new Error(`Script exited with code ${code}`));
    });
    proc.on('error', (err) => {
      if (jobId && jobs[jobId]) {
        jobs[jobId].proc = null;
      }
      reject(new Error(`Failed to spawn process: ${err.message}`));
    });
  });
}

async function runPipeline(jobId, cleanDocId, jobDir) {
  console.log(`[Pipeline] Job ${jobId} starting...`);
  try {
    console.log(`[Pipeline] Job ${jobId} - Starting STEP 1: analysis.js`);
    await runScript('node', [
      path.join(SCRIPTS, 'analysis.js'),
      cleanDocId,
      '--output', path.join(jobDir, 'report'),
    ], (msg) => {
      if (msg.progress) updateJob(jobId, { progress: msg.progress });
      if (msg.text && msg.text.includes('Extraction complete')) {
        updateJob(jobId, { step: 'Running AI analysis on text...', progress: null });
      }
    }, jobId);
    console.log(`[Pipeline] Job ${jobId} - STEP 1 complete`);

    console.log(`[Pipeline] Job ${jobId} - Starting STEP 2: charts.py`);
    updateJob(jobId, { step: 'Generating contribution charts...', progress: null });
    await runScript('python', [
      'charts.py',
      '--summary',   path.join(jobDir, 'report-summary.csv'),
      '--revisions', path.join(jobDir, 'report-revisions.csv'),
      '--output',    jobDir,
    ], (msg) => {
      if (msg.progress) updateJob(jobId, { progress: msg.progress });
    }, jobId);
    console.log(`[Pipeline] Job ${jobId} - STEP 2 complete`);

    console.log(`[Pipeline] Job ${jobId} - Starting STEP 3: report.py`);
    updateJob(jobId, { step: 'Compiling PDF report...', progress: null });
    const reportJsonPath = path.join(jobDir, 'report.json');
    let documentName = null;
    if (fs.existsSync(reportJsonPath)) {
      try {
        const reportJson = JSON.parse(fs.readFileSync(reportJsonPath, 'utf8'));
        documentName = reportJson.documentTitle || reportJson.fileId || 'Untitled document';
      } catch (err) {
        console.warn('[Pipeline] Could not read report.json for PDF metadata:', err.message);
      }
    }

    const reportArgs = [
      'report.py',
      '--charts',  `"${jobDir}"`,
      '--output',  `"${path.join(jobDir, 'report.pdf')}"`,
      '--title',   '"Academic Contribution & Plagiarism Report"',
    ];
    const analysisFile = path.join(jobDir, 'report-ai-analysis.txt');
    if (fs.existsSync(analysisFile)) reportArgs.push('--analysis', `"${analysisFile}"`);
    if (documentName) reportArgs.push('--document-name', `"${documentName}"`);

    await runScript('python', reportArgs, (msg) => {
      if (msg.progress) updateJob(jobId, { progress: msg.progress });
    }, jobId);
    console.log(`[Pipeline] Job ${jobId} - STEP 3 complete`);

    try {
      const reportJson = JSON.parse(fs.readFileSync(reportJsonPath, 'utf8'));
      const timestamp = reportJson.generatedAt.replace(/[^0-9]/g, '-').slice(0, 10);
      const base = `${jobId}`;

      const filesToUpload = [
        { local: path.join(jobDir, 'report.pdf'),                              storage: `${base}/Contribution_Report_${timestamp}.pdf`, contentType: 'application/pdf' },
        { local: path.join(jobDir, 'report-summary.csv'),                      storage: `${base}/report-summary.csv`,                   contentType: 'text/csv' },
        { local: path.join(jobDir, 'report-revisions.csv'),                    storage: `${base}/report-revisions.csv`,                 contentType: 'text/csv' },
        { local: path.join(jobDir, 'report-ai-analysis.txt'),                  storage: `${base}/report-ai-analysis.txt`,               contentType: 'text/plain' },
        { local: path.join(jobDir, 'report-user-text.txt'),                    storage: `${base}/report-user-text.txt`,                 contentType: 'text/plain' },
        { local: path.join(jobDir, 'report.json'),                             storage: `${base}/report.json`,                          contentType: 'application/json' },
        { local: path.join(jobDir, 'contribution-pie.png'),                    storage: `${base}/contribution-pie.png`,                 contentType: 'image/png' },
        { local: path.join(jobDir, 'contribution-line-networds.png'),          storage: `${base}/contribution-line-networds.png`,       contentType: 'image/png' },
        { local: path.join(jobDir, 'contribution-line-revision-networds.png'), storage: `${base}/contribution-line-revision-networds.png`, contentType: 'image/png' },
      ];

      for (const f of filesToUpload) {
        if (!fs.existsSync(f.local)) { console.log('[History]: Skipping missing file:', f.local); continue; }
        const buffer = fs.readFileSync(f.local);
        const { error: uploadErr } = await supabase.storage
          .from('report')
          .upload(f.storage, buffer, { contentType: f.contentType, upsert: true });
        if (uploadErr) throw uploadErr;
      }

      const documentTitle = reportJson.documentTitle || reportJson.fileId || 'Untitled document';
      const { error: dbErr } = await supabase.from('history').upsert({
        id: jobId,
        doc_id: reportJson.fileId,
        title: documentTitle,
        generated_at: reportJson.generatedAt,
        user_summary: JSON.stringify(reportJson.userSummary),
        pdf_path:           `${base}/Contribution_Report_${timestamp}.pdf`,
        csv_summary_path:   `${base}/report-summary.csv`,
        csv_revisions_path: `${base}/report-revisions.csv`,
        ai_analysis_path:   `${base}/report-ai-analysis.txt`,
        user_text_path:     `${base}/report-user-text.txt`,
        json_path:          `${base}/report.json`,
      });
      if (dbErr) throw dbErr;
      console.log('[History]: Job', jobId, 'saved to Supabase successfully.');
    } catch (histErr) {
      console.error('[History Error] Job', jobId, ':', histErr.message);
    }

    updateJob(jobId, { status: 'done', step: 'Complete' });
    console.log(`[Pipeline]: Job ${jobId} complete.`);
  } catch (err) {
    console.error(`[Pipeline Error] Job ${jobId}: ${err.message}`);
    updateJob(jobId, { status: 'error', error: err.message || 'An unexpected error occurred.' });
  }
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

// POST /analyze — start the pipeline 

app.post('/analyze', (req, res) => {
  console.log('[Analyze] POST /analyze received, body:', req.body);
  const { docUrl } = req.body;

  if (!docUrl) {
    console.log('[Analyze] Error: Missing Google Doc URL');
    return res.status(400).json({ error: 'Missing Google Doc URL.' });
  }

  const cleanDocId = extractDocId(docUrl);
  console.log(`[Parser]: Extracted Document ID: ${cleanDocId}`);

  const jobId = Date.now().toString();
  const jobDir = path.join(ROOT, 'output', jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  jobs[jobId] = {
    status: 'queued',
    step: 'Waiting in queue...',
    progress: null,
    meta: { cleanDocId, jobDir },
  };
  queue.push(jobId);
  upsertJobRow(jobId, { doc_id: cleanDocId, status: 'queued', step: 'Waiting in queue...' });

  res.json({ status: 'started', jobId, queuePosition: queuePosition(jobId) });

  processQueue();
});

// GET /history - fetch all past analyses from Supabase
app.get('/history', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('history')
      .select('id, doc_id, title, generated_at, user_summary, pdf_path, csv_summary_path, csv_revisions_path, ai_analysis_path, json_path, user_text_path')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const sign = async (storagePath) => {
      if (!storagePath) return null;
      const { data: signed, error: signErr } = await supabase.storage
        .from('report')
        .createSignedUrl(storagePath, 60 * 60);
      return signErr ? null : signed.signedUrl;
    };

    const withUrls = await Promise.all(data.map(async (job) => {
      let displayTitle = job.title || 'Untitled document';

      if (!displayTitle || displayTitle === 'Academic Contribution & Plagiarism Report') {
        const resolvedTitle = await resolveDocumentTitle(job.doc_id);
        if (resolvedTitle) {
          displayTitle = resolvedTitle;
        } else {
          try {
            const { data: jsonBlob, error: downloadErr } = await supabase.storage
              .from('report')
              .download(job.json_path);

            if (!downloadErr && jsonBlob) {
              const text = await jsonBlob.text();
              const parsed = JSON.parse(text);
              if (parsed?.documentTitle) {
                displayTitle = parsed.documentTitle;
              }
            }
          } catch (err) {
            console.warn('[History Title] Could not resolve title from report JSON:', err.message);
          }
        }
      }

      return {
        ...job,
        displayTitle,
        downloadUrl:     await sign(job.pdf_path),
        csvSummaryUrl:   await sign(job.csv_summary_path),
        csvRevisionsUrl: await sign(job.csv_revisions_path),
        aiAnalysisUrl:   await sign(job.ai_analysis_path),
        userTextUrl:     await sign(job.user_text_path),
      };
    }));

    res.json({ jobs: withUrls });
  } catch (err) {
    console.error('[History Fetch Error]:', err.message);
    res.status(500).json({ error: 'Could not load history.' });
  }
});

// DELETE /history/:id - delete a job from Supabase storage and DB
app.delete('/history/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // List all files in the job's storage folder
    const { data: files, error: listErr } = await supabase.storage
      .from('report')
      .list(id);
    if (listErr) throw listErr;

    if (files && files.length > 0) {
      const paths = files.map(f => `${id}/${f.name}`);
      const { error: removeErr } = await supabase.storage
        .from('report')
        .remove(paths);
      if (removeErr) throw removeErr;
      console.log(`[Delete] Removed ${paths.length} file(s) from storage for job ${id}`);
    }

    // Delete the DB row
    const { error: dbErr } = await supabase
      .from('history')
      .delete()
      .eq('id', id);
    if (dbErr) throw dbErr;

    console.log(`[Delete] Job ${id} deleted from DB.`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[Delete Error] Job ${id}:`, err.message);
    res.status(500).json({ error: 'Could not delete job.' });
  }
});
app.get('/history_page.html', (req, res) => {
  sendFileContent(res, path.join(STATIC, 'history_page.html'), 'text/html');
});

// POST /cancel - cancel currently running jobs (if any)
app.post('/cancel', (req, res) => {
  const jobId = req.query.jobId || currentJobId;
  if (!jobId || !jobs[jobId]) {
    return res.json({ message: 'No running job to cancel.' });
  }

  const job = jobs[jobId];

  if (job.status === 'queued') {
    const idx = queue.indexOf(jobId);
    if (idx !== -1) queue.splice(idx, 1);
    updateJob(jobId, { status: 'cancelled', step: 'Cancelled by user.' });
    return res.json({ message: 'Job cancelled.' });
  }

  if (job.status !== 'running') {
    return res.json({ message: 'No running job to cancel.' });
  }

  const proc = job.proc;
  if (proc) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { shell: true });
      } else {
        process.kill(-proc.pid, 'SIGKILL'); // negative pid kills the whole process group
      }
    } catch (e) {
      console.error('Failed to kill process:', e.message);
    }
    jobs[jobId].proc = null;
  }

  updateJob(jobId, { status: 'cancelled', step: 'Cancelled by user.' });
  console.log(`[Pipeline]: Job ${jobId} cancelled.`);
  res.json({ message: 'Job cancelled.' });
});

// GET /status

app.get('/status', async (req, res) => {
  const jobId = req.query.jobId || currentJobId;
  if (!jobId) return res.json({ status: 'idle' });

  if (jobs[jobId]) {
    const job = jobs[jobId];
    return res.json({
      status: job.status,
      step: job.step,
      progress: job.progress,
      error: job.error,
      queuePosition: job.status === 'queued' ? queuePosition(jobId) : null,
    });
  }

  try {
    const { data, error } = await supabase
      .from('job_queue')
      .select('status, step, progress_current, progress_total, error')
      .eq('id', jobId)
      .single();
    if (error || !data) return res.json({ status: 'idle' });
    res.json({
      status: data.status,
      step: data.step,
      progress: data.progress_current != null ? { current: data.progress_current, total: data.progress_total } : null,
      error: data.error,
    });
  } catch {
    res.json({ status: 'idle' });
  }
});

// GET /download 

app.get('/download', (req, res) => {
  const jobId = req.query.jobId || currentJobId;
  if (!jobId) {
    return res.status(404).send('No active job found.');
  }

  const pdfPath = path.join(ROOT, 'output', jobId, 'report.pdf');

  if (fs.existsSync(pdfPath)) {
    res.download(pdfPath, 'Academic_Contribution_Report.pdf');
  } else {
    res.status(404).send('PDF not found. The pipeline may have failed.');
  }
});

// START 

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Serving HTML from: ${STATIC}`);
  console.log(`Static folder exists: ${fs.existsSync(STATIC)}`);
  console.log(`front_page.html exists: ${fs.existsSync(path.join(STATIC, 'front_page.html'))}`);
  restoreQueueOnBoot();
});