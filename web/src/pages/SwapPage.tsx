import { useEffect, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { useChainId } from 'wagmi'
import { ARC_CHAIN_ID, type WalletSummary } from '@stillwater/chain'
import {
  api,
  ApiError,
  type ManagedWalletRecord,
  type PublicPool,
} from '../lib/api-client'
import {
  formatFeeTier,
  formatPoolPrice,
  PAGE_INTRO,
  PAGE_TITLE,
  poolSpotPrice,
} from './ExplorePage'
import { BalancePresets, useTokenBalance } from '../components/BalancePresets'
import { usePendingAttempt } from '../lib/attempts'
import { Underline } from '../components/Underline'
import {
  executePoolSwap,
  POOL_UNUSABLE_ERRORS,
  quotePoolSwap,
  swapDecimals,
  swapErrorMessage,
  type SwapQuote,
} from '../lib/swap-actions'
import { AlmostEmptyBadge, isAlmostEmpty, ProtocolBadge } from '../components/PoolBadges'

const CARD =
  'flex flex-col gap-5 rounded-[28px] border border-line bg-card p-[clamp(20px,2.6vw,36px)]'
const NOTE_TEXT = 'text-[1rem] text-ink-muted'
const FIELD_INPUT =
  'min-h-14 w-full rounded-[18px] border border-line bg-field px-5 text-[1.1rem] text-ink'
const TAB_BUTTON =
  'relative min-h-11 pb-3 text-[1.15rem] text-ink-muted aria-selected:font-semibold aria-selected:text-ink'
const DETAIL_ROW = 'flex justify-between gap-3 py-2.5 text-[1rem]'
const DETAIL_VALUE = 'text-ink tabular-nums'
const PRIMARY_BUTTON =
  'min-h-[60px] w-full rounded-full bg-accent px-6 text-[1.1rem] font-semibold text-on-accent enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-tint disabled:text-ink-faint'

type Props = {
  initialPoolAddress?: string
  wallet: ManagedWalletRecord | null
  summary: WalletSummary | null
  onRefresh: () => Promise<void>
  onOpenAuth: () => void
  onNotify: (
    type: 'success' | 'error' | 'info',
    title: string,
    message?: string,
  ) => void
  onSwapComplete?: () => void
}

const errorCode = (reason: unknown) =>
  reason instanceof ApiError
    ? reason.code
    : reason instanceof Error
      ? reason.message
      : 'Try again.'
// After these, the reviewed quote is no longer usable and the user must review a new one.
const QUOTE_RESET_ERRORS = new Set([
  ...POOL_UNUSABLE_ERRORS,
  'V4_QUOTE_STALE',
  'V4_APPROVAL_REQUIRED',
])

export function SwapPage({
  initialPoolAddress,
  wallet,
  summary,
  onRefresh,
  onOpenAuth,
  onNotify,
  onSwapComplete,
}: Props) {
  const chainId = useChainId()
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<PublicPool[]>([])
  const [pool, setPool] = useState<PublicPool | null>(null)
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<SwapQuote | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [poolQuoteUnavailable, setPoolQuoteUnavailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState(false)
  const {
    data: tokenBalance,
    refetch: refetchTokenBalance,
    isError: tokenBalanceError,
  } = useTokenBalance(pool?.token.address, wallet?.address)
  // A swap still confirming when the page was left is picked up again here.
  const { pending: pendingAttempt, track } = usePendingAttempt(
    wallet ? `stillwater_swap_attempt_${wallet.id}` : null,
    (outcome) => {
      if (outcome.ok) onNotify('success', 'Swap complete')
      else onNotify('error', 'Swap failed', outcome.message)
      void Promise.all([onRefresh(), refetchTokenBalance()])
    },
  )

  useEffect(() => {
    if (!initialPoolAddress) return
    let current = true
    api
      .getPool(initialPoolAddress)
      .then(({ pool: selected }) => {
        if (current) setPool(selected)
      })
      .catch((reason: unknown) => {
        if (current)
          setError(
            reason instanceof Error ? reason.message : 'Pool not available',
          )
      })
    return () => {
      current = false
    }
  }, [initialPoolAddress])

  useEffect(() => {
    if (pool) return
    let current = true
    const timer = window.setTimeout(() => {
      api
        .listPools(search)
        .then(({ pools }) => {
          if (current) setResults(pools.slice(0, 8))
        })
        .catch(() => {
          if (current) setResults([])
        })
    }, 250)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [search, pool])

  useEffect(() => {
    setQuote(null)
    setReview(false)
    setError(null)
    setPoolQuoteUnavailable(false)
    if (!pool || !wallet || !amount || chainId !== ARC_CHAIN_ID) return
    let raw: bigint
    try {
      raw = parseUnits(amount, swapDecimals(pool, direction, 'in'))
    } catch {
      return
    }
    if (raw <= 0n) return
    let current = true
    const timer = window.setTimeout(() => {
      quotePoolSwap(pool, direction, raw)
        .then((result) => {
          if (current) {
            setQuote(result)
            setError(null)
          }
        })
        .catch((reason: unknown) => {
          if (!current) return
          const code = errorCode(reason)
          setPoolQuoteUnavailable(POOL_UNUSABLE_ERRORS.has(code))
          setError(swapErrorMessage(code))
        })
    }, 350)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [pool, wallet, amount, direction, chainId])

  const chooseAnotherPool = () => {
    if (pool) setSearch(pool.token.address)
    setPool(null)
    setError(null)
    setPoolQuoteUnavailable(false)
  }

  const executeAndWait = async (intentId: string) => {
    const executed = await api.executeIntent(intentId)
    await track(executed.attemptId)
    return true
  }

  const submit = async () => {
    if (!pool || !quote || !wallet) return
    setBusy(true)
    try {
      const completed = await executePoolSwap({
        pool,
        direction,
        quote,
        execute: executeAndWait,
        onApprove: () =>
          onNotify(
            'info',
            'Approving the amount first',
          ),
      })
      if (!completed) return
      onNotify(
        'success',
        'Swap complete',
        `${direction === 'buy' ? 'Bought' : 'Sold'} ${pool.token.symbol}.`,
      )
      setAmount('')
      setQuote(null)
      setReview(false)
      await Promise.all([onRefresh(), refetchTokenBalance()])
      onSwapComplete?.()
    } catch (reason) {
      const code = errorCode(reason)
      if (QUOTE_RESET_ERRORS.has(code)) {
        setQuote(null)
        setReview(false)
        setPoolQuoteUnavailable(POOL_UNUSABLE_ERRORS.has(code))
        setError(swapErrorMessage(code))
      }
      onNotify('error', 'Swap failed', swapErrorMessage(code))
      // A failed swap can still have cost a network fee: show current balances now.
      void Promise.all([onRefresh(), refetchTokenBalance()])
    } finally {
      setBusy(false)
    }
  }

  const outputDecimals = pool ? swapDecimals(pool, direction, 'out') : 18
  const amountText = (raw: string) =>
    formatPoolPrice(Number(formatUnits(BigInt(raw), outputDecimals)))
  const paySymbol =
    direction === 'buy' ? 'USDC' : (pool?.token.symbol ?? 'Token')
  const receiveSymbol =
    direction === 'buy' ? (pool?.token.symbol ?? 'Token') : 'USDC'
  const embedded = Boolean(initialPoolAddress)
  return (
    <section
      className="mx-auto flex w-full max-w-[1280px] flex-col gap-8 text-ink"
      aria-labelledby={embedded ? undefined : 'swap-title'}
      aria-label={embedded ? 'Swap in this pool' : undefined}
    >
      {embedded ? null : (
        <div className="flex flex-col gap-2.5 pt-2">
          <h1 id="swap-title" className={PAGE_TITLE}>
            Swap
          </h1>
          <p className={PAGE_INTRO}>
            Trade in a pool you choose.
          </p>
        </div>
      )}
      <div
        className={
          embedded
            ? 'grid'
            : 'grid grid-cols-[minmax(0,1.15fr)_minmax(0,.85fr)] items-start gap-8 max-[900px]:grid-cols-1'
        }
      >
        {/* Opened from a pool, the pool is already chosen: only the trade shows. */}
        {embedded ? null : (
        <div className={CARD}>
          <h2 className="text-[1.75rem] font-semibold">
            {pool ? 'Your pool' : 'Choose a pool'}
          </h2>
          {pool ? (
            <div className="flex flex-col gap-2 rounded-[22px] bg-sage px-7 py-6">
              <strong className="flex flex-wrap items-center gap-3 text-[2.1rem] leading-tight font-semibold">
                {pool.token.symbol} / USDC
                <ProtocolBadge v4={pool.protocol === 'uniswap-v4'} />
                {isAlmostEmpty(pool) ? <AlmostEmptyBadge /> : null}
              </strong>
              <span className={NOTE_TEXT}>
                Fee {formatFeeTier(pool.fee)} · {pool.token.symbol} is $
                {formatPoolPrice(poolSpotPrice(pool))} now
              </span>
              <code className="font-mono text-[.9rem] break-all text-ink-muted">
                {pool.address}
              </code>
            </div>
          ) : (
            <>
              <input
                className={FIELD_INPUT}
                aria-label="Search token or contract address"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                name="swap-pool-search"
                type="search"
                autoComplete="off"
                spellCheck={false}
                placeholder="Search a token, or paste a contract address…"
              />
              <div className="flex flex-col">
                {results.map((candidate) => (
                  <button
                    type="button"
                    key={candidate.address}
                    className="flex justify-between gap-4 border-b border-line py-4 text-left text-[1.1rem] text-ink hover:text-link max-[520px]:flex-col max-[520px]:gap-1"
                    onClick={() => {
                      setPool(candidate)
                      setSearch('')
                    }}
                  >
                    <strong className="flex flex-wrap items-center gap-2.5 font-semibold">
                      {candidate.token.symbol} / USDC
                      <ProtocolBadge v4={candidate.protocol === 'uniswap-v4'} />
                      {isAlmostEmpty(candidate) ? <AlmostEmptyBadge /> : null}
                    </strong>
                    <span className={NOTE_TEXT}>
                      Fee {formatFeeTier(candidate.fee)} ·{' '}
                      {candidate.token.address.slice(0, 10)}…
                    </span>
                  </button>
                ))}
                {results.length === 0 ? (
                  <p className="py-6 text-[1.05rem] text-ink-muted">
                    No pools found. Try a contract address.
                  </p>
                ) : null}
              </div>
            </>
          )}
          {pool ? (
            <button
              type="button"
              className="min-h-11 self-start text-[1.1rem] font-semibold text-link"
              onClick={chooseAnotherPool}
            >
              Change pool
            </button>
          ) : null}
          <p className={`${NOTE_TEXT} leading-relaxed`}>
            A listed pool works with Stillwater. It is not a judgement on
            whether the token is safe.
          </p>
        </div>
        )}
        <div className={CARD}>
          <div
            className="flex gap-8 border-b border-line"
            role="tablist"
            aria-label="Swap direction"
          >
            <button
              type="button"
              role="tab"
              className={TAB_BUTTON}
              aria-selected={direction === 'buy'}
              onClick={() => {
                setDirection('buy')
                setAmount('')
              }}
            >
              Buy {pool?.token.symbol ?? 'token'}
              {direction === 'buy' ? <Underline id="swap-tab" /> : null}
            </button>
            <button
              type="button"
              role="tab"
              className={TAB_BUTTON}
              aria-selected={direction === 'sell'}
              onClick={() => {
                setDirection('sell')
                setAmount('')
              }}
            >
              Sell {pool?.token.symbol ?? 'token'}
              {direction === 'sell' ? <Underline id="swap-tab" /> : null}
            </button>
          </div>
          <label className="flex flex-col gap-2.5 text-[1.05rem] text-ink-muted">
            You pay
            <span className="flex min-h-[72px] items-center gap-3 rounded-[20px] border border-line bg-field px-5 focus-within:border-band">
              <input
                className="min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[1.7rem] text-ink tabular-nums shadow-none focus:border-0 focus:shadow-none"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                name="swap-amount"
                autoComplete="off"
                inputMode="decimal"
                placeholder="0.00"
              />
              <span className="text-[1.15rem] font-semibold text-ink">
                {paySymbol}
              </span>
            </span>
          </label>
          {direction === 'buy' && summary ? (
            <p className="text-[.98rem] text-ink-muted">
              Wallet:{' '}
              {Number(
                formatUnits(BigInt(summary.balances.nativeUsdc.raw), 18),
              ).toLocaleString('en-US', { maximumFractionDigits: 6 })}{' '}
              USDC · network fees use this too
            </p>
          ) : null}
          {direction === 'sell' && wallet && pool ? (
            <BalancePresets
              balance={tokenBalance}
              decimals={pool.token.decimals}
              symbol={pool.token.symbol}
              presets
              unavailable={tokenBalanceError}
              onSelect={setAmount}
            />
          ) : null}
          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-5">
            <span className="text-[1.1rem] text-ink-muted">
              You receive about
            </span>
            <strong className="text-right text-[2.1rem] font-semibold tabular-nums">
              {quote ? amountText(quote.expectedAmountOut) : '—'}{' '}
              <span className="text-[1.2rem]">{receiveSymbol}</span>
            </strong>
          </div>
          {quote ? (
            <dl className="flex flex-col border-t border-line">
              <div className={DETAIL_ROW}>
                <dt className="text-ink-muted">At least</dt>
                <dd className={DETAIL_VALUE}>
                  {amountText(quote.minimumAmountOut)} {receiveSymbol}
                </dd>
              </div>
              {quote.priceImpactBps !== undefined ? (
                <div className={DETAIL_ROW}>
                  <dt className="text-ink-muted">Price moves by</dt>
                  <dd className={`${DETAIL_VALUE} ${quote.priceImpactBps >= 100 ? 'text-rest' : ''}`}>
                    {(quote.priceImpactBps / 100).toFixed(2)}%
                  </dd>
                </div>
              ) : null}
              <div className={DETAIL_ROW}>
                <dt className="text-ink-muted">Pool fee</dt>
                <dd className={DETAIL_VALUE}>{formatFeeTier(pool?.fee)}</dd>
              </div>
            </dl>
          ) : null}
          {error ? (
            <div
              className="text-[1rem] leading-relaxed text-danger"
              role="alert"
            >
              <p>{error}</p>
              {/* In the buy drawer the pool is fixed, so there is no other pool to choose. */}
              {poolQuoteUnavailable && !embedded ? (
                <button
                  type="button"
                  className="mt-2 font-semibold text-ink underline underline-offset-4"
                  onClick={chooseAnotherPool}
                >
                  Choose another {pool?.token.symbol}/USDC pool
                </button>
              ) : null}
            </div>
          ) : null}
          {!wallet ? (
            <button
              className={PRIMARY_BUTTON}
              type="button"
              onClick={onOpenAuth}
            >
              Sign in to swap
            </button>
          ) : (
            <button
              className={PRIMARY_BUTTON}
              type="button"
              disabled={
                !pool ||
                !quote ||
                busy ||
                pendingAttempt !== null ||
                chainId !== ARC_CHAIN_ID
              }
              onClick={() => {
                if (review) void submit()
                else setReview(true)
              }}
            >
              {busy
                ? 'Working…'
                : pendingAttempt
                  ? 'Confirming your last swap…'
                  : review
                    ? 'Confirm swap'
                    : 'Review swap'}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
