/**
 * CLEAN FINAL SERVER.JS — Render Compatible
 * -----------------------------------------
 * ✔ Excel lookup
 * ✔ Hybrid TF-IDF matching
 * ✔ Browserless cloud scraping (no Chrome needed)
 * ✔ General knowledge answers via web
 * ✔ Works on FREE Render tier
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

/* -------------------------------------------------------
   Serve Frontend
------------------------------------------------------- */
const PUBLIC_DIR = path.join(__dirname, "public");
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

/* -------------------------------------------------------
   Excel Load
------------------------------------------------------- */
const EXCEL_PATH = path.join(__dirname, "california_pipeline_multi_hazard_sources_with_real_incidents_rowwise.xlsx");
let excelData = [];

try {
    if (fs.existsSync(EXCEL_PATH)) {
        const wb = XLSX.readFile(EXCEL_PATH);
        wb.SheetNames.forEach(sheet => {
            const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet]);
            rows.forEach(r => r._sheet = sheet);
            excelData.push(...rows);
        });
        console.log(`✅ Excel loaded: ${excelData.length} rows`);
    } else {
        console.log("⚠️ Excel file not found next to server.js");
    }
} catch (err) {
    console.log("❌ Excel error:", err);
}

/* -------------------------------------------------------
   Text Helpers
------------------------------------------------------- */
const normalize = s =>
    String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

const tokenize = s =>
    normalize(s).split(" ").filter(Boolean);

/* -------------------------------------------------------
   Build TF-IDF
------------------------------------------------------- */
let docs = [];
let vocab = new Set();
let idf = {};

function buildIndex() {
    docs = [];
    vocab.clear();
    idf = {};

    excelData.forEach((row, i) => {
        const text = [
            row["Dataset / Reference Name"],
            row["Topic"],
            row["Description"]
        ].filter(Boolean).join(" ") || Object.values(row).join(" ");

        const tokens = tokenize(text);
        const tf = {};
        tokens.forEach(t => { tf[t] = (tf[t] || 0) + 1; vocab.add(t); });

        docs.push({ tokens, tf, text, rowIndex: i });
    });

    const N = docs.length || 1;

    vocab.forEach(t => {
        const df = docs.filter(d => d.tf[t]).length;
        idf[t] = Math.log((N + 1) / (df + 1)) + 1;
    });

    docs.forEach(d => {
        let norm = 0;
        d.tfidf = {};
        Object.keys(d.tf).forEach(t => {
            d.tfidf[t] = d.tf[t] * idf[t];
            norm += d.tfidf[t] ** 2;
        });
        norm = Math.sqrt(norm) || 1;
        Object.keys(d.tfidf).forEach(t => d.tfidf[t] /= norm);
    });

    console.log("🔍 TF-IDF index built. Vocab:", vocab.size);
}
buildIndex();

function cosine(qmap, d) {
    let dot = 0;
    for (const t in qmap) {
        if (d.tfidf[t]) dot += qmap[t] * d.tfidf[t];
    }
    return dot;
}

/* -------------------------------------------------------
   Hybrid Ranking
------------------------------------------------------- */
function rank(question) {
    const qTokens = tokenize(question);

    const qtf = {};
    qTokens.forEach(t => qtf[t] = (qtf[t] || 0) + 1);

    let qmap = {};
    let norm = 0;

    for (const t in qtf) {
        qmap[t] = qtf[t] * (idf[t] || 0);
        norm += qmap[t] ** 2;
    }
    norm = Math.sqrt(norm) || 1;
    for (const t in qmap) qmap[t] /= norm;

    let scores = docs.map(d => {
        const score = cosine(qmap, d);
        return { score, rowIndex: d.rowIndex };
    });

    scores.sort((a, b) => b.score - a.score);

    const top = scores[0];
    if (!top) return null;

    const bestRow = excelData[top.rowIndex];
    return { row: bestRow, score: top.score };
}

/* -------------------------------------------------------
   Browserless Scraping (Recommended)
------------------------------------------------------- */
async function scrapeURL(url) {
    try {
        if (!process.env.BROWSERLESS_KEY) return null;

        const result = await axios.post(
            `https://chrome.browserless.io/content?token=${process.env.BROWSERLESS_KEY}`,
            { url, waitFor: 1500 }
        );

        return result.data || null;
    } catch (err) {
        console.log("❌ Scrape error:", err.message);
        return null;
    }
}

/* -------------------------------------------------------
   General Question Answering (Web Search)
------------------------------------------------------- */
async function generalWebAnswer(question) {
    try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(question)}&format=json`;

        const res = await axios.get(url);

        if (res.data.Abstract) return res.data.Abstract;
        if (res.data.RelatedTopics?.length)
            return res.data.RelatedTopics[0]?.Text || null;

        return null;
    } catch {
        return null;
    }
}

/* -------------------------------------------------------
   Routes
------------------------------------------------------- */
app.get("/", (req, res) => {
    const indexPath = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    res.send("✅ Chatbot backend running. Use POST /ask");
});

app.get("/healthz", (req, res) => res.sendStatus(200));

app.post("/ask", async (req, res) => {
    const q = req.body.question?.trim();
    if (!q) return res.json({ answer: "Please enter a question." });

    /* Small Talk */
    const smallTalk = {
        hi: "Hi! 👋 How can I help today?",
        hello: "Hello! 😊",
        thanks: "You're welcome! 🙌"
    };
    for (const k in smallTalk) {
        if (q.toLowerCase().includes(k))
            return res.json({ answer: smallTalk[k] });
    }

    /* Step 1: Excel match */
    const best = rank(q);

    if (!best || best.score < 0.05) {
        /* Try answering from web */
        const webAns = await generalWebAnswer(q);
        if (webAns)
            return res.json({ answer: webAns, source: "web" });

        return res.json({ answer: "I couldn't find relevant data." });
    }

    const row = best.row;

    /* Step 2: Try scraping URL */
    const link =
        row.Link ||
        row["Primary URL"] ||
        row["Download / Service URL"] ||
        row.URL ||
        null;

    if (!link) return res.json({ answer: JSON.stringify(row, null, 2) });

    const content = await scrapeURL(link);

    if (!content) return res.json({
        answer: JSON.stringify(row, null, 2),
        note: "webpage blocked"
    });

    /* Step 3: Summarize (*very simple*) */
    const sentences = content.split("\n").filter(s => s.length > 40);
    const summary = sentences.slice(0, 4).join("\n\n");

    return res.json({
        answer: summary || content.slice(0, 500),
        source: link
    });
});

/* -------------------------------------------------------
   Start Server
------------------------------------------------------- */
const PORT = process.env.PORT || 9000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
