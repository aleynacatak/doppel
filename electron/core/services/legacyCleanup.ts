import type { Storage } from "./storage";

/**
 * Earlier builds filled the library with example routines that had made-up run history, and the
 * style profile with example projects. Remove them once; routines people saved themselves stay.
 */
export async function removeLegacyDemoData(storage: Storage) {
  if (await storage.hasMarker("demo-data-removed")) return;
  for (const routine of await storage.listRoutines()) {
    if (routine.versions?.[0]?.note !== "Seed routine") continue;
    for (const run of routine.runs) await storage.deleteRun(run.id);
    await storage.deleteRoutine(routine.id);
  }
  const style = await storage.getStyleProfile();
  if (style?.sources.some((s) => s.id.startsWith("seed-style-"))) {
    const sources = style.sources.filter((s) => !s.id.startsWith("seed-style-"));
    await storage.saveStyleProfile({ sources, rules: sources.length ? style.rules : [] });
  }
  await storage.setMarker("demo-data-removed");
}
