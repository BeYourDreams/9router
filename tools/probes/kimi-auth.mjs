import fs from "node:fs";
const html = await (await fetch("https://www.kimi.com/chat")).text();
const js = [...new Set(html.match(/https:\/\/statics\.moonshot\.cn\/kimi-web\/assets\/[A-Za-z0-9_\-.]+\.js/g) || [])];
const hits = new Set();
for (const u of js) {
  let c; try { c = await (await fetch(u)).text(); } catch { continue; }
  for (const m of c.matchAll(/["'`](\/[A-Za-z0-9_.\/-]*(?:[Tt]oken|[Rr]efresh|[Ll]ogin|[Aa]uth)[A-Za-z0-9_.\/-]*)["'`]/g)) hits.add(m[1]);
}
console.log([...hits].sort().join("\n"));
