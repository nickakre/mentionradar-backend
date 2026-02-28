// MentionRadar Backend — REAL DATA VERSION
require("dotenv").config();
const express = require("express");
const sqlite3 = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const axios = require("axios"); // Install this: npm install axios

const app = express();
app.use(express.json());

const CONFIG = {
  PORT: process.env.PORT || 10000,
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
};

const dbPath = path.join(__dirname, "mentionradar.db");
const db = new sqlite3(dbPath);

// Ensure tables exist
db.exec(`
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS keywords (id INTEGER PRIMARY KEY, user_id TEXT, keyword TEXT, UNIQUE(user_id, keyword));
CREATE TABLE IF NOT EXISTS mentions (
  id TEXT PRIMARY KEY, 
  user_id TEXT, 
  keyword TEXT, 
  source TEXT, 
  title TEXT, 
  url TEXT, 
  found_at INTEGER
);
`);

/* =========================
   CORE ENGINE: THE FETCHER
========================= */
async function scanForKeywords() {
  const allKeywords = db.prepare("SELECT * FROM keywords").all();
  console.log(`Scanning for ${allKeywords.length} keywords...`);

  for (const kw of allKeywords) {
    try {
      // Fetch from Hacker News Algolia API
      const response = await axios.get(`https://hn.algolia.com/api/v1/search_by_date?query=${kw.keyword}&tags=story`);
      const hits = response.data.hits;

      const insert = db.prepare(`
        INSERT OR IGNORE INTO mentions (id, user_id, keyword, source, title, url, found_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      hits.forEach(hit => {
        insert.run(
          hit.objectID, 
          kw.user_id, 
          kw.keyword, 
          "Hacker News", 
          hit.title, 
          hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
          Math.floor(Date.now() / 1000)
        );
      });
    } catch (err) {
      console.error(`Error scanning ${kw.keyword}:`, err.message);
    }
  }
}

// Run scan every 10 minutes
setInterval(scanForKeywords, 10 * 60 * 1000);

/* =========================
   ROUTES
========================= */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", CONFIG.CORS_ORIGIN);
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/api/status", (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "email_required" });

  const user = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if (!user) return res.json({ ok: true, mentions: [] });

  const mentions = db.prepare("SELECT * FROM mentions WHERE user_id=? ORDER BY found_at DESC LIMIT 50").all(user.id);
  res.json({ ok: true, mentions });
});

app.post("/api/keywords/add", async (req, res) => {
  const { email, keyword } = req.body;
  if (!email || !keyword) return res.status(400).json({ error: "missing_fields" });

  let user = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if (!user) {
    const newId = crypto.randomBytes(12).toString("hex");
    db.prepare("INSERT INTO users (id, email) VALUES (?,?)").run(newId, email);
    user = { id: newId };
  }

  try {
    db.prepare("INSERT INTO keywords (user_id, keyword) VALUES (?,?)").run(user.id, keyword.toLowerCase().trim());
    // Trigger immediate scan for this new keyword
    res.json({ success: true });
    scanForKeywords(); 
  } catch (e) {
    res.status(409).json({ error: "keyword_exists" });
  }
});

app.listen(CONFIG.PORT, () => console.log(`Backend Live on ${CONFIG.PORT}`));