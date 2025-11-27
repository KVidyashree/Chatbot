/** -------------------------------------------------------
 *   FINAL SERVER.JS — FULLY RENDER-COMPATIBLE VERSION
 *   ✔ Working Scraper
 *   ✔ Working Excel Matching
 *   ✔ General Chat
 *   ✔ Works on Render Free Tier
 * ------------------------------------------------------- */

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
   Serve frontend from /public
------------------------------------------------------- */
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

/* -------------------------------------------------------
   Excel file path (must be in root folder)
------------------------------------------------------- */
const EXCEL_PATH = path.join(__dirname, "california_pipeline_multi_hazard_sources.xlsx");

/* -------------------------------------------------------
   Load Excel
------------------------------------------------------- */
let excelData = [];

try {
    const workbook = XLSX.readFile(EXCEL_PATH);
    workbook.SheetNames.forEach(sheet => {
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheet]);
        rows.forEach(r => (r._sheet = sheet));
        excelData.push(...rows);
    });

    console.log(`📄 Excel loaded: ${excelData.length} rows`);
} catch (err) {
    console.error("❌ Failed to load Excel:", err.message);
}

/* -------------------------------------------------------
   Text helpers
------------------------------------------------------- */
function normalize(t = "") {
    return String(t)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function tokenize(t = "") {
    return normalize(t).split(" ").filter(Boolean);
}

/* -------------------------------------------------------
   Cosine Similarity
------------------------------------------------------- */
function cosineSimilarity(aTokens, bTokens) {
    const all = Array.from(new Set([...aTokens, ...bTokens]));
    let dot = 0;

    const a = all.map(x => aTokens.filter(t => t === x).length);
    const b = all.map(x => bTokens.filter(t => t === x).length);

    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];

    const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));

    if (!magA || !magB) return 0;
    return dot / (magA * magB);
}

/* -------------------------------------------------------
   Build TF-IDF index
------------------------------------------------------- */
let docs = [];
let idf = {};

function buildIndex() {
    const vocab = new Set();
    docs = [];
    idf = {};

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

    // compute df
    vocab.forEach(term => {
        let df = 0;
        docs.forEach(d => {
            if (d.tf[term]) df++;
        });
        idf[term] = Math.log((N + 1) / (df + 1)) + 1;
    });

    // compute tfidf
    docs.forEach(d => {
        let norm = 0;
        const tfidf = {};

        for (const term in d.tf) {
            tfidf[term] = d.tf[term] * idf[term];
            norm += tfidf[term] * tfidf[term];
        }

        norm = Math.sqrt(norm) || 1;

        for (const term in tfidf) {
            tfidf[term] /= norm;
        }

        d.tfidf = tfidf;
    });

    console.log("🔎 TF-IDF index built.");
}

buildIndex();

/* -------------------------------------------------------
   Hybrid match
------------------------------------------------------- */
function rank(question) {
    const qTokens = tokenize(question);
    const qSet = new Set(qTokens);

    // calculate question tf-idf
    const qtf = {};
    qTokens.forEach(t => qtf[t] = (qtf[t] || 0) + 1);

    const qtfidf = {};
    let qNorm = 0;

    for (const t in qtf) {
        qtfidf[t] = qtf[t] * (idf[t] || 0);
        qNorm += qtfidf[t] * qtfidf[t];
    }

    qNorm = Math.sqrt(qNorm) || 1;

    for (const t in qtfidf) qtfidf[t] /= qNorm;

    // compute score for each doc
    const results = docs.map(doc => {
        let dot = 0;

        for (const t in qtfidf) {
            if (doc.tfidf[t]) dot += qtfidf[t] * doc.tfidf[t];
        }

        const jaccard =
            [...qSet].filter(t => doc.tokens.includes(t)).length /
            new Set([...qSet, ...doc.tokens]).size;

        const score = 0.6 * dot + 0.4 * jaccard;

        return {
            rowIndex: doc.rowIndex,
            score
        };
    });

    results.sort((a, b) => b.score - a.score);

    return results;
}

/* -------------------------------------------------------
   Puppeteer (Render compatible)
------------------------------------------------------- */
async function scrape(url) {
    try {
        const browser = await puppeteer.launch({
            headless: "new",
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ]
        });

        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

        const text = await page.evaluate(() => document.body.innerText || "");

        await browser.close();
        return text;
    } catch (err) {
        console.error("❌ Scraping failed:", err.message);
        return null;
    }
}

/* -------------------------------------------------------
   Extractive summarizer
------------------------------------------------------- */
function summarize(text, question) {
    const sentences = text.split("\n").map(x => x.trim()).filter(Boolean);
    if (!sentences.length) return null;

    const qTokens = tokenize(question);

    const scored = sentences.map(s => {
        const t = tokenize(s);
        const score =
            0.6 * cosineSimilarity(qTokens, t) +
            0.4 * (t.filter(x => qTokens.includes(x)).length / (qTokens.length || 1));

        return { s, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, 5).map(x => x.s).join("\n\n");
}

/* -------------------------------------------------------
   Small talk
------------------------------------------------------- */
const smallTalk = {
    "hi": "Hi! 👋 How can I help you today?",
    "hello": "Hello! 😊 Ask me anything.",
    "how are you": "I'm working great! Thanks for asking 😊",
    "thanks": "You're welcome! 🙌",
    "thank you": "Glad to help! 😊"
};

/* -------------------------------------------------------
   ROOT endpoint (Render MUST serve index.html)
------------------------------------------------------- */
app.get("/", (req, res) => {
    return res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* -------------------------------------------------------
   Main API
------------------------------------------------------- */
app.post("/ask", async (req, res) => {
    const question = req.body.question?.trim();
    if (!question) return res.json({ answer: "Please enter a question." });

    // small talk
    const lower = question.toLowerCase();
    for (const k in smallTalk) {
        if (lower.includes(k)) {
            return res.json({
                answer: smallTalk[k],
                matchMethod: "small-talk"
            });
        }
    }

    // ranking
    const best = rank(question)[0];
    const row = excelData[best.rowIndex];

    const sheet = row._sheet;
    const link =
        row.Link ||
        row["Primary URL"] ||
        row["Download / Service URL"] ||
        row.URL;

    if (!link) {
        return res.json({
            answer: "No URL found in matched Excel row.",
            sheet
        });
    }

    // scrape
    const text = await scrape(link);

    if (!text || text.length < 50) {
        return res.json({
            answer: "Webpage blocked or empty.\n\nExcel Info:\n" +
                JSON.stringify(row, null, 2),
            sheet,
            source: link,
            matchMethod: "excel-fallback"
        });
    }

    const summary = summarize(text, question);

    return res.json({
        answer: summary,
        source: link,
        sheet,
        matchMethod: "scraped"
    });
});

/* -------------------------------------------------------
   Start server
------------------------------------------------------- */
const PORT = process.env.PORT || 9000;
app.listen(PORT, () =>
    console.log(`🚀 Server running on ${PORT}`)
);
