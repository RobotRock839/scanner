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
  const sr = []; for (let i = sl - 1; i < ra.length; i++) { const w = ra.slice(i - sl + 1, i + 1), hi = Math.max(...w), lo = Math.min(...w); sr.push(hi === lo ? 50 : (ra[i] - lo) / (hi - lo) * 100); }
  const ka = []; for (let i = ks - 1; i < sr.length; i++) ka.push(cSMA(sr.slice(i - ks + 1, i + 1), ks));
  return { k: ka[ka.length - 1] || 50 };
}
function cADX(kl, n = 14) {
  if (kl.length < n * 2) return 20;
  const h = kl.map(k => parseFloat(k[2])), l = kl.map(k => parseFloat(k[3])), c = kl.map(k => parseFloat(k[4]));
  const tr = [], pd = [], md = [];
  for (let i = 1; i < kl.length; i++) {
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    const u = h[i] - h[i - 1], d = l[i - 1] - l[i]; pd.push(u > d && u > 0 ? u : 0); md.push(d > u && d > 0 ? d : 0);
  }
  let a = tr.slice(0, n).reduce((a, b) => a + b, 0), p = pd.slice(0, n).reduce((a, b) => a + b, 0), m = md.slice(0, n).reduce((a, b) => a + b, 0);
  const dx = [];
  for (let i = n; i < tr.length; i++) { a = a - a / n + tr[i]; p = p - p / n + pd[i]; m = m - m / n + md[i]; const pi = a > 0 ? p / a * 100 : 0, mi = a > 0 ? m / a * 100 : 0, den = pi + mi; dx.push(den > 0 ? Math.abs(pi - mi) / den * 100 : 0); }
  return dx.length < n ? 20 : dx.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function cSqzMom(kl, n = 20) {
  if (kl.length < n * 2) return { positivo: false, subiendo: false, virando: false };
  const cls = kl.map(k => parseFloat(k[4])), highs = kl.map(k => parseFloat(k[2])), lows = kl.map(k => parseFloat(k[3]));
  const vals = [];
  for (let i = n; i < kl.length; i++) {
    const sl = cls.slice(i - n, i), hl = highs.slice(i - n, i), ll = lows.slice(i - n, i);
    const hh = Math.max(...hl), ll2 = Math.min(...ll), mid = (hh + ll2) / 2, sma = sl.reduce((a, b) => a + b, 0) / n;
    vals.push(cls[i] - (mid + sma) / 2);
  }
  if (vals.length < 4) return { positivo: false, subiendo: false, virando: false };
  const last = vals[vals.length - 1], prev = vals[vals.length - 2];
  return { positivo: last > 0, subiendo: last > prev && last < 0, virando: prev <= 0 && last > 0 };
}
function detectAbsorcion(klines) {
  if (!klines || klines.length < 12) return { count: 0 };
  let count = 0;
  for (let i = 10; i < Math.min(60, klines.length); i += 5) {
    const sl = klines.slice(i, i + 10); if (sl.length < 10) continue;
    const dd = sl.map(k => { const o = parseFloat(k[1]), c = parseFloat(k[4]), v = parseFloat(k[5]); return c > o ? v : c < o ? -v : 0; });
    const c1 = dd.slice(0, 5).reduce((a, b) => a + b, 0), c2 = dd.slice(5).reduce((a, b) => a + b, 0);
    if (c1 > 0 && c2 < c1 * 0.8) count++;
  }
  return { count };
}
function cEMA(cls, period) {
  if (!cls || cls.length < period) return null;
  const k = 2 / (period + 1);
  let ema = cls.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < cls.length; i++) { ema = cls[i] * k + ema * (1 - k); }
  return ema;
}
async function checkTrend(symbol) {
  try {
    const kl = await fwr('https://fapi.binance.com/fapi/v1/klines?symbol=' + symbol + 'USDT&interval=1h&limit=' + (TREND_EMA_SLOW + 30));
    if (!Array.isArray(kl) || kl.length < TREND_EMA_SLOW + 5) return null;
    const cls = kl.map(x => parseFloat(x[4]));
    const emaFast = cEMA(cls, TREND_EMA_FAST), emaSlow = cEMA(cls, TREND_EMA_SLOW);
    if (emaFast == null || emaSlow == null) return null;
    return { trendUp: emaFast > emaSlow };
  } catch (e) { return null; }
}

/* ============================================================
   FETCH COMPARTIDO + MÉTRICAS + ANALIZADORES (idénticos al scanner web)
   ============================================================ */
async function fetchSymbolData(symbol) {
  const pair = symbol + 'USDT';
  try {
    const [kl, fr] = await Promise.allSettled([
      fwr('https://fapi.binance.com/fapi/v1/klines?symbol=' + pair + '&interval=15m&limit=80'),
      fwr('https://fapi.binance.com/fapi/v1/fundingRate?symbol=' + pair + '&limit=1')
    ]);
    if (kl.status !== 'fulfilled' || !Array.isArray(kl.value) || kl.value.length < 60) return null;
    const k = kl.value;
    const funding = fr.status === 'fulfilled' && fr.value[0] ? parseFloat(fr.value[0].fundingRate) * 100 : 0;
    return { k, funding };
  } catch (e) { return null; }
}

function computeMetrics(k) {
  const cls = k.map(x => parseFloat(x[4]));
  const vols = k.map(x => parseFloat(x[5]));
  const vSma = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const vRatio = vSma > 0 ? vols[vols.length - 1] / vSma : 1;
  const adx = cADX(k, 14);
  const stR = cStochRSI(cls, 14, 14, 3, 3), stochK = stR.k;
  const sqz = cSqzMom(k);
  const absData = detectAbsorcion(k);
  const deltas = k.map(x => { const o = parseFloat(x[1]), c = parseFloat(x[4]), v = parseFloat(x[5]); return c > o ? v : c < o ? -v : 0; });
  const cvd20 = deltas.slice(-20).reduce((a, b) => a + b, 0);
  const cvdPv = deltas.slice(-21, -1).reduce((a, b) => a + b, 0);
  const cvdSm = deltas.slice(-25).reduce((a, b) => a + b, 0) / 5;
  const cvdU = cvd20 > cvdPv && cvd20 > cvdSm;
  let whaleBuy = false;
  for (let i = Math.max(0, k.length - 4); i < k.length; i++) {
    const kk = k[i], o = parseFloat(kk[1]), h = parseFloat(kk[2]), c = parseFloat(kk[4]), v = parseFloat(kk[5]);
    const rat = vSma > 0 ? v / vSma : 1, cpo = Math.abs(c - o) + 1e-9;
    const mS = h - Math.max(o, c), aV = mS > cpo * 1.5 && rat >= 2 && c > o;
    if (rat >= 2 && c > o && cvdU && !aV) whaleBuy = true;
  }
  if (whaleBuy) {
    const lastK = k[k.length - 1];
    const lo = parseFloat(lastK[1]), lh = parseFloat(lastK[2]), lc = parseFloat(lastK[4]);
    if (vRatio > 1.8 && !((lc - lo) > (lh - lc))) whaleBuy = false;
  }
  const refWindow = cls.slice(-30, -4);
  const refLow = refWindow.length ? Math.min(...refWindow) : cls[Math.max(0, cls.length - 5)];
  const price = cls[cls.length - 1];
  const subidaPct = refLow > 0 ? ((price - refLow) / refLow * 100) : 0;
  return { cls, vols, vSma, vRatio, adx, stochK, sqz, absData, whaleBuy, refLow, price, subidaPct };
}

function analyzeSqueeze(symbol, funding, m) {
  if (funding >= 0) return null;
  let score = 0;
  if (funding < -0.01) score += 2; else score += 1;
  if (m.vRatio < 0.6) score += 2; else if (m.vRatio < 1.0) score += 1;
  if (m.adx <= 15) score += 2; else if (m.adx <= 25) score += 1;
  if (m.sqz.virando) score += 2; else if (m.sqz.subiendo || m.sqz.positivo) score += 1;
  if (m.absData.count >= 3) score += 2; else if (m.absData.count >= 1) score += 1;
  if (m.stochK < 15) score += 2; else if (m.stochK < 25) score += 1;
  if (score < 5) return null;
  let tipo = 'candidato';
  if (m.whaleBuy) { score += 3; tipo = 'entrada'; }
  return { symbol, funding, adx: m.adx, vRatio: m.vRatio, whaleBuy: m.whaleBuy, stochK: m.stochK, score, scoreMax: 13, price: m.price, subidaPct: m.subidaPct, tipo, refLow: m.refLow, modo: 'squeeze' };
}

function analyzeBreakout(symbol, funding, k, m) {
  const kPrior = k.slice(0, k.length - 3);
  if (kPrior.length < 30) return null;
  const adxPrior = cADX(kPrior, 14);
  const comprimidoAntes = adxPrior <= BREAKOUT_ADX_COMPRIMIDO;
  const rompiendoAhora = m.adx > adxPrior && m.adx <= BREAKOUT_ADX_MAX_AHORA;
  const volExplosivo = m.vRatio >= BREAKOUT_VOL_MULT;
  const momentumOk = m.sqz.virando || m.sqz.subiendo;
  const refPrice = m.cls[m.cls.length - 5];
  const movRecentPct = refPrice > 0 ? ((m.price - refPrice) / refPrice * 100) : 0;
  const tempranoOk = movRecentPct >= BREAKOUT_MOV_MIN && movRecentPct <= BREAKOUT_MOV_MAX;
  if (!(comprimidoAntes && rompiendoAhora && volExplosivo && momentumOk && tempranoOk)) return null;
  let confianza = 0;
  if (m.absData.count >= 2) confianza += 2; else if (m.absData.count >= 1) confianza += 1;
  if (m.stochK < 40) confianza += 2; else if (m.stochK < 60) confianza += 1;
  if (funding < 0) confianza += 1;
  const tipo = m.whaleBuy ? 'entrada' : 'candidato';
  if (m.whaleBuy) confianza += 3;
  return { symbol, funding, adx: m.adx, vRatio: m.vRatio, whaleBuy: m.whaleBuy, stochK: m.stochK, score: confianza, scoreMax: 8, price: m.price, subidaPct: movRecentPct, tipo, refLow: m.refLow, modo: 'breakout' };
}

async function calcTecho(symbol, price) {
  const pair = symbol + 'USDT';
  const RNG_PCT = 0.15;
  try {
    const dep = await fwr('https://fapi.binance.com/fapi/v1/depth?symbol=' + pair + '&limit=500');
    if (!dep || !dep.asks) return null;
    const asks = dep.asks.map(a => ({ p: +a[0], u: +a[0] * +a[1] })).filter(a => a.p > price && a.p <= price * (1 + RNG_PCT));
    if (!asks.length) return null;
    const bucketSize = (price * RNG_PCT) / 20;
    const walls = Array.from({ length: 20 }, (_, i) => ({
      price: price + (i * bucketSize),
      usd: asks.filter(a => a.p >= price + (i * bucketSize) && a.p < price + ((i + 1) * bucketSize)).reduce((s, a) => s + a.u, 0)
    }));
    const top = [...walls].sort((a, b) => b.usd - a.usd)[0];
    return { techoPrice: top.price, techoUsd: top.usd, distPct: ((top.price - price) / price * 100) };
  } catch (e) { return null; }
}

async function getAllPairs() {
  const tickers = await fwr('https://fapi.binance.com/fapi/v1/ticker/24hr');
  const filtered = tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => !['USDC', 'BUSD', 'TUSD', 'USDP', 'DAI', 'FDUSD'].some(s => t.symbol.startsWith(s)))
    .filter(t => parseFloat(t.quoteVolume) >= MIN_QUOTE_VOLUME_USDT);
  const priceMap = {}, volMap = {};
  filtered.forEach(t => {
    const sym = t.symbol.replace('USDT', '');
    priceMap[sym] = parseFloat(t.lastPrice);
    volMap[sym] = parseFloat(t.quoteVolume);
  });
  return { symbols: filtered.map(t => t.symbol.replace('USDT', '')), priceMap, volMap };
}

/* ============================================================
   HISTORIAL (persistido en archivo JSON del repo)
   ============================================================ */
function loadHist() {
  if (!existsSync(HIST_PATH)) return [];
  try { return JSON.parse(readFileSync(HIST_PATH, 'utf-8')); } catch (e) { return []; }
}
function saveHist(historial) {
  const dir = dirname(HIST_PATH);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(HIST_PATH, JSON.stringify(historial.slice(0, 150), null, 2));
}

function yaAlertado(historial, symbol) {
  const activa = historial.find(x => x.symbol === symbol && x.tipo === 'entrada' && !x.resultado);
  if (activa) return true;
  const reciente = historial.find(x => x.symbol === symbol && x.tipo === 'entrada' && x.resultado && (Date.now() - x.resueltoTs) < COOLDOWN_HOURS * 60 * 60 * 1000);
  return !!reciente;
}

function evaluarResultados(historial, priceMap) {
  for (const h of historial) {
    if (h.tipo !== 'entrada' || h.resultado) continue;
    const priceNow = priceMap[h.symbol];
    if (priceNow === undefined || isNaN(priceNow)) continue;
    const edadMs = Date.now() - h.ts;
    if (h.tpPrice != null && priceNow >= h.tpPrice) {
      h.resultado = 'TP'; h.resultadoPct = ((priceNow - h.price) / h.price * 100); h.resueltoTs = Date.now();
      sendTelegram(`✅ <b>TP tocado</b> — ${h.symbol}USDT\nEntrada: ${fmtPrice(h.price)} → Ahora: ${fmtPrice(priceNow)} (+${h.resultadoPct.toFixed(1)}%)`);
    } else if (h.slPrice != null && priceNow <= h.slPrice) {
      h.resultado = 'SL'; h.resultadoPct = ((priceNow - h.price) / h.price * 100); h.resueltoTs = Date.now();
      sendTelegram(`❌ <b>SL tocado</b> — ${h.symbol}USDT\nEntrada: ${fmtPrice(h.price)} → Ahora: ${fmtPrice(priceNow)} (${h.resultadoPct.toFixed(1)}%)\nCruzó el soporte previo (${fmtPrice(h.slPrice)}).`);
    } else if (edadMs >= RESULT_WINDOW_MS) {
      h.resultado = 'EXPIRADO'; h.resultadoPct = ((priceNow - h.price) / h.price * 100); h.resueltoTs = Date.now();
    }
  }
}

/* ============================================================
   MAIN
   ============================================================ */
async function main() {
  console.log('=== MEGA_PUMP_SCAN (Node) —', new Date().toISOString(), '===');
  let historial = loadHist();

  const { symbols: pairs, priceMap, volMap } = await getAllPairs();
  console.log(`Pares con liquidez >= $${fmtBig(MIN_QUOTE_VOLUME_USDT)}: ${pairs.length}`);

  evaluarResultados(historial, priceMap);

  let candidatos = 0, entradasNuevas = 0, filtradasNuevas = 0;

  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async s => {
      const data = await fetchSymbolData(s);
      if (!data) return [];
      const m = computeMetrics(data.k);
      const out = [];
      const sq = analyzeSqueeze(s, data.funding, m);
      if (sq) out.push(sq);
      const bo = analyzeBreakout(s, data.funding, data.k, m);
      if (bo) out.push(bo);
      return out;
    }));

    for (const arr of results) {
      for (const d of arr) {
        candidatos++;
        if (d.tipo === 'entrada' && !yaAlertado(historial, d.symbol)) {
          const techo = await calcTecho(d.symbol, d.price);
          const tpFixedPrice = d.price * (1 + TP_FIXED_PCT);
          const tpPrice = techo && techo.techoPrice ? Math.min(techo.techoPrice, tpFixedPrice) : tpFixedPrice;
          const slPrice = d.refLow || null;
          const rr = (slPrice != null && d.price > slPrice) ? (tpPrice - d.price) / (d.price - slPrice) : null;
          const trend = await checkTrend(d.symbol);
          const trendOk = trend ? trend.trendUp : false;
          const rrOk = rr != null && rr >= MIN_RR;
          const vol24h = volMap[d.symbol];
          const modoTxt = d.modo === 'breakout' ? '🌱 BREAKOUT TEMPRANO' : '🐋 SQUEEZE';

          if (trendOk && rrOk) {
            historial.unshift({ ...d, techoPrice: techo ? techo.techoPrice : null, techoUsd: techo ? techo.techoUsd : null, distPct: techo ? techo.distPct : null, tpPrice, slPrice, rr, vol24h, resultado: null, resultadoPct: null, ts: Date.now() });
            entradasNuevas++;
            const techoTxt = techo ? `\n🎯 Techo estimado: <b>${fmtPrice(techo.techoPrice)}</b> (+${techo.distPct.toFixed(2)}%)\nPared: $${fmtBig(techo.techoUsd)}` : '';
            const sub = clasificarSubida(d.subidaPct);
            await sendTelegram(
              `🚀 <b>MEGA PUMP — ENTRADA CONFIRMADA</b>\n\n` +
              `<b>${d.symbol}USDT</b> · Modo: ${modoTxt}\nPrecio: ${fmtPrice(d.price)}\nScore: ${d.score}/${d.scoreMax}\n` +
              `Funding: ${d.funding.toFixed(4)}% · ADX: ${Math.round(d.adx)}\n🐋 Whale BUY confirmado\n` +
              `📈 Tendencia 1h: BULL · R:R ${rr.toFixed(2)} · Vol 24h: $${fmtBig(vol24h)}\n` +
              `${sub.emoji} ${sub.txt}\n` +
              `🎯 TP objetivo: ${fmtPrice(tpPrice)} · 🛑 SL (soporte previo): ${slPrice ? fmtPrice(slPrice) : '—'}` +
              techoTxt
            );
          } else {
            const motivo = !trendOk
              ? `Tendencia 1h bajista o sin datos (EMA${TREND_EMA_FAST}<EMA${TREND_EMA_SLOW})`
              : `R:R insuficiente (${rr != null ? rr.toFixed(2) : 'N/A'} < ${MIN_RR})`;
            const exists = historial.find(x => x.symbol === d.symbol && x.tipo === 'filtrada' && x.modo === d.modo && (Date.now() - x.ts) < 3 * 60 * 60 * 1000);
            if (!exists) {
              historial.unshift({ ...d, tipo: 'filtrada', techoPrice: techo ? techo.techoPrice : null, techoUsd: techo ? techo.techoUsd : null, distPct: techo ? techo.distPct : null, tpPrice, slPrice, rr, vol24h, motivo, ts: Date.now() });
              filtradasNuevas++;
            }
          }
        } else if (d.tipo !== 'entrada') {
          const exists = historial.find(x => x.symbol === d.symbol && x.modo === d.modo && (Date.now() - x.ts) < 3 * 60 * 60 * 1000);
          if (!exists) historial.unshift({ ...d, ts: Date.now() });
        }
      }
    }
    await new Promise(res => setTimeout(res, BATCH_DELAY));
  }

  historial = historial.slice(0, 150);
  saveHist(historial);

  const resueltas = historial.filter(h => h.tipo === 'entrada' && (h.resultado === 'TP' || h.resultado === 'SL'));
  const wins = resueltas.filter(h => h.resultado === 'TP').length;
  const winrate = resueltas.length ? (wins / resueltas.length * 100).toFixed(0) + '%' : '—';

  console.log(`Candidatos: ${candidatos} · Entradas nuevas: ${entradasNuevas} · Filtradas nuevas: ${filtradasNuevas}`);
  console.log(`Resueltas: ${resueltas.length} · Winrate: ${winrate}`);
  console.log('=== Fin ===');
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
