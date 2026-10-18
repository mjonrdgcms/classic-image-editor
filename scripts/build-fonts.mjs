// Copies the bundled font library into public/fonts and writes src/text/fontcatalog.json.
//   npm install --no-save $(node scripts/build-fonts.mjs --packages)
//   node scripts/build-fonts.mjs [node_modules dir]
// Fonts come from Fontsource (Google Fonts, SIL Open Font License / Apache 2.0).
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const list = readFileSync(join(root, "scripts/fonts.txt"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const [category, id, family] = l.split("|");
    return { category, id, family };
  });
if (process.argv[2] === "--packages") {
  console.log(list.map((f) => `@fontsource/${f.id}`).join(" "));
  process.exit(0);
}
const nm = process.argv[2] ?? join(root, "node_modules");
const out = join(root, "public/fonts");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "licenses"), { recursive: true });

const WANT = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const ITALIC = new Set([300, 400, 700]);
const SUBSETS = ["latin", "latin-ext"];
const catalog = [];
let bytes = 0;
for (const f of list) {
  const dir = join(nm, "@fontsource", f.id);
  const meta = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
  const ranges = JSON.parse(readFileSync(join(dir, "unicode.json"), "utf8"));
  const faces = [];
  const weights = meta.weights.filter((w) => WANT.includes(w));
  for (const w of weights)
    for (const style of meta.styles) {
      if (style === "italic" && !ITALIC.has(w)) continue;
      for (const sub of SUBSETS) {
        if (!meta.subsets.includes(sub)) continue;
        const name = `${f.id}-${sub}-${w}-${style}.woff2`;
        const src = join(dir, "files", name);
        if (!existsSync(src)) continue;
        mkdirSync(join(out, f.id), { recursive: true });
        copyFileSync(src, join(out, f.id, name));
        bytes += readFileSync(src).length;
        faces.push({ w, s: style === "italic" ? 1 : 0, sub: sub === "latin" ? 0 : 1, file: `${f.id}/${name}` });
      }
    }
  copyFileSync(join(dir, "LICENSE"), join(out, "licenses", `${f.id}.txt`));
  catalog.push({ id: f.id, family: f.family, category: f.category, license: meta.license.type, faces });
}
const unicode = { 0: JSON.parse(readFileSync(join(nm, "@fontsource", "inter", "unicode.json"), "utf8"))["latin"], 1: JSON.parse(readFileSync(join(nm, "@fontsource", "inter", "unicode.json"), "utf8"))["latin-ext"] };
mkdirSync(join(root, "src/text"), { recursive: true });
writeFileSync(join(root, "src/text/fontcatalog.json"), JSON.stringify({ unicode, families: catalog }));
console.log(`${catalog.length} families, ${catalog.reduce((n, c) => n + c.faces.length, 0)} files, ${(bytes / 1048576).toFixed(1)} MB`);
