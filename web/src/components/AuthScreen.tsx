import React, { useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import {
  useAppKit,
  useAppKitAccount,
  useAppKitState,
  useDisconnect,
} from '@reown/appkit/react'
import { api, type AuthUser, ApiError } from '../lib/api-client'
import { Tomo } from './Icons'

type Props = {
  onAuthSuccess: (user: AuthUser) => void
  onError: (msg: string) => void
  onClose?: () => void
}

export const AuthScreen: React.FC<Props> = ({
  onAuthSuccess,
  onError,
  onClose,
}) => {
  const { open } = useAppKit()
  const { address, isConnected } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const { embeddedWalletInfo } = useAppKitAccount()
  const { open: signInOpen } = useAppKitState()
  const { disconnect } = useDisconnect()

  // "Change" signs the current account out, then asks for an email (or Google / X) again.
  const changeAccount = async () => {
    try {
      await disconnect()
    } catch (error) {
      console.error('Disconnect failed', error)
      onError("Couldn't switch accounts. Try again.")
      return
    }
    open({ view: 'Connect' })
  }
  const account =
    embeddedWalletInfo?.user?.email ??
    embeddedWalletInfo?.user?.username ??
    address

  const [step, setStep] = useState<'signing' | 'creating' | null>(null)
  // Once sign-in has started (the Reown window is open or we are signing),
  // the guest exit goes away. It comes back if the Reown window is closed
  // without signing in, so nobody is stuck in this dialog.
  const signInStarted = signInOpen || step !== null
  const [, setChallengeData] = useState<{
    challengeId: string
    message: string
    expiresAt: number
  } | null>(null)

  const handleStartAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!address) {
      open()
      return
    }
    setStep('signing')
    try {
      // 1. Issue SIWE Challenge from API (first sign-in also creates the account)
      const challenge = await api.issueChallenge(address)
      setChallengeData(challenge)

      // 2. The sign-in account (email, Google or X) signs the challenge
      const signature = await signMessageAsync({ message: challenge.message })

      // 3. Verify Challenge and create session
      const verifyResult = await api.verifyChallenge(
        challenge.challengeId,
        challenge.message,
        signature,
      )

      // 4. Create the Stillwater wallet as part of onboarding (returns the existing one on later sign-ins)
      setStep('creating')
      try {
        await api.provisionWallet()
      } catch (provisionError) {
        console.error('Wallet creation failed', provisionError)
        onError(
          "Signed in, but your Fenno wallet couldn't be created. Open Wallet to try again.",
        )
      }

      onAuthSuccess(verifyResult.user)
    } catch (err: unknown) {
      console.error('Auth flow failed', err)
      if (err instanceof ApiError) {
        if (err.code === 'CHALLENGE_EXPIRED') {
          onError('SIWE challenge expired. Please retry.')
        } else if (
          err.code === 'BACKEND_UNREACHABLE' ||
          err.code === 'NETWORK_ERROR'
        ) {
          onError(
            'Unable to connect to the backend server. Please verify the API worker is running.',
          )
        } else {
          onError(`Authentication failed: ${err.message || err.code}`)
        }
      } else if (typeof err === 'object' && err !== null && 'message' in err) {
        onError((err as { message: string }).message)
      } else {
        onError('Sign-in was not completed.')
      }
      setChallengeData(null)
    } finally {
      setStep(null)
    }
  }

  return (
    <div className="mx-auto max-w-[560px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="signin-title"
        className="flex flex-col items-center gap-5 rounded-[32px] bg-card px-[clamp(20px,5vw,44px)] py-10 text-center text-ink shadow-2xl"
      >
        <Tomo size={92} sleepy={false} />
        <h2
          id="signin-title"
          className="text-[2.1rem] leading-tight font-semibold"
        >
          Sign in to Fenno
        </h2>
        <p className="max-w-[460px] text-[1.1rem] leading-relaxed text-ink-muted">
          Sign in with email, Google or X. <br /> Your Fenno wallet is made
          for you on your first sign-in.
        </p>

        <form onSubmit={handleStartAuth} className="flex w-full flex-col gap-3">
          {isConnected && address ? (
            <div className="flex items-center justify-between gap-3 rounded-[18px] border border-line bg-field px-4 py-3 text-left">
              <span className="flex min-w-0 items-center gap-2.5">
                <span
                  className="size-2.5 shrink-0 rounded-full bg-feed"
                  aria-hidden="true"
                />
                <span
                  className="truncate text-[.95rem] text-ink"
                  title={account}
                >
                  {account}
                </span>
              </span>
              <button
                type="button"
                onClick={() => void changeAccount()}
                disabled={step !== null}
                className="min-h-10 shrink-0 rounded-full border border-line px-4 text-[.95rem] font-medium hover:bg-tint disabled:opacity-50"
              >
                Change
              </button>
            </div>
          ) : null}
          <button
            type="submit"
            disabled={step !== null}
            className="flex min-h-[60px] w-full items-center justify-center gap-2.5 rounded-full bg-accent px-6 text-[1.1rem] font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60"
          >
            {step === 'signing'
              ? 'Confirming your sign-in…'
              : step === 'creating'
                ? 'Making your wallet…'
                : isConnected
                  ? 'Sign in'
                  : 'Continue'}
          </button>
          {onClose && !signInStarted ? (
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 text-[1rem] font-medium text-ink-muted hover:text-ink"
            >
              Keep exploring as a guest
            </button>
          ) : null}
        </form>
      </div>
    </div>
  )
}
