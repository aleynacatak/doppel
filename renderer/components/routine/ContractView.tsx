import type { AppId, MatchRule, PortDef, SettingDef } from "@core/types";
import { describeSpec, inputSpec, outputSpec } from "@shared/ports";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";
import { AppTag } from "../common/AppLogo";
import { Section } from "../common/Section";
import { Tag } from "../common/Tag";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One port: label, what it takes or gives in plain words, required or not. */
function PortRow({ port, what }: { port: PortDef; what: string }) {
  return (
    <TableRow>
      <TableCell className="py-3 pr-4">
        <div>{port.label}</div>
        {port.description && <div className="text-sm text-muted-foreground">{port.description}</div>}
      </TableCell>
      <TableCell className="text-muted-foreground py-3 pr-4">{capitalize(what)}</TableCell>
      <TableCell className="text-muted-foreground py-3">{port.required ? copy.ports.required : copy.ports.optional}</TableCell>
    </TableRow>
  );
}

export function PortTable({ ports, describe, empty }: { ports: PortDef[]; describe: (p: PortDef) => string; empty: string }) {
  if (ports.length === 0) return <p className="text-muted-foreground">{empty}</p>;
  return (
    <Table>
      <TableBody>
        {ports.map((p) => (
          <PortRow key={p.key} port={p} what={describe(p)} />
        ))}
      </TableBody>
    </Table>
  );
}

function describeDefault(s: SettingDef) {
  if (s.default === undefined || s.default === "") return null;
  if (Array.isArray(s.default)) return copy.plural(s.default.length, "item");
  if (typeof s.default === "boolean") return s.default ? copy.run.yes : "No";
  return String(s.default);
}

export function SettingsTable({ settings }: { settings: SettingDef[] }) {
  if (settings.length === 0) return <p className="text-muted-foreground">{copy.routine.noSettings}</p>;
  return (
    <Table>
      <TableBody>
        {settings.map((s) => (
          <TableRow key={s.key}>
            <TableCell className="py-3 pr-4">
              <div>{s.label}</div>
              {s.help && <div className="text-sm text-muted-foreground">{s.help}</div>}
            </TableCell>
            <TableCell className="text-muted-foreground py-3 pr-4">{copy.routine.paramTypes[s.type]}</TableCell>
            <TableCell className="text-muted-foreground py-3">{describeDefault(s)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type Contract = { appId: AppId; inputs: PortDef[]; outputs: PortDef[]; settings?: SettingDef[]; iterate?: { input: string }; matches?: Record<string, MatchRule> };

function ContractInputs({ routine }: { routine: Contract }) {
  const iterPort = routine.iterate ? routine.inputs.find((p) => p.key === routine.iterate!.input) : undefined;
  const describeInput = (p: PortDef) => (p.type === "document" ? copy.routine.documentPort(appLabel(routine.appId)) : describeSpec(inputSpec(p, routine.appId)));
  return (
    <>
      <PortTable ports={routine.inputs} describe={describeInput} empty={copy.routine.noInputs} />
      <p className="text-sm text-muted-foreground flex flex-wrap items-center gap-1">
        {iterPort ? copy.routine.iterates(iterPort.label) : copy.routine.runsOnce}
      </p>
      {Object.entries(routine.matches ?? {}).map(([key, rule]) => {
        const port = routine.inputs.find((p) => p.key === key);
        return port ? (
          <p key={key} className="text-sm text-muted-foreground">
            {copy.routine.pairs(port.label, copy.match.describe(rule))}
          </p>
        ) : null;
      })}
    </>
  );
}

function ContractOutputs({ routine }: { routine: Contract }) {
  return <PortTable ports={routine.outputs} describe={(p) => describeSpec(outputSpec(p, !!routine.iterate, routine.appId))} empty={copy.routine.noOutputs} />;
}

/** The contract as one card each for inputs, outputs and settings: the routine's own page. */
export function ContractSections({ routine }: { routine: Contract }) {
  return (
    <>
      <Section title={copy.routine.inputsTitle}>
        <ContractInputs routine={routine} />
      </Section>
      <Section title={copy.routine.outputsTitle}>
        <ContractOutputs routine={routine} />
      </Section>
      {routine.settings && (
        <Section title={copy.routine.settingsTitle}>
          <SettingsTable settings={routine.settings} />
        </Section>
      )}
    </>
  );
}

/** A routine's I/O contract: inputs, what it iterates over, outputs, settings. */
export function ContractView({ routine }: { routine: Contract }) {
  return (
    <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-2">
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium">{copy.routine.inputsTitle}</div>
        <ContractInputs routine={routine} />
      </div>
      <div className="flex flex-col gap-3">
        <div className="text-sm font-medium">{copy.routine.outputsTitle}</div>
        <ContractOutputs routine={routine} />
        {routine.settings && (
          <>
            <div className="text-sm font-medium pt-2">{copy.routine.settingsTitle}</div>
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
      <AppTag appId={appId} />
      {starter && <Tag tone="quiet">{copy.routine.madeByDoppl}</Tag>}
    </>
  );
}
