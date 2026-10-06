/** Browser-stored settings that follow the account across devices: only `pulse-*` keys, strings, with size limits. */
const KEY = /^pulse-[a-z0-9-]{1,40}$/;
export const MAX_KEYS = 30;
export const MAX_VALUE_BYTES = 300_000;
export const MAX_TOTAL_BYTES = 600_000;

export function sanitizeState(payload) {
  const input = payload?.keys;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid state");
  const clean = {};
  let total = 0;
  for (const [key, value] of Object.entries(input)) {
    if (!KEY.test(key) || typeof value !== "string") continue;
    const size = Buffer.byteLength(value);
    if (size > MAX_VALUE_BYTES) throw new RangeError(`State value too large: ${key}`);
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new RangeError("State too large");
    clean[key] = value;
    if (Object.keys(clean).length > MAX_KEYS) throw new RangeError("Too many keys");
  }
  return clean;
}
