// Filtering affects display only. Funding failures, holds and the full CSV audit trail are retained.
export const visibleLog = (log: {category?: string; reason?: string}) =>
  !(log.category === 'CYCLE' && /^Funding data restored: /.test(log.reason || ''));
