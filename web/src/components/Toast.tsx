import React from "react";
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

export const ToastContainer: React.FC<Props> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed right-6 bottom-6 z-80 flex max-w-sm flex-col gap-2">
      {toasts.map((toast) => {
        const isSuccess = toast.type === "success";
        const isError = toast.type === "error";

        return (
          <div
            key={toast.id}
            className={`flex items-start justify-between gap-3 rounded-xl border bg-white p-4 shadow-lg transition-all duration-150 ${
              isSuccess
                ? "border-emerald-200"
                : isError
                  ? "border-rose-200"
                  : "border-blue-200"
            }`}
          >
            <div>
              <div
                className={`text-xs font-bold ${
                  isSuccess
                    ? "text-emerald-700"
                    : isError
                      ? "text-rose-700"
                      : "text-blue-700"
                }`}
              >
                {toast.title}
              </div>
              {toast.message ? (
                <div className="mt-1 text-xs text-slate-600 break-words leading-relaxed">
                  {toast.message}
                </div>
              ) : null}
            </div>
            <button
              onClick={() => onDismiss(toast.id)}
              className="p-1 text-slate-400 transition-colors hover:text-slate-700"
              aria-label="Dismiss"
            >
              <IconClose size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
};
