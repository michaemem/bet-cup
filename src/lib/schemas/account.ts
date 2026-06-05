import { z } from "zod";

/**
 * Shared validation for the account-settings forms and Actions. Both mutations
 * require the caller to confirm their CURRENT password (verified server-side via
 * a transient sign-in), so every schema carries `currentPassword`. Length rules
 * mirror the established conventions: display name `min 1 / max 80` (no regex —
 * same as `participantCreateSchema.name`), passwords `min 6` (matching sign-in
 * and the GoTrue minimum).
 */
export const changeDisplayNameSchema = z.object({
  displayName: z.string().trim().min(1, "Name is required").max(80),
  currentPassword: z.string().min(1, "Current password is required"),
});

export type ChangeDisplayNameInput = z.infer<typeof changeDisplayNameSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(6, "New password must be at least 6 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    path: ["newPassword"],
    message: "New password must be different from the current one",
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
