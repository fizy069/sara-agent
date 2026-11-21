import { Decimal } from "decimal.js";

const amount = String.raw`\d+(?:,\d+)*(?:\.\d+)?`;
const scales = new Map([["lakh", 100_000], ["crore", 10_000_000], ["लाख", 100_000], ["करोड़", 10_000_000]]);
const scale = String.raw`(?:\s*(lakh|crore|लाख|करोड़)s?(?![\p{L}\p{M}]))?`;
const numbers = new RegExp(`(${amount})${scale}`, "giu");
const claims = new RegExp(String.raw`(?:₹|\b(?:INR|Rs\.?)\s*)\s*(${amount})${scale}|(${amount})\s*%`, "giu");

function digits(text: string): string {
  return text.replace(/[०-९]/g, (digit) => String(digit.charCodeAt(0) - 0x0966));
}

function value(amount: string, scale?: string): string {
  const multiplier = scale ? scales.get(scale.toLowerCase()) ?? 1 : 1;
  return new Decimal(amount.replaceAll(",", "")).times(multiplier).toString();
}

export function findUngroundedFinanceNumbers(reply: string, sources: readonly string[]): string[] {
  const grounded = new Set(sources.flatMap((source) =>
    Array.from(digits(source).matchAll(numbers), ([, amount, scale]) => value(amount, scale)),
  ));
  return [...new Set(Array.from(digits(reply).matchAll(claims))
    .filter(([, rupees, scale, percentage]) => !grounded.has(value(rupees ?? percentage, scale)))
    .map(([claim]) => claim))];
}
