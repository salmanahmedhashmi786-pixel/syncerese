/**
 * fontkit ships no types and is only used in the invoice tests, to ask an
 * embedded font whether it has a glyph for a codepoint. Declaring the one
 * method used beats pulling in an `any`.
 */
declare module 'fontkit' {
  export type Face = { hasGlyphForCodePoint(codePoint: number): boolean }
  export function create(buffer: Buffer): Face
  const fontkit: { create(buffer: Buffer): Face }
  export default fontkit
}
