import { useMemo, useState } from 'react'
import type { AlphaWalletSummary } from '@stillwater/chain'
import type { AuthUser, ManagedWalletRecord } from '../lib/api-client'
import type { ModalType } from '../components/IntentActionModal'
import {
  formatUsd,
  pondFromV4,
  pondsFromSummary,
  type Pond,
} from '../lib/ponds'
import { PondList, type PondAction } from '../components/pond/PondList'
import { useV4Ponds } from '../components/pond/useV4Ponds'
import { Loading, Skeleton } from '../components/Skeleton'

type Props = {
  user: AuthUser | null
  wallet: ManagedWalletRecord | null
  summary: AlphaWalletSummary | null
  onRefresh: () => Promise<void>
  onNotify: (
    type: 'success' | 'error' | 'info',
    title: string,
    message?: string,
  ) => void
  onOpenModal: (modal: ModalType) => void
  onOpenAuth: () => void
  onExplore: () => void
}

const V3_MODAL_KIND = {
  collect: 'collect',
  add: 'increase',
  remove: 'decrease',
  close: 'withdraw',
} as const
const PRIMARY =
  'min-h-[60px] rounded-full bg-accent px-8 text-[1.2rem] font-semibold text-on-accent hover:bg-accent-hover'

/** Every position in the Stillwater wallet, with its actions. */
export function PositionsPage({
  user,
  wallet,
  summary,
  onRefresh,
  onNotify,
  onOpenModal,
  onOpenAuth,
  onExplore,
}: Props) {
  const v4 = useV4Ponds(wallet, onRefresh, onNotify)
  const [collecting, setCollecting] = useState(false)
  const ponds = useMemo(
    () => [...v4.positions.map(pondFromV4), ...pondsFromSummary(summary)],
    [v4.positions, summary],
  )
  const collectable = ponds.filter(
    (pond) => pond.v4 && (pond.gatheredUsd ?? 0) >= 0.005,
  )
  const collectAllUsd = collectable.reduce(
    (sum, pond) => sum + (pond.gatheredUsd ?? 0),
    0,
  )
  const busy = collecting || v4.busy !== null || v4.pendingAttempt !== null

  const act = async (pond: Pond, action: PondAction) => {
    if (pond.v3) {
      onOpenModal({
        type: 'action',
        kind: V3_MODAL_KIND[action],
        position: pond.v3,
      })
      return
    }
    if (!pond.v4) return
    if (
      action === 'close' &&
      !window.confirm(
        `Close your ${pond.pair} pond? Both tokens and any fees it gathered go back to your Stillwater wallet.`,
      )
    )
      return
    await v4.run(pond.v4, action === 'close' ? 'withdraw' : 'collect')
  }

  const collectAll = async () => {
    setCollecting(true)
    let collected = 0
    try {
      for (const pond of collectable) {
        if (!(await v4.run(pond.v4!, 'collect', { quiet: true }))) break
        collected += pond.gatheredUsd ?? 0
      }
    } finally {
      setCollecting(false)
      await Promise.all([v4.refresh(), onRefresh()])
    }
    if (collected > 0)
      onNotify(
        'success',
        'Fees collected',
        `${formatUsd(collected)} is in your Stillwater wallet.`,
      )
  }

  const empty = ponds.length === 0
  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-6 pt-4 pb-12">
      {empty ? (
        <section
          aria-labelledby="positions-title"
          className="flex flex-col items-start gap-5"
        >
          <h1 id="positions-title" className="text-[2.4rem] font-semibold">
            Your positions
          </h1>
          {v4.loading && wallet ? (
            <PositionRowsSkeleton rows={3} />
          ) : (
            <>
              <p className="max-w-[560px] text-[1.15rem] leading-relaxed text-ink-muted">
                {user
                  ? 'You have no positions yet. Pick a pool to add liquidity and it shows up here.'
                  : 'Sign in to see your positions.'}
              </p>
              <button
                type="button"
                onClick={user ? onExplore : onOpenAuth}
                className={PRIMARY}
              >
                {user ? 'Explore pools' : 'Sign in'}
              </button>
            </>
          )}
        </section>
      ) : (
        <PondList
          ponds={ponds}
          busy={busy}
          collectAllUsd={collectAllUsd}
          onCollectAll={() => void collectAll()}
          onAction={(pond, action) => void act(pond, action)}
        />
      )}
      {v4.loading && !empty ? <PositionRowsSkeleton rows={2} /> : null}

      {v4.nextPage !== null ? (
        <button
          type="button"
          onClick={() => void v4.loadMore()}
          disabled={v4.loading}
          className="self-start text-[1rem] font-semibold text-link disabled:opacity-50"
        >
          Show more positions
        </button>
      ) : null}
      {v4.error ? (
        <p role="alert" className="text-danger">
          {v4.error}
        </p>
      ) : null}
    </div>
  )
}

/** Shaped like the rows in PondList: pair, state, value, gathered, Manage. */
function PositionRowsSkeleton({ rows }: { rows: number }) {
  return (
    <Loading label="Loading your positions…" className="w-full">
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,.8fr)_minmax(0,.7fr)_auto] items-center gap-4 border-b border-line py-6 max-[760px]:grid-cols-[minmax(0,1fr)_auto]"
        >
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-24 max-[760px]:justify-self-end" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-16 justify-self-end max-[760px]:justify-self-start" />
          <Skeleton className="h-11 w-28 justify-self-end max-[760px]:col-span-full max-[760px]:justify-self-start" />
        </div>
      ))}
    </Loading>
  )
}
