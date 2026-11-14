import { describe, it, expect } from "vitest";
import { compactToolSchemas } from "../../open-sse/rtk/toolSchema.js";
import { dedupeSystemText } from "../../open-sse/rtk/index.js";
import { composePrompts } from "../../open-sse/rtk/composePrompt.js";

const longDesc = "Read a file from disk. " + "Use offset and limit for large files. ".repeat(40);

describe("compactToolSchemas", () => {
  it("trims an OpenAI tool description and keeps required/enum untouched", () => {
    const body = {
      tools: [{
        type: "function",
        function: {
          name: "read",
          description: longDesc,
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            additionalProperties: true,
            properties: {
              mode: { type: "string", enum: ["fast", "safe"], description: "Pick a mode." },
            },
            required: ["mode"],
          },
        },
      }],
    };
    const before = JSON.stringify(body).length;
    const stats = compactToolSchemas(body, true);
    const after = JSON.stringify(body).length;
    expect(after).toBeLessThan(before);
    expect(stats.hits[0].filter).toBe("tool-schema");
    const fn = body.tools[0].function;
    expect(fn.name).toBe("read");
    expect(fn.description.length).toBeLessThanOrEqual(401);
    expect(fn.parameters.$schema).toBeUndefined();
    expect(fn.parameters.additionalProperties).toBeUndefined();
    expect(fn.parameters.required).toEqual(["mode"]);
    expect(fn.parameters.properties.mode.enum).toEqual(["fast", "safe"]);
    expect(fn.parameters.properties.mode.description).toBe("Pick a mode.");
  });

  it("handles the Anthropic input_schema shape", () => {
    const body = { tools: [{ name: "Read", description: longDesc, input_schema: { type: "object", title: "x" } }] };
    compactToolSchemas(body, true);
    expect(body.tools[0].description.length).toBeLessThan(longDesc.length);
    expect(body.tools[0].input_schema.title).toBeUndefined();
  });

  it("is a no-op when disabled or when there are no tools", () => {
    const body = { tools: [{ type: "function", function: { name: "read", description: longDesc } }] };
    expect(compactToolSchemas(body, false)).toBeNull();
    expect(compactToolSchemas({ messages: [] }, true)).toBeNull();
    expect(body.tools[0].function.description).toBe(longDesc);
  });

  it("never grows a short description", () => {
    const body = { tools: [{ type: "function", function: { name: "x", description: "Short." } }] };
    compactToolSchemas(body, true);
    expect(body.tools[0].function.description).toBe("Short.");
  });
});

describe("dedupeSystemText", () => {
  const shared = "Shared project rule. ".repeat(8);

  it("drops an exact duplicate paragraph across two system messages", () => {
    const body = {
      messages: [
        { role: "system", content: `global rules\n\n${shared}` },
        { role: "system", content: `project rules\n\n${shared}` },
        { role: "user", content: shared },
      ],
    };
    const stats = dedupeSystemText(body, true);
    expect(stats.hits[0].filter).toBe("system-dedupe");
    expect(body.messages[0].content).toContain(shared.trim());
    expect(body.messages[1].content).not.toContain(shared.trim());
    expect(body.messages[2].content).toBe(shared); // user turns are never touched
  });

  it("keeps short repeated lines and single-paragraph prompts", () => {
    const body = { messages: [{ role: "system", content: "a\n\nb" }] };
    expect(dedupeSystemText(body, true)).toBeNull();
    expect(body.messages[0].content).toBe("a\n\nb");
  });

  it("covers Claude system blocks and Responses instructions", () => {
    const body = {
      system: [{ type: "text", text: shared }],
      instructions: `one\n\n${shared}\n\n${shared}`,
    };
    dedupeSystemText(body, true);
    expect(body.instructions.split("\n\n").length).toBe(2);
  });
});

describe("composePrompts", () => {
  it("writes a shared line once and keeps short structural lines", () => {
    const sharedLine = "Security warnings and irreversible actions: write normal.";
    const caveman = `terse mode.\n${sharedLine}\nCode blocks: keep exact.`;
    const ponytail = `lazy mode.\n${sharedLine}\nCode blocks: keep exact.`;
    const out = composePrompts([caveman, ponytail]);
    expect(out.match(new RegExp(sharedLine.replace(/[.]/g, "\\."), "g")).length).toBe(1);
    expect(out.match(/Code blocks: keep exact\./g).length).toBe(1);
    expect(out.startsWith("terse mode.")).toBe(true);
    expect(out).toContain("lazy mode.");
  });

  it("skips empty prompts", () => {
    expect(composePrompts(["a", "", null, " "])).toBe("a");
  });
});
