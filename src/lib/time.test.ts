import { describe, expect, it } from "vitest";
import { formatInZone, localToUtc, parseWallClock, type WallClockParts } from "@/lib/time";

/** Parse-or-throw so the assertions below operate on non-null parts. */
function mustParse(wallClock: string): WallClockParts {
  const parts = parseWallClock(wallClock);
  if (!parts) throw new Error(`expected parseable wall clock: ${wallClock}`);
  return parts;
}

describe("parseWallClock", () => {
  it("parses a canonical YYYY-MM-DD HH:mm string into 1-based-month parts", () => {
    expect(parseWallClock("2026-06-01 18:00")).toEqual({ y: 2026, mo: 6, d: 1, h: 18, mi: 0 });
  });

  it("rejects non-canonical formats (no seconds, no T separator, no slashes)", () => {
    expect(parseWallClock("2026-06-01T18:00")).toBeNull();
    expect(parseWallClock("2026-06-01 18:00:00")).toBeNull();
    expect(parseWallClock("2026/06/01 18:00")).toBeNull();
    expect(parseWallClock("18:00 2026-06-01")).toBeNull();
    expect(parseWallClock("")).toBeNull();
  });

  it("rejects out-of-range and impossible calendar dates", () => {
    expect(parseWallClock("2026-13-01 18:00")).toBeNull(); // month 13
    expect(parseWallClock("2026-06-01 24:00")).toBeNull(); // hour 24
    expect(parseWallClock("2026-02-30 18:00")).toBeNull(); // Feb 30 doesn't exist
  });
});

describe("localToUtc", () => {
  it("converts a summer (CEST, +02:00) Warsaw wall clock to the right UTC instant", () => {
    const utc = localToUtc(mustParse("2026-06-01 18:00"), "Europe/Warsaw");
    expect(utc.toISOString()).toBe("2026-06-01T16:00:00.000Z");
  });

  it("applies the correct offset across the DST boundary (CET, +01:00, in winter)", () => {
    const utc = localToUtc(mustParse("2026-01-15 18:00"), "Europe/Warsaw");
    // Winter is CET (+01:00): 18:00 local → 17:00 UTC, a different offset than
    // the summer case above — proving the conversion is DST-aware.
    expect(utc.toISOString()).toBe("2026-01-15T17:00:00.000Z");
  });

  it("treats a UTC-zone wall clock as the same instant", () => {
    const utc = localToUtc(mustParse("2026-06-01 18:00"), "UTC");
    expect(utc.toISOString()).toBe("2026-06-01T18:00:00.000Z");
  });
});

describe("formatInZone", () => {
  it("round-trips a UTC instant back to the entered wall clock in the tournament zone", () => {
    const utc = new Date("2026-06-01T16:00:00.000Z");
    expect(formatInZone(utc, "Europe/Warsaw")).toBe("2026-06-01 18:00");
  });
});
