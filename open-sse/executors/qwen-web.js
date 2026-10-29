// QwenWebExecutor — qianwen.com / 千问 web provider (clean-room).
//
// Routes requests through the web client from a logged-in browser context.
// Authentication is cookie-based: the user pastes a header like
//   `isg=...; tfstk=...; _qk_bx_um_v1=...` from DevTools → Application.
//
// The page's security SDK signs every chat request with x5sec + bx headers that
// cannot be reproduced in plain Node, so we drive the page via browserPool and
// extract the answer from the DOM element #qk-markdown-react.
//
// Endpoint: POST https://chat2.qianwen.com/api/v2/chat?biz_id=ai_qwen&...
// Models: Qwen, Qwen3.7-Max, Qwen3.6-Flash, and passthrough.

import { BaseExecutor } from "./base.js";
import { randomUUID } from "node:crypto";
import {
  acquireBrowserContext,
  openPage,
  releaseBrowserContext,
} from "../services/browserPool.js";
import { SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { isMissingBrowserExecutable } from "./browserExecutableCheck.js";

const QWEN_API_BASE = "https://chat2.qianwen.com";
const PAGE_URL = "https://www.qianwen.com/";

const DEFAULT_MODEL = "Qwen";

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function statusForAdapterError(message) {
  if (/(?:401|403|invalid|expired)/i.test(message)) return 401;
  if (/429|rate[-_\s]?limit|quota/i.test(message)) return 429;
  if (/400|request|messages|model/i.test(message)) return 400;
  return 502;
}

function extractUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join("");
      }
    }
  }
  return "";
}

function resolveModel(bodyObj, messages) {
  const explicit = bodyObj?.model;
  if (explicit && MODEL_CONF[explicit]) return explicit;
  const lastUser = extractUserText(messages);
  if (/max/i.test(lastUser)) return "Qwen3.7-Max";
  if (/flash/i.test(lastUser) || /3\.6/i.test(lastUser)) return "Qwen3.6-Flash";
  return DEFAULT_MODEL;
}

const MODEL_CONF = {
  Qwen: { label: "Qwen", upstream: "Qwen" },
  "Qwen3.7-Max": { label: "Qwen3.7-Max", upstream: "Qwen3.7-Max" },
  "Qwen3.6-Flash": { label: "Qwen3.6-Flash", upstream: "Qwen3.6-Flash" },
};

export class QwenWebExecutor extends BaseExecutor {
  constructor() {
    super("qwen-web", { id: "qwen-web", baseUrl: PAGE_URL });
  }

  async testConnection(credentials) {
    const raw = String(credentials?.apiKey || "").trim();
    if (!raw) return false;
    return raw.includes("isg=") || raw.includes("tfstk=") || raw.includes("_qk_bx_");
  }

  async execute(input) {
    let context, page;
    try {
      const response = await executeQwenWebCleanRoom(input);
      return { response, url: PAGE_URL, headers: {}, transformedBody: input.body };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Qwen Web execution failed";
      if (isMissingBrowserExecutable(message)) {
        return {
          response: errorResponse(
            503,
            "Qwen Web requires a Chrome/Chromium browser. Install Google Chrome " +
              "on the host, and run `npx playwright-core install chromium`.",
          ),
          url: PAGE_URL,
          headers: {},
          transformedBody: input.body,
        };
      }
      const status = statusForAdapterError(message);
      return {
        response: errorResponse(status, message),
        url: PAGE_URL,
        headers: {},
        transformedBody: input.body,
      };
    }
  }
}

const SSE_ENCODER = new TextEncoder();

async function executeQwenWebCleanRoom(input) {
  const { body, credentials } = input;
  const bodyObj = typeof body === "string" ? JSON.parse(body) : body;
  const messages = bodyObj?.messages ?? [];
  const model = resolveModel(bodyObj, messages);

  const raw = credentials?.providerSpecificData?.storageState ?? credentials?.apiKey ?? "";
  const storageState = raw.trim().startsWith("{") ? JSON.parse(raw) : null;

  const context = await acquireBrowserContext("qwen-web", { storageState });
  const page = await openPage(context);

  try {
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);

    // Click the input area
    const inputBox = page.locator('[contenteditable="true"]').first();
    await inputBox.click({ timeout: 10000 });

    const userText = extractUserText(messages);
    await page.keyboard.type(userText, { delay: 15 });
    await page.waitForTimeout(300);

    // Click send
    await page.getByRole("button", { name: "发送消息" }).click();

    // Poll for the answer appearing in #qk-markdown-react
    const encoder = new TextEncoder();
    const chunks = await page.evaluate(async () => {
      const out = [];
      const startTime = Date.now();
      const timeoutMs = 90000;
      const checkInterval = 800;

      while (Date.now() - startTime < timeoutMs) {
        await new Promise((r) => setTimeout(r, checkInterval));
        const md = document.querySelector("#qk-markdown-react");
        if (md) {
          const txt = md.innerText.trim();
          if (txt && !txt.startsWith("写一首短诗") && !txt.startsWith("用一句话介绍") && !txt.startsWith("只回复OK") && txt.length > 10) {
            out.push(txt);
            break;
          }
        }
        // Check if page shows login or error
        const loginMsg = document.querySelector("text:has-text('登录可同步历史对话')");
        if (loginMsg) {
          out.push("[error: please log in first]");
          break;
        }
      }
      return out;
    });

    // Build SSE response
    const stream = new ReadableStream({
      pull(controller) {
        for (const txt of chunks) {
          const chunk = {
            id: `chatcmpl-${randomUUID()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: txt }, finish_reason: null }],
          };
          controller.enqueue(SSE_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        const finish = {
          id: `chatcmpl-${randomUUID()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        controller.enqueue(SSE_ENCODER.encode(`data: ${JSON.stringify(finish)}\n\n`));
        controller.enqueue(SSE_ENCODER.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return new Response(stream, { status: 200, headers: SSE_HEADERS_NO_BUFFER });
  } finally {
    await page.close().catch(() => {});
  }
}