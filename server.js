// MentionRadar Backend — FINAL STABLE VERSION
require("dotenv").config();

const express = require("express");
const sqlite3 = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json());

/* =========================
   CONFIG
========================= */
const CONFIG = {
  PORT: process.env.PORT || 10000, // Render uses 10000
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
};

/* =========================
   DATABASE
========================= */
const dbPath = path.join(__dirname, "mentionradar.db");
const db = new sqlite3(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  plan TEXT DEFAULT 'free',
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(user_id, keyword)
);

CREATE TABLE IF NOT EXISTS mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  source TEXT,
  title TEXT,
  url TEXT,
  found_at INTEGER DEFAULT (unixepoch())
);
`);

/* =========================
   HELPERS
========================= */
const uid = () => crypto.randomBytes(12).toString("hex");

function getOrCreateUser(email) {
  let user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user) {
    db.prepare("INSERT INTO users (id,email) VALUES (?,?)").run(uid(), email);
    user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  }
  return user;
}

/* =========================
   CORS
========================= */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", CONFIG.CORS_ORIGIN);
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* =========================
   ROUTES
========================= */

// Root — simple text (for Render health)
app.get("/", (req, res) => {
  res.send("MentionRadar backend running");
});

// ✅ STATUS — ALWAYS RETURNS JSON (NO EMAIL REQUIRED)
app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    service: "MentionRadar Backend",
    time: new Date().toISOString(),
  });
});

// Add keyword
app.post("/api/keywords/add", (req, res) => {
  const { email, keyword } = req.body;
  if (!email || !keyword) {
    return res.status(400).json({ error: "email_and_keyword_required" });
  }

  const user = getOrCreateUser(email);

  try {
    db.prepare(
      "INSERT INTO keywords (user_id, keyword) VALUES (?,?)"
    ).run(user.id, keyword.toLowerCase().trim());

    res.json({ success: true });
  } catch {
    res.status(409).json({ error: "keyword_exists" });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(CONFIG.PORT, () => {
  console.log(`
+----------------------------------+
|  MentionRadar Backend is LIVE 🚀 |
|  Port: ${CONFIG.PORT}             |
+----------------------------------+
`);
});