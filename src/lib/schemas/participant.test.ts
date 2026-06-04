import { describe, expect, it } from "vitest";
import { participantCreateSchema } from "@/lib/schemas/participant";

describe("participantCreateSchema", () => {
  it("accepts a valid name + username and lowercases the username", () => {
    const result = participantCreateSchema.parse({ name: "Bob Roberts", username: "Bob_R" });
    expect(result).toEqual({ name: "Bob Roberts", username: "bob_r" });
  });

  it("trims surrounding whitespace on both fields", () => {
    const result = participantCreateSchema.parse({ name: "  Bob  ", username: "  BOB  " });
    expect(result.name).toBe("Bob");
    expect(result.username).toBe("bob");
  });

  it("accepts the full legal username charset (letters, digits, . _ -)", () => {
    expect(participantCreateSchema.safeParse({ name: "X", username: "a.b_c-1" }).success).toBe(true);
  });

  it("rejects a username shorter than 3 characters", () => {
    expect(participantCreateSchema.safeParse({ name: "X", username: "ab" }).success).toBe(false);
  });

  it("rejects a username longer than 30 characters", () => {
    expect(participantCreateSchema.safeParse({ name: "X", username: "a".repeat(31) }).success).toBe(false);
  });

  it("rejects usernames with illegal characters (space, @, slash)", () => {
    expect(participantCreateSchema.safeParse({ name: "X", username: "bad name" }).success).toBe(false);
    expect(participantCreateSchema.safeParse({ name: "X", username: "bad@name" }).success).toBe(false);
    expect(participantCreateSchema.safeParse({ name: "X", username: "bad/name" }).success).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(participantCreateSchema.safeParse({ name: "   ", username: "valid" }).success).toBe(false);
  });

  it("rejects a name longer than 80 characters", () => {
    expect(participantCreateSchema.safeParse({ name: "n".repeat(81), username: "valid" }).success).toBe(false);
  });
});
