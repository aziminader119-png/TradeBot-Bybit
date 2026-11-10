# MG Exchange Charts 0.1.1

Upstream: https://github.com/MG-Trading-Terminal/mg-exchange-chart
Pinned commit: a8ebc06b910b242a1555efad2dc13282d3c15a5e
License: Apache-2.0; see LICENSE.

index.js is an esbuild ESM bundle of upstream src/index.ts with the local adaptations documented below. The declarations were generated using TypeScript. No npm dependency or CDN is required. The NEXORA React chart controls are adapted separately under components/futures. The local changes preserve the existing public chart API.


Local lifecycle fix: ignore late history and stream callbacks after destroy or a newer timeframe load; suppress scheduling after destroy and make destroy idempotent. Regression scenarios: tests/futures-stream-recovery.test.mts.

Position overlay adaptation: optional display colour per line and explicit USDT P&L labels with four decimals; no interaction or exchange writes are added.

Position labels use a gap left of centre in the line, 14px bold labels and price badges, with independently coloured P&L. The legacy alert renderer is unchanged.

Labels are transparent with no background rectangle. Price/time axes and current-price markers are two pixels larger; the price axis is 84px wide to fit them.

Overlapping or nearby position/protection labels share a horizontal lane with 28px gaps. Price lines retain their actual Y coordinates.

Live chart scrolling preserves user-selected right padding when new candles arrive, rather than snapping to the axis. Initial/live view reserves 12% right padding; history browsing is not auto-recentered by ticks.
