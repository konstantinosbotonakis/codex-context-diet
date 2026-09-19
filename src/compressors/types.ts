export interface CapsuleInput {
  toolName: string;
  inputLine: string;
  resultText: string;
  isError: boolean;
}

export interface CapsuleBudgets {
  maxChars: number;
  maxErrorLines: number;
  maxStackFrames: number;
  maxSummaryLines: number;
  headChars: number;
}

export interface ExtractedCapsule {
  /** Which extractor produced the body, recorded in debug events. */
  kind: string;
  /** Compact facts such as an exit status or a test summary. */
  facts?: string[];
  /** Evidence lines, each already bounded. */
  lines: string[];
  /** Source characters these lines actually represent. */
  retainedChars: number;
}

export type Extractor = (input: CapsuleInput, budgets: CapsuleBudgets) => ExtractedCapsule | null;

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 3)) + '...';
}

export function textLines(text: string): string[] {
  return text.split('\n');
}

export function retained(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

