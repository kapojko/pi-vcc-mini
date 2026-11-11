import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerCheckpointSystem } from "./src/hooks/checkpoint";
import { registerPiVccCommand } from "./src/commands/pi-vcc";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerRecallTool } from "./src/tools/recall";

export default (pi: ExtensionAPI) => {
  registerCheckpointSystem(pi);
  registerBeforeCompactHook(pi);
  registerPiVccCommand(pi);
  registerVccRecallCommand(pi);
  registerRecallTool(pi);
};
