// MentionRadar Backend — GLOBAL PREMIUM VERSION (STABLE)
require("dotenv").config();
const express = require("express");
const sqlite3 = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const axios = require("axios");
const fs = require("fs"); // Added for directory management

const app = express();
app.use(express.json());

const CONFIG = {
  PORT: process.env.PORT || 10000,
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
};

/* =========================
   DATABASE PERSISTENCE FIX
========================= */
// 1. Determine the directory based on environment
const dbDir = process.env.NODE_ENV === "production" 
  ? "/opt/render/project/src/data" 
  : __dirname;

// 2. Create the directory if it doesn't exist (Fixes the Render crash)
if (!fs.existsSync(dbDir)) {
  console.log("Creating database directory:", dbDir);
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, "mentionradar.db");
const db = new sqlite3(dbPath);

// Database Schema
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
   THE GLOBAL FETCHING ENGINE
========================= */

const saveMention = (id, userId, keyword, source, title, url) => {
  try {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO mentions (id, user_id, keyword, source, title, url, found_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(id, userId, keyword, source, title, url, Math.floor(Date.now() / 1000));
  } catch (e) {}
};

async function scanAllSources() {
  const allKeywords = db.prepare("SELECT * FROM keywords").all();
  for (const kw of allKeywords) {
    console.log(`🌍 Global Scan: ${kw.keyword}`);
    
    fetchGoogleNews(kw);
    fetchReddit(kw);
    fetchHN(kw);
    fetchGitHub(kw);
    fetchDevTo(kw);
  }
}

// SOURCE: GOOGLE NEWS (via RSS-to-JSON)
async function fetchGoogleNews(kw) {
  try {
    const res = await axios.get(`https://api.rss2json.com/v1/api.json?rss_url=https://news.google.com/rss/search?q=${encodeURIComponent(kw.keyword)}&hl=en-US&gl=US&ceid=US:en`);
    res.data.items.forEach(item => {
      saveMention(item.guid, kw.user_id, kw.keyword, "Google News", item.title, item.link);
    });
  } catch (e) { console.log("Google News Error"); }
}

// SOURCE: REDDIT
async function fetchReddit(kw) {
  try {
    const res = await axios.get(`https://www.reddit.com/search.json?q=${encodeURIComponent(kw.keyword)}&sort=new`, { 
      headers: { 'User-Agent': 'Mozilla/5.0 MentionRadar/1.0' } 
    });
    res.data.data.children.forEach(post => {
      saveMention(post.data.id, kw.user_id, kw.keyword, "Reddit", post.data.title, `https://reddit.com${post.data.permalink}`);
    });
  } catch (e) { console.log("Reddit Error"); }
}

// SOURCE: HACKER NEWS
async function fetchHN(kw) {
  try {
    const res = await axios.get(`https://hn.algolia.com/api/v1/search_by_date?query=${kw.keyword}&tags=story`);
    res.data.hits.forEach(h => saveMention(h.objectID, kw.user_id, kw.keyword, "Hacker News", h.title, h.url || `https://news.ycombinator.com/item?id=${h.objectID}`));
  } catch (e) { console.log("HN Error"); }
}

// SOURCE: GITHUB
async function fetchGitHub(kw) {
  try {
    const res = await axios.get(`https://api.github.com/search/repositories?q=${kw.keyword}&sort=updated`);
    res.data.items.slice(0, 10).forEach(repo => {
      saveMention(repo.id.toString(), kw.user_id, kw.keyword, "GitHub", `Repo: ${repo.full_name}`, repo.html_url);
    });
  } catch (e) { console.log("GitHub Error"); }
}

// SOURCE: DEV.TO
async function fetchDevTo(kw) {
  try {
    const res = await axios.get(`https://dev.to/api/articles?tag=${kw.keyword}`);
    res.data.forEach(art => saveMention(art.id.toString(), kw.user_id, kw.keyword, "Dev.to", art.title, art.url));
  } catch (e) { console.log("DevTo Error"); }
}

// Auto-scan every 20 minutes
setInterval(scanAllSources, 20 * 60 * 1000);

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

app.get("/", (req, res) => res.send("Radar Global Online"));

app.get("/api/status", (req, res) => {
  const { email } = req.query;
  const user = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if (!user) return res.json({ ok: true, mentions: [], keywords: [] });
  
  const keywords = db.prepare("SELECT keyword FROM keywords WHERE user_id=?").all(user.id);
  const mentions = db.prepare("SELECT * FROM mentions WHERE user_id=? ORDER BY found_at DESC LIMIT 150").all(user.id);
  res.json({ ok: true, mentions, keywords: keywords.map(k => k.keyword) });
});

app.post("/api/keywords/add", async (req, res) => {
  const { email, keyword } = req.body;
  let user = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if (!user) {
    const newId = crypto.randomBytes(12).toString("hex");
    db.prepare("INSERT INTO users (id, email) VALUES (?,?)").run(newId, email);
    user = { id: newId };
  }
  try {
    db.prepare("INSERT INTO keywords (user_id, keyword) VALUES (?,?)").run(user.id, keyword.toLowerCase().trim());
    res.json({ success: true });
    // Trigger an immediate scan when a new keyword is added
    scanAllSources(); 
  } catch (e) { res.status(409).json({ error: "keyword_exists" }); }
});

app.listen(CONFIG.PORT, () => console.log(`Server running on port ${CONFIG.PORT}`));