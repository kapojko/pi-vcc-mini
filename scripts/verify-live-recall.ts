/**
 * Live grep-recall verification (runs with whatever model pi defaults to).
 *
 * The fact under test lives ONLY in a turn-1 toolResult (file read). Turn 2
 * adds compaction mass, manual compact pushes turn 1 into the summarized
 * prefix, the file is deleted from disk, and the model is asked for the fact
 * with vcc_recall as the only remaining source.
 *
 * Checks (from the session JSONL):
 *  R1  compaction ran; turn-1 exchange is in the summarized prefix
 *  R2  the summary does NOT carry the raw fact (retrieval is genuinely needed)
 *  R3  a vcc_recall toolCall was made with a sensible query
 *  R4  the tool result carries the fact in grep format (#N entry headers)
 *  R5  the final answer quotes the fact correctly
 *
 * Run: PI_VCC_CKPT_DEBUG=1 bun run scripts/verify-live-recall.ts
 */
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";

// Machine-specific knobs (all optional): PI_VCC_VERIFY_DIR, PI_VCC_AGENT_DIR,
// PI_VCC_EXTRA_EXT — see scripts/verify-live-s3s4.ts.
const CWD = process.env.PI_VCC_VERIFY_DIR ?? join(tmpdir(), "pi-vcc-mini-verify-recall");
const extensionUnderTest = resolve(import.meta.dir, ".."); // this working tree
const FACT_FILE = `${CWD}/config-notes.txt`;
const API_KEY = "ZEBRA-42-ORCHID-77";
const BACKUP_CODE = "NARWHAL-1907";

mkdirSync(CWD, { recursive: true });
rmSync(`${CWD}/.pi`, { recursive: true, force: true });
rmSync(FACT_FILE, { force: true });
writeFileSync(
  FACT_FILE,
  [
    "# deployment notes (scratch)",
    "region = eu-north-1",
    `API_KEY = ${API_KEY}`,
    "max_workers = 8",
    `backup_code = ${BACKUP_CODE}`,
    "feature_flags = dark-mode,beta-ui",
    "",
  ].join("\n"),
);

const bigPaste = (label: string, lines: number) =>
  `Store this specification part ${label} verbatim in your context (do NOT write it to a file, just acknowledge):\n` +
  Array.from({ length: lines }, (_, i) => `${label}-${i}: alpha beta gamma delta epsilon zeta eta theta iota kappa memory cache latency throughput quantization inference token model server context`)
    .join("\n");

const resourceLoader = new DefaultResourceLoader({
  cwd: CWD,
  agentDir: process.env.PI_VCC_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  noExtensions: true,
  additionalExtensionPaths: [
    // Working tree (installed copy lags until commit + reinstall).
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

type Entry = {
  type: string;
  message?: { role: string; content: unknown };
  summary?: string;
};
const entries = (): Entry[] =>
  readFileSync((session as any).sessionManager.getSessionFile(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (b.type === "text" ? b.text : b.type === "toolCall" ? `<toolCall:${b.name} ${JSON.stringify(b.arguments)}>` : ""))
    .join(" ");
};

try {
  console.log("--- turn 1: read config-notes.txt (fact enters a toolResult)");
  await session.prompt("Read the file config-notes.txt in this directory and tell me its most important line in one sentence.");

  console.log("--- turn 2: big paste (compaction mass)");
  await session.prompt(bigPaste("A", 1200) + "\n\nAcknowledge in one sentence.");

  console.log("--- compact (turn 1 must fall into the summarized prefix)");
  await session.compact("keep the recent specification work; earlier file reads are no longer needed");
  await session.waitForIdle();

  let es = entries();
  const compactions = es.filter((e) => e.type === "compaction");
  const summaryText = compactions.map((c) => String(c.summary ?? "")).join("\n");
  const turn1Gone = !textOf(es[0]?.message?.content).includes("config-notes"); // prefix replaced by compaction entry
  console.log("R1 compactions:", compactions.length, "| first entry now:", es[0]?.type);
  console.log("R2 raw fact in summary:", summaryText.includes(API_KEY) || summaryText.includes(BACKUP_CODE) ? "PRESENT (weakens test)" : "absent (retrieval genuinely needed)");

  console.log("--- file deleted from disk; turn 3: recall question");
  rmSync(FACT_FILE);
  await session.prompt(
    "The file config-notes.txt has been deleted from disk. " +
      "What exact value was stored on its API_KEY line, and what was the backup_code? " +
      "Use the vcc_recall tool to search the raw session history (compacted parts included) and quote the matching lines.",
  );

  es = entries();
  const msgs = es.filter((e) => e.type === "message") as Required<Entry>[];
  const recallCalls = msgs.filter((m) =>
    Array.isArray(m.message.content) &&
    m.message.content.some((b: any) => b.type === "toolCall" && b.name === "vcc_recall"),
  );
  const lastAssistantTexts = msgs
    .filter((m) => m.message.role === "assistant")
    .map((m) => textOf(m.message.content))
    .filter((t) => t.trim() && !t.includes("<toolCall"));
  const finalAnswer = lastAssistantTexts[lastAssistantTexts.length - 1] ?? "";

  // R3: query of the (last) vcc_recall call
  const lastCall = recallCalls.flatMap((m) =>
    (m.message.content as any[]).filter((b) => b.type === "toolCall" && b.name === "vcc_recall"),
  ).pop();
  console.log("R3 vcc_recall calls:", recallCalls.length, "| last query:", JSON.stringify(lastCall?.arguments ?? null));

  // R4: tool result carries the fact with grep-format entry headers
  const toolResults = msgs
    .filter((m) => m.message.role === "toolResult")
    .map((m) => textOf(m.message.content))
    .filter((t) => t.includes("API_KEY") || t.includes("NARWHAL"));
  console.log("R4 result hits fact:", toolResults.length > 0, "| grep #N headers:", /#\d+/.test(toolResults[0] ?? ""));
  if (toolResults[0]) console.log(toolResults[0].slice(0, 600));

  // R5: final answer quotes both facts
  console.log("R5 final answer has API_KEY:", finalAnswer.includes(API_KEY), "| backup_code:", finalAnswer.includes(BACKUP_CODE));
  console.log("--- final answer ---\n" + finalAnswer.slice(0, 700));
} finally {
  session.dispose();
}
