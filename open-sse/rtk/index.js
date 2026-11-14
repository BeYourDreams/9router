// RTK port: compress tool_result content in LLM request bodies
// Applied in chatCore on the source-format body, before translateRequest.
import { RAW_CAP, MIN_COMPRESS_SIZE } from "./constants.js";
import { autoDetectFilter } from "./autodetect.js";
import { safeApply } from "./applyFilter.js";

// Compress tool_result content in-place. Returns stats or null if disabled/failed.
export function compressMessages(body, enabled) {
  if (!enabled) return null;
  if (!body) return null;

  // Kiro format: conversationState.history + conversationState.currentMessage
  if (body.conversationState) {
    return compressKiroFormat(body, enabled);
  }

  // Support both OpenAI/Claude "messages" and OpenAI Responses "input"
  const items = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!items) return null;

  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    for (let i = 0; i < items.length; i++) {
      const msg = items[i];
      if (!msg) continue;

      // Shape 4: OpenAI Responses — top-level { type:"function_call_output", output: string | [{type:"input_text", text}] }
      if (msg.type === "function_call_output") {
        if (typeof msg.output === "string") {
          msg.output = compressText(msg.output, stats, "openai-responses-string");
        } else if (Array.isArray(msg.output)) {
          for (let k = 0; k < msg.output.length; k++) {
            const part = msg.output[k];
            if (part && part.type === "input_text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "openai-responses-array");
            }
          }
        }
        continue;
      }

      // Shape 1: OpenAI tool message — { role:"tool", content: "string" }
      if (msg.role === "tool" && typeof msg.content === "string") {
        msg.content = compressText(msg.content, stats, "openai-tool");
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      // Shape 1b: OpenAI tool message — { role:"tool", content:[{type:"text", text:"..."}] }
      if (msg.role === "tool") {
        for (let k = 0; k < msg.content.length; k++) {
          const part = msg.content[k];
          if (part && part.type === "text" && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "openai-tool-array");
          }
        }
        continue;
      }

      // Shape 2/3: blocks array with tool_result entries
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (!block || block.type !== "tool_result") continue;
        if (block.is_error === true) continue; // preserve error traces

        if (typeof block.content === "string") {
          // Shape 2: claude string form
          block.content = compressText(block.content, stats, "claude-string");
        } else if (Array.isArray(block.content)) {
          // Shape 3: claude array form — compress each text part
          for (let k = 0; k < block.content.length; k++) {
            const part = block.content[k];
            if (part && part.type === "text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "claude-array");
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressMessages error:", e.message);
    return null;
  }
  return stats;
}

// Compress Kiro format: conversationState.history[].userInputMessage.userInputMessageContext.toolResults[].content[].text
function compressKiroFormat(body, enabled) {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    const state = body.conversationState;
    const allMessages = [...(Array.isArray(state?.history) ? state.history : [])];
    if (state?.currentMessage) allMessages.push(state.currentMessage);

    for (const msg of allMessages) {
      const toolResults = msg?.userInputMessage?.userInputMessageContext?.toolResults;
      if (!Array.isArray(toolResults)) continue;

      for (const tr of toolResults) {
        if (tr.status === "error") continue; // preserve error traces
        if (!Array.isArray(tr.content)) continue;

        for (const part of tr.content) {
          if (part && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "kiro-tool-result");
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressKiroFormat error:", e.message);
    return null;
  }
  return stats;
}

function compressText(text, stats, shape) {
  const bytesIn = text.length;
  stats.bytesBefore += bytesIn;

  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const fn = autoDetectFilter(text);
  if (!fn) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const out = safeApply(fn, text);

  // Safety: never return empty, never grow the input
  if (!out || out.length === 0 || out.length >= bytesIn) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  stats.bytesAfter += out.length;
  stats.hits.push({ shape, filter: fn.filterName || fn.name, saved: bytesIn - out.length });
  return out;
}

// --- System-prompt paragraph dedupe ---------------------------------------
//
// A client that inlines both a global and a project instruction file sends the
// overlapping paragraph twice on every request, and a first request has no
// history for any other saver to eat. Only *exact* duplicate paragraphs are
// dropped, only when long enough to be boilerplate, and the result is never
// allowed to grow or empty out — same fail-open contract as compressText.
const MIN_DUP_PARAGRAPH = 80;

function dedupeParagraphs(text, seen = new Set()) {
  const parts = text.split(/\n\s*\n/);
  if (parts.length < 2) return text;
  const kept = [];
  for (const part of parts) {
    const key = part.trim();
    if (key.length >= MIN_DUP_PARAGRAPH) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(part);
  }
  return kept.join("\n\n");
}

function rewriteSystemText(holder, key, stats, seen) {
  const value = holder?.[key];
  if (typeof value !== "string" || value.length < MIN_DUP_PARAGRAPH) return;
  const out = dedupeParagraphs(value, seen);
  if (out.length === 0 || out.length >= value.length) return;
  holder[key] = out;
  stats.bytesBefore += value.length;
  stats.bytesAfter += out.length;
}

/**
 * Drop exact duplicate paragraphs from every system instruction the body
 * carries (Chat `system` messages, Responses `instructions`, Anthropic
 * `system` string or blocks). Returns stats or null when nothing was saved.
 */
export function dedupeSystemText(body, enabled) {
  if (!enabled || !body || typeof body !== "object") return null;
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  // One set for the whole request: a client that splits its instructions across
  // several system messages (or Claude blocks) repeats itself across them.
  const seen = new Set();
  try {
    rewriteSystemText(body, "instructions", stats, seen);
    if (Array.isArray(body.system)) {
      for (const block of body.system) {
        if (block && typeof block.text === "string") rewriteSystemText(block, "text", stats, seen);
      }
    } else {
      rewriteSystemText(body, "system", stats, seen);
    }

    const items = Array.isArray(body.messages) ? body.messages
      : Array.isArray(body.input) ? body.input
      : [];
    for (const item of items) {
      if (!item || (item.role !== "system" && item.role !== "developer")) continue;
      if (typeof item.content === "string") {
        rewriteSystemText(item, "content", stats, seen);
        continue;
      }
      if (!Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part && typeof part.text === "string") rewriteSystemText(part, "text", stats, seen);
      }
    }
  } catch (e) {
    console.warn("[RTK] dedupeSystemText error:", e.message);
    return null;
  }
  const saved = stats.bytesBefore - stats.bytesAfter;
  if (saved <= 0) return null;
  stats.hits.push({ shape: "system", filter: "system-dedupe", saved });
  return stats;
}

// Convenience: format a log line from stats
export function formatRtkLog(stats) {
  if (!stats || !stats.hits || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  const filters = Array.from(new Set(stats.hits.map(h => h.filter))).join(",");
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${filters}] hits=${stats.hits.length}`;
}
