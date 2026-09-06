// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IndexStatusPill, type IndexStatusPillProps } from '../src/client/IndexStatusPill.tsx'

const sessions = {
  ids: ['session'],
  byId: { session: { id: 'session', displayTitle: 'Session', cwd: '/repo', running: false, blank: false, updatedAt: 1 } },
  current: 'session',
  phase: 'ready',
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
}

describe('IndexStatusPill', () => {
  it('shows the current workspace status and expands its details', () => {
    const props = {
      useSessions: (selector: (value: typeof sessions) => unknown) => selector(sessions),
      useIndexStatus: (selector: (value: unknown) => unknown) => selector({
        connection: 'ready',
        status: { status: 'refreshing', pendingChanges: 2, updatedAt: 42 },
      }),
      statusSource: { selectSession: () => undefined },
    } as unknown as IndexStatusPillProps
    render(<IndexStatusPill {...props} />)

    expect(screen.getByRole('button', { name: /Zvec.*Refreshing/i })).toBeTruthy()
    expect(screen.getByRole('button').parentElement?.style.pointerEvents).toBe('auto')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('/repo')).toBeTruthy()
    expect(screen.getByText(/Pending changes: 2/i)).toBeTruthy()
  })

  it('renders nothing without a current workspace', () => {
    const noCurrent = { ...sessions, current: undefined }
    const props = {
      useSessions: (selector: (value: typeof noCurrent) => unknown) => selector(noCurrent),
      useIndexStatus: (selector: (value: unknown) => unknown) => selector({ connection: 'ready' }),
      statusSource: { selectSession: () => undefined },
    } as unknown as IndexStatusPillProps
    const { container } = render(<IndexStatusPill {...props} />)
    expect(container.innerHTML).toBe('')
  })
})
