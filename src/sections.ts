export interface SectionData {
  earlyRequests: string[];
  filesAndChanges: string[];
  commits: string[];
  userMessages: string[];
  /** Populated only when settings.trackCommands is non-empty -- see
   * core/settings.ts. Empty array otherwise, same as any other section
   * with nothing to report. */
  trackedCommands: string[];
  /**
   * pi-vcc-mini: the model-written pre-compaction checkpoint, verbatim
   * (already capped by the caller). Free text, not "- " items; rendered as
   * the leading [Checkpoint] section and replaced (not merged) on every
   * compaction that has a newer one.
   */
  checkpoint?: string;
  briefTranscript: string;
}
