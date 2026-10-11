// Query-string numbers for the read routes, clamped before they reach Prisma.
//
// Three shapes go wrong without a clamp. `limit=999999999` is the full-table
// read that pagination exists to prevent. `page=0` arrives as a negative
// `skip` and `page=abc` as NaN, both of which throw — so a mistyped query
// string is a 500 instead of a list. And `Math.min(parseInt(raw), cap)` still
// passes NaN through to `take`, because Math.min of NaN is NaN.
//
// Rule used here: an unparseable value, or one below the legal minimum, falls
// back to the default; anything above the maximum is clamped to it. A default
// is a known-good number, so the route can never see NaN.
export function intParam(
  searchParams: URLSearchParams,
  name: string,
  dflt: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(searchParams.get(name) ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < min) return dflt;
  return Math.min(parsed, max);
}

export function pageParams(
  searchParams: URLSearchParams,
  defaultLimit: number,
  maxLimit = 100,
): { page: number; limit: number } {
  return {
    page: intParam(searchParams, "page", 1, 1, Number.MAX_SAFE_INTEGER),
    limit: intParam(searchParams, "limit", defaultLimit, 1, maxLimit),
  };
}
