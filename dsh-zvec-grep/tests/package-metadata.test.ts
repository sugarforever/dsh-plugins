import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('package metadata', () => {
  it('provides the Hono runtime peer required by the MCP Node transport', async () => {
    const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      dependencies: Record<string, string>
    }

    expect(packageJson.dependencies.hono).toBe('^4.11.4')
  })

  it('marks host-provided DeepSeek peers as optional', async () => {
    const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      peerDependencies: Record<string, string>
      peerDependenciesMeta: Record<string, { optional?: boolean }>
    }

    const hostPeers = Object.keys(packageJson.peerDependencies)
      .filter(name => name.startsWith('@deepseek-ai/'))

    expect(hostPeers.length).toBeGreaterThan(0)
    expect(Object.fromEntries(hostPeers.map(name => [name, packageJson.peerDependenciesMeta[name]])))
      .toEqual(Object.fromEntries(hostPeers.map(name => [name, { optional: true }])))
  })
})
