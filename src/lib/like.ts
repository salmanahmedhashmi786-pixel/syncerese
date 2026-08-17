/**
 * Escapes LIKE/ILIKE metacharacters in user input.
 *
 * `%` and `_` are wildcards, and `\` escapes them. Interpolating raw user text
 * into `%…%` means a user who types `%` matches EVERY row — which turns a
 * search box into a bulk export of the tenant's entire dataset in one query,
 * and makes `_` silently match characters the user did not type.
 *
 * Always pair with `ESCAPE '\'` — Postgres's default escape is already
 * backslash, but stating it keeps the intent obvious and survives a
 * `standard_conforming_strings` change.
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** `%term%` — a safe "contains" pattern. */
export const containsPattern = (input: string): string =>
  `%${escapeLike(input.trim().toLowerCase())}%`

/** `term%` — a safe "starts with" pattern. */
export const startsWithPattern = (input: string): string =>
  `${escapeLike(input.trim().toLowerCase())}%`
