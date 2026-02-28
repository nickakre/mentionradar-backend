// MentionRadar Backend
require("dotenv").config();

const express = require("express");
const sqlite3 = require("better-sqlite3");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const path = require("path");

console.log("✅ server.js loaded");

const app = express();
app.use(express.json());

/* =========================
   CONFIG
========================= */
const CONFIG = {
  PORT: process.env.PORT || 3002,
  APP_URL: process.env.APP_URL || "http://localhost:3000",
  SMTP_HOST: process.env.SMTP_HOST || "smtp.gmail.com",
  SMTP_PORT: Number(process.env.SMTP_PORT) || 587,
  SMTP_USER: process.env.SMTP_USER || "",
  SMTP_PASS: process.env.SMTP_PASS || "",
  FROM_EMAIL: process.env.FROM_EMAIL || "alerts@mentionradar.com",
  ADMIN_KEY: process.env.ADMIN_KEY || "change-me",
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
  stripe_id TEXT,
  sub_id TEXT,
  slack_hook TEXT,
  alert_freq TEXT DEFAULT 'daily',
  email_on INTEGER DEFAULT 1,
  slack_on INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(user_id, keyword)
);

CREATE TABLE IF NOT EXISTS mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  snippet TEXT,
  upvotes INTEGER DEFAULT 0,
  alerted INTEGER DEFAULT 0,
  found_at INTEGER DEFAULT (unixepoch())
);
`);

/* =========================
   HELPERS
========================= */
const uid = () => crypto.randomBytes(12).toString("hex");
const getUser = email => db.prepare("SELECT * FROM users WHERE email=?").get(email);

function getOrCreateUser(email) {
  let u = getUser(email);
  if (!u) {
    db.prepare("INSERT INTO users (id,email) VALUES (?,?)").run(uid(), email);
    u = getUser(email);
  }
  return u;
}

const getUserKeywords = uid =>
  db.prepare("SELECT * FROM keywords WHERE user_id=? AND active=1").all(uid);

const kwLimit = plan => ({ free: 3, starter: 3, pro: 10 }[plan] || 3);

/* =========================
   CORS
========================= */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", CONFIG.CORS_ORIGIN);
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* =========================
   ROUTES
========================= */

// Root (IMPORTANT)
app.get("/", (req, res) => {
  res.send("MentionRadar backend running");
});

// STATUS (THIS FIXES YOUR ERROR)
app.get("/api/status", (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: "email required" });

  const user = getOrCreateUser(email);
  const keywords = getUserKeywords(user.id);
  const mentions = db
    .prepare("SELECT * FROM mentions WHERE user_id=? ORDER BY found_at DESC LIMIT 50")
    .all(user.id);

  res.json({
    user,
    keywords,
    mentions,
    stats: {
      kwUsed: keywords.length,
      kwLimit: kwLimit(user.plan),
    },
  });
});

app.post("/api/keywords/add", (req, res) => {
  const { email, keyword } = req.body;
  if (!email || !keyword) return res.status(400).json({ error: "missing_fields" });

  const user = getOrCreateUser(email);
  if (getUserKeywords(user.id).length >= kwLimit(user.plan)) {
    return res.status(402).json({ error: "limit_reached" });
  }

  try {
    db.prepare("INSERT INTO keywords (user_id, keyword) VALUES (?,?)")
      .run(user.id, keyword.toLowerCase().trim());
    res.json({ success: true });
  } catch {
    res.status(409).json({ error: "keyword_exists" });
  }
});

/* =========================
   SERVER
========================= */
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 MentionRadar running on port ${CONFIG.PORT}`);
});