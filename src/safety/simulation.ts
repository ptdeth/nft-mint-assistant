export interface SimulationSummary {
  canExecute: boolean;
  warnings: string[];
}

export async function simulateTransaction(): Promise<SimulationSummary> {
  return {
    canExecute: false,
    warnings: ["Transaction simulation is not implemented in Step 1."]
  };
}
