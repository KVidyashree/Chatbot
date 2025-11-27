/**
 * FINAL SERVER — Hybrid Excel AI + Free Web Search (No Bing key, No Puppeteer)
 * ---------------------------------------------------------------------------
 * ✔ Answers general questions using free Wikipedia/Google-text extraction
 * ✔ Answers Excel-based questions using TF-IDF hybrid ranking
 * ✔ Small-talk responses
 * ✔ Fully works on Render (no Chrome required)
 * ✔ Serves frontend from /public
 * ✔ Uses new Excel file: california_pipeline_multi_hazard_sources_with_real_incidents_rowwise.xlsx
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

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
const EXCEL_PATH = path.join(
    __dirname,
    "california_pipeline_multi_hazard_sources_with_real_incidents_rowwise.xlsx"
);

console.log("📄 Using Excel:", EXCEL_PATH);

/* -------------------------------------------------------
   Load Excel
------------------------------------------------------- */
let excelData = [];

try {
    if (fs.existsSync(EXCEL_PATH)) {
        const workbook = XLSX.readFile(EXCEL_PATH);
        workbook.SheetNames.forEach(sheet => {
            const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheet]);
            rows.forEach(r => (r._sheet = sheet));
            excelData.push(...rows);
        });
        console.log(`✅ Excel loaded: ${excelData.length} rows`);
    } else {
        console.log("⚠️ Excel missing!");
    }
} catch (err) {
    console.error("❌ Excel error:", err);
}

/* -------------------------------------------------------
   Text Utilities
------------------------------------------------------- */
const normalize = s =>
    String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

const tokenize = s => normalize(s).split(/\s+/).filter(Boolean);

const cosine = (a, b) => {
    const all = Array.from(new Set([...a, ...b]));
    let av = all.map(t => a.filter(x => x === t).length);
    let bv = all.map(t => b.filter(x => x === t).length);
    let dot = av.reduce((s, v, i) => s + v * bv[i], 0);
    let magA = Math.sqrt(av.reduce((s, v) => s + v * v, 0));
    let magB = Math.sqrt(bv.reduce((s, v) => s + v * v, 0));
    return magA && magB ? dot / (magA * magB) : 0;
};

/* -------------------------------------------------------
   Build TF-IDF
------------------------------------------------------- */
let docs = [];
let idf = {};
let vocab = new Set();

function buildIndex() {
    docs = [];
    idf = {};
    vocab = new Set();

    excelData.forEach((row, i) => {
        const text =
            row["Dataset / Reference Name"] ||
            row["Topic"] ||
            row["Description"] ||
            Object.values(row).join(" ");

        const tokens = tokenize(text);
        const tf = {};
        tokens.forEach(t => {
            tf[t] = (tf[t] || 0) + 1;
            vocab.add(t);
        });

        docs.push({ tokens, tf, tfidf: {}, rowIndex: i });
    });

    const N = docs.length || 1;

    vocab.forEach(t => {
        const df = docs.filter(d => d.tf[t]).length;
        idf[t] = Math.log((N + 1) / (df + 1)) + 1;
    });

    docs.forEach(doc => {
        const tfidf = {};
        let norm = 0;
        for (const t in doc.tf) {
            tfidf[t] = doc.tf[t] * idf[t];
            norm += tfidf[t] ** 2;
        }
        norm = Math.sqrt(norm) || 1;
        for (const t in tfidf) tfidf[t] /= norm;
        doc.tfidf = tfidf;
    });

    console.log("🔎 TF-IDF index ready");
}
buildIndex();

/* -------------------------------------------------------
   TF-IDF Ranking
------------------------------------------------------- */
function rankExcel(question) {
    const qTokens = tokenize(question);
    const qtf = {};
    qTokens.forEach(t => (qtf[t] = (qtf[t] || 0) + 1));

    let qmap = {};
    let norm = 0;
    for (const t in qtf) {
        qmap[t] = qtf[t] * (idf[t] || 0);
        norm += qmap[t] ** 2;
    }
    norm = Math.sqrt(norm) || 1;
    for (const t in qmap) qmap[t] /= norm;

    const results = docs.map(d => {
        let dot = 0;
        for (const t in qmap) if (d.tfidf[t]) dot += qmap[t] * d.tfidf[t];
        return {
            score: dot,
            row: excelData[d.rowIndex],
            rowIndex: d.rowIndex
        };
    });

    results.sort((a, b) => b.score - a.score);
    const max = results[0].score || 1;
    results.forEach(r => (r.confidence = r.score / max));

    return results;
}

/* -------------------------------------------------------
   FREE Web Search (no API key)
   using DuckDuckGo Instant Answer API
------------------------------------------------------- */
async function webSearch(query) {
    try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
            query
        )}&format=json&no_redirect=1&no_html=1`;

        const res = await fetch(url);
        const data = await res.json();

        if (data.Abstract && data.Abstract.length > 0) return data.Abstract;
        if (data.RelatedTopics?.length > 0) {
            const first = data.RelatedTopics[0];
            if (first.Text) return first.Text;
        }

        return "No information found online.";
    } catch (err) {
        return "Failed to search online.";
    }
}

/* -------------------------------------------------------
   Small Talk
------------------------------------------------------- */
const SMALL_TALK = {
    hi: "Hi! 👋 How can I help today?",
    hello: "Hello! 😊 What would you like to know?",
    hey: "Hey! 🙌 Ask me anything.",
    "how are you": "I'm great — ready to help!",
    thanks: "You're welcome!",
    "thank you": "Happy to help 😊"
};

/* -------------------------------------------------------
   ROOT & HEALTH
------------------------------------------------------- */
app.get("/", (req, res) => {
    const indexFile = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
    res.send("✅ Backend running. Use POST /ask");
});

app.get("/healthz", (_, res) => res.sendStatus(200));

/* -------------------------------------------------------
   MAIN Chat Endpoint
------------------------------------------------------- */
app.post("/ask", async (req, res) => {
    const question = req.body.question?.trim();
    if (!question) return res.json({ answer: "Please enter a question." });

    const q = question.toLowerCase();

    // 1) Small talk
    for (const key in SMALL_TALK) {
        if (q.includes(key)) return res.json({ answer: SMALL_TALK[key] });
    }

    // 2) Excel ranking
    const ranked = rankExcel(question);
    const best = ranked[0];

    // If confidence low → do web search
    if (best.confidence < 0.40) {
        const result = await webSearch(question);
        return res.json({
            answer: result,
            matchMethod: "web-search",
            confidence: best.confidence
        });
    }

    // 3) High confidence → return Excel row summary
    let txt = `Best match from sheet: ${best.row._sheet}\nConfidence: ${best.confidence.toFixed(
        2
    )}\n\n`;

    for (const k in best.row) if (k !== "_sheet") txt += `${k}: ${best.row[k]}\n`;

    res.json({
        answer: txt.trim(),
        matchMethod: "excel",
        confidence: best.confidence
    });
});

/* -------------------------------------------------------
   START SERVER
------------------------------------------------------- */
const PORT = process.env.PORT || 9000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
