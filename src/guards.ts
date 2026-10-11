/** Canonical object guard for parsing device JSON; fields stay `unknown` until checked. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
