import { describe, expect, it, vi } from 'vitest'
import { registerStatusRoute } from '../src/status-route.ts'

describe('status route', () => {
  it('reports every known workspace on a parameterless GET', async () => {
    let route!: { path: string; methods?: string[]; fetch: (request: Request) => Promise<Response> }
    const register = vi.fn((next: typeof route) => { route = next; return vi.fn() })
    const runtime = {
      statusFor: vi.fn((root: string) => root === '/repo'
        ? { root, status: 'ready', pendingChanges: 0, updatedAt: 42 }
        : undefined),
    }
    const sessions = { list: () => [
      { id: 'session-1', header: { cwd: '/repo' } },
      { id: 'session-2', header: { cwd: '/other' } },
      { id: 'session-3', header: {} },
    ] }
    const dispose = registerStatusRoute({ register } as never, runtime as never, sessions, 2000)
    const response = await route.fetch(new Request('http://localhost/api/dsh-zvec-grep/status'))

    expect(route.path).toBe('/api/dsh-zvec-grep/status')
    expect(route.methods).toEqual(['GET'])
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      version: 2,
      pollIntervalMs: 2000,
      workspaces: [
        { root: '/repo', status: 'ready', pendingChanges: 0, updatedAt: 42 },
        { root: '/other', status: 'indexing', pendingChanges: 0, updatedAt: 0 },
      ],
    })
    expect(dispose).toBeTypeOf('function')
  })

  it('lists a workspace shared by several sessions once', async () => {
    let route!: { fetch: (request: Request) => Promise<Response> }
    const register = vi.fn((next: typeof route) => { route = next; return vi.fn() })
    registerStatusRoute(
      { register } as never,
      { statusFor: vi.fn(() => undefined) } as never,
      { list: () => [{ id: 'a', header: { cwd: '/repo' } }, { id: 'b', header: { cwd: '/repo' } }] },
      2000,
    )

    expect((await (await route.fetch(new Request('http://localhost/api/dsh-zvec-grep/status'))).json()).workspaces)
      .toEqual([{ root: '/repo', status: 'indexing', pendingChanges: 0, updatedAt: 0 }])
  })

  it('requires at least one session with a workspace', async () => {
    let route!: { fetch: (request: Request) => Promise<Response> }
    const register = vi.fn((next: typeof route) => { route = next; return vi.fn() })
    registerStatusRoute({ register } as never, { statusFor: vi.fn(() => undefined) } as never, { list: () => [] }, 2000)

    expect((await route.fetch(new Request('http://localhost/api/dsh-zvec-grep/status'))).status).toBe(404)
  })

  it('reports an index failure without exposing internal errors', async () => {
    let route!: { fetch: (request: Request) => Promise<Response> }
    const register = vi.fn((next: typeof route) => { route = next; return vi.fn() })
    const runtime = {
      statusFor: vi.fn(() => ({ root: '/repo', status: 'error', pendingChanges: 0, updatedAt: 42, message: '/secret failed' })),
    }
    registerStatusRoute({ register } as never, runtime as never, { list: () => [{ id: 'session-1', header: { cwd: '/repo' } }] }, 2000)

    const payload = await (await route.fetch(new Request('http://localhost/api/dsh-zvec-grep/status'))).json()

    expect(payload).toEqual({
      version: 2,
      pollIntervalMs: 2000,
      workspaces: [{ root: '/repo', status: 'error', pendingChanges: 0, updatedAt: 42, errorCode: 'index_failed' }],
    })
    expect(JSON.stringify(payload)).not.toContain('/secret failed')
  })
})
