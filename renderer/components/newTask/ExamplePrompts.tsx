import { copy } from "@/copy";

type Example = (typeof copy.newTask.examples)[number];

export function ExamplePrompts({ onPick }: { onPick: (example: Example) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="ui-label">{copy.newTask.examplesLabel}</div>
      <div className="flex flex-wrap gap-2">
        {copy.newTask.examples.map((ex) => (
          <button key={ex.text} type="button" className="ui-chip" onClick={() => onPick(ex)}>
            {ex.text}
          </button>
        ))}
      </div>
    </div>
  );
}
