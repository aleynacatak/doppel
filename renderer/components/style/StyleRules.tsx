import type { StyleProfile } from "@core/types";
import { copy } from "@/copy";

export function StyleRules({ rules }: { rules: StyleProfile["rules"] }) {
  if (rules.length === 0) return <p className="ui-muted">{copy.style.noRules}</p>;
  return (
    <table className="ui-table">
      <tbody>
        {rules.map((r) => (
          <tr key={r.label}>
            <td className="ui-muted w-48 py-2 pr-4">{r.label}</td>
            <td className="py-2">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
