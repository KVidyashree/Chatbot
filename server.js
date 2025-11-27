/**
 * FINAL server.js — Hybrid Local AI (No OpenAI Needed)
 * -----------------------------------------------------
 * Features:
 *  - Multi-sheet Excel reader
 *  - Local TF-IDF + Jaccard + Column Boost hybrid matching
 *  - Local summarizer (extractive)
 *  - SPA-friendly Puppeteer scraper
 *  - Returns: answer, sheet, confidence, match method, source URL
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const XLSX = require("xlsx");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

// -------------------------------------------------------------
// Excel PATH Auto-detect
// -------------------------------------------------------------
const EXCEL_PATH = "./california_pipeline_multi_hazard_sources.xlsx";

console.log("Using Excel file:", EXCEL_PATH);

// -------------------------------------------------------------
// Load Excel (All Sheets)
// -------------------------------------------------------------
let excelData = [];
try {
    const workbook = XLSX.readFile(EXCEL_PATH);
    workbook.SheetNames.forEach(sheet => {
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheet]);
        rows.forEach(r => (r._sheet = sheet)); // add sheet name to each row
        excelData = excelData.concat(rows);
    });
    console.log(`✅ Excel loaded: ${excelData.length} rows across ${workbook.SheetNames.length} sheets`);
} catch (err) {
    console.error("❌ Excel load failed:", err.message);
    excelData = [];
}

// -------------------------------------------------------------
// TEXT UTILITIES
// -------------------------------------------------------------
function normalizeText(s = "") {
    return String(s)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenize(s = "") {
    return normalizeText(s).split(/\s+/).filter(Boolean);
}

// -------------------------------------------------------------
// LOCAL cosineSimilarity (for summarizer + hybrid logic)
// -------------------------------------------------------------
function cosineSimilarity(aTokens, bTokens) {
    const all = Array.from(new Set([...aTokens, ...bTokens]));
    let aVec = all.map(t => aTokens.filter(x => x === t).length);
    let bVec = all.map(t => bTokens.filter(x => x === t).length);

    let dot = 0;
    for (let i = 0; i < aVec.length; i++) dot += aVec[i] * bVec[i];

    const magA = Math.sqrt(aVec.reduce((s, v) => s + v * v, 0));
    const magB = Math.sqrt(bVec.reduce((s, v) => s + v * v, 0));

    if (!magA || !magB) return 0;
    return dot / (magA * magB);
}

// -------------------------------------------------------------
// Build TF-IDF Index
// -------------------------------------------------------------
const docs = [];
const idf = {};
const vocab = new Set();

function buildTfidfIndex() {
    docs.length = 0;
    for (const key in idf) delete idf[key];
    vocab.clear();

    for (let i = 0; i < excelData.length; i++) {
        const row = excelData[i];
        
        const parts = [];
        if (row["Dataset / Reference Name"]) parts.push(row["Dataset / Reference Name"]);
        if (row["Topic"]) parts.push(row["Topic"]);
        if (row["Description"]) parts.push(row["Description"]);
        if (parts.length === 0) parts.push(Object.values(row).join(" "));

        const text = parts.join(" ");
        const tokens = tokenize(text);
        const tf = {};
        tokens.forEach(t => {
            tf[t] = (tf[t] || 0) + 1;
            vocab.add(t);
        });

        docs.push({ text, tokens, tf, tfidf: {}, rowIndex: i });
    }

    const N = docs.length;
    for (const t of vocab) {
        let df = 0;
        docs.forEach(d => {
            if (d.tf[t]) df++;
        });
        idf[t] = Math.log((N + 1) / (df + 1)) + 1;
    }

    docs.forEach(d => {
        let norm = 0;
        const map = {};
        for (const t in d.tf) {
            const val = d.tf[t] * idf[t];
            map[t] = val;
            norm += val * val;
        }
        const denom = Math.sqrt(norm) || 1;
        for (const t in map) map[t] = map[t] / denom;
        d.tfidf = map;
    });

    console.log("✅ TF-IDF index built. Vocab size:", vocab.size);
}

buildTfidfIndex();

// -------------------------------------------------------------
// Hybrid Matching (TF-IDF cosine + Jaccard + Column Boost)
// -------------------------------------------------------------
function jaccardScore(qSet, docTokens) {
    const s2 = new Set(docTokens);
    let inter = 0;
    qSet.forEach(t => { if (s2.has(t)) inter++; });
    const uni = new Set([...qSet, ...s2]).size || 1;
    return inter / uni;
}

function computeColumnBoost(qTokens, row) {
    const titleFields = ["Dataset / Reference Name", "Topic"];
    let boost = 0;

    titleFields.forEach(f => {
        if (row[f]) {
            const tk = tokenize(row[f]);
            qTokens.forEach(q => {
                if (tk.includes(q)) boost += 0.15;
            });
        }
    });

    return Math.min(boost, 0.5);
}

function cosineAgainstDocs(qTokens) {
    const qtf = {};
    qTokens.forEach(t => qtf[t] = (qtf[t] || 0) + 1);

    let qnorm = 0;
    const qmap = {};
    for (const t in qtf) {
        const val = qtf[t] * (idf[t] || 0);
        qmap[t] = val;
        qnorm += val * val;
    }
    qnorm = Math.sqrt(qnorm) || 1;
    for (const t in qmap) qmap[t] = qmap[t] / qnorm;

    return docs.map(d => {
        let dot = 0;
        for (const k in qmap) {
            if (d.tfidf[k]) dot += qmap[k] * d.tfidf[k];
        }
        return { rowIndex: d.rowIndex, cosine: dot };
    });
}

function hybridRank(question) {
    const qTokens = tokenize(question);
    const qSet = new Set(qTokens);
    const cosineScores = cosineAgainstDocs(qTokens);

    const results = cosineScores.map(entry => {
        const row = excelData[entry.rowIndex];
        const doc = docs[entry.rowIndex];

        const js = jaccardScore(qSet, doc.tokens);
        const cb = computeColumnBoost(qTokens, row);

        const score = (0.55 * entry.cosine) + (0.25 * js) + (0.20 * cb);

        return {
            row,
            rowIndex: entry.rowIndex,
            score,
            cosine: entry.cosine,
            jaccard: js,
            columnBoost: cb
        };
    });

    results.sort((a, b) => b.score - a.score);

    const max = results[0].score || 1;
    results.forEach(r => r.confidence = r.score / max);

    return results;
}

// -------------------------------------------------------------
// Puppeteer Scraper (SPA Auto-scroll)
// -------------------------------------------------------------
async function fetchPageText(url) {
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--window-size=1400,900"
            ]
        });

        const page = await browser.newPage();
        await page.setJavaScriptEnabled(true);
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

        // Scroll to load SPA content
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

        const text = await page.evaluate(() => {
            document.querySelectorAll("script, style, iframe, noscript").forEach(el => el.remove());
            return document.body.innerText;
        });

        return text || null;

    } catch (err) {
        console.error("Scraping error:", err.message);
        return null;
    } finally {
        if (browser) await browser.close();
    }
}

// -------------------------------------------------------------
// Local Multi-Paragraph Summarizer
// -------------------------------------------------------------
function extractTopSentences(pageText, question) {
    if (!pageText) return null;

    const sentences = pageText.split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (!sentences.length) return null;

    const qTokens = tokenize(question);

    const scored = sentences.map(s => {
        const t = tokenize(s);
        const sim = cosineSimilarity(qTokens, t);
        const j = jaccardScore(new Set(qTokens), t);
        const overlap = t.filter(x => qTokens.includes(x)).length;

        const score = (0.5 * sim) + (0.3 * j) + (0.2 * (overlap / (qTokens.length || 1)));
        return { s, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const top = scored.slice(0, 6).map(x => x.s);

    let out = "";
    for (let i = 0; i < top.length; i += 2) {
        out += top.slice(i, i + 2).join(" ") + "\n\n";
    }

    return out.trim();
}

// -------------------------------------------------------------
// Small Talk
// -------------------------------------------------------------
const smallTalk = {
    "hi": "Hi there! 👋 How can I help you today?",
    "hello": "Hello! 😊 What do you want to know?",
    "hey": "Hey! Ask me anything!",
    "how are you": "I'm doing great! Thanks for asking 😊",
    "bye": "Goodbye! 👋",
    "thanks": "You're welcome! 🙌",
    "thank you": "Happy to help! 😊"
};

// -------------------------------------------------------------
// Main Chat Endpoint
// -------------------------------------------------------------
app.post("/ask", async (req, res) => {
    const question = req.body.question?.trim();
    if (!question) return res.json({ answer: "Please ask something." });

    const lower = question.toLowerCase();
    for (const s in smallTalk) {
        if (lower.includes(s))
            return res.json({ answer: smallTalk[s], matchMethod: "small-talk", confidence: 1 });
    }

    // Ranking
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

    const MIN_CONFIDENCE_TO_SCRAPE = 0.15;

    // Low confidence → Excel fallback
    if (!link || confidence < MIN_CONFIDENCE_TO_SCRAPE) {
        let fb = `Best match from sheet: ${sheet}\nConfidence: ${confidence}\n\n`;
        for (const k in row) {
            if (k !== "_sheet") fb += `${k}: ${row[k]}\n`;
        }
        return res.json({ answer: fb.trim(), sheet, confidence, matchMethod: "hybrid-fallback" });
    }

    // Try scraping
    const text = await fetchPageText(link);
    if (!text) {
        let fb = `Sheet: ${sheet}\nConfidence: ${confidence}\n(Webpage blocked or empty)\n\n`;
        for (const k in row) {
            if (k !== "_sheet") fb += `${k}: ${row[k]}\n`;
        }
        return res.json({ answer: fb.trim(), source: link, sheet, confidence });
    }

    const summary = extractTopSentences(text, question);
    if (!summary || summary.length < 50) {
        let fb = `Sheet: ${sheet}\nConfidence: ${confidence}\n(Limited page content)\n\n`;
        for (const k in row) {
            if (k !== "_sheet") fb += `${k}: ${row[k]}\n`;
        }
        return res.json({ answer: fb.trim(), source: link, sheet, confidence });
    }

    return res.json({
        answer: summary,
        source: link,
        sheet,
        confidence,
        matchMethod: "hybrid+scrape"
    });
});

// -------------------------------------------------------------
// Start Server
// -------------------------------------------------------------
app.listen(9000, () =>
    console.log("🚀 Hybrid Local AI server running at http://localhost:9000")
);
