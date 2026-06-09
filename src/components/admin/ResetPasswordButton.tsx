import { actions } from "astro:actions";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

interface ResetPasswordButtonProps {
  id: string;
  displayName: string;
  username: string;
}

/**
 * Per-row password reset control (FR-024). Confirms behind an AlertDialog that
 * names the participant and warns the reset invalidates their current password
 * and signs them out everywhere, then calls the admin-only
 * `participants.resetPassword` Action. On success the dialog body swaps to a
 * reveal panel (the returned temp password is the ONLY copy) that stays open
 * until dismissed — like `ParticipantForm`, it must NOT reload while the
 * password is on screen. Dismissing (Done, Esc, or overlay) reloads so the list
 * re-queries under admin RLS.
 *
 * The confirm uses a plain Button (NOT `AlertDialogAction`, which auto-closes)
 * so a failed reset keeps the dialog open with its error.
 */
export function ResetPasswordButton({ id, displayName, username }: ResetPasswordButtonProps) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    const { data, error: actionError } = await actions.participants.resetPassword({ id });
    if (actionError) {
      setError(actionError.message);
      setSubmitting(false);
      return;
    }
    setPassword(data.password);
    setSubmitting(false);
  };

  const handleCopy = async () => {
    if (!password) return;
    await navigator.clipboard.writeText(`Username: ${username}\nPassword: ${password}`);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  const handleOpenChange = (next: boolean) => {
    if (submitting) return;
    // Once the password is revealed, any dismissal refreshes the list (the
    // password is gone either way); never silently leave a stale view.
    if (!next && password) {
      window.location.reload();
      return;
    }
    setOpen(next);
    if (!next) {
      setError(null);
      setCopied(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button variant="outline">Reset password</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        {password ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Temporary password for {displayName}</AlertDialogTitle>
              <AlertDialogDescription>
                Share this now — it&apos;s shown only once. {displayName} is signed out everywhere and must use it to
                sign in, then change it in Settings.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <dl className="space-y-2 font-mono text-sm">
              <div className="flex flex-wrap gap-2">
                <dt className="text-muted-foreground w-20">Username</dt>
                <dd className="font-semibold">{username}</dd>
              </div>
              <div className="flex flex-wrap gap-2">
                <dt className="text-muted-foreground w-20">Password</dt>
                <dd className="font-semibold">{password}</dd>
              </div>
            </dl>
            <AlertDialogFooter>
              <Button type="button" variant="outline" onClick={handleCopy}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  window.location.reload();
                }}
              >
                Done
              </Button>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Reset {displayName}&apos;s password?</AlertDialogTitle>
              <AlertDialogDescription>
                This generates a new temporary password and immediately signs {displayName} out of all sessions. Their
                current password stops working. You&apos;ll see the new password once, to share out-of-band.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
              <Button onClick={handleConfirm} disabled={submitting}>
                {submitting ? "Resetting…" : "Reset password"}
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
