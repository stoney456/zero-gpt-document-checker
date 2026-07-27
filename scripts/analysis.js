process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

/**
 * Google Docs Revision Diff Tool + AI Plagiarism Analysis
 * Outputs: <base>.json, <base>-summary.csv, <base>-revisions.csv, <base>-ai-analysis.txt
 * All timestamps in Singapore Time (SGT, UTC+8)
 *
 * Usage:
 *   node analysis.js <fileId> [--output <basePath>] [--from <revId>] [--to <revId>]
 *
 * Requirements:
 *   npm install googleapis diff @google/genai
 */

const { google } = require("googleapis");
const { diffWords } = require("diff");
const { GoogleGenAI } = require("@google/genai");
const fs = require("fs");
const path = require("path");

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
];

// CONVERT TIMEZONE
// Convert ISO timestamp to Singapore Time (SGT)
function toSGT(isoString) {
  if (!isoString) return null;
  const sgtMs = new Date(isoString).getTime() + 8 * 60 * 60 * 1000;
  const d = new Date(sgtMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} SGT`;
}

function nowSGT() { return toSGT(new Date().toISOString()); }

// Authentication

async function getAuthClient() {
  // Option 1: environment variable
  const serviceKeyEnv = process.env.GOOGLE_SERVICE_KEY;
  if (serviceKeyEnv && serviceKeyEnv.trim().startsWith("{")) {
    try {
      const credentials = JSON.parse(serviceKeyEnv);
      const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
      return auth.getClient();
    } catch (err) {
      console.error("GOOGLE_SERVICE_KEY env var is invalid JSON, falling back to service-key.json");
    }
  }

  // Option 2: Run application locally if environment key cannot be used locally, fallback on service-key.json
  const serviceAccountPath = path.join(__dirname, "service-key.json");
  if (fs.existsSync(serviceAccountPath)) {
    const auth = new google.auth.GoogleAuth({ keyFile: serviceAccountPath, scopes: SCOPES });
    return auth.getClient();
  }

  throw new Error("No credentials found. Set GOOGLE_SERVICE_KEY env variable or place service-key.json in the scripts folder.");
}

// GOOGLE DOCS REVISIONS RETRIEVAL

async function listRevisions(drive, fileId) {
  const res = await drive.revisions.list({
    fileId,
    fields: "revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress),keepForever)",
  });
  return res.data.revisions || [];
}

async function getFileMetadata(drive, fileId) {
  try {
    const res = await drive.files.get({
      fileId,
      fields: "name,mimeType",
    });
    return res.data || null;
  } catch (err) {
    console.error(`Could not fetch document metadata for ${fileId}: ${err.message}`);
    return null;
  }
}

async function exportRevisionAsText(auth, fileId, revisionId) {
  const url = `https://docs.google.com/feeds/download/documents/export/Export?id=${fileId}&revision=${revisionId}&exportFormat=txt`;
  const res = await auth.request({ url, method: "GET", responseType: "text" });
  return (res.data || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

// DIFF 

function computeDiff(prevText, currText) {
  const changes = diffWords(prevText, currText);
  const added = [], removed = [];
  changes.forEach((part) => {
    if (part.added && part.value.trim()) added.push(part.value.trim());
    if (part.removed && part.value.trim()) removed.push(part.value.trim());
  });
  const addedWords = added.join(" ").split(/\s+/).filter(Boolean).length;
  const removedWords = removed.join(" ").split(/\s+/).filter(Boolean).length;
  return {
    added, removed,
    stats: {
      wordsAdded: addedWords, wordsRemoved: removedWords,
      charsAdded: added.join("").length, charsRemoved: removed.join("").length,
      netWords: addedWords - removedWords,
    },
  };
}

// USER TEXT MAP 
// Collects text added by each user across all their revisions.
// Uses the final document text to verify chunks still exist before including them.

function buildUserFinalTextMap(revisions, texts) {
  const finalText = texts[texts.length - 1] ?? "";
  const userChunks = {};

  for (let i = 0; i < revisions.length; i++) {
    const currText = texts[i];
    if (currText === null) continue;

    const prevText = i === 0 ? "" : (texts[i - 1] ?? "");
    const author = revisions[i].lastModifyingUser?.displayName || "Unknown";
    const changes = diffWords(prevText || "", currText);

    changes.forEach((part) => {
      if (part.added && part.value.trim().length > 0) {
        if (!userChunks[author]) userChunks[author] = [];
        userChunks[author].push(part.value.trim());
      }
    });
  }

  // Only keep chunks that still appear in the final document
  const result = {};
  Object.entries(userChunks).forEach(([author, chunks]) => {
    const surviving = chunks.filter(chunk => {
      const words = chunk.split(/\s+/).filter(Boolean);
      if (words.length < 3) return false;
      const phrase = words.slice(0, 4).join(" ").toLowerCase();
      return finalText.toLowerCase().includes(phrase);
    });

    // Fall back to all chunks if none survived
    const toUse = surviving.length > 0 ? surviving : chunks.filter(c => c.length > 10);
    const combined = toUse.join(" ").trim();
    if (combined.length > 0) result[author] = combined;
  });

  return result;
}

// STORE DATA INTO CSV

function csv(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  return (s.includes(",") || s.includes('"') || s.includes("\n"))
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildSummaryCSV(userSummary, fileId, generatedAt) {
  const meta = `# Google Docs User Summary\n# File ID: ${fileId}\n# Generated: ${generatedAt}\n#`;
  const header = "Name,Email,Revisions Made,Words Added,Words Removed,Net Words,Chars Added,Chars Removed,First Edit (SGT),Last Edit (SGT)";
  const rows = userSummary.map((u) =>
    [csv(u.name), csv(u.email), u.revisionsCount, u.totalWordsAdded, u.totalWordsRemoved,
     u.totalWordsAdded - u.totalWordsRemoved, u.totalCharsAdded, u.totalCharsRemoved,
     csv(u.firstEditSGT), csv(u.lastEditSGT)].join(",")
  );
  return [meta, header, ...rows].join("\n");
}
// Store extracted data into a csv file to be later used to create charts for user contribution analysis
function buildRevisionCSV(revisions, fileId, generatedAt) {
  const meta = `# Google Docs Revision Detail\n# File ID: ${fileId}\n# Generated: ${generatedAt}\n#`;
  const header = "Revision Index,Revision ID,Modified Time (SGT),Name,Email,Is First Revision,Has Changes,Words Added,Words Removed,Net Words,Chars Added,Chars Removed,Error";
  const rows = revisions.map((r) =>
    [r.revisionIndex, csv(r.revisionId), csv(r.modifiedTimeSGT), csv(r.modifiedBy.name), csv(r.modifiedBy.email),
     r.isFirstRevision, r.hasChanges ?? "", r.diff?.stats.wordsAdded ?? "", r.diff?.stats.wordsRemoved ?? "",
     r.diff?.stats.netWords ?? "", r.diff?.stats.charsAdded ?? "", r.diff?.stats.charsRemoved ?? "",
     csv(r.error ?? "")].join(",")
  );
  return [meta, header, ...rows].join("\n");
}

function buildUserTextFile(userFinalTextMap) {
  return Object.entries(userFinalTextMap)
    .map(([author, text]) => `${author}:\n${text}`)
    .join("\n\n---\n\n");
}

// AI ANALYSIS WITH GEMINI LLM

async function analyzeAIPlagiarism(userTextMap, geminiApiKey) {
  const ai = new GoogleGenAI({ apiKey: geminiApiKey });
  const MAX_CHARS = 20000;

  // Retry wrapper for transient 500/503 errors on Gemma endpoints
  async function withRetry(fn, retries = 4, baseDelay = 1500) {
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn();
      } catch (err) {
        const isRetryable = err.message?.includes("500") || err.message?.includes("503") || err.message?.includes("INTERNAL");
        if (i === retries || !isRetryable) throw err;
        const delay = baseDelay * Math.pow(2, i);
        console.error(`Retrying after ${delay}ms (attempt ${i + 1}/${retries})...`);
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }

  const perUserPrompt = (name, text) => {
    const trimmedText = text.length > MAX_CHARS
      ? text.slice(0, MAX_CHARS) + "\n[...truncated]"
      : text;

    return `You are an expert at detecting AI-generated text.
    Analyze the following text written by "${name}" for AI plagiarism.
    Your output must not have any markdown formatting or HTML tags.
    Follow this format exactly:
    User: ${name}
    AI Plagiarism Percentage: XX% (Low / Medium / High)
    Analysis: A clear explanation of why.
    Specific Excerpts:
    Excerpt 1: the quoted text
    Explanation: your explanation of why this excerpt is likely AI-generated or human-written.

    Excerpt 2: the quoted text
    Explanation: your explanation of why this excerpt is likely AI-generated or human-written.

    Excerpt 3: the quoted text
    Explanation: your explanation of why this excerpt is likely AI-generated or human-written.
    ---
    === ${name} ===
    ${trimmedText}`;
      };

  console.error("Running AI plagiarism analysis...");
  const entries = Object.entries(userTextMap);
  const results = await Promise.all(
    entries.map(async ([name, text]) => {
      try {
        const response = await withRetry(() =>
          ai.models.generateContent({
            model: "gemma-4-31b-it",
            contents: [{ role: "user", parts: [{ text: perUserPrompt(name, text) }] }],
            config: {
              temperature: 0.4,
              topP: 0.95,
              topK: 70,
              maxOutputTokens: 8192,
            },
          })
        );

        let result = "";
        if (response?.candidates?.[0]?.content?.parts) {
          result = response.candidates[0].content.parts
            .filter(p => !p.thought)
            .map(p => p.text || "")
            .join("")
            .trim();
        }
        if (!result) result = (response.text || "").trim();
        if (!result) {
          console.error(`Warning: empty response for "${name}"`);
          return `User: ${name}\n\nAI Plagiarism Percentage: N/A\n\nAnalysis: Model returned no response for this user.\n---`;
        }
        return result;
      } catch (err) {
        console.error(`Failed for "${name}": ${err.message}`);
        return `User: ${name}\n\nAI Plagiarism Percentage: N/A\n\nAnalysis: Error during analysis: ${err.message}\n---`;
      }
    })
  );
  return results.join("\n\n");
}

// MAIN

async function main() {
  const args = process.argv.slice(2);

  if (!args.length || args[0] === "--help") {
    console.log(`
Usage: node analysis.js <fileId> [--output <basePath>] [--from <revId>] [--to <revId>]

Environment variables:
  GOOGLE_SERVICE_KEY   Service account JSON (string)
  GEMINI_API_KEY       Gemini API key

Outputs (when --output is set):
  <basePath>.json              Full revision diff + user summary
  <basePath>-summary.csv       Per-user contribution summary
  <basePath>-revisions.csv     Per-revision stats table
  <basePath>-ai-analysis.txt   AI plagiarism analysis per user
    `);
    process.exit(0);
  }

  const fileId     = args[0];
  const rawOutput  = args.includes("--output") ? args[args.indexOf("--output") + 1] : null;
  const outputBase = rawOutput ? rawOutput.replace(/\.(json|csv)$/i, "") : null;
  const outputDir  = outputBase ? path.dirname(outputBase) : null;
  const fromRevId  = args.includes("--from")   ? args[args.indexOf("--from") + 1]   : null;
  const toRevId    = args.includes("--to")     ? args[args.indexOf("--to") + 1]     : null;

  // Gemini key: environment variable only
  const geminiKey = "AIzaSyC6lWuWJSaZJmJMf9NpenKxCfPQ4KTu6AA";
  if (!geminiKey) {
    console.error("No GEMINI_API_KEY environment variable set. Skipping AI analysis.");
  }

  const generatedAt = nowSGT();

  console.error("Authenticating...");
  const authClient = await getAuthClient();
  const drive = google.drive({ version: "v3", auth: authClient });

  const fileMetadata = await getFileMetadata(drive, fileId);
  const documentTitle = fileMetadata?.name || null;

  console.error("Fetching revision list...");
  let revisions = await listRevisions(drive, fileId);
  if (!revisions.length) { console.error("No revisions found."); process.exit(1); }

  if (fromRevId) {
    const idx = revisions.findIndex((r) => r.id === fromRevId);
    if (idx === -1) { console.error(`Revision "${fromRevId}" not found.`); process.exit(1); }
    revisions = revisions.slice(idx);
  }
  if (toRevId) {
    const idx = revisions.findIndex((r) => r.id === toRevId);
    if (idx === -1) { console.error(`Revision "${toRevId}" not found.`); process.exit(1); }
    revisions = revisions.slice(0, idx + 1);
  }

  console.error(`Processing ${revisions.length} revisions...`);

  const texts = [];
  for (let i = 0; i < revisions.length; i++) {
    const rev = revisions[i];
    console.error(`  [${i+1}/${revisions.length}] Rev ${rev.id} — ${rev.lastModifyingUser?.displayName || "Unknown"} — ${toSGT(rev.modifiedTime)}`);
    try {
      texts.push(await exportRevisionAsText(authClient, fileId, rev.id));
    } catch (err) {
      console.error(`    Export failed (${err.response?.status ?? "?"}): ${err.message}`);
      texts.push(null);
    }
    if (i < revisions.length - 1) await new Promise((r) => setTimeout(r, 5000));
    console.error(`[Progress] ${i+1}/${revisions.length}`);
  }

  const revisionEntries = [];
  let lastGoodText = "";

  for (let i = 0; i < revisions.length; i++) {
    const rev = revisions[i];
    const currText = texts[i];
    const prevText = i === 0 ? "" : (texts[i - 1] ?? lastGoodText);

    const entry = {
      revisionIndex: i + 1,
      revisionId: rev.id,
      modifiedTime: rev.modifiedTime,
      modifiedTimeSGT: toSGT(rev.modifiedTime),
      modifiedBy: {
        name: rev.lastModifyingUser?.displayName || "Unknown",
        email: rev.lastModifyingUser?.emailAddress || null,
      },
      isFirstRevision: i === 0,
    };


    if (currText === null) {
      entry.error = "Could not export this revision";
      entry.hasChanges = false;
    } else {
      const diff = computeDiff(prevText, currText);
      entry.diff = diff;
      entry.hasChanges = diff.added.length > 0 || diff.removed.length > 0;
      lastGoodText = currText;
    }

    revisionEntries.push(entry);
  }

  const userMap = {};
  revisionEntries.forEach((rev) => {
    if (!rev.diff) return;
    const key = rev.modifiedBy.email || rev.modifiedBy.name;

    if (!userMap[key]) {
      userMap[key] = {
        name: rev.modifiedBy.name, email: rev.modifiedBy.email,
        revisionsCount: 0, totalWordsAdded: 0, totalWordsRemoved: 0,
        totalCharsAdded: 0, totalCharsRemoved: 0,
        firstEditSGT: null, lastEditSGT: null,
      };
    }

    const u = userMap[key];
    u.revisionsCount++;
    u.totalWordsAdded   += rev.diff.stats.wordsAdded;
    u.totalWordsRemoved += rev.diff.stats.wordsRemoved;
    u.totalCharsAdded   += rev.diff.stats.charsAdded;
    u.totalCharsRemoved += rev.diff.stats.charsRemoved;
    if (!u.firstEditSGT) u.firstEditSGT = rev.modifiedTimeSGT;
    u.lastEditSGT = rev.modifiedTimeSGT;
  });

  const userSummary = Object.values(userMap);
  const output = {
    fileId,
    documentTitle,
    generatedAt,
    timezone: "Asia/Singapore (UTC+8)",
    totalRevisions: revisionEntries.length,
    userSummary,
    revisions: revisionEntries,
  };

  const userTextMap = buildUserFinalTextMap(revisions, texts);

  if (outputBase) {
    fs.writeFileSync(`${outputBase}.json`,          JSON.stringify(output, null, 2), "utf8");
    fs.writeFileSync(`${outputBase}-summary.csv`,   buildSummaryCSV(userSummary, fileId, generatedAt), "utf8");
    fs.writeFileSync(`${outputBase}-revisions.csv`, buildRevisionCSV(revisionEntries, fileId, generatedAt), "utf8");

    const userTextContent = buildUserTextFile(userTextMap);
    const userTextPath = path.join(outputDir || ".", "report-user-text.txt");
    fs.writeFileSync(userTextPath, userTextContent, "utf8");

    console.error(`Revision outputs saved: ${outputBase}.json, ${outputBase}-summary.csv, ${outputBase}-revisions.csv`);
    console.error(`User text saved: ${userTextPath}`);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }

  console.error('[Status] Extraction complete. Starting AI plagiarism analysis...');
  // Checks if all editors from Google Docs are accounted for

  if (!geminiKey) return;

  console.error("Attributing final document text to users...");

  if (!Object.keys(userTextMap).length) {
    console.error("No text attributed to any user. Skipping AI analysis.");
    return;
  }

  // Clear stale analysis file
  if (outputBase) {
    const analysisPath = `${outputBase}-ai-analysis.txt`;
    if (fs.existsSync(analysisPath)) fs.unlinkSync(analysisPath);
  }

// Save AI analysis with a given name
  try {
    const analysisText = await analyzeAIPlagiarism(userTextMap, geminiKey);

    if (outputBase) {
      const analysisPath = `${outputBase}-ai-analysis.txt`;
      const header = `AI Plagiarism Analysis\nFile ID: ${fileId}\nGenerated: ${generatedAt}\n${"=".repeat(60)}\n\n`;
      fs.writeFileSync(analysisPath, header + analysisText, "utf8");
      console.error(`AI analysis saved: ${analysisPath}`);
    } else {
      console.log("\n=== AI PLAGIARISM ANALYSIS ===\n");
      console.log(analysisText);
    }
  } catch (aiErr) {
    console.error(`AI analysis failed: ${aiErr.message}`);
    if (aiErr.response) {
      console.error(`Gemini status: ${aiErr.response.status}`);
      console.error(`Gemini body: ${JSON.stringify(aiErr.response.data)}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});