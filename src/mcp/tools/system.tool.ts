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
      "2. Source は wiki そのものです。人間入力は wiki markdown に集約し、そこから Knowledge を蒸留してください。",
      "3. Vibe Memory は LLM との会話ログです。作業終了時には record_vibe_memory で会話要約と diff を記録してください。",
      "4. agent_diff は Vibe Memory 中の編集差分です。file content は保存せず、diff_hunk と抽出できた symbol 列だけを残してください。",
      "5. 重複する知識を避け、既存の知見がある場合はそれを更新（Update）または拡張してください。",
      "6. Knowledge は fact / rule / procedure / lesson、status は draft / active / deprecated、scope は repo / global だけを使ってください。",
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
