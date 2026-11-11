import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

type Option = { value: string; label: string };

export function SelectMenu({ label, value, options, disabled, onChange }: {
  label: string;
  value: string;
  options: Option[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  useEffect(() => {
    if (!open) return;
    optionsRef.current[selectedIndex]?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open, selectedIndex]);

  const choose = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      optionsRef.current[next]?.focus();
    }
  };

  return <div className="select-menu" ref={rootRef}>
    <span className="select-menu-label">{label}</span>
    <button ref={triggerRef} type="button" className="select-menu-trigger" disabled={disabled || !options.length}
      aria-label={label} aria-haspopup="listbox" aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setOpen(true);
        }
      }}>
      <span>{options[selectedIndex]?.label ?? "Selecione um resultado"}</span><ChevronDown size={15} />
    </button>
    {open && <div className="select-menu-options" role="listbox" aria-label={label}>
      {options.map((option, index) => <button key={option.value} ref={(element) => { optionsRef.current[index] = element; }}
        type="button" role="option" aria-selected={option.value === value} className="select-menu-option"
        onClick={() => choose(option.value)} onKeyDown={(event) => onOptionKeyDown(event, index)}>
        <span>{option.label}</span>{option.value === value && <Check size={15} />}
      </button>)}
    </div>}
  </div>;
}
