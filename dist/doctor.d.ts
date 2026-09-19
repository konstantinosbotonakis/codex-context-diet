export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface Check {
    name: string;
    status: CheckStatus;
    detail: string;
}
export declare function runDoctor(env: NodeJS.ProcessEnv): Check[];
export declare function renderDoctor(checks: Check[]): string;
export declare function doctorExitCode(checks: Check[]): number;
