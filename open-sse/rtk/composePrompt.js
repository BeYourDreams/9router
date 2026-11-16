// Two instruction savers can be on at once — terse output (caveman) plus
// minimal code (ponytail) — and their prompts share whole paragraphs
// (boundaries, persistence, auto-clarity). Injectable separately that overlap
// is paid twice on every request; composed, each distinct line goes once.
//
// Line-level, exact-match only, and short lines (< 24 chars) are always kept:
// they are the prompt's structure, not repetition.

const MIN_DUP_LINE = 24;

export function composePrompts(prompts = []) {
  const seen = new Set();
  const blocks = [];
  for (const prompt of Array.isArray(prompts) ? prompts : []) {
    if (typeof prompt !== "string" || !prompt.trim()) continue;
    const lines = [];
    for (const line of prompt.split("\n")) {
      const key = line.trim();
      if (key.length >= MIN_DUP_LINE) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      lines.push(line);
    }
    blocks.push(lines.join("\n").trim());
  }
  return blocks.filter(Boolean).join("\n\n");
}
