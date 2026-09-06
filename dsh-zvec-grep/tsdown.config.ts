import { defineConfig, type UserConfig } from 'tsdown'

const clientModuleId = '@sugarforever/dsh-zvec-grep'
const clientExternals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
] as const

export const clientBundleConfig: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: true,
  external: [...clientExternals],
  noExternal: (id: string) => clientExternals.includes(id as typeof clientExternals[number]) ? undefined : true,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(clientModuleId)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    dts: false,
    clean: true,
    external: [/^@deepseek-ai\//, /^@zvec\//, /^chokidar$/],
  },
  clientBundleConfig,
])
