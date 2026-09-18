export interface SessionRecord {
    session_id: string;
    cwd: string;
    model: string;
    started_at: string;
    goal: string[];
}
/** The goal the diet state carries: the last few prompts, joined. */
export declare function readGoal(env: NodeJS.ProcessEnv, sessionId: string): {
    goal: string;
    goalIndex: number;
};
/** SessionStart records the session. UserPromptSubmit keeps the goals and runs the guard. Never throws. */
export declare function main(stdin: string, env: NodeJS.ProcessEnv): Promise<string>;
