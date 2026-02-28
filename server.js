// MentionRadar Backend
require("dotenv").config();

const express = require('express');
const sqlite3 = require('better-sqlite3');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());

/* =========================
   CONFIG
========================= */
const CONFIG = {
  PORT: process.env.PORT || 3002,
  APP_URL: process.env.APP_URL || 'http://localhost:3000',
  SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
  SMTP_PORT: Number(process.env.SMTP_PORT) || 587,
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  FROM_EMAIL: process.env.FROM_EMAIL || 'alerts@mentionradar.com',
  ADMIN_KEY: process.env.ADMIN_KEY || 'change-me',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
};

/* =========================
   DATABASE (Render-safe)
========================= */
const dbPath = path.join(__dirname, 'mentionradar.db');
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
function uid() {
  return crypto.randomBytes(12).toString('hex');
}

function getUser(email) {
  return db.prepare('SELECT * FROM users WHERE email=?').get(email);
}

function getOrCreateUser(email) {
  let u = getUser(email);
  if (!u) {
    db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(uid(), email);
    u = getUser(email);
  }
  return u;
}

function getUserKeywords(userId) {
  return db.prepare('SELECT * FROM keywords WHERE user_id=? AND active=1').all(userId);
}

function kwLimit(plan) {
  return { free: 3, starter: 3, pro: 10 }[plan] || 3;
}

/* =========================
   HTTP FETCH
========================= */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'MentionRadar/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

/* =========================
   SOURCES
========================= */
async function searchReddit(keyword) {
  try {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=new&limit=10&t=day`;
    const data = JSON.parse(await fetchUrl(url));
    return (data.data?.children || []).map(c => ({
      source: 'reddit',
      title: c.data.title,
      url: `https://reddit.com${c.data.permalink}`,
      snippet: (c.data.selftext || '').slice(0, 300),
      upvotes: c.data.score || 0,
    }));
  } catch {
    return [];
  }
}

async function searchHN(keyword) {
  try {
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(keyword)}&hitsPerPage=10`;
    const data = JSON.parse(await fetchUrl(url));
    return (data.hits || []).map(h => ({
      source: 'hackernews',
      title: h.title || h.story_title || 'HN Discussion',
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      snippet: (h.comment_text || '').slice(0, 300).replace(/<[^>]*>/g, ''),
      upvotes: h.points || 0,
    }));
  } catch {
    return [];
  }
}

async function searchDevTo(keyword) {
  try {
    const url = `https://dev.to/api/articles?tag=${encodeURIComponent(keyword)}&per_page=5`;
    const articles = JSON.parse(await fetchUrl(url));
    return articles.map(a => ({
      source: 'devto',
      title: a.title,
      url: a.url,
      snippet: a.description || '',
      upvotes: a.positive_reactions_count || 0,
    }));
  } catch {
    return [];
  }
}

async function searchAll(keyword) {
  const [r, h, d] = await Promise.allSettled([
    searchReddit(keyword),
    searchHN(keyword),
    searchDevTo(keyword),
  ]);
  return [
    ...(r.status === 'fulfilled' ? r.value : []),
    ...(h.status === 'fulfilled' ? h.value : []),
    ...(d.status === 'fulfilled' ? d.value : []),
  ];
}

/* =========================
   STORAGE + ALERTS
========================= */
function storeMention(userId, keyword, mention) {
  if (db.prepare('SELECT id FROM mentions WHERE user_id=? AND url=?').get(userId, mention.url)) {
    return false;
  }
  db.prepare(
    'INSERT INTO mentions (user_id,keyword,source,title,url,snippet,upvotes) VALUES (?,?,?,?,?,?,?)'
  ).run(userId, keyword, mention.source, mention.title, mention.url, mention.snippet, mention.upvotes);
  return true;
}

async function sendEmailAlert(user, mentions) {
  if (!user.email_on || !CONFIG.SMTP_USER) return;

  const mailer = nodemailer.createTransport({
    host: CONFIG.SMTP_HOST,
    port: CONFIG.SMTP_PORT,
    secure: false,
    auth: { user: CONFIG.SMTP_USER, pass: CONFIG.SMTP_PASS },
  });

  const rows = mentions.slice(0, 10).map(m => `
    <tr>
      <td style="padding:12px;border-bottom:1px solid #21262d">
        <strong style="color:#3fb950">[${m.keyword}]</strong> via ${m.source}<br/>
        <a href="${m.url}" style="color:#58a6ff">${m.title}</a><br/>
        <span style="color:#484f58;font-size:12px">${(m.snippet || '').slice(0, 150)}</span>
      </td>
    </tr>
  `).join('');

  await mailer.sendMail({
    from: `MentionRadar <${CONFIG.FROM_EMAIL}>`,
    to: user.email,
    subject: `📡 ${mentions.length} new mention(s) found`,
    html: `
      <div style="background:#0d1117;color:#c9d1d9;font-family:monospace;padding:24px;max-width:600px">
        <h2 style="color:#3fb950">MentionRadar Alert</h2>
        <table style="width:100%;border-collapse:collapse">${rows}</table>
        <p style="color:#484f58;font-size:11px;margin-top:16px">
          <a href="${CONFIG.APP_URL}" style="color:#3fb950">View Dashboard</a>
        </p>
      </div>
    `,
  });
}

/* =========================
   SCANNER (single instance)
========================= */
let scanRunning = false;

async function runScan() {
  if (scanRunning) return;
  scanRunning = true;

  try {
    console.log(`[${new Date().toISOString()}] Scanning...`);
    for (const user of db.prepare('SELECT * FROM users').all()) {
      const keywords = getUserKeywords(user.id);
      if (!keywords.length) continue;

      const newMentions = [];
      for (const kw of keywords) {
        const results = await searchAll(kw.keyword);
        for (const r of results) {
          if (storeMention(user.id, kw.keyword, r)) {
            newMentions.push({ ...r, keyword: kw.keyword });
          }
        }
        await new Promise(r => setTimeout(r, 1500));
      }

      if (newMentions.length) {
        console.log(`→ ${user.email}: ${newMentions.length} new mentions`);
        await sendEmailAlert(user, newMentions).catch(console.error);
      }
    }
  } finally {
    scanRunning = false;
  }
}

cron.schedule('*/10 * * * *', () => runScan().catch(console.error));

/* =========================
   CORS
========================= */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', CONFIG.CORS_ORIGIN);
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* =========================
   ROUTES (unchanged)
========================= */
// (your routes are unchanged – omitted here for brevity)
// KEEP ALL YOUR EXISTING ROUTES EXACTLY AS THEY ARE

/* =========================
   START SERVER (Render-safe)
========================= */
app.listen(CONFIG.PORT, () => {
  console.log(`
+------------------------------------------+
|      MentionRadar Backend v1.0           |
+------------------------------------------+
|  Running on port ${CONFIG.PORT}          |
+------------------------------------------+
`);
});