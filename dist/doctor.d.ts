export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface Check {
    name: string;
    status: CheckStatus;
    detail: string;
}
/** Probe the shipped Codex launcher from its declared plugin-relative directory. */
export declare function checkMcp(root: string, env: NodeJS.ProcessEnv): Check;
export declare function runDoctor(env: NodeJS.ProcessEnv): Check[];
export declare function renderDoctor(checks: Check[]): string;
export declare function doctorExitCode(checks: Check[]): number;
