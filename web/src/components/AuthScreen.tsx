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

  const [step, setStep] = useState<"signing" | "creating" | null>(null);
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
    setStep("signing");
    try {
      // 1. Issue SIWE Challenge from API (first sign-in also creates the account)
      const challenge = await api.issueChallenge(address);
      setChallengeData(challenge);

      // 2. Request Signature via connected wallet
      const signature = await signMessageAsync({ message: challenge.message });

      // 3. Verify Challenge and create session
      const verifyResult = await api.verifyChallenge(
        challenge.challengeId,
        challenge.message,
        signature,
      );

      // 4. Create the Stillwater wallet as part of onboarding (returns the existing one on later sign-ins)
      setStep("creating");
      try {
        await api.provisionWallet();
      } catch (provisionError) {
        console.error("Wallet creation failed", provisionError);
        onError("Signed in, but your Stillwater wallet couldn't be created. Open Wallet to try again.");
      }

      onAuthSuccess(verifyResult.user);
    } catch (err: unknown) {
      console.error("Auth flow failed", err);
      if (err instanceof ApiError) {
        if (err.code === "CHALLENGE_EXPIRED") {
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
      setStep(null);
    }
  };

  return (
    <div className="mx-auto my-8 max-w-lg px-4">
      <div className="rounded-2xl border border-[#29364a] bg-[#111827] p-8 text-[#f3f4f6] shadow-2xl">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-[#10b981]/40 bg-[#10b981]/10 text-[#6ee7b7] mb-4">
            <IconShield size={24} />
          </div>
          <h2 className="text-xl font-bold tracking-tight text-[#e7edf5] mb-2">
            Sign In to Stillwater
          </h2>
          <p className="text-xs text-[#a8b5c7] leading-relaxed max-w-md mx-auto">
            Connect your wallet and sign a message to sign in. Your Stillwater wallet is created for you on your first sign-in.
          </p>
        </div>

        {/* Custody Architecture Notice */}
        <div className="mb-6 rounded-xl border border-[#29364a] bg-[#151e2b] p-4 text-xs leading-relaxed text-[#b6c1d1] [&_strong]:text-[#e7edf5]">
          <strong className="block font-bold mb-1">
            Dual-Key Custody Safety
          </strong>
          Your connected wallet is your <strong>Owner Wallet</strong>. It signs you in, and <strong>every withdrawal</strong> from your Stillwater wallet needs its signature. You choose where each withdrawal goes.
        </div>

        {/* Auth Form */}
        <form onSubmit={handleStartAuth} className="flex flex-col gap-4">
          {/* Step 1: Connect Wallet */}
          <div>
            <label className="block text-xs font-semibold text-[#b6c1d1] mb-1.5">
              Owner Wallet
            </label>
            {isConnected && address ? (
              <div className="flex items-center justify-between rounded-xl border border-[#29364a] bg-[#0b0f19] px-3.5 py-2.5">
                <div className="flex items-center gap-2 overflow-hidden">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                  <span className="font-mono text-xs text-[#e5edf5] truncate">
                    {address}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => open()}
                  className="shrink-0 rounded-lg border border-[#43536a] px-2.5 py-1 text-xs font-semibold text-[#e5edf5] hover:bg-[#1f2937] active:scale-95"
                >
                  Change
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => open()}
                className="w-full rounded-xl border border-[#43536a] py-2.5 text-xs font-semibold text-[#e5edf5] hover:bg-[#1f2937] active:scale-95 flex items-center justify-center gap-2"
              >
                <IconWallet size={15} />
                <span>Connect Wallet</span>
              </button>
            )}
          </div>

          {/* Submit Action */}
          <button
            type="submit"
            disabled={step !== null}
            className="mt-2 w-full rounded-xl bg-[#059669] py-3 text-xs font-bold text-white shadow-sm hover:bg-[#047857] active:scale-95 disabled:opacity-50"
          >
            {step === "signing" ? "Waiting for signature…" : step === "creating" ? "Creating your wallet…" : isConnected ? "Sign In with Ethereum" : "Connect Wallet & Sign In"}
          </button>

          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="w-full py-1.5 text-xs font-medium text-[#a8b5c7] hover:text-[#e7edf5] text-center"
            >
              Continue exploring as guest
            </button>
          ) : null}
        </form>
      </div>
    </div>
  );
};
