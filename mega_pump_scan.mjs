#!/usr/bin/env node
/* ============================================================
   MEGA_PUMP_SCAN — versión Node.js (sin navegador)
   Corre como GitHub Action programada. Misma lógica de detección
   que MEGA_PUMP_SCANNER.html (modos Squeeze + Breakout, filtros
   de tendencia/R:R/liquidez, TP/SL, cooldown), pero:
   - Usa fetch nativo de Node (18+), no localStorage.
   - Persiste el historial en un archivo JSON del propio repo
     (data/mega_pump_historial.json), que el workflow commitea
     de vuelta después de cada corrida.
   - Lee el token y chat_id de Telegram de variables de entorno
     (secrets de GitHub), nunca hardcodeados.
   ============================================================ */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID   = process.env.TG_CHAT_ID;
const HIST_PATH    = process.env.HIST_PATH || 'data/mega_pump_historial.json';

if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
  console.error('Faltan TG_BOT_TOKEN y/o TG_CHAT_ID en las variables de entorno (secrets).');
  process.exit(1);
}

/* ============================================================
   PARÁMETROS (idénticos al scanner web)
   ============================================================ */
const TP_FIXED_PCT = 0.10;
const RESULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_RR = 1.2;
const MIN_QUOTE_VOLUME_USDT = 2_000_000;
const TREND_EMA_FAST = 50;
const TREND_EMA_SLOW = 200;
const COOLDOWN_HOURS = 12;

const BREAKOUT_ADX_COMPRIMIDO = 20;
const BREAKOUT_ADX_MAX_AHORA  = 40;
const BREAKOUT_VOL_MULT       = 3;
const BREAKOUT_MOV_MIN        = 2;
const BREAKOUT_MOV_MAX        = 12;

const BATCH = 15;
const BATCH_DELAY = 200;

/* ============================================================
   UTILS
   ============================================================ */
function fmtPrice(p) { if (p >= 100) return p.toFixed(2); if (p >= 1) return p.toFixed(4); return p.toPrecision(4); }
function fmtBig(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}
function clasificarSubida(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return { emoji: '⚪', txt: 'sin datos' };
  if (pct < 5) return { emoji: '🟢', txt: 'TEMPRANO (+' + pct.toFixed(1) + '%)' };
  if (pct < 15) return { emoji: '🟡', txt: 'EN CURSO (+' + pct.toFixed(1) + '%)' };
  return { emoji: '🔴', txt: 'TARDE, ya corrió (+' + pct.toFixed(1) + '%)' };
}
async function fwr(url, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + url);
      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(res => setTimeout(res, 400));
    }
  }
}
async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('Telegram error:', e.message); }
}

/* ============================================================
   INDICADORES (idénticos al scanner web)
   ============================================================ */
function cSMA(arr, n) { return arr.slice(-n).reduce((a, b) => a + b, 0) / Math.min(arr.length, n); }
function cRSI(cls, n = 14) {
  if (cls.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = cls.length - n; i < cls.length; i++) { const d = cls[i] - cls[i - 1]; if (d > 0) g += d; else l += Math.abs(d); }
  const ag = g / n, al = l / n; if (al === 0) return 100; return 100 - (100 / (1 + ag / al));
}
function cStochRSI(cls, rl = 14, sl = 14, ks = 3, ds = 3) {
  if (cls.length < rl + sl + ks + ds + 5) return { k: 50 };
  const ra = []; for (let i = rl; i < cls.length; i++) ra.push(cRSI(cls.slice(0, i + 1), rl));
  const sr = []; for (let i = sl - 1; i < ra.length; i++) { const w = ra.slice(i - sl + 1, i + 1), hi =
