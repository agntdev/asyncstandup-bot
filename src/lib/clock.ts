/**
 * Injectable clock seam — all time-based decisions pass through `now()` so
 * tests can drive schedules, cutoffs, and DST transitions deterministically.
 * Call `new Date()` / `Date.now()` ONLY through this module.
 */

export interface Clock {
  /** Current instant in epoch milliseconds. */
  epochMs(): number;
  /** Current instant as a Date. */
  date(): Date;
}

const realClock: Clock = {
  epochMs: () => Date.now(),
  date: () => new Date(),
};

let overridden: Clock | null = null;

/** The clock the bot uses. Override in tests via `setClock`. */
export function now(): Date {
  return (overridden ?? realClock).date();
}

/** Epoch-ms clock. Override in tests via `setClock`. */
export function nowMs(): number {
  return (overridden ?? realClock).epochMs();
}

/** Override the clock for a test (pass `null` to restore the real clock). */
export function setClock(c: Clock | null): void {
  overridden = c;
}