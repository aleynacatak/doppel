import fs from "node:fs/promises";
import path from "node:path";
import type { CheckResult } from "./checks";
import type { AttemptResult } from "./runner";
import type { CheckDef } from "./tasks";

// Eval reports: one Markdown and one CSV file per profile (evals/reports/<date>-<profile>.md/.csv), and a comparison
// table when several profiles ran together.

export interface ProfileSummary {
  profile: string;
  attempts: number;
  passed: number;
  passRate: number;
  created: number;
  /** Averages over all attempts. */
  avgCalls: number;
  avgWallSec: number;
  /** Averages over passed attempts (what a working routine costs). */
  callsPerPass: number | null;
  tokensPerPass: number | null;
  costPerPass: number | null;
  avgContextChars: number;
  failures: Record<string, number>;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export function summarize(results: AttemptResult[]): ProfileSummary[] {
  const profiles = [...new Set(results.map((r) => r.profile))];
  return profiles.map((profile) => {
    const rs = results.filter((r) => r.profile === profile);
    const ok = rs.filter((r) => r.passed);
    const failures: Record<string, number> = {};
    for (const r of rs) if (r.category) failures[r.category] = (failures[r.category] ?? 0) + 1;
    return {
      profile,
      attempts: rs.length,
      passed: ok.length,
      passRate: rs.length ? ok.length / rs.length : 0,
      created: rs.filter((r) => r.created).length,
      avgCalls: round(avg(rs.map((r) => r.aiCalls))),
      avgWallSec: round(avg(rs.map((r) => r.wallSec))),
      callsPerPass: ok.length ? round(avg(ok.map((r) => r.aiCalls))) : null,
      tokensPerPass: ok.length ? Math.round(avg(ok.map((r) => r.inputTokens + r.outputTokens))) : null,
      costPerPass: ok.length ? round(avg(ok.map((r) => r.costUsd)), 4) : null,
      avgContextChars: Math.round(avg(rs.map((r) => r.contextChars))),
      failures,
    };
  });
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const orDash = (v: number | null, f: (n: number) => string = String) => (v === null ? "–" : f(v));
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function summaryTable(summaries: ProfileSummary[]) {
  return [
    "| Profile | Passed | Pass rate | Created | AI calls (avg) | Calls per pass | Tokens per pass | Cost per pass (USD) | Capability context (chars ≈ tokens) | Wall time (avg s) | Failures |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...summaries.map(
      (s) =>
        `| ${s.profile} | ${s.passed}/${s.attempts} | ${pct(s.passRate)} | ${s.created}/${s.attempts} | ${s.avgCalls} | ${orDash(s.callsPerPass)} | ${orDash(s.tokensPerPass)} | ${orDash(s.costPerPass, (n) => n.toFixed(4))} | ${s.avgContextChars} ≈ ${Math.round(s.avgContextChars / 4)} | ${s.avgWallSec} | ${Object.entries(s.failures).map(([k, v]) => `${k} ${v}`).join(", ") || "–"} |`,
    ),
  ].join("\n");
}

export function markdownReport(results: AttemptResult[], meta: { date: string; profiles: string[]; tasks: string[]; repeat: number; notes?: string[] }): string {
  const summaries = summarize(results);
  const lines = [
    `# Doppl eval · ${meta.profiles.join(" vs ")} · ${meta.date}`,
    "",
    `Tasks: ${meta.tasks.join(", ")} · repeat ${meta.repeat}. A task passes when the creation succeeds and a rerun of the saved routine on the fixtures passes every check.`,
    "",
    "## Summary",
    "",
    summaryTable(summaries),
    "",
    ...(summaries.length === 2 ? ["## Before / after", "", compareSummaries(summaries[0], summaries[1]), ""] : []),
    ...(meta.notes?.length ? ["## Notes", "", ...meta.notes.map((n) => `- ${n}`), ""] : []),
    "## Attempts",
    "",
    "| Task | Profile | # | Result | Category | AI calls | Previews | Proposals | Questions | In tokens | Out tokens | Cost (USD) | Wall (s) | Rerun AI calls | Details |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.task} | ${r.profile} | ${r.repeat} | ${r.passed ? "pass" : r.created ? "fail (rerun)" : "fail (creation)"} | ${r.category ?? "–"} | ${r.aiCalls} | ${r.previews} | ${r.proposals} | ${r.questions} | ${r.inputTokens} | ${r.outputTokens} | ${r.costUsd.toFixed(4)} | ${r.wallSec} | ${r.rerunAiCalls} | ${cell(
          [questionText(r), (r.error ?? r.checks.map((c) => `${c.check.type}: ${c.detail}`).join("; ")).slice(0, 400)].filter(Boolean).join(" · "),
        )} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

/** "Asked (inputs): How should… → By “Flavor”": the questions of an attempt and the answers. */
const questionText = (r: AttemptResult) => (r.questionLog?.length ? `Asked ${r.questionLog.map((q) => `(${q.kind}) ${q.text} → ${q.answer}`).join("; ")}` : "");

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function csvReport(results: AttemptResult[]): string {
  const head = ["task", "profile", "repeat", "created", "passed", "category", "aiCalls", "previews", "proposals", "questions", "inputTokens", "cachedTokens", "outputTokens", "costUsd", "wallSec", "contextChars", "rerunAiCalls", "error", "checks", "questionLog"];
  const rows = results.map((r) =>
    [r.task, r.profile, r.repeat, r.created, r.passed, r.category ?? "", r.aiCalls, r.previews, r.proposals, r.questions, r.inputTokens, r.cachedTokens, r.outputTokens, r.costUsd, r.wallSec, r.contextChars, r.rerunAiCalls, r.error ?? "", r.checks.map((c) => `${c.passed ? "ok" : "FAIL"} ${c.check.type}: ${c.detail}`).join("; "), (r.questionLog ?? []).map((q) => JSON.stringify(q)).join("\n")].map(csvCell).join(","),
  );
  return [head.join(","), ...rows].join("\n") + "\n";
}

/** A free name: <base>.md, <base>-2.md… */
async function freeBase(dir: string, base: string) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    try {
      await fs.access(path.join(dir, `${name}.md`));
    } catch {
      return name;
    }
  }
}

/** Writes one report per profile (Markdown + CSV), and a comparison when several profiles ran. Returns the files. */
export async function writeReports(dir: string, results: AttemptResult[], meta: { date: string; tasks: string[]; repeat: number; notes?: string[] }): Promise<string[]> {
  await fs.mkdir(dir, { recursive: true });
  const written: string[] = [];
  const profiles = [...new Set(results.map((r) => r.profile))];
  for (const profile of profiles) {
    const rs = results.filter((r) => r.profile === profile);
    const base = await freeBase(dir, `${meta.date}-${profile}`);
    await fs.writeFile(path.join(dir, `${base}.md`), markdownReport(rs, { ...meta, profiles: [profile] }));
    await fs.writeFile(path.join(dir, `${base}.csv`), csvReport(rs));
    written.push(path.join(dir, `${base}.md`), path.join(dir, `${base}.csv`));
  }
  if (profiles.length > 1) {
    const base = await freeBase(dir, `${meta.date}-compare-${profiles.join("-vs-")}`);
    await fs.writeFile(path.join(dir, `${base}.md`), markdownReport(results, { ...meta, profiles }));
    written.push(path.join(dir, `${base}.md`));
  }
  return written;
}

/** A before/after table from two saved CSV reports (the summary of Part 2's fixes). */
export function compareSummaries(before: ProfileSummary, after: ProfileSummary): string {
  const row = (label: string, a: string, b: string) => `| ${label} | ${a} | ${b} |`;
  return [
    `| | ${before.profile} | ${after.profile} |`,
    "|---|---|---|",
    row("Pass rate", `${pct(before.passRate)} (${before.passed}/${before.attempts})`, `${pct(after.passRate)} (${after.passed}/${after.attempts})`),
    row("AI calls (avg, all attempts)", String(before.avgCalls), String(after.avgCalls)),
    row("AI calls per successful creation", orDash(before.callsPerPass), orDash(after.callsPerPass)),
    row("Tokens per successful creation", orDash(before.tokensPerPass), orDash(after.tokensPerPass)),
    row("Cost per successful creation (USD)", orDash(before.costPerPass, (n) => n.toFixed(4)), orDash(after.costPerPass, (n) => n.toFixed(4))),
    row("Capability context (chars ≈ tokens)", `${before.avgContextChars} ≈ ${Math.round(before.avgContextChars / 4)}`, `${after.avgContextChars} ≈ ${Math.round(after.avgContextChars / 4)}`),
  ].join("\n");
}

/** Reads a CSV report back (for before/after summaries across runs). */
export function parseCsvReport(text: string): AttemptResult[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur || row.length) rows.push([...row, cur]);
  const [head, ...body] = rows;
  const idx = (k: string) => head.indexOf(k);
  const num = (r: string[], k: string) => Number(r[idx(k)] || 0);
  return body
    .filter((r) => r.length > 1)
    .map((r) => ({
      task: r[idx("task")],
      profile: r[idx("profile")],
      repeat: num(r, "repeat"),
      created: r[idx("created")] === "true",
      passed: r[idx("passed")] === "true",
      category: (r[idx("category")] || null) as AttemptResult["category"],
      error: r[idx("error")] || undefined,
      aiCalls: num(r, "aiCalls"),
      inputTokens: num(r, "inputTokens"),
      cachedTokens: num(r, "cachedTokens"),
      outputTokens: num(r, "outputTokens"),
      costUsd: num(r, "costUsd"),
      wallSec: num(r, "wallSec"),
      previews: num(r, "previews"),
      proposals: num(r, "proposals"),
      questions: num(r, "questions"),
      contextChars: num(r, "contextChars"),
      rerunAiCalls: num(r, "rerunAiCalls"),
      checks: (r[idx("checks")] ?? "")
        .split(/; (?=(?:ok|FAIL) \w+: )/)
        .map((c) => /^(ok|FAIL) (\w+): ([\s\S]*)$/.exec(c))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m): CheckResult => ({ check: { type: m[2] } as CheckDef, passed: m[1] === "ok", detail: m[3] })),
      ...(r[idx("questionLog")] ? { questionLog: r[idx("questionLog")].split("\n").map((l) => JSON.parse(l)) } : {}),
    }));
}
