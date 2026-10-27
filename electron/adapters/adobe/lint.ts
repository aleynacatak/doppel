import vm from "node:vm";

// Checks a routine body before it runs in an Adobe app. Model-written scripts run on testers' Macs with
// their files open, so anything that deletes files, runs other programs or reaches the network is refused.

const NOT_ES3: [RegExp, string][] = [
  [/=>/, "arrow functions (=>) don't exist in ExtendScript"],
  [/(^|[^\w.$])(let|const)\s+[A-Za-z_$]/m, "let/const don't exist in ExtendScript; use var"],
  [/`/, "template literals (backticks) don't exist in ExtendScript"],
  [/(^|[^\w.$])class\s+[A-Za-z_$]/m, "classes don't exist in ExtendScript"],
  [/\.(forEach|map|filter|reduce|some|every|find|findIndex|includes)\s*\(/, "array methods like forEach/map/filter don't exist in ExtendScript; use for loops"],
  [/\.trim\s*\(\s*\)/, "String.prototype.trim doesn't exist in ExtendScript; use replace(/^\\s+|\\s+$/g, \"\")"],
  [/Object\.(keys|values|entries|assign)\s*\(/, "Object.keys/values/assign don't exist in ExtendScript"],
  [/Array\.isArray\s*\(/, "Array.isArray doesn't exist in ExtendScript"],
];

const RESERVED =
  "abstract|boolean|byte|char|class|const|debugger|double|enum|export|extends|final|float|goto|implements|import|int|interface|long|native|package|private|protected|public|short|static|super|synchronized|throws|transient|volatile";
const RESERVED_DECL = new RegExp(`\\b(var|function)\\s+(${RESERVED})\\b|[,(]\\s*(${RESERVED})\\s*[,)]`);

const forbidden = (appName: string): [RegExp, string][] => [
  [/\.remove\s*\(/, "deleting files or folders (.remove()) isn't allowed"],
  [/\.execute\s*\(/, "opening or running other files (.execute()) isn't allowed"],
  [/\bdoScript\b/, "running other scripts (app.doScript) isn't allowed"],
  [/\bcallSystem\b/, "system calls aren't allowed"],
  [/\bSocket\b/, "network access (Socket) isn't allowed"],
  [/\bevalFile\b|(^|[^\w.$])eval\s*\(/m, "eval and $.evalFile aren't allowed"],
  [/#include|#target|#targetengine/, "#include/#target directives aren't allowed"],
  [/app\.quit\s*\(/, `quitting ${appName} isn't allowed`],
  [/\b(alert|confirm|prompt)\s*\(/, `dialogs (alert/confirm/prompt) would block ${appName}; use ctx.log instead`],
  [/\$\.setenv\b|\$\.getenv\b/, "environment access isn't allowed"],
];

/**
 * Syntax (as a function with the given parameter list), ES3-only features, reserved words, unsafe calls,
 * plus app-specific rules.
 */
export function lintExtendScript(
  script: string,
  options: { appName: string; signature: string; extra?: [RegExp, string][] },
): string[] {
  const issues: string[] = [];
  try {
    new vm.Script(`(function (${options.signature}) {\n${script}\n})`, { filename: "routine.jsx" });
  } catch (err) {
    issues.push(`Syntax error: ${(err as Error).message}`);
  }
  for (const [re, message] of [...NOT_ES3, ...forbidden(options.appName), ...(options.extra ?? [])]) if (re.test(script)) issues.push(message);
  const reserved = script.match(RESERVED_DECL);
  if (reserved) issues.push(`"${reserved[2] ?? reserved[3]}" is a reserved word in ExtendScript; rename it`);
  return issues;
}
