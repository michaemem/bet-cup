import { describe, expect, it, vi } from "vitest";
import { readAllPages, type PageResult } from "@/lib/paginate";

// A fake PostgREST pager over an in-memory array. Mirrors `.range(from, to)`
// (inclusive bounds) and — like the real server — never returns more than
// `serverCap` rows in one response, so a page window wider than the cap is
// silently truncated (the exact behavior readAllPages must not trip on).
function makePager(total: number, serverCap = 1000) {
  const all = Array.from({ length: total }, (_, i) => ({ id: i }));
  const fetchPage = vi.fn((from: number, to: number): Promise<PageResult<{ id: number }>> => {
    const window = all.slice(from, to + 1);
    return Promise.resolve({ data: window.slice(0, serverCap), error: null });
  });
  return { all, fetchPage };
}

describe("readAllPages", () => {
  it("returns a single short page without a second fetch", async () => {
    const { fetchPage } = makePager(42);
    const rows = await readAllPages(fetchPage, 1000);
    expect(rows).toHaveLength(42);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(0, 999);
  });

  it("stitches multiple pages into the complete set", async () => {
    const { all, fetchPage } = makePager(2050);
    const rows = await readAllPages(fetchPage, 1000);
    expect(rows).toHaveLength(2050);
    expect(rows).toEqual(all);
    // 1000 + 1000 + 50 → three fetches, last one short.
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("does one extra empty fetch when the total is an exact multiple of pageSize", async () => {
    const { fetchPage } = makePager(2000);
    const rows = await readAllPages(fetchPage, 1000);
    expect(rows).toHaveLength(2000);
    // 1000 + 1000 + 0 → the exact-multiple boundary needs the trailing empty page to stop.
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("returns an empty array when there are no rows", async () => {
    const { fetchPage } = makePager(0);
    const rows = await readAllPages(fetchPage, 1000);
    expect(rows).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("handles a small page size across many pages", async () => {
    const { all, fetchPage } = makePager(25);
    const rows = await readAllPages(fetchPage, 10);
    expect(rows).toEqual(all);
    // 10 + 10 + 5 → three fetches.
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("throws with the page error as cause", async () => {
    const boom = { message: "nope" };
    const fetchPage = vi.fn(() => Promise.resolve<PageResult<{ id: number }>>({ data: null, error: boom }));
    await expect(readAllPages(fetchPage, 1000)).rejects.toThrow("readAllPages: page fetch failed");
    await expect(readAllPages(fetchPage, 1000)).rejects.toMatchObject({ cause: boom });
  });

  it("rejects a non-positive or non-integer page size", async () => {
    const { fetchPage } = makePager(10);
    await expect(readAllPages(fetchPage, 0)).rejects.toThrow("pageSize must be a positive integer");
    await expect(readAllPages(fetchPage, -5)).rejects.toThrow("pageSize must be a positive integer");
    await expect(readAllPages(fetchPage, 1.5)).rejects.toThrow("pageSize must be a positive integer");
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
