import type { PortabilityIssue } from "../types";

// Routines will sync across devices, so a script must never point at a location on this Mac.
// Every file, folder or template location has to be a param chosen at run time.
const PATTERNS: { re: RegExp; message: string }[] = [
  { re: /\/Users\//, message: "Points to a folder inside a user's home on this Mac" },
  { re: /\/Volumes\//, message: "Points to a specific drive" },
  { re: /(^|["'\s(=])~\//, message: "Points to a home folder (~/)" },
  { re: /\b[A-Za-z]:\\\\?[A-Za-z0-9_]/, message: "Points to a Windows drive" },
  { re: /file:\/\//, message: "Uses a file:// address" },
];

export function findPortabilityIssues(script: string): PortabilityIssue[] {
  const issues: PortabilityIssue[] = [];
  script.split("\n").forEach((text, i) => {
    if (/^\s*\/\//.test(text)) return; // comments can't break a run
    for (const p of PATTERNS) {
      if (p.re.test(text)) {
        issues.push({ line: i + 1, text: text.trim(), message: p.message });
        break;
      }
    }
  });
  return issues;
}
