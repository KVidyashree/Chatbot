/**
 * FINAL server.js — Browserless Scraping + Hybrid Local AI (Render Compatible)
 * -------------------------------------------------------------------------
 * ✔ Multi-sheet Excel reader
 * ✔ TF-IDF + Jaccard + Column Boost hybrid matching
 * ✔ Local summarizer
 * ✔ Browserless.io scraping (NO Puppeteer needed)
 * ✔ General search (DuckDuckGo → Browserless)
 * ✔ Excel-link scraping
 * ✔ Works on Render free tier
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
   Serve frontend
------------------------------------------------------- */
const PUBLIC_DIR = path.join(__dirname, "public");
if (fs.existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
}

/* -------------------------------------------------------
   Excel File
------------------------------------------------------- */
const EXCEL_PATH = path.join(__dirname, "california_pipeline_multi_hazard_sources.xlsx");
console.log("📄 Using Excel:", EXCEL_PATH);

let excelData = [];

try {
    if (fs.existsSync(EXCEL_PATH)) {
        const wb = XLSX.readFile(EXCEL_PATH);
        wb.SheetNames.forEach(sheet => {
            const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet]);
            rows.forEach(r => (r._sheet = sheet));
            excelData.push(...rows);
        });
        console.log("✅ Excel Loaded:", excelData.length, "rows");
    }
} catch (e) {
    console.error("❌ Excel load error", e.message);
}

/* -------------------------------------------------------
   Text utilities
------------------------------------------------------- */
function normalizeText(s = "") {
    return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function tokenize(s = "") {
    return normalizeText(s).split(" ").filter(Boolean);
}

/* -------------------------------------------------------
   Cosine similarity
------------------------------------------------------- */
function cosineSimilarity(a, b) {
    const all = [...new Set([...a, ...b])];
    let dot = 0;

    const aVec = all.map(t => a.filter(x => x === t).length);
    const bVec = all.map(t => b.filter(x => x === t).length);

    for (let i = 0; i < aVec.length; i++) dot += aVec[i] * bVec[i];

    const magA = Math.sqrt(aVec.reduce((s, v) => s + v * v, 0));
    const magB = Math.sqrt(bVec.reduce((s, v) => s + v * v, 0));

    return magA && magB ? dot / (magA * magB) : 0;
}

/* -------------------------------------------------------
   TF-IDF Index
------------------------------------------------------- */
let docs = [];
let idf = {};
let vocab = new Set();

function buildIndex() {
    docs = [];
    idf = {};
    vocab = new Set();

    excelData.forEach((row, i) => {
        const text = (
            row["Dataset / Reference Name"] + " " +
            row["Topic"] + " " +
            row["Description"]
        ) || Object.values(row).join(" ");

        const tokens = tokenize(text);

        const tf = {};
        tokens.forEach(t => {
            tf[t] = (tf[t] || 0) + 1;
            vocab.add(t);
        });

        docs.push({ text, tokens, tf, tfidf: {}, rowIndex: i });
    });

    const N = docs.length;

    vocab.forEach(t => {
        let df = docs.filter(d => d.tf[t]).length;
        idf[t] = Math.log((N + 1) / (df + 1)) + 1;
    });

    docs.forEach(d => {
        let tfidf = {};
        let norm = 0;

        for (const t in d.tf) {
            tfidf[t] = d.tf[t] * idf[t];
            norm += tfidf[t] * tfidf[t];
        }

        norm = Math.sqrt(norm) || 1;

        for (const t in tfidf) tfidf[t] /= norm;

        d.tfidf = tfidf;
    });

    console.log("🔎 Built TF-IDF index. Docs:", docs.length);
}
buildIndex();

/* -------------------------------------------------------
   Hybrid Ranking
------------------------------------------------------- */
function jaccardScore(qSet, docTokens) {
    const dSet = new Set(docTokens);
    const inter = [...qSet].filter(t => dSet.has(t)).length;
    const uni = new Set([...qSet, ...dSet]).size;
    return inter / (uni || 1);
}

function computeColumnBoost(qTokens, row) {
    let boost = 0;
    ["Dataset / Reference Name", "Topic"].forEach(col => {
        if (row[col]) {
            const t = tokenize(row[col]);
            qTokens.forEach(q => {
                if (t.includes(q)) boost += 0.15;
            });
        }
    });
    return Math.min(boost, 0.5);
}

function cosineAgainstDocs(qTokens) {
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

    return docs.map(d => {
        let dot = 0;
        for (const t in qmap) if (d.tfidf[t]) dot += qmap[t] * d.tfidf[t];

        return { rowIndex: d.rowIndex, cosine: dot };
    });
}

function hybridRank(question) {
    const qTokens = tokenize(question);
    const qSet = new Set(qTokens);

    const base = cosineAgainstDocs(qTokens);

    const ranked = base.map(entry => {
        const row = excelData[entry.rowIndex];
        const doc = docs[entry.rowIndex];

        const js = jaccardScore(qSet, doc.tokens);
        const cb = computeColumnBoost(qTokens, row);

        const score = 0.55 * entry.cosine + 0.25 * js + 0.2 * cb;

        return {
            row,
            rowIndex: entry.rowIndex,
            score,
            confidence: 0,
            cosine: entry.cosine,
            jaccard: js,
            columnBoost: cb
        };
    });

    ranked.sort((a, b) => b.score - a.score);
    const max = ranked[0].score || 1;

    ranked.forEach(r => r.confidence = r.score / max);

    return ranked;
}

/* -------------------------------------------------------
   Browserless Scraper (NO Puppeteer)
------------------------------------------------------- */
async function scrapeWithBrowserless(url) {
    try {
        const key = process.env.BROWSERLESS_API_KEY;
        if (!key) {
            console.log("⚠️ No Browserless API key found");
            return null;
        }

        const resp = await axios.post(
            `https://chrome.browserless.io/content?token=${key}`,
            { url },
            { timeout: 30000 }
        );

        return resp.data || null;
    } catch (err) {
        console.error("❌ Browserless error:", err.message);
        return null;
    }
}

/* -------------------------------------------------------
   General Search (DuckDuckGo → Browserless)
------------------------------------------------------- */
async function generalAnswer(question) {
    const q = encodeURIComponent(question);
    const url = `https://duckduckgo.com/?q=${q}`;

    const text = await scrapeWithBrowserless(url);

    if (!text) return null;

    const sentences = text.split(/\n+/).filter(s => s.trim().length > 30);

    return sentences.slice(0, 5).join("\n\n");
}

/* -------------------------------------------------------
   Summarizer
------------------------------------------------------- */
function extractTopSentences(text, question) {
    if (!text) return null;

    const sentences = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (!sentences.length) return null;

    const qTokens = tokenize(question);

    const ranked = sentences.map(s => {
        const t = tokenize(s);
        const sim =
            0.5 * cosineSimilarity(qTokens, t) +
            0.3 * jaccardScore(new Set(qTokens), t) +
            0.2 * (t.filter(x => qTokens.includes(x)).length / (qTokens.length || 1));

        return { s, score: sim };
    });

    ranked.sort((a, b) => b.score - a.score);

    return ranked.slice(0, 5).map(x => x.s).join("\n\n");
}

/* -------------------------------------------------------
   Small talk
------------------------------------------------------- */
const smallTalk = {
    "hi": "Hi! 👋 How can I help today?",
    "hello": "Hello! 😊 Ask me anything.",
    "how are you": "I'm doing great — ready to assist!"
};

/* -------------------------------------------------------
   Root Endpoint
------------------------------------------------------- */
app.get("/", (req, res) => {
    const indexPath = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    res.send("Backend running — POST /ask");
});

/* -------------------------------------------------------
   Chat Endpoint
------------------------------------------------------- */
app.post("/ask", async (req, res) => {
    const question = req.body.question?.trim();

    if (!question) return res.json({ answer: "Please enter a question." });

    // small talk
    if (smallTalk[question.toLowerCase()]) {
        return res.json({ answer: smallTalk[question.toLowerCase()] });
    }

    // GENERAL QUESTION → Browserless → DuckDuckGo
    if (!excelData.length) {
        const general = await generalAnswer(question);
        if (general) return res.json({ answer: general, matchMethod: "general-search" });

        return res.json({ answer: "I could not fetch information online." });
    }

    // Otherwise → Excel Hybrid
    const ranked = hybridRank(question);
    const best = ranked[0];

    const row = best.row;
    const sheet = row._sheet;
    const confidence = Number(best.confidence.toFixed(3));

    const link =
        row.Link ||
        row["Primary URL"] ||
        row["Download / Service URL"] ||
        row.URL ||
        null;

    // If no link → return Excel row details
    if (!link) {
        let txt = `Best match from sheet: ${sheet}\nConfidence: ${confidence}\n\n`;
        for (const k in row) if (k !== "_sheet") txt += `${k}: ${row[k]}\n`;

        return res.json({ answer: txt.trim(), matchMethod: "excel-fallback" });
    }

    // Try Browserless for scraping
    const text = await scrapeWithBrowserless(link);

    if (!text || text.length < 100) {
        let txt = `Sheet: ${sheet}\nConfidence: ${confidence}\n(Webpage unavailable)\n\n`;
        for (const k in row) if (k !== "_sheet") txt += `${k}: ${row[k]}\n`;

        return res.json({ answer: txt.trim(), matchMethod: "excel-fallback" });
    }

    const summary = extractTopSentences(text, question);

    return res.json({
        answer: summary || text.slice(0, 500),
        sheet,
        confidence,
        source: link,
        matchMethod: "hybrid+browserless"
    });
});

/* -------------------------------------------------------
   Start Server
------------------------------------------------------- */
const PORT = process.env.PORT || 9000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
