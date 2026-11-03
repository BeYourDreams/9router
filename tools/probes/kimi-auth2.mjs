import fs from "node:fs";
const html = await (await fetch("https://www.kimi.com/chat")).text();
const js = [...new Set(html.match(/https:\/\/statics\.moonshot\.cn\/kimi-web\/assets\/[A-Za-z0-9_\-.]+\.js/g) || [])];
for (const u of js) {
  let c; try { c = await (await fetch(u)).text(); } catch { continue; }
  if (!c.includes("refreshAccessToken") && !c.includes("refresh_token")) continue;
  const i = c.search(/refreshAccessToken\s*[:=]/);
  const at = c.indexOf("/apiv2/");
  console.log("==", u.split("/").pop(), "len", c.length, "authApiAt", at);
  if (i > 0) console.log("   refreshAccessToken ctx:", c.slice(Math.max(0, i - 2500), i + 300).replace(/\s+/g, " ").slice(-2600));
  break;
}
