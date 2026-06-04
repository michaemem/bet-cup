import { describe, expect, it } from "vitest";
import { generatePassword } from "@/lib/password";

const AMBIGUOUS = /[0O1lI]/;

describe("generatePassword", () => {
  it("returns the requested length (default 16)", () => {
    expect(generatePassword()).toHaveLength(16);
    expect(generatePassword(24)).toHaveLength(24);
    expect(generatePassword(3)).toHaveLength(3);
  });

  it("uses only the unambiguous alphabet (no 0/O/1/l/I)", () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePassword()).not.toMatch(AMBIGUOUS);
    }
  });

  it("guarantees at least one lowercase, one uppercase, and one digit", () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword();
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[2-9]/);
    }
  });

  it("produces a different value on repeated calls", () => {
    const values = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(values.size).toBe(50);
  });

  it("rejects a length below the character-class minimum", () => {
    expect(() => generatePassword(2)).toThrow();
  });
});
