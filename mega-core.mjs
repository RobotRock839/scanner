// ══════════════════════════════════════════════════════════════════════════
// mega-core.mjs
//
// Núcleo de cálculo del tab "MEGA PUMP" (Manipulation+Distribution / entrada
// confirmada), extraído TAL CUAL de index.html (liqscan_main / checkAMDMega,
// fetchMegaData, calcTechoMega y sus funciones auxiliares) para poder
// correrlo con Node fuera del navegador — mismo código, misma lógica, sin
// reescribir nada. Si el día de mañana se toca la lógica en index.html,
// hay que copiar el cambio acá también (o, mejor, extraer ambos de un
// tercer archivo común — ver nota al final).
//
// No requiere localStorage ni DOM: solo fetch() a la API pública de
// Binance Futures. Node 18+ trae fetch global, no hace falta node-fetch.
// ══════════════════════════════════════════════════════════════════════════

// ── Fetch con reintentos (igual a fwr() del scanner, sin las banderas de UI) ──
export async function fwr(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 418) throw new Error('HTTP 418 (IP baneada por Binance — esperar unos minutos)');
      if (!r.ok) throw new Error('HTTP ' + r.status + ' en ' + url);
      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise((res) => setTimeout(res, 500));
    }
  }
}

export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const my = idx++;
      try { results[my] = await fn(items[my], my); }
      catch (e) { results[my] = null; }
      await new Promise((res) => setTimeout(res, 70));
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Indicadores técnicos (idénticos al scanner) ──
function cSMA(arr, n) { return arr.slice(-n).reduce((a, b) => a + b, 0) / Math.min(arr.length, n); }

function cRSI(cls, n = 14) {
  if (cls.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = cls.length - n; i < cls.length; i++) { const d = cls[i] - cls[i - 1]; if (d > 0) g += d; else l += Math.abs(d); }
  const ag = g / n, al = l / n; if (al === 0) return 100; return 100 - (100 / (1 + ag / al));
}

export function cStochRSI(cls, rl = 14, sl = 14, ks = 3, ds = 3) {
  if (cls.length < rl + sl + ks + ds + 5) return { k: 50, d: 50, kP: 50 };
  const ra = []; for (let i = rl; i < cls.length; i++) ra.push(cRSI(cls.slice(0, i + 1), rl));
  const sr = []; for (let i = sl - 1; i < ra.length; i++) { const w = ra.slice(i - sl + 1, i + 1), hi = Math.max(...w), lo = Math.min(...w); sr.push(hi === lo ? 50 : (ra[i] - lo) / (hi - lo) * 100); }
  const ka = []; for (let i = ks - 1; i < sr.length; i++) ka.push(cSMA(sr.slice(i - ks + 1, i + 1), ks));
  if (ka.length < ds) return { k: ka[ka.length - 1] || 50, d: 50, kP: ka[ka.length - 2] || 50 };
  const da = []; for (let i = ds - 1; i < ka.length; i++) da.push(cSMA(ka.slice(i - ds + 1, i + 1), ds));
  return { k: ka[ka.length - 1], kP: ka[ka.length - 2] || ka[ka.length - 1], d: da[da.length - 1] };
}

export function cADX(kl, n = 14) {
  if (kl.length < n * 2) return 20;
  const h = kl.map((k) => parseFloat(k[2])), l = kl.map((k) => parseFloat(k[3])), c = kl.map((k) => parseFloat(k[4]));
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

export function cSqzMom(kl, n = 20) {
  if (kl.length < n * 2) return { positivo: false, subiendo: false, virando: false };
  const cls = kl.map((k) => parseFloat(k[4])), highs = kl.map((k) => parseFloat(k[2])), lows = kl.map((k) => parseFloat(k[3]));
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

// ── CVD / absorción / whale buy (idéntico al scanner) ──
function deltaVela(k, idx) {
  const o = parseFloat(k[idx][1]), c = parseFloat(k[idx][4]), v = parseFloat(k[idx][5]);
  return c > o ? v : c < o ? -v : 0;
}
function sumRange(getVal, endIdx, count) {
  let s = 0;
  for (let j = 0; j < count; j++) { const idx = endIdx - j; if (idx < 0) break; s += getVal(idx); }
  return s;
}
function avgRange(getVal, endIdx, count) {
  let s = 0, c = 0;
  for (let j = 0; j < count; j++) { const idx = endIdx - j; if (idx < 0) break; s += getVal(idx); c++; }
  return c > 0 ? s / c : 0;
}
function absorcionCvdAt(k, idx) {
  if (idx - 9 < 0) return false;
  const cvdRec = sumRange((i) => deltaVela(k, i), idx, 5);
  const cvdPrev = sumRange((i) => deltaVela(k, i), idx - 5, 5);
  const closeNow = parseFloat(k[idx][4]);
  const closeBack = parseFloat(k[idx - 5][4]);
  const prSube = closeNow > closeBack * 1.005;
  const cvdCae = cvdPrev > 0 && cvdRec < cvdPrev * 0.8;
  return prSube && cvdCae;
}
export function computeAbsConsecCountPine(k) {
  const lastIdx = k.length - 1;
  let count = 0;
  for (let i = 0; i <= 9; i++) {
    const idx = lastIdx - i;
    if (idx < 0) break;
    if (absorcionCvdAt(k, idx)) count++;
    else break;
  }
  return count;
}
export function computeWhaleBuyPine(k, whaleMult = 2.0, whaleLookback = 4) {
  const n = k.length;
  if (n < 30) return false;
  const vol = k.map((x) => parseFloat(x[5]));
  const open = k.map((x) => parseFloat(x[1]));
  const high = k.map((x) => parseFloat(x[2]));
  const close = k.map((x) => parseFloat(x[4]));
  const delta = k.map((x, i) => (close[i] > open[i] ? vol[i] : close[i] < open[i] ? -vol[i] : 0));
  const lastIdx = n - 1;
  for (let off = 0; off < whaleLookback; off++) {
    const idx = lastIdx - off;
    if (idx - 24 < 0) continue;
    const volSma = avgRange((i) => vol[i], idx, 20);
    const volRatio = volSma > 0 ? vol[idx] / volSma : 1;
    const mechaSup = high[idx] - Math.max(open[idx], close[idx]);
    const cuerpo = Math.abs(close[idx] - open[idx]) + 1e-9;
    const whaleBullNow = volRatio >= whaleMult && close[idx] > open[idx];
    const absorcionVenta = mechaSup > cuerpo * 1.5 && whaleBullNow;
    const cvdVentana = sumRange((i) => delta[i], idx, 20);
    const cvdVentanaPrev = sumRange((i) => delta[i], idx - 1, 20);
    const cvdVals = [0, 1, 2, 3, 4].map((off2) => sumRange((i) => delta[i], idx - off2, 20));
    const cvdSma = cvdVals.reduce((a, b) => a + b, 0) / cvdVals.length;
    const cvdSube = cvdVentana > cvdVentanaPrev && cvdVentana > cvdSma;
    const whaleBuy = whaleBullNow && cvdSube && !absorcionVenta;
    if (whaleBuy) return true;
  }
  return false;
}

// ── Filtro AMD estricto: barrido de liquidez + CHoCH (igual a checkAMDMega) ──
export const MEGA_AMD_LOOKBACK = 40;
export const MEGA_AMD_TRIGGER_WINDOW = 4;

export async function checkAMDMega(symbol) {
  try {
    const kl = await fwr('https://fapi.binance.com/fapi/v1/klines?symbol=' + symbol + 'USDT&interval=1h&limit=' + (MEGA_AMD_LOOKBACK + MEGA_AMD_TRIGGER_WINDOW + 10));
    if (!Array.isArray(kl) || kl.length < MEGA_AMD_LOOKBACK + MEGA_AMD_TRIGGER_WINDOW) return null;
    const highs = kl.map((x) => parseFloat(x[2])), lows = kl.map((x) => parseFloat(x[3])), closes = kl.map((x) => parseFloat(x[4]));
    const n = kl.length;
    const winStart = n - MEGA_AMD_TRIGGER_WINDOW;
    const lookStart = Math.max(0, winStart - MEGA_AMD_LOOKBACK);
    let swingLowIdx = lookStart;
    for (let i = lookStart; i < winStart; i++) { if (lows[i] < lows[swingLowIdx]) swingLowIdx = i; }
    const swingLow = lows[swingLowIdx];
    let swingHigh = -Infinity;
    for (let i = swingLowIdx; i < winStart; i++) { if (highs[i] > swingHigh) swingHigh = highs[i]; }
    if (swingHigh === -Infinity) return null;
    let sweep = false, sweepIdx = -1;
    for (let i = winStart; i < n; i++) { if (lows[i] < swingLow && closes[i] > swingLow) { sweep = true; sweepIdx = i; break; } }
    let chochUp = false;
    if (sweep) { for (let i = sweepIdx; i < n; i++) { if (closes[i] > swingHigh) { chochUp = true; break; } } }
    return { sweep, chochUp, swingLow, swingHigh, amdOk: sweep && chochUp };
  } catch (e) { return null; }
}

export async function calcTechoMega(symbol, price) {
  const pair = symbol + 'USDT';
  const RNG_PCT = 0.15;
  try {
    const dep = await fwr('https://fapi.binance.com/fapi/v1/depth?symbol=' + pair + '&limit=500');
    if (!dep || !dep.asks) return null;
    const asks = dep.asks.map((a) => ({ p: +a[0], u: +a[0] * +a[1] })).filter((a) => a.p > price && a.p <= price * (1 + RNG_PCT));
    if (!asks.length) return null;
    const bucketSize = (price * RNG_PCT) / 20;
    const walls = Array.from({ length: 20 }, (_, i) => ({
      price: price + i * bucketSize,
      usd: asks.filter((a) => a.p >= price + i * bucketSize && a.p < price + (i + 1) * bucketSize).reduce((s, a) => s + a.u, 0),
    }));
    const top = [...walls].sort((a, b) => b.usd - a.usd)[0];
    return { techoPrice: top.price, techoUsd: top.usd };
  } catch (e) { return null; }
}

// ── Candidato base (Score 0-15) — igual a fetchMegaData ──
export const MEGA_TP_FIXED_PCT = 0.10;
export const MEGA_MIN_RR = 1.2;

export async function fetchMegaData(symbol) {
  const pair = symbol + 'USDT';
  try {
    const [kl, fr] = await Promise.allSettled([
      fwr('https://fapi.binance.com/fapi/v1/klines?symbol=' + pair + '&interval=4h&limit=80'),
      fwr('https://fapi.binance.com/fapi/v1/fundingRate?symbol=' + pair + '&limit=1'),
    ]);
    if (kl.status !== 'fulfilled' || !Array.isArray(kl.value) || kl.value.length < 30) return null;
    const k = kl.value;
    const funding = fr.status === 'fulfilled' && fr.value[0] ? parseFloat(fr.value[0].fundingRate) * 100 : 0;
    if (funding >= 0) return null;
    const cls = k.map((x) => parseFloat(x[4]));
    const vols = k.map((x) => parseFloat(x[5]));
    const vSma = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const vRatio = vSma > 0 ? vols[vols.length - 1] / vSma : 1;
    const adx = cADX(k, 14);
    const stR = cStochRSI(cls, 14, 14, 3, 3), stochK = stR.k;
    const sqz = cSqzMom(k);
    const absConsecCnt = computeAbsConsecCountPine(k);
    let score = 0, tipo = 'candidato';
    if (funding < -0.01) score += 2; else score += 1;
    if (vRatio < 0.5) score += 2; else if (vRatio < 1.0) score += 1;
    if (adx <= 15) score += 2; else if (adx <= 25) score += 1;
    if (sqz.virando) score += 2; else if (sqz.subiendo || sqz.positivo) score += 1;
    if (absConsecCnt >= 3) score += 2; else if (absConsecCnt >= 1) score += 1;
    if (stochK < 15) score += 2; else if (stochK < 25) score += 1;
    if (stochK < 20 && vRatio < 0.5) tipo = 'spring'; else if (absConsecCnt >= 2) tipo = 'absorcion';
    const springOrAbsorcion = (stochK < 20 && vRatio < 0.5) || absConsecCnt >= 2;
    if (score < 4) return null;
    const whaleBuy = computeWhaleBuyPine(k);
    if (whaleBuy) { score += 3; tipo = 'entrada'; }
    const refWindow = cls.slice(-30, -4);
    const refLow = refWindow.length ? Math.min(...refWindow) : cls[Math.max(0, cls.length - 5)];
    const price = cls[cls.length - 1];
    return { symbol, funding, adx, vRatio, whaleBuy, absorcionCnt: absConsecCnt, stochK, sqzVirando: sqz.virando, sqzSubiendo: sqz.subiendo, springOrAbsorcion, score, scoreMax: 15, price, tipo, refLow };
  } catch (e) { return null; }
}

// ── NOTA sobre el "historial" / cooldown de 12h ──
// En index.html esto vive en localStorage del navegador (megaHistorial /
// megaYaAlertado) para no re-alertar la misma entrada dos veces y calcular
// winrate TP/SL con el tiempo. Ese estado es del navegador de Pablo, no del
// repo, así que a propósito NO se replica acá: run-mega.mjs siempre calcula
// el estado "fresco" de este momento. Si en algún momento se quiere el mismo
// anti-repetición en la corrida automática, hay que persistir un JSON de
// historial en el repo y leerlo/escribirlo en cada corrida — decílo y lo
// sumamos, no lo armé de más sin que lo pidas.
