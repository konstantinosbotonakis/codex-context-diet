export type KeyProblem = 'missing' | 'rejected';
export declare function keyWarningMessage(problem: KeyProblem): string;
/** Pulls the HTTP status out of a transport error, so a rejected key can be named. */
export declare function problemFromError(message: string): KeyProblem | null;
/**
 * At most one warning per session, and never more than once an hour, so a
 * missing key does not turn every tool call into a notification.
 */
export declare function keyWarning(env: NodeJS.ProcessEnv, sessionId: string, problem: KeyProblem, now?: Date): string | null;
