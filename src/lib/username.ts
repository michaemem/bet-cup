/**
 * Single source of truth for the username -> synthetic-email mapping. Both the
 * `participants.create` Action and the sign-in handler import `synthEmail` so
 * they can never drift — drift would mean "created but can't log in".
 */
export const SYNTHETIC_EMAIL_DOMAIN = "betcup.local";

export function synthEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${SYNTHETIC_EMAIL_DOMAIN}`;
}
