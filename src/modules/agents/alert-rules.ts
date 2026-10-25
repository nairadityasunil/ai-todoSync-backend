/**
 * Pure alert rules, kept apart from the database so they can be unit tested.
 */

/** Earlier actions an agent needs before its working hours are judged. */
export const MIN_HISTORY_FOR_HOURS = 50;

/**
 * Hours of day (UTC, 0-23) in `recent` that the agent never used in `history`.
 * Judged against the agent's own pattern, so it works in any time zone.
 * Returns [] when the history is too short to say what is usual.
 */
export function unusualHours(
  history: Date[],
  recent: Date[],
  minHistory = MIN_HISTORY_FOR_HOURS,
): number[] {
  if (history.length < minHistory) return [];
  const usual = new Set(history.map((date) => date.getUTCHours()));
  return [...new Set(recent.map((date) => date.getUTCHours()))]
    .filter((hour) => !usual.has(hour))
    .sort((a, b) => a - b);
}
