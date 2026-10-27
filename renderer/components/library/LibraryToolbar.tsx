import type { App } from "@core/types";
import { copy } from "@/copy";
import { appLabel } from "@/lib/format";
import { Segmented } from "../ui/Segmented";

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
      <input
        type="search"
        className="ui-input max-w-xs"
        placeholder={copy.library.search}
        aria-label={copy.library.search}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      <select className="ui-select w-44" aria-label="App" value={appFilter} onChange={(e) => onAppFilter(e.target.value)}>
        <option value="all">{copy.library.allApps}</option>
        {apps.map((a) => (
          <option key={a.id} value={a.id}>
            {appLabel(a.id)}
          </option>
        ))}
      </select>
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
