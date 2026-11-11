/** Controls that were met last time and are not now (pure, for drift alerts). */
export function driftedControls(
  previous: Array<{ id: string; status: string }>,
  current: Array<{ id: string; title: string; status: string }>,
): Array<{ id: string; title: string; status: string }> {
  const before = new Map(previous.map((c) => [c.id, c.status]));
  return current.filter((c) => before.get(c.id) === "met" && c.status !== "met");
}
