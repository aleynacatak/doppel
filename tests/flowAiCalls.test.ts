import { describe, expect, it } from "vitest";
import { flowAiCalls } from "../electron/shared/flowGraph";

const routines = [
  { id: "a", createdWithAiCalls: 3 },
  { id: "b", createdWithAiCalls: 21 },
  { id: "c", createdWithAiCalls: 17 },
  { id: "unused", createdWithAiCalls: 100 },
];
const node = (routineId: string) => ({ kind: "routine", routineId });

describe("flowAiCalls", () => {
  it("adds up the routines of a flow wired by hand", () => {
    expect(flowAiCalls({ createdWithAiCalls: 0, nodes: [node("a"), node("b"), node("c"), { kind: "input" }] }, routines)).toBe(41);
  });

  it("counts a routine used twice once", () => {
    expect(flowAiCalls({ createdWithAiCalls: 0, nodes: [node("a"), node("a")] }, routines)).toBe(3);
  });

  it("keeps the flow's own count when making it took more, such as planning from one request", () => {
    expect(flowAiCalls({ createdWithAiCalls: 30, nodes: [node("a"), node("b")] }, routines)).toBe(30);
  });

  it("ignores routines that no longer exist", () => {
    expect(flowAiCalls({ createdWithAiCalls: 0, nodes: [node("gone")] }, routines)).toBe(0);
  });
});
