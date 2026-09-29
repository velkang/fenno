import React, { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { useAppKit } from "@reown/appkit/react";
import { api, type AuthUser, ApiError } from "../lib/api-client";
import { IconShield, IconWallet } from "./Icons";

type Props = {
  onAuthSuccess: (user: AuthUser) => void;
  onError: (msg: string) => void;
  onClose?: () => void;
};

export const AuthScreen: React.FC<Props> = ({ onAuthSuccess, onError, onClose }) => {
  const { open } = useAppKit();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [invitationCode, setInvitationCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [, setChallengeData] = useState<{
    challengeId: string;
    message: string;
    expiresAt: number;
  } | null>(null);

  const handleStartAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address) {
      open();
      return;
    }
    const trimmedCode = invitationCode.trim() || undefined;

    setLoading(true);
    try {
      // 1. Issue SIWE Challenge from API (invitation code only required for new users)
      const challenge = await api.issueChallenge(address, trimmedCode);
      setChallengeData(challenge);

      // 2. Request Signature via connected wallet
      const signature = await signMessageAsync({ message: challenge.message });

      // 3. Verify Challenge and create session
      const verifyResult = await api.verifyChallenge(
        challenge.challengeId,
        challenge.message,
        signature,
      );

      onAuthSuccess(verifyResult.user);
    } catch (err: unknown) {
      console.error("Auth flow failed", err);
      if (err instanceof ApiError) {
        if (err.code === "INVITATION_REQUIRED") {
          onError("An invitation code is required for first-time registration.");
        } else if (err.code === "INVALID_INVITATION_CODE" || err.code === "INVALID_INVITATION") {
          onError("Invalid or expired invitation code. Please check and try again.");
        } else if (err.code === "INVITATION_ALREADY_CLAIMED") {
          onError("This invitation code was already claimed by another wallet.");
        } else if (err.code === "CHALLENGE_EXPIRED") {
          onError("SIWE challenge expired. Please retry.");
        } else if (err.code === "BACKEND_UNREACHABLE" || err.code === "NETWORK_ERROR") {
          onError("Unable to connect to the backend server. Please verify the API worker is running.");
        } else {
          onError(`Authentication failed: ${err.message || err.code}`);
        }
      } else if (typeof err === "object" && err !== null && "message" in err) {
        onError((err as { message: string }).message);
      } else {
        onError("Failed to complete wallet signature.");
      }
      setChallengeData(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto my-8 max-w-lg px-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-xl">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-blue-200 bg-blue-50 text-blue-600 mb-4">
            <IconShield size={24} />
          </div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900 mb-2">
            Sign In to Actora
          </h2>
          <p className="text-xs text-slate-500 leading-relaxed max-w-md mx-auto">
            Connect your owner wallet to establish a Sign-In With Ethereum (SIWE) session for automated liquidity operations.
          </p>
        </div>

        {/* Custody Architecture Notice */}
        <div className="mb-6 rounded-xl border border-blue-100 bg-blue-50/60 p-4 text-xs leading-relaxed text-slate-700">
          <strong className="block font-bold text-slate-900 mb-1">
            Dual-Key Custody Safety
          </strong>
          Your connected wallet is your <strong>Owner Wallet</strong>. It signs session keys and is the <strong>only address</strong> authorized to receive asset withdrawals.
        </div>

        {/* Auth Form */}
        <form onSubmit={handleStartAuth} className="flex flex-col gap-4">
          {/* Step 1: Connect Wallet */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              1. Owner Wallet
            </label>
            {isConnected && address ? (
              <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5">
                <div className="flex items-center gap-2 overflow-hidden">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                  <span className="font-mono text-xs text-slate-800 truncate">
                    {address}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => open()}
                  className="shrink-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 active:scale-95 shadow-sm"
                >
                  Change
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => open()}
                className="w-full rounded-xl border border-slate-200 bg-white py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 active:scale-95 flex items-center justify-center gap-2 shadow-sm"
              >
                <IconWallet size={15} />
                <span>Connect Wallet</span>
              </button>
            )}
          </div>

          {/* Step 2: Invitation Code (New Users) */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-slate-700">
                2. Invitation Code
              </label>
              <span className="text-xs text-slate-400">
                (New users only)
              </span>
            </div>
            <input
              type="text"
              placeholder="Leave blank if already registered"
              value={invitationCode}
              onChange={(e) => setInvitationCode(e.target.value)}
              disabled={loading}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none"
            />
          </div>

          {/* Submit Action */}
          <button
            type="submit"
            disabled={loading}
            className="mt-2 w-full rounded-xl bg-blue-600 py-3 text-xs font-bold text-white shadow-sm hover:bg-blue-700 active:scale-95 disabled:opacity-50"
          >
            {loading ? "Authenticating…" : isConnected ? "Sign In with Ethereum" : "Connect Wallet & Sign In"}
          </button>

          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="w-full py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 text-center"
            >
              Continue exploring as guest
            </button>
          ) : null}
        </form>
      </div>
    </div>
  );
};
