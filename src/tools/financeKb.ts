import type { AgentTool } from "@earendil-works/pi-agent-core";
import Type from "typebox";

const parameters = Type.Object({
  topicIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
}, { additionalProperties: false });

export const lookupFinance: AgentTool<typeof parameters> = {
  name: "lookup_finance",
  label: "Look up finance facts",
  description: "Look up sourced Indian finance facts by topic, such as gst_registration or mudra_limits.",
  parameters,
  async execute() {
    return {
      content: [{ type: "text", text: "No verified finance records are available for this lookup." }],
      details: { records: [] },
    };
  },
};
