import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AUTOMATIC_CHECKPOINT_ENDING,
  DEFAULT_CHECKPOINT_PROMPT,
  DEFAULT_SETTINGS,
  LEGACY_CHECKPOINT_PROMPT_1_0_1,
  LEGACY_DEFAULT_CHECKPOINT_PROMPT,
  loadSettings,
} from "../src/core/settings";

let dir: string;
let configPath: string;
let previousConfigPath: string | undefined;

beforeEach(() => {
  previousConfigPath = process.env.PI_VCC_CONFIG_PATH;
  dir = mkdtempSync(join(tmpdir(), "pi-vcc-settings-"));
  configPath = join(dir, "config.json");
  process.env.PI_VCC_CONFIG_PATH = configPath;
});

afterEach(() => {
  if (previousConfigPath === undefined) delete process.env.PI_VCC_CONFIG_PATH;
  else process.env.PI_VCC_CONFIG_PATH = previousConfigPath;
});

describe("config loading", () => {
  it("returns full defaults when no config file exists", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("loads the new default when the config contains the exact legacy built-in", () => {
    writeFileSync(configPath, JSON.stringify({ checkpointPrompt: LEGACY_DEFAULT_CHECKPOINT_PROMPT }));
    expect(loadSettings().checkpointPrompt).toBe(DEFAULT_CHECKPOINT_PROMPT);
  });

  it("loads the new default when the config contains the previous (1.0.1) built-in", () => {
    writeFileSync(configPath, JSON.stringify({ checkpointPrompt: LEGACY_CHECKPOINT_PROMPT_1_0_1 }));
    expect(loadSettings().checkpointPrompt).toBe(DEFAULT_CHECKPOINT_PROMPT);
  });

  it("keeps the automatic ending in the default prompt", () => {
    expect(DEFAULT_CHECKPOINT_PROMPT).toContain(AUTOMATIC_CHECKPOINT_ENDING);
    expect(AUTOMATIC_CHECKPOINT_ENDING).toContain("Do not end the run with the note alone");
    expect(DEFAULT_CHECKPOINT_PROMPT).not.toContain("Afterward, resume the task normally.");
  });

  it("preserves a custom checkpoint prompt", () => {
    writeFileSync(configPath, JSON.stringify({ checkpointPrompt: "My custom checkpoint." }));
    expect(loadSettings().checkpointPrompt).toBe("My custom checkpoint.");
  });

  it("pins explicitly set keys and defaults the rest", () => {
    writeFileSync(configPath, JSON.stringify({ checkpointThreshold: 0.75 }));
    const settings = loadSettings();
    expect(settings.checkpointThreshold).toBe(0.75);
    expect(settings.checkpointPrompt).toBe(DEFAULT_CHECKPOINT_PROMPT);
    expect(settings.recallProfile).toBe("grep");
  });
});
