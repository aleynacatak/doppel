import type { App } from "@core/types";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";
import { Segmented } from "../common/Segmented";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export type LibraryView = "grid" | "list";

export function LibraryToolbar({
  query,
  onQuery,
  appFilter,
  onAppFilter,
  view,
  onView,
  apps,
}: {
  query: string;
  onQuery: (q: string) => void;
  appFilter: string;
  onAppFilter: (appId: string) => void;
  view: LibraryView;
  onView: (v: LibraryView) => void;
  apps: App[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Input
        type="search"
        className="max-w-xs"
        placeholder={copy.library.search}
        aria-label={copy.library.search}
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
