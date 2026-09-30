import { motion } from "motion/react";

/**
 * The active tab's underline. Rendered only inside the active item (which must be `relative`);
 * the shared `layoutId` makes it glide from the previous item to the new one.
 */
export function Underline({ id }: { id: string }) {
  return <motion.span layoutId={id} aria-hidden="true" className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-ink" />;
}
