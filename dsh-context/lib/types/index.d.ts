import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type Config as ContextConfig } from './config.ts';
export declare const name = "context-engineer";
export declare const inject: string[];
/** Plugin schema; consumers validate against it without importing `Config` the type. */
export declare const Config: z<ContextConfig>;
export type PluginConfig = ContextConfig;
export declare function apply(ctx: Context, rawConfig: PluginConfig): Promise<void>;
//# sourceMappingURL=index.d.ts.map