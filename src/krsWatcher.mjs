// krsWatcher.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { analyzeOdpis, formatPLN } from './analyzer.mjs';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'state.json');
const CSV_PATH_DEFAULT = path.join(__dirname, 'companies.csv');

const REGISTRY_URL = (k) => `https://api-krs.ms.gov.pl/api/krs/OdpisPelny/${k}?rejestr=P&format=json`;

async function loadJsonSafe(p, fallback){ try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; } }
async function saveJsonSafe(p, data){ await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf8'); }

async function fetchOdpis(krs){
  const url = REGISTRY_URL(krs);
  const res = await fetch(url, { headers: { 'Accept':'application/json' }});
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch(e){ throw new Error(`Nieprawidłowy JSON: ${e.message}`); }
}

function must(val, name){ if(!val) throw new Error(`Missing required env/config: ${name}`); return val; }

function buildTransport(){
  const host = must(process.env.SMTP_HOST, 'SMTP_HOST');
  const port = Number(must(process.env.SMTP_PORT, 'SMTP_PORT'));
  const secure = String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';
  const user = must(process.env.SMTP_USER, 'SMTP_USER');
  const pass = must(process.env.SMTP_PASS, 'SMTP_PASS');
  return nodemailer.createTransport({ host, port, secure, auth:{ user, pass } });
}

// ====== Ładowanie listy KRS z wielu źródeł ======
function uniq(arr){ return Array.from(new Set(arr)); }
function normKrs(s){ return String(s||'').replace(/\D/g,'').padStart(10,'0').slice(-10); }

async function loadKrsFromCsv(csvPath){
  try{
    const raw = await fs.readFile(csvPath, 'utf8');
    const lines = raw.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    if(!lines.length) return [];
    const sep = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
    const header = lines[0].toUpperCase();
    const hasHeader = /KRS/.test(header);
    const dataLines = hasHeader ? lines.slice(1) : lines;
    const idx = hasHeader ? header.split(sep).findIndex(h=>/KRS/.test(h)) : 0;
    const vals = dataLines.map(ln => {
      const cols = ln.split(sep).map(c=>c.trim());
      return normKrs(cols[idx>=0?idx:0]);
    });
    return vals.filter(v=>/^\d{10}$/.test(v));
  }catch{ return []; }
}

async function loadKrsFromSheetsCsv(url){
  if(!url) return [];
  try{
    const res = await fetch(url);
    if(!res.ok) throw new Error('HTTP '+res.status);
    const text = await res.text();
    const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    if(!lines.length) return [];
    const header = lines[0].toUpperCase();
    const sep = ',';
    const hasHeader = /KRS/.test(header);
    const idx = hasHeader ? header.split(sep).findIndex(h=>/KRS/.test(h)) : 0;
    const dataLines = hasHeader ? lines.slice(1) : lines;
    const vals = dataLines.map(ln => {
      const cols = ln.split(sep).map(c=>c.replace(/^"|"$/g,'').trim());
      return normKrs(cols[idx>=0?idx:0]);
    });
    return vals.filter(v=>/^\d{10}$/.test(v));
  }catch{ return []; }
}

async function loadKrsList(cfg){
  const listFromCfg = (cfg.krs||[]).map(normKrs).filter(v=>/^\d{10}$/.test(v));
  const csvPath = cfg.csvPath ? (path.isAbsolute(cfg.csvPath) ? cfg.csvPath : path.join(__dirname, '..', cfg.csvPath)) : CSV_PATH_DEFAULT;
  const listFromCsv = await loadKrsFromCsv(csvPath);
  const listFromSheets = await loadKrsFromSheetsCsv(cfg.sheetsCsvUrl||'');
  return uniq([ ...listFromCfg, ...listFromCsv, ...listFromSheets ]);
}

// ====== E-mail: pojedyncza spółka (gdybyś chciał kiedyś wysyłać osobno) ======
function htmlEmailSingle({krs, analysis, oldLast}){
  const changedKap = !!analysis.kapital;
  const subjPrefix = changedKap ? 'ALERT ' : '';
  const subject = `${subjPrefix}KRS: zmiany dla ${krs} (wpis ${analysis.last})`;
  const dz = (analysis.dzialy||[]).map(d=>`<span style="display:inline-block;margin:2px 6px 0 0;padding:4px 8px;border:1px solid #e5e7eb;border-radius:999px;background:#f8fafc;color:#111827;font-size:12px;">${d}</span>`).join('');

  let kapHtml = `<p style="margin:8px 0 0;color:#6b7280;font-size:14px">Kapitał: brak zmian w ostatnim wpisie lub sekcja niedostępna.</p>`;
  if(analysis.kapital){
    const prev = analysis.kapital.poprzednia ? formatPLN(analysis.kapital.poprzednia) : '—';
    const now  = analysis.kapital.nowa ? formatPLN(analysis.kapital.nowa) : '—';
    const diff = Number.isFinite(analysis.kapital.roznica) ? formatPLN(analysis.kapital.roznica) : '—';
    kapHtml = `<div style="margin-top:6px;padding:10px;border:1px solid #fde68a;background:#fffbeb;border-radius:12px">
      <div style="font-weight:700;color:#92400e">Zmieniono kapitał zakładowy</div>
      <div style="margin-top:6px;color:#111827">Poprzednia: <strong>${prev}</strong></div>
      <div>Nowa: <strong>${now}</strong></div>
      <div style="margin-top:4px;color:#374151">Zmiana: <strong>${diff}</strong></div>
    </div>`;
  }

  const html = `
  <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:#111827">
    <h2 style="margin:0 0 8px 0;font-size:18px">KRS ${krs} – nowy wpis <span style="font-family:ui-monospace,monospace">${analysis.last}</span></h2>
    <div style="margin:6px 0 0 0;color:#374151">Działy:</div>
    <div style="margin-top:4px">${dz || '<span style="color:#6b7280">—</span>'}</div>
    ${kapHtml}
    <p style="margin-top:12px;font-size:12px;color:#6b7280">Źródło: <a href="${REGISTRY_URL(krs)}" style="color:#2563eb;text-decoration:none">${REGISTRY_URL(krs)}</a></p>
  </div>`;

  const text = `KRS ${krs} – nowy wpis ${analysis.last}\nDziały: ${(analysis.dzialy||[]).join(', ')||'—'}\n` +
    (analysis.kapital ? `Kapitał: zmiana (poprzednia: ${analysis.kapital.poprzednia||'-'}, nowa: ${analysis.kapital.nowa||'-'})\n` : `Kapitał: brak zmian\n`) +
    `\nŹródło: ${REGISTRY_URL(krs)}`;

  return { subject, html, text };
}

// ====== E-mail: RAPORT DZIENNY ======
function htmlReport({dateStr, results}){
  const changed = results.filter(r=>r.ok && r.changed);
  const changedCap = changed.filter(r=>r.kapitalChanged);
  const subjPrefix = changedCap.length ? 'ALERT ' : '';
  const subject = `${subjPrefix}KRS: dzienny raport (${changed.length} spółek ze zmianą)`;

  const capRows = changedCap.map(r=>{
    const prev = r.kapital?.poprzednia ? formatPLN(r.kapital.poprzednia) : '—';
    const now  = r.kapital?.nowa ? formatPLN(r.kapital.nowa) : '—';
    const diff = Number.isFinite(r.kapital?.roznica) ? formatPLN(r.kapital.roznica) : '—';
    return `<tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${r.krs}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${prev}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${now}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:600">${diff}</td>
    </tr>`;
  }).join('');

  const sections = changed.map(r=>{
    const dz = (r.dzialy||[]).map(d=>`<span style="display:inline-block;margin:2px 6px 0 0;padding:4px 8px;border:1px solid #e5e7eb;border-radius:999px;background:#f8fafc;color:#111827;font-size:12px;">${d}</span>`).join('');
    let kapHtml = `<p style="margin:8px 0 0;color:#6b7280;font-size:14px">Kapitał: brak zmian lub sekcja niedostępna.</p>`;
    if(r.kapital){
      const prev = r.kapital.poprzednia ? formatPLN(r.kapital.poprzednia) : '—';
      const now  = r.kapital.nowa ? formatPLN(r.kapital.nowa) : '—';
      const diff = Number.isFinite(r.kapital.roznica) ? formatPLN(r.kapital.roznica) : '—';
      kapHtml = `<div style="margin-top:6px;padding:10px;border:1px solid #fde68a;background:#fffbeb;border-radius:12px">
        <div style="font-weight:700;color:#92400e">Zmieniono kapitał zakładowy</div>
        <div style="margin-top:6px;color:#111827">Poprzednia: <strong>${prev}</strong></div>
        <div>Nowa: <strong>${now}</strong></div>
        <div style="margin-top:4px;color:#374151">Zmiana: <strong>${diff}</strong></div>
      </div>`;
    }
    return `<div style="padding:14px 0;border-top:1px solid #e5e7eb">
      <h3 style="margin:0 0 6px;font-size:16px">${r.krs} – wpis <span style="font-family:ui-monospace,monospace">${r.last}</span></h3>
      <div style="margin:6px 0 0;color:#374151">Działy:</div>
      <div style="margin-top:4px">${dz || '<span style="color:#6b7280">—</span>'}</div>
      ${kapHtml}
      <p style="margin-top:8px;font-size:12px;color:#6b7280">Źródło: <a href="${REGISTRY_URL(r.krs)}" style="color:#2563eb;text-decoration:none">${REGISTRY_URL(r.krs)}</a></p>
    </div>`;
  }).join('') || `<p style="color:#6b7280">Brak nowych wpisów dzisiaj.</p>`;

  const html = `
  <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:#111827">
    <h2 style="margin:0 0 4px">KRS – dzienny raport (${dateStr})</h2>
    <p style="margin:0;color:#374151">Spółek ze zmianą: <strong>${changed.length}</strong> • ze zmianą kapitału: <strong>${changedCap.length}</strong></p>
    ${capRows ? `
    <div style="margin-top:10px">
      <div style="font-weight:600;margin-bottom:6px">Zmiany kapitału (mini-tabela):</div>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f3f4f6">
            <th style="text-align:left;padding:8px">KRS</th>
            <th style="text-align:left;padding:8px">Poprzednia</th>
            <th style="text-align:left;padding:8px">Nowa</th>
            <th style="text-align:left;padding:8px">Różnica</th>
          </tr>
        </thead>
        <tbody>${capRows}</tbody>
      </table>
    </div>` : ''}
    <div style="margin-top:16px">${sections}</div>
  </div>`;

  const text = `KRS – dzienny raport (${dateStr})
Zmian: ${changed.length}, kapitał: ${changedCap.length}`;
  return { subject, html, text };
}

function isNow14Warsaw(){
  const fmt = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = fmt.formatToParts(new Date());
  const hh = Number(parts.find(p=>p.type==='hour')?.value || '0');
  const mm = Number(parts.find(p=>p.type==='minute')?.value || '0');
  return hh === 14 && mm === 0;
}

async function main(){
  const cfg = await loadJsonSafe(CFG_PATH, null);
  if(!cfg) throw new Error('Brak pliku config.json w katalogu src/');

  // GATE czasu – chyba że --force-send
  if(!process.argv.includes('--force-send') && !isNow14Warsaw()){
    console.log('[info] Nie jest 14:00 Europe/Warsaw – pomijam wysyłkę (uruchomienie kontrolne).');
    return;
  }

  const recipients = must((cfg.recipients||[]).join(','), 'config.recipients');
  const sendOnlyOnChange = cfg.sendOnlyOnChange !== false;
  const state = await loadJsonSafe(STATE_PATH, {});
  const transporter = buildTransport();

  const krsList = await loadKrsList(cfg);
  if(!krsList.length) throw new Error('Brak numerów KRS w config/csv/sheets');

  const results = [];
  for(const krs of krsList){
    try{
      const payload = await fetchOdpis(krs);
      const analysis = analyzeOdpis(payload);
      if(!analysis.ok) throw new Error(analysis.error || 'Analiza nie powiodła się');

      const prevLast = state[krs]?.lastNumerWpisu ?? null;
      const changed = prevLast == null || Number(analysis.last) > Number(prevLast);

      state[krs] = { lastNumerWpisu: analysis.last };
      results.push({
        krs, ok:true, last:analysis.last, changed,
        dzialy:analysis.dzialy, kapital:analysis.kapital,
        kapitalChanged: !!analysis.kapital
      });
    }catch(err){
      results.push({ krs, ok:false, error: String(err?.message || err) });
    }
  }

  await saveJsonSafe(STATE_PATH, state);

  const dateStr = new Intl.DateTimeFormat('pl-PL', { timeZone:'Europe/Warsaw', dateStyle:'long' }).format(new Date());
  const changed = results.filter(r=>r.ok && r.changed);
  if(sendOnlyOnChange && changed.length === 0){
    console.log('[summary] Brak nowych wpisów – nie wysyłam e-maila.');
    return;
  }

  const { subject, html, text } = htmlReport({ dateStr, results });
  await transporter.sendMail({
    from: process.env.MAIL_FROM || 'KRS Watcher <noreply@example.com>',
    to: recipients,
    subject, text, html
  });

  console.log('[summary]', JSON.stringify({ sent:true, subject, totals:{ changed: changed.length, capital: changed.filter(r=>r.kapitalChanged).length } }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
