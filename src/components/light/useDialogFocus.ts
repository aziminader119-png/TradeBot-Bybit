import {useEffect,useRef} from 'react';

// One keyboard/focus policy for confirmations and the mobile navigation drawer.
let locks = 0;
let previousOverflow = '';
const layers: HTMLElement[] = [];
export function useDialogFocus(open:boolean,busy:boolean,onClose:()=>void) {
  const ref=useRef<HTMLDivElement|null>(null);
  const latest=useRef({busy,onClose}); latest.current={busy,onClose};
  useEffect(()=>{
    if(!open||!ref.current)return;
    const node=ref.current,previous=document.activeElement as HTMLElement|null;
    layers.push(node);
    if(locks++===0){previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';}
    const focusable=()=>Array.from(node.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(el=>!el.closest('[inert]')&&el.getClientRects().length>0);
    (focusable()[0]||node).focus();
    const key=(e:KeyboardEvent)=>{
      if(layers[layers.length-1]!==node)return;
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(!latest.current.busy)latest.current.onClose();}
      if(e.key==='Tab'){
        const list=focusable(),first=list[0],last=list[list.length-1];
        if(!first){e.preventDefault();node.focus();return;}
        if(e.shiftKey&&(document.activeElement===first||!node.contains(document.activeElement))){e.preventDefault();last.focus();}
        else if(!e.shiftKey&&(document.activeElement===last||!node.contains(document.activeElement))){e.preventDefault();first.focus();}
      }
    };
    document.addEventListener('keydown',key,true);
    return()=>{
      document.removeEventListener('keydown',key,true);
      const index=layers.indexOf(node);if(index>=0)layers.splice(index,1);
      if(--locks===0)document.body.style.overflow=previousOverflow;
      if(previous?.isConnected)previous.focus();
    };
  },[open]);
  return ref;
}
