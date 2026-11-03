/**
 * Step-level funnel from each user's furthest step (exposures record the step a user is on). A user who
 * completed the guide reached every step; anyone else dropped off at the step they last reached.
 */
export function stepFunnel(
  steps: Array<{ id: string; title?: string }>,
  exposures: Array<{ status: string; currentStepId?: string | null }>,
): Array<{
  stepId: string;
  title: string;
  index: number;
  reached: number;
  dropped: number;
  dropOffRate: number;
}> {
  if (steps.length === 0) return [];
  const indexById = new Map(steps.map((step, index) => [step.id, index]));
  const reached = new Array<number>(steps.length).fill(0);
  const dropped = new Array<number>(steps.length).fill(0);
  for (const exposure of exposures) {
    const furthest =
      exposure.status === "completed"
        ? steps.length - 1
        : (indexById.get(exposure.currentStepId ?? "") ?? 0);
    for (let i = 0; i <= furthest; i += 1) reached[i] += 1;
    if (exposure.status !== "completed") dropped[furthest] += 1;
  }
  return steps.map((step, index) => ({
    stepId: step.id,
    title: step.title || `Step ${index + 1}`,
    index,
    reached: reached[index],
    dropped: dropped[index],
    dropOffRate: reached[index] > 0 ? dropped[index] / reached[index] : 0,
  }));
}
