export interface ExpectedToolCall {
  name: string;
  input?: Readonly<Record<string, string | number>>;
  inputQuery?: RegExp;
  resultTextIncludes?: string;
}

export interface SaraCase {
  id: string;
  description: string;
  turns: readonly {
    user: string;
    expected: string;
    toolCalls: readonly ExpectedToolCall[];
  }[];
}

export const saraCases: readonly SaraCase[] = [
  {
    id: "casual-shop-talk",
    description: "Casual shop talk",
    turns: [{
      user: "Aaj shop mein pehli baar ek customer apne dog ko le aaya. Pura din ban gaya!",
      expected: "Respond warmly and specifically to the customer's dog brightening the shopkeeper's day. Use natural Roman-script Hinglish and keep the reply short. Avoid unsolicited business or money advice.",
      toolCalls: [],
    }],
  },
  {
    id: "stressed-shop-owner",
    description: "Stressed shop owner",
    turns: [{
      user: "My shop is short-staffed today, orders are piling up, and I can't think straight.",
      expected: "Acknowledge how overwhelming the situation feels before suggesting one specific step the shop owner could take right now. Stay brief and avoid a lecture or a list of tasks.",
      toolCalls: [],
    }],
  },
  {
    id: "grounded-hinglish-finance",
    description: "Grounded Hinglish finance answer",
    turns: [{
      user: "UPI payment atak gaya, status kaise check karun?",
      expected: "In concise, natural Roman-script Hinglish, tell the user to check the payment app's transaction history. Briefly name NPCI or its UPI Help Guidelines. Any additional finance claims must be supported by the lookup, including the scope of UPI Help. Avoid inventing a timeline or guaranteeing a reversal.",
      toolCalls: [{
        name: "lookup_finance",
        inputQuery: /^(?=.*\bUPI\b)[a-z0-9 .,'?&-]+$/i,
        resultTextIncludes: "UPI Help Guidelines",
      }],
    }],
  },
  {
    id: "recall-across-turns",
    description: "Recall across turns",
    turns: [
      {
        user: "Neha is opening the shop this Saturday while I pick up a new shelf.",
        expected: "Respond naturally and avoid changing who is opening the shop or when.",
        toolCalls: [],
      },
      {
        user: "I'm hoping the new shelf will fit by the counter.",
        expected: "Respond briefly to the concern about fitting the new shelf by the counter. Avoid inventing dimensions or certainty that it will fit.",
        toolCalls: [],
      },
      {
        user: "Who did I say was opening the shop on Saturday?",
        expected: "Directly answer that Neha is opening the shop, using the earlier turn.",
        toolCalls: [],
      },
    ],
  },
  {
    id: "emi-missing-rate",
    description: "EMI with a missing annual rate",
    turns: [{
      user: "What would my monthly EMI be for a ₹50,000 loan over 2 years?",
      expected: "Ask for the annual interest rate. Avoid assuming a rate, quoting an EMI, or asking again for the loan amount or tenure.",
      toolCalls: [],
    }],
  },
  {
    id: "emi-all-inputs",
    description: "EMI with all inputs",
    turns: [{
      user: "What would my monthly EMI be for a ₹50,000 loan over 2 years at 12% annual interest?",
      expected: "Report the exact calculator result of ₹2,353.67 per month, including paise. Ordinary digit grouping or no separator is fine. Avoid rounding the result or asking for inputs already given.",
      toolCalls: [{
        name: "calculate_emi",
        input: { principal: 50_000, annualRatePct: 12, tenureMonths: 24 },
        resultTextIncludes: "₹2353.67",
      }],
    }],
  },
];
