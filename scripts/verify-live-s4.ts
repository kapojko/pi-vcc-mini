/**
 * Live S4 verification: threshold-path checkpoint pinning + replacement.
 *
 *   turn 1 (small)        -> turn_end checkpoint #1 (marker + note #1)
 *   turn 2 (big paste)    -> makes the kept tail > smart-keep min, so the
 *                            cut at compact #1 puts exchange #1 in the
 *                            summarized PREFIX -> [Checkpoint] pinned
 *   compact #1            -> no interception (window covered), direct
 *                            compaction, [Checkpoint] #1 must lead summary
 *   turn 3 (small)        -> new window: before_agent_start checkpoint #2
 *   turn 4 (big paste)    -> exchange #2 falls into the prefix at compact #2
 *   compact #2            -> [Checkpoint] #2 REPLACES #1 (exactly one
 *                            section, newest content)
 *
 * Needs checkpointThreshold low (e.g. 0.001) in ~/.pi/agent/pi-vcc-mini.json.
 * Run: PI_VCC_CKPT_DEBUG=1 bun run scripts/verify-live-s4.ts
 */
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";

// Machine-specific knobs (all optional): PI_VCC_VERIFY_DIR, PI_VCC_AGENT_DIR,
// PI_VCC_EXTRA_EXT — see scripts/verify-live-s3s4.ts.
const CWD = process.env.PI_VCC_VERIFY_DIR ?? join(tmpdir(), "pi-vcc-mini-verify-s4");
mkdirSync(CWD, { recursive: true });
const extensionUnderTest = resolve(import.meta.dir, ".."); // this working tree

const bigPaste = (label: string, lines: number) =>
  `Remember this specification verbatim (part ${label}):\n` +
  Array.from({ length: lines }, (_, i) =>
    `${label}-${i}: alpha beta gamma delta epsilon zeta eta theta iota kappa memory cache latency throughput quantization inference token model server context`)
    .join("\n");

const resourceLoader = new DefaultResourceLoader({
  cwd: CWD,
  agentDir: process.env.PI_VCC_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  noExtensions: true,
  additionalExtensionPaths: [
    join(extensionUnderTest, "index.ts"),
    ...(process.env.PI_VCC_EXTRA_EXT ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ],
});
await resourceLoader.reload();

const { session } = await createAgentSession({ cwd: CWD, resourceLoader });
console.log("model:", `${(session as any).model?.provider}/${(session as any).model?.id}`);

const entries = (): any[] =>
  readFileSync(
    (session as unknown as { sessionManager: { getSessionFile(): string } }).sessionManager.getSessionFile(),
    "utf8",
  ).trim().split("\n").map((l) => JSON.parse(l));

const countMarkers = () => entries().filter((e) => e.type === "custom_message" && e.customType === "vcc-checkpoint-request").length;
const compactions = () => entries().filter((e) => e.type === "compaction");

try {
  console.log("--- turn 1: small (checkpoint #1 should fire at turn_end)");
  await session.prompt("Read notes.txt in this directory and summarize it in one sentence.");
  await session.waitForIdle();
  console.log("markers after turn 1:", countMarkers(), "(expect 1)");

  console.log("--- turn 2: big paste (tail anchor)");
  await session.prompt(bigPaste("A", 1200) + "\n\nAcknowledge in one sentence that you stored the specification.");
  await session.waitForIdle();

  console.log("--- compact #1 (direct, no interception; [Checkpoint] #1 must be pinned)");
  try {
    await session.compact();
    console.log("compact #1 returned normally");
  } catch (e) {
    console.log("compact #1 threw:", (e as Error).message);
  }
  await session.waitForIdle();
  const c1 = compactions();
  console.log("compactions:", c1.length);
  if (c1.length) {
    const s = c1[c1.length - 1].summary as string;
    console.log("summary #1 starts with [Checkpoint]:", s.startsWith("[Checkpoint]"));
    console.log("[Checkpoint] occurrences:", (s.match(/^\[Checkpoint\]/gm) ?? []).length, "(expect 1)");
    console.log("--- summary #1 head ---");
    console.log(s.slice(0, 900));
  }

  console.log("--- turn 3: small (checkpoint #2 should fire via before_agent_start)");
  await session.prompt("Read notes.txt again and give me one key point from it.");
  await session.waitForIdle();
  console.log("markers after turn 3:", countMarkers(), "(expect 2)");

  console.log("--- turn 4: big paste (tail anchor #2)");
  await session.prompt(bigPaste("B", 1200) + "\n\nAcknowledge in one sentence that you stored the specification.");
  await session.waitForIdle();

  console.log("--- compact #2 ([Checkpoint] #2 must REPLACE #1: exactly one section, newest note)");
  try {
    await session.compact();
    console.log("compact #2 returned normally");
  } catch (e) {
    console.log("compact #2 threw:", (e as Error).message);
  }
  await session.waitForIdle();
  const c2 = compactions();
  console.log("compactions:", c2.length);
  if (c2.length >= 2) {
    const s = c2[c2.length - 1].summary as string;
    console.log("summary #2 starts with [Checkpoint]:", s.startsWith("[Checkpoint]"));
    console.log("[Checkpoint] occurrences:", (s.match(/^\[Checkpoint\]/gm) ?? []).length, "(expect 1 — replaced, not accumulated)");
    console.log("--- summary #2 head ---");
    console.log(s.slice(0, 900));
  }
} finally {
  session.dispose();
}
