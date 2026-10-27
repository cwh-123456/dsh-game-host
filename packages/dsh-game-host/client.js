/**
 * dsh-game-host — browser half.
 *
 * A full-page "game deck": a `main` panel plus a sidebar entry. Games register
 * themselves into the chain child slot (`game.stage`) from their own packages.
 * The page also shows in-page alerts for the current session: a pending
 * approval / question / plan review, and "this turn finished".
 */
window.__ModuleLoader__.load({
  id: 'dsh-game-host',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'gameHost'
    const PANEL_ID = 'games'
    const PREFS_KEY = 'dsh.gameHost.v1'

    const zh = {
      panel: '游戏',
      title: '游戏平台',
      back: '返回对话',
      noGame: '未选择游戏',
      noGames: '暂无游戏',
      empty: '还没有可玩的游戏',
      emptyHint: '安装游戏包后，它会自动出现在左侧目录里。',
      approvalPrefix: '需要你批准：',
      approvalPlain: '需要你批准一项操作',
      questionPrefix: '需要你回答：',
      questionPlain: '有一个问题等你回答',
      planReview: '有一份计划等你审阅',
      completed: '本轮完成',
      goHandle: '去处理',
      goAnswer: '去回答',
      goReview: '去审阅',
      goChat: '回到会话',
      dismiss: '忽略',
      untitled: '未命名对话',
      unnamedWorkspace: '未命名工作区',
    }
    const en = {
      panel: 'Games',
      title: 'Game Deck',
      back: 'Back to chat',
      noGame: 'No game selected',
      noGames: 'No games',
      empty: 'No games installed yet',
      emptyHint: 'Installed game packages appear in the list automatically.',
      approvalPrefix: 'Approval needed: ',
      approvalPlain: 'An action needs your approval',
      questionPrefix: 'Answer needed: ',
      questionPlain: 'A question is waiting for you',
      planReview: 'A plan is waiting for your review',
      completed: 'This turn finished',
      goHandle: 'Handle it',
      goAnswer: 'Answer',
      goReview: 'Review',
      goChat: 'Back to chat',
      dismiss: 'Dismiss',
      untitled: 'Untitled chat',
      unnamedWorkspace: 'Unnamed workspace',
    }

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set: (next) => {
          if (Object.is(next, value)) return
          value = next
          for (const listener of Array.from(listeners)) {
            try {
              listener()
            } catch (error) {
              console.error('[game-host] store listener failed', error)
            }
          }
        },
      }
    }

    function loadPrefs() {
      try {
        const raw = localStorage.getItem(PREFS_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch (error) {
        return {}
      }
    }

    function savePrefs(patch) {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }))
      } catch (error) {
        console.error('[game-host] save prefs failed', error)
      }
    }

    function GameIcon({ size = 18 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('rect', { x: 1.6, y: 4.6, width: 12.8, height: 6.8, rx: 3.4, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M4.9 8h2M5.9 7v2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        h('circle', { cx: 10.4, cy: 7.7, r: 0.7, fill: 'currentColor' }),
        h('circle', { cx: 11.6, cy: 8.9, r: 0.7, fill: 'currentColor' }),
      )
    }

    function EmptyStage({ t, compact }) {
      return h(
        'div',
        {
          style: {
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: compact ? 12 : 24,
            textAlign: 'center',
            color: 'var(--dsw-alias-label-tertiary)',
          },
        },
        h('div', { style: { fontSize: compact ? 12 : 14 } }, t('empty')),
        compact ? null : h('div', { style: { fontSize: 12, opacity: 0.75, maxWidth: 340, lineHeight: 1.6 } }, t('emptyHint')),
      )
    }

    function AlertBanner({ meta, text, actionLabel, onAction, onDismiss, tone }) {
      const accent = tone === 'warn' ? '#E18A00' : '#3B82F6'
      return h(
        'div',
        {
          role: 'status',
          'aria-live': 'polite',
          style: {
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 18px',
            fontSize: 12,
            background: 'var(--dsw-alias-interactive-bg-hover)',
            borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
            color: 'var(--dsw-alias-label-primary)',
          },
        },
        h('span', { style: { width: 6, height: 6, borderRadius: 3, background: accent, flex: '0 0 auto' } }),
        h(
          'span',
          {
            title: meta,
            style: {
              flex: '0 0 auto',
              maxWidth: '38%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 11,
              color: 'var(--dsw-alias-label-tertiary)',
            },
          },
          meta,
        ),
        h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, text),
        onAction
          ? h(
              'button',
              {
                type: 'button',
                onClick: onAction,
                style: {
                  flex: '0 0 auto',
                  border: 0,
                  borderRadius: 6,
                  padding: '3px 10px',
                  cursor: 'pointer',
                  fontSize: 12,
                  color: '#FFFFFF',
                  background: accent,
                },
              },
              actionLabel,
            )
          : null,
        onDismiss
          ? h(
              'button',
              {
                type: 'button',
                onClick: onDismiss,
                title: 'dismiss',
                style: {
                  flex: '0 0 auto',
                  border: 0,
                  background: 'transparent',
                  cursor: 'pointer',
                  fontSize: 14,
                  lineHeight: 1,
                  padding: '2px 4px',
                  color: 'var(--dsw-alias-label-tertiary)',
                },
              },
              '×',
            )
          : null,
      )
    }

    function mainSessionIdOf(list) {
      if (!list || !Array.isArray(list.ids)) return undefined
      for (const id of list.ids) {
        const row = list.byId ? list.byId[id] : undefined
        if (row && row.retainedBy && row.retainedBy.mainView > 0) return id
      }
      return undefined
    }

    function pendingLabel(pending, t) {
      if (!pending) return ''
      if (pending.kind === 'approval') {
        const name = pending.displayReason || pending.toolName || pending.reason
        return name ? t('approvalPrefix') + name : t('approvalPlain')
      }
      if (pending.kind === 'plan-review') return t('planReview')
      if (pending.kind === 'question') {
        const list = pending.questions
        const first = Array.isArray(list) && list.length > 0 ? list[0] : undefined
        const label = first ? first.header || first.question : undefined
        return label ? t('questionPrefix') + String(label) : t('questionPlain')
      }
      return pending.toolName || String(pending.kind || '')
    }

    function actionLabelOf(pending, t) {
      if (!pending) return t('goChat')
      if (pending.kind === 'approval') return t('goHandle')
      if (pending.kind === 'question') return t('goAnswer')
      if (pending.kind === 'plan-review') return t('goReview')
      return t('goChat')
    }

    function workspaceTitleOf(workspace, t) {
      if (!workspace) return t('unnamedWorkspace')
      if (workspace.title) return workspace.title
      if (workspace.path) {
        const parts = String(workspace.path).split(/[\\/]/).filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : String(workspace.path)
      }
      return t('unnamedWorkspace')
    }

    function buildAlerts({ sessionsList, workspacesList, statusMap, mainSessionId, mainCompletedAt, dismissed, t }) {
      const alerts = []
      if (!statusMap) return alerts
      const sessionById = (sessionsList && sessionsList.byId) || {}
      const listed = workspacesList && Array.isArray(workspacesList.items) ? workspacesList.items : []
      const groups =
        listed.length > 0
          ? listed.map((workspace) => ({ workspace, sessionIds: workspace.sessionIds || [] }))
          : [{ workspace: undefined, sessionIds: (sessionsList && sessionsList.ids) || [] }]
      const seen = new Set()

      for (const group of groups) {
        const workspaceTitle = group.workspace ? workspaceTitleOf(group.workspace, t) : ''
        for (const sessionId of group.sessionIds) {
          // Sub-agent sessions surface as bare UUIDs; only user-facing
          // conversations (`session-<uuid>`) are worth alerting about.
          if (!String(sessionId).startsWith('session-')) continue
          const row = sessionById[sessionId]
          if (!row || row.blank) continue
          const status = statusMap.get(sessionId)
          if (!status) continue
          const sessionTitle = row.title || t('untitled')
          const pending = status.pendingInteraction
          if (pending) {
            const id = sessionId + ':' + pending.kind + ':' + (pending.callId || pending.toolName || '')
            if (dismissed[id] || seen.has(id)) continue
            seen.add(id)
            alerts.push({
              id,
              sessionId,
              workspaceTitle,
              sessionTitle,
              kind: pending.kind,
              pending,
              attention: true,
              text: pendingLabel(pending, t),
              actionLabel: actionLabelOf(pending, t),
              updatedAt: row.updatedAt || 0,
            })
            continue
          }
          if (sessionId !== mainSessionId && status.completionUnread) {
            const id = sessionId + ':completed'
            if (dismissed[id] || seen.has(id)) continue
            seen.add(id)
            alerts.push({
              id,
              sessionId,
              workspaceTitle,
              sessionTitle,
              kind: 'completed',
              pending: undefined,
              attention: false,
              text: t('completed'),
              actionLabel: t('goChat'),
              updatedAt: row.updatedAt || 0,
            })
          }
        }
      }

      if (mainCompletedAt && mainSessionId) {
        const id = mainSessionId + ':completed'
        if (!dismissed[id]) {
          const workspace = listed.find((item) => (item.sessionIds || []).includes(mainSessionId))
          const row = sessionById[mainSessionId]
          alerts.push({
            id,
            sessionId: mainSessionId,
            workspaceTitle: workspaceTitleOf(workspace, t),
            sessionTitle: (row && row.title) || t('untitled'),
            kind: 'completed',
            pending: undefined,
            attention: false,
            text: t('completed'),
            actionLabel: t('goChat'),
            updatedAt: (row && row.updatedAt) || 0,
          })
        }
      }

      alerts.sort((a, b) => {
        if (a.attention !== b.attention) return a.attention ? -1 : 1
        return (b.updatedAt || 0) - (a.updatedAt || 0)
      })
      return alerts
    }

    function GamePage(props) {
      const {
        t,
        onBack,
        renderSlotChain,
        useGames,
        useSelectedId,
        selectGame,
        useSessions,
        useSessionStatus,
        useWorkspaces,
        goToConversation,
      } = props

      const games = typeof useGames === 'function' ? useGames((rows) => rows) : []
      const selectedId = typeof useSelectedId === 'function' ? useSelectedId((id) => id) : null
      const rows = Array.isArray(games) ? games : []
      const hasGames = rows.length > 0
      const current = hasGames ? rows.find((row) => row.id === selectedId) : undefined

      const sessionsList = typeof useSessions === 'function' ? useSessions((list) => list) : undefined
      const workspacesList = typeof useWorkspaces === 'function' ? useWorkspaces((snapshot) => snapshot) : undefined
      const statusMap = typeof useSessionStatus === 'function' ? useSessionStatus((map) => map) : undefined

      const mainSessionId = sessionsList ? mainSessionIdOf(sessionsList) : undefined
      const mainStatus = statusMap && mainSessionId !== undefined ? statusMap.get(mainSessionId) : undefined
      const mainRunning = mainStatus ? mainStatus.running === true : false
      const mainPending = mainStatus ? mainStatus.pendingInteraction : undefined

      const [completedAt, setCompletedAt] = React.useState(0)
      const previousRunning = React.useRef(mainRunning)

      React.useEffect(() => {
        const wasRunning = previousRunning.current
        previousRunning.current = mainRunning
        if (!wasRunning || mainRunning) return undefined
        if (mainPending) return undefined
        const timer = setTimeout(() => setCompletedAt(Date.now()), 1000)
        return () => clearTimeout(timer)
      }, [mainRunning, mainPending])

      React.useEffect(() => {
        if (!completedAt) return undefined
        const timer = setTimeout(() => setCompletedAt(0), 12000)
        return () => clearTimeout(timer)
      }, [completedAt])

      const [dismissed, setDismissed] = React.useState({})
      const alerts = buildAlerts({
        sessionsList,
        workspacesList,
        statusMap,
        mainSessionId,
        mainCompletedAt: completedAt,
        dismissed,
        t,
      })

      const openAlert = (alert) => {
        if (!alert) return
        if (typeof goToConversation === 'function') {
          goToConversation(alert.sessionId, alert.kind === 'completed' ? null : alert.pending)
        }
        if (alert.kind === 'completed' && alert.sessionId === mainSessionId) setCompletedAt(0)
      }

      const dismissAlert = (alert) => {
        if (!alert) return
        setDismissed((previous) => ({ ...previous, [alert.id]: true }))
        if (alert.kind === 'completed' && alert.sessionId === mainSessionId) setCompletedAt(0)
      }

      return h(
        'section',
        {
          'data-plugin-panel': true,
          style: {
            boxSizing: 'border-box',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-primary)',
            overflow: 'hidden',
          },
        },
        h(
          'header',
          {
            'data-window-drag': true,
            style: {
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 18px',
              borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
            },
          },
          h('h1', { style: { margin: 0, fontSize: 15, fontWeight: 500, flex: '0 0 auto' } }, t('title')),
          h(
            'span',
            {
              style: {
                flex: 1,
                fontSize: 12,
                color: 'var(--dsw-alias-label-tertiary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            current ? current.label : t('noGame'),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: onBack,
              style: {
                flex: '0 0 auto',
                border: 0,
                borderRadius: 6,
                padding: '4px 10px',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                cursor: 'pointer',
                fontSize: 12,
              },
            },
            t('back'),
          ),
        ),
        alerts.length > 0
          ? h(
              'div',
              { style: { flex: '0 0 auto', maxHeight: 168, overflowY: 'auto' } },
              alerts.slice(0, 8).map((alert) =>
                h(AlertBanner, {
                  key: alert.id,
                  tone: alert.attention ? 'warn' : 'info',
                  meta: alert.workspaceTitle ? alert.workspaceTitle + ' · ' + alert.sessionTitle : alert.sessionTitle,
                  text: alert.text,
                  actionLabel: alert.actionLabel,
                  onAction: () => openAlert(alert),
                  onDismiss: () => dismissAlert(alert),
                }),
              ),
              alerts.length > 8
                ? h(
                    'div',
                    { style: { padding: '4px 18px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } },
                    '+' + String(alerts.length - 8),
                  )
                : null,
            )
          : null,
        h(
          'div',
          { style: { flex: 1, minHeight: 0, display: 'flex' } },
          h(
            'nav',
            {
              style: {
                flex: '0 0 auto',
                width: 180,
                padding: 8,
                overflow: 'auto',
                borderRight: '0.5px solid var(--dsw-alias-border-l1)',
              },
            },
            hasGames
              ? rows.map((row) =>
                  h(
                    'button',
                    {
                      key: row.id,
                      type: 'button',
                      title: row.label,
                      onClick: () => selectGame(row.id),
                      style: {
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        border: 0,
                        borderRadius: 6,
                        padding: '7px 9px',
                        marginBottom: 2,
                        cursor: 'pointer',
                        fontSize: 13,
                        color: 'var(--dsw-alias-label-primary)',
                        background: row.id === selectedId ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
                      },
                    },
                    row.label,
                  ),
                )
              : h(
                  'p',
                  { style: { margin: 0, padding: '8px 9px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
                  t('noGames'),
                ),
          ),
          h(
            'div',
            { style: { flex: 1, minHeight: 0, position: 'relative', background: 'var(--dsw-alias-bg-base)' } },
            hasGames && typeof renderSlotChain === 'function'
              ? renderSlotChain('game.stage', { gameId: selectedId }, { fallback: h(EmptyStage, { t }) })
              : h(EmptyStage, { t }),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'game-host: dictionaries')
          const t = ctx.locale.bind(NS)

          const getService = (name) => {
            try {
              return typeof ctx.get === 'function' ? ctx.get(name) : undefined
            } catch (error) {
              return undefined
            }
          }

          const goToConversation = (sessionId, pending) => {
            try {
              const workspace = getService('uiWorkspace')
              if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
              else ctx.layout.selectPanel(null)
            } catch (error) {
              console.error('[game-host] open session failed', error)
              try {
                ctx.layout.selectPanel(null)
              } catch (inner) {
                console.error('[game-host] fallback panel switch failed', inner)
              }
            }
            const focusPending = () => {
              try {
                if (!pending) return
                if (pending.kind === 'approval') {
                  const node = document.querySelector('[data-approval-key]')
                  if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', behavior: 'smooth' })
                  return
                }
                if ((pending.kind === 'question' || pending.kind === 'plan-review') && pending.callId) {
                  const panels = getService('userQuestionPanels')
                  if (panels && typeof panels.reveal === 'function') panels.reveal(sessionId, pending.callId)
                }
              } catch (error) {
                console.error('[game-host] focus pending failed', error)
              }
            }
            if (typeof requestAnimationFrame === 'function') {
              requestAnimationFrame(() => requestAnimationFrame(focusPending))
            } else {
              setTimeout(focusPending, 32)
            }
          }

          const prefs = loadPrefs()
          let selected = typeof prefs.selected === 'string' ? prefs.selected : null
          const selectedStore = createStore(selected)
          const gamesStore = createStore([])

          const selectGame = (id) => {
            if (selected === id) return
            selected = id
            selectedStore.set(id)
            savePrefs({ selected: id })
          }

          const readCatalogue = () => {
            const catalogueRows = []
            const seen = new Set()
            let entries = []
            try {
              entries = typeof ctx.slots.entries === 'function' ? ctx.slots.entries('game.stage') || [] : []
            } catch (error) {
              console.error('[game-host] read catalogue failed', error)
              entries = []
            }
            for (const entry of entries) {
              const options = entry && entry.options ? entry.options : {}
              const id = options.id
              if (!id || seen.has(id)) continue
              seen.add(id)
              let label = options.label
              if (typeof label === 'function') {
                try {
                  label = label()
                } catch (error) {
                  label = id
                }
              }
              catalogueRows.push({ id, label: typeof label === 'string' && label ? label : id })
            }
            return catalogueRows
          }

          const refreshCatalogue = () => {
            try {
              const catalogueRows = readCatalogue()
              gamesStore.set(catalogueRows)
              if (!catalogueRows.some((row) => row.id === selected)) {
                selectGame(catalogueRows.length > 0 ? catalogueRows[0].id : null)
              }
            } catch (error) {
              console.error('[game-host] refresh catalogue failed', error)
            }
          }

          ctx.effect(() => {
            refreshCatalogue()
            let unsubscribe = null
            try {
              if (typeof ctx.slots.subscribe === 'function') {
                unsubscribe = ctx.slots.subscribe('game.stage', () => refreshCatalogue())
              }
            } catch (error) {
              console.error('[game-host] subscribe catalogue failed', error)
            }
            return () => {
              try {
                if (unsubscribe) unsubscribe()
              } catch (error) {
                console.error('[game-host] unsubscribe catalogue failed', error)
              }
            }
          }, 'game-host: catalogue')

          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                locale: NS,
                children: {
                  'game.stage': { kind: 'chain', scope: 'root' },
                },
                inject: () => ({
                  onBack: () => {
                    try {
                      ctx.layout.selectPanel(null)
                    } catch (error) {
                      console.error('[game-host] back to chat failed', error)
                    }
                  },
                  selectGame,
                  goToConversation,
                  hooks: { games: gamesStore, selectedId: selectedStore },
                }),
              },
              GamePage,
            ),
          )

          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 20,
                locale: NS,
                label: () => t('panel'),
              },
              GameIcon,
            ),
          )
        } catch (error) {
          console.error('[game-host] apply failed', error)
        }
      },
    }
  },
})
