import { tool } from "ai";
import { Decimal } from "decimal.js";
import { z } from "zod";

// Leave room for subtraction even at the smallest positive rate a JS number can represent.
const Money = Decimal.clone({ precision: 700, rounding: Decimal.ROUND_HALF_UP });

export const calculateEmi = tool({
  description: "Calculate the fixed monthly loan repayment in INR. Requires principal, annual rate, and tenure in months.",
  inputSchema: z.strictObject({
    principal: z.number().positive().describe("Loan principal in rupees"),
    annualRatePct: z.number().nonnegative().describe("Annual interest as a percentage, e.g. 12 for 12%"),
    tenureMonths: z.int().min(1),
  }),
  async execute({ principal, annualRatePct, tenureMonths }) {
    const amount = new Money(principal);
    const rate = new Money(annualRatePct).div(1200);
    const emi = rate.isZero()
      ? amount.div(tenureMonths)
      : amount.times(rate).div(new Money(1).minus(rate.plus(1).pow(-tenureMonths)));
    // Drop numerical noise from the formula before rounding to paise at a half-cent tie.
    const monthlyEmiInr = emi.toDecimalPlaces(40).toFixed(2);

    return `Monthly EMI: ₹${monthlyEmiInr}.`;
  },
});
