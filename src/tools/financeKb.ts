import { tool } from "ai";
import { z } from "zod";

export const lookupFinance = tool({
  description: "Look up sourced Indian finance facts by topic, such as gst_registration or mudra_limits.",
  inputSchema: z.strictObject({
    topicIds: z.array(z.string().min(1)).min(1),
  }),
  async execute() {
    return "No verified finance records are available for this lookup.";
  },
});
