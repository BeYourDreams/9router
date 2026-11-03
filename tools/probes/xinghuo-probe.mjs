// Verify create → chat end to end (cookie-only, no geetest token).
import fs from "node:fs";

const ss = JSON.parse(fs.readFileSync("xinghuo-capture/storage-state.json", "utf8"));
const cookie = ss.cookies.filter((c) => /xfyun\.cn/.test(c.domain)).map((c) => `${c.name}=${c.value}`).join("; ");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const H = {
  cookie,
  "user-agent": UA,
  origin: "https://xinghuo.xfyun.cn",
  referer: "https://xinghuo.xfyun.cn/desk",
  clienttype: "1",
  "lang-code": "zh",
};

const created = await fetch("https://xinghuo.xfyun.cn/iflygpt/u/chat-list/v1/create-chat-list", {
  method: "POST",
  headers: { ...H, "content-type": "application/json" },
  body: JSON.stringify({ chatSource: 1 }),
});
const json = await created.json();
const chatId = json?.data?.id;
console.log("create:", created.status, "chatId:", chatId);

const boundary = "----PiProbe";
const fields = {
  fd: "928244",
  isBot: "0",
  capabilities: "ifly_search",
  clientType: "1",
  text: "只回答一个字：好",
  chatId: String(chatId),
  firstChat: "true",
  options: '{"chatOption":{"thinkPattern":"auto","routeVersion":"v2"}}',
};
const body =
  Object.entries(fields)
    .map(([n, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`)
    .join("") + `--${boundary}--\r\n`;

const res = await fetch("https://xinghuo.xfyun.cn/iflygpt-chat/u/chat_message/chat", {
  method: "POST",
  headers: { ...H, accept: "text/event-stream", botweb: "0", "content-type": `multipart/form-data; boundary=${boundary}` },
  body,
});
const text = await res.text();
console.log("chat HTTP:", res.status, res.headers.get("content-type"), "bytes:", text.length);
// One frame per blank-line-separated block; print event name + a content peek.
const blocks = text.split(/\r?\n\r?\n+/).filter(Boolean);
for (const b of blocks.slice(0, 3)) console.log("  FRAME:", b.replace(/\r?\n/g, " | ").slice(0, 160));
const msgs = blocks
  .filter((b) => /event:\s*message/.test(b))
  .map((b) => {
    const data = (b.match(/data:(.+)/) || [])[1];
    try { return JSON.parse(data).content || ""; } catch { return ""; }
  })
  .join("");
console.log("ANSWER:", JSON.stringify(msgs), "| stop seen:", /finishReason.{0,3}stop/.test(text));
