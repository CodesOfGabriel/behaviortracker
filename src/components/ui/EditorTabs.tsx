import type { KeyboardEvent } from "react";

export function EditorTabs<T extends string>({ id, label, items, value, onChange }: {
  id: string; label: string; items: { id: T; label: string }[]; value: T; onChange: (value: T) => void;
}) {
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    onChange(items[next].id);
    (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
  };
  return <div className="editor-tabs" role="tablist" aria-label={label}>
    {items.map((item, index) => <button key={item.id} id={`${id}-${item.id}-tab`} role="tab" type="button"
      aria-selected={value === item.id} aria-controls={value === item.id ? `${id}-${item.id}-panel` : undefined} tabIndex={value === item.id ? 0 : -1}
      onClick={() => onChange(item.id)} onKeyDown={(event) => keyboard(event, index)}>{item.label}</button>)}
  </div>;
}
