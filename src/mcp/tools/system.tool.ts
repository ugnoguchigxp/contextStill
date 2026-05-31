import { runDoctor } from "../../modules/doctor/doctor.service.js";
import { readProjectEnv } from "../../project-identity.js";
import { buildInitialInstructionsText } from "../../shared/locales/initial-instructions.js";
import { resolveLocale } from "../../shared/locales/locale.js";

export const initialInstructionsTool = {
  name: "initial_instructions",
  description: "Get concise MCP operating guidance and the recommended tool flow.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  handler: async () => {
    const locale = resolveLocale(readProjectEnv("LANG"));
    return {
      content: [{ type: "text", text: buildInitialInstructionsText(locale) }],
    };
  },
};

export const doctorTool = {
  name: "doctor",
  description: "Run diagnostic checks on the contextStill system (Gnosis compatible).",
  inputSchema: {
    type: "object",
    properties: {},
  },
  handler: async () => {
    const report = await runDoctor();
    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  },
};
