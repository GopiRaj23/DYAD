/**
 * analytics.js — Privacy-first analytics for DYAAD (PostgreSQL)
 *
 * - IPs hashed with daily-rotating salt (SHA-256). Never stored raw.
 * - Country-level geolocation only (not city).
 * - Sessions auto-purged after 30 days.
 * - Daily aggregates kept indefinitely (no personal data).
 * - Works on Railway via existing PostgreSQL pool.
 */

'use strict';

const geoip  = require('geoip-lite');
const crypto = require('crypto');

let pool; // set via init()

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS analytics_sessions (
    id           SERIAL PRIMARY KEY,
    ip_hash      TEXT NOT NULL,
    country      TEXT DEFAULT 'XX',
    joined_at    BIGINT NOT NULL,
    left_at      BIGINT,
    duration_sec INTEGER,
    mode         TEXT DEFAULT 'stream'
  );
  CREATE TABLE IF NOT EXISTS analytics_daily (
    date             TEXT PRIMARY KEY,
    total_sessions   INTEGER DEFAULT 0,
    unique_visitors  INTEGER DEFAULT 0,
    avg_duration_sec INTEGER DEFAULT 0,
    top_countries    TEXT DEFAULT '{}',
    rooms_created    INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_asess_joined ON analytics_sessions(joined_at);
`;

async function init(pgPool) {
  pool = pgPool;
  try {
    await pool.query(SCHEMA);
    console.log('[analytics] tables ready');
    purgeOldSessions();
    scheduleMidnightRollup();
  } catch(e) {
    console.error('[analytics] schema error:', e.message);
  }
}

// ── Daily salt (rotates at midnight) ─────────────────────────────────────────

function dailySalt() {
  const today = new Date().toISOString().slice(0, 10);
  return crypto.createHash('sha256').update('dyaad-salt-' + today).digest('hex');
}

function hashIP(ip) {
  if (!ip) return 'unknown';
  const clean = ip.replace(/^::ffff:/, '').split(',')[0].trim();
  return crypto.createHash('sha256').update(clean + dailySalt()).digest('hex').slice(0, 32);
}

function getCountry(ip) {
  if (!ip) return 'XX';
  const clean = ip.replace(/^::ffff:/, '').split(',')[0].trim();
  const geo = geoip.lookup(clean);
  return (geo && geo.country) ? geo.country : 'XX';
}

// ── Session tracking ──────────────────────────────────────────────────────────

async function sessionStart(ip, mode) {
  if (!pool) return null;
  try {
    const res = await pool.query(
      `INSERT INTO analytics_sessions (ip_hash, country, joined_at, mode)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [hashIP(ip), getCountry(ip), Date.now(), mode || 'stream']
    );
    return res.rows[0].id;
  } catch(e) {
    console.error('[analytics] sessionStart error:', e.message);
    return null;
  }
}

async function sessionEnd(sessionId) {
  if (!pool || !sessionId) return;
  try {
    const res = await pool.query(
      'SELECT joined_at FROM analytics_sessions WHERE id = $1', [sessionId]
    );
    if (!res.rows.length) return;
    const dur = Math.round((Date.now() - Number(res.rows[0].joined_at)) / 1000);
    await pool.query(
      'UPDATE analytics_sessions SET left_at = $1, duration_sec = $2 WHERE id = $3',
      [Date.now(), dur, sessionId]
    );
  } catch(e) {
    console.error('[analytics] sessionEnd error:', e.message);
  }
}

async function incRoomsCreated() {
  if (!pool) return;
  const today = new Date().toISOString().slice(0, 10);
  try {
    await pool.query(`
      INSERT INTO analytics_daily (date, rooms_created)
      VALUES ($1, 1)
      ON CONFLICT (date) DO UPDATE SET rooms_created = analytics_daily.rooms_created + 1
    `, [today]);
  } catch(e) {
    console.error('[analytics] incRoomsCreated error:', e.message);
  }
}

// ── Daily rollup ──────────────────────────────────────────────────────────────

async function rollupToday() {
  if (!pool) return;
  const today = new Date().toISOString().slice(0, 10);
  const dayStart = new Date(today).getTime();
  const dayEnd   = dayStart + 86400000;
  try {
    const { rows } = await pool.query(
      `SELECT ip_hash, country, duration_sec FROM analytics_sessions
       WHERE joined_at >= $1 AND joined_at < $2`,
      [dayStart, dayEnd]
    );
    if (!rows.length) return;

    const unique = new Set(rows.map(r => r.ip_hash)).size;
    const durations = rows.map(r => r.duration_sec || 0).filter(d => d > 0);
    const avgDur = durations.length
      ? Math.round(durations.reduce((a,b) => a+b, 0) / durations.length) : 0;

    const countryCounts = {};
    rows.forEach(r => {
      const c = r.country || 'XX';
      countryCounts[c] = (countryCounts[c] || 0) + 1;
    });

    await pool.query(`
      INSERT INTO analytics_daily (date, total_sessions, unique_visitors, avg_duration_sec, top_countries)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (date) DO UPDATE SET
        total_sessions   = $2,
        unique_visitors  = $3,
        avg_duration_sec = $4,
        top_countries    = $5
    `, [today, rows.length, unique, avgDur, JSON.stringify(countryCounts)]);
  } catch(e) {
    console.error('[analytics] rollupToday error:', e.message);
  }
}

async function purgeOldSessions() {
  if (!pool) return;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  try {
    const res = await pool.query(
      'DELETE FROM analytics_sessions WHERE joined_at < $1', [cutoff]
    );
    if (res.rowCount > 0) console.log(`[analytics] purged ${res.rowCount} old sessions`);
  } catch(e) {
    console.error('[analytics] purge error:', e.message);
  }
}

function scheduleMidnightRollup() {
  const now  = new Date();
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 1, 0, 0);
  setTimeout(() => { rollupToday(); purgeOldSessions(); scheduleMidnightRollup(); }, next - now);
}

// ── Query helpers for dashboard ───────────────────────────────────────────────

async function getLiveCount() {
  if (!pool) return 0;
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  try {
    const res = await pool.query(
      `SELECT COUNT(*) AS n FROM analytics_sessions WHERE left_at IS NULL AND joined_at > $1`,
      [cutoff]
    );
    return parseInt(res.rows[0].n, 10);
  } catch(e) { return 0; }
}

async function getTodayStats() {
  await rollupToday();
  const today = new Date().toISOString().slice(0, 10);
  if (!pool) return null;
  try {
    const res = await pool.query(
      'SELECT * FROM analytics_daily WHERE date = $1', [today]
    );
    return res.rows[0] || {
      date: today, total_sessions: 0, unique_visitors: 0,
      avg_duration_sec: 0, top_countries: '{}', rooms_created: 0,
    };
  } catch(e) { return null; }
}

async function getLast30Days() {
  await rollupToday();
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT * FROM analytics_daily ORDER BY date DESC LIMIT 30`
    );
    return res.rows.reverse();
  } catch(e) { return []; }
}

async function getHourlyToday() {
  if (!pool) return Array(24).fill(0);
  const today = new Date().toISOString().slice(0, 10);
  const dayStart = new Date(today).getTime();
  const dayEnd   = dayStart + 86400000;
  try {
    const { rows } = await pool.query(
      `SELECT joined_at FROM analytics_sessions WHERE joined_at >= $1 AND joined_at < $2`,
      [dayStart, dayEnd]
    );
    const hours = Array(24).fill(0);
    rows.forEach(r => { hours[new Date(Number(r.joined_at)).getHours()]++; });
    return hours;
  } catch(e) { return Array(24).fill(0); }
}

async function getAllCountries() {
  if (!pool) return {};
  try {
    const { rows } = await pool.query(
      `SELECT top_countries FROM analytics_daily ORDER BY date DESC LIMIT 30`
    );
    const totals = {};
    rows.forEach(r => {
      try {
        Object.entries(JSON.parse(r.top_countries || '{}')).forEach(([k,v]) => {
          totals[k] = (totals[k] || 0) + v;
        });
      } catch(e) {}
    });
    return totals;
  } catch(e) { return {}; }
}

module.exports = { init, sessionStart, sessionEnd, incRoomsCreated, getLiveCount, getTodayStats, getLast30Days, getHourlyToday, getAllCountries };
