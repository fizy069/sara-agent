import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Decimal } from "decimal.js";
import Type from "typebox";

const parameters = Type.Object({
  principal: Type.Number({ exclusiveMinimum: 0, description: "Loan principal in rupees" }),
  annualRatePct: Type.Number({ minimum: 0, description: "Annual interest as a percentage, e.g. 12 for 12%" }),
  tenureMonths: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false });

// Leave room for subtraction when a positive monthly rate is very close to zero.
const Money = Decimal.clone({ precision: 350, rounding: Decimal.ROUND_HALF_UP });

export const calculateEmi: AgentTool<typeof parameters> = {
  name: "calculate_emi",
  label: "Calculate EMI",
  description: "Calculate the fixed monthly loan repayment in INR. Requires principal, annual rate, and tenure in months.",
  parameters,
  async execute(_id, { principal, annualRatePct, tenureMonths }) {
    if (!Number.isFinite(principal) || principal <= 0 ||
        !Number.isFinite(annualRatePct) || annualRatePct < 0 ||
        !Number.isSafeInteger(tenureMonths) || tenureMonths < 1) {
      throw new Error("Provide a positive principal, a nonnegative annual rate, and a positive whole number of months.");
    }

    const amount = new Money(principal);
    const rate = new Money(annualRatePct).div(1200);
    const emi = rate.isZero()
      ? amount.div(tenureMonths)
      : amount.times(rate).div(new Money(1).minus(rate.plus(1).pow(-tenureMonths)));
    const monthlyEmiInr = emi.toFixed(2);

    return {
      content: [{ type: "text", text: `Monthly EMI: ₹${monthlyEmiInr}.` }],
      details: { monthlyEmiInr },
    };
  },
};
