// MentionRadar Backend
const express = require('express');
const sqlite3 = require('better-sqlite3');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const db = new sqlite3('mentionradar.db');
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

const CONFIG = {
  PORT: process.env.PORT || 3002,
  APP_URL: process.env.APP_URL || 'http://localhost:3000',
  SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
  SMTP_PORT: 587,
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  FROM_EMAIL: process.env.FROM_EMAIL || 'alerts@mentionradar.com',
  ADMIN_KEY: process.env.ADMIN_KEY || 'change-me',
};

function uid() { return crypto.randomBytes(12).toString('hex'); }
function getUser(email) { return db.prepare('SELECT * FROM users WHERE email=?').get(email); }
function getOrCreateUser(email) {
  let u = getUser(email);
  if (!u) { db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(uid(), email); u = getUser(email); }
  return u;
}
function getUserKeywords(userId) {
  return db.prepare('SELECT * FROM keywords WHERE user_id=? AND active=1').all(userId);
}
function kwLimit(plan) { return { free: 3, starter: 3, pro: 10 }[plan] || 3; }

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'MentionRadar/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function searchReddit(keyword) {
  try {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=new&limit=10&t=day`;
    const data = JSON.parse(await fetchUrl(url));
    return (data.data?.children || []).map(c => ({
      source: 'reddit', title: c.data.title,
      url: `https://reddit.com${c.data.permalink}`,
      snippet: (c.data.selftext || '').slice(0, 300),
      upvotes: c.data.score || 0,
    }));
  } catch { return []; }
}

async function searchHN(keyword) {
  try {
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(keyword)}&hitsPerPage=10`;
    const data = JSON.parse(await fetchUrl(url));
    return (data.hits || []).map(h => ({
      source: 'hackernews', title: h.title || h.story_title || 'HN Discussion',
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      snippet: (h.comment_text || '').slice(0, 300).replace(/<[^>]*>/g, ''),
      upvotes: h.points || 0,
    }));
  } catch { return []; }
}

async function searchDevTo(keyword) {
  try {
    const url = `https://dev.to/api/articles?tag=${encodeURIComponent(keyword)}&per_page=5`;
    const articles = JSON.parse(await fetchUrl(url));
    return articles.map(a => ({ source: 'devto', title: a.title, url: a.url, snippet: a.description || '', upvotes: a.positive_reactions_count || 0 }));
  } catch { return []; }
}

async function searchAll(keyword) {
  const [r, h, d] = await Promise.allSettled([searchReddit(keyword), searchHN(keyword), searchDevTo(keyword)]);
  return [
    ...(r.status === 'fulfilled' ? r.value : []),
    ...(h.status === 'fulfilled' ? h.value : []),
    ...(d.status === 'fulfilled' ? d.value : []),
  ];
}

function storeMention(userId, keyword, mention) {
  if (db.prepare('SELECT id FROM mentions WHERE user_id=? AND url=?').get(userId, mention.url)) return false;
  db.prepare('INSERT INTO mentions (user_id,keyword,source,title,url,snippet,upvotes) VALUES (?,?,?,?,?,?,?)')
    .run(userId, keyword, mention.source, mention.title, mention.url, mention.snippet, mention.upvotes);
  return true;
}

async function sendEmailAlert(user, mentions) {
  if (!user.email_on || !CONFIG.SMTP_USER) return;
  const mailer = nodemailer.createTransport({ host: CONFIG.SMTP_HOST, port: CONFIG.SMTP_PORT, secure: false, auth: { user: CONFIG.SMTP_USER, pass: CONFIG.SMTP_PASS } });
  const rows = mentions.slice(0, 10).map(m => `<tr><td style="padding:12px;border-bottom:1px solid #21262d"><strong style="color:#3fb950">[${m.keyword}]</strong> via ${m.source}<br><a href="${m.url}" style="color:#58a6ff">${m.title}</a><br><span style="color:#484f58;font-size:12px">${(m.snippet||'').slice(0,150)}</span></td></tr>`).join('');
  await mailer.sendMail({
    from: `MentionRadar <${CONFIG.FROM_EMAIL}>`, to: user.email,
    subject: `📡 ${mentions.length} new mention(s) found`,
    html: `<div style="background:#0d1117;color:#c9d1d9;font-family:monospace;padding:24px;max-width:600px"><h2 style="color:#3fb950">MentionRadar Alert</h2><table style="width:100%;border-collapse:collapse">${rows}</table><p style="color:#484f58;font-size:11px;margin-top:16px"><a href="${CONFIG.APP_URL}" style="color:#3fb950">View Dashboard</a></p></div>`,
  });
}

async function runScan() {
  console.log(`[${new Date().toISOString()}] Scanning...`);
  for (const user of db.prepare('SELECT * FROM users').all()) {
    const keywords = getUserKeywords(user.id);
    if (!keywords.length) continue;
    const newMentions = [];
    for (const kw of keywords) {
      const results = await searchAll(kw.keyword);
      for (const r of results) { if (storeMention(user.id, kw.keyword, r)) newMentions.push({ ...r, keyword: kw.keyword }); }
      await new Promise(r => setTimeout(r, 1500));
    }
    if (newMentions.length) {
      console.log(`  -> ${user.email}: ${newMentions.length} new mentions`);
      if (user.email_on) await sendEmailAlert(user, newMentions).catch(console.error);
    }
  }
}

cron.schedule('*/10 * * * *', () => runScan().catch(console.error));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/api/status', (req, res) => {
  const user = getOrCreateUser(req.query.email);
  const keywords = getUserKeywords(user.id);
  const mentions = db.prepare('SELECT * FROM mentions WHERE user_id=? ORDER BY found_at DESC LIMIT 50').all(user.id);
  const todayCount = db.prepare("SELECT COUNT(*) as n FROM mentions WHERE user_id=? AND date(found_at,'unixepoch')=date('now')").get(user.id).n;
  res.json({ user, keywords, mentions, stats: { total: mentions.length, today: todayCount, kwUsed: keywords.length, kwLimit: kwLimit(user.plan) } });
});

app.post('/api/keywords/add', (req, res) => {
  const { email, keyword } = req.body;
  if (!email || !keyword) return res.status(400).json({ error: 'Missing fields' });
  const user = getOrCreateUser(email);
  const existing = getUserKeywords(user.id);
  if (existing.length >= kwLimit(user.plan)) return res.status(402).json({ error: 'limit_reached' });
  try {
    db.prepare('INSERT INTO keywords (user_id, keyword) VALUES (?,?)').run(user.id, keyword.toLowerCase().trim());
    res.json({ success: true });
  } catch { res.status(409).json({ error: 'Keyword already exists' }); }
});

app.delete('/api/keywords/:id', (req, res) => {
  db.prepare('UPDATE keywords SET active=0 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/mentions', (req, res) => {
  const user = getUser(req.query.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let query = 'SELECT * FROM mentions WHERE user_id=?';
  const params = [user.id];
  if (req.query.source) { query += ' AND source=?'; params.push(req.query.source); }
  query += ' ORDER BY found_at DESC LIMIT 100';
  res.json(db.prepare(query).all(...params));
});

app.post('/api/alerts/settings', (req, res) => {
  const { email, email_on, slack_on, slack_hook, alert_freq } = req.body;
  const user = getOrCreateUser(email);
  db.prepare('UPDATE users SET email_on=?, slack_on=?, slack_hook=?, alert_freq=? WHERE id=?')
    .run(email_on ? 1 : 0, slack_on ? 1 : 0, slack_hook || null, alert_freq || 'daily', user.id);
  res.json({ success: true });
});

app.post('/api/scan/trigger', async (req, res) => {
  if (req.headers['x-admin-key'] !== CONFIG.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  runScan().catch(console.error);
  res.json({ message: 'Scan triggered' });
});

app.get('/api/admin/stats', (req, res) => {
  if (req.headers['x-admin-key'] !== CONFIG.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const users = db.prepare('SELECT plan, COUNT(*) as n FROM users GROUP BY plan').all();
  const totalMentions = db.prepare('SELECT COUNT(*) as n FROM mentions').get().n;
  const pro = users.find(u => u.plan === 'pro')?.n || 0;
  const starter = users.find(u => u.plan === 'starter')?.n || 0;
  const free = users.find(u => u.plan === 'free')?.n || 0;
  res.json({ users: { free, starter, pro }, mrr: `$${starter * 19 + pro * 49}`, mentions: totalMentions });
});

app.listen(CONFIG.PORT, () => {
  console.log(`
  +------------------------------------------+
  |      MentionRadar Backend v1.0           |
  +------------------------------------------+
  |  Running: http://localhost:${CONFIG.PORT}           |
  |  GET  /api/status?email=...              |
  |  POST /api/keywords/add                  |
  |  GET  /api/mentions?email=...            |
  |  POST /api/alerts/settings               |
  |  GET  /api/admin/stats  (admin)          |
  +------------------------------------------+
  Scan runs every 10 minutes automatically.
  `);
});
