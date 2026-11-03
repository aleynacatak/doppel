import { copy } from "@/copy";

/** "Created with N AI calls · Reruns use 0" */
export function CostLine({ aiCalls }: { aiCalls: number }) {
  return <p className="text-sm font-medium">{copy.routine.cost(aiCalls)}</p>;
}
