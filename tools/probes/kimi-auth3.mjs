const html = await (await fetch("https://www.kimi.com/chat")).text();
const js = [...new Set(html.match(/https:\/\/statics\.moonshot\.cn\/kimi-web\/assets\/[A-Za-z0-9_\-.]+\.js/g) || [])];
const found = [];
await Promise.all(js.map(async (u) => {
  let c; try { c = await (await fetch(u)).text(); } catch { return; }
  if (!/refresh_token|RefreshToken/.test(c)) return;
  // Any quoted path or URL near a refresh mention
  for (const m of c.matchAll(/[`"']([^`"'\s]{6,90}(?:refresh|Refresh|token|Token)[^`"'\s]{0,60})[`"']/g)) found.push([u.split("/").pop(), m[1]]);
}));
const uniq = [...new Map(found.map((x) => [x[1], x])).values()];
uniq.filter(([, p]) => /\/|https?:/.test(p)).slice(0, 40).forEach(([f, p]) => console.log(p, " ←", f));
