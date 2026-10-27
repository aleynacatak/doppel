"use client";

import type { DevFlags, ForcedStatus } from "@core/types";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { copy } from "@/copy";
import { doppel } from "@/lib/doppel";
import { appLabel } from "@/lib/format";
import { useShell } from "@/lib/store";
import { Button } from "../ui/Button";

const STATUSES: ForcedStatus[] = ["auto", "connected", "not-running", "not-installed", "permission-denied"];

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="ui-label pb-1">{title}</legend>
      {children}
    </fieldset>
  );
}

function Radio<T extends string | number>({ name, value, current, label, onChange }: { name: string; value: T; current: T; label: string; onChange: (v: T) => void }) {
  return (
    <label className="ui-choice">
      <input type="radio" name={name} checked={current === value} onChange={() => onChange(value)} />
      <span>{label}</span>
    </label>
  );
}

/** Hidden panel (Shift+D) that forces states, so every screen can be designed. */
export function DevPanel() {
  const { devFlags, apps, setDevFlags, setSettings, setAiAccess, toggleDevPanel } = useShell();
  const router = useRouter();
  if (!devFlags) return null;

  const update = async (patch: Partial<DevFlags>) => {
    setDevFlags(await doppel().setDevFlags(patch));
    setAiAccess(await doppel().getAiAccess());
  };

  return (
    <aside className="ui-dev-panel flex w-80 shrink-0 flex-col gap-5 overflow-y-auto p-4" aria-label={copy.dev.title}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="ui-h2">{copy.dev.title}</div>
          <div className="ui-small ui-muted">{copy.dev.hint}</div>
        </div>
        <Button variant="ghost" size="small" onClick={toggleDevPanel}>
          {copy.common.close}
        </Button>
      </div>

      <Group title={copy.dev.ai}>
        <label className="ui-choice">
          <input type="checkbox" checked={devFlags.mockAi} onChange={(e) => update({ mockAi: e.target.checked })} />
          <span>{copy.dev.mockAi}</span>
        </label>
      </Group>

      <Group title={copy.dev.library}>
        <label className="ui-choice">
          <input type="checkbox" checked={devFlags.emptyLibrary} onChange={(e) => update({ emptyLibrary: e.target.checked })} />
          <span>{copy.dev.emptyLibrary}</span>
        </label>
      </Group>

      <Group title={copy.dev.appStatus}>
        {apps.map((app) => (
          <label key={app.id} className="flex items-center justify-between gap-2">
            <span>{appLabel(app.id)}</span>
            <select
              className="ui-select w-44"
              value={devFlags.forceStatus[app.id] ?? "auto"}
              onChange={(e) => update({ forceStatus: { [app.id]: e.target.value as ForcedStatus } })}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === "auto" ? copy.dev.auto : copy.appStatus[s]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </Group>

      <Group title={copy.dev.creation}>
        {(Object.keys(copy.dev.creationOptions) as DevFlags["creationOutcome"][]).map((v) => (
          <Radio key={v} name="creation" value={v} current={devFlags.creationOutcome} label={copy.dev.creationOptions[v]} onChange={(creationOutcome) => update({ creationOutcome })} />
        ))}
      </Group>

      <Group title={copy.dev.run}>
        {(Object.keys(copy.dev.runOptions) as DevFlags["runOutcome"][]).map((v) => (
          <Radio key={v} name="run" value={v} current={devFlags.runOutcome} label={copy.dev.runOptions[v]} onChange={(runOutcome) => update({ runOutcome })} />
        ))}
        <label className="ui-choice pt-1">
          <input type="checkbox" checked={devFlags.envMismatch} onChange={(e) => update({ envMismatch: e.target.checked })} />
          <span>{copy.dev.env}</span>
        </label>
      </Group>

      <Group title={copy.dev.qc}>
        {(Object.keys(copy.dev.qcOptions) as DevFlags["qcOutcome"][]).map((v) => (
          <Radio key={v} name="qc" value={v} current={devFlags.qcOutcome} label={copy.dev.qcOptions[v]} onChange={(qcOutcome) => update({ qcOutcome })} />
        ))}
      </Group>

      <Group title={copy.dev.speed}>
        {copy.dev.speedOptions.map((o) => (
          <Radio key={o.value} name="speed" value={o.value} current={devFlags.speed} label={o.label} onChange={(speed) => update({ speed })} />
        ))}
      </Group>

      <div className="ui-divider flex flex-col gap-2 pt-4">
        <Button
          onClick={async () => {
            setSettings(await doppel().saveSettings({ onboarded: false }));
            router.push("/connect");
          }}
        >
          {copy.dev.showConnect}
        </Button>
        <Button
          onClick={async () => {
            if (!window.confirm(copy.dev.resetConfirm)) return;
            await doppel().resetData();
            window.location.assign("/connect");
          }}
        >
          {copy.dev.reset}
        </Button>
      </div>
    </aside>
  );
}
