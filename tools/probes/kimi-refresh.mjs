import fs from "node:fs";
const s = JSON.parse(fs.readFileSync("kimi-capture/storage.json", "utf8"));
const tok = String(s.after.localStorage.access_token).replace(/^"|"$/g, "");
const html = await (await fetch("https://www.kimi.com/settings/get/webpro", { headers: { authorization: "Bearer " + tok } })).text();
const js = [...new Set(html.match(/https:\/\/statics\.moonshot\.cn\/kimi-web\/assets\/[A-Za-z0-9_\-.]+\.js/g) || [])];
const hits = new Map();
for (const u of js) {
  let c; try { c = await (await fetch(u)).text(); } catch { continue; }
  for (const m of c.matchAll(/["'`](\/apiv2?\/[A-Za-z0-9_.\/]*[Aa]uth[A-Za-z0-9_.\/]*)["'`]/g)) hits.set(m[1], u.split("/").pop());
  for (const m of c.matchAll(/([A-Za-z]*[Rr]efresh[A-Za-z]*)\s*[:=(]/g)) hits.set("name:" + m[1], u.split("/").pop());
}
console.log([...hits].filter(([k]) => !k.startsWith("name:") || /Token|token/.test(k)).map(([k, v]) => `${k}  ← ${v}`).join("\n").slice(0, 3000));
