import type { ParamDef } from "@core/types";
import { copy } from "@/copy";

function describeDefault(p: ParamDef) {
  if (p.default === undefined || p.default === "") return null;
  if (Array.isArray(p.default)) return copy.plural(p.default.length, "item");
  if (typeof p.default === "boolean") return p.default ? copy.run.yes : "No";
  return String(p.default);
}

export function ParamsList({ params }: { params: ParamDef[] }) {
  if (params.length === 0) return <p className="ui-muted">{copy.routine.noParams}</p>;
  return (
    <table className="ui-table">
      <tbody>
        {params.map((p) => {
          const def = describeDefault(p);
          return (
            <tr key={p.key}>
              <td className="py-2 pr-4">
                <div>{p.label}</div>
                {p.help && <div className="ui-small ui-muted">{p.help}</div>}
              </td>
              <td className="ui-muted py-2 pr-4">{copy.routine.paramTypes[p.type]}</td>
              <td className="ui-muted py-2 pr-4">{p.required ? copy.routine.required : copy.routine.optional}</td>
              <td className="ui-muted py-2">{def}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
