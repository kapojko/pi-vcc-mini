import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseGrepFlags, normalizeToolParams, parseToolRequest } from "../src/core/recall-request";
import { runGrep } from "../src/core/grep-recall";
import { openRecallView } from "../src/core/recall-run";
import { registerRecallTool } from "../src/tools/recall";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const writeSession = (entries: any[]) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-vcc-grep-"));
  dirs.push(dir);
  const file = join(dir, "session.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return file;
};

const msg = (id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: "message", id, message: { role, content, ...extra } });

const sessionManager = (ids: string[]) => ({
  getSessionFile: () => undefined as unknown as string,
  getBranch: () => ids.map((id) => ({ id })),
  getEntries: () => ids.map((id) => ({ id })),
});

const view = (file: string, ids: string[] = []) =>
  openRecallView(file, "lineage", sessionManager(ids) as any);

describe("parseGrepFlags", () => {
  it("maps -C/-B/-A and leaves the query", () => {
    expect(parseGrepFlags("-C 3 redis cache")).toEqual({ query: "redis cache", before: 3, after: 3 });
    expect(parseGrepFlags("-B2 -A 1 redis")).toEqual({ query: "redis", before: 2, after: 1 });
    expect(parseGrepFlags("-A4 x")).toEqual({ query: "x", after: 4 });
  });

  it("ignores -i and leaves plain queries untouched", () => {
    expect(parseGrepFlags("-i Redis")).toEqual({ query: "Redis" });
    expect(parseGrepFlags("redis cache")).toEqual({ query: "redis cache" });
    // A hyphenated word is not a flag.
    expect(parseGrepFlags("cache-hit rate")).toEqual({ query: "cache-hit rate" });
  });
});

describe("normalizeToolParams (grep additions)", () => {
  it("repairs flags inside query into before/after", () => {
    const p = normalizeToolParams({ query: "-C 4 auth" });
    expect(p.query).toBe("auth");
    expect(p.before).toBe(4);
    expect(p.after).toBe(4);
  });

  it("never overrides explicit before/after", () => {
    const p = normalizeToolParams({ query: "-C 4 auth", before: 0 });
    expect(p.before).toBe(0);
    expect(p.after).toBe(4);
  });

  it("repairs string numbers for before/after and drops junk", () => {
    const p = normalizeToolParams({ query: "x", before: "2", after: "#3" });
    expect(p.before).toBe(2);
    expect(p.after).toBe(3);
    const bad = normalizeToolParams({ query: "x", before: "lots" });
    expect(bad.before).toBeUndefined();
    expect(bad._vccDropped).toBeDefined();
  });
});

describe("parseToolRequest (grep profile)", () => {
  it("routes '#N' and index lists to expand", () => {
    expect(parseToolRequest({ query: "#1253" }, "grep").action).toEqual({ kind: "expand", indices: [1253] });
    expect(parseToolRequest({ query: "12 15" }, "grep").action).toEqual({ kind: "expand", indices: [12, 15] });
    expect(parseToolRequest({ query: "#12, #15" }, "grep").action).toEqual({ kind: "expand", indices: [12, 15] });
  });

  it("routes keywords to a grep action with default context", () => {
    expect(parseToolRequest({ query: "redis cache" }, "grep").action)
      .toEqual({ kind: "grep", query: "redis cache", before: 1, after: 1 });
    expect(parseToolRequest({ query: "redis", before: 3 }, "grep").action)
      .toEqual({ kind: "grep", query: "redis", before: 3, after: 1 });
  });

  it("keeps #N:path drill-down and the recent fallback", () => {
    expect(parseToolRequest({ query: "#5:auth.ts" }, "grep").action.kind).toBe("drill");
    expect(parseToolRequest({}, "grep").action.kind).toBe("recent");
  });

  it("names params the grep action does not use", () => {
    const r = parseToolRequest({ query: "x", page: 3 }, "grep");
    expect(r.ignored).toEqual(["page"]);
  });
});

describe("runGrep", () => {
  // Created per test: the module-level afterEach removes temp dirs after every
  // test in this file, so a describe-body fixture would be deleted too early.
  const setup = () => {
    const file = writeSession([
      msg("m0", "user", "please fix the redis cache layer"),
      msg("m1", "assistant", "Looking at the cache config now."),
      msg("m2", "toolResult", "redis_version: 7.2\nmaxmemory: 512mb"),
      msg("m3", "assistant", "The cache TTL was the problem.\nFixed the eviction policy."),
      msg("m4", "user", "good, now run the tests"),
    ]);
    return { file, v: view(file, ["m0", "m1", "m2", "m3", "m4"]) };
  };

  it("returns matching lines in entry blocks with #N and role", () => {
    const { v } = setup();
    const out = runGrep("redis", v);
    expect(out).toContain('grep "redis": 2 matching lines in 2 of 5 entries');
    expect(out).toContain("#0 [user]");
    expect(out).toContain("please fix the redis cache layer");
    expect(out).toContain("#2 [tool_result]");
    expect(out).toContain("redis_version: 7.2");
  });

  it("shows one line per match inside one entry", () => {
    const { v } = setup();
    const out = runGrep("TTL|eviction", v);
    expect(out).toContain("The cache TTL was the problem.");
    expect(out).toContain("Fixed the eviction policy.");
  });

  it("adds before/after context entries as one-liners", () => {
    const { v } = setup();
    const out = runGrep("maxmemory", v, { before: 1, after: 1 });
    expect(out).toContain("  > #1 [assistant] Looking at the cache config now.");
    expect(out).toContain("  > #3 [assistant]");
  });

  it("keeps before/hit/after context chronological and deduplicates shared neighbors", () => {
    const file = writeSession([
      msg("m0", "user", "lead in"),
      msg("m1", "assistant", "target one"),
      msg("m2", "assistant", "shared neighbor"),
      msg("m3", "assistant", "target two"),
      msg("m4", "assistant", "tail"),
    ]);
    const out = runGrep("target", view(file, ["m0", "m1", "m2", "m3", "m4"]), { before: 1, after: 1 });
    const refs = [...out.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    expect(refs).toEqual([0, 1, 2, 3, 4]);
    expect(out.match(/^  > #2 /gm)).toHaveLength(1);
  });

  it("before:0/after:0 drops context entirely", () => {
    const { v } = setup();
    const out = runGrep("maxmemory", v, { before: 0, after: 0 });
    expect(out).not.toContain("  > #");
  });

  it("is case-insensitive by default", () => {
    const { v } = setup();
    const out = runGrep("REDIS", v);
    expect(out).toContain("redis_version");
  });

  it("falls back to per-term OR when the literal phrase matches nothing", () => {
    const { v } = setup();
    const out = runGrep("redis eviction", v);
    expect(out).toContain("redis_version");
    expect(out).toContain("eviction policy");
  });

  it("accepts a regex query", () => {
    const { v } = setup();
    const out = runGrep("maxmemory|TTL", v);
    expect(out).toContain("maxmemory: 512mb");
    expect(out).toContain("The cache TTL was the problem.");
  });

  it("says no matches with a refine hint", () => {
    const { v } = setup();
    const out = runGrep("nothing-matches-this", v);
    expect(out).toContain("No matches");
    expect(out).toContain("Refine or shorten the query");
  });

  it("skips the current turn when asked to", () => {
    const { v } = setup();
    const out = runGrep("tests", v, { skip: new Set([4]) });
    expect(out).toContain("already in your context");
  });

  it("caps output lines and says how many were omitted", () => {
    const many = writeSession(
      Array.from({ length: 60 }, (_, i) => msg(`g${i}`, "assistant", `line about target number ${i}`)),
    );
    const all = Array.from({ length: 60 }, (_, i) => `g${i}`);
    const out = runGrep("target", view(many, all));
    expect(out).toMatch(/more matching lines/);
    const bodyLines = out.split("\n").filter((l) => l.startsWith("  line about"));
    expect(bodyLines.length).toBeLessThanOrEqual(40);
  });

  it("routes #N:path drill-down through the same param", () => {
    const { v } = setup();
    const out = runGrep("#2:nonexistent-file.txt", v);
    expect(out.toLowerCase()).toContain("no file");
  });
});

describe("grep profile registration", () => {
  it("declares a lean surface: query + before + after only", () => {
    let tool: any;
    registerRecallTool({ registerTool: (t: any) => { tool = t; } } as any, "grep");
    expect(tool.name).toBe("vcc_recall");
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(["after", "before", "query"]);
    expect(tool.parameters.required).toEqual(["query"]);
  });

  it("pins the declaration sizes and keeps grep far below the full profile", () => {
    let grepTool: any;
    let fullTool: any;
    registerRecallTool({ registerTool: (t: any) => { grepTool = t; } } as any, "grep");
    registerRecallTool({ registerTool: (t: any) => { fullTool = t; } } as any, "full");
    const size = (t: any) =>
      JSON.stringify({ description: t.description, promptSnippet: t.promptSnippet, parameters: t.parameters }).length;
    expect(size(grepTool)).toBe(773);
    expect(size(fullTool)).toBe(2395);
    expect(size(grepTool)).toBeLessThan(size(fullTool) / 2);
  });

  it("executes a grep query end to end", async () => {
    // Ends on a user message: the tool call that runs vcc_recall follows it in
    // a real turn, and findCurrentTurn then treats the whole visible span as
    // already-in-context only when entries follow the last user message.
    const f = writeSession([
      msg("m0", "user", "discuss the kafka topic"),
      msg("m1", "assistant", "kafka is fine"),
      msg("m2", "user", "continue later"),
    ]);
    let tool: any;
    registerRecallTool({ registerTool: (t: any) => { tool = t; } } as any, "grep");
    const result = await tool.execute("call", { query: "kafka" }, undefined, undefined, {
      sessionManager: {
        getSessionFile: () => f,
        getBranch: () => [{ id: "m0" }, { id: "m1" }, { id: "m2" }],
        getEntries: () => [{ id: "m0" }, { id: "m1" }, { id: "m2" }],
      },
    });
    expect(result.content[0].text).toContain("kafka is fine");
  });
});
