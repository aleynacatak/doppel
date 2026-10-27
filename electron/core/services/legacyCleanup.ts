import type { Storage } from "./storage";

/** The version the simulated Figma of earlier builds reported; real Figma has none. */
const SIMULATED_FIGMA_VERSION = "126.2";

/**
 * Earlier builds filled the library with example routines that had made-up run history, and the
 * style profile with example projects. Remove them once, along with routines made against the
 * simulated Figma file (they never ran on a real one); other routines people saved stay.
 */
export async function removeLegacyDemoData(storage: Storage) {
  if (await storage.hasMarker("demo-data-removed")) return;
  for (const routine of await storage.listRoutines()) {
    const seeded = routine.versions?.[0]?.note === "Seed routine";
    const simulatedFigma = routine.appId === "figma" && routine.appVersion === SIMULATED_FIGMA_VERSION;
    if (!seeded && !simulatedFigma) continue;
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
