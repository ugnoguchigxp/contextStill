import { runDoctor } from "../../modules/doctor/doctor.service.js";

export const initialInstructionsTool = {
  name: "initial_instructions",
  description:
    "Get the minimum operational rules for Agent-First knowledge management (Gnosis compatible).",
  inputSchema: {
    type: "object",
    properties: {},
  },
  handler: async () => {
    const rules = [
      "1. いかなる時も日本語で返答してください。",
      "2. 知識（Knowledge Item）は、根拠となる Vibe Memory や AI Artifact と紐付けて管理してください。",
      "3. 重複する知識を避け、既存の知見がある場合はそれを更新（Update）または拡張してください。",
      "4. セッションの最後には必ず Vibe Memory を記録し、知見を蒸留する準備を整えてください。",
    ].join("\n");
    return {
      content: [{ type: "text", text: rules }],
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
