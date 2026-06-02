/**
 * Wall-clock ↔ UTC conversion for kickoff times. Centralized so no caller
 * hand-rolls Date math — critical because workerd's `Date` is ALWAYS UTC
 * server-side (research §4), so a bare `new Date(y, m, d, h, mi)` does NOT mean
 * the admin's local time. Every conversion goes through `@date-fns/tz`'s
 * `TZDate`, which is Intl-based (no bundled tzdata, safe on the Workers runtime
 * and stays current with the platform's IANA database).
 *
 * The canonical wall-clock string is `"YYYY-MM-DD HH:mm"` (24h, minute
 * precision, no seconds, no offset) in the tournament's IANA zone. Both entry
 * paths (one-by-one form, bulk paste) converge on it so client and server
 * validate identically.
 */
import { TZDate } from "@date-fns/tz";

export interface WallClockParts {
  /** Full year, e.g. 2026. */
  y: number;
  /** Month, 1-12 (NOT zero-based). */
  mo: number;
  /** Day of month, 1-31. */
  d: number;
  /** Hour, 0-23. */
  h: number;
  /** Minute, 0-59. */
  mi: number;
}

/** The canonical wall-clock format both entry paths normalize to. */
export const KICKOFF_LOCAL_FORMAT = "YYYY-MM-DD HH:mm";

/**
 * True iff `timeZone` is a valid IANA zone the runtime accepts. Guards the
 * schema boundary so an invalid zone is a clean field error rather than an
 * Invalid Date that later throws `RangeError` in `localToUtc(...).toISOString()`.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

const KICKOFF_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

/**
 * Parse a canonical `"YYYY-MM-DD HH:mm"` string into wall-clock parts, or
 * return `null` if it doesn't match the format or carries out-of-range fields
 * (incl. impossible calendar dates like Feb 30). Range-checked so callers can
 * treat a non-null result as a real calendar date.
 */
export function parseWallClock(wallClock: string): WallClockParts | null {
  const match = KICKOFF_LOCAL_RE.exec(wallClock.trim());
  if (!match) return null;

  const [, ys, mos, ds, hs, mis] = match;
  const parts: WallClockParts = {
    y: Number(ys),
    mo: Number(mos),
    d: Number(ds),
    h: Number(hs),
    mi: Number(mis),
  };

  if (parts.mo < 1 || parts.mo > 12) return null;
  if (parts.d < 1 || parts.d > 31) return null;
  if (parts.h > 23 || parts.mi > 59) return null;

  // Reject impossible calendar dates (e.g. 2026-02-30) by round-tripping
  // through a UTC Date and checking the day survived normalization.
  const probe = new Date(Date.UTC(parts.y, parts.mo - 1, parts.d));
  if (probe.getUTCMonth() !== parts.mo - 1 || probe.getUTCDate() !== parts.d) {
    return null;
  }

  return parts;
}

/**
 * Convert tournament-zone wall-clock parts to the correct UTC instant.
 * `TZDate(y, mo-1, d, h, mi, zone)` builds the instant in the given IANA zone;
 * its underlying timestamp is already correct UTC.
 */
export function localToUtc(parts: WallClockParts, ianaZone: string): Date {
  const { y, mo, d, h, mi } = parts;
  const zoned = new TZDate(y, mo - 1, d, h, mi, ianaZone);
  return new Date(zoned.getTime());
}

/** Re-project a UTC instant into a tournament-zone `TZDate` for display. */
export function utcToZone(utc: Date, ianaZone: string): TZDate {
  return new TZDate(utc.getTime(), ianaZone);
}

/**
 * Format a UTC instant as the canonical `"YYYY-MM-DD HH:mm"` wall-clock string
 * in the tournament zone. Uses `TZDate`'s zone-local getters (no `date-fns`
 * dependency here — kept out of the server-side timezone core).
 */
export function formatInZone(utc: Date, ianaZone: string): string {
  const zoned = utcToZone(utc, ianaZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${String(zoned.getFullYear())}-${pad(zoned.getMonth() + 1)}-${pad(zoned.getDate())}` +
    ` ${pad(zoned.getHours())}:${pad(zoned.getMinutes())}`
  );
}
