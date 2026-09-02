// ══════════════════════════════════════════════════════════════════════════
// run-mega.mjs
//
// Corre el mismo escaneo que el botón "↺ NOW" del tab MEGA PUMP en
// index.html (función runMega()), pero en Node — pensado para GitHub
// Actions con un cron cada 15 min. Escribe mega-resultados.json en la raíz
// del repo con las entradas confirmadas del momento (trendOk && rrOk) y las
// filtradas con su motivo, para que index.html las pre-cargue al abrir.
//
// Uso: node run-mega.mjs
// ══════════════════════════════════════════════════════════════════════════
import { writeFile } from 'node:fs/promises';
import {
  fetchMegaData, checkAMDMega, calcTechoMega, mapWithConcurrency,
  MEGA_MIN_RR, MEGA_TP_FIXED_PCT,
} from './mega-core.mjs';

const CONCURRENCY = 4;
const OUT_FILE = new URL('./mega-resultados.json', import.meta.url);

const STABLE_PREFIXES = ['USDC', 'BUSD', 'TUSD', 'USDP', 'DAI', 'FDUSD'];

async function getPairs() {
  const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
  if (!r.ok) throw new Error('No se pudo obtener la lista de pares (HTTP ' + r.status + ')');
  const tickers = await r.json();
  return tickers
    .filter((t) => t.symbol.endsWith('USDT') && !t.symbol.includes('_') && !STABLE_PREFIXES.some((s) => t.symbol.startsWith(s)))
    .map((t) => t.symbol.replace('USDT', ''));
}

async function main() {
  const startedAt = Date.now();
  console.log('Obteniendo lista de pares USDT-perp de Binance Futures...');
  const pairs = await getPairs();
  console.log(pairs.length + ' pares a escanear.');

  const entradas = [];
  const filtradas = [];
  const otros = []; // candidato / spring / absorcion (informativo, sin whale buy todavía)

  const BATCH = 20;
  let processed = 0;
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    const results = await mapWithConcurrency(batch, CONCURRENCY, (s) => fetchMegaData(s));
    for (const d of results) {
      if (!d) continue;
      if (d.tipo === 'entrada') {
        const techo = await calcTechoMega(d.symbol, d.price);
        const tpFixedPrice = d.price * (1 + MEGA_TP_FIXED_PCT);
        const tpPrice = techo && techo.techoPrice ? Math.min(techo.techoPrice, tpFixedPrice) : tpFixedPrice;
        const slPrice = d.refLow || null;
        const rr = slPrice != null && d.price > slPrice ? (tpPrice - d.price) / (d.price - slPrice) : null;
        const amd = await checkAMDMega(d.symbol);
        const amdStrict = amd ? amd.amdOk : false;
        const altPath = !!(d.springOrAbsorcion && d.sqzVirando);
        const trendOk = amdStrict || altPath;
        const rrOk = rr != null && rr >= MEGA_MIN_RR;
        if (trendOk && rrOk) {
          const amdVia = amdStrict ? 'sweep+choch' : 'spring+sqz';
          entradas.push({ ...d, tpPrice, slPrice, rr, techoPrice: techo ? techo.techoPrice : null, amdSweep: amd ? amd.sweep : false, amdChoch: amd ? amd.chochUp : false, amdVia });
        } else {
          let motivo;
          if (!trendOk) {
            if (amd && amd.sweep && !amd.chochUp) motivo = 'AMD: barrido sin CHoCH y sin compresión/absorción con giro (Manipulation sin confirmar)';
            else if (d.springOrAbsorcion && !d.sqzVirando) motivo = 'AMD: compresión/absorción sin giro de momentum (Manipulation sin confirmar D)';
            else motivo = 'AMD: sin barrido de liquidez 1h ni compresión/absorción (todavía en Accumulation)';
          } else {
            motivo = `R:R insuficiente (${rr != null ? rr.toFixed(2) : 'N/A'} < ${MEGA_MIN_RR})`;
          }
          filtradas.push({ ...d, motivo });
        }
      } else {
        otros.push(d);
      }
    }
    processed += batch.length;
    console.log(`  ${processed}/${pairs.length} · ${entradas.length} entradas confirmadas · ${filtradas.length} filtradas`);
    await new Promise((res) => setTimeout(res, 300));
  }

  const out = {
    generadoEn: new Date().toISOString(),
    tomoMs: Date.now() - startedAt,
    totalPares: pairs.length,
    entradas,
    filtradas,
    otros,
  };
  await writeFile(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`Listo. ${entradas.length} entrada(s) confirmada(s), ${filtradas.length} filtrada(s). Escrito en mega-resultados.json`);
}

main().catch((e) => {
  console.error('run-mega.mjs falló:', e);
  process.exit(1);
});
