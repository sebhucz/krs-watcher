// analyzer.mjs
export function formatPLN(txt){
try{ let s=String(txt).replace(/ /g,'').replace(/\./g,'').replace(',', '.');
const n=Number(s); if(Number.isFinite(n)) return n.toLocaleString('pl-PL',{style:'currency',currency:'PLN'});
}catch{} return txt;
}
export function numify(txt){ if(txt==null) return NaN; let s=String(txt).replace(/ /g,'').replace(/\./g,'').replace(',', '.'); const n=Number(s); return Number.isFinite(n)?n:NaN; }


const DZIAL_DESC = {
dzial1: 'Dział I – Dane podmiotu i kapitał',
dzial2: 'Dział II – Organy i reprezentacja',
dzial3: 'Dział III – PKD, sprawozdania, wzmianki',
dzial4: 'Dział IV – Postępowania, upadłości',
dzial5: 'Dział V – Połączenia, podziały, przekształcenia',
dzial6: 'Dział VI – Wzmianki różne',
dzialI: 'Dział I – Dane podmiotu i kapitał',
dzialII: 'Dział II – Organy i reprezentacja',
dzialIII: 'Dział III – PKD, sprawozdania, wzmianki',
dzialIV: 'Dział IV – Postępowania, upadłości',
dzialV: 'Dział V – Połączenia, podziały, przekształcenia',
dzialVI: 'Dział VI – Wzmianki różne'
};
const dzialDesc = (key) => DZIAL_DESC[key] || key;


function entryTouchesPath(obj, last){
const target = String(last);
const stack = [obj];
while(stack.length){
const cur = stack.pop();
if(Array.isArray(cur)) { for(const it of cur) stack.push(it); continue; }
if(cur && typeof cur === 'object'){
if(cur.nrWpisuWprow != null && String(cur.nrWpisuWprow) === target) return true;
if(cur.nrWpisuaWprow != null && String(cur.nrWpisuaWprow) === target) return true;
for(const k in cur){ stack.push(cur[k]); }
}
}
return false;
}


function dzialyDlaWpisu(data, last){
const out = [];
const dane = data?.odpis?.dane;
if(!dane || typeof dane !== 'object') return out;
for(const k of Object.keys(dane)){
if(/^dzial/i.test(k)){
const section = dane[k];
try{ if(entryTouchesPath(section, last)) out.push(dzialDesc(k)); } catch{}
}
}
return out;
}


function getKapitalArray(data){
const candidates = [
d=>d?.odpis?.dane?.dzial1?.kapital?.wysokoscKapitaluZakladowego,
d=>d?.odpis?.dane?.kapital?.wysokoscKapitaluZakladowego,
d=>d?.odpis?.dane?.dzialI?.kapital?.wysokoscKapitaluZakladowego,
];
for(const g of candidates){ const arr=g(data); if(Array.isArray(arr)&&arr.length) return arr; }
return null;
}


export function analyzeOdpis(payload){
if(!payload || !payload.odpis)
return { ok:false, error:'Brak pola odpis', last:null };


const wpisy = payload?.odpis?.naglowekP?.wpis || [];
if(!Array.isArray(wpisy) || !wpisy.length)
return { ok:false, error:'Brak sekcji odpis.naglowekP.wpis', last:null };


const last = wpisy.reduce((max, x) => {
}
