import { useMemo, useState } from 'react'
import type { WalletSummary } from '@stillwater/chain'
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
import { AnimatePresence, motion } from 'motion/react'
import { fade } from '../lib/motion'
import { runFailureMessage, useAutomationRuns, useMandates } from '../lib/automation'
import { RecentreDialog } from '../components/pond/RecentreDialog'
import { CareDialog } from '../components/pond/CareDialog'
import { CloseDialog } from '../components/pond/CloseDialog'

type Props = {
  user: AuthUser | null
  wallet: ManagedWalletRecord | null
  summary: WalletSummary | null
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
  const [recentring, setRecentring] = useState<Pond | null>(null)
  const [caring, setCaring] = useState<Pond | null>(null)
  const [closing, setClosing] = useState<Pond | null>(null)
  const { mandates, refresh: refreshMandates } = useMandates(wallet)
  const automation = useAutomationRuns(wallet, (run) => {
    if (run.status === 'done') {
      onNotify('success', 'Band re-centred', 'Your pond earns around today’s price again.')
    } else {
      onNotify('error', 'Re-centring stopped',
        `${runFailureMessage(run.failureReason)} Anything already taken out is in your Fenno wallet.`)
    }
    void Promise.all([v4.refresh(), onRefresh()])
  })
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
  const runningPools = new Set(automation.runs
    .filter((run) => run.status === 'running')
    .map((run) => run.poolId.toLowerCase()))
  const mandateFor = (pond: Pond) =>
    mandates.find((mandate) => mandate.poolId.toLowerCase() === pond.poolId.toLowerCase())
  const caredPonds = new Map(ponds.flatMap((pond) => {
    const mandate = mandateFor(pond)
    return mandate?.status === 'active' ? [[pond.key, mandate.mode] as const] : []
  }))
  const movingPonds = new Set(ponds
    .filter((pond) => runningPools.has(pond.poolId.toLowerCase()))
    .map((pond) => pond.key))

  const act = async (pond: Pond, action: PondAction) => {
    if (action === 'recentre') {
      setRecentring(pond)
      return
    }
    if (action === 'care') {
      setCaring(pond)
      return
    }
    if (pond.v3) {
      onOpenModal({ kind: V3_MODAL_KIND[action], position: pond.v3 })
      return
    }
    if (!pond.v4) return
    if (action === 'close') {
      setClosing(pond)
      return
    }
    await v4.run(pond.v4, 'collect')
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
        `${formatUsd(collected)} added to your wallet.`,
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
        // Fades in where the skeleton was.
        <motion.div {...fade}>
          <PondList
            ponds={ponds}
            busy={busy}
            collectAllUsd={collectAllUsd}
            onCollectAll={() => void collectAll()}
            onAction={(pond, action) => void act(pond, action)}
            recentring={movingPonds}
            cared={caredPonds}
            runs={automation.runs}
          />
        </motion.div>
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
      <AnimatePresence>
        {closing?.v4 ? (
          <CloseDialog
            key={closing.key}
            pair={closing.pair}
            onCancel={() => setClosing(null)}
            onConfirm={() => {
              const position = closing.v4!
              setClosing(null)
              void v4.run(position, 'withdraw')
            }}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {caring ? (
          <CareDialog
            key={caring.key}
            pond={caring}
            mandate={mandateFor(caring)}
            onClose={() => setCaring(null)}
            onSaved={(message) => {
              setCaring(null)
              onNotify('success', 'Saved', message)
              void refreshMandates()
            }}
            onError={(message) => onNotify('error', 'Couldn’t save', message)}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {recentring && (recentring.v4 ?? recentring.v3) ? (
          <RecentreDialog
            key={recentring.key}
            position={(recentring.v4 ?? recentring.v3)!}
            resting={recentring.state !== 'feeding'}
            onClose={() => setRecentring(null)}
            onStarted={() => {
              setRecentring(null)
              onNotify('info', 'Re-centring started')
              void automation.refresh()
            }}
            onError={(message) => onNotify('error', 'Couldn’t re-centre', message)}
          />
        ) : null}
      </AnimatePresence>
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
