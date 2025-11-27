/**
 * FINAL server.js — Excel + Web Scraper + General AI Chatbot
 * ----------------------------------------------------------
 * ✔ Excel lookup
 * ✔ TF-IDF + Jaccard + Column boost
 * ✔ Web scraping using Browserless API (Render compatible)
 * ✔ General search mode for "Modi", "Elon Musk", etc.
 * ✔ Small talk
 * ✔ Local summarizer
 * ✔ Serves frontend from /public
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const XLSX = require("xlsx");

const app = express();
app.use(cors());
app.use(express.json());

/* -------------------------------------------------------
   Serve UI from /public
------------------------------------------------------- */
const PUBLIC_DIR = path.join(__dirname, "public");
if (fs.existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
}

/* -------------------------------------------------------
   Excel File
------------------------------------------------------- */
const EXCEL_PATH = path.join(__dirname, "california_pipeline_multi_hazard_sources.xlsx");
console.log("📄 Excel Path:", EXCEL_PATH);

let excelData = [];

try {
    if (fs.existsSync(EXCEL_PATH)) {
        const wb = XLSX.readFile(EXCEL_PATH);
        wb.SheetNames.forEach(sheet => {
            const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet]);
            rows.forEach(r => (r._sheet = sheet));
            excelData.push(...rows);
        });
        console.log(`✅ Loaded Excel: ${excelData.length} rows`);
    } else {
        console.log("⚠️ Excel NOT found. Only general web search will work.");
    }
} catch (e) {
    console.log("❌ Excel load error:", e);
}

/* -------------------------------------------------------
   Text Utilities
------------------------------------------------------- */
const normalize = s => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const tokenize = s => normalize(s).split(" ").filter(Boolean);

/* -------------------------------------------------------
   Cosine Similarity
------------------------------------------------------- */
function cosine(a, b) {
    const all = Array.from(new Set([...a, ...b]));
    const av = all.map(t => a.filter(x => x === t).length);
    const bv = all.map(t => b.filter(x => x === t).length);
    let dot = 0;

    for (let i = 0; i < av.length; i++) dot += av[i] * bv[i];

    const magA = Math.sqrt(av.reduce((s, v) => s + v * v, 0));
    const magB = Math.sqrt(bv.reduce((s, v) => s + v * v, 0));

    return magA && magB ? dot / (magA * magB) : 0;
}

/* -------------------------------------------------------
   Build TF-IDF Index
------------------------------------------------------- */
let docs = [];
let idf = {};
let vocab = new Set();

function buildIndex() {
    docs = [];
    idf = {};
    vocab = new Set();

    excelData.forEach((row, i) => {
        const parts = [
            row["Dataset / Reference Name"],
            row["Topic"],
            row["Description"]
        ].filter(Boolean);
        const text = parts.join(" ") || Object.values(row).join(" ");
        const tokens = tokenize(text);

        const tf = {};
        tokens.forEach(t => {
            tf[t] = (tf[t] || 0) + 1;
            vocab.add(t);
        });

        docs.push({ tokens, tf, rowIndex: i });
    });

    const N = docs.length || 1;

    vocab.forEach(t => {
        const df = docs.filter(d => d.tf[t]).length;
        idf[t] = Math.log((N + 1) / (df + 1)) + 1;
    });

    docs.forEach(d => {
        const tfidf = {};
        let norm = 0;
        for (const t in d.tf) {
            tfidf[t] = d.tf[t] * idf[t];
            norm += tfidf[t] * tfidf[t];
        }
        norm = Math.sqrt(norm) || 1;
        for (const t in tfidf) tfidf[t] /= norm;
        d.tfidf = tfidf;
    });

    console.log("🔎 TF-IDF Index Built | Vocab:", vocab.size);
}

buildIndex();

/* -------------------------------------------------------
   Ranking Function
------------------------------------------------------- */
function hybridRank(question) {
    const qTokens = tokenize(question);
    const qSet = new Set(qTokens);

    const qtf = {};
    qTokens.forEach(t => qtf[t] = (qtf[t] || 0) + 1);

    let qmap = {};
    let norm = 0;

    for (const t in qtf) {
        qmap[t] = qtf[t] * (idf[t] || 0);
        norm += qmap[t] * qmap[t];
    }
    norm = Math.sqrt(norm) || 1;
    for (const t in qmap) qmap[t] /= norm;

    const results = docs.map((d, idx) => {
        let dot = 0;
        for (const t in qmap) if (d.tfidf[t]) dot += qmap[t] * d.tfidf[t];

        const jac = jaccard(qSet, d.tokens);
        const cb = columnBoost(qTokens, excelData[idx]);

        const score = 0.55 * dot + 0.25 * jac + 0.20 * cb;
        return { score, cosine: dot, jaccard: jac, columnBoost: cb, row: excelData[idx] };
    });

    results.sort((a, b) => b.score - a.score);
    const max = results[0]?.score || 1;
    results.forEach(r => r.confidence = r.score / max);

    return results;
}

function jaccard(a, tokens) {
    const b = new Set(tokens);
    const inter = [...a].filter(x => b.has(x)).length;
    const union = new Set([...a, ...b]).size || 1;
    return inter / union;
}

function columnBoost(qt, row) {
    let b = 0;
    ["Dataset / Reference Name", "Topic"].forEach(key => {
        if (row[key]) tokenize(row[key]).forEach(t => {
            if (qt.includes(t)) b += 0.15;
        });
    });
    return Math.min(b, 0.5);
}

/* -------------------------------------------------------
   Browserless Web Scraping (Render compatible)
------------------------------------------------------- */
async function scrapeBrowserless(url) {
    try {
        const BL_KEY = process.env.BROWSERLESS_KEY;
        if (!BL_KEY) return null;

        const response = await axios.post(
            `https://chrome.browserless.io/content?token=${BL_KEY}`,
            { url },
            { timeout: 20000 }
        );

        return response.data ? String(response.data) : null;
    } catch (e) {
        console.log("❌ Browserless scrape error:", e.message);
        return null;
    }
}

/* -------------------------------------------------------
   General Web Search Mode (Bing Search Page)
------------------------------------------------------- */
async function generalWebSearch(question) {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(question)}`;
    return { url, text: await scrapeBrowserless(url) };
}

/* -------------------------------------------------------
   Summarizer
------------------------------------------------------- */
function summarize(text, question) {
    const sentences = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const qTokens = tokenize(question);

    const scored = sentences.map(s => {
        const t = tokenize(s);
        const score =
            0.5 * cosine(qTokens, t) +
            0.3 * jaccard(new Set(qTokens), t) +
            0.2 * (t.filter(x => qTokens.includes(x)).length / (qTokens.length || 1));
        return { s, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, 5).map(x => x.s).join("\n\n");
}

/* -------------------------------------------------------
   Small Talk
------------------------------------------------------- */
const smallTalk = {
    "hi": "Hi! 👋 How can I help today?",
    "hello": "Hello! 😊 How may I assist?",
    "how are you": "I'm great — ready to help!",
    "good morning": "Good morning ☀️",
    "good evening": "Good evening 🌙",
    "thanks": "You're welcome! 🙌"
};

/* -------------------------------------------------------
   Root & Health
------------------------------------------------------- */
app.get("/", (req, res) => {
    const file = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(file)) return res.sendFile(file);
    res.send("Backend running. POST /ask");
});

app.get("/healthz", (req, res) => res.send("ok"));

/* -------------------------------------------------------
   MAIN CHATBOT ENDPOINT
------------------------------------------------------- */
app.post("/ask", async (req, res) => {
    const question = req.body.question?.trim();
    if (!question) return res.json({ answer: "Please enter a question." });

    // 1. Small Talk
    const lower = question.toLowerCase();
    for (const k in smallTalk) {
        if (lower.includes(k)) return res.json({ answer: smallTalk[k] });
    }

    // 2. Excel not loaded?
    if (!excelData.length) {
        console.log("⚠ Excel empty → switching to Web Search");
        const search = await generalWebSearch(question);
        const summary = search.text ? summarize(search.text, question) : null;
        return res.json({
            answer: summary || "I could not extract meaningful information.",
            matchMethod: "web-search",
            source: search.url
        });
    }

    // 3. Excel Matching
    const ranked = hybridRank(question);
    const best = ranked[0];
    const conf = best.confidence;

    // 4. If confidence too low → general web search
    if (conf < 0.15) {
        console.log("🌐 Low confidence → Web Search Mode");
        const search = await generalWebSearch(question);
        const summary = search.text ? summarize(search.text, question) : null;

        return res.json({
            answer: summary || "I could not extract useful information.",
            matchMethod: "web-search",
            confidence: conf,
            source: search.url
        });
    }

    // 5. Excel link scraping mode
    const row = best.row;
    const link =
        row.Link ||
        row["Primary URL"] ||
        row["Download / Service URL"] ||
        row.URL;

    if (!link) {
        return res.json({
            answer: JSON.stringify(row, null, 2),
            matchMethod: "excel-fallback",
            confidence: conf
        });
    }

    const scraped = await scrapeBrowserless(link);
    if (!scraped) {
        return res.json({
            answer: JSON.stringify(row, null, 2),
            matchMethod: "blocked",
            confidence: conf,
            source: link
        });
    }

    const summary = summarize(scraped, question);
    return res.json({
        answer: summary || JSON.stringify(row, null, 2),
        matchMethod: "hybrid+scrape",
        confidence: conf,
        source: link
    });
});

/* -------------------------------------------------------
   Start Server
------------------------------------------------------- */
app.listen(process.env.PORT || 9000, () =>
    console.log("🚀 Server running on PORT", process.env.PORT || 9000)
);
