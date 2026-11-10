import React from 'react';
export type FilterOption<T extends string | number> = { value: T; label: string };
/** Shared inline filters: presentation only. The caller retains all filtering state and callbacks. */
export function FilterChoices<T extends string | number>({label,value,options,onChange,className='',testId,optionAttribute}:{
 label:string;value:T;options:FilterOption<T>[];onChange:(value:T)=>void;className?:string;testId?:string;optionAttribute?:string;
}){
 return <div className={'filter-choices '+className} role="group" aria-label={label} data-testid={testId}>
  {label&&<span className="filter-label">{label}</span>}
  {options.map(option=><button type="button" key={option.value} className={option.value===value?'active':undefined} aria-pressed={option.value===value} {...(optionAttribute?{[optionAttribute]:option.value}:{})} onClick={()=>onChange(option.value)}>{option.label}</button>)}
 </div>;
}
