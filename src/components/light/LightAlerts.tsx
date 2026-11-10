import React, { useState } from 'react';
import type { BotStateSummary } from '../../types/trading.ts';
import { ReportSummary } from './reports.tsx';
import { FilterChoices } from './FilterChoices.tsx';
import { LightReports } from './LightReports.tsx';
import { AlertManager, AlertEventsTable, alertSummary, useAlertEvents, useAlertRules } from '../alerts/AlertCenter.tsx';

// Smart MART Alerts and Alert History pages: both use the one server-side alert service (notification only).
export const LightAlerts: React.FC<{ state: BotStateSummary | null; view: 'smart' | 'history' }> = ({ state, view }) => {
  const rules = useAlertRules(), events = useAlertEvents();
  const [tab, setTab] = useState<'indicator' | 'bot'>('indicator');
  if (view === 'smart') return <div className="workspace lp-botpos lp-reports" data-testid="smart-page">
    <ReportSummary items={alertSummary(rules.data?.rules, events.data?.events, true)} />
    <p className="lp-source-note">Recovery alerts for confirmed open BOT and External positions: an indicator condition on a closed candle (optionally a minimum loss on the underlying price move or the leveraged ROI). You decide whether to trade — an alert never executes MART, opens, closes or changes any position, TP, leverage, margin mode, freeze or ownership.</p>
    <AlertManager smart={true} />
  </div>;
  return <div className="workspace lp-botpos lp-reports" data-testid="alerts-page">
    <ReportSummary items={alertSummary(rules.data?.rules, events.data?.events, false)} />
    <div className="lp-risk-filter"><FilterChoices<'indicator' | 'bot'> label="Source" value={tab} options={[{ value: 'indicator', label: 'Indicator & Smart MART alerts' }, { value: 'bot', label: 'Bot alerts' }]} onChange={setTab} /></div>
    {tab === 'indicator' ? <><p className="lp-source-note">Every raised indicator and Smart MART alert (latest 2,000). Click a symbol to open its chart at the signal.</p><AlertEventsTable /></> : <LightReports key="alerts" view="alerts" state={state} />}
  </div>;
};
