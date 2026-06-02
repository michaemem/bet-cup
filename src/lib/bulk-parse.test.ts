import { describe, expect, it } from "vitest";
import { parseMatchPaste } from "@/lib/bulk-parse";

const ZONE = "Europe/Warsaw";

describe("parseMatchPaste", () => {
  it("parses a clean comma-delimited fixture list as all-valid rows", () => {
    const rows = parseMatchPaste("Poland, Germany, 2099-06-01 18:00\nSpain, Italy, 2099-06-02 20:45", ZONE);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "valid")).toBe(true);
    expect(rows[0]).toMatchObject({ homeTeam: "Poland", awayTeam: "Germany", kickoffLocal: "2099-06-01 18:00" });
  });

  it("skips blank lines (including whitespace-only lines)", () => {
    const rows = parseMatchPaste("\n  \nPoland, Germany, 2099-06-01 18:00\n\n", ZONE);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("valid");
  });

  it("auto-detects tab and pipe delimiters", () => {
    const tabRow = parseMatchPaste("Poland\tGermany\t2099-06-01 18:00", ZONE)[0];
    expect(tabRow.status).toBe("valid");
    expect(tabRow).toMatchObject({ homeTeam: "Poland", awayTeam: "Germany" });

    const pipeRow = parseMatchPaste("Poland | Germany | 2099-06-01 18:00", ZONE)[0];
    expect(pipeRow.status).toBe("valid");
    expect(pipeRow).toMatchObject({ homeTeam: "Poland", awayTeam: "Germany" });
  });

  it("normalizes loose kickoff formats to the canonical YYYY-MM-DD HH:mm", () => {
    const tRow = parseMatchPaste("Poland, Germany, 2099-6-1T9:05", ZONE)[0];
    expect(tRow.status).toBe("valid");
    expect(tRow.kickoffLocal).toBe("2099-06-01 09:05");

    const secRow = parseMatchPaste("Spain, Italy, 2099-06-02 20:45:30", ZONE)[0];
    expect(secRow.status).toBe("valid");
    expect(secRow.kickoffLocal).toBe("2099-06-02 20:45");
  });

  it("flags a row with too few fields as an error with a message", () => {
    const row = parseMatchPaste("Poland, 2099-06-01 18:00", ZONE)[0];
    expect(row.status).toBe("error");
    expect(row.error).toBe("Expected: home, away, kickoff");
  });

  it("flags a row with an unparseable kickoff as an error", () => {
    const row = parseMatchPaste("Poland, Germany, next tuesday", ZONE)[0];
    expect(row.status).toBe("error");
    expect(row.error).toBeTruthy();
  });

  it("marks a valid past-kickoff row isPast but keeps it valid (allowed-with-warning)", () => {
    const past = parseMatchPaste("Poland, Germany, 2000-01-01 18:00", ZONE)[0];
    expect(past.status).toBe("valid");
    expect(past.isPast).toBe(true);

    const future = parseMatchPaste("Poland, Germany, 2099-06-01 18:00", ZONE)[0];
    expect(future.status).toBe("valid");
    expect(future.isPast).toBe(false);
  });
});
