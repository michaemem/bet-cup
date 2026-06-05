import { actions } from "astro:actions";
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

interface DeleteParticipantButtonProps {
  id: string;
  displayName: string;
}

/**
 * Per-row destructive delete control (FR-004). Confirms behind an AlertDialog
 * that names the participant and warns the action is permanent, then calls the
 * admin-only `participants.delete` Action. On success the whole page reloads so
 * the list re-queries under admin RLS (mirrors `ParticipantForm.handleReset` —
 * no optimistic in-place update). On error the dialog stays open and surfaces
 * `error.message` (already a stable, non-leaking message from the Action).
 *
 * The confirm uses a plain Button (NOT `AlertDialogAction`, which auto-closes
 * the dialog on click) so a failed delete keeps the dialog open with its error.
 */
export function DeleteParticipantButton({ id, displayName }: DeleteParticipantButtonProps) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    const { error: actionError } = await actions.participants.delete({ id });
    if (actionError) {
      setError(actionError.message);
      setSubmitting(false);
      return;
    }
    window.location.reload();
  };

  const handleOpenChange = (next: boolean) => {
    if (submitting) return;
    setOpen(next);
    if (!next) setError(null);
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm">
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes their account, predictions, and points. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={handleConfirm} disabled={submitting}>
            {submitting ? "Deleting…" : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
