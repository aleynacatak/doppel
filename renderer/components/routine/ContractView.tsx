import type { AppId, MatchRule, PortDef, SettingDef } from "@core/types";
import { describeSpec, inputSpec, outputSpec } from "@shared/ports";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";
import { Tag } from "../ui/Tag";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One port: label, what it takes or gives in plain words, required or not. */
function PortRow({ port, what }: { port: PortDef; what: string }) {
  return (
    <tr>
      <td className="py-2 pr-4">
        <div>{port.label}</div>
        {port.description && <div className="ui-small ui-muted">{port.description}</div>}
      </td>
      <td className="ui-muted py-2 pr-4">{capitalize(what)}</td>
      <td className="ui-muted py-2">{port.required ? copy.ports.required : copy.ports.optional}</td>
    </tr>
  );
}

export function PortTable({ ports, describe, empty }: { ports: PortDef[]; describe: (p: PortDef) => string; empty: string }) {
  if (ports.length === 0) return <p className="ui-muted">{empty}</p>;
  return (
    <table className="ui-table">
      <tbody>
        {ports.map((p) => (
          <PortRow key={p.key} port={p} what={describe(p)} />
        ))}
      </tbody>
    </table>
  );
}

function describeDefault(s: SettingDef) {
  if (s.default === undefined || s.default === "") return null;
  if (Array.isArray(s.default)) return copy.plural(s.default.length, "item");
  if (typeof s.default === "boolean") return s.default ? copy.run.yes : "No";
  return String(s.default);
}

export function SettingsTable({ settings }: { settings: SettingDef[] }) {
  if (settings.length === 0) return <p className="ui-muted">{copy.routine.noSettings}</p>;
  return (
    <table className="ui-table">
      <tbody>
        {settings.map((s) => (
          <tr key={s.key}>
            <td className="py-2 pr-4">
              <div>{s.label}</div>
              {s.help && <div className="ui-small ui-muted">{s.help}</div>}
            </td>
            <td className="ui-muted py-2 pr-4">{copy.routine.paramTypes[s.type]}</td>
            <td className="ui-muted py-2">{describeDefault(s)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A routine's I/O contract: inputs, what it iterates over, outputs, settings. */
export function ContractView({
  routine,
  compact = false,
}: {
  routine: { appId: AppId; inputs: PortDef[]; outputs: PortDef[]; settings?: SettingDef[]; iterate?: { input: string }; matches?: Record<string, MatchRule> };
  compact?: boolean;
}) {
  const iterPort = routine.iterate ? routine.inputs.find((p) => p.key === routine.iterate!.input) : undefined;
  const describeInput = (p: PortDef) => (p.type === "document" ? copy.routine.documentPort(appLabel(routine.appId)) : describeSpec(inputSpec(p, routine.appId)));
  return (
    <div className={`grid grid-cols-1 gap-6 ${compact ? "" : "lg:grid-cols-2"}`}>
      <div className="flex flex-col gap-2">
        <div className="ui-h3">{copy.routine.inputsTitle}</div>
        <PortTable ports={routine.inputs} describe={describeInput} empty={copy.routine.noInputs} />
        <p className="ui-small ui-muted flex flex-wrap items-center gap-1">
          {iterPort ? copy.routine.iterates(iterPort.label) : copy.routine.runsOnce}
        </p>
        {Object.entries(routine.matches ?? {}).map(([key, rule]) => {
          const port = routine.inputs.find((p) => p.key === key);
          return port ? (
            <p key={key} className="ui-small ui-muted">
              {copy.routine.pairs(port.label, copy.match.describe(rule))}
            </p>
          ) : null;
        })}
      </div>
      <div className="flex flex-col gap-2">
        <div className="ui-h3">{copy.routine.outputsTitle}</div>
        <PortTable ports={routine.outputs} describe={(p) => describeSpec(outputSpec(p, !!routine.iterate, routine.appId))} empty={copy.routine.noOutputs} />
        {routine.settings && (
          <>
            <div className="ui-h3 pt-2">{copy.routine.settingsTitle}</div>
            <SettingsTable settings={routine.settings} />
          </>
        )}
      </div>
    </div>
  );
}

/** The app badge of a routine, with "Made by Doppl" for starters. */
export function RoutineBadges({ appId, starter }: { appId: AppId; starter?: boolean }) {
  return (
    <>
      <Tag tone="strong">{appLabel(appId)}</Tag>
      {starter && <Tag tone="quiet">{copy.routine.madeByDoppl}</Tag>}
    </>
  );
}
