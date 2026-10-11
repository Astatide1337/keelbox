"use client";
import type { ReactNode, RefObject } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
export function MobileNavigation({
  open,
  onOpenChange,
  children,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  children: ReactNode;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="navigation-sheet"
        style={{ translate: "none", transform: "none" }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <DialogTitle>Navigation</DialogTitle>
        <DialogDescription className="sr-only">
          Choose a project destination.
        </DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}
