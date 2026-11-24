import { useId } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

type Option = { value: string; label: string };
export function SelectMenu({label,value,options,disabled,onChange,placeholder="Selecione uma opção"}: {
  label:string;value:string;options:Option[];disabled?:boolean;placeholder?:string;onChange:(value:string)=>void;
}) {
  const id=useId();
  return <div className="ui-select-field">
    <label htmlFor={id}>{label}</label>
    <Select value={value} onValueChange={onChange} disabled={disabled||!options.length}>
      <SelectTrigger id={id} aria-label={label} className="ui-select-trigger"><SelectValue placeholder={placeholder}/></SelectTrigger>
      <SelectContent position="popper" align="start" className="ui-select-content">
        {options.filter(option=>option.value!=="").map(option=><SelectItem key={option.value} value={option.value} className="ui-select-item">{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}
