// Price/P&L ticks do not invalidate history; fills and position changes do.
export function reportChangeKey(state) {
  const rows = (value, fields) => (Array.isArray(value) ? value : [])
    .map(row => JSON.stringify(fields.map(field => row[field] ?? null))).sort();
  return JSON.stringify([
    rows(state.positions, ['id','symbol','side','size','qty','entryPrice','owner','missingOnExchange']),
    rows(state.trades, ['id','orderId','symbol','side','action','qty','quantity','timestamp'])
  ]);
}

