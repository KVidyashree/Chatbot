/**
 * FINAL server.js — Render Compatible + Hybrid Local AI
 * -----------------------------------------------------
 * ✔ Multi-sheet Excel reader
 * ✔ Local TF-IDF + Jaccard + Column Boost hybrid matching
 * ✔ Local summarizer
 * ✔ Puppeteer scraper (Render compatible)
 * ✔ Serves frontend from /public
 * ✔ Health + root endpoints required by Render
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

/* -------------------------------------------------------
   Serve the frontend from /public
------------------------------------------------------- */
const PUBLIC_DIR = path.join(__dirname, "public");
if (fs.existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
}

/* -------------------------------------------------------
   Excel File Path (relative to server.js)
------------------------------------------------------- */
const EXCEL_PATH = path.join(__dirname, "california_pipeline_multi_hazard_sources.xlsx");
console.log("📄 Using Excel:", EXCEL_PATH);

/* -------------------------------------------------------
   Load Excel (All Sheets)
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

        console.log(`✅ Excel Loaded: ${excelData.length} rows`);
    } else {
        console.log("⚠️ Excel file NOT found. Upload next to server.js");
    }
} catch (err) {
    console.error("❌ Excel Load Error", err);
}

/* -------------------------------------------------------
   Text Processing Helpers
------------------------------------------------------- */
function normalizeText(text = "") {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function tokenize(text = "") {
    return normalizeText(text).split(" ").filter(Boolean);
}

/* -------------------------------------------------------
   Local Cosine Similarity
------------------------------------------------------- */
function cosineSimilarity(aTokens, bTokens) {
    const all = Array.from(new Set([...aTokens, ...bTokens]));
    let dot = 0;

    const aVec = all.map(t => aTokens.filter(x => x === t).length);
    const bVec = all.map(t => bTokens.filter(x => x === t).length);

    for (let i = 0; i < aVec.length; i++) dot += aVec[i] * bVec[i];

    const magA = Math.sqrt(aVec.reduce((s, v) => s + v * v, 0));
    const magB = Math.sqrt(bVec.reduce((s, v) => s + v * v, 0));

    if (!magA || !magB) return 0;
    return dot / (magA * magB);
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

        docs.push({ text, tokens, tf, tfidf: {}, rowIndex: i });
    });

    const N = docs.length || 1;

    vocab.forEach(t => {
        let df = docs.filter(d => d.tf[t]).length;
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

        for (const t in tfidf) {
            tfidf[t] /= norm;
        }

        d.tfidf = tfidf;
    });

    console.log("🔎 TF-IDF index built. Vocabulary size:", vocab.size);
}

buildIndex();

/* -------------------------------------------------------
   Hybrid Ranking (TF-IDF + Jaccard + Column Boost)
------------------------------------------------------- */
function jaccardScore(qSet, docTokens) {
    const dSet = new Set(docTokens);
    const intersection = [...qSet].filter(t => dSet.has(t)).length;
    const union = new Set([...qSet, ...dSet]).size || 1;
    return intersection / union;
}
function computeColumnBoost(qTokens, row) {
    let boost = 0;
    ["Dataset / Reference Name", "Topic"].forEach(col => {
        if (row[col]) {
            let tokens = tokenize(row[col]);
            qTokens.forEach(q => {
                if (tokens.includes(q)) boost += 0.15;
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
        for (const t in qmap) {
            if (d.tfidf[t]) dot += qmap[t] * d.tfidf[t];
        }
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

        const score =
            0.55 * entry.cosine +
            0.25 * js +
            0.2 * cb;

        return {
            row,
            rowIndex: entry.rowIndex,
            score,
            cosine: entry.cosine,
            jaccard: js,
            columnBoost: cb
        };
    });

    ranked.sort((a, b) => b.score - a.score);

    const max = ranked[0]?.score || 1;
    ranked.forEach(r => r.confidence = r.score / max);

    return ranked;
}

/* -------------------------------------------------------
   Puppeteer Scraper (Render-friendly)
------------------------------------------------------- */
async function fetchPageText(url) {
    if (!url) return null;

    let browser = null;
    try {
        const launchOpts = {
            headless: "new",
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-blink-features=AutomationControlled",
                "--window-size=1400,900"
            ]
        };

        // If Render provides a Chrome path
        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        }

        browser = await puppeteer.launch(launchOpts);
        const page = await browser.newPage();
        await page.setJavaScriptEnabled(true);

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/123.0.0.0 Safari/537.36"
        );

        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

        await page.evaluate(async () => {
            await new Promise(resolve => {
                let total = 0;
                const distance = 400;
                const timer = setInterval(() => {
                    window.scrollBy(0, distance);
                    total += distance;
                    if (total >= document.body.scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 200);
            });
        });

        return await page.evaluate(() => document.body.innerText || "");

    } catch (err) {
        console.error("❌ Scraper error:", err);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

/* -------------------------------------------------------
   Local Summarizer
------------------------------------------------------- */
function extractTopSentences(text, question) {
    if (!text) return null;

    const sentences = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (!sentences.length) return null;

    const qTokens = tokenize(question);

    const ranked = sentences.map(s => {
        const t = tokenize(s);
        const score =
            0.5 * cosineSimilarity(qTokens, t) +
            0.3 * jaccardScore(new Set(qTokens), t) +
            0.2 * (t.filter(x => qTokens.includes(x)).length / (qTokens.length || 1));

        return { s, score };
    });

    ranked.sort((a, b) => b.score - a.score);

    return ranked.slice(0, 6).map(x => x.s).join("\n\n");
}

/* -------------------------------------------------------
   Small Talk
------------------------------------------------------- */
const smallTalk = {
    "hi": "Hello 👋 How may I assist you?",
    "hello": "Hi! 😊 Ready when you are.",
    "good morning": "Good morning ☀️",
    "good evening": "Good evening 🌙",
    "thanks": "You're welcome! 🙌",
    "thank you": "Glad to help 😊"
};

/* -------------------------------------------------------
   Root Endpoint (required by Render)
------------------------------------------------------- */
app.get("/", (req, res) => {
    const indexPath = path.join(PUBLIC_DIR, "index.html");

    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    }
    res.send("✅ Chatbot backend is running.<br>Use POST /ask");
});

/* -------------------------------------------------------
   Health Check
------------------------------------------------------- */
app.get("/healthz", (req, res) => res.sendStatus(200));

/* -------------------------------------------------------
   Main Chat Endpoint
------------------------------------------------------- */
app.post("/ask", async (req, res) => {
    const question = req.body.question?.trim();
    if (!question) return res.json({ answer: "Please enter a question." });

    const qLower = question.toLowerCase();
    for (const key in smallTalk) {
        if (qLower.includes(key)) {
            return res.json({
                answer: smallTalk[key],
                matchMethod: "small-talk",
                confidence: 1
            });
        }
    }

    if (!excelData.length) {
        return res.json({
            answer: "Excel file missing on server.",
            matchMethod: "error"
        });
    }

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

    if (!link || confidence < 0.15) {
        let txt = `Best match from sheet: ${sheet}\nConfidence: ${confidence}\n\n`;
        for (const k in row) if (k !== "_sheet") txt += `${k}: ${row[k]}\n`;

        return res.json({
            answer: txt.trim(),
            matchMethod: "excel-fallback",
            confidence
        });
    }

    const text = await fetchPageText(link);

    if (!text) {
        let txt = `Sheet: ${sheet}\nConfidence: ${confidence}\n(Webpage blocked or empty)\n\n`;
        for (const k in row) if (k !== "_sheet") txt += `${k}: ${row[k]}\n`;

        return res.json({
            answer: txt.trim(),
            matchMethod: "blocked-page",
            source: link
        });
    }

    const summary = extractTopSentences(text, question);

    if (!summary || summary.length < 40) {
        let txt = `Sheet: ${sheet}\nConfidence: ${confidence}\n(No meaningful text extracted)\n\n`;
        for (const k in row) if (k !== "_sheet") txt += `${k}: ${row[k]}\n`;

        return res.json({
            answer: txt.trim(),
            matchMethod: "excel-fallback",
            source: link
        });
    }

    res.json({
        answer: summary,
        sheet,
        confidence,
        source: link,
        matchMethod: "hybrid+scrape"
    });
});

/* -------------------------------------------------------
   Start Server (Render needs process.env.PORT)
------------------------------------------------------- */
const PORT = process.env.PORT || 9000;

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
