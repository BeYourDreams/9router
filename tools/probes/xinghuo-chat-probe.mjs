// One single chat turn, no GtToken — is the geetest token required on a normal
// (un-challenged) session? Exactly one request to avoid tripping their limiter.
import fs from "node:fs";

const ss = JSON.parse(fs.readFileSync("xinghuo-capture/storage-state.json", "utf8"));
const cookie = ss.cookies.filter((c) => /xfyun\.cn/.test(c.domain)).map((c) => `${c.name}=${c.value}`).join("; ");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

const boundary = "----PiProbe" + Math.random().toString(36).slice(2);
const parts = [
  ["fd", "928244"],
  ["isBot", "0"],
  ["capabilities", "ifly_search"],
  ["clientType", "1"],
  ["text", "回答：好"],
  ["chatId", "1176429743"],
  ["firstChat", "false"],
  ["options", JSON.stringify({ chatOption: { thinkPattern: "auto", routeVersion: "v2" } })],
];
const body = parts.map(([n, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`).join("") + `--${boundary}--\r\n`;

const res = await fetch("https://xinghuo.xfyun.cn/iflygpt-chat/u/chat_message/chat", {
  method: "POST",
  headers: {
    cookie,
    "user-agent": UA,
    origin: "https://xinghuo.xfyun.cn",
    referer: "https://xinghuo.xfyun.cn/desk?chatId=1176429743",
    accept: "text/event-stream",
    clienttype: "1",
    "lang-code": "zh",
    botweb: "0",
    "content-type": `multipart/form-data; boundary=${boundary}`,
  },
  body,
});
console.log("HTTP", res.status, res.headers.get("content-type"));
const text = await res.text();
console.log(text.slice(0, 1200));
