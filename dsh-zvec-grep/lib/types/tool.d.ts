import type { WorkspaceSearchRuntime } from './runtime.ts';
export interface SearchToolConfig {
    defaultLimit: number;
    maxLimit: number;
}
export declare function createSearchTool(runtime: WorkspaceSearchRuntime, config: SearchToolConfig): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=tool.d.ts.map