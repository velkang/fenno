import React from "react";
import { AnimatePresence, motion } from "motion/react";
import { IconClose } from "./Icons";

export type ToastMessage = {
  id: string;
  type: "success" | "error" | "info";
  title: string;
  message?: string;
};

type Props = {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
};

const DOT: Record<ToastMessage["type"], string> = { success: "bg-feed", error: "bg-danger", info: "bg-rest" };

// Always rendered, so a toast can slide out after it is dismissed; the rest of the stack closes up.
export const ToastContainer: React.FC<Props> = ({ toasts, onDismiss }) => (
  <div className="pointer-events-none fixed top-24 right-6 z-80 flex w-[min(400px,calc(100vw-32px))] flex-col gap-3 max-[760px]:top-4 max-[520px]:right-4">
    <AnimatePresence mode="popLayout" initial={false}>
      {toasts.map((toast) => (
        <motion.div key={toast.id} layout role={toast.type === "error" ? "alert" : "status"}
          initial={{ opacity: 0, transform: "translateX(24px)" }}
          animate={{ opacity: 1, transform: "none" }}
          exit={{ opacity: 0, transform: "translateX(24px)" }}
          style={{ borderRadius: 22 }}
          className="pointer-events-auto grid grid-cols-[12px_minmax(0,1fr)_auto] items-start gap-3.5 border border-line bg-card px-5 py-4 shadow-xl">
          <span className={`mt-2 size-3 rounded-full ${DOT[toast.type]}`} aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-1">
            <strong className="text-[1.05rem] font-semibold text-ink">{toast.title}</strong>
            {toast.message ? <span className="text-[.98rem] leading-relaxed break-words text-ink-muted">{toast.message}</span> : null}
          </div>
          <button type="button" onClick={() => onDismiss(toast.id)} aria-label="Dismiss"
            className="-mr-1 grid size-9 place-items-center rounded-full text-ink-faint hover:bg-tint hover:text-ink">
            <IconClose size={16} />
          </button>
        </motion.div>
      ))}
    </AnimatePresence>
  </div>
);
