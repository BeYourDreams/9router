# Provider probes

One-off reverse-engineering scripts used while adding the `webCookie` providers
(`kimi-web`, `xinghuo-web`, `yuanbao-web`, `doubao-web`, `yiyan-web`, `ling-web`).
They are **not** part of CI, `npm test`, or the runtime — kept as evidence for how
each upstream endpoint was found and which headers are actually required.

## Prerequisites

Every probe reads a capture directory produced by the generic capture tool:

```sh
node tools/web-capture.mjs https://www.kimi.com/chat --out kimi-capture --wait 240
node tools/web-capture.mjs https://xinghuo.xfyun.cn/desk --out xinghuo-capture
node tools/web-capture.mjs https://yuanbao.tencent.com/chat --out yuanbao-capture
```

Run from the repo root — the paths are relative to `cwd`:

| Probe              | Reads                                                                          |
| ------------------ | ------------------------------------------------------------------------------ |
| `kimi-*.mjs`       | `kimi-capture/storage.json`, `kimi-capture/all-requests.json`                  |
| `xinghuo-*.mjs`    | `xinghuo-capture/storage-state.json`                                           |
| `yuanbao-*.mjs`    | `yuanbao-capture/storage-state.json`, `yuanbao-capture/all-requests.json`      |

The capture dirs are gitignored (`*-capture/`) because they contain live session
cookies and tokens. No probe hardcodes a credential — each one loads it from the capture.

## What each probe answers

**Kimi (`www.kimi.com`, Connect/gRPC-JSON uplink)**

- `kimi-auth.mjs` / `kimi-auth2.mjs` / `kimi-auth3.mjs` — crawl the published
  `statics.moonshot.cn/kimi-web` bundles for `token|refresh|login|auth` route paths.
- `kimi-refresh.mjs` — locate the refresh endpoint and the name of the refresh field.
- `kimi-models.mjs` / `kimi-models2.mjs` — brute-force which `options.model` ids are
  accepted (`k28`, `k28-instant`, `k3-thinking`, …) with and without `thinking`.
- `kimi-probe.mjs` — replay one chat turn with the full captured header set.
- `kimi-min.mjs` — same turn with the headers bisected down, to find the minimal set
  (`x-msh-device-id` / `x-msh-session-id` are the ones that matter).

Kimi's uplink is `POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat` with
`content-type: application/connect+json`, and each message is framed by a 5-byte
prefix (1 flag byte + 4-byte big-endian length) — that is what the
`Buffer.alloc(5 + len)` block builds.

**Xinghuo (`xinghuo.xfyun.cn`)**

- `xinghuo-probe.mjs` — full flow: create a chat list, then send one message.
- `xinghuo-chat-probe.mjs` — a single turn on an existing `chatId`, deliberately
  without the Geetest `GtToken`, to prove the captcha is only issued on challenge.

**Yuanbao (`yuanbao.tencent.com`)**

- `yuanbao-probe.mjs` — replay the captured conversation-create + message-send.
- `yuanbao-header-bisect.mjs` — group-bisect the captured headers to find which are
  required (grouping keeps the number of real turns low).

## Caveats

- Each run costs a real chat turn on a real account, and yuanbao/xinghuo rate-limit
  or captcha aggressively. Run one at a time, never in a loop.
- Bundles and endpoints drift: expect these to need re-deriving after a provider
  release. When they fail, start again from `tools/web-capture.mjs`.
- They print raw upstream responses, which can include account identifiers — don't
  paste that output into issues or logs.
