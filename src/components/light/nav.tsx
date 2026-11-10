import React from 'react';

// Sidebar pages use real bot records and existing read-only exchange endpoints.
export type LightNavItem = { id: string; label: string; built: boolean; icon: React.ReactNode };

export const LIGHT_NAV: LightNavItem[] = [
  { id: 'dashboard', label: "Dashboard", built: true, icon: <><rect x="2.2" y="2.2" width="4.6" height="4.6" rx="1"></rect><rect x="9.2" y="2.2" width="4.6" height="4.6" rx="1"></rect><rect x="2.2" y="9.2" width="4.6" height="4.6" rx="1"></rect><rect x="9.2" y="9.2" width="4.6" height="4.6" rx="1"></rect></> },
  { id: 'pump_short', label: 'Pump Short', built: true, icon: <><path d="M2 12 L6 8 L9 10 L14 3"></path><path d="M10 3h4v4"></path><path d="M10 12h4"></path></> },
  { id: 'closed_positions', label: "Closed Positions", built: true, icon: <><rect x="3.2" y="2.2" width="9.6" height="11.6" rx="1"></rect><path d="M5.6 8l1.8 1.8 3.2-3.8"></path></> },
  { id: 'symbols', label: "Symbols", built: true, icon: <><circle cx="8" cy="8" r="5.8"></circle><path d="M8 4.6v6.8M6.2 6.2h2.6a1.3 1.3 0 0 1 0 2.6H6.2h2.6a1.3 1.3 0 0 1 0 2.6H6.2"></path></> },
  { id: 'all_positions', label: "All Positions", built: true, icon: <><path d="M8 1.8 2.2 4.6 8 7.4l5.8-2.8L8 1.8Z"></path><path d="M2.2 8 8 10.8 13.8 8"></path><path d="M2.2 11.4 8 14.2l5.8-2.8"></path></> },
  { id: 'bot_positions', label: "BOT Positions", built: true, icon: <><rect x="3" y="5.6" width="10" height="7.2" rx="1.4"></rect><path d="M8 2.4v3.2"></path><path d="M5.4 14.4v-1.6M10.6 14.4v-1.6"></path><circle cx="6.1" cy="8.6" r="0.9"></circle><circle cx="9.9" cy="8.6" r="0.9"></circle></> },
  // existing page, not in the design hand-off: managing / resuming / resolving hedge cycles
  { id: 'bot_cycles', label: 'Bot Cycles', built: true, icon: <><path d="M13.4 6.2A5.6 5.6 0 0 0 3.1 5"></path><path d="M2.6 9.8a5.6 5.6 0 0 0 10.3 1.2"></path><path d="M3 2.4V5h2.6"></path><path d="M13 13.6V11h-2.6"></path></> },
  { id: 'external_positions', label: "External Positions", built: true, icon: <><path d="M9.2 2.8h4v4"></path><path d="M13.2 2.8 7.4 8.6"></path><path d="M12 8.6v4.6H3V3.6h4.6"></path></> },
  { id: 'aged_positions', label: "Aged Positions", built: true, icon: <><circle cx="8" cy="8" r="5.8"></circle><path d="M8 4.6V8l2.6 1.6"></path></> },
  { id: 'latest_opened', label: "Latest Opened", built: true, icon: <><circle cx="8" cy="8" r="5.8"></circle><path d="M8 5.2v5.6M5.2 8h5.6"></path></> },
  { id: 'trigger_orders', label: "Trigger Orders", built: true, icon: <><circle cx="8" cy="8" r="5.8"></circle><path d="M8 5.2v5.6M5.2 8h5.6"></path></> },
  { id: 'trade_history', label: "Trade History", built: true, icon: <><path d="M3 4.2h10M3 8h10M3 11.8h6.4"></path></> },
  { id: 'deep_loss_positions', label: "Deep Loss Positions", built: true, icon: <><path d="M2 4.4 6.6 9l2.8-2L14 11.6"></path><path d="M14 8.4v3.2h-3.2"></path></> },
  { id: 'deep_profit_positions', label: "Deep Profit Positions", built: true, icon: <><path d="M2 11.6 6.6 7l2.8 2L14 4.4"></path><path d="M14 7.6V4.4h-3.2"></path></> },
  { id: 'high_margin_positions', label: "High Margin Positions", built: true, icon: <><path d="M2.4 11.2a5.6 5.6 0 0 1 11.2 0"></path><path d="M8 11.2l3.1-3.5"></path><circle cx="8" cy="11.2" r="0.9"></circle></> },
  { id: 'mart_positions', label: "Mart Positions", built: true, icon: <><path d="M3 8a5 5 0 0 1 8.4-3.6L14 6"></path><path d="M14 3v3h-3"></path><path d="M13 8a5 5 0 0 1-8.4 3.6L2 10"></path><path d="M2 13v-3h3"></path></> },
  { id: 'smart_mart_alerts', label: "Smart Mart Alerts", built: true, icon: <><path d="M8 2.2a4 4 0 0 0-4 4c0 3.6-1.6 4.6-1.6 4.6h11.2s-1.6-1-1.6-4.6a4 4 0 0 0-4-4Z"></path><path d="M6.6 13.2a1.5 1.5 0 0 0 2.8 0"></path></> },
  { id: 'alert_history', label: "Alert History", built: true, icon: <><path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8"></path><path d="M2.4 2.6v2.6H5"></path><path d="M8 5v3.2l2.2 1.4"></path></> },
  { id: 'pl_analytics', label: "P&L Analytics", built: true, icon: <><path d="M2.6 13.4V8.6M6.2 13.4V4.6M9.8 13.4V7.2M13.4 13.4V2.6"></path></> },
  { id: 'statistics', label: "Statistics", built: true, icon: <><path d="M2.4 8a5.6 5.6 0 1 0 5.6-5.6V8H2.4Z"></path><path d="M9.6 6.4V2.6"></path></> },
  { id: 'logs', label: "Logs", built: true, icon: <><rect x="2.4" y="2.8" width="11.2" height="10.4" rx="1.2"></rect><path d="M5 6l1.8 1.8L5 9.6M8.4 10h3"></path></> },
  { id: 'security', label: 'Security', built: true, icon: <><path d="M8 2 3 4v4c0 3 5 6 5 6s5-3 5-6V4L8 2Z"/><path d="m5.5 8 1.5 1.5L10.5 6"/></> },
];

export const NavIcon: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);


