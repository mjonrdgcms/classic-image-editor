// QA: run every filter (defaults) on test images and write raw outputs.
//   npx tsx scripts/filter-sheet.ts <rawDir> <outDir> [filterId...]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { FILTERS } from "../src/filters";
import { defaults, runFilter } from "../src/filters/types";

const [rawDir, outDir, ...only] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const names = ["portrait", "landscape", "group", "man"];
const imgs = names.map((n) => {
  const [w, h] = readFileSync(`${rawDir}/${n}.txt`, "utf8").split(" ").map(Number);
  return { n, w, h, data: new Uint8ClampedArray(readFileSync(`${rawDir}/${n}.rgba`)) };
});
const list: string[] = [];
for (const f of FILTERS) {
  if (only.length && !only.includes(f.id)) continue;
  for (const im of imgs.slice(0, Number(process.env.NIMG ?? (only.length ? 4 : 2)))) {
    const t0 = performance.now();
    let out;
    try {
      out = runFilter(f, { w: im.w, h: im.h, data: new Uint8ClampedArray(im.data) }, defaults(f), { fg: [0, 0, 0], bg: [255, 255, 255], scale: 1 });
    } catch (e) {
      console.error(f.id, (e as Error).message);
      continue;
    }
    const ms = performance.now() - t0;
    writeFileSync(`${outDir}/${f.id}__${im.n}.rgba`, Buffer.from(out.data.buffer, out.data.byteOffset, out.data.length));
    writeFileSync(`${outDir}/${f.id}__${im.n}.txt`, `${out.w} ${out.h} ${ms.toFixed(0)}`);
  }
  list.push(`${f.id}|${f.name}|${f.category}`);
}
writeFileSync(`${outDir}/list.txt`, list.join("\n"));
console.log(list.length, "filters");
