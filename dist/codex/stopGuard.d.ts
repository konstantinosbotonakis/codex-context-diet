/**
 * Report once per session when several dropped results were re-run recently.
 *
 * The MCP `stop_guard` tool and the command fallback both call this, so the
 * two transports cannot drift. Returns the stdout body, or an empty string
 * when there is nothing to say.
 */
export declare function handleStopGuard(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): string;
