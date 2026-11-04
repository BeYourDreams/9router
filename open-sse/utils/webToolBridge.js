// Response-side bridge that upgrades web-cookie providers' plain-text tool
// invocations into real OpenAI `tool_calls`.
//
// Web-UI providers (xinghuo, chatglm, doubao, yiyan, yuanbao, ling, qwen,
// xiaomimimo, …) have no native function calling: we instruct the model with a
// `<tool>{...}</tool>` contract (see translator/webTools.js) and it answers with
// that block as ordinary assistant text. Streaming those bytes straight through
// leaves agent clients with `finish_reason:"stop"` and a message that merely
// *looks* like a tool call, so nothing is executed and the turn ends.
//
// Rather than teach every executor a different parsing path, this module sits on
// the single point where chatCore hands the upstream body back to the response
// handlers and rewrites it.
//
// Streaming contract: assistant text is forwarded as soon as it can no longer be
// the beginning of a `<tool` / `<tool_call` marker, so ordinary answers keep
// flowing token by token. Once a marker starts, the remainder of the turn is
// buffered. At end of stream the buffered turn is parsed:
//
//   • tool envelope found → emit `tool_calls` + `finish_reason:"tool_calls"`
//   • otherwise           → release the held prose + `finish_reason:"stop"`
//
// Only the OpenAI SSE/JSON shapes produced by web executors are understood.
// Whether the layer applies at all is decided by the caller.

import { buildToolAwareResult, parseToolCallsFromText } from "../translator/webTools.js";

// Longest prefix that must be held back so a marker split across two SSE frames
// is still recognised (`<to` + `ol>`).
const MARKERS = ["<tool_call", "<tool"];
const MAX_MARKER = Math.max(...MARKERS.map((m) => m.length));
const LOOKS_LIKE_TOOL = /<tool(?:_call)?[\s>]/i;

function toText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("");
  }
  return String(value);
}

/**
 * Split `text` into the part safe to forward and a trailing fragment that must
 * wait. `blocked` is true when the held fragment begins a tool envelope
 * (`<tool>` / `<tool_call …>`), meaning the rest of the turn belongs to it and
 * may no longer be streamed as prose.
 */
function splitPendingTail(text) {
  if (!text) return { ready: "", pending: "", blocked: false };

  // Find the earliest `<` whose remainder is either a complete envelope opener
  // or a still-incomplete prefix of one. Later `<` characters (e.g. `</tool>`)
  // do not matter: once an opener is seen everything after it is held.
  let index = text.indexOf("<");
  while (index !== -1) {
    const tail = text.slice(index).toLowerCase();
    if (LOOKS_LIKE_TOOL.test(text.slice(index))) {
      return { ready: text.slice(0, index), pending: text.slice(index), blocked: true };
    }
    if (MARKERS.some((marker) => marker.startsWith(tail))) {
      return { ready: text.slice(0, index), pending: text.slice(index), blocked: false };
    }
    index = text.indexOf("<", index + 1);
  }

  // No usable `<`: keep back a bare suffix that could still grow into `<tool`.
  const keep = Math.min(MAX_MARKER - 1, text.length);
  const suffix = text.slice(text.length - keep);
  if (!suffix.includes(">") && MARKERS.some((marker) => marker.startsWith(suffix.toLowerCase()))) {
    return { ready: text.slice(0, text.length - keep), pending: suffix, blocked: false };
  }
  return { ready: text, pending: "", blocked: false };
}

/** JSON body of an OpenAI `chat.completion.chunk` (or full completion) frame. */
function frameDelta(frame) {
  const choice = frame?.choices?.[0];
  return choice?.delta ?? choice?.message ?? {};
}

function frameText(frame) {
  return toText(frameDelta(frame)?.content);
}

function frameReasoning(frame) {
  const delta = frameDelta(frame);
  return toText(delta?.reasoning_content ?? delta?.reasoning);
}

function frameToolCalls(frame) {
  const calls = frameDelta(frame)?.tool_calls;
  return Array.isArray(calls) && calls.length ? calls : null;
}

/** Split a raw SSE buffer into complete event blocks and a remainder. */
function splitSseEvents(buffer) {
  const events = [];
  let rest = buffer;
  let index;
  while ((index = rest.indexOf("\n\n")) !== -1) {
    events.push(rest.slice(0, index));
    rest = rest.slice(index + 2);
  }
  return { events, rest };
}

function parseFrameData(eventBlock) {
  const dataLine = eventBlock
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!dataLine || dataLine === "[DONE]") return { dataLine, frame: null };
  try {
    return { dataLine, frame: JSON.parse(dataLine) };
  } catch {
    return { dataLine, frame: null };
  }
}

function makeChunkLike(template, delta, finishReason) {
  const base = template && typeof template === "object" ? template : {};
  return {
    ...base,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  };
}

function sseData(frame) {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

function safeNotify(onToolCalls, toolCalls, content) {
  if (!onToolCalls) return;
  try {
    onToolCalls(toolCalls, content);
  } catch {
    // Observability must never break the stream.
  }
}

/**
 * Streaming bridge: forwards an OpenAI SSE stream, upgrading a trailing
 * `<tool>` envelope into `tool_calls` + `finish_reason:"tool_calls"`.
 */
export function createWebToolBridgeStream({ requestedTools, idSeed = "call", onToolCalls } = {}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let sseBuffer = "";   // raw bytes not yet forming a complete SSE event
  let template = null;  // first upstream frame, reused as the chunk skeleton
  let held = "";        // assistant text withheld pending marker resolution
  let turnText = "";    // every assistant text delta seen this turn
  let buffering = false;
  let sawUpstreamToolCalls = false;

  return new TransformStream({
    transform(chunk, controller) {
      sseBuffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const { events, rest } = splitSseEvents(sseBuffer.replace(/\r\n/g, "\n"));
      sseBuffer = rest;
      for (const block of events) handleBlock(block, controller);
    },
    flush(controller) {
      const tail = sseBuffer.trim();
      sseBuffer = "";
      if (tail) handleBlock(tail, controller);
      finishTurn(controller);
    },
  });

  function handleBlock(block, controller) {
    if (!block.trim()) return;
    const { dataLine, frame } = parseFrameData(block);
    if (!frame) {
      if (dataLine === "[DONE]") return; // terminal marker is re-emitted by finishTurn
      controller.enqueue(encoder.encode(`${block}\n\n`));
      return;
    }

    template = template ?? frame;

    // Reasoning streams through untouched — it never carries a tool envelope.
    if (frameReasoning(frame)) {
      controller.enqueue(encoder.encode(sseData(frame)));
      return;
    }

    const toolCalls = frameToolCalls(frame);
    if (toolCalls) {
      sawUpstreamToolCalls = true;
      controller.enqueue(encoder.encode(sseData(frame)));
      return;
    }

    const text = frameText(frame);
    if (text) {
      turnText += text;
      if (buffering) return; // already inside an envelope — hold everything
      held += text;
      const { ready, pending, blocked } = splitPendingTail(held);
      held = pending;
      if (ready) controller.enqueue(encoder.encode(sseData(makeChunkLike(template, { content: ready }))));
      if (blocked) buffering = true;
      return;
    }

    // An upstream finish frame is intentionally swallowed: finishTurn emits the
    // authoritative terminal frame once the buffered tail has been resolved.
  }

  function finishTurn(controller) {
    if (sawUpstreamToolCalls) {
      controller.enqueue(encoder.encode(sseData(makeChunkLike(template, {}, "tool_calls"))));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      return;
    }

    if (buffering) {
      const parsed = parseToolCallsFromText(turnText, `${idSeed}-${Date.now()}`, requestedTools);
      if (parsed.toolCalls) {
        // The prose before the envelope was already forwarded; what remains is
        // the call itself. Content that trailed the envelope is dropped rather
        // than re-sent, since the client is about to run the tools.
        for (const call of parsed.toolCalls) {
          controller.enqueue(encoder.encode(sseData(makeChunkLike(template, { tool_calls: [call] }))));
        }
        safeNotify(onToolCalls, parsed.toolCalls, parsed.content);
        controller.enqueue(encoder.encode(sseData(makeChunkLike(template, {}, "tool_calls"))));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        return;
      }
      // Not a tool envelope after all — release the withheld prose.
      if (held) controller.enqueue(encoder.encode(sseData(makeChunkLike(template, { content: held }))));
      held = "";
    }

    controller.enqueue(encoder.encode(sseData(makeChunkLike(template, {}, "stop"))));
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  }
}

/**
 * Wrap an OpenAI SSE `Response` so text-form tool invocations become
 * `tool_calls`. The response is returned untouched when `requestedTools` is
 * empty or the body is missing.
 */
export function wrapResponseWithWebToolBridge(response, { requestedTools, idSeed, onToolCalls } = {}) {
  if (!response?.body || !Array.isArray(requestedTools) || requestedTools.length === 0) return response;
  const bridged = response.body.pipeThrough(createWebToolBridgeStream({ requestedTools, idSeed, onToolCalls }));
  return new Response(bridged, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Rewrite a buffered OpenAI completion (non-streaming) whose assistant content
 * still carries a `<tool>` envelope.
 */
export function applyWebToolBridgeToJson(payload, { requestedTools, idSeed = "call", onToolCalls } = {}) {
  if (!payload || !Array.isArray(requestedTools) || requestedTools.length === 0) return payload;
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  if (!message || typeof message.content !== "string" || !message.content.toLowerCase().includes("<tool")) {
    return payload;
  }
  const { content, toolCalls } = parseToolCallsFromText(message.content, `${idSeed}-${Date.now()}`, requestedTools);
  if (!toolCalls) return payload;
  safeNotify(onToolCalls, toolCalls, content);
  return {
    ...payload,
    choices: [
      { ...choice, message: { ...message, content: content || null, tool_calls: toolCalls }, finish_reason: "tool_calls" },
      ...payload.choices.slice(1),
    ],
  };
}

/**
 * Rewrite an already-aggregated SSE text body in one shot. Used when an executor
 * collects the whole upstream stream before returning it, and by tests.
 */
export function bridgeSseText(sseText, { requestedTools, idSeed = "call", onToolCalls } = {}) {
  const raw = String(sseText || "");
  if (!Array.isArray(requestedTools) || requestedTools.length === 0) return raw;

  const normalized = raw.replace(/\r\n/g, "\n");
  const { events } = splitSseEvents(`${normalized}\n\n`);
  let content = "";
  let template = null;
  let sawDone = false;

  for (const block of events) {
    const { dataLine, frame } = parseFrameData(block);
    if (dataLine === "[DONE]") {
      sawDone = true;
      continue;
    }
    if (!frame) continue;
    template = template ?? frame;
    content += frameText(frame);
  }

  if (!LOOKS_LIKE_TOOL.test(content)) return raw;

  const parsed = parseToolCallsFromText(content, `${idSeed}-${Date.now()}`, requestedTools);
  if (!parsed.toolCalls) return raw;
  safeNotify(onToolCalls, parsed.toolCalls, parsed.content);

  const out = [];
  if (parsed.content) out.push(sseData(makeChunkLike(template, { content: parsed.content })));
  for (const call of parsed.toolCalls) out.push(sseData(makeChunkLike(template, { tool_calls: [call] })));
  out.push(sseData(makeChunkLike(template, {}, "tool_calls")));
  if (sawDone || out.length) out.push("data: [DONE]\n\n");
  return out.join("");
}
