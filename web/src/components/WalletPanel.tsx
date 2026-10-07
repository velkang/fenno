import { useEffect, useRef, useState } from 'react'
import { formatUnits, getAddress, isAddress, parseUnits, toHex } from 'viem'
import { useAccount, useChainId, useSignTypedData } from 'wagmi'
import {
  ARC_CHAIN_ID,
  tokenWithdrawalTypes,
  withdrawalDomain,
  withdrawalTypes,
  type WalletSummary,
} from '@stillwater/chain'
import { api, ApiError, type ManagedWalletRecord } from '../lib/api-client'
import { usePendingAttempt } from '../lib/attempts'
import { AnimatePresence, motion } from 'motion/react'
import { fade, slideFromRight } from '../lib/motion'
import { Underline } from './Underline'

const MUTED_TEXT = 'text-[1rem] leading-relaxed text-ink-muted'
const LABEL_TEXT = 'text-[.95rem] text-ink-muted'
const WARNING_TEXT = 'text-[1rem] leading-relaxed text-rest'
const OUTLINE_BUTTON =
  'min-h-11 rounded-full border border-line px-5 text-[1rem] font-medium text-ink hover:bg-tint'
const PRIMARY_BUTTON =
  'min-h-14 rounded-full bg-accent px-6 text-[1.05rem] font-semibold text-on-accent enabled:hover:bg-accent-hover'
const TAB_BUTTON =
  'relative min-h-12 text-[1.05rem] text-ink-muted aria-selected:font-semibold aria-selected:text-ink'
const FIELD_LABEL = 'grid gap-2 text-[.98rem] text-ink-muted'
const FIELD_INPUT =
  'min-h-[52px] w-full rounded-[14px] border border-line bg-field px-4 text-[1.05rem] text-ink'

type Props = {
  open: boolean
  wallet: ManagedWalletRecord | null
  canProvision: boolean
  ownerAddress?: string
  summary: WalletSummary | null
  onClose: () => void
  onProvision: () => Promise<void>
  onRefresh: () => Promise<void>
  onOpenAuth: () => void
  onLogout: () => void
  onNotify: (
    type: 'success' | 'error' | 'info',
    title: string,
    message?: string,
  ) => void
}

export function WalletPanel({
  open,
  wallet,
  canProvision,
  ownerAddress,
  summary,
  onClose,
  onProvision,
  onRefresh,
  onOpenAuth,
  onLogout,
  onNotify,
}: Props) {
  const [tab, setTab] = useState<'deposit' | 'withdraw'>('deposit')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState(false)
  const [maximum, setMaximum] = useState<bigint | null>(null)
  const [feeReserve, setFeeReserve] = useState<bigint | null>(null)
  const [assets, setAssets] = useState<
    Array<{ address: string; symbol: string; decimals: number; raw: string }>
  >([])
  // What to withdraw: USDC (empty), or another token the wallet holds, by address.
  const [assetAddress, setAssetAddress] = useState('')
  const token = assets.find((asset) => asset.address === assetAddress) ?? null
  // A withdrawal still confirming when the page was left is picked up again here.
  const { pending: pendingAttempt, track } = usePendingAttempt(
    wallet ? `stillwater_withdrawal_attempt_${wallet.id}` : null,
    (outcome) => {
      if (outcome.ok) onNotify('success', 'Withdrawal complete')
      else onNotify('error', 'Withdrawal failed', outcome.message)
      void onRefresh()
    },
  )
  const closeRef = useRef<HTMLButtonElement>(null)
  const { address: connectedAddress } = useAccount()
  const chainId = useChainId()
  const { signTypedDataAsync } = useSignTypedData()
  const connectedOwner =
    !!connectedAddress &&
    !!ownerAddress &&
    connectedAddress.toLowerCase() === ownerAddress.toLowerCase()
  const nativeRaw = BigInt(summary?.balances.nativeUsdc.raw ?? '0')
  const displayBalance = Number(formatUnits(nativeRaw, 18)).toLocaleString(
    'en-US',
    { maximumFractionDigits: 6 },
  )
  const validRecipient =
    isAddress(recipient) &&
    recipient.toLowerCase() !== wallet?.address.toLowerCase() &&
    recipient.toLowerCase() !== '0x0000000000000000000000000000000000000000'
  const symbol = token?.symbol ?? 'USDC'
  const decimals = token?.decimals ?? 6
  let parsedAmount = 0n
  try {
    parsedAmount = parseUnits(amount, decimals)
  } catch {
    /* pending input */
  }
  // USDC keeps back the network fee; another token can all go, as the fee is paid in USDC.
  const available = token ? BigInt(token.raw) : maximum
  const validAmount =
    parsedAmount > 0n && available !== null && parsedAmount <= available

  useEffect(() => {
    if (!open || !wallet || !isAddress(recipient)) {
      setMaximum(null)
      setFeeReserve(null)
      return
    }
    let current = true
    const timer = window.setTimeout(() => {
      api
        .getMaximumUsdcWithdrawal(recipient)
        .then((result) => {
          if (current) {
            setMaximum(BigInt(result.maximum))
            setFeeReserve(BigInt(result.feeReserve))
          }
        })
        .catch(() => {
          if (current) {
            setMaximum(null)
            setFeeReserve(null)
          }
        })
    }, 250)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [open, wallet, recipient])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open || !wallet) {
      setAssets([])
      return
    }
    let current = true
    api
      .getWalletAssets()
      .then((result) => {
        if (!current) return
        setAssets(result.assets)
        // A token that has all gone (withdrawn, swapped) falls back to USDC.
        setAssetAddress((selected) =>
          result.assets.some((asset) => asset.address === selected) ? selected : '')
      })
      .catch(() => {
        if (current) setAssets([])
      })
    return () => {
      current = false
    }
  }, [open, wallet, summary])

  const withdraw = async () => {
    if (
      !wallet ||
      !connectedOwner ||
      !validRecipient ||
      !validAmount ||
      chainId !== ARC_CHAIN_ID
    )
      return
    setBusy(true)
    try {
      const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)))
      const expiresAt = Math.floor(Date.now() / 1_000) + 5 * 60
      const message = {
        wallet: getAddress(wallet.address),
        recipient: getAddress(recipient),
        amount: parsedAmount,
        nonce,
        expiresAt: BigInt(expiresAt),
      }
      // A token's signature names the token, so it can't be used to move anything else.
      const signature = token
        ? await signTypedDataAsync({
            domain: withdrawalDomain,
            types: tokenWithdrawalTypes,
            primaryType: 'TokenWithdrawal',
            message: { ...message, token: getAddress(token.address) },
          })
        : await signTypedDataAsync({
            domain: withdrawalDomain,
            types: withdrawalTypes,
            primaryType: 'UsdcWithdrawal',
            message,
          })
      const prepared = await api.prepareWithdrawal({
        ...(token ? { token: token.address } : {}),
        recipient,
        amount: parsedAmount.toString(),
        nonce,
        expiresAt,
        signature,
      })
      const executed = await api.executeIntent(prepared.intentId)
      await track(executed.attemptId)
      onNotify(
        'success',
        'Withdrawal complete',
        `${amount} ${symbol} sent.`,
      )
      setAmount('')
      setRecipient('')
      setReview(false)
      await onRefresh()
    } catch (error) {
      onNotify(
        'error',
        'Withdrawal failed',
        error instanceof ApiError &&
          error.code === 'INSUFFICIENT_USDC_AFTER_FEES'
          ? token
            ? 'Not enough USDC for the network fee. Add a little USDC first.'
            : 'Not enough USDC for the fee. Try less.'
          : error instanceof ApiError && error.code === 'INSUFFICIENT_TOKEN_BALANCE'
            ? `You don't hold that much ${symbol}.`
          : error instanceof Error
            ? error.message
            : 'Try again.',
      )
      // A failed withdrawal can still have cost a network fee: show current balances now.
      void onRefresh()
    } finally {
      setBusy(false)
    }
  }

  // Kept mounted so closing can slide out; the scrim fades while the panel slides.
  return (
    <AnimatePresence>
    {open ? (
    <motion.div
      key="wallet-panel"
      {...fade}
      className="fixed inset-0 z-70 flex justify-end bg-scrim text-ink"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <motion.section
        {...slideFromRight}
        className="h-full w-[min(460px,100%)] overflow-auto overscroll-contain rounded-l-[28px] bg-card p-8 shadow-2xl max-[520px]:rounded-none max-[520px]:p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-panel-title"
      >
        <div className="flex items-start justify-between border-b border-line pb-[22px]">
          <div>
            <h2 id="wallet-panel-title" className="text-[2rem] font-semibold">
              Wallet
            </h2>
            <p className={MUTED_TEXT}>Your Stillwater wallet on Arc</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close wallet"
            className={OUTLINE_BUTTON}
          >
            Close
          </button>
        </div>
        {!wallet ? (
          <div className="grid gap-4 py-[30px]">
            <p>
              {canProvision
                ? 'Create your Stillwater wallet to receive Arc USDC.'
                : 'Sign in to create your Stillwater wallet.'}
            </p>
            {!canProvision ? (
              <button
                type="button"
                onClick={onOpenAuth}
                className={PRIMARY_BUTTON}
              >
                Sign in
              </button>
            ) : null}
            {canProvision ? (
              <button
                type="button"
                onClick={onProvision}
                className={PRIMARY_BUTTON}
              >
                Create wallet
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="mt-6 grid gap-2 rounded-[22px] bg-sage px-6 py-5">
              <span className={LABEL_TEXT}>USDC</span>
              <strong className="text-[2.4rem] leading-tight font-semibold tabular-nums">
                {displayBalance}
              </strong>
              <small className={MUTED_TEXT}>
                One balance for transactions and Arc network fees
              </small>
            </div>
            <div className="grid gap-2.5 border-b border-line py-6">
              <span className={LABEL_TEXT}>Stillwater address</span>
              <code className="font-mono text-[.9rem] leading-normal wrap-anywhere text-ink">
                {wallet.address}
              </code>
              <button
                type="button"
                className={`${OUTLINE_BUTTON} justify-self-start`}
                onClick={async () => {
                  await navigator.clipboard.writeText(wallet.address)
                  onNotify('info', 'Address copied')
                }}
              >
                Copy address
              </button>
            </div>
            <div
              className="mt-2 flex gap-8 border-b border-line"
              role="tablist"
              aria-label="Wallet actions"
            >
              <button
                type="button"
                role="tab"
                className={TAB_BUTTON}
                aria-selected={tab === 'deposit'}
                onClick={() => {
                  setTab('deposit')
                  setReview(false)
                }}
              >
                Deposit
                {tab === 'deposit' ? <Underline id="wallet-tab" /> : null}
              </button>
              <button
                type="button"
                role="tab"
                className={TAB_BUTTON}
                aria-selected={tab === 'withdraw'}
                onClick={() => setTab('withdraw')}
              >
                Withdraw
                {tab === 'withdraw' ? <Underline id="wallet-tab" /> : null}
              </button>
            </div>
            {tab === 'deposit' ? (
              <div className="grid gap-4 py-[22px]">
                <p className={MUTED_TEXT}>
                  Send Arc USDC to the Stillwater address above from your wallet
                  or exchange. This same USDC pays network fees and funds
                  positions.
                </p>
                <a
                  className="text-[1rem] font-medium text-link underline underline-offset-4"
                  href={`https://explorer.arc.io/address/${wallet.address}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View address on Arc Explorer
                </a>
              </div>
            ) : (
              <form
                className="grid gap-4 py-[22px]"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (review) void withdraw()
                  else setReview(true)
                }}
              >
                {assets.length > 0 ? (
                  <fieldset className="grid gap-2">
                    <legend className="mb-2 text-[.98rem] text-ink-muted">What to withdraw</legend>
                    <div className="flex flex-wrap gap-2">
                      {[{ address: '', symbol: 'USDC' }, ...assets].map((option) => (
                        <button
                          key={option.address || 'usdc'}
                          type="button"
                          aria-pressed={assetAddress === option.address}
                          onClick={() => {
                            setAssetAddress(option.address)
                            setAmount('')
                            setReview(false)
                          }}
                          className="min-h-11 whitespace-nowrap rounded-full border border-line px-4 text-[1rem] font-medium text-ink hover:bg-tint aria-pressed:border-accent aria-pressed:bg-feed-soft aria-pressed:font-semibold"
                        >
                          {option.symbol}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
                <label className={FIELD_LABEL}>
                  Recipient address
                  <input
                    className={FIELD_INPUT}
                    name="withdraw-recipient"
                    spellCheck={false}
                    value={recipient}
                    onChange={(event) => {
                      setRecipient(event.target.value)
                      setMaximum(null)
                      setFeeReserve(null)
                      setReview(false)
                    }}
                    placeholder="0x…"
                    autoComplete="off"
                  />
                </label>
                <label className={FIELD_LABEL}>
                  Amount in {symbol}
                  <input
                    className={FIELD_INPUT}
                    name="withdraw-amount"
                    autoComplete="off"
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value)
                      setReview(false)
                    }}
                    inputMode="decimal"
                    placeholder="0.00"
                  />
                </label>
                <button
                  type="button"
                  className="min-h-11 justify-self-start text-[1rem] font-semibold text-link disabled:opacity-50"
                  disabled={available === null}
                  onClick={() => {
                    setAmount(formatUnits(available ?? 0n, decimals))
                    setReview(false)
                  }}
                >
                  {token ? `Use all ${token.symbol}` : 'Use all after the network fee'}
                </button>
                {review && validRecipient && validAmount ? (
                  <p
                    className={`${MUTED_TEXT} rounded-[18px] bg-sage p-4 wrap-anywhere`}
                  >
                    Send {amount} {symbol} to{' '}
                    <code className="text-ink">{getAddress(recipient)}</code>
                    .{' '}
                  </p>
                ) : null}
                <button
                  className={`${PRIMARY_BUTTON} disabled:cursor-not-allowed disabled:opacity-45`}
                  disabled={
                    !validRecipient ||
                    !validAmount ||
                    busy ||
                    pendingAttempt !== null ||
                    !connectedOwner ||
                    chainId !== ARC_CHAIN_ID
                  }
                  type="submit"
                >
                  {busy
                    ? 'Sending…'
                    : pendingAttempt
                      ? 'Confirming your last withdrawal…'
                      : review
                      ? 'Confirm withdrawal'
                      : 'Review withdrawal'}
                </button>
                {chainId !== ARC_CHAIN_ID ? (
                  <p className={WARNING_TEXT}>
                    Your sign-in isn't on Arc Mainnet. Log out and sign in again
                    to withdraw.
                  </p>
                ) : null}
                {!connectedOwner ? (
                  <p className={WARNING_TEXT}>
                    Sign in again to confirm a withdrawal.
                  </p>
                ) : null}
                <p className={MUTED_TEXT}>
                  {token
                    ? `The network fee is paid from your USDC${feeReserve === null ? '' : `, about ${formatUnits(feeReserve, 18)} USDC`}.`
                    : feeReserve === null
                      ? 'Enter a recipient to estimate the network-fee reserve.'
                      : `Estimated fee reserve: ${formatUnits(feeReserve, 18)} USDC.`}
                </p>
              </form>
            )}
            {assets.length > 0 ? (
              <div className="mt-2 flex flex-wrap justify-between gap-3 border-t border-line pt-5 text-[1.05rem] tabular-nums">
                <span className={LABEL_TEXT}>Other assets</span>
                {assets.map((asset) => (
                  <strong key={asset.address} title={asset.address}>
                    {formatUnits(BigInt(asset.raw), asset.decimals)}{' '}
                    {asset.symbol}
                  </strong>
                ))}
              </div>
            ) : null}
          </>
        )}
        {canProvision ? (
          <div className="mt-8 border-t border-line pt-5">
            <button
              type="button"
              onClick={onLogout}
              className="min-h-11 text-[1rem] font-medium text-ink-muted hover:text-ink"
            >
              Log out
            </button>
          </div>
        ) : null}
      </motion.section>
    </motion.div>
    ) : null}
    </AnimatePresence>
  )
}
