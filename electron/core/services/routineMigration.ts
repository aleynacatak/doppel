import fs from "node:fs/promises";
import path from "node:path";
import { type LegacyRoutine, isLegacyRun, legacyRoutineToContract, legacyRunToRun, stagedRoutineToFlow } from "../routines/legacy";
import type { InputValue, ParamValue, Routine, Run } from "../types";
import { newId } from "../util";
import type { Storage } from "./storage";

/**
 * Brings routine and run files written by earlier Doppl builds to the routines-and-flows format, once, when Doppl
 * starts: a routine with params gets inputs and settings; a multi-stage routine becomes a flow plus one routine
 * per stage (versions, run history and AI call counts kept). Every file that changes is copied to
 * backups/<time>-routines-and-flows/ first, as it was. Values picked in earlier runs (paths) move to the
 * last-values file on this Mac.
 */
export async function migrateRoutines(storage: Storage): Promise<{ routines: number; flows: number; runs: number; backup: string | null }> {
  const root = storage.root;
  const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  const list = async (dir: string) => (await fs.readdir(path.join(root, dir)).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));

  const legacyRoutines: { file: string; raw: LegacyRoutine }[] = [];
  for (const name of await list("routines")) {
    const file = path.join(root, "routines", name);
    const raw = await read(file).catch(() => null);
    if (raw && raw.format !== 2) legacyRoutines.push({ file, raw: raw as unknown as LegacyRoutine });
  }
  const legacyRuns: { file: string; raw: Record<string, unknown> }[] = [];
  for (const name of await list("runs")) {
    const file = path.join(root, "runs", name);
    const raw = await read(file).catch(() => null);
    if (raw && isLegacyRun(raw)) legacyRuns.push({ file, raw });
  }
  if (legacyRoutines.length === 0 && legacyRuns.length === 0) return { routines: 0, flows: 0, runs: 0, backup: null };

  const backup = path.join(root, "backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-routines-and-flows`);
  for (const { file } of [...legacyRoutines, ...legacyRuns]) {
    const to = path.join(backup, path.basename(path.dirname(file)), path.basename(file));
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(file, to);
  }

  let flows = 0;
  let routines = 0;
  const runTargets = new Map<string, { target: Run["target"]; nodeOfStage: Record<string, string> }>();
  for (const { raw } of legacyRoutines) {
    const multi = (raw.stages?.length ?? 0) > 1;
    if (multi) {
      const { flow, routines: made, nodeOfStage } = stagedRoutineToFlow(raw, newId);
      for (const r of made) await storage.saveRoutine(r);
      await storage.saveFlow(flow);
      await storage.deleteRoutine(raw.id);
      runTargets.set(raw.id, { target: { kind: "flow", id: flow.id }, nodeOfStage });
      await moveLastParams(storage, raw, `flow:${flow.id}`);
      flows++;
      routines += made.length;
    } else if (raw.stages?.length === 1) {
      // One stage: a routine of its own, not a flow.
      const { routines: [made] } = stagedRoutineToFlow(raw, newId);
      const routine: Routine = { ...made, id: raw.id, name: raw.name, createdWithAiCalls: raw.createdWithAiCalls ?? 0, versions: raw.versions ?? [], runs: raw.runs ?? [] };
      await storage.saveRoutine(routine);
      runTargets.set(raw.id, { target: { kind: "routine", id: raw.id }, nodeOfStage: { [raw.stages[0].id]: "routine" } });
      routines++;
    } else {
      await storage.saveRoutine(legacyRoutineToContract(raw));
      runTargets.set(raw.id, { target: { kind: "routine", id: raw.id }, nodeOfStage: {} });
      routines++;
    }
    if (!multi) await moveLastParams(storage, raw, `routine:${raw.id}`);
  }
  let runs = 0;
  for (const { raw } of legacyRuns) {
    const routineId = String(raw.routineId ?? "");
    const mapped = runTargets.get(routineId) ?? { target: { kind: "routine" as const, id: routineId }, nodeOfStage: {} };
    await storage.saveRun(legacyRunToRun(raw as never, mapped.target, mapped.nodeOfStage));
    runs++;
  }
  return { routines, flows, runs, backup };
}

/** Values picked in the last run move to this Mac's last-values file: locations as input values, the rest as settings. */
async function moveLastParams(storage: Storage, raw: LegacyRoutine, scope: string) {
  const last = raw.lastParams ?? {};
  if (Object.keys(last).length === 0) return;
  const values = { inputs: {} as Record<string, InputValue>, outputFolders: {}, settings: {} as Record<string, ParamValue>, matches: {} };
  for (const p of raw.params ?? []) {
    const v = last[p.key];
    if (v === undefined) continue;
    if (["file", "folder", "dataFile"].includes(p.type)) values.inputs[`input-${p.key}`] = v as InputValue;
    else values.settings[p.key] = v as ParamValue;
  }
  await storage.saveLastValues(scope, values);
}
