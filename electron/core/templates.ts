import { FIGMA_TEMPLATES } from "../adapters/figma/templates";
import { INDESIGN_TEMPLATES } from "../adapters/indesign/templates";
import type { RoutineTemplate } from "../adapters/types";

/** Real, working routines shown to the model as examples of how each app's routines are written. */
export const EXAMPLE_ROUTINES: RoutineTemplate[] = [...INDESIGN_TEMPLATES, ...FIGMA_TEMPLATES];
