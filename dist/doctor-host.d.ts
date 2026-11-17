import type { Check } from './doctor.js';
export declare function summarizeHookTrust(result: unknown): Check;
/** Exchange only initialize and hooks/list. No thread, model turn or approval is created. */
export declare function checkHookTrust(env: NodeJS.ProcessEnv): Promise<Check>;
export declare function checkThreadExecution(env: NodeJS.ProcessEnv): Check | undefined;
