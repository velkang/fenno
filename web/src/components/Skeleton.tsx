import type { ReactNode } from "react";

/** A placeholder block shaped like the content that is loading. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true"
    className={`block animate-pulse rounded-full bg-line motion-reduce:animate-none ${className}`} />;
}

/** Wraps skeletons so screen readers hear one "loading" message instead of empty shapes. */
export function Loading({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  return <div role="status" className={className}>
    <span className="sr-only">{label}</span>
    {children}
  </div>;
}
