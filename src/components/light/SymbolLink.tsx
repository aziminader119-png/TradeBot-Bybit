import React from 'react';
import {symbolPath} from './navigation.ts';

// Link to the Single Symbol page (/Symbol/<SYMBOL>), opened in a new tab as before it was disabled.
// Anything that is not a USDT perpetual symbol (e.g. the '—' placeholder) stays plain text.
export function SymbolLink({symbol, children, className, title}: {symbol: string | null | undefined; children: React.ReactNode; className?: string; title?: string}) {
  if (!symbol || !/^[A-Z0-9]{2,30}USDT$/i.test(symbol)) return <span className={className} title={title}>{children}</span>;
  return <a className={className} href={symbolPath(symbol)} target="_blank" rel="noopener noreferrer" title={title}>{children}</a>;
}
