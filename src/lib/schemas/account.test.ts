import { describe, expect, it } from "vitest";
import { changeDisplayNameSchema, changePasswordSchema } from "@/lib/schemas/account";

describe("changeDisplayNameSchema", () => {
  it("accepts a valid name + current password and trims the name", () => {
    const result = changeDisplayNameSchema.parse({ displayName: "  Bob Roberts  ", currentPassword: "secret" });
    expect(result).toEqual({ displayName: "Bob Roberts", currentPassword: "secret" });
  });

  it("rejects an empty display name", () => {
    expect(changeDisplayNameSchema.safeParse({ displayName: "   ", currentPassword: "secret" }).success).toBe(false);
  });

  it("rejects a display name longer than 80 characters", () => {
    expect(changeDisplayNameSchema.safeParse({ displayName: "n".repeat(81), currentPassword: "secret" }).success).toBe(
      false,
    );
  });

  it("rejects a missing current password", () => {
    expect(changeDisplayNameSchema.safeParse({ displayName: "Bob", currentPassword: "" }).success).toBe(false);
  });
});

describe("changePasswordSchema", () => {
  it("accepts a valid current + new + matching confirm", () => {
    const result = changePasswordSchema.parse({
      currentPassword: "oldpass",
      newPassword: "newpass",
      confirmPassword: "newpass",
    });
    expect(result).toEqual({ currentPassword: "oldpass", newPassword: "newpass", confirmPassword: "newpass" });
  });

  it("rejects a missing current password", () => {
    expect(
      changePasswordSchema.safeParse({ currentPassword: "", newPassword: "newpass", confirmPassword: "newpass" })
        .success,
    ).toBe(false);
  });

  it("rejects a new password shorter than 6 characters", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "oldpass",
      newPassword: "short",
      confirmPassword: "short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a mismatched confirm on the confirmPassword path", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "oldpass",
      newPassword: "newpass",
      confirmPassword: "different",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "confirmPassword")).toBe(true);
    }
  });

  it("rejects a new password equal to the current one on the newPassword path", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "samepass",
      newPassword: "samepass",
      confirmPassword: "samepass",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "newPassword")).toBe(true);
    }
  });
});
