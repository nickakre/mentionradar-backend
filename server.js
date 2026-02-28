require("dotenv").config();
const express = require("express");
const sqlite3 = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const axios = require("axios");
const fs = require("fs");

const app = express();
app.use(express.json());

const CONFIG = {
  PORT: process.env.PORT || 10000,
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
  RESEND_API_KEY: process.env.RESEND_API_KEY // Optional for emails
};

const dbDir = process.env.NODE_ENV === "production" ? "/opt/render/project/src/data" : __dirname;
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new sqlite3(path.join(dbDir, "mentionradar.db"));

// Final Schema: Added 'is_notified' to track alerts
db.exec(`
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS keywords (id INTEGER PRIMARY KEY, user_id TEXT, keyword TEXT, UNIQUE(user_id, keyword));
CREATE TABLE IF NOT EXISTS mentions (
  id TEXT PRIMARY KEY, user_id TEXT, keyword TEXT, source TEXT, title TEXT, url TEXT, found_at INTEGER, is_notified INTEGER DEFAULT 0
);
`);

/* =========================
   ENHANCED FETCHING ENGINE
========================= */
const saveMention = (id, userId, keyword, source, title, url) => {
  try {
    const insert = db.prepare(`INSERT OR IGNORE INTO mentions (id, user_id, keyword, source, title, url, found_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const result = insert.run(id, userId, keyword, source, title, url, Math.floor(Date.now() / 1000));
    
    // Idea: If this is a brand new mention, we could trigger an email alert here
    if (result.changes > 0) console.log(`✨ New Match: [${source}] ${title}`);
  } catch (e) {}
};

async function scanAllSources() {
  const allKeywords = db.prepare("SELECT * FROM keywords").all();
  for (const kw of allKeywords) {
    fetchGoogleNews(kw);
    fetchReddit(kw);
    fetchHN(kw);
    fetchGitHub(kw);
    fetchDevTo(kw);
  }
}

// Sources... (Logic remains same as previous stable version)
async function fetchGoogleNews(kw) { try { const res = await axios.get(`https://api.rss2json.com/v1/api.json?rss_url=https://news.google.com/rss/search?q=${encodeURIComponent(kw.keyword)}&hl=en-US&gl=US&ceid=US:en`); res.data.items.forEach(item => saveMention(item.guid, kw.user_id, kw.keyword, "Google News", item.title, item.link)); } catch (e) {} }
async function fetchReddit(kw) { try { const res = await axios.get(`https://www.reddit.com/search.json?q=${encodeURIComponent(kw.keyword)}&sort=new`, { headers: { 'User-Agent': 'Mozilla/5.0' } }); res.data.data.children.forEach(p => saveMention(p.data.id, kw.user_id, kw.keyword, "Reddit", p.data.title, `https://reddit.com${p.data.permalink}`)); } catch (e) {} }
async function fetchHN(kw) { try { const res = await axios.get(`https://hn.algolia.com/api/v1/search_by_date?query=${kw.keyword}&tags=story`); res.data.hits.forEach(h => saveMention(h.objectID, kw.user_id, kw.keyword, "Hacker News", h.title, h.url || `https://news.ycombinator.com/item?id=${h.objectID}`)); } catch (e) {} }
async function fetchGitHub(kw) { try { const res = await axios.get(`https://api.github.com/search/repositories?q=${kw.keyword}&sort=updated`); res.data.items.slice(0, 5).forEach(r => saveMention(r.id.toString(), kw.user_id, kw.keyword, "GitHub", `Repo: ${r.full_name}`, r.html_url)); } catch (e) {} }
async function fetchDevTo(kw) { try { const res = await axios.get(`https://dev.to/api/articles?tag=${kw.keyword}`); res.data.forEach(a => saveMention(a.id.toString(), kw.user_id, kw.keyword, "Dev.to", a.title, a.url)); } catch (e) {} }

setInterval(scanAllSources, 15 * 60 * 1000);

/* =========================
   API ROUTES (With DELETE)
========================= */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", CONFIG.CORS_ORIGIN);
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/api/status", (req, res) => {
  const user = db.prepare("SELECT id FROM users WHERE email=?").get(req.query.email);
  if (!user) return res.json({ ok: true, mentions: [], keywords: [] });
  const kws = db.prepare("SELECT keyword FROM keywords WHERE user_id=?").all(user.id);
  const mnts = db.prepare("SELECT * FROM mentions WHERE user_id=? ORDER BY found_at DESC LIMIT 100").all(user.id);
  res.json({ ok: true, mentions: mnts, keywords: kws.map(k => k.keyword) });
});

app.post("/api/keywords/add", (req, res) => {
  const { email, keyword } = req.body;
  let user = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if (!user) {
    const id = crypto.randomBytes(8).toString("hex");
    db.prepare("INSERT INTO users (id, email) VALUES (?,?)").run(id, email);
    user = { id };
  }
  try {
    db.prepare("INSERT INTO keywords (user_id, keyword) VALUES (?,?)").run(user.id, keyword.toLowerCase().trim());
    scanAllSources();
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: "exists" }); }
});

// NEW: Delete Route
app.delete("/api/keywords/delete", (req, res) => {
  const { email, keyword } = req.body;
  const user = db.prepare("SELECT id FROM users WHERE email=?").get(email);
  if (user) {
    db.prepare("DELETE FROM keywords WHERE user_id=? AND keyword=?").run(user.id, keyword);
    db.prepare("DELETE FROM mentions WHERE user_id=? AND keyword=?").run(user.id, keyword);
    res.json({ success: true });
  } else { res.sendStatus(404); }
});

app.listen(CONFIG.PORT, () => console.log(`Radar Engine Online`));