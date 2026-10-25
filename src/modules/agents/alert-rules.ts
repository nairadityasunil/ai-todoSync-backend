/**
 * Pure alert rules, kept apart from the database so they can be unit tested.
 */

/** Earlier actions an agent needs before its working hours are judged. */
export const MIN_HISTORY_FOR_HOURS = 50;

/**
 * Hours of day (UTC, 0-23) in `recent` that are not next to any hour the
 * agent worked before. Judged against the agent's own pattern, so it works in
 * any time zone; the neighbouring hours count as usual, so a daylight-saving
 * shift does not raise an alert. Returns [] when the history is too short.
 */
export function unusualHours(
  usualHours: Iterable<number>,
  historyCount: number,
  recent: Date[],
  minHistory = MIN_HISTORY_FOR_HOURS,
): number[] {
  if (historyCount < minHistory) return [];
  const usual = new Set(usualHours);
  const near = (hour: number) =>
    usual.has(hour) ||
    usual.has((hour + 23) % 24) ||
    usual.has((hour + 1) % 24);
  return [...new Set(recent.map((date) => date.getUTCHours()))]
    .filter((hour) => !near(hour))
    .sort((a, b) => a - b);
}
