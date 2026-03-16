// shared/utils/parseNumber.ts

/**
 * Parse a value to a number with a fallback.
 * @param value - The value to parse
 * @param fallback - The fallback value if parsing fails
 * @returns The parsed number or the fallback value
 */
export function parseNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
