import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { IndexStatusPill } from './IndexStatusPill.tsx'
import { IndexStatusSource } from './status-source.ts'

export const inject = ['slots']

export function apply(ctx: Context): void {
  const status = new IndexStatusSource()
  ctx.effect(() => {
    status.start()
    return () => status.stop()
  }, 'dsh-zvec-grep: status polling')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'zvec-index-status',
    order: 50,
    inject: () => ({ hooks: { indexStatus: status }, statusSource: status }),
  }, IndexStatusPill))
}
