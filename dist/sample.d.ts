/**
 * Representative sampling for long tool results.
 *
 * A naive head-of-output sample hides a failure that sits in the middle. This
 * sampler keeps a bounded head, the highest-signal lines from the omitted
 * middle, and the tail, so a 100k-character log is judged on its evidence
 * rather than on its first page. Formats are recognised by line shape, so an
 * unknown output still gets head, signal lines and tail.
 */
export interface SampleOptions {
    /** Hard character budget for the returned text. */
    budgetChars: number;
    /** Preferred head size; clamped to fit the budget. */
    headChars?: number;
    /** Preferred tail size; clamped to fit the budget. */
    tailChars?: number;
    /** Maximum signal lines kept from the middle. */
    maxSignalLines?: number;
    /** Maximum characters kept per signal line. */
    maxSignalLineChars?: number;
}
export interface SampleResult {
    text: string;
    signalLines: number;
    /** Characters of the original text that the sample does not contain. */
    omitted: number;
}
export declare function sampleResult(text: string, options: SampleOptions): SampleResult;
