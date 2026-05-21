// Fix for corporate proxy / self-signed certificate chain errors
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

/**
 * Google Docs Revision Diff Tool + AI Plagiarism Analysis
 * Outputs: <base>.json, <base>-summary.csv, <base>-revisions.csv, <base>-ai-analysis.txt
 * All timestamps in Singapore Time (SGT, UTC+8)
 *
 * Usage:
 *   node index.js <fileId> [--output <basePath>] [--from <revId>] [--to <revId>] [--gemini-key <apiKey>]
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

// Convert ISO timestamp to Singapore Time (SGT)
function toSGT(isoString) {
  if (!isoString) return null;
  const sgtMs = new Date(isoString).getTime() + 8 * 60 * 60 * 1000;
  const d = new Date(sgtMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} SGT`;
}

function nowSGT() { return toSGT(new Date().toISOString()); }

// Authenticate using service account or application default credentials

async function getAuthClient() {
  const serviceAccountPath = path.join(__dirname, "service-key.json");
  if (fs.existsSync(serviceAccountPath)) {
    const auth = new google.auth.GoogleAuth({ keyFile: serviceAccountPath, scopes: SCOPES });
    return auth.getClient();
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
    return auth.getClient();
  }
  throw new Error("No credentials found. Place credentials.json in this directory.");
}

// ─── DRIVE HELPERS ────────────────────────────────────────────────────────────

async function listRevisions(drive, fileId) {
  const res = await drive.revisions.list({
    fileId,
    fields: "revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress),keepForever)",
  });
  return res.data.revisions || [];
}

async function exportRevisionAsText(auth, fileId, revisionId) {
  const url = `https://docs.google.com/feeds/download/documents/export/Export?id=${fileId}&revision=${revisionId}&exportFormat=txt`;
  const res = await auth.request({ url, method: "GET", responseType: "text" });
  return (res.data || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

// ─── DIFF ─────────────────────────────────────────────────────────────────────

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

// ─── CSV ──────────────────────────────────────────────────────────────────────

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

// AI Plagiarism Analysis using LLM

async function analyzeAIPlagiarism(userTextMap, geminiApiKey) {

  const ai = new GoogleGenAI({ apiKey: geminiApiKey })
  // Build a combined prompt with all users' added text
  const userSections = Object.entries(userTextMap)
    .map(([name, text]) => `=== ${name} ===\n${text}`)
    .join("\n\n");

  const prompt = `You are an expert at detecting AI-generated text. Below is text written by different users in a collaborative Google Doc. Each section is labeled with the user's name.
Analyze the text of each user for AI plagiarism (i.e. whether their text appears to be AI-generated rather than human-written). You must show an example of 3 excerpts for each user.
For each user, your output must not have any unknown markdown formatting or HTML tags. 
The output should follow this format:

User: <name of the user>

AI Plagirism Percentage: XX% (in brackets, provide likelihood of low/medium/high)

Analysis: <a clear explanation of why>

Specific Excerpts: 
Excerpt {no}: the quoted text
Explanation(must show): your explanation of why this excerpt is likely AI-generated or human-written.

Excerpt {no}: another quoted text, change the excerpt number for each excerpt you quote
Explanation(must show): your explanation of why this excerpt is likely AI-generated or human-written
---

${userSections}`;

  console.error("\n🤖 Running AI plagiarism analysis via Gemini...");

  const response = await ai.models.generateContent({
    model: "gemma-4-26b-a4b-it",
    contents: prompt,
  });
  
  return response.text
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (!args.length || args[0] === "--help") {
    console.log(`
Usage: node index.js <fileId> [--output <basePath>] [--from <revId>] [--to <revId>] [--gemini-key <apiKey>]

Outputs (when --output is set):
  <basePath>.json              Full revision diff + user summary
  <basePath>-summary.csv       Per-user contribution summary
  <basePath>-revisions.csv     Per-revision stats table
  <basePath>-ai-analysis.txt   AI plagiarism analysis per user (requires --gemini-key)

All timestamps are in Singapore Time (SGT, UTC+8).

Examples:
  node index.js 1BxiMVs0XRA5... --output report --gemini-key YOUR_KEY
  node index.js 1BxiMVs0XRA5... --from 3 --to 7 --output filtered --gemini-key YOUR_KEY
    `);
    process.exit(0);
  }

  const fileId     = args[0];
  const rawOutput  = args.includes("--output")     ? args[args.indexOf("--output") + 1]     : null;
  const outputBase = rawOutput ? rawOutput.replace(/\.(json|csv)$/i, "") : null;
  const fromRevId  = args.includes("--from")       ? args[args.indexOf("--from") + 1]       : null;
  const toRevId    = args.includes("--to")         ? args[args.indexOf("--to") + 1]         : null;
  // Use your own Gemini API key for privacy reasons
  const geminiKey = process.env.GEMINI_API_KEY || args[args.indexOf("--gemini-key") + 1] || null;

  const generatedAt = nowSGT();

  console.error("🔐 Authenticating...");
  const authClient = await getAuthClient();
  const drive = google.drive({ version: "v3", auth: authClient });

  console.error("📋 Fetching revision list...");
  let revisions = await listRevisions(drive, fileId);
  if (!revisions.length) { console.error("❌ No revisions found."); process.exit(1); }

  if (fromRevId) {
    const idx = revisions.findIndex((r) => r.id === fromRevId);
    if (idx === -1) { console.error(`❌ Revision "${fromRevId}" not found.`); process.exit(1); }
    revisions = revisions.slice(idx);
  }
  if (toRevId) {
    const idx = revisions.findIndex((r) => r.id === toRevId);
    if (idx === -1) { console.error(`❌ Revision "${toRevId}" not found.`); process.exit(1); }
    revisions = revisions.slice(0, idx + 1);
  }

  console.error(`📄 Processing ${revisions.length} revisions...\n`);

  // Export all revision texts
  const texts = [];
  for (let i = 0; i < revisions.length; i++) {
    const rev = revisions[i];
    console.error(`  ↓ [${i+1}/${revisions.length}] Rev ${rev.id} — ${rev.lastModifyingUser?.displayName || "Unknown"} — ${toSGT(rev.modifiedTime)}`);
    try {
      texts.push(await exportRevisionAsText(authClient, fileId, rev.id));
    } catch (err) {
      console.error(`    ⚠️  Export failed (${err.response?.status ?? "?"}): ${err.message}`);
      texts.push(null);
    }
    if (i < revisions.length - 1) await new Promise((r) => setTimeout(r, 5000));
  }

  // Build revision entries
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

  // Per-user summary + collect added text per user for AI analysis
  const userMap = {};
  const userAddedText = {}; // accumulates all added text per user for Gemini

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
      userAddedText[key] = { name: rev.modifiedBy.name, chunks: [] };
    }

    const u = userMap[key];
    u.revisionsCount++;
    u.totalWordsAdded  += rev.diff.stats.wordsAdded;
    u.totalWordsRemoved += rev.diff.stats.wordsRemoved;
    u.totalCharsAdded  += rev.diff.stats.charsAdded;
    u.totalCharsRemoved += rev.diff.stats.charsRemoved;
    if (!u.firstEditSGT) u.firstEditSGT = rev.modifiedTimeSGT;
    u.lastEditSGT = rev.modifiedTimeSGT;

    // Collect the text this user added across all their revisions
    if (rev.diff.added.length > 0) {
      userAddedText[key].chunks.push(...rev.diff.added);
    }
  });

  const userSummary = Object.values(userMap);

  const output = {
    fileId, generatedAt,
    timezone: "Asia/Singapore (UTC+8)",
    totalRevisions: revisionEntries.length,
    userSummary,
    revisions: revisionEntries,
  };

  // Save revision files
  if (outputBase) {
    const jsonPath      = `${outputBase}.json`;
    const summaryPath   = `${outputBase}-summary.csv`;
    const revisionsPath = `${outputBase}-revisions.csv`;

    fs.writeFileSync(jsonPath,      JSON.stringify(output, null, 2), "utf8");
    fs.writeFileSync(summaryPath,   buildSummaryCSV(userSummary, fileId, generatedAt), "utf8");
    fs.writeFileSync(revisionsPath, buildRevisionCSV(revisionEntries, fileId, generatedAt), "utf8");

    console.error(`\n✅ Revision outputs saved:`);
    console.error(`   📄 ${jsonPath}`);
    console.error(`   📊 ${summaryPath}   ← per-user summary`);
    console.error(`   📋 ${revisionsPath} ← all revisions`);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }

  // ─── AI PLAGIARISM ANALYSIS ────────────────────────────────────────────────

  if (!geminiKey) {
    console.error("\n⚠️  No Gemini API key provided. Skipping AI plagiarism analysis.");
    console.error("   Pass --gemini-key YOUR_KEY or set the GEMINI_API_KEY environment variable.");
    return;
  }

  // Build a map of { displayName -> combined added text } for users who actually wrote something
  const userTextMap = {};
  Object.values(userAddedText).forEach(({ name, chunks }) => {
    if (chunks.length > 0) {
      userTextMap[name] = chunks.join(" ");
    }
  });

  if (!Object.keys(userTextMap).length) {
    console.error("\n⚠️  No added text found for any user. Skipping AI analysis.");
    return;
  }

  

  try {
  const analysisText = await analyzeAIPlagiarism(userTextMap, geminiKey);

  if (outputBase) {
    const analysisPath = `${outputBase}-ai-analysis.txt`;
    const header = `AI Plagiarism Analysis\nFile ID: ${fileId}\nGenerated: ${generatedAt}\n${"=".repeat(60)}\n\n`;
    fs.writeFileSync(analysisPath, header + analysisText, "utf8");
    console.error(`   🤖 ${analysisPath} ← AI plagiarism analysis`);
  } else {
    console.log("\n=== AI PLAGIARISM ANALYSIS ===\n");
    console.log(analysisText);
  }
} catch (aiErr) {
  console.error(`\n⚠️  AI analysis skipped: ${aiErr.message}`);
}
}

main().catch((err) => {
  console.error("\n❌ Fatal error:", err.message);
  process.exit(1);
});