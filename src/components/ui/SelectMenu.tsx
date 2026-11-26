import { useId, useRef, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

type Option = { value: string; label: string; disabled?: boolean };
export function SelectMenu({label,value,options,disabled,onChange,placeholder="Selecione uma opção"}: {
  label:string;value:string;options:Option[];disabled?:boolean;placeholder?:string;onChange:(value:string)=>void;
}) {
  const id=useId();
  const field=useRef<HTMLDivElement>(null);
  const [portalContainer,setPortalContainer]=useState<HTMLElement>();
  const emptyValue=`${id}-empty`;
  const hasEmptyOption=options.some(option=>option.value==="");
  return <div className="ui-select-field" ref={field}>
    <label htmlFor={id}>{label}</label>
    <Select value={value===""&&hasEmptyOption?emptyValue:value} onValueChange={selected=>onChange(selected===emptyValue?"":selected)} disabled={disabled||!options.some(option=>!option.disabled)}
      onOpenChange={open=>{if(open)setPortalContainer(field.current?.closest("dialog")??undefined);}}>
      <SelectTrigger id={id} aria-label={label} className="ui-select-trigger"><SelectValue placeholder={placeholder}/></SelectTrigger>
      <SelectContent container={portalContainer} position="popper" align="start" className="ui-select-content">
        {options.map(option=><SelectItem key={option.value} value={option.value===""?emptyValue:option.value} disabled={option.disabled} className="ui-select-item">{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}
