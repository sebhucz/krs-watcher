// src/krsWatcher.mjs

import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";

// ✅ UWAGA: od Node.js 18+ mamy fetch wbudowany
// Tu robimy fallback – jeśli globalny fetch nie istnieje, wtedy dynamicznie załadujemy node-fetch
const fetch = globalThis.fetch ?? (await import("node-fetch")).default;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");

// ---- funkcja: wczytaj konfigurację ----
function loadConfig() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  // Sprawdź, czy istnieje klucz krs_file i wczytaj dane
  if (config.krs_file) {
    const krsFilePath = path.join(__dirname, config.krs_file);
    config.krs = fs.readFileSync(krsFilePath, "utf8")
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  // Sprawdź, czy istnieje klucz recipients_file i wczytaj dane
  if (config.recipients_file) {
    const recipientsFilePath = path.join(__dirname, config.recipients_file);
    config.recipients = fs.readFileSync(recipientsFilePath, "utf8")
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  return config;
}

// ---- funkcja: wczytaj/utwórz state ----
function loadState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---- funkcja: pobierz odpis z API ----
async function fetchOdpis(krs) {
  const url = `https://api-krs.ms.gov.pl/api/krs/OdpisPelny/${krs}?rejestr=P&format=json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Błąd pobierania KRS ${krs}: ${res.status}`);
  return res.json();
}

// ---- funkcja: ostatni numer wpisu ----
function getLastNumerWpisu(payload) {
  const wpisy = payload?.odpis?.naglowekP?.wpis || [];
  if (!Array.isArray(wpisy) || !wpisy.length) return null;
  return Math.max(...wpisy.map((w) => Number(w?.numerWpisu) || 0));
}

// ---- funkcja: NAZWA SPÓŁKI – tylko Dział I ----
function getCompanyName(payload) {
  // Spróbuj bezpośrednich pól
  const directPaths = [
    (d) => d?.odpis?.dane?.dzial1?.danePodmiotu?.nazwa,
    (d) => d?.odpis?.dane?.dzial1?.danePodmiotu?.firma,
    (d) => d?.odpis?.dane?.dzial1?.podstawoweDane?.nazwa,
    (d) => d?.odpis?.dane?.dzial1?.podstawoweDane?.firma,
    (d) => d?.odpis?.dane?.dzialI?.danePodmiotu?.nazwa,
    (d) => d?.odpis?.dane?.dzialI?.danePodmiotu?.firma,
  ];
  for (const g of directPaths) {
    const v = g(payload);
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  // Jeśli brak – przeszukaj tylko Dział I
  const dz1 = payload?.odpis?.dane?.dzial1 ?? payload?.odpis?.dane?.dzialI;
  if (!dz1 || typeof dz1 !== "object") return "";

  let bestWithNr = { nr: -Infinity, name: null };
  let bestFallback = "";
  const stack = [dz1];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const it of cur) stack.push(it);
      continue;
    }
    if (cur && typeof cur === "object") {
      const possible = cur.firma ?? cur.nazwa ?? cur.nazwaSkrocona;
      if (typeof possible === "string" && possible.trim()) {
        const nr = Number(cur.nrWpisuWprow ?? cur.nrWpisuaWprow);
        if (Number.isFinite(nr)) {
          if (nr >= bestWithNr.nr)
            bestWithNr = { nr, name: possible.trim() };
        } else {
          if (possible.trim().length > bestFallback.length)
            bestFallback = possible.trim();
        }
      }
      for (const k in cur) stack.push(cur[k]);
    }
  }
  if (bestWithNr.name) return bestWithNr.name;
  if (bestFallback) return bestFallback;
  return "";
}

// ---- funkcja: zbieranie działów zmian ----
function collectChangedByDzial(payload, last) {
  const dane = payload?.odpis?.dane;
  if (!dane || typeof dane !== "object") return [];

  const DZIAL_DESC = {
    dzial1: "Dział I – Dane podmiotu i kapitał",
    dzial2: "Dział II – Organy i reprezentacja",
    dzial3: "Dział III – PKD, sprawozdania, wzmianki",
    dzial4: "Dział IV – Postępowania, upadłości",
    dzial5: "Dział V – Połączenia, podziały, przekształcenia",
    dzial6: "Dział VI – Wzmianki różne",
    dzialI: "Dział I – Dane podmiotu i kapitał",
    dzialII: "Dział II – Organy i reprezentacja",
    dzialIII: "Dział III – PKD, sprawozdania, wzmianki",
    dzialIV: "Dział IV – Postępowania, upadłości",
    dzialV: "Dział V – Połączenia, podziały, przekształcenia",
    dzialVI: "Dział VI – Wzmianki różne",
  };

  const out = [];
  for (const key of Object.keys(dane)) {
    if (!/^dzial/i.test(key)) continue;
    const section = dane[key];
    const bucket = [];
    const stack = [{ node: section, path: key }];
    while (stack.length) {
      const { node, path } = stack.pop();
      if (Array.isArray(node)) {
        node.forEach((it, idx) =>
          stack.push({ node: it, path: `${path}[${idx}]` })
        );
        continue;
      }
      if (node && typeof node === "object") {
        const nr = node.nrWpisuWprow ?? node.nrWpisuaWprow;
        if (nr != null && String(nr) === String(last)) {
          bucket.push({ path, data: node });
        }
        for (const k in node)
          stack.push({ node: node[k], path: path + "." + k });
      }
    }
    if (bucket.length)
      out.push({ dzialKey: key, dzialName: DZIAL_DESC[key] || key, items: bucket });
  }
  return out;
}

// ---- funkcja: zmiana kapitału ----
function getKapitalInfo(payload, last) {
  const cands = [
    (d) => d?.odpis?.dane?.dzial1?.kapital?.wysokoscKapitaluZakladowego,
    (d) => d?.odpis?.dane?.kapital?.wysokoscKapitaluZakladowego,
    (d) => d?.odpis?.dane?.dzialI?.kapital?.wysokoscKapitaluZakladowego,
  ];
  let arr = null;
  for (const g of cands) {
    const a = g(payload);
    if (Array.isArray(a) && a.length) {
      arr = a;
      break;
    }
  }
  if (!arr) return null;
  const match = arr.find(
    (it) =>
      String(it?.nrWpisuWprow ?? it?.nrWpisuaWprow) === String(last)
  );
  if (!match) return null;
  const prev =
    arr
      .map((it) => ({
        nr: Number(it?.nrWpisuWprow ?? it?.nrWpisuaWprow),
        val: it?.wartosc,
      }))
      .filter((x) => Number.isFinite(x.nr) && x.nr < last)
      .sort((a, b) => b.nr - a.nr)[0] || null;
  return { nowa: match?.wartosc ?? null, poprzednia: prev?.val ?? null };
}

// ---- wysyłka maila ----
async function sendMail(config, subject, html) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  await transporter.sendMail({
    from: config.sender,
    to: config.recipients.join(", "),
    subject,
    html,
  });
}

// ---- main ----
async function main() {
  const config = loadConfig();
  const state = loadState();
  const results = [];

  for (const krs of config.krs) {
    try {
      const payload = await fetchOdpis(krs);
      const last = getLastNumerWpisu(payload);
      if (!last) continue;

      const prevLast = state[krs] || null;
      if (prevLast !== null && prevLast === last) {
        continue; // brak nowych zmian
      }

      const name = getCompanyName(payload);
      const kapital = getKapitalInfo(payload, last);
      const dzialy = collectChangedByDzial(payload, last);

      results.push({ krs, name, last, kapital, dzialy });

      state[krs] = last;
    } catch (e) {
      console.error("Błąd przy KRS", krs, e.message);
    }
  }

  if (!results.length) {
    console.log("[summary] Brak nowych wpisów – nie wysyłam e-maila.");
    return;
  }

  // Budowa maila
  let alert = results.some((r) => r.kapital);
  let subject = (alert ? "ALERT " : "") + "Zmiany w KRS – raport dzienny";
  let html = `<h1>Raport zmian w KRS</h1>`;

  for (const r of results) {
    html += `<h2>${r.name} (KRS ${r.krs})</h2>`;
    html += `<p>Ostatni wpis: ${r.last}</p>`;
    if (r.kapital) {
      html += `<p><strong>Kapitał zakładowy zmieniony:</strong> ${r.kapital.poprzednia} → ${r.kapital.nowa}</p>`;
    }
    html += `<ul>`;
    for (const d of r.dzialy) {
      html += `<li>${d.dzialName}</li>`;
    }
    html += `</ul>`;
    html += `<p><a href="https://sebhucz.github.io/krs-watcher/?krs=${r.krs}" target="_blank">Podgląd w panelu</a></p>`;
  }

  await sendMail(config, subject, html);
  saveState(state);
}

if (process.argv.includes("--force-send")) {
  main();
} else {
  const now = new Date();
  const hours = now.getUTCHours();
  if (hours === 12) {
    main();
  } else {
    console.log("[summary] Nie jest 14:00 Europe/Warsaw – pomijam wysyłkę.");
  }
}
