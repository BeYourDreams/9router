// Shrink the tool *definitions*, the one large block a first request carries
// that rtk never touched: the output filters (git/grep/ls/…) need history, and
// a session's first turn has none. Claude Code sends 20–40 definitions whose
// descriptions alone run to several KB.
//
// Shrink-only and fail-open like every other saver here. What goes:
//   $schema / title / examples   — documentation for humans, not a constraint
//   additionalProperties: true   — that is the JSON-Schema default anyway
//   description past the first paragraph, capped at MAX_DESC
// Never touched: `required`, `enum`, types and the parameter descriptions —
// those are what the model needs to call the tool correctly.
//
// ponytail: first paragraph only. If a deployment finds tool calls degrading,
// keep the paragraphs of the named tools instead of loosening it globally.

const MAX_DESC = 400;
const MAX_SCHEMA_DEPTH = 12;

/** The mutable definition object and its parameter-schema key, per wire shape. */
function shapeOf(tool) {
  if (!tool || typeof tool !== "object") return null;
  if (tool.function && typeof tool.function === "object") {
    return { def: tool.function, schemaKey: "parameters" };
  }
  if (tool.input_schema && typeof tool.input_schema === "object") {
    return { def: tool, schemaKey: "input_schema" }; // Anthropic
  }
  if (tool.parameters || (typeof tool.name === "string" && typeof tool.description === "string")) {
    return { def: tool, schemaKey: "parameters" }; // OpenAI Responses, flat
  }
  return null;
}

function pruneSchema(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > MAX_SCHEMA_DEPTH) return;
  if (Array.isArray(node)) {
    for (const item of node) pruneSchema(item, depth + 1);
    return;
  }
  delete node.$schema;
  delete node.title;
  delete node.examples;
  if (node.additionalProperties === true) delete node.additionalProperties;
  for (const key of Object.keys(node)) pruneSchema(node[key], depth + 1);
}

/** First paragraph, cut at a sentence boundary when it still overruns. */
function shorten(text) {
  if (typeof text !== "string" || text.length <= MAX_DESC) return text;
  let head = text.split(/\n\s*\n/)[0].trim();
  if (head.length < 40) head = text.trim(); // one-liner split by a stray blank line
  if (head.length > MAX_DESC) {
    const cut = head.slice(0, MAX_DESC);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
    head = end > 80 ? cut.slice(0, end + 1).trim() : cut.trimEnd() + "…";
  }
  return head;
}

/**
 * @param {object} body  final outbound body (source or target shape)
 * @param {boolean} enabled
 * @returns {{bytesBefore:number,bytesAfter:number,hits:Array}|null}
 */
export function compactToolSchemas(body, enabled) {
  if (!enabled || !body || typeof body !== "object") return null;
  const tools = Array.isArray(body.tools) ? body.tools
    : Array.isArray(body.functions) ? body.functions
    : null;
  if (!tools || tools.length === 0) return null;

  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  let saved = 0;
  try {
    for (const tool of tools) {
      const shape = shapeOf(tool);
      if (!shape) continue;
      const before = JSON.stringify(tool).length;
      stats.bytesBefore += before;

      const trimmed = shorten(shape.def.description);
      if (typeof trimmed === "string" && trimmed.length < (shape.def.description || "").length) {
        shape.def.description = trimmed;
      }
      if (shape.def[shape.schemaKey] && typeof shape.def[shape.schemaKey] === "object") {
        pruneSchema(shape.def[shape.schemaKey]);
      }

      const after = JSON.stringify(tool).length;
      stats.bytesAfter += after;
      if (after < before) saved += before - after;
    }
  } catch (e) {
    console.warn("[RTK] compactToolSchemas error:", e.message);
    return null;
  }
  if (saved > 0) stats.hits.push({ shape: "tools", filter: "tool-schema", saved });
  return stats;
}
