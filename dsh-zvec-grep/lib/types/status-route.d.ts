import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import type { WorkspaceSearchRuntime } from './runtime.ts';
export declare const STATUS_PATH = "/api/dsh-zvec-grep/status";
/**
 * Report every workspace the host currently knows, keyed by the session cwd the runtime was
 * activated with. A plain HTTP route carries no calling session, so instead of asking the caller
 * who it is, the route publishes every workspace and the client selects its own cwd from the list.
 *
 * `requestBody: 'buffered'` is load-bearing, not cosmetic: the host bridges an incoming request
 * into a WHATWG Request, and only the 'buffered' mode leaves a body-less GET alone. Any other
 * value - including the omitted field - takes the streaming branch, which always attaches
 * `body: Readable.toWeb(req)` and makes `new Request()` throw
 * `Request with GET/HEAD method cannot have body`, surfaced to the client as a bare 400 on every
 * poll. The host's own GET routes set the same mode for the same reason.
 */
export declare function registerStatusRoute(connection: HostConnectionFetch, runtime: Pick<WorkspaceSearchRuntime, 'statusFor'>, sessions: {
    list(): Array<{
        id: string;
        header: {
            cwd?: string;
        };
    }>;
}, pollIntervalMs: number): () => void;
//# sourceMappingURL=status-route.d.ts.map