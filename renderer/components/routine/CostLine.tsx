import { copy } from "@/copy";

/** "Created with N AI calls · Reruns use 0" */
export function CostLine({ aiCalls }: { aiCalls: number }) {
  return <p className="ui-h3">{copy.routine.cost(aiCalls)}</p>;
}
