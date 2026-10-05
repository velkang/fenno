import React, { useEffect, useState, useCallback } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { SPRING, fade, lift } from './lib/motion'
import { Header, type PageRoute } from './components/Header'
import { AuthScreen } from './components/AuthScreen'
import { ExplorePage } from './pages/ExplorePage'
import { SwapPage } from './pages/SwapPage'
import { PoolPage } from './pages/PoolPage'
import { PondPage } from './pages/PondPage'
import { PositionsPage } from './pages/PositionsPage'
import { WalletPanel } from './components/WalletPanel'
import {
  IntentActionModal,
  type ModalType,
} from './components/IntentActionModal'
import { ToastContainer, type ToastMessage } from './components/Toast'
import { api, type AuthUser, type ManagedWalletRecord } from './lib/api-client'
import type { WalletSummary, Waters } from '@stillwater/chain'

const WALLET_POLL_INTERVAL_MS = 60_000

function getPageFromLocation(): PageRoute {
  const path = window.location.pathname.toLowerCase().replace(/\/+$/, '') || '/'
  if (path === '/positions') return 'positions'
  if (path === '/explore') return 'explore'
  if (path === '/swap') return 'swap'
  if (/^\/pools\/0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(path)) return 'pool'
  // "/" and anything unknown open the Pond.
  return 'pond'
}

const PAGE_PATH: Record<Exclude<PageRoute, 'pool'>, string> = {
  pond: '/',
  positions: '/positions',
  explore: '/explore',
  swap: '/swap',
}

function getWatersFromLocation(): Waters | '' {
  const waters = new URLSearchParams(window.location.search).get('waters')
  return waters === 'still' || waters === 'gentle' || waters === 'rapids'
    ? waters
    : ''
}

export const App: React.FC = () => {
  // Navigation State (Page-based routing)
  const [activePage, setActivePage] = useState<PageRoute>(getPageFromLocation)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [showWallet, setShowWallet] = useState(false)
  const [waters, setWaters] = useState<Waters | ''>(getWatersFromLocation)
  const [poolAddress, setPoolAddress] = useState<string | null>(() => {
    const match = window.location.pathname.match(
      /^\/pools\/(0x(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64}))\/?$/,
    )
    return match?.[1] ?? null
  })

  // Normalize legacy hash URLs and keep the page in sync with browser navigation.
  useEffect(() => {
    const syncPageFromLocation = () => {
      const page = getPageFromLocation()
      setActivePage(page)
      setWaters(getWatersFromLocation())
      const match = window.location.pathname.match(
        /^\/pools\/(0x(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64}))\/?$/,
      )
      setPoolAddress(match?.[1] ?? null)

      const path = page === 'pool' ? window.location.pathname : PAGE_PATH[page]
      if (window.location.pathname !== path || window.location.hash) {
        window.history.replaceState(
          null,
          '',
          `${path}${page === 'explore' ? window.location.search : ''}`,
        )
      }
    }

    syncPageFromLocation()
    window.addEventListener('popstate', syncPageFromLocation)
    return () => window.removeEventListener('popstate', syncPageFromLocation)
  }, [])

  const handleNavigate = (page: PageRoute) => {
    if (page === 'pool') return
    setActivePage(page)
    if (page === 'explore') setWaters('')
    const path = PAGE_PATH[page]
    if (
      window.location.pathname !== path ||
      window.location.search ||
      window.location.hash
    ) {
      window.history.pushState(null, '', path)
    }
  }

  /** Explore, optionally narrowed to one kind of water (kept in the URL). */
  const handleExplore = (next: Waters | '' = '') => {
    setWaters(next)
    setActivePage('explore')
    const url = next ? `/explore?waters=${next}` : '/explore'
    if (`${window.location.pathname}${window.location.search}` !== url)
      window.history.pushState(null, '', url)
  }

  const handleSelectPool = (address: string) => {
    setPoolAddress(address)
    setActivePage('pool')
    window.history.pushState(null, '', `/pools/${address}`)
  }

  // State
  const [user, setUser] = useState<AuthUser | null>(null)
  const [wallet, setWallet] = useState<ManagedWalletRecord | null>(null)
  const [summary, setSummary] = useState<WalletSummary | null>(null)
  const [modal, setModal] = useState<ModalType>(null)
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const addToast = (
    type: 'success' | 'error' | 'info',
    title: string,
    message?: string,
  ) => {
    const id = `toast_${Date.now()}_${Math.random()}`
    setToasts((prev) => [...prev, { id, type, title, message }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 5000)
  }

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  // Check existing session
  useEffect(() => {
    let mounted = true
    async function checkSession() {
      try {
        const res = await api.getMe()
        if (mounted && res?.user) {
          setUser(res.user)
        }
      } catch {
        // Not authenticated
      }
    }
    checkSession()
    return () => {
      mounted = false
    }
  }, [])

  // Load wallet data and summary in parallel
  const refreshData = useCallback(async () => {
    if (!user) return
    try {
      const [walletRes, summaryRes] = await Promise.all([
        api.getMyWallet().catch(() => null),
        api.getWalletSummary().catch(() => null),
      ])
      if (walletRes?.wallet) setWallet(walletRes.wallet)
      if (summaryRes?.summary) setSummary(summaryRes.summary)
    } catch (err) {
      console.error('Failed to load wallet data', err)
    }
  }, [user])

  // Poll only while the tab is visible, and refresh as soon as it becomes visible
  // again. Each poll is two API requests, which count toward the Workers free
  // plan's 100k requests per day.
  useEffect(() => {
    if (!user) return
    refreshData()
    const refreshIfVisible = () => {
      if (!document.hidden) refreshData()
    }
    const interval = setInterval(refreshIfVisible, WALLET_POLL_INTERVAL_MS)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [user, refreshData])

  const handleLogout = async () => {
    try {
      await api.logout()
    } catch {
      // ignore
    }
    setUser(null)
    setWallet(null)
    setSummary(null)
    addToast('info', 'Logged out')
  }

  const handleProvision = async () => {
    try {
      await api.provisionWallet()
      await refreshData()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Provisioning failed'
      addToast('error', 'Wallet not created', msg)
    }
  }

  return (
    // One place for motion: calm defaults, and none of it for people who ask for reduced motion.
    <MotionConfig reducedMotion="user" transition={SPRING}>
      <a
        href="#main"
        className="sr-only z-[90] rounded-full bg-accent px-5 py-3 font-semibold text-on-accent focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <Header
        user={user}
        walletAddress={wallet?.address}
        activePage={activePage}
        onNavigate={handleNavigate}
        onOpenAuthModal={() => setShowAuthModal(true)}
        onOpenWallet={() => setShowWallet(true)}
        walletOpen={showWallet}
      />

      <main
        id="main"
        tabIndex={-1}
        className="w-full flex-1 bg-paper outline-none px-[clamp(16px,4vw,80px)] pt-8 pb-12 text-ink max-[680px]:pt-5"
      >
        {activePage === 'pond' && (
          <PondPage
            user={user}
            wallet={wallet}
            summary={summary}
            onRefresh={refreshData}
            onNotify={addToast}
            onOpenPositions={() => handleNavigate('positions')}
            onOpenAuth={() => setShowAuthModal(true)}
            onExplore={(next) => handleExplore(next)}
            onOpenPool={handleSelectPool}
          />
        )}
        {activePage === 'positions' && (
          <PositionsPage
            user={user}
            wallet={wallet}
            summary={summary}
            onRefresh={refreshData}
            onNotify={addToast}
            onOpenModal={(next) => setModal(next)}
            onOpenAuth={() => setShowAuthModal(true)}
            onExplore={() => handleExplore()}
          />
        )}
        {activePage === 'explore' && (
          <ExplorePage
            waters={waters}
            onWatersChange={handleExplore}
            onSelectPool={handleSelectPool}
          />
        )}
        {activePage === 'pool' && poolAddress && (
          <PoolPage
            address={poolAddress}
            onBack={() => handleExplore(waters)}
            wallet={wallet}
            summary={summary}
            onRefresh={refreshData}
            onNotify={addToast}
            onOpenAuth={() => setShowAuthModal(true)}
          />
        )}
        {activePage === 'swap' && (
          <SwapPage
            wallet={wallet}
            summary={summary}
            onRefresh={refreshData}
            onNotify={addToast}
            onOpenAuth={() => setShowAuthModal(true)}
          />
        )}
      </main>
      <WalletPanel
        open={showWallet}
        wallet={wallet}
        canProvision={user !== null}
        ownerAddress={user?.ownerAddress ?? user?.address}
        summary={summary}
        onClose={() => setShowWallet(false)}
        onProvision={handleProvision}
        onLogout={() => {
          setShowWallet(false)
          void handleLogout()
        }}
        onRefresh={refreshData}
        onOpenAuth={() => {
          setShowWallet(false)
          setShowAuthModal(true)
        }}
        onNotify={addToast}
      />

      {/* SIWE Auth Modal Overlay */}
      <AnimatePresence>
        {showAuthModal && (
          <motion.div
            key="sign-in"
            {...fade}
            className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm"
            // Clicking the dimmed area outside the card closes the modal.
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setShowAuthModal(false)
            }}
          >
            <motion.div {...lift} className="relative w-full max-w-[560px]">
            <AuthScreen
              onAuthSuccess={(newUser) => {
                setUser(newUser)
                setShowAuthModal(false)
              }}
              onError={(msg) => addToast('error', 'Sign-in failed', msg)}
              onClose={() => setShowAuthModal(false)}
            />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <IntentActionModal
        // A fresh form for each position and action, so amounts never carry over.
        key={modal ? `${modal.kind}:${modal.position.tokenId}` : 'closed'}
        modal={modal}
        summary={summary}
        onClose={() => setModal(null)}
        onSuccess={refreshData}
        onNotify={addToast}
      />

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </MotionConfig>
  )
}
