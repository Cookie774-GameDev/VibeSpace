const EXACT_LITERAL_REQUEST =
  /\b(?:reply with|return)\s+exactly\s*:?\s*([A-Z0-9]+(?:_[A-Z0-9]+)+)(?=$|[\s.,;:!?])/giu;
const EXACT_LITERAL_SHAPE = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/u;
const EQUIVALENT_RESPONSE_SHAPE = /^([A-Z0-9]+(?:[ _-]+[A-Z0-9]+)*)([.!?]{0,3})$/u;
const MAX_LITERAL_LENGTH = 128;
const MAX_EQUIVALENT_RESPONSE_LENGTH = 256;

export function explicitExactLiteralFromRequest(request: string): string | null {
  const matches = [...request.matchAll(EXACT_LITERAL_REQUEST)];
  if (matches.length !== 1) return null;

  const literal = matches[0]?.[1] ?? null;
  if (!literal || literal.length > MAX_LITERAL_LENGTH || !EXACT_LITERAL_SHAPE.test(literal)) {
    return null;
  }
  return literal;
}

/**
 * Repairs only an explicit identifier-like exact-output contract when the
 * entire provider response consists of the same uppercase token segments,
 * narrow separators, and bounded terminal punctuation. Everything else is
 * preserved verbatim.
 */
export function reconcileExplicitExactLiteral(request: string, response: string): string {
  const literal = explicitExactLiteralFromRequest(request);
  if (!literal || response.length > MAX_EQUIVALENT_RESPONSE_LENGTH || /[\r\n]/u.test(response)) {
    return response;
  }
  const trimmedResponse = response.trim();
  const equivalent = EQUIVALENT_RESPONSE_SHAPE.exec(trimmedResponse);
  if (!equivalent) {
    return response;
  }
  const responseSegments = equivalent[1]?.split(/[ _-]+/u);
  const literalSegments = literal.split('_');
  if (
    !responseSegments ||
    responseSegments.length !== literalSegments.length ||
    responseSegments.some((segment, index) => segment !== literalSegments[index])
  ) {
    return response;
  }
  return literal;
}
