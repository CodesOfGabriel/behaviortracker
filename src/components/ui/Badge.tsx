import type { ReactNode } from "react";
import { cn } from "../../lib/format";

export function Badge({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
  dot?: boolean;
}) {
  return (
    <span className={cn("badge", `badge-${tone}`)}>
      {dot && <span className="badge-dot" aria-hidden />}
      {children}
    </span>
  );
}

