// test.mjs – prosty self-test dla getCompanyName

import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

// Załaduj naszą funkcję z krsWatcher.mjs
import { getCompanyName } from "./src/krsWatcher.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Wskażemy plik JSON (ten, który testujesz)
const TEST_FILE = path.join(__dirname, "Odpis_Pełny_KRS_0000028098.json");

// 1) Wczytaj JSON
const data = JSON.parse(fs.readFileSync(TEST_FILE, "utf8"));

// 2) Wywołaj funkcję
const name = getCompanyName(data);

// 3) Sprawdź, czy wynik zgadza się z oczekiwaniem
const expected = "INC SPÓŁKA AKCYJNA";

if (name !== expected) {
  throw new Error(`❌ Błąd: spodziewałem się "${expected}", a dostałem "${name}"`);
}

console.log("✅ Test przeszedł pomyślnie – nazwa spółki odczytana poprawnie!");
