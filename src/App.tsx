/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Approved light design: sidebar + 110px header shell. Dashboard, Symbols and BOT Positions use the light layout;
// the other existing pages keep their own styling; design pages that do not exist yet open a placeholder without data.
import React, {lazy, Suspense} from 'react';
import { useLiveReportRefresh } from './hooks/useLiveReportRefresh.ts';
import {TradeNotifications} from './components/notifications/TradeNotifications.tsx';
import {usePageRoute,navigate,PAGE_PATHS,symbolPath} from './components/light/navigation.ts';
import { useBotState } from './hooks/useBotState.ts';
import { LightShell } from './components/light/LightShell.tsx';
import { LightDashboard } from './components/light/LightDashboard.tsx';
const LightSymbols = lazy(() => import('./components/light/LightSymbols.tsx').then(module => ({default: module.LightSymbols})));
const LightBotPositions = lazy(() => import('./components/light/LightBotPositions.tsx').then(module => ({default: module.LightBotPositions})));
const BotCyclesView = lazy(() => import('./components/views/BotCyclesView.tsx').then(module => ({default: module.BotCyclesView})));
const LightActivity = lazy(() => import('./components/light/LightActivity.tsx').then(module => ({default: module.LightActivity})));
const LightPositionLists = lazy(() => import('./components/light/LightPositionLists.tsx').then(module => ({default: module.LightPositionLists})));
const LightClosed = lazy(() => import('./components/light/LightClosed.tsx').then(module => ({default: module.LightClosed})));
const LightPnlAnalytics = lazy(() => import('./components/light/LightPnlAnalytics.tsx').then(module => ({default: module.LightPnlAnalytics})));
const LightReports = lazy(() => import('./components/light/LightReports.tsx').then(module => ({default: module.LightReports})));
const LightSymbolWorkspace = lazy(() => import('./components/light/LightSymbolWorkspace.tsx').then(module => ({default: module.LightSymbolWorkspace})));
const LightAlerts = lazy(() => import('./components/light/LightAlerts.tsx').then(module => ({default: module.LightAlerts})));
const LightSecurity = lazy(() => import('./components/light/LightSecurity.tsx').then(module => ({default: module.LightSecurity})));

export default function App() {
  const { state, wsConnected, lastUpdated, refresh } = useBotState();
  useLiveReportRefresh(state);
  const route=usePageRoute(),activeTab=route.tab,selectedSymbol=route.symbol||'BTCUSDT';
  const go=(tab:string)=>navigate(PAGE_PATHS[tab]||'/Dashboard');
  const setSelectedSymbol=(s:string)=>navigate(symbolPath(s));
  // existing pages keep their own styling inside .tb-legacy
  return (
    <TradeNotifications state={state}><LightShell state={state} wsConnected={wsConnected} lastUpdated={lastUpdated} activeTab={activeTab} onTab={go} onRefresh={refresh}>
      <Suspense fallback={<div className="workspace" role="status">Loading page…</div>}>
      {activeTab === 'not_found' && <div className="content"><h2>Page not found</h2><a href="/Dashboard">Dashboard</a></div>}
      {activeTab === 'dashboard' && <LightDashboard state={state} onRefresh={refresh} />}
      {activeTab === 'symbols' && <LightSymbols state={state} onRefresh={refresh} onGoSymbol={setSelectedSymbol} />}
      {activeTab === 'bot_cycles' && <BotCyclesView state={state} onRefresh={refresh} onGoSymbols={() => go('symbols')} />}
      {activeTab === 'all_positions' && <LightPositionLists key="all" view="all" state={state} onGoCycles={() => go('bot_cycles')} />}
      {activeTab === 'bot_positions' && <LightBotPositions state={state} onGoCycles={() => go('bot_cycles')} />}
      {activeTab === 'external_positions' && <LightPositionLists key="external" view="external" state={state} onGoCycles={() => go('bot_cycles')} />}
      {activeTab === 'latest_opened' && <LightPositionLists key="latest" view="latest" state={state} onGoCycles={() => go('bot_cycles')} />}
      {activeTab === 'aged_positions' && <LightPositionLists key="aged" view="aged" state={state} onGoCycles={() => go('bot_cycles')} />}
      {activeTab === 'deep_loss_positions' && <LightPositionLists key="loss" view="loss" state={state} onGoCycles={() => go('bot_cycles')} />}
      {activeTab === 'deep_profit_positions' && <LightPositionLists key="profit" view="profit" state={state} onGoCycles={() => go('bot_cycles')} />}
      {activeTab === 'high_margin_positions' && <LightPositionLists key="margin" view="margin" state={state} onGoCycles={() => go('bot_cycles')} />}
      {activeTab === 'trade_history' && <LightActivity key="trades" view="trades" state={state} />}
      {activeTab === 'trigger_orders' && <LightActivity key="triggers" view="triggers" state={state} />}
      {activeTab === 'closed_positions' && <LightClosed />}
      {activeTab === 'mart_positions' && <LightPositionLists key="mart" view="mart" state={state} onGoCycles={() => go('bot_cycles')} />}
      {activeTab === 'smart_mart_alerts' && <LightAlerts key="smart" view="smart" state={state} />}
      {activeTab === 'alert_history' && <LightAlerts key="history" view="history" state={state} />}
      {activeTab === 'pl_analytics' && <LightPnlAnalytics state={state} />}
      {activeTab === 'statistics' && <LightReports key="statistics" view="statistics" state={state} />}
      {activeTab === 'logs' && <LightReports key="logs" view="logs" state={state} />}
      {activeTab === 'security' && <LightSecurity state={state} onRefresh={refresh} />}
      {activeTab === 'symbol_trading' && <LightSymbolWorkspace key={selectedSymbol+'|'+state?.settings?.environment+'|'+state?.settings?.apiHost} state={state} symbol={selectedSymbol} onSymbol={setSelectedSymbol} onRefresh={refresh} onGoCycles={() => go('bot_cycles')} onGoSymbols={() => go('symbols')} />}
      </Suspense>
    </LightShell></TradeNotifications>
  );
}



