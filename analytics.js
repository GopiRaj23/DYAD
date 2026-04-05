/**
 * analytics.js — Privacy-first analytics for DYAAD
 *
 * - IPs are hashed with a daily-rotating salt (SHA-256). Never stored raw.
 * - Only country-level geolocation (not city).
 * - Sessions auto-purged after 30 days.
 * - Daily aggregates kept indefinitely (no personal data).
 */

'use strict';

const Database = require('better-sqlite3');
const geoip    = require('geoip-lite');
const crypto   = require('crypto');
const path     = require('path');

const DB_PATH = path.join(__dirname, 'dyad_analytics.db');
const db = new Database(DB_PATH);

// ── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_hash     TEXT NOT NULL,
    country     TEXT DEFAULT 'XX',
    joined_at   INTEGER NOT NULL,   -- unix ms
    left_at     INTEGER,            -- unix ms
    duration_sec INTEGER,
    mode        TEXT DEFAULT 'stream'
  );

  CREATE TABLE IF NOT EXISTS daily_stats (
    date             TEXT PRIMARY KEY,  -- YYYY-MM-DD
    total_sessions   INTEGER DEFAULT 0,
    unique_visitors  INTEGER DEFAULT 0,
    avg_duration_sec INTEGER DEFAULT 0,
    top_countries    TEXT DEFAULT '{}', -- JSON {CC: count}
    rooms_created    INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_joined ON sessions(joined_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_hash   ON sessions(ip_hash);
`);

// ── Daily salt (rotates at midnight — hashes can't be linked across days) ───

function dailySalt() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return crypto.createHash('sha256').update('dyaad-salt-' + today).digest('hex');
}

function hashIP(ip) {
  if (!ip) return 'unknown';
  // Strip IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 → 1.2.3.4)
  const clean = ip.replace(/^::ffff:/, '');
  return crypto.createHash('sha256').update(clean + dailySalt()).digest('hex').slice(0, 32);
}

function getCountry(ip) {
  if (!ip) return 'XX';
  const clean = ip.replace(/^::ffff:/, '');
  const geo = geoip.lookup(clean);
  return (geo && geo.country) ? geo.country : 'XX';
}

// ── Session tracking ──────────────────────────────────────────────────────────

const insert = db.prepare(`
  INSERT INTO sessions (ip_hash, country, joined_at, mode)
  VALUES (@ip_hash, @country, @joined_at, @mode)
`);

const close = db.prepare(`
  UPDATE sessions
  SET left_at = @left_at, duration_sec = @duration_sec
  WHERE id = @id
`);

function sessionStart(ip, mode) {
  const info = insert.run({
    ip_hash:   hashIP(ip),
    country:   getCountry(ip),
    joined_at: Date.now(),
    mode:      mode || 'stream',
  });
  return info.lastInsertRowid;
}

function sessionEnd(sessionId) {
  if (!sessionId) return;
  const now = Date.now();
  const row = db.prepare('SELECT joined_at FROM sessions WHERE id = ?').get(sessionId);
  if (!row) return;
  const dur = Math.round((now - row.joined_at) / 1000);
  close.run({ left_at: now, duration_sec: dur, id: sessionId });
}

// ── Daily rollup (called once per day + on dashboard load) ───────────────────

function rollupToday() {
  const today = new Date().toISOString().slice(0, 10);
  const dayStart = new Date(today).getTime();
  const dayEnd   = dayStart + 86400000;

  const rows = db.prepare(
    `SELECT ip_hash, country, duration_sec FROM sessions
     WHERE joined_at >= ? AND joined_at < ?`
  ).all(dayStart, dayEnd);

  if (!rows.length) return;

  const unique   = new Set(rows.map(r => r.ip_hash)).size;
  const durations = rows.map(r => r.duration_sec || 0).filter(d => d > 0);
  const avgDur   = durations.length ? Math.round(durations.reduce((a,b)=>a+b,0)/durations.length) : 0;

  const countryCounts = {};
  rows.forEach(r => {
    const c = r.country || 'XX';
    countryCounts[c] = (countryCounts[c] || 0) + 1;
  });

  db.prepare(`
    INSERT INTO daily_stats (date, total_sessions, unique_visitors, avg_duration_sec, top_countries)
    VALUES (@date, @total, @unique, @avg, @countries)
    ON CONFLICT(date) DO UPDATE SET
      total_sessions   = @total,
      unique_visitors  = @unique,
      avg_duration_sec = @avg,
      top_countries    = @countries
  `).run({
    date:      today,
    total:     rows.length,
    unique,
    avg:       avgDur,
    countries: JSON.stringify(countryCounts),
  });
}

// ── Room created counter ──────────────────────────────────────────────────────

function incRoomsCreated() {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO daily_stats (date, rooms_created)
    VALUES (@date, 1)
    ON CONFLICT(date) DO UPDATE SET rooms_created = rooms_created + 1
  `).run({ date: today });
}

// ── Purge sessions older than 30 days ────────────────────────────────────────

function purgeOldSessions() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const result = db.prepare('DELETE FROM sessions WHERE joined_at < ?').run(cutoff);
  if (result.changes > 0) console.log(`[analytics] purged ${result.changes} old sessions`);
}

// ── Query helpers for dashboard ───────────────────────────────────────────────

function getLiveCount() {
  // Sessions with no left_at within last 2h (covers server restarts)
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  return db.prepare(
    `SELECT COUNT(*) as n FROM sessions WHERE left_at IS NULL AND joined_at > ?`
  ).get(cutoff).n;
}

function getTodayStats() {
  rollupToday();
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(today) || {
    date: today, total_sessions: 0, unique_visitors: 0,
    avg_duration_sec: 0, top_countries: '{}', rooms_created: 0,
  };
}

function getLast30Days() {
  rollupToday();
  return db.prepare(
    `SELECT * FROM daily_stats ORDER BY date DESC LIMIT 30`
  ).all().reverse();
}

function getHourlyToday() {
  const today = new Date().toISOString().slice(0, 10);
  const dayStart = new Date(today).getTime();
  const dayEnd   = dayStart + 86400000;

  const rows = db.prepare(
    `SELECT joined_at FROM sessions WHERE joined_at >= ? AND joined_at < ?`
  ).all(dayStart, dayEnd);

  const hours = Array(24).fill(0);
  rows.forEach(r => {
    const h = new Date(r.joined_at).getHours();
    hours[h]++;
  });
  return hours;
}

function getAllCountries() {
  // Aggregate country counts across last 30 days from daily_stats
  const rows = db.prepare(
    `SELECT top_countries FROM daily_stats ORDER BY date DESC LIMIT 30`
  ).all();

  const totals = {};
  rows.forEach(r => {
    try {
      const obj = JSON.parse(r.top_countries || '{}');
      Object.entries(obj).forEach(([k, v]) => { totals[k] = (totals[k] || 0) + v; });
    } catch(e) {}
  });
  return totals;
}

// Run purge once on startup
purgeOldSessions();

// Schedule daily rollup at midnight
function scheduleMidnightRollup() {
  const now  = new Date();
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 1, 0, 0); // 00:01 AM
  const ms = next - now;
  setTimeout(() => { rollupToday(); purgeOldSessions(); scheduleMidnightRollup(); }, ms);
}
scheduleMidnightRollup();

module.exports = { sessionStart, sessionEnd, incRoomsCreated, getLiveCount, getTodayStats, getLast30Days, getHourlyToday, getAllCountries };
