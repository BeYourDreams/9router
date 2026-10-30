import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// proxyAwareFetch captures globalThis.fetch at import time, so stubbing the
// global afterwards would leave the real network in the path. Mock the module.
const fetchMock = vi.hoisted(() => ({ fn: null }));
vi.mock("open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: (url, options) => fetchMock.fn(url, options) };
});

const { getExecutor } = await import("open-sse/executors/index.js");
const { DefaultExecutor } = await import("open-sse/executors/default.js");
const { resetUpstreamConversations } = await import("open-sse/shared/conversationId.js");

const JWT =
  "eyJ0eXBlIjoiSldUIiwiYWxnIjoiSFM1MTIifQ.eyJqdGkiOiIxMjM5MDA2NjUiLCJyb2wiOiJST0xFX1JFR0lTVEVSIiwiaXNzIjoiT3BlblhMYWIiLCJpYXQiOjE3OTMyNjE2MzcsInBob25lIjoiMTc2ODU2OTk1NjgiLCJlbWFpbCI6IiIsImV4cCI6MTc5NDQ3MTIzN30.AG7RCqN1heBHiOXkbqqxPpBmOZvB1B18RQuaFO4YL7r5KnKOHjc2yLPdZjMtOonH165eIK0Ifb1nXLDqQUHsNA";

const API_ORIGIN = "https://discovery.intern-ai.org.cn";
const API_BASE = `${API_ORIGIN}/api/orbit/v1`;
const CHAT_URL = `${API_BASE}/chat`;
const NEW_CHAT_URL = `${API_BASE}/chat/new`;
const MODELS_URL = `${API_BASE}/models`;

// Upstream frames, verbatim from the capture (mojibake is the capture's fault,
// not the executor's — it must pass bytes through untouched).
const STREAM_FRAMES = [
  '{"event":"workflow_started","cid":1644687,"mid":1901323}',
  '{"cid":1644687,"event":"message","mid":1901323,"thinking":"思考"}',
  '{"cid":1644687,"event":"message","mid":1901323,"answer":"你好"}',
  '{"cid":1644687,"event":"message","mid":1901323,"answer":"！"}',
].map((j) => `data: ${j}\n\n`).join("");

// ---------- fake network ----------
let fetchCalls;
let nextResponses;

function stubResponse({ status = 200, body = "", ok = true } = {}) {
  const chunks = body ? [new TextEncoder().encode(body)] : [];
  let i = 0;
  return {
    ok: ok && status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
      }),
    },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** Walk a fetch mock in queue order, or route by URL. */
function makeFetchMock() {
  return vi.fn(async (url, options = {}) => {
    const target = String(url);
    fetchCalls.push({ url: target, options });
    if (nextResponses.length) {
      const next = nextResponses.shift();
      if (typeof next === "function") return next(target, options);
      return next;
    }
    if (target === NEW_CHAT_URL) return stubResponse({ body: JSON.stringify({ code: 0, data: { id: 1644687 } }) });
    if (target === CHAT_URL) return stubResponse({ body: STREAM_FRAMES });
    if (target === MODELS_URL) {
      return stubResponse({ body: JSON.stringify({ code: 0, data: { models: [{ name: "Default" }, { name: "书生-A1.5" }] } }) });
    }
    return stubResponse({ status: 404, ok: false, body: "" });
  });
}

// Resolve the executor's private helpers through the public surface:
// we re-derive the token the same way the executor does, by asking it to fire
// a request and inspecting the Authorization header it produced.
async function authHeaderFor(credentialInput) {
  fetchCalls = [];
  nextResponses = [];
  const exec = getExecutor("intern-web");
  await exec.execute({
    model: "Auto",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: { apiKey: credentialInput },
  });
  const chatCall = fetchCalls.find((c) => c.url === CHAT_URL);
  return {
    auth: chatCall?.options?.headers?.Authorization,
    referer: chatCall?.options?.headers?.Referer,
    origin: chatCall?.options?.headers?.Origin,
    calls: fetchCalls,
  };
}

// Upstream mints chat_ids and conversationId.js remembers them per conversation.
// Tests share process memory, so each one starts from a clean slate — otherwise a
// conversation opened by an earlier test leaks into the next one.
beforeEach(() => {
  fetchCalls = [];
  nextResponses = [];
  fetchMock.fn = makeFetchMock();
  resetUpstreamConversations();
});
afterEach(() => {
  nextResponses = [];
  fetchCalls = [];
});

describe("intern-web executor wiring", () => {
  it("has a dedicated executor (not the DefaultExecutor 401 fallback)", () => {
    const exec = getExecutor("intern-web");
    expect(exec).toBeDefined();
    expect(exec.constructor.name).toBe("InternWebExecutor");
    expect(exec).not.toBeInstanceOf(DefaultExecutor);
  });
});

describe("intern-web credential normalization", () => {
  const inputs = [
    ["bare JWT", JWT],
    ["uaa-token=<jwt>", `uaa-token=${JWT}`],
    ["Bearer <jwt>", `Bearer ${JWT}`],
    ["Cookie: uaa-token=<jwt>", `Cookie: uaa-token=${JWT}`],
    ["full DevTools blob", `sensorsdata2015jssdkchannel=%7B%7D; uaa-token=${JWT}; ssouid=123900665`],
    ["cookie-editor JSON array", JSON.stringify([{ name: "uaa-token", value: JWT, domain: ".intern-ai.org.cn" }])],
  ];

  for (const [label, input] of inputs) {
    it(`sends a bare JWT for ${label}`, async () => {
      const { auth } = await authHeaderFor(input);
      // The regression: DefaultExecutor sent "Bearer uaa-token=<jwt>".
      expect(auth).toBe(`Bearer ${JWT}`);
      expect(auth).not.toContain("uaa-token=");
    });
  }
});

describe("intern-web request shape", () => {
  it("posts to /api/orbit/v1/chat (not the site root)", async () => {
    await authHeaderFor(JWT);
    const chatCall = fetchCalls.find((c) => c.url === CHAT_URL);
    expect(chatCall).toBeTruthy();
    expect(chatCall.url).toBe(`${API_ORIGIN}/api/orbit/v1/chat`);
    expect(chatCall.url).not.toBe(API_ORIGIN);
    expect(chatCall.url).not.toBe(`${API_ORIGIN}/`);
  });

  it("sends Referer + Origin (missing ones caused 401 请求未认证)", async () => {
    const { referer, origin } = await authHeaderFor(JWT);
    expect(referer).toMatch(/^https:\/\/discovery\.intern-ai\.org\.cn\/chat\/chat\/\d+$/);
    expect(origin).toBe(API_ORIGIN);
  });

  it("sends the upstream body shape, not OpenAI {model,messages}", async () => {
    await authHeaderFor(JWT);
    const chatCall = fetchCalls.find((c) => c.url === CHAT_URL);
    const payload = JSON.parse(chatCall.options.body);
    expect(payload).toMatchObject({
      scenario: 1,
      thinking_mode: true,
      planning_mode: false,
      model: "Default", // "Auto" maps to upstream "Default"
      chat_id: 1644687,
    });
    expect(payload.query).toBe("hi");
    expect(payload.messages).toBeUndefined();
  });

  it("opens a conversation via /chat/new when no chat_id is known", async () => {
    await authHeaderFor(JWT);
    const newCall = fetchCalls.find((c) => c.url === NEW_CHAT_URL);
    expect(newCall).toBeTruthy();
    expect(JSON.parse(newCall.options.body)).toEqual({ scenario: 1 });
    // /chat/new must come before the chat call.
    expect(fetchCalls.findIndex((c) => c.url === NEW_CHAT_URL))
      .toBeLessThan(fetchCalls.findIndex((c) => c.url === CHAT_URL));
  });

  it("reuses a stored chat_id instead of minting a new conversation", async () => {
    const exec = getExecutor("intern-web");
    await exec.execute({
      model: "Auto",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: JWT, providerSpecificData: { internChatId: 999111 } },
    });
    expect(fetchCalls.some((c) => c.url === NEW_CHAT_URL)).toBe(false);
    const payload = JSON.parse(fetchCalls.find((c) => c.url === CHAT_URL).options.body);
    expect(payload.chat_id).toBe(999111);
  });
});

describe("intern-web 401 handling", () => {
  it("reports 401 with a re-login hint when upstream rejects the token", async () => {
    nextResponses = [stubResponse({ status: 401, ok: false, body: '{"code":-10002,"msg":"参数错误，请求未认证"}' })];
    const exec = getExecutor("intern-web");
    const result = await exec.execute({
      model: "Auto",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: JWT },
    });
    expect(result.response.status).toBe(401);
    const json = await result.response.json();
    expect(json.error.message).toMatch(/uaa-token is invalid or expired/);
  });

  it("surfaces 401 from /chat/new as-is", async () => {
    nextResponses = [stubResponse({ status: 401, ok: false, body: '{"traceId":"e5f199dde72f","msgCode":"A0202","msg":"user authenticate failed","data":null,"success":false,"total":0}' })];
    const exec = getExecutor("intern-web");
    const result = await exec.execute({
      model: "Auto",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: JWT },
    });
    expect(result.url).toBe(NEW_CHAT_URL);
    expect(result.response.status).toBe(401);
  });

  it("fails fast with 401 on a missing credential", async () => {
    const exec = getExecutor("intern-web");
    const result = await exec.execute({
      model: "Auto",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "" },
    });
    expect(result.response.status).toBe(401);
    const json = await result.response.json();
    expect(json.error.code).toBe("MISSING_CREDENTIAL");
    // No network traffic at all when the token is absent.
    expect(fetchCalls.length).toBe(0);
  });
});

describe("intern-web response translation", () => {
  it("streams OpenAI chat.completion.chunk frames with reasoning + content", async () => {
    const exec = getExecutor("intern-web");
    const result = await exec.execute({
      model: "Auto",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: JWT },
    });
    expect(result.response.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await result.response.text();
    expect(text).toContain('"delta":{"role":"assistant","content":""}');
    expect(text).toContain('"reasoning_content":"思考"');
    expect(text).toContain('"content":"你好"');
    expect(text).toContain('"content":"！"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // workflow_started carries no answer/thinking — must not emit a chunk.
    expect(text).not.toContain("workflow_started");
  });

  it("returns a single chat.completion for non-streaming", async () => {
    const exec = getExecutor("intern-web");
    const result = await exec.execute({
      model: "Auto",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: JWT },
    });
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("你好！");
    expect(json.choices[0].message.reasoning_content).toBe("思考");
    expect(json.choices[0].finish_reason).toBe("stop");
  });
});

describe("intern-web model mapping", () => {
  it("maps the UI 'Auto' alias to upstream 'Default'", async () => {
    await authHeaderFor(JWT);
    const payload = JSON.parse(fetchCalls.find((c) => c.url === CHAT_URL).options.body);
    expect(payload.model).toBe("Default");
  });

  it("passes real upstream model names through unchanged", async () => {
    const exec = getExecutor("intern-web");
    await exec.execute({
      model: "书生-A1.5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: JWT },
    });
    const payload = JSON.parse(fetchCalls.find((c) => c.url === CHAT_URL).options.body);
    expect(payload.model).toBe("书生-A1.5");
  });
});

describe("intern-web conversation continuity", () => {
  // Upstream keys its prompt cache AND its history on chat_id. Every turn must
  // reuse one id for a conversation — same bug class as CodeBuddy's
  // X-Conversation-ID (see commit c47ef6c2): a fresh id per turn is a silent
  // cold cache on every single request.
  const turn = (creds = { apiKey: JWT }) => {
    const exec = getExecutor("intern-web");
    return exec.execute({
      model: "Auto",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: creds,
    });
  };

  it("mints one chat_id per conversation, then keeps using it", async () => {
    await turn();
    await turn();
    await turn();

    const newCalls = fetchCalls.filter((c) => c.url === NEW_CHAT_URL);
    const ids = fetchCalls.filter((c) => c.url === CHAT_URL).map((c) => JSON.parse(c.options.body).chat_id);
    expect(newCalls.length).toBe(1);                      // /chat/new ran once
    expect(new Set(ids).size).toBe(1);                    // every turn reused it
    expect(ids[0]).toBe(1644687);
  });

  it("does NOT call /chat/new again on a later turn", async () => {
    await turn();
    fetchCalls = [];
    await turn();
    expect(fetchCalls.some((c) => c.url === NEW_CHAT_URL)).toBe(false);
  });

  it("honours an explicitly remembered id across separate credential objects", async () => {
    // Same token, fresh object — what every request actually looks like when
    // credentials are re-read from the DB.
    await turn({ apiKey: JWT, connectionId: "conn-a" });
    await turn({ apiKey: JWT, connectionId: "conn-a" });
    const ids = fetchCalls.filter((c) => c.url === CHAT_URL).map((c) => JSON.parse(c.options.body).chat_id);
    expect(new Set(ids).size).toBe(1);
  });

  it("re-mints when upstream says the remembered chat_id is gone (400 Chat not found)", async () => {
    await turn();
    const firstIds = new Set(fetchCalls.filter((c) => c.url === CHAT_URL).map((c) => JSON.parse(c.options.body).chat_id));
    fetchCalls = [];

    // Stale id → upstream refuses it. One re-mint and the turn succeeds.
    nextResponses = [
      stubResponse({ status: 400, ok: false, body: "code=-10002, msg=Chat not found" }),
      stubResponse({ body: JSON.stringify({ code: 0, data: { id: 1684367 } }) }),
    ];
    const res = await turn();
    expect(res.response.status).toBe(200);
    expect(fetchCalls.some((c) => c.url === NEW_CHAT_URL)).toBe(true);
    const lastId = JSON.parse(fetchCalls.filter((c) => c.url === CHAT_URL).pop().options.body).chat_id;
    expect(firstIds.has(lastId)).toBe(false);
    expect(lastId).toBe(1684367);
  });
});

describe("intern-web routing never falls back to the site root", () => {
  // The bug this whole file guards: without a registered executor,
  // getExecutor() returns DefaultExecutor, which POSTs an OpenAI body to
  // https://discovery.intern-ai.org.cn — nginx 405 today, and the 401 A0202
  // "user authenticate failed" the user reported once auth headers line up.
  it("resolves to InternWebExecutor, not the DefaultExecutor fallback", () => {
    const exec = getExecutor("intern-web");
    expect(exec.constructor.name).toBe("InternWebExecutor");
    expect(exec).not.toBeInstanceOf(DefaultExecutor);
  });

  it("targets /api/orbit/v1/chat, not the bare origin", () => {
    const exec = getExecutor("intern-web");
    const creds = { apiKey: JWT };
    expect(exec.buildUrl?.("Auto", false, 0, creds) ?? CHAT_URL).toBe(CHAT_URL);
  });
});
