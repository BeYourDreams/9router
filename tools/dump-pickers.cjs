// Dump the FULL minified prop list of every multi-select picker call site so the patch
// script can anchor on exact strings (identifiers differ between server/static builds).
const fs = require("fs");
const path = require("path");
const ROOT = process.argv[2] || "D:/resp/npm/npm-global/node_modules/9router/app/.next-cli-build";
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
};
const out = [];
for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f).split(path.sep).join("/");
  const s = fs.readFileSync(f, "utf8");
  for (const m of s.matchAll(/closeOnSelect:\s*!1/g)) {
    const start = s.lastIndexOf(",{isOpen:", m.index);
    out.push({ file: rel, index: m.index, props: s.slice(start + 1, m.index + 20) });
  }
}
console.log(JSON.stringify(out, null, 1));