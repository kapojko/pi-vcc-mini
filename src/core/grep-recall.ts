import type { Message } from "@earendil-works/pi-ai";
import { safeRegex, searchableText } from "./search-entries";
import { clip } from "./content";
import type { RenderedEntry } from "./render-entries";
import type { RecallView } from "./recall-run";
import { expandEntryFile } from "./drill-down";
import { parseDrillDown } from "./drill-down";

/**
 * grep-style recall (pi-vcc-mini "grep" profile).
 *
 * One string query in, matching LINES out — the idiom coding models already
 * run all day with grep/rg. Granularity is the line, not the entry: one call
 * returns at most a few hundred chars of matched lines plus optional neighbor
 * entries, instead of whole entries. Chronological order (grep output), not
 * relevance: matches are collected in session order.
 *
 * Matching chain, mirroring search-entries' mode detection without its
 * ranking: literal/regex over the whole query first, then — only when that
 * yields nothing and the query is multi-word — per-term OR, so a natural
 * query like "redis cache decision" still hits.
 */

/** Matched lines shown per call (all entries combined). */
export const GREP_MAX_LINES = 40;
/** Entries whose hits are rendered (context entries excluded from this cap). */
export const GREP_MAX_ENTRIES = 15;
/** One matched line's display cap. */
const GREP_LINE_CHARS = 240;
/** One context entry's display cap. */
const CONTEXT_CHARS = 200;

export interface GrepHitLine {
  entryIndex: number;
  line: string;
}

export interface GrepOptions {
  /** Entries of context before/after each hit entry. */
  before?: number;
  after?: number;
  /** Indices to leave out of the corpus (the current turn, see recall-run). */
  skip?: Set<number>;
}

/** Entry lines, one string per source line (empty lines dropped). */
const entryLines = (msg: Message | undefined, e: RenderedEntry): string[] => {
  const text = searchableText(msg, e);
  if (!text) return e.summary ? e.summary.split("\n") : [];
  return text.split("\n");
};

const matchLine = (line: string, matcher: RegExp): boolean => matcher.test(line);

/** Build the primary matcher: the whole query as literal (or regex if it looks like one). */
const primaryMatcher = (query: string): RegExp => safeRegex(query);

/** Fallback matcher for multi-word queries: per-term OR. */
const termMatcher = (query: string): RegExp | undefined => {
  const terms = query.split(/\s+/).filter((t) => t.length > 1);
  if (terms.length < 2) return undefined;
  return new RegExp(terms.map((t) => safeRegex(t).source).join("|"), "i");
};

export interface GrepResult {
  /** Rendered output (header, hits, context, footer). */
  text: string;
  /** Stats for callers that want them. */
  totalLines: number;
  totalEntries: number;
}

const formatContextEntry = (e: RenderedEntry): string =>
  `  > #${e.index} [${e.role}] ${clip(e.summary.replace(/\n+/g, " "), CONTEXT_CHARS)}`;

export const grepLines = (
  rendered: RenderedEntry[],
  rawMessages: Message[],
  query: string,
  skip?: Set<number>,
): { lines: GrepHitLine[]; totalLines: number; totalEntries: number } => {
  const corpus: Array<{ e: RenderedEntry; msg: Message | undefined }> = [];
  for (let i = 0; i < rendered.length; i++) {
    if (skip?.has(rendered[i].index)) continue;
    corpus.push({ e: rendered[i], msg: rawMessages[i] });
  }

  const collect = (matcher: RegExp): GrepHitLine[] => {
    const out: GrepHitLine[] = [];
    for (const { e, msg } of corpus) {
      for (const line of entryLines(msg, e)) {
        if (line.trim() && matchLine(line, matcher)) out.push({ entryIndex: e.index, line });
        if (out.length > 5000) return out; // hard bound before rendering caps
      }
    }
    return out;
  };

  // Reset lastIndex paranoia: safeRegex returns non-global regexes, but be explicit.
  let hits = collect(primaryMatcher(query));
  if (hits.length === 0) {
    const fallback = termMatcher(query);
    if (fallback) hits = collect(fallback);
  }

  const entriesWithHits = new Set(hits.map((h) => h.entryIndex));
  return { lines: hits, totalLines: hits.length, totalEntries: entriesWithHits.size };
};

export const runGrep = (
  query: string,
  view: RecallView,
  opts: GrepOptions = {},
): string => {
  const before = Math.max(0, Math.min(10, opts.before ?? 1));
  const after = Math.max(0, Math.min(10, opts.after ?? 1));
  const { rendered, rawMessages } = view.load(false);

  // #N:path drill-down stays reachable through the same string param.
  const target = parseDrillDown(query);
  if (target) {
    return expandEntryFile(view.sessionFile, target.index, target.pathPattern, target.full, target.offset, target.limit);
  }

  const { lines, totalLines, totalEntries } = grepLines(rendered, rawMessages, query, opts.skip);

  if (lines.length === 0 && view.scope === "lineage") {
    const wide = view.widen();
    if (grepLines(wide.load(false).rendered, wide.load(false).rawMessages, query, opts.skip).lines.length > 0) {
      return "Nothing on the current conversation path; showing edited or retried branches (scope:'all').\n\n" +
        runGrep(query, wide, opts);
    }
  }
  if (lines.length === 0 && opts.skip?.size) {
    const inTurn = grepLines(rendered, rawMessages, query).lines.filter((h) => opts.skip!.has(h.entryIndex)).length;
    if (inTurn > 0) {
      return `No earlier matches for "${query}"; its ${inTurn} match${inTurn === 1 ? " is" : "es are"} in the current turn, which is already in your context.`;
    }
  }

  const total = rendered.length;
  const header = `grep "${query}": ${totalLines} matching line${totalLines === 1 ? "" : "s"} in ${totalEntries} of ${total} entries${view.scope === "all" ? " (scope: all)" : ""}`;

  if (lines.length === 0) {
    return `${header}\n\nNo matches. Refine or shorten the query; case is ignored.`;
  }

  // Group by entry, chronological; cap lines and entries.
  const byEntry = new Map<number, string[]>();
  for (const h of lines) {
    if (!byEntry.has(h.entryIndex)) byEntry.set(h.entryIndex, []);
    if (byEntry.size > GREP_MAX_ENTRIES || byEntry.get(h.entryIndex)!.length >= 10) continue;
    byEntry.get(h.entryIndex)!.push(clip(h.line.trim(), GREP_LINE_CHARS));
  }
  let shownLines = 0;
  const parts: string[] = [];
  const groups = [...byEntry].map(([entryIndex, entryHitLines]) => {
    const pos = rendered.findIndex((entry) => entry.index === entryIndex);
    return { entry: rendered[pos], entryHitLines, pos };
  });
  const renderedContext = new Set<number>();
  const addContext = (pos: number) => {
    if (renderedContext.has(pos)) return;
    renderedContext.add(pos);
    parts.push(formatContextEntry(rendered[pos]));
  };

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    if (shownLines >= GREP_MAX_LINES) break;
    const { entry, entryHitLines, pos } = groups[groupIndex];
    // Do not cross a neighboring hit: this keeps the complete output in
    // chronological order and prevents another hit from becoming context.
    const previousHitPos = groupIndex > 0 ? groups[groupIndex - 1].pos : -1;
    const nextHitPos = groupIndex + 1 < groups.length ? groups[groupIndex + 1].pos : rendered.length;
    for (let j = Math.max(previousHitPos + 1, pos - before); j < pos; j++) addContext(j);

    parts.push(`#${entry.index} [${entry.role}]`);
    for (const line of entryHitLines) {
      if (shownLines >= GREP_MAX_LINES) break;
      parts.push(`  ${line}`);
      shownLines++;
    }
    for (let j = pos + 1; j <= Math.min(nextHitPos - 1, pos + after); j++) addContext(j);
  }

  const omittedLines = totalLines - shownLines;
  const footer = omittedLines > 0
    ? `\n\n...(${omittedLines} more matching lines) — refine the query for fewer results.`
    : "";

  const skippedNote = opts.skip?.size ? "\n\n(searched entries before the current turn)" : "";
  return `${header}\n\n${parts.join("\n")}${footer}${skippedNote}`;
};
