// The whole point of `npm start` auto-building is that it fires exactly when the
// build is older than the sources, and never when a live server owns the tree.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { BUILD_INPUTS, isBuildStale, portOccupied } from "../../scripts/build-state.mjs";

const base = resolve(tmpdir(), `build-state-${process.pid}-${Date.now()}`);
afterAll(() => rmSync(resolve(base), { recursive: true, force: true }));

/** An isolated tree so mtime fixtures cannot leak between cases. */
function fixture(name) {
  const root = resolve(base, name);
  mkdirSync(root, { recursive: true });
  return {
    root,
    mk(rel, secs) {
      const p = resolve(root, rel);
      mkdirSync(resolve(p, ".."), { recursive: true });
      writeFileSync(p, "x");
      utimesSync(p, new Date(0), new Date(secs * 1000));
      return p;
    },
    stale: (distDir = ".next") => isBuildStale({ projectRoot: root, distDir }),
  };
}

const T0 = 1_000_000; // fixed epoch seconds; only their order matters

describe("isBuildStale", () => {
  it("is stale when BUILD_ID is missing", () => {
    const f = fixture("no-build-id");
    f.mk("src/app/page.js", T0);
    expect(f.stale()).toBe(true);
  });

  it("is fresh when BUILD_ID is newer than every input", () => {
    const f = fixture("fresh");
    f.mk("src/app/page.js", T0);
    f.mk("open-sse/providers/registry/glm.js", T0 + 1);
    f.mk("next.config.mjs", T0 + 2);
    f.mk(".next/BUILD_ID", T0 + 100);
    expect(f.stale()).toBe(false);
  });

  it("is stale when one deeply nested source is newer (recursive, not top level)", () => {
    const f = fixture("nested");
    f.mk("src/ok.js", T0);
    f.mk(".next/BUILD_ID", T0 + 100);
    f.mk("src/lib/deep/nested/module.js", T0 + 101);
    expect(f.stale()).toBe(true);
  });

  it("ignores trees that do not feed the build", () => {
    expect(BUILD_INPUTS).not.toContain("tests");
    expect(BUILD_INPUTS).not.toContain("gitbook");
    expect(BUILD_INPUTS).not.toContain("docs");
    const f = fixture("ignores");
    f.mk(".next/BUILD_ID", T0 + 100);
    f.mk("tests/unit/whatever.test.js", T0 + 9999);
    f.mk("gitbook/some-page.md", T0 + 9999);
    f.mk("docs/ARCHITECTURE.md", T0 + 9999);
    expect(f.stale()).toBe(false);
  });

  it("judges a sandbox dist dir on its own", () => {
    const f = fixture("sandbox");
    f.mk("src/app/page.js", T0);
    f.mk(".next/BUILD_ID", T0 + 100); // production is up to date…
    expect(f.stale(".next")).toBe(false);
    expect(f.stale(".next-sandbox")).toBe(true); // …the sandbox has never been built
  });

  it("never throws on a missing tree, and follows an empty one", () => {
    expect(isBuildStale({ projectRoot: resolve(base, "absent"), distDir: ".next" })).toBe(true);
    const f = fixture("empty");
    f.mk(".next/BUILD_ID", T0 + 100);
    expect(f.stale()).toBe(false);
  });
});

describe("portOccupied", () => {
  it("reports a listening port as occupied, and a released one as free", async () => {
    const probe = createServer();
    await new Promise((d) => probe.listen(0, d));
    const port = probe.address().port;
    expect(await portOccupied(port)).toBe(true);
    await new Promise((d) => probe.close(d));
    expect(await portOccupied(port)).toBe(false);
  });

  it("sees an IPv4-only listener (Windows does not map it to the IPv6 wildcard)", async () => {
    const probe = createServer();
    await new Promise((d) => probe.listen(0, "127.0.0.1", d));
    const port = probe.address().port;
    expect(await portOccupied(port)).toBe(true);
    await new Promise((d) => probe.close(d));
  });
});
