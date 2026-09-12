import type { PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots';
import type { IndexStatusSnapshot, IndexStatusSource } from './status-source.ts';
export type IndexStatusPillProps = PropsRuntime<'shell.overlay'> & {
    useIndexStatus: SnapshotSelectorHook<IndexStatusSnapshot>;
    statusSource: Pick<IndexStatusSource, 'selectWorkspace'>;
};
export declare function IndexStatusPill(props: IndexStatusPillProps): import("react").JSX.Element | null;
//# sourceMappingURL=IndexStatusPill.d.ts.map