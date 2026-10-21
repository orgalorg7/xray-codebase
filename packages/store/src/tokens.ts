/**
 * Splits identifiers and paths into lowercase words so full-text search can match
 * `getUserById`, `get_user_by_id` and `src/user-by-id.ts` from the query "user by id".
 */
export function splitIdentifier(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}
