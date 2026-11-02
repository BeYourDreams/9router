// Doubao Web (doubao.com) executor adapter — plain HTTP, no browser.
//
// Endpoint:  POST https://www.doubao.com/chat/completion  → text/event-stream
// Auth:      the account cookie header (sessionid/sid_tt/… — "Login via Browser").
//
// Two things captured against the live site drive the design here:
//
// 1. The web client sends only the NEW user turn and lets doubao keep the history,
//    keyed on client_meta.conversation_id. An OpenAI client is stateless, so we
//    replay the whole conversation as content blocks in one request and always
//    open a fresh conversation ("" + a fresh local id + need_create_conversation).
//    Echoing a client-chosen conversation id instead is ignored server-side and
//    silently appends every request to the account's main conversation.
// 2. The per-request anti-bot signatures (msToken, a_bogus) must NOT be replayed.
//    They are minted by page JS seconds before the call; a stale one is answered
//    HTTP 200 + SSE STREAM_ERROR "rate limited" (710022004). Omitting them worked
//    for ~30 consecutive Node-side calls.
// 3. That same error_code is also what doubao's risk engine ("shark") returns when
//    it flags a session/IP and wants a captcha — a bare-Node channel can be limited
//    this way at any time, and a real browser login on that machine is the only
//    known reset. It is surfaced as 403 (cookie/verify problem) or 429 (plain
//    throttle) so rotation and backoff behave, never as an empty 200.
//
// Tools are not supported — the web uplink has no tool-call channel.

import { randomUUID } from "node:crypto";
import { SSE_HEADERS_NO_BUFFER } from "../../utils/sseConstants.js";

const BASE = "https://www.doubao.com";
const COMPLETION_PATH = "/chat/completion";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

// The main chat bot every web conversation is bound to. Required: without a
// bot_id the endpoint answers STREAM_ERROR "common invalid param".
const BOT_ID = "7338286299411103781";

// model_item_key → what the picker labels it. Values read out of the /chat/ SSR
// payload (menu_item_list). Unknown ids fold onto "0" (快速) — an unknown key is
// answered with an empty stream, so forwarding a client id verbatim is not an option.
const MODEL_KEYS = {
  "doubao-fast": "0",
  fast: "0",
  "doubao-seed-1-6": "0",
  "doubao-expert": "3",
  expert: "3",
  "doubao-2-1-pro": "5",
  "doubao-2.1-pro": "5",
  "doubao-1-5-pro": "5",
  "doubao-2-1-lite": "seed-lite-7b",
  "doubao-2.1-lite": "seed-lite-7b",
  "doubao-1-5-lite": "seed-lite-7b",
  lite: "seed-lite-7b",
};
const DEFAULT_MODEL_KEY = "0";

/** Cookie header from whatever the connection holds: raw header, JSON array, or Playwright storage state. */
export function resolveCookieHeader(credentials) {
  const raw = String(credentials?.providerSpecificData?.storageState ?? credentials?.apiKey ?? credentials?.accessToken ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("{")) {
    try {
      const cookies = JSON.parse(raw)?.cookies;
      if (Array.isArray(cookies)) return toHeader(cookies);
    } catch {
      /* not a storage state */
    }
    return "";
  }
  if (raw.startsWith("[")) {
    try {
      return toHeader(JSON.parse(raw));
    } catch {
      return "";
    }
  }
  const stripped = raw.replace(/^cookie\s*:\s*/i, "");
  return stripped.includes("=") ? stripped : "";

  function toHeader(list) {
    return list
      .filter((c) => c?.name && c?.value && /doubao\.com$/.test(String(c.domain || "").replace(/^\./, "")))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join("");
  if (content == null) return "";
  return String(content);
}

// block_type 10000 = a plain text block. The web client wraps every turn in one.
function block(text) {
  return {
    local_message_id: randomUUID(),
    content_block: [
      {
        block_type: 10000,
        block_id: randomUUID(),
        content: { text_block: { text, icon_url: "", icon_url_dark: "", summary: "" }, pc_event_block: "" },
        parent_id: "",
        meta_info: [],
        extra_info: {},
        append_fields: [],
      },
    ],
    message_status: 0,
  };
}

/**
 * OpenAI messages → doubao uplink body.
 *
 * Every turn goes up as its own content block in ONE request: the web client
 * only sends the newest turn and lets doubao keep history, but an OpenAI client
 * is stateless, so history is replayed. Verified against the live endpoint — a
 * 3-block replay (question / "好的" / follow-up) answers the follow-up from the
 * earlier block. Blocks all arrive as human messages (assistant sender fields
 * belong to the IM layer), which is enough for the model to track the exchange.
 * One request also means one doubao conversation, so 9router sessions never
 * share context with each other.
 */
export function buildRequestBody({ messages, model }) {
  const blocks = messages.map((m) => textOf(m?.content)).filter(Boolean);
  if (!blocks.length) throw new Error("Doubao Web request has no text content");

  const key = MODEL_KEYS[String(model || "").toLowerCase()] ?? DEFAULT_MODEL_KEY;
  const now = Date.now();
  return {
    client_meta: {
      local_conversation_id: `local_${Math.floor(Math.random() * 1e15)}`,
      conversation_id: "",
      bot_id: BOT_ID,
      last_section_id: "",
      last_message_index: null,
    },
    messages: blocks.map(block),
    option: {
      create_time_ms: now,
      unique_key: randomUUID(),
      start_seq: 0,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: { model_item_key: key, reasoning_effort: "3", mode_id: "1" },
      model_config: { model_item_key: key, model_extra_params: {}, reasoning_effort: 3 },
      aggregate_params: {
        mention_skill_list: "[]",
        mention_plugin_list: "[]",
        mention_ext: "[{}]",
        conversation_mode: "1",
        mode_id: "1",
        model_item_key: key,
        agent_mode: "2",
        reasoning_effort: "3",
        provider_id: "",
      },
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(now / 1000), append_sse_event_scene: 0 },
      general_task_param: { server_do_compare: true },
      // The rest are inert constants lifted from a captured real request. The
      // endpoint rejects the call ("common invalid param") once certain of them
      // are missing, and none were individually bisected as required, so they stay.
      agent_mode: 2,
      conversation_mode: 1,
      need_deep_think: 0,
      is_finish: false,
      message_storage_type: 0,
      scene_type: 0,
      tts_switch: false,
      is_audio: false,
      answer_with_suggest: false,
      click_clear_context: false,
      disable_sse_cache: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      is_from_click_option: false,
      is_from_click_softlink: false,
      is_select_text: false,
      no_replace_for_regen: false,
      resend_for_regen: false,
      select_text_action: "",
      send_message_scene: "",
      collect_id: "",
      regen_instruction: "",
      regen_query_id: [],
      edit_query_id: [],
      message_from: 0,
      shared_app_name: "",
      shared_app_id: "",
      is_ai_playground: false,
      is_old_user: true,
      related_deleted_message_ids: {},
      connector_info_list: [],
    },
    user_context: [],
    ext: { agent_mode: "2", use_deep_think: "0", is_finish: "1", sub_conv_firstmet_type: "1" },
  };
}

/**
 * doubao SSE frame → text deltas.
 *
 *   CHUNK_DELTA      {"text":"…"}                        per-token increment
 *   STREAM_MSG_NOTIFY content_block[].text_block.text    the first chunk
 *   STREAM_CHUNK     patch_op[]                          patches (text + tts + finish)
 *   SSE_REPLY_END    {"end_type":1|2|3}                  3 closes the stream
 *   STREAM_ERROR     {"error_code":…,"error_msg":"…"}    failure inside a 200
 *
 * Only CHUNK_DELTA/STREAM_MSG_NOTIFY/patch_object==1 carry answer text; tts
 * patches (patch_object 111) repeat it and must be skipped or the answer doubles.
 */
export function frameToText(event, data) {
  let frame;
  try {
    frame = JSON.parse(data);
  } catch {
    return "";
  }
  if (event === "CHUNK_DELTA") return typeof frame?.text === "string" ? frame.text : "";
  if (event === "STREAM_MSG_NOTIFY") {
    return (frame?.content?.content_block || []).map((b) => b?.content?.text_block?.text || "").join("");
  }
  if (event === "STREAM_CHUNK") {
    return (frame?.patch_op || [])
      .filter((p) => p?.patch_object === 1)
      .flatMap((p) => (p?.patch_value?.content_block || []).map((b) => b?.content?.text_block?.text || ""))
      .join("");
  }
  return "";
}

export function frameError(data) {
  try {
    const frame = JSON.parse(data);
    if (!frame?.error_msg && !frame?.error_code) return null;
    return {
      code: Number(frame.error_code) || 0,
      message: String(frame.error_msg || "doubao stream error"),
      // The risk engine asks for a slide/semantic captcha; only a real browser can answer.
      needsVerify: /"type":"verify"|verify_scene/.test(String(frame.extra?.decision || "")),
    };
  } catch {
    return null;
  }
}

export function statusForStreamError(err) {
  if (err?.code === 710022004) return err.needsVerify ? 403 : 429;
  if (err?.needsVerify) return 403;
  return 502;
}

export async function executeDoubaoWeb({ input, fetchImpl }) {
  const { body, credentials, signal } = input;
  const bodyObj = typeof body === "string" ? JSON.parse(body) : body;
  const cookie = resolveCookieHeader(credentials);
  if (!cookie) {
    throw Object.assign(new Error("Doubao Web needs the doubao.com login cookie. Use “Login via Browser”, or paste the Cookie header from DevTools (must contain sessionid)."), { status: 401 });
  }

  const payload = buildRequestBody({ messages: bodyObj?.messages ?? [], model: bodyObj?.model });
  // Query string: inert client constants only — the per-request anti-bot
  // signatures (msToken / a_bogus) are never replayed. device_id / web_id /
  // tea_uuid identify the browser install; every request proven to work carried
  // them, and they are not derivable from the cookie, so they come from
  // providerSpecificData (settable on the connection via the API; the dashboard
  // form has no field for them) and are otherwise omitted — the capture is still
  // accepted, but that combination is untested after the risk flag landed.
  // Ceiling: if a connection only ever answers "rate limited", POST
  // {providerSpecificData:{doubaoDeviceId,doubaoWebId}} to /api/providers/<id>.
  const ids = credentials?.providerSpecificData || {};
  const qs = new URLSearchParams({
    version_code: "20800",
    language: "zh",
    device_platform: "web",
    doubao_device_platform: "web",
    aid: "497858",
    real_aid: "497858",
    pkg_type: "release_version",
    pc_version: "3.43.5",
    doubao_pc_version: "3.43.5",
    region: "CN",
    sys_region: "CN",
    samantha_web: "1",
    web_platform: "browser",
    "use-olympus-account": "1",
    ...(ids.doubaoDeviceId ? { device_id: String(ids.doubaoDeviceId), tea_uuid: String(ids.doubaoTeaUuid || ids.doubaoDeviceId) } : {}),
    ...(ids.doubaoWebId ? { web_id: String(ids.doubaoWebId) } : {}),
  });
  const url = `${BASE}${COMPLETION_PATH}?${qs}`;

  const response = await (fetchImpl || fetch)(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Cookie: cookie,
      Origin: BASE,
      Referer: `${BASE}/chat/`,
      "User-Agent": USER_AGENT,
      // Sent by the web client on every completion; harmless either way, kept for parity.
      "agw-js-conv": "str, str",
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error(`Doubao Web rejected the cookie (HTTP ${response.status}). Re-login at doubao.com and refresh the connection.`), { status: 401 });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw Object.assign(new Error(`Doubao Web HTTP ${response.status}: ${text.slice(0, 200)}`), { status: response.status });
  }

  const raw = await response.text();
  const model = bodyObj?.model || "doubao-fast";
  const chunks = [];
  let sawError = null;
  let finished = false;

  for (const part of raw.split(/\n\n+/)) {
    const event = /^event:\s*(.+)$/m.exec(part)?.[1]?.trim() || "";
    const data = /^data:\s*(.*)$/m.exec(part)?.[1]?.trim() || "";
    if (!data) continue;
    if (event === "STREAM_ERROR") {
      sawError = frameError(data);
      continue;
    }
    if (event === "SSE_REPLY_END") {
      // end_type 3 is the last frame of the turn; 1/2 are per-message markers.
      if (/"end_type"\s*:\s*3/.test(data)) finished = true;
      continue;
    }
    const text = frameToText(event, data);
    if (!text) continue;
    chunks.push({
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    });
  }

  if (!chunks.length && !sawError) {
    throw Object.assign(
      new Error("Doubao Web returned no content. The cookie is probably expired, or the risk engine challenged this IP — re-login with “Login via Browser”."),
      { status: 401 }
    );
  }
  if (sawError && !chunks.length) {
    throw Object.assign(new Error(`Doubao Web: ${sawError.message}${sawError.needsVerify ? " (doubao asked this session for a captcha — log in once in a real browser from this machine)" : ""}`), {
      status: statusForStreamError(sawError),
    });
  }

  chunks.push({
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });

  const encoder = new TextEncoder();
  const queue = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"];
  let cursor = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (cursor >= queue.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(queue[cursor++]));
    },
  });

  return {
    response: new Response(stream, { status: 200, headers: SSE_HEADERS_NO_BUFFER }),
    url,
    headers: {},
    transformedBody: bodyObj,
  };
}
