import { copy } from "@/copy";
import { Button } from "@/components/ui/button";

type Example = (typeof copy.newTask.examples)[number];

export function ExamplePrompts({ onPick }: { onPick: (example: Example) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm font-medium">{copy.newTask.examplesLabel}</div>
      <div className="flex flex-wrap gap-2">
        {copy.newTask.examples.map((ex) => (
          <Button variant="outline" size="sm" className="h-auto whitespace-normal text-left" key={ex.text} onClick={() => onPick(ex)}>
            {ex.text}
          </Button>
        ))}
      </div>
    </div>
  );
}
