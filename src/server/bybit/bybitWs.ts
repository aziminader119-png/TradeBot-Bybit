import WebSocket from 'ws';
import { SymbolMarketInfo } from '../../types/trading.ts';

export type TickerCallback = (symbol: string, ticker: Partial<SymbolMarketInfo>) => void;

export class BybitWsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private isTestnet: boolean;
  private subscribedSymbols: Set<string> = new Set();
  private pingInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private listeners: Set<TickerCallback> = new Set();
  private isDestroyed: boolean = false;
  private isConnected: boolean = false;

  constructor(isTestnet: boolean = false) {
    this.isTestnet = isTestnet;
    this.url = isTestnet
      ? 'wss://stream-testnet.bybit.com/v5/public/linear'
      : 'wss://stream.bybit.com/v5/public/linear';
  }

  public setTestnet(isTestnet: boolean): void {
    if (this.isTestnet !== isTestnet) {
      this.isTestnet = isTestnet;
      this.url = isTestnet
        ? 'wss://stream-testnet.bybit.com/v5/public/linear'
        : 'wss://stream.bybit.com/v5/public/linear';
      this.reconnect();
    }
  }

  public onTicker(cb: TickerCallback): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  public connect(): void {
    if (this.isDestroyed) return;
    // Test/offline mode: never open the public Bybit market stream.
    if (process.env.TRADEBOT_OFFLINE === '1') return;
    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.isConnected = true;
        this.startHeartbeat();
        this.resubscribe();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.op === 'pong') return;

          if (msg.topic && msg.topic.startsWith('tickers.') && msg.data) {
            const tickerData = msg.data;
            const symbol = tickerData.symbol;
            if (!symbol) return;

            const update: Partial<SymbolMarketInfo> = {
              symbol,
              lastPrice: tickerData.lastPrice ? parseFloat(tickerData.lastPrice) : undefined,
              price24hPcnt: tickerData.price24hPcnt ? parseFloat(tickerData.price24hPcnt) * 100 : undefined,
              highPrice24h: tickerData.highPrice24h ? parseFloat(tickerData.highPrice24h) : undefined,
              lowPrice24h: tickerData.lowPrice24h ? parseFloat(tickerData.lowPrice24h) : undefined,
              volume24h: tickerData.volume24h ? parseFloat(tickerData.volume24h) : undefined,
            };

            for (const cb of this.listeners) {
              cb(symbol, update);
            }
          }
        } catch {
          // ignore malformed ws messages
        }
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        this.cleanupHeartbeat();
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error('[Bybit WS] Error:', err.message);
        this.ws?.close();
      });
    } catch (err) {
      console.error('[Bybit WS] Connect exception:', err);
      this.scheduleReconnect();
    }
  }

  private startHeartbeat(): void {
    this.cleanupHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, 20000);
  }

  private cleanupHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.isDestroyed || this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, 4000);
  }

  private reconnect(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.connect();
  }

  public subscribe(symbol: string): void {
    this.subscribedSymbols.add(symbol);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          op: 'subscribe',
          args: [`tickers.${symbol}`],
        })
      );
    }
  }

  public subscribeMultiple(symbols: string[]): void {
    for (const s of symbols) {
      this.subscribedSymbols.add(s);
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN && symbols.length > 0) {
      this.ws.send(
        JSON.stringify({
          op: 'subscribe',
          args: symbols.map((s) => `tickers.${s}`),
        })
      );
    }
  }

  public unsubscribe(symbol: string): void {
    this.subscribedSymbols.delete(symbol);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          op: 'unsubscribe',
          args: [`tickers.${symbol}`],
        })
      );
    }
  }

  private resubscribe(): void {
    if (this.subscribedSymbols.size > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const args = Array.from(this.subscribedSymbols).map((s) => `tickers.${s}`);
      this.ws.send(JSON.stringify({ op: 'subscribe', args }));
    }
  }

  public getStatus(): boolean {
    return this.isConnected;
  }

  public destroy(): void {
    this.isDestroyed = true;
    this.cleanupHeartbeat();
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.listeners.clear();
  }
}
