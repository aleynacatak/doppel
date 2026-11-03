import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)}>
      <TabsList aria-label={label}>
        {options.map((o) => (
          <TabsTrigger key={o.value} value={o.value}>
            {o.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
