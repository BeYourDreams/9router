import { describe, it, expect, vi } from "vitest";
// Static import on purpose: a dynamic `import(variable)` here resolves through
// the filesystem root instead of the `open-sse` alias (it becomes
// '/open-sse/...') and the adapter can't be resolved at runtime.
import * as adapter from "../../open-sse/executors/xiaomimimo-web/adapter.js";
const PH = "HT/GkQGR+A6SObOmojivgg==";

/** Build a fake Playwright page whose in-page fetch yields `blocks` as SSE. */
function fakePage(blocks, { docCookie = `xiaomichatbot_ph=${PH}` } = {}) {
  let wire = "";
  for (const [ev, data] of blocks) {
    wire += `id:aaaa\nevent:${ev}\ndata:${JSON.stringify(data)}\n\n`;
  }
  // Deliver the wire in small slices, but only at line boundaries: a real SSE
  // response never splits a JSON payload mid-token the way a byte-level chunk
  // would, and slicing mid-JSON only exercises our own parser's error path.
  const slices = [];
  for (const line of wire.split("\n")) {
    const enc = new TextEncoder().encode(`${line}\n`);
    for (let i = 0; i < enc.length; i += 7) slices.push(enc.slice(i, i + 7));
  }
  let cursor = 0;
  const seen = [];

  // Browser globals must survive across evaluate() calls: the adapter stashes
  // the reader on window.__xmm in the start call and reads it on each pull.
  globalThis.window = { __xmm: {} };
  globalThis.document = { cookie: docCookie };

  return {
    seen,
    async goto() {},
    async waitForTimeout() {},
    async close() {},
    async evaluate(fn, arg) {
      const src = String(fn);
      if (src.includes("__xmm")) {
        globalThis.fetch = async (url) => {
          seen.push({ url });
          return {
            ok: true,
            status: 200,
            body: {
              getReader: () => ({
                async read() {
                  if (cursor >= slices.length) return { done: true, value: undefined };
                  return { done: false, value: slices[cursor++] };
                },
                cancel: async () => {},
              }),
            },
          };
        };
      }
      // eslint-disable-next-line no-eval
      return eval(`(${src})`)(arg, arg);
    },
  };
}

vi.mock("../../open-sse/services/browserPool.js", () => ({
  acquireBrowserContext: vi.fn(async () => ({})),
  openPage: vi.fn(async () => pageStub),
}));

let pageStub;

const loadAdapter = async () => adapter;
const CRED = { apiKey: `userId=24819372; xiaomichatbot_ph="${PH}"` };

function run(blocks, opts) {
  pageStub = fakePage(blocks, opts);
  return loadAdapter().then(({ executeXiaomiMiMoWebCleanRoom }) =>
    executeXiaomiMiMoWebCleanRoom({
      body: { model: "mimo-v2.6-flash", messages: [{ role: "user", content: "hi" }] },
      credentials: CRED,
    })
  );
}

describe("xiaomimimo-web adapter", () => {
  it("strips RFC-6265 quotes from pasted cookie values", async () => {
    const { xiaomiMiMoWebStorageStateFromCookieHeader } = await loadAdapter();
    const state = xiaomiMiMoWebStorageStateFromCookieHeader(
      `userId=24819372; xiaomichatbot_ph="${PH}"`
    );
    const byName = Object.fromEntries(state.cookies.map((c) => [c.name, c.value]));
    expect(byName.xiaomichatbot_ph).toBe(PH);
    expect(byName.userId).toBe("24819372");
    // httpOnly would hide the jar from document.cookie, which the _ph echo needs.
    expect(state.cookies.every((c) => c.httpOnly === false)).toBe(true);
  });

  it("mirrors the _ph cookie into the chat query string", async () => {
    const res = await run([["finish", { content: "[DONE]" }]]);
    expect(res.status).toBe(200);
    await res.text();
    expect(pageStub.seen[0].url).toContain("/open-apis/react/chat?xiaomichatbot_ph=");
  });

  it("maps message/usage/finish SSE events to OpenAI chunks", async () => {
    const text = await (
      await run([
        ["dialogId", { content: "32575791" }],
        ["message", { messageType: "assistant", reasoningContent: "because" }],
        ["message", { messageType: "assistant", content: "2" }],
        ["usage", { promptTokens: 8, completionTokens: 3, totalTokens: 11 }],
        ["finish", { content: "[DONE]" }],
      ])
    ).text();
    const chunks = text
      .split("\n\n")
      .filter(Boolean)
      .map((l) => l.replace(/^data: /, ""))
      .filter((l) => l !== "[DONE]")
      .map((l) => JSON.parse(l));

    expect(chunks.map((c) => c.choices[0].delta)).toEqual([
      { reasoning_content: "because" },
      { content: "2" },
      {},
    ]);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    expect(chunks.at(-1).usage).toEqual({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 });
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
  });

  it("terminates the stream when upstream never sends finish", async () => {
    const text = await (
      await run([["message", { messageType: "assistant", content: "hi" }]])
    ).text();
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("[DONE]");
  });

  it("reassembles UTF-8 content split across chunk boundaries", async () => {
    const text = await (
      await run([
        ["message", { messageType: "assistant", content: "首都北京" }],
        ["finish", { content: "[DONE]" }],
      ])
    ).text();
    expect(text).toContain("首都北京"); // not mojibake
  });

  it("throws a clear error when the _ph cookie is absent from the jar", async () => {
    await expect(run([["finish", { content: "[DONE]" }]], { docCookie: "" })).rejects.toThrow(
      /xiaomichatbot_ph/
    );
  });
});
