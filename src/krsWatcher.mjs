// krsWatcher.mjs
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


// Gate: wysyłamy tylko o 14:00 Europe/Warsaw, chyba że --force-send
if(!process.argv.includes('--force-send') && !isNow14Warsaw()){
console.log('[info] Nie jest 14:00 Europe/Warsaw – pomijam wysyłkę (uruchomienie kontrolne).');
return;
}


const recipients = must((cfg.recipients||[]).join(','), 'config.recipients');
const sendOnlyOnChange = cfg.sendOnlyOnChange !== false;
const state = await loadJsonSafe(STATE_PATH, {});
const transporter = buildTransport();
const results = [];


for(const krsRaw of cfg.krs || []){
const krs = String(krsRaw).padStart(10,'0');
try{
const payload = await fetchOdpis(krs);
const analysis = analyzeOdpis(payload);
if(!analysis.ok) throw new Error(analysis.error || 'Analiza nie powiodła się');


const prevLast = state[krs]?.lastNumerWpisu ?? null;
const changed = prevLast == null || Number(analysis.last) > Number(prevLast);


if(!sendOnlyOnChange || changed){
const { subject, html, text } = htmlEmail({krs, analysis, oldLast: prevLast});
await transporter.sendMail({
from: process.env.MAIL_FROM || 'KRS Watcher <noreply@example.com>',
to: recipients,
subject, text, html
});
}


state[krs] = { lastNumerWpisu: analysis.last };
results.push({ krs, ok:true, last:analysis.last, changed, kapital: !!analysis.kapital });
}catch(err){
results.push({ krs, ok:false, error: String(err?.message || err) });
}
}


await saveJsonSafe(STATE_PATH, state);


// Log zbiorczy
console.log('[summary]', JSON.stringify(results, null, 2));
}


if (import.meta.url === `file://${process.argv[1]}`) {
main().catch(e => { console.error(e); process.exit(1); });
}
