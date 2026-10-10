"use client";
import { DropdownMenu as Primitive } from "radix-ui";
import { cn } from "cn";
import type { ComponentProps } from "react";
export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export function DropdownMenuContent({
  className,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        sideOffset={8}
        className={cn(
          "z-50 min-w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}
export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none focus:bg-accent data-[disabled]:opacity-50 data-[disabled]:pointer-events-none",
        className,
      )}
      {...props}
    />
  );
}
export function DropdownMenuLabel(
  props: ComponentProps<typeof Primitive.Label>,
) {
  return (
    <Primitive.Label
      className="px-3 py-2 text-xs text-muted-foreground"
      {...props}
    />
  );
}
export const DropdownMenuSeparator = Primitive.Separator;
