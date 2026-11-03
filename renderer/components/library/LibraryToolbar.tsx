import type { App } from "@core/types";
import type { ReactNode } from "react";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";
import { Segmented } from "../common/Segmented";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export type LibraryView = "grid" | "list";

export function LibraryToolbar({
  tabs,
  searchLabel,
  query,
  onQuery,
  appFilter,
  onAppFilter,
  view,
  onView,
  apps,
}: {
  tabs: ReactNode;
  searchLabel: string;
  query: string;
  onQuery: (q: string) => void;
  appFilter: string;
  onAppFilter: (appId: string) => void;
  view: LibraryView;
  onView: (v: LibraryView) => void;
  apps: App[];
}) {
  return (
    <div className="flex items-center gap-3">
      {tabs}
      <Input
        type="search"
        className="min-w-0 max-w-xs flex-1"
        placeholder={searchLabel}
        aria-label={searchLabel}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      <NativeSelect className="w-full w-44" aria-label="App" value={appFilter} onChange={(e) => onAppFilter(e.target.value)}>
        <NativeSelectOption value="all">{copy.library.allApps}</NativeSelectOption>
        {apps.map((a) => (
          <NativeSelectOption key={a.id} value={a.id}>
            {appLabel(a.id)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <div className="ml-auto">
        <Segmented<LibraryView>
          label="View"
          value={view}
          onChange={onView}
          options={[
            { value: "grid", label: copy.library.grid },
            { value: "list", label: copy.library.list },
          ]}
        />
      </div>
    </div>
  );
}
