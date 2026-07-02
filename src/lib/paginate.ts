// Generic read-all-pages helper for Supabase/PostgREST reads.
//
// PostgREST caps every response at `db-max-rows` (this project sets
// `max_rows = 1000` in supabase/config.toml). A single-shot `.select()` whose
// result exceeds that ceiling is silently truncated — no error is raised — so
// any read that can fan out past ~1000 rows must be paged. This helper loops
// `.range(from, to)` requests until a short page signals the end, and throws on
// the first page error so callers keep their throw-to-500 semantics.
//
// It takes a page-fetching callback (not a Supabase client) so it stays free of
// the DB and is unit-testable with a plain in-memory fake — the same
// pure-core/async-shell split used by buildMatchPredictionRows and loadHistory.
//
// CORRECTNESS: page boundaries are only gap-/duplicate-free if the underlying
// query has a stable total order. Callers MUST apply a deterministic `.order()`
// (e.g. a unique key) on the query they page here.

// Must stay <= PostgREST `max_rows` (supabase/config.toml). If this exceeds the
// server cap, a full page comes back short and the loop stops early — silently
// re-truncating. Keep the two in lockstep.
export const DEFAULT_PAGE_SIZE = 1000;

export interface PageResult<T> {
  data: T[] | null;
  error: unknown;
}

/**
 * Read every row of a query by paging `.range(from, to)` until exhaustion.
 *
 * Requests half-open windows of `pageSize` rows (`[0..pageSize-1]`,
 * `[pageSize..2*pageSize-1]`, …), concatenating each page's rows, and stops when
 * a page returns fewer than `pageSize` rows (the last/only page). `pageSize`
 * must be `<= db-max-rows`, otherwise the server truncates a full window and the
 * "short page ⇒ done" signal never fires. Throws (with `cause`) on the first
 * page error.
 *
 * CAVEAT: callers MUST NOT pass `{ count: 'exact' }` on the paged query. When the
 * total is an exact multiple of `pageSize` this loop issues one final
 * out-of-range request expecting an empty `200 []`; with an exact count PostgREST
 * answers an out-of-range offset with `416 Range Not Satisfiable`, which this
 * helper would surface as a thrown error instead of end-of-data.
 */
export async function readAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`readAllPages: pageSize must be a positive integer (got ${String(pageSize)})`);
  }

  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) {
      throw new Error("readAllPages: page fetch failed", { cause: error });
    }
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}
