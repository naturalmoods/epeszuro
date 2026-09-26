// Mérés a kézzel címkézett mintán: TYPESAFE_API_KEY=ts_... node test/jev.mjs [fixture]
// A nyers Jev-válaszokat a test/out/-ba menti; kulcs nélkül azokat értékeli újra (a küszöbök hangolásához nem kell új hívás).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { judge, action, USD_PER_MTOK, PROMPT_VERSION } from "../src/judge.js";

const fx = process.argv[2] || new URL("fixtures/yt-1.json", import.meta.url).pathname;
const { video, comments } = JSON.parse(readFileSync(fx, "utf8"));
const useContext = process.argv.includes("--context") && video.type === "live chat";
const out = new URL(`out/${fx.split("/").pop().replace(".json", "")}.${PROMPT_VERSION}${useContext ? ".ctx" : ""}.json`, import.meta.url).pathname;
const apiKey = process.env.TYPESAFE_API_KEY;

// a nevekcserélt párok külön kommentként mennek, "<id>s" azonosítóval
const items = [...comments.map((c, i) => useContext ? { ...c, context: comments.slice(Math.max(0, i - 5), i).map((prev) => prev.text) } : c), ...comments.filter((c) => c.swap).map((c) => ({ id: `${c.id}s`, text: c.swap }))];

let results, tokens = 0, ms = 0;
if (apiKey) {
  const t0 = performance.now();
  const batches = [];
  for (let i = 0; i < items.length; i += 10) batches.push(items.slice(i, i + 10)); // 10 komment = 60 kérdés hívásonként
  const res = await Promise.all(batches.map((b) => judge(b, video, { apiKey, model: process.env.TYPESAFE_MODEL })));
  ms = Math.round(performance.now() - t0);
  results = res.flatMap((r) => r.results);
  tokens = res.reduce((s, r) => s + (r.tokens || 0), 0);
  mkdirSync(new URL("out/", import.meta.url), { recursive: true });
  writeFileSync(out, JSON.stringify({ results, tokens, ms }, null, 1));
} else if (existsSync(out)) {
  ({ results, tokens, ms } = JSON.parse(readFileSync(out, "utf8")));
  console.log(`(kulcs nélkül: mentett válaszok, ${out})`);
} else throw new Error("Add meg: TYPESAFE_API_KEY=ts_... node test/jev.mjs");

const byId = Object.fromEntries(results.map((r) => [String(r.id), r]));
const RANK = { null: 0, mark: 1, blur: 2, shred: 3 };
const f2 = (x) => x.toFixed(2);
let exact = 0, falsePos = 0, missed = 0, shredMissed = 0;
// az expect lehet lista is (határeset: bármelyik elfogadható); a legközelebbihez mérünk
const nearest = (exp, got) => [].concat(exp).reduce((b, e) => (Math.abs(RANK[got] - RANK[e]) < Math.abs(RANK[got] - RANK[b]) ? e : b));

console.log("\n id  várt   kapott  erősz dehum csop  trág  gúnyn támad  szöveg");
for (const c of comments) {
  const r = byId[String(c.id)], got = action(r), exp = nearest(c.expect, got);
  const d = RANK[got] - RANK[exp];
  if (d === 0) exact++;
  if (d >= 2 || (d > 0 && RANK[got] >= 2)) falsePos++; // indokolatlan homályosítás / megsemmisítés
  if (exp === "shred" && got !== "shred") shredMissed++;
  if (d <= -2 || (exp === "shred" && got !== "shred")) missed++;
  const mark = d === 0 ? " " : d > 0 ? "▲" : "▼";
  const vals = r.error ? r.error : [r.threat, r.dehum, r.group, r.vulgar, r.nick, r.attack].map(f2).join("  ");
  console.log(`${mark}${String(c.id).padStart(2)}  ${[].concat(c.expect).map(String).join("|").padEnd(6)} ${String(got).padEnd(6)}  ${vals}  ${c.text.replace(/\s+/g, " ").slice(0, 60)}`);
}

console.log("\nPártsemlegesség (eredeti → nevekcserélt):");
let maxDiff = 0, flips = 0;
for (const c of comments.filter((c) => c.swap)) {
  const a = byId[String(c.id)], b = byId[`${c.id}s`];
  const diff = Math.max(...["threat", "dehum", "group", "vulgar", "nick"].map((k) => Math.abs(a[k] - b[k])), Math.abs(a.attack - b.attack) / 3);
  maxDiff = Math.max(maxDiff, diff);
  if (action(a) !== action(b)) flips++;
  console.log(`  #${c.id}  támad ${f2(a.attack)} → ${f2(b.attack)}  trág ${f2(a.vulgar)} → ${f2(b.vulgar)}  döntés ${action(a)} → ${action(b)}  max eltérés ${f2(diff)}`);
}

const usd = (tokens * USD_PER_MTOK) / 1e6;
console.log(`\nPontos egyezés: ${exact}/${comments.length} · indokolatlan elrejtés: ${falsePos} · kihagyott súlyos: ${missed} · max pártkülönbség: ${f2(maxDiff)} (döntésváltás: ${flips})`);
console.log(`${items.length} komment · ${ms} ms · ${tokens} token · ${usd.toPrecision(3)} USD ≈ ${(usd * 320).toPrecision(2)} Ft`);

if (shredMissed) console.log(`✗ ${shredMissed} megsemmisítendő komment (erőszak, dehumanizálás, gyűlölet) átcsúszott`);
if (falsePos) console.log(`✗ ${falsePos} komment indokolatlanul el lett rejtve`);
if (flips) console.log("✗ a nevek cseréje megváltoztatja a döntést");
if (maxDiff > 0.3) console.log(`! egy nyers érték ${f2(maxDiff)}-t változik a nevek cseréjétől (a döntés nem)`);
process.exitCode = !shredMissed && !flips && falsePos === 0 ? 0 : 1;
console.log(process.exitCode ? "ELTÉRÉS" : "OK");
