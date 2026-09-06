import { describe, expect, it, vi } from 'vitest'
import { mountPlugin } from '../src/index.ts'

describe('Harness integration', () => {
  it('activates existing and newly created session workspaces automatically', () => {
    const activate = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    let created!: (session: { header: { cwd?: string } }) => void
    const ctx = {
      sessions: { list: () => [{ header: { cwd: '/existing' } }, { header: {} }] },
      tools: { register: vi.fn() },
      systemPrompt: { section: vi.fn() },
      logger: { warn: vi.fn() },
      on: vi.fn((_name, listener) => { created = listener }),
      effect: vi.fn((setup) => setup()),
    }
    const runtime = { activate, close, search: vi.fn() }

    mountPlugin(ctx as never, runtime as never, { defaultLimit: 10, maxLimit: 30 })
    created({ header: { cwd: '/new' } })
    created({ header: {} })

    expect(activate).toHaveBeenCalledTimes(2)
    expect(activate).toHaveBeenNthCalledWith(1, '/existing')
    expect(activate).toHaveBeenNthCalledWith(2, '/new')
    expect(ctx.tools.register).toHaveBeenCalledOnce()
  })
})
