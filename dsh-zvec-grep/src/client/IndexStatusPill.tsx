import { useEffect, useState } from 'react'
import type { PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { IndexStatusSnapshot, IndexStatusSource, WorkspaceIndexStatus } from './status-source.ts'

export type IndexStatusPillProps = PropsRuntime<'shell.overlay'> & {
  useIndexStatus: SnapshotSelectorHook<IndexStatusSnapshot>
  statusSource: Pick<IndexStatusSource, 'selectSession'>
}

const labels = {
  indexing: 'Indexing',
  refreshing: 'Refreshing',
  ready: 'Ready',
  error: 'Error',
} as const

const colors = {
  indexing: 'var(--dsw-alias-state-warn-primary)',
  refreshing: 'var(--dsw-alias-brand-primary)',
  ready: 'var(--dsw-alias-state-success-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
} as const

function currentWorkspace(props: IndexStatusPillProps): { sessionId: string; root: string } | undefined {
  return props.useSessions((state: { current?: string; byId: Record<string, { cwd?: string }> }) => {
    const current = state.current
    const root = current === undefined ? undefined : state.byId[current]?.cwd
    return current === undefined || root === undefined ? undefined : { sessionId: current, root }
  })
}

function displayStatus(feed: IndexStatusSnapshot): WorkspaceIndexStatus | { status: 'error'; pendingChanges: 0; updatedAt: number; errorCode: 'index_failed' } | undefined {
  if (feed.connection === 'error') {
    return { status: 'error', pendingChanges: 0, updatedAt: 0, errorCode: 'index_failed' }
  }
  return feed.status
}

export function IndexStatusPill(props: IndexStatusPillProps) {
  const [expanded, setExpanded] = useState(false)
  const workspace = currentWorkspace(props)
  const feed = props.useIndexStatus((value: IndexStatusSnapshot) => value)
  useEffect(() => {
    props.statusSource.selectSession(workspace?.sessionId)
  }, [props.statusSource, workspace?.sessionId])
  if (workspace === undefined) return null

  const status = displayStatus(feed)
  const phase = status?.status ?? 'indexing'
  const label = status === undefined && feed.connection === 'loading' ? 'Loading' : labels[phase]
  return (
    <div style={styles.anchor} data-zvec-index-status={phase}>
      {expanded && (
        <div style={styles.panel} role="status">
          <strong style={styles.heading}>Zvec index</strong>
          <span style={styles.path}>{workspace.root}</span>
          <span>Status: {label}</span>
          <span>Pending changes: {status?.pendingChanges ?? 0}</span>
          {status?.errorCode && <span style={styles.error}>Index update failed</span>}
        </div>
      )}
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Zvec index ${label}`}
        title={`Zvec index: ${label}`}
        style={styles.button}
        onClick={() => setExpanded(value => !value)}
      >
        <span aria-hidden="true" style={{ ...styles.dot, background: colors[phase] }} />
        <span>Zvec</span>
        <span style={styles.phase}>{label}</span>
      </button>
    </div>
  )
}

const styles = {
  anchor: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    display: 'flex',
    alignItems: 'flex-end',
    flexDirection: 'column',
    gap: 8,
    font: '500 12px/1.4 system-ui, sans-serif',
    color: 'var(--dsw-alias-label-primary)',
    pointerEvents: 'auto',
  },
  button: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    minHeight: 32,
    padding: '6px 11px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 999,
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-button-floating-fill)',
    boxShadow: '0 6px 20px color-mix(in srgb, black 14%, transparent)',
    cursor: 'pointer',
  },
  dot: { width: 8, height: 8, borderRadius: '50%' },
  phase: { color: 'var(--dsw-alias-label-secondary)' },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    width: 280,
    padding: 12,
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-2)',
    boxShadow: '0 12px 32px color-mix(in srgb, black 18%, transparent)',
  },
  heading: { fontSize: 13 },
  path: {
    overflow: 'hidden',
    color: 'var(--dsw-alias-label-secondary)',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  error: { color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' },
} as const
