import { Tabs, TabsList, TabsTrigger } from "./tabs";

export function EditorTabs<T extends string>({ id, label, items, value, onChange }: {
  id: string; label: string; items: { id: T; label: string }[]; value: T; onChange: (value: T) => void;
}) {
  return <Tabs value={value} onValueChange={next=>onChange(next as T)} className="ui-tabs-nav">
    <TabsList aria-label={label} className="ui-tabs-list">
      {items.map(item=><TabsTrigger key={item.id} value={item.id} id={`${id}-${item.id}-tab`}
        aria-controls={`${id}-${item.id}-panel`} className="ui-tabs-trigger">{item.label}</TabsTrigger>)}
    </TabsList>
  </Tabs>;
}
