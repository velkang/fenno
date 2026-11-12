import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import {
  useAppKit,
  useAppKitAccount,
  useDisconnect,
} from '@reown/appkit/react'
import { api, type AuthUser, ApiError } from '../lib/api-client'
import { Tomo } from './Icons'

type Props = {
  onAuthSuccess: (user: AuthUser) => void
  onError: (msg: string) => void
  onClose?: () => void
}

/** The person closed or declined the signature in Reown's window. */
const declined = (error: unknown) => {
  const { code, name, message } = (error ?? {}) as { code?: number; name?: string; message?: string }
  return code === 4001 || name === 'UserRejectedRequestError' || /reject|denied|cancel/i.test(message ?? '')
}

export const AuthScreen: React.FC<Props> = ({
  onAuthSuccess,
  onError,
  onClose,
}) => {
  const { open } = useAppKit()
  const { address, isConnected } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const { embeddedWalletInfo, status } = useAppKitAccount()
  const { disconnect } = useDisconnect()
  const [step, setStep] = useState<'signing' | 'creating' | null>(null)
  // The account sign-in was last tried for, so a failure doesn't retry itself in a loop.
  const tried = useRef<string | null>(null)

  // Reown has a live email, Google or X session. After a long break the wallet library can still
  // remember the last account while Reown's session has ended; that account has to sign in again.
  const live = isConnected && !!address && status === 'connected' && !!embeddedWalletInfo?.user
  const restoring = status === 'reconnecting' || status === 'connecting'
  const account = embeddedWalletInfo?.user?.email ?? embeddedWalletInfo?.user?.username ?? address

  // Clears whatever account is remembered and asks for an email (or Google / X) again.
  const startOver = useCallback(async () => {
    tried.current = null
    try {
      await disconnect()
    } catch (error) {
      console.error('Disconnect failed', error)
    }
    open({ view: 'Connect' })
  }, [disconnect, open])

  const signIn = useCallback(async (owner: string) => {
    tried.current = owner
    setStep('signing')
    try {
      // 1. Issue SIWE Challenge from API (first sign-in also creates the account)
      const challenge = await api.issueChallenge(owner)
      // 2. The sign-in account (email, Google or X) signs the challenge
      const signature = await signMessageAsync({ message: challenge.message })
      // 3. Verify Challenge and create session
      const verifyResult = await api.verifyChallenge(challenge.challengeId, challenge.message, signature)
      // 4. Create the Fenno wallet as part of onboarding (returns the existing one on later sign-ins)
      setStep('creating')
      try {
        await api.provisionWallet()
      } catch (provisionError) {
        console.error('Wallet creation failed', provisionError)
        onError("Signed in, but your Fenno wallet couldn't be created. Open Wallet to try again.")
      }
      onAuthSuccess(verifyResult.user)
    } catch (err: unknown) {
      console.error('Auth flow failed', err)
      if (err instanceof ApiError) {
        if (err.code === 'CHALLENGE_EXPIRED') {
          onError('That took too long. Press Continue to try again.')
        } else if (err.code === 'BACKEND_UNREACHABLE' || err.code === 'NETWORK_ERROR') {
          onError("Fenno can't be reached right now. Try again in a moment.")
        } else {
          onError(`Authentication failed: ${err.message || err.code}`)
        }
      } else if (declined(err)) {
        onError('Sign-in was cancelled.')
      } else {
        // The remembered account couldn't sign: start again from Reown rather than show its error.
        await startOver()
      }
    } finally {
      setStep(null)
    }
  }, [onAuthSuccess, onError, signMessageAsync, startOver])

  // As soon as Reown has an account, sign in to Fenno with it: no second click.
  useEffect(() => {
    if (live && address && step === null && tried.current !== address) void signIn(address)
  }, [live, address, step, signIn])

  const handleContinue = (e: React.FormEvent) => {
    e.preventDefault()
    if (live && address) void signIn(address)
    else if (isConnected) void startOver()
    else open({ view: 'Connect' })
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
          Sign in with Google, X or email. <br /> Your Fenno wallet is made
          for you on your first sign-in.
        </p>

        <form onSubmit={handleContinue} className="flex w-full flex-col gap-3">
          {live ? (
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
                onClick={() => void startOver()}
                disabled={step !== null}
                className="min-h-10 shrink-0 rounded-full border border-line px-4 text-[.95rem] font-medium hover:bg-tint disabled:opacity-50"
              >
                Change
              </button>
            </div>
          ) : null}
          <button
            type="submit"
            disabled={step !== null || restoring}
            className="flex min-h-[60px] w-full items-center justify-center gap-2.5 rounded-full bg-accent px-6 text-[1.1rem] font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60"
          >
            {step === 'signing'
              ? 'Confirming your sign-in…'
              : step === 'creating'
                ? 'Making your wallet…'
                : restoring
                  ? 'One moment…'
                  : 'Continue'}
          </button>
          {onClose && step === null ? (
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
