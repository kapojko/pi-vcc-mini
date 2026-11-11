/**
 * Live S3/S4 verification: manual compaction interception + [Checkpoint]
 * pinning, driven through the SDK (session.compact() is the same manual
 * entry point /compact uses).
 *
 * Run: PI_VCC_CKPT_DEBUG=1 bun run scripts/verify-live-s3s4.ts
 */
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";

// Machine-specific knobs (all optional):
//   PI_VCC_VERIFY_DIR  scratch cwd for the test session
//   PI_VCC_AGENT_DIR   pi agent dir (default: ~/.pi/agent)
//   PI_VCC_EXTRA_EXT   extra extension entry points for the loader,
//                      comma-separated (default: none)
const CWD = process.env.PI_VCC_VERIFY_DIR ?? join(tmpdir(), "pi-vcc-mini-verify-s3s4");
mkdirSync(CWD, { recursive: true });
const extensionUnderTest = resolve(import.meta.dir, ".."); // this working tree

const resourceLoader = new DefaultResourceLoader({
  cwd: CWD,
  agentDir: process.env.PI_VCC_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  noExtensions: true,
  additionalExtensionPaths: [
    // The working tree (the fix under verification); the installed copy
    // lags until this is committed + reinstalled.
    join(extensionUnderTest, "index.ts"),
    ...(process.env.PI_VCC_EXTRA_EXT ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ],
});
// A caller-supplied loader is not reloaded by createAgentSession.
await resourceLoader.reload();

const { session } = await createAgentSession({ cwd: CWD, resourceLoader });
console.log("model:", `${(session as any).model?.provider}/${(session as any).model?.id}`);

const dump = (label: string) => {
  const file = (session as unknown as { sessionManager: { getSessionFile(): string } }).sessionManager.getSessionFile();
  const lines = readFileSync(file, "utf8").trim().split("\n");
  console.log(`\n===== ${label} (${lines.length} entries) =====`);
  for (const line of lines) {
    const e = JSON.parse(line);
    const t = e.type;
    if (t === "message") {
      const c = e.message.content;
      const text = typeof c === "string" ? c : (Array.isArray(c) ? c : [])
        .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text : `<${b.type}>`))
        .join(" ");
      console.log(`  [${e.message.role}] ${text.slice(0, 110).replace(/\n/g, " ")}`);
    } else if (t === "custom_message") {
      console.log(`  <custom_message ${e.customType}>`);
    } else if (t === "compaction") {
      console.log(`  <compaction> summary starts: ${String(e.summary).slice(0, 300).replace(/\n/g, " ")}`);
    } else if (t !== "session" && t !== "model_change" && t !== "thinking_level_change") {
      console.log(`  <${t}>`);
    }
  }
};

try {
  // Self-contained fixtures: big enough that pi's compaction accepts the
  // session ("Nothing to compact" below its minimum) — a fresh empty dir
  // otherwise makes both manual compacts no-ops.
  const fixture = (name: string, topic: string) => {
    const file = join(CWD, name);
    if (!existsSync(file)) {
      writeFileSync(
        file,
        Array.from({ length: 350 }, (_, i) => `${topic} item ${i}: alpha beta gamma delta epsilon memory cache latency throughput quantization inference server context`).join("\n") + "\n",
      );
    }
  };
  fixture("report.txt", "report");
  fixture("notes.txt", "notes");

  console.log("--- turn 1: read report.txt");
  await session.prompt("Read the file report.txt in this directory and summarize it in three sentences.");
  console.log("--- turn 2: read notes.txt");
  await session.prompt("Now read notes.txt and list its key points in two sentences.");

  console.log("--- manual compact #1 (S3: intercept -> checkpoint -> re-trigger)");
  try {
    await session.compact("keep the file names and their summaries");
    console.log("compact #1 returned normally");
  } catch (e) {
    console.log("compact #1 threw:", (e as Error).message);
  }
  // The cancelled compact leaves the checkpoint turn (and the re-triggered
  // compaction after it) running in the background.
  await session.waitForIdle();
  dump("after compact #1");

  console.log("--- turn 3: small follow-up");
  await session.prompt("In one word, how many files did you read?");

  console.log("--- manual compact #2 (S4: second window, checkpoint replaced)");
  try {
    await session.compact("keep the checkpoint note verbatim");
    console.log("compact #2 returned normally");
  } catch (e) {
    console.log("compact #2 threw:", (e as Error).message);
  }
  await session.waitForIdle();
  dump("after compact #2");
} finally {
  session.dispose();
}
