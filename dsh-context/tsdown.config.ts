import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  clean: true,
  dts: false,
  external: [/^@deepseek-ai\//],
})
