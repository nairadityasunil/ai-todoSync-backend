import costService from "../../agents/cost.service.js";
import type { ILlmModel } from "../models/llm-model.model.js";

export interface CostCalculationResult {
  inputCost: number;
  outputCost: number;
  cachedCost: number;
  totalCost: number;
}

export class CostControlService {
  /**
   * Calculate cost in USD based on input, output, and cached token counts
   * using per-million-token pricing from catalog.
   */
  public calculateCost(
    model: ILlmModel,
    inputTokens: number,
    outputTokens: number,
    cachedTokens = 0,
  ): CostCalculationResult {
    const inputPricePerToken = (model.inputPricePerMToken || 0) / 1_000_000;
    const outputPricePerToken = (model.outputPricePerMToken || 0) / 1_000_000;
    const cachedPricePerToken =
      (model.cachedInputPricePerMToken || 0) / 1_000_000;

    const uncachedInput = Math.max(0, inputTokens - cachedTokens);
    const inputCost = uncachedInput * inputPricePerToken;
    const cachedCost = cachedTokens * cachedPricePerToken;
    const outputCost = outputTokens * outputPricePerToken;
    const totalCost = Number((inputCost + cachedCost + outputCost).toFixed(8));

    return {
      inputCost: Number(inputCost.toFixed(8)),
      outputCost: Number(outputCost.toFixed(8)),
      cachedCost: Number(cachedCost.toFixed(8)),
      totalCost,
    };
  }

  /**
   * Refuses the call when the workspace's monthly AI budget (set in Agent
   * Governance → Costs) is used up and its hard stop is on.
   */
  public async assertWorkspaceBudget(workspaceId: string): Promise<void> {
    await costService.assertWithinBudget(workspaceId);
  }
}

export default new CostControlService();
