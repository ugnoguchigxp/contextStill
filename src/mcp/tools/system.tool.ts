import { runDoctor } from "../../modules/doctor/doctor.service.js";
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
    const locale = resolveLocale(process.env.MEMORY_ROUTER_LANG);
    return {
      content: [{ type: "text", text: buildInitialInstructionsText(locale) }],
    };
  },
};

export const doctorTool = {
  name: "doctor",
  description: "Run diagnostic checks on the memory-router system (Gnosis compatible).",
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
