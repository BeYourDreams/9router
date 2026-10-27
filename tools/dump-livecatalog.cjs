// Print the compiled ModelSelectModal region around the live-catalog constant so the
// patch script can anchor on exact minified text.
const fs = require("fs");
const f = process.argv[2];
const s = fs.readFileSync(f, "utf8");
const i = s.indexOf('"cursor","cline","clinepass","zed"');
console.log("--- const region ---");
console.log(JSON.stringify(s.slice(i - 60, i + 40)));
// hook calls
for (const m of s.matchAll(/=\s*[A-Za-z$_][\w$]*\((\w+),(\w+|"[^"]*")\)/g)) {
  const seg = s.slice(m.index, m.index + 60);
  if (/Cline|Cursor|Zed/.test(seg)) console.log("HOOK", JSON.stringify(seg));
}
// the live-model ternary in the grouping memo
for (const lit of ['"cursor"==', '==="cursor"']) {
  let idx = -1;
  while ((idx = s.indexOf(lit, idx + 1)) > 0) {
    const seg = s.slice(idx - 40, idx + 320);
    if (/Models|\.length/.test(seg)) { console.log("TERNARY @" + idx, JSON.stringify(seg)); break; }
  }
}