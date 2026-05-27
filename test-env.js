#!/usr/bin/env node
/**
 * test-env.js
 * Standalone diagnostic script to verify Render environment variables.
 * Bypasses all application business logic to test pure visibility.
 */

console.log("\n========================================================");
console.log("⚙️  LAUNCHING RENDER ENVIRONMENT DIAGNOSTIC TEST");
console.log("========================================================");

// ── 1. TEST GEMINI API KEY ───────────────────────────────────────────────────
console.log("\n[1/2] Checking GEMINI_API_KEY...");

const geminiKey = process.env.GEMINI_API_KEY;

if (geminiKey) {
    console.log("  ✅ SUCCESS: GEMINI_API_KEY is visible to Node.js.");
    console.log(`  ℹ️  String Length: ${geminiKey.length} characters`);
    console.log(`  ℹ️  Key Masked:    ${geminiKey.substring(0, 6)}...${geminiKey.substring(geminiKey.length - 4)}`);
    
    if (geminiKey.includes(" ")) {
        console.log("  ⚠️  WARNING: Your key contains spaces! Check for accidental whitespace in Render.");
    }
} else {
    console.error("  ❌ ERROR: GEMINI_API_KEY is completely undefined or null!");
    console.error("     Ensure the variable name is exactly 'GEMINI_API_KEY' in Render Settings.");
}

// ── 2. TEST GOOGLE SERVICE ACCOUNT KEY ───────────────────────────────────────
console.log("\n[2/2] Checking Google Service Account Key...");

// Check if you used Method 1 (Secret File) or Method 2 (Environment Variable)
const secretFilePath = "./google-key.json";
const fs = require('fs');

if (fs.existsSync(secretFilePath)) {
    console.log("  ✅ SUCCESS: Secret file 'google-key.json' found in root directory.");
    try {
        const fileContent = fs.readFileSync(secretFilePath, 'utf8');
        const parsedJson = JSON.parse(fileContent);
        console.log("  ✅ SUCCESS: Secret file contains valid, parseable JSON.");
        console.log(`  ℹ️  Project ID:  ${parsedJson.project_id || "Not Found"}`);
        console.log(`  ℹ️  Client Email: ${parsedJson.client_email || "Not Found"}`);
    } catch (err) {
        console.error("  ❌ ERROR: Found 'google-key.json', but it is NOT valid JSON!");
        console.error(`     Details: ${err.message}`);
    }
} else if (process.env.GCP_PRIVATE_KEY) {
    console.log("  ℹ️  Detected fallback environment variable 'GCP_PRIVATE_KEY'.");
    console.log(`  ℹ️  Key Length: ${process.env.GCP_PRIVATE_KEY.length} characters`);
    if (!process.env.GCP_PRIVATE_KEY.includes("BEGIN PRIVATE KEY")) {
        console.log("  ⚠️  WARNING: Your private key format looks malformed or missing headers.");
    }
} else {
    console.log("  ℹ️  No Google credentials detected (Neither 'google-key.json' file nor 'GCP_PRIVATE_KEY' env var).");
    console.log("     Ignore this if this specific service doesn't require Google Docs/Sheets access.");
}

console.log("\n========================================================");
console.log("🏁 DIAGNOSTIC COMPLETE");
console.log("========================================================\n");