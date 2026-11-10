
import { BybitClient } from "./src/server/bybit/bybitClient.ts";
import { BotDatabase } from "./src/server/db/database.ts";

const db = BotDatabase.getInstance();
const s = db.getSettings();
const client = new BybitClient(s.apiKey, s.apiSecret, false);
const res = await client.getPositions();
const active = res.filter((p: any) => parseFloat(p.size || "0") > 0);
console.log("BYBIT ACTIVE POSITIONS (" + active.length + "):");
active.forEach((p: any) => {
  console.log(p.symbol, p.side, "size:", p.size, "val:", p.positionValue, "entry:", p.avgPrice, "mark:", p.markPrice);
});

// The former "last 5 orders" section called BybitClient.getHistoricOrders(), which does not exist (it threw a
// TypeError at runtime and failed `tsc --noEmit`). Removed; this read-only script now lists positions only.
