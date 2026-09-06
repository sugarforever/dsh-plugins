import { describe, expect, it, vi } from 'vitest'
import { registerStatusRoute } from '../src/status-route.ts'

describe('status route', () => {
  it('registers a read-only no-store JSON endpoint', async () => {
    let route!: { path: string; fetch: (request: Request) => Promise<Response> }
    const register = vi.fn((next: typeof route) => { route = next; return vi.fn() })
    const runtime = { statusFor: vi.fn(() => ({ root: '/repo', status: 'ready', pendingChanges: 0, updatedAt: 42 })) }
    const sessions = { list: () => [{ id: 'session-1', header: { cwd: '/repo' } }] }
    const dispose = registerStatusRoute({ register } as never, runtime as never, sessions, 2000)
    const response = await route.fetch(new Request('http://localhost/api/dsh-zvec-grep/status?sessionId=session-1'))

    expect(route.path).toBe('/api/dsh-zvec-grep/status')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      version: 1,
      pollIntervalMs: 2000,
      status: { status: 'ready', pendingChanges: 0, updatedAt: 42 },
    })
    expect(dispose).toBeTypeOf('function')
  })

  it('requires one known session without exposing internal errors', async () => {
    let route!: { fetch: (request: Request) => Promise<Response> }
    const register = vi.fn((next: typeof route) => { route = next; return vi.fn() })
    const runtime = { statusFor: vi.fn(() => ({ root: '/repo', status: 'error', pendingChanges: 0, updatedAt: 42, message: '/secret failed' })) }
    registerStatusRoute({ register } as never, runtime as never, { list: () => [{ id: 'session-1', header: { cwd: '/repo' } }] }, 2000)

    const missing = await route.fetch(new Request('http://localhost/api/dsh-zvec-grep/status'))
    const unknown = await route.fetch(new Request('http://localhost/api/dsh-zvec-grep/status?sessionId=nope'))
    const known = await route.fetch(new Request('http://localhost/api/dsh-zvec-grep/status?sessionId=session-1'))

    expect(missing.status).toBe(400)
    expect(unknown.status).toBe(404)
    expect(await known.json()).toEqual({
      version: 1,
      pollIntervalMs: 2000,
      status: { status: 'error', pendingChanges: 0, updatedAt: 42, errorCode: 'index_failed' },
    })
  })
})
