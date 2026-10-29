import type { AppId } from "../types";
import type { CheckDef } from "../../evals/tasks";

// Building blocks (helpers in code): small, tested functions routines are built from. Photoshop and InDesign blocks
// are ExtendScript functions in the library Doppl prepends to every script; Figma blocks are composite actions,
// named macros of catalog actions. Every block has versions; a routine version pins the versions it uses, so its
// reruns stay deterministic. Built-in blocks ship with Doppl; promoted ones grow from the designer's own routines.

export interface HelperParam {
  name: string;
  type: string;
  optional?: boolean;
  doc?: string;
}

export interface HelperTest {
  name: string;
  /**
   * Inputs by name: "gen:<fixture>" for a synthetic fixture Doppl draws (core/blocks/fixtures), or a file path
   * (a promoted block's recorded trial inputs). Scripts get them as params.<name>.
   */
  inputs: Record<string, string>;
  /** ExtendScript body (Photoshop, InDesign) or a JSON action list (Figma) that uses the block. */
  script: string;
  /** Checks on the files the test writes (port "files") and the run. */
  checks: CheckDef[];
  /** Fields the script's returned data must have (compared as JSON). */
  expect?: Record<string, unknown>;
}

export interface HelperDef {
  /** "ps.maskWhiteBackground", "id.resolvePages", "figma.fillTemplate". */
  id: string;
  version: number;
  app: AppId;
  /** A group per app: masking, layers, export… */
  set: string;
  /** How a routine calls it: "maskWhiteBackground", "ctx.resolvePages"; Figma: the block's name. */
  call: string;
  /** One line for the index the model gets. */
  summary: string;
  signature: { params: HelperParam[]; returns: string };
  sideEffects: string[];
  /** For the model: what it does, its options, one usage example. */
  doc: string;
  source: "builtin" | "promoted";
  tests: HelperTest[];
  /** ExtendScript (a function definition); Figma: a CompositeAction as JSON. */
  code: string;
  /** Promoted blocks: where they came from (stripped when exported as built-in). */
  origin?: { candidateId: string; routines: string[]; promotedAt: string };
}

/** Versions a routine uses: block id → version. */
export type HelperPins = Record<string, number>;

/** A Figma composite action: a macro of catalog actions with {{args.<param>}} placeholders. */
export interface CompositeAction {
  params: HelperParam[];
  /** Actions, possibly with { "$each": "{{args.<object or list>}}", "do": action } (key/value or item/index). */
  actions: Record<string, unknown>[];
  /** The id (inside the block) whose result is the block's result ("$<block id>" in later actions). */
  result?: string;
}

/** What a stage needs of its blocks at run time. */
export interface StageBlocks {
  /** ExtendScript apps: the helper code to put in the library, in order. */
  code?: { id: string; version: number; code: string }[];
  /** Figma: composite actions by name. */
  composites?: Record<string, CompositeAction>;
}

export interface HelperTestResult {
  helper: string;
  version: number;
  test: string;
  passed: boolean;
  /** Why it didn't run (the app isn't open, an input is gone). */
  skipped?: string;
  detail: string;
}

/** Custom code from saved routines that could become a building block, with the evidence for it. */
export interface BlockCandidate {
  id: string;
  app: AppId;
  /** The code (one step's custom code, as first captured). */
  code: string;
  /** Every routine it was written in (repeats merge here: "written twice" is strong evidence). */
  occurrences: {
    routineId: string;
    routineName: string;
    version: number;
    step: string;
    request: string;
    savedAt: string;
    /** The trial when it was made: items tried and passed, and its input files (for generated tests). */
    trial: { items: number; ok: number; inputs: string[] };
  }[];
  evidence: {
    /** Items its routines ran successfully, and how many distinct inputs that covered. */
    successfulItems: number;
    inputKeys: string[];
    qcPassed: number;
    qcChecked: number;
    markedOk: number;
    notRight: number;
    /** Refines that changed this code. */
    refineTouches: number;
  };
  score: number;
  status: "candidate" | "generalized" | "promoted" | "dismissed";
  /** After "Generalize": the block the AI made of it, its lint problems and test results. */
  draft?: { def: HelperDef; lint: string[]; tests: HelperTestResult[] };
  promoted?: { id: string; version: number };
  createdAt: string;
  updatedAt: string;
}
