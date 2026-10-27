// Dump the exact minified JSX prop list of every multi-select picker call site in the
// installed bundle, so the patch script can anchor on exact strings.
const fs = require("fs");
const path = require("path");
const ROOT = process.argv[2] || "D:/resp/npm/npm-global/node_modules/9router/app/.next-cli-build";
const only = process.argv[3] || ""; // substring filter, e.g. "static"
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
};
for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f).split(path.sep).join("/");
  if (only && !rel.includes(only)) continue;
  const s = fs.readFileSync(f, "utf8");
  for (const m of s.matchAll(/closeOnSelect:!1/g)) {
    const start = s.lastIndexOf(",{isOpen:", m.index);
    console.log("=== " + rel + " @" + m.index);
    console.log(JSON.stringify(s.slice(start, m.index + 18)));
    console.log("");
  }
}