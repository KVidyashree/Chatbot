/**
 * FINAL server.js — FULL Conversational AI + Excel Intelligence + Web Scraper
 * ---------------------------------------------------------------------------
 * Modes:
 *  ✔ Small talk ("hi", "hello", "good morning")
 *  ✔ Excel-Knowledge AI (your dataset with scraping + summary)
 *  ✔ General Answer AI (web-search scraping + summary)
 *  ✔ Safe for Render Free Tier
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

/* ------------------------------------------------------------------
   Serve Frontend
------------------------------------------------------------------ */
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

/* ------------------------------------------------------------------
   Load Excel
------------------------------------------------------------------ */
const EXCEL_PATH = path.join(__dirname, "california_pipeline_multi_hazard_sources.xlsx");

let excelData = [];

try {
    const workbook = XLSX.readFile(EXCEL_PATH);

    workbook.SheetNames.forEach(sheet => {
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheet]);
        rows.forEach(r => (r._sheet = sheet));
        excelData.push(...rows);
    });

    console.log("✔ Excel Loaded:", excelData.length, "rows");

} catch (err) {
    console.log("⚠ Could not load Excel:", err.message);
}

/* ------------------------------------------------------------------
   Helpers
------------------------------------------------------------------ */
function normalize(t = "") {
    return t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function tokenize(t = "") {
    return normalize(t).split(" ").filter(Boolean);
}

/* ------------------------------------------------------------------
   Cosine Similarity
------------------------------------------------------------------ */
function cosineSimilarity(aTokens, bTokens) {
    const all = Array.from(new Set([...aTokens, ...bTokens]));
    let dot = 0;

    const a = all.map(t => aTokens.filter(x => x === t).length);
    const b = all.map(t => bTokens.filter(x => x === t).length);

    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));

    return magA && magB ? dot / (magA * magB) : 0;
}

/* ------------------------------------------------------------------
   TF-IDF Index for Excel
------------------------------------------------------------------ */
let docs = [];
let idf = {};

function buildIndex() {
    const vocab = new Set();
    docs = [];
    idf = {};

    excelData.forEach((row, index) => {
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

        docs.push({ tokens, tf, rowIndex: index });
    });

    const N = docs.length;

    vocab.forEach(term => {
        let df = docs.filter(d => d.tf[term]).length;
        idf[term] = Math.log((N + 1) / (df + 1)) + 1;
    });

    docs.forEach(d => {
        d.tfidf = {};
        let norm = 0;

        for (const t in d.tf) {
            d.tfidf[t] = d.tf[t] * idf[t];
            norm += d.tfidf[t] * d.tfidf[t];
        }

        norm = Math.sqrt(norm) || 1;
        for (const t in d.tfidf) d.tfidf[t] /= norm;
    });

    console.log("🔍 TF-IDF built for Excel.");
}

buildIndex();

/* ------------------------------------------------------------------
   Rank Excel rows
------------------------------------------------------------------ */
function rankExcel(question) {
    const qTokens = tokenize(question);

    const qtf = {};
    qTokens.forEach(t => qtf[t] = (qtf[t] || 0) + 1);

    let qtfidf = {};
    let norm = 0;

    for (const t in qtf) {
        qtfidf[t] = qtf[t] * (idf[t] || 0);
        norm += qtfidf[t] * qtfidf[t];
    }

    norm = Math.sqrt(norm) || 1;
    for (const t in qtfidf) qtfidf[t] /= norm;

    const scores = docs.map(d => {
        let dot = 0;
        for (const t in qtfidf) {
            if (d.tfidf[t]) dot += qtfidf[t] * d.tfidf[t];
        }
        return { rowIndex: d.rowIndex, score: dot };
    });

    scores.sort((a, b) => b.score - a.score);
    return scores;
}

/* ------------------------------------------------------------------
   Puppeteer Web Scraper (Render-safe)
------------------------------------------------------------------ */
async function scrape(url) {
    try {
        const browser = await puppeteer.launch({
            headless: "new",
            args: ["--no-sandbox", "--disable-setuid-sandbox"]
        });

        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

        const txt = await page.evaluate(() => document.body.innerText || "");
        await browser.close();
        return txt;

    } catch (err) {
        console.log("❌ Scrape Failed:", err.message);
        return null;
    }
}

/* ------------------------------------------------------------------
   Extractive Summarizer
------------------------------------------------------------------ */
function summarize(text, question) {
    const sentences = text.split("\n").map(x => x.trim()).filter(Boolean);

    const qTokens = tokenize(question);

    const scored = sentences.map(s => {
        const t = tokenize(s);
        const score =
            0.7 * cosineSimilarity(qTokens, t) +
            0.3 * (t.filter(x => qTokens.includes(x)).length / (qTokens.length || 1));

        return { s, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, 5).map(x => x.s).join("\n\n");
}

/* ------------------------------------------------------------------
   SMALL TALK
------------------------------------------------------------------ */
const smallTalk = {
    "hi": "Hi! 👋 How can I help today?",
    "hello": "Hello! 😊 Ask me anything.",
    "how are you": "I'm great — ready to assist you!",
    "good morning": "Good morning ☀",
    "thanks": "You're welcome!",
    "thank you": "Glad to help!"
};

/* ------------------------------------------------------------------
   GENERAL AI QUESTIONS:
   (Google-like answers for ANY question)
------------------------------------------------------------------ */
async function answerGeneral(question) {
    const q = encodeURIComponent(question);

    // using DuckDuckGo (no API key)
    const url = `https://duckduckgo.com/?q=${q}`;

    const text = await scrape(url);
    if (!text) return "I couldn't fetch information online.";

    return summarize(text, question) || "I could not summarize that.";
}

/* ------------------------------------------------------------------
   ROOT
------------------------------------------------------------------ */
app.get("/", (req, res) => {
    return res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* ------------------------------------------------------------------
   MAIN /ask API
------------------------------------------------------------------ */
app.post("/ask", async (req, res) => {
    const q = req.body.question?.trim();
    if (!q) return res.json({ answer: "Please enter a question." });

    const low = q.toLowerCase();

    /* 1) Small talk */
    for (const k in smallTalk) {
        if (low.includes(k)) {
            return res.json({ answer: smallTalk[k], mode: "small-talk" });
        }
    }

    /* 2) Excel matching check */
    const ranked = rankExcel(q);
    const best = ranked[0];

    if (!best || best.score < 0.1) {
        // No match → treat as general question
        const ans = await answerGeneral(q);
        return res.json({ answer: ans, mode: "general-ai" });
    }

    const row = excelData[best.rowIndex];
    const link =
        row.Link ||
        row["Primary URL"] ||
        row["Download / Service URL"] ||
        row.URL;

    if (!link) {
        // No link → fallback to general AI
        const ans = await answerGeneral(q);
        return res.json({ answer: ans, mode: "general-ai" });
    }

    /* 3) Scrape Excel link → summarize */
    const text = await scrape(link);

    if (!text || text.length < 80) {
        // Scraping blocked → fallback to general AI
        const ans = await answerGeneral(q);
        return res.json({
            answer: ans,
            mode: "fallback-general",
            sheet: row._sheet
        });
    }

    const summary = summarize(text, q);

    return res.json({
        answer: summary,
        source: link,
        sheet: row._sheet,
        mode: "excel+scrape"
    });
});

/* ------------------------------------------------------------------
   Start Server
------------------------------------------------------------------ */
const PORT = process.env.PORT || 9000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
