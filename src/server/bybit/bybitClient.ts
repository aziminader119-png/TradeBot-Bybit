import crypto from 'crypto';
import { SymbolMarketInfo } from '../../types/trading.ts';

export interface BybitOrderParams {
  category: 'linear';
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit';
  qty: string;
  price?: string;
  positionIdx: 0 | 1 | 2; // 0 = One-Way mode, 1 = Buy (Long in Hedge), 2 = Sell (Short in Hedge)
  reduceOnly?: boolean;
  orderLinkId?: string;
}

export interface BybitWalletResult {
  totalEquity: number;
  availableBalance: number;
  usedMargin: number;
  unrealizedPnl: number;
  accountType: 'UNIFIED' | 'CONTRACT' | string;
  coinList?: Array<{
    coin: string;
    equity: number;
    walletBalance: number;
    availableToWithdraw: number;
    unrealisedPnl: number;
  }>;
}

export interface BybitErrorInfo {
  kind: 'NO_CREDENTIALS' | 'BAD_CREDENTIAL_FORMAT' | 'NETWORK' | 'TIMEOUT' | 'AUTH' | 'FORBIDDEN' | 'RATE_LIMIT' | 'SERVER' | 'HTTP' | 'BAD_RESPONSE' | 'RET_CODE';
  endpoint: string;
  httpStatus?: number;
  retCode?: number;
  retMsg?: string;
  message: string;
  at?: number;
  host?: string;
  bodySnippet?: string; // first characters of a non-JSON error body (e.g. an HTML block page), for diagnosis
}

/** One request as seen on the wire — no key, secret or signature is ever recorded. */
export interface BybitTraceEntry {
  at: number;
  method: 'GET' | 'POST';
  host: string;
  path: string;
  params: string[]; // parameter NAMES only
  signed: boolean;
  signMethod?: 'HMAC_SHA256' | 'RSA_SHA256';
  timestampSent?: string;
  recvWindow?: string;
  clockOffsetMs: number;
  durationMs: number;
  httpStatus?: number;
  retCode?: number;
  retMsg?: string;
  server?: string; // response 'server' header (e.g. CloudFront) — shows who answered
  outcome: 'OK' | 'RET_CODE' | 'HTTP_ERROR' | 'NETWORK' | 'TIMEOUT' | 'NOT_SENT';
  note?: string;
}

/**
 * Official Bybit V5 REST hosts per account entity (Bybit "Integration Guidance"). A key only works on the
 * host of the Bybit entity it was created on. Only these hosts can be selected; no arbitrary host is accepted.
 */
export const BYBIT_REST_HOSTS: Record<string, string> = {
  'api.bybit.com': 'Bybit Global (mainnet)',
  'api.bybit.eu': 'Bybit EU / EEA',
  'api.bybit.tr': 'Bybit Turkey',
  'api.bybit.kz': 'Bybit Kazakhstan',
  'api.bybitgeorgia.ge': 'Bybit Georgia',
  'api.bybit.ae': 'Bybit UAE',
  'api.bybit.id': 'Bybit Indonesia',
  'api.manepa.jp': 'Bybit Japan',
  'api.spark-fintech.com': 'Bybit Hong Kong',
};
export const BYBIT_TESTNET_HOST = 'api-testnet.bybit.com';

const INVISIBLE = /[\s\u00A0\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
/** Remove whitespace and invisible / bidi marks that copy-paste (e.g. from an RTL page) can add. */
export function cleanCredential(v: string | undefined | null): { value: string; removed: number } {
  const raw = String(v ?? '');
  const isPem = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw);
  if (isPem) {
    // keep PEM line structure; drop only invisible marks
    const value = raw.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '').trim();
    return { value, removed: raw.length - value.length - (raw.length - raw.trim().length) };
  }
  const value = raw.replace(INVISIBLE, '');
  return { value, removed: raw.length - value.length };
}

/**
 * Blocking credential problems, described WITHOUT revealing any character of the key or secret.
 * Only what cannot be sent/signed is blocking: characters outside printable ASCII (e.g. Persian/Arabic
 * digits or letters from a keyboard layout) would make the HTTP header invalid or the signature wrong.
 */
export function credentialProblems(apiKey: string, apiSecret: string): string[] {
  const out: string[] = [];
  const badCount = (v: string) => [...v].filter((c) => !/[\x21-\x7E]/.test(c)).length;
  if (apiKey && badCount(apiKey)) out.push(`API key contains ${badCount(apiKey)} non-ASCII character(s) (length ${apiKey.length})`);
  const pem = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(apiSecret);
  if (apiSecret && !pem && badCount(apiSecret)) out.push(`API secret contains ${badCount(apiSecret)} non-ASCII character(s) (length ${apiSecret.length})`);
  if (pem) { try { crypto.createPrivateKey(apiSecret); } catch { out.push('API secret looks like an RSA private key (PEM) but could not be parsed'); } }
  return out;
}

function bybitError(info: BybitErrorInfo): Error {
  const err: any = new Error(info.message);
  err.bybit = { ...info, at: Date.now() };
  if (info.retCode !== undefined) err.retCode = info.retCode;
  return err;
}

function retError(res: { retCode: number; retMsg: string }, endpoint: string): Error {
  return bybitError({ kind: 'RET_CODE', endpoint, httpStatus: 200, retCode: res.retCode, retMsg: res.retMsg, message: `${endpoint}: ${BybitClient.translateBybitError(res.retCode, res.retMsg)}` });
}

export class BybitClient {
  private baseUrl: string;
  private host: string;
  private apiKey: string;
  private apiSecret: string;
  // Bybit: timestamp must satisfy server_time - recv_window <= timestamp < server_time + 1000.
  // 10 s tolerates slow links; the clock is synced from Bybit server time.
  private recvWindow: string = '10000';
  public credentialNotes: string[] = [];
  private trace: BybitTraceEntry[] = [];

  constructor(apiKey: string = '', apiSecret: string = '', isTestnet: boolean = false, host?: string) {
    this.apiKey = '';
    this.apiSecret = '';
    this.host = BYBIT_TESTNET_HOST;
    this.baseUrl = '';
    this.updateCredentials(apiKey, apiSecret, isTestnet, host);
  }

  public static resolveHost(isTestnet: boolean, host?: string): string {
    if (isTestnet) return BYBIT_TESTNET_HOST;
    return host && BYBIT_REST_HOSTS[host] ? host : 'api.bybit.com';
  }

  public updateCredentials(apiKey: string, apiSecret: string, isTestnet: boolean, host?: string): void {
    const k = cleanCredential(apiKey), sct = cleanCredential(apiSecret);
    this.apiKey = k.value;
    this.apiSecret = sct.value;
    this.credentialNotes = [];
    if (k.removed) this.credentialNotes.push(`Removed ${k.removed} space/invisible character(s) from the API key`);
    if (sct.removed) this.credentialNotes.push(`Removed ${sct.removed} space/invisible character(s) from the API secret`);
    this.host = BybitClient.resolveHost(isTestnet, host);
    this.baseUrl = `https://${this.host}`;
  }

  public getHost(): string { return this.host; }
  public getSignMethod(): 'HMAC_SHA256' | 'RSA_SHA256' { return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(this.apiSecret) ? 'RSA_SHA256' : 'HMAC_SHA256'; }
  /** Last requests (newest first). Contains no key, secret or signature. */
  public getTrace(): BybitTraceEntry[] { return [...this.trace]; }
  private pushTrace(t: BybitTraceEntry) { this.trace.unshift(t); if (this.trace.length > 30) this.trace.length = 30; }

  // Bybit V5: sign timestamp + apiKey + recvWindow + (GET: queryString | POST: raw JSON body).
  // System-generated keys: HMAC_SHA256 (hex). Self-generated keys: RSA_SHA256 (base64).
  private generateSignature(timestamp: string, queryString: string, bodyString: string): string {
    if (!this.apiSecret) return '';
    const payload = `${timestamp}${this.apiKey}${this.recvWindow}${queryString || bodyString}`;
    if (this.getSignMethod() === 'RSA_SHA256') {
      return crypto.sign('sha256', Buffer.from(payload), crypto.createPrivateKey(this.apiSecret)).toString('base64');
    }
    return crypto.createHmac('sha256', this.apiSecret).update(payload).digest('hex');
  }

  // ---- Phase 4: clock offset, read-only lock, honest error reporting ----
  private timeOffsetMs = 0;
  private tradingEnabled = false; // read-only until the owner arms live trading (PIN) in this process
  public lastError: BybitErrorInfo | null = null;

  /** Hard read-only lock at the client level: no order / leverage / mode / TP call while false. */
  public setTradingEnabled(on: boolean): void {
    this.tradingEnabled = on;
  }

  public isTradingEnabled(): boolean {
    return this.tradingEnabled;
  }

  private assertTrading(what: string): void {
    if (!this.tradingEnabled) {
      const err: any = new Error(`READ-ONLY: ${what} was not sent. Live trading is not armed.`);
      err.readOnly = true;
      throw err;
    }
  }

  /**
   * Align request timestamps with Bybit server time. Bybit accepts a signed request only when
   *   server_time - recv_window <= timestamp < server_time + 1000,
   * i.e. a timestamp may lag by up to recv_window (10 s) but may lead by less than 1 s.
   * Bybit stamped `serverMs` somewhere between t0 and t1 on our clock, so the true offset lies in
   * [serverMs - t1, serverMs - t0]. The old midpoint estimate assumed the delay was symmetric; a slow connection
   * set-up or event-loop stall before the request left (common on a busy host) puts the midpoint too far ahead,
   * e.g. a 4.8 s stall gave timestamps ~2.4 s ahead -> retCode 10002. The lower bound can never place our
   * timestamps ahead of Bybit; its worst-case lag is the round trip, well inside recv_window. A sample whose
   * round trip exceeds MAX_SYNC_RTT_MS is an invalid sample: up to SYNC_ATTEMPTS samples are taken and the best
   * valid one is used. If none is valid, the current offset is kept (0 = the host's NTP clock on a first sync)
   * and the next periodic sync tries again; a slow sample can therefore never shift timestamps by more than
   * MAX_SYNC_RTT_MS (half of recv_window).
   */
  public async syncTime(): Promise<{ offsetMs: number; serverTime: number }> {
    let best: { offset: number; rtt: number } | null = null, serverTime = 0;
    for (let attempt = 0; attempt < BybitClient.SYNC_ATTEMPTS; attempt++) {
      const t0 = Date.now();
      const res = await this.request('GET', '/v5/market/time', {}, false);
      const t1 = Date.now();
      const serverMs = res.result?.timeNano ? Math.floor(Number(res.result.timeNano) / 1e6) : Number(res.result?.timeSecond || 0) * 1000;
      if (!(serverMs > 0)) continue;
      serverTime = serverMs;
      const rtt = t1 - t0;
      if (!best || rtt < best.rtt) best = { offset: Math.round(serverMs - t1), rtt };
      if (rtt <= BybitClient.MAX_SYNC_RTT_MS) break;
    }
    if (best && best.rtt <= BybitClient.MAX_SYNC_RTT_MS) {
      this.timeOffsetMs = best.offset;
      this.timeSynced = true;
    }
    return { offsetMs: this.timeOffsetMs, serverTime };
  }
  private static readonly MAX_SYNC_RTT_MS = 5000;
  private static readonly SYNC_ATTEMPTS = 3;
  private timeSynced = false;

  public getTimeOffsetMs(): number {
    return this.timeOffsetMs;
  }

  private async request<T = any>(
    method: 'GET' | 'POST',
    endpoint: string,
    params: Record<string, any> = {},
    requiresAuth: boolean = false
  ): Promise<{ retCode: number; retMsg: string; result: T; time: number }> {
    const timestamp = (Date.now() + this.timeOffsetMs).toString();
    let url = `${this.baseUrl}${endpoint}`;
    let queryString = '';
    let bodyString = '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (method === 'GET') {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) searchParams.append(key, String(value));
      }
      queryString = searchParams.toString();
      if (queryString) url += `?${queryString}`;
    } else {
      bodyString = JSON.stringify(params);
    }

    const t: BybitTraceEntry = {
      at: Date.now(), method, host: this.host, path: endpoint, params: Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== null),
      signed: requiresAuth, clockOffsetMs: this.timeOffsetMs, durationMs: 0, outcome: 'NOT_SENT',
    };
    const fail = (info: BybitErrorInfo): never => {
      t.outcome = info.kind === 'TIMEOUT' ? 'TIMEOUT' : info.kind === 'NETWORK' ? 'NETWORK' : info.httpStatus ? 'HTTP_ERROR' : 'NOT_SENT';
      t.httpStatus = info.httpStatus; t.retCode = info.retCode; t.retMsg = info.retMsg; t.note = info.message;
      t.durationMs = Date.now() - t.at;
      this.pushTrace(t);
      const err = bybitError({ ...info, host: this.host });
      this.lastError = (err as any).bybit;
      throw err;
    };

    if (requiresAuth) {
      if (!this.apiKey || !this.apiSecret) fail({ kind: 'NO_CREDENTIALS', endpoint, message: 'Bybit API key or secret not configured' });
      const problems = credentialProblems(this.apiKey, this.apiSecret);
      if (problems.length) fail({ kind: 'BAD_CREDENTIAL_FORMAT', endpoint, message: `Not sent: ${problems.join('; ')}. Re-copy the key/secret from Bybit.` });
      headers['X-BAPI-API-KEY'] = this.apiKey;
      headers['X-BAPI-TIMESTAMP'] = timestamp;
      headers['X-BAPI-RECV-WINDOW'] = this.recvWindow;
      t.signMethod = this.getSignMethod();
      t.timestampSent = timestamp;
      t.recvWindow = this.recvWindow;
      try {
        headers['X-BAPI-SIGN'] = this.generateSignature(timestamp, queryString, bodyString);
      } catch (e: any) {
        fail({ kind: 'BAD_CREDENTIAL_FORMAT', endpoint, message: `Not sent: could not sign the request (${e.message})` });
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      let response!: Response;
      try {
        response = await fetch(url, { method, headers, body: method === 'POST' ? bodyString : undefined, signal: controller.signal });
      } catch (e: any) {
        if (e.name === 'AbortError') fail({ kind: 'TIMEOUT', endpoint, message: `No response from ${this.host} within 10 s (${endpoint})` });
        const cause = e.cause?.code || e.cause?.message || e.message;
        fail({ kind: 'NETWORK', endpoint, message: `No HTTP response from ${this.host} (${cause}) on ${endpoint}. The request did not reach Bybit (DNS, connection or TLS failure on this machine's network).` });
      }
      const text = await response.text();
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      t.httpStatus = response.status;
      t.server = response.headers?.get?.('server') || undefined;
      const snippet = !data && text ? text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : undefined;

      if (!response.ok) {
        // Report exactly what came back; never guess an API-key IP problem from an HTTP status.
        const retCode = data?.retCode;
        const retMsg = data?.retMsg;
        let kind: BybitErrorInfo['kind'] = 'HTTP';
        let message = `HTTP ${response.status} from ${this.host} on ${endpoint}${retMsg !== undefined ? ` — Bybit retCode ${retCode}: ${retMsg}` : ' (no Bybit API response body)'}${t.server ? ` · server: ${t.server}` : ''}${snippet ? ` · body: "${snippet}"` : ''}`;
        if (response.status === 401) kind = 'AUTH';
        else if (response.status === 403 && !data) {
          kind = 'FORBIDDEN';
          message += '. The request was refused before reaching the Bybit API (edge/CDN level). This is not an API-key setting.';
        } else if (response.status === 429) kind = 'RATE_LIMIT';
        else if (response.status >= 500) kind = 'SERVER';
        fail({ kind, endpoint, httpStatus: response.status, retCode, retMsg, message, bodySnippet: snippet });
      }
      if (!data) fail({ kind: 'BAD_RESPONSE', endpoint, httpStatus: response.status, bodySnippet: snippet, message: `HTTP ${response.status} from ${this.host} on ${endpoint} but the body is not Bybit JSON${snippet ? `: "${snippet}"` : ''}` });
      t.retCode = data.retCode; t.retMsg = data.retMsg;
      t.outcome = data.retCode === 0 ? 'OK' : 'RET_CODE';
      t.durationMs = Date.now() - t.at;
      this.pushTrace(t);
      return data; // retCode != 0 is returned to the caller unchanged
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Read-only: describe the API key (permissions, read-only flag, IP binding, expiry). */
  public async getApiKeyInfo(): Promise<{ readOnly: boolean; permissions: Record<string, string[]>; ips: string[]; ipBound: boolean; expiresAt: string | null; uta: boolean | null }> {
    const res = await this.request('GET', '/v5/user/query-api', {}, true);
    if (res.retCode !== 0) throw retError(res, '/v5/user/query-api');
    const r: any = res.result || {};
    const ips: string[] = Array.isArray(r.ips) ? r.ips : [];
    return {
      readOnly: Number(r.readOnly) === 1,
      permissions: r.permissions || {},
      ips,
      ipBound: ips.length > 0 && !(ips.length === 1 && ips[0] === '*'),
      expiresAt: r.expiredAt || null,
      uta: r.uta === undefined ? null : Number(r.uta) === 1,
    };
  }

  /** Read-only: account margin mode (REGULAR_MARGIN = cross, ISOLATED_MARGIN, PORTFOLIO_MARGIN). */
  public async getAccountInfo(): Promise<{ marginMode: string | null; unifiedMarginStatus: number | null }> {
    const res = await this.request('GET', '/v5/account/info', {}, true);
    if (res.retCode !== 0) throw retError(res, '/v5/account/info');
    return { marginMode: res.result?.marginMode ?? null, unifiedMarginStatus: res.result?.unifiedMarginStatus ?? null };
  }

  /**
   * Read-only: total funding settled for `symbol` between `startTime` and `endTime` (unified account
   * transaction log, type SETTLEMENT). Bybit sign is kept: negative = paid, positive = received.
   * Bybit serves at most 7 days per query, so the range is walked in 7-day windows; rows are de-duplicated
   * by id so window edges never count a settlement twice. Any failure, unreadable row or truncated
   * result throws — the caller must treat funding as unknown, never as 0.
   */
  public async getFundingSince(symbol: string, startTime: number, endTime: number = Date.now() + this.timeOffsetMs): Promise<number> {
    const WINDOW = 7 * 24 * 60 * 60 * 1000;
    const MAX_PAGES = 50;
    const seen = new Set<string>();
    let total = 0;
    for (let from = startTime; from < endTime; from += WINDOW) {
      const to = Math.min(from + WINDOW - 1, endTime);
      let cursor: string | undefined;
      let page = 0;
      for (;;) {
        const params: Record<string, any> = { accountType: 'UNIFIED', category: 'linear', currency: 'USDT', type: 'SETTLEMENT', startTime: from, endTime: to, limit: 50 };
        if (cursor) params.cursor = cursor;
        const res = await this.request('GET', '/v5/account/transaction-log', params, true);
        if (res.retCode !== 0) throw retError(res, '/v5/account/transaction-log');
        for (const row of res.result?.list || []) {
          if (row.symbol !== symbol) continue;
          const key = String(row.id || `${row.transactionTime}|${row.side}|${row.funding}`);
          if (seen.has(key)) continue;
          seen.add(key);
          const v = Number(row.funding);
          if (row.funding === undefined || row.funding === '' || !Number.isFinite(v)) {
            throw new Error(`Bybit transaction-log row ${key} for ${symbol} has no readable funding value`);
          }
          total += v;
        }
        cursor = res.result?.nextPageCursor || undefined;
        if (!cursor) break;
        if (++page >= MAX_PAGES) throw new Error(`Funding history for ${symbol} exceeds ${MAX_PAGES} pages in one 7-day window; total not computed`);
      }
    }
    return total;
  }

  // 1. Market Instruments Info
  public async getInstrumentsInfo(symbol?: string): Promise<Record<string, SymbolMarketInfo>> {
    // Phase 6: every USDT perpetual that is Trading (paginated; dated futures excluded). Errors are thrown.
    const result: Record<string, SymbolMarketInfo> = {};
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const params: Record<string, any> = { category: 'linear', limit: 1000 };
      if (symbol) params.symbol = symbol;
      if (cursor) params.cursor = cursor;
      const res = await this.request('GET', '/v5/market/instruments-info', params, false);
      if (res.retCode !== 0) throw retError(res, '/v5/market/instruments-info');
      for (const item of res.result?.list || []) {
        if (item.quoteCoin !== 'USDT' || item.status !== 'Trading') continue;
        if (item.contractType && item.contractType !== 'LinearPerpetual') continue;
        // fields Bybit did not return: the defaults below are kept for compatibility, but these rules are NOT verified
        const lf = item.lotSizeFilter || {}, levf = item.leverageFilter || {};
        const missingRules = ([['qtyStep', lf.qtyStep], ['minOrderQty', lf.minOrderQty], ['minNotionalValue', lf.minNotionalValue], ['maxLeverage', levf.maxLeverage]] as [string, any][])
          .filter(([, v]) => !(parseFloat(v) > 0)).map(([k]) => k);
        result[item.symbol] = {
          symbol: item.symbol,
          missingRules,
          lastPrice: 0,
          price24hPcnt: 0,
          highPrice24h: 0,
          lowPrice24h: 0,
          volume24h: 0,
          tickSize: parseFloat(item.priceFilter?.tickSize || '0.01'),
          qtyStep: parseFloat(item.lotSizeFilter?.qtyStep || '0.001'),
          minQty: parseFloat(item.lotSizeFilter?.minOrderQty || '0.001'),
          maxQty: parseFloat(item.lotSizeFilter?.maxMktOrderQty || item.lotSizeFilter?.maxOrderQty || '1000000'),
          minNotional: parseFloat(item.lotSizeFilter?.minNotionalValue || '5.0'),
          maxLeverage: parseFloat(item.leverageFilter?.maxLeverage || '50'),
        };
      }
      cursor = res.result?.nextPageCursor || undefined;
      if (!cursor) break;
    }
    return result;
  }

  // 2. Tickers
  public async getTickers(symbol?: string): Promise<Record<string, Partial<SymbolMarketInfo>>> {
    const params: Record<string, any> = { category: 'linear' };
    if (symbol) params.symbol = symbol;

    const res = await this.request('GET', '/v5/market/tickers', params, false);
    const result: Record<string, Partial<SymbolMarketInfo>> = {};

    if (res.retCode === 0 && res.result?.list) {
      for (const item of res.result.list) {
        const lastP = parseFloat(item.lastPrice || '0');
        const prev1h = parseFloat(item.prevPrice1h || '0');
        const p1h = prev1h > 0 && lastP > 0 ? ((lastP - prev1h) / prev1h) * 100 : undefined;
        const funding = item.fundingRate ? parseFloat(item.fundingRate) * 100 : 0;

        result[item.symbol] = {
          symbol: item.symbol,
          lastPrice: lastP,
          price24hPcnt: parseFloat(item.price24hPcnt || '0') * 100,
          price1hPcnt: p1h,
          highPrice24h: parseFloat(item.highPrice24h || '0'),
          lowPrice24h: parseFloat(item.lowPrice24h || '0'),
          volume24h: parseFloat(item.volume24h || '0'),
          turnover24h: parseFloat(item.turnover24h || '0'),
          fundingRate: funding,
        };
      }
    }
    return result;
  }

  /** Phase 4: public market candles (no API key, read-only). Returns oldest-first OHLC. */
  public async getKlines(symbol: string, interval: string, limit = 120): Promise<{ t: number; o: number; h: number; l: number; c: number; v: number }[]> {
    const res = await this.request('GET', '/v5/market/kline', { category: 'linear', symbol, interval, limit: String(limit) }, false);
    if (res.retCode !== 0) throw retError(res, '/v5/market/kline');
    return (res.result?.list || []).map((k: string[]) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
  }

  /** Exact exchange fields for the manual Futures workspace; no compatibility defaults. */
  public async getFuturesContract(symbol:string){
    const res=await this.request('GET','/v5/market/instruments-info',{category:'linear',symbol},false);
    if(res.retCode!==0)throw retError(res,'/v5/market/instruments-info');
    const raw=(res.result?.list||[]).find((i:any)=>i.symbol===symbol&&i.quoteCoin==='USDT'&&i.status==='Trading'&&i.contractType==='LinearPerpetual');
    if(!raw)throw Error('Not a trading USDT perpetual contract');
    const n=(v:unknown)=>{const x=Number(v);return Number.isFinite(x)&&x>0?x:null;};
    return {symbol,contractType:raw.contractType,settleCoin:raw.settleCoin||null,tickSize:n(raw.priceFilter?.tickSize),qtyStep:n(raw.lotSizeFilter?.qtyStep),minQty:n(raw.lotSizeFilter?.minOrderQty),maxMarketQty:n(raw.lotSizeFilter?.maxMktOrderQty),minNotional:n(raw.lotSizeFilter?.minNotionalValue),maxLeverage:n(raw.leverageFilter?.maxLeverage),fundingInterval:n(raw.fundingInterval)};
  }

  /** Read-only Futures chart history. Separate from the strategy price feed. */
  public async getFuturesHistory(symbol:string,interval:string,limit=500,start?:number,end?:number):Promise<{time:number;open:number;high:number;low:number;close:number;volume:number}[]>{
    const params:Record<string,string>={category:'linear',symbol,interval,limit:String(Math.min(1000,Math.max(1,limit)))};
    if(start!==undefined)params.start=String(start);if(end!==undefined)params.end=String(end);
    const res=await this.request('GET','/v5/market/kline',params,false);
    if(res.retCode!==0)throw retError(res,'/v5/market/kline');
    const rows=(res.result?.list||[]).map((k:string[])=>({time:+k[0]/1000,open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]}))
      .filter((b:any)=>[b.time,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)&&b.time>0&&b.open>0&&b.close>0&&b.low>0&&b.high>=b.low&&b.volume>=0).sort((a:any,b:any)=>a.time-b.time);
    return rows.filter((b:any,i:number)=>!i||b.time!==rows[i-1].time);
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  // Always includes Bybit's own retCode and retMsg so the owner sees the real exchange error.
  public static translateBybitError(retCode: number, retMsg: string): string {
    const raw = `Bybit retCode ${retCode}: ${retMsg || 'no message'}`;
    const hint: Record<number, string> = {
      10002: 'request time outside recv_window — the app re-syncs its clock with Bybit; check this machine\'s clock',
      10003: 'Bybit does not know this key on this host: wrong or deleted key, mainnet/testnet mismatch, or the key belongs to another Bybit entity (EU, Turkey, Kazakhstan, Georgia, UAE, Indonesia, Japan, Hong Kong) whose own API host must be selected',
      10004: 'signature rejected — the secret does not match this key (check it was copied completely; self-generated RSA keys need the PEM private key)',
      10005: 'the key lacks a permission needed for this request',
      10006: 'rate limit reached',
      10010: 'Bybit reports the request IP does not match the IP addresses bound to this key. This comes from the key\'s own settings on Bybit; the app has no IP requirement',
      33004: 'API key expired',
    };
    return hint[retCode] ? `${raw} — ${hint[retCode]}` : raw;
  }

  // 3. Read-only connection test: public time, then (if keys exist) key info, wallet and margin mode.
  // Nothing here can change anything on the account.
  public async testConnection(): Promise<{
    success: boolean;
    latencyMs: number;
    message: string;
    wallet?: BybitWalletResult;
    keyInfo?: Awaited<ReturnType<BybitClient['getApiKeyInfo']>>;
    marginMode?: string | null;
    timeOffsetMs?: number;
    errorCode?: number;
    error?: BybitErrorInfo;
  }> {
    const start = Date.now();
    const fail = (stage: string, err: any) => {
      const info: BybitErrorInfo = err.bybit || { kind: 'RET_CODE', endpoint: stage, message: err.message, retCode: err.retCode };
      return { success: false, latencyMs: Date.now() - start, message: `${stage}: ${info.message}`, errorCode: info.retCode, error: info };
    };
    let latencyMs = 0;
    try {
      await this.syncTime();
      latencyMs = Date.now() - start;
    } catch (err: any) {
      return fail('Public API (server time)', err);
    }
    if (!this.apiKey || !this.apiSecret) {
      return { success: true, latencyMs, timeOffsetMs: this.timeOffsetMs, message: `Bybit public API reachable (${latencyMs} ms). No API key configured.` };
    }
    let keyInfo: Awaited<ReturnType<BybitClient['getApiKeyInfo']>>;
    try { keyInfo = await this.getApiKeyInfo(); } catch (err: any) { return fail('API key check', err); }
    let wallet: BybitWalletResult;
    try { wallet = await this.getWalletBalance(); } catch (err: any) { return fail('Wallet', err); }
    let marginMode: string | null = null;
    try { marginMode = (await this.getAccountInfo()).marginMode; } catch { marginMode = null; }
    return {
      success: true, latencyMs, wallet, keyInfo, marginMode, timeOffsetMs: this.timeOffsetMs,
      message: `Connected (${latencyMs} ms). Key: ${keyInfo.readOnly ? 'read-only' : 'read-write'}, IP binding: ${keyInfo.ipBound ? keyInfo.ips.join(', ') : 'none'}. Account ${wallet.accountType}, equity ${wallet.totalEquity.toFixed(2)} USDT.`,
    };
  }

  // 4. Wallet Balance (Supports both UNIFIED and Classic CONTRACT accounts)
  public async getWalletBalance(): Promise<BybitWalletResult> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('API key and secret not configured');
    }

    // Try 1: UNIFIED Trading Account (UTA)
    let res = await this.request('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }, true);

    if (res.retCode === 0 && res.result?.list?.[0]) {
      const acc = res.result.list[0];
      const coinList = (acc.coin || []).map((c: any) => ({
        coin: c.coin,
        equity: parseFloat(c.equity || '0'),
        walletBalance: parseFloat(c.walletBalance || '0'),
        availableToWithdraw: parseFloat(c.availableToWithdraw || '0'),
        unrealisedPnl: parseFloat(c.unrealisedPnl || '0'),
      }));
      const usdtCoin = coinList.find((c: any) => c.coin === 'USDT') || coinList[0];

      let totalEquity = parseFloat(acc.totalEquity || '0');
      if (!totalEquity && usdtCoin) {
        totalEquity = usdtCoin.equity || usdtCoin.walletBalance || 0;
      }

      let availableBalance = parseFloat(acc.totalAvailableBalance || acc.totalWalletBalance || '0');
      if (!availableBalance && usdtCoin) {
        availableBalance = usdtCoin.availableToWithdraw || usdtCoin.walletBalance || 0;
      }

      let usedMargin = parseFloat(acc.totalInitialMargin || acc.totalPositionIM || '0');
      if (!usedMargin && totalEquity > availableBalance) {
        usedMargin = totalEquity - availableBalance;
      }

      const unrealizedPnl = parseFloat(acc.totalPerpUPL || (usdtCoin ? String(usdtCoin.unrealisedPnl) : '0'));

      return {
        totalEquity: Math.round(totalEquity * 1000) / 1000,
        availableBalance: Math.round(availableBalance * 1000) / 1000,
        usedMargin: Math.round(usedMargin * 1000) / 1000,
        unrealizedPnl: Math.round(unrealizedPnl * 1000) / 1000,
        accountType: acc.accountType || 'UNIFIED',
        coinList,
      };
    }

    // If error was directly an authentication error (10003 invalid api_key, 10004 invalid sign, 10005 perm, 10010 ip), fail immediately with exact retCode
    const isAccountTypeError = res.retCode === 10001 || res.retCode === 10002 || (res.retMsg && res.retMsg.toLowerCase().includes('accounttype'));
    if (!isAccountTypeError && res.retCode !== 0) {
      throw retError(res, '/v5/account/wallet-balance');
    }

    // Try 2: Classic Derivatives Account (CONTRACT)
    const errCode = res.retCode;
    const resContract = await this.request('GET', '/v5/account/wallet-balance', { accountType: 'CONTRACT' }, true);
    if (resContract.retCode === 0 && resContract.result?.list?.[0]) {
      const acc = resContract.result.list[0];
      const coinList = (acc.coin || []).map((c: any) => ({
        coin: c.coin,
        equity: parseFloat(c.equity || '0'),
        walletBalance: parseFloat(c.walletBalance || '0'),
        availableToWithdraw: parseFloat(c.availableToWithdraw || '0'),
        unrealisedPnl: parseFloat(c.unrealisedPnl || '0'),
      }));
      const usdtCoin = coinList.find((c: any) => c.coin === 'USDT') || coinList[0];

      const totalEquity = parseFloat(acc.totalEquity || '0') || (usdtCoin?.equity || usdtCoin?.walletBalance || 0);
      const availableBalance = parseFloat(acc.totalAvailableBalance || acc.totalWalletBalance || '0') || (usdtCoin?.availableToWithdraw || usdtCoin?.walletBalance || 0);
      const usedMargin = parseFloat(acc.totalInitialMargin || '0') || (totalEquity > availableBalance ? totalEquity - availableBalance : 0);
      const unrealizedPnl = parseFloat(acc.totalPerpUPL || (usdtCoin ? String(usdtCoin.unrealisedPnl) : '0'));

      return {
        totalEquity: Math.round(totalEquity * 1000) / 1000,
        availableBalance: Math.round(availableBalance * 1000) / 1000,
        usedMargin: Math.round(usedMargin * 1000) / 1000,
        unrealizedPnl: Math.round(unrealizedPnl * 1000) / 1000,
        accountType: 'CONTRACT',
        coinList,
      };
    }

    // If both failed, construct descriptive error
    const failedCode = resContract.retCode !== 0 ? resContract.retCode : errCode;
    const failedMsg = resContract.retMsg || res.retMsg || 'Failed to fetch wallet balance';
    throw retError({ retCode: failedCode, retMsg: failedMsg }, '/v5/account/wallet-balance');
  }

  // 5. Positions List (all pages; Bybit returns 20 per page by default)
  public async getPositions(symbol?: string): Promise<any[]> {
    const all: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const params: Record<string, any> = { category: 'linear', settleCoin: 'USDT', limit: 200 };
      if (symbol) params.symbol = symbol;
      if (cursor) params.cursor = cursor;
      const res = await this.request('GET', '/v5/position/list', params, true);
      if (res.retCode !== 0) {
        console.warn(`[BybitClient] getPositions failed with retCode ${res.retCode}: ${res.retMsg}`);
        const err: any = new Error(BybitClient.translateBybitError(res.retCode, res.retMsg));
        err.retCode = res.retCode;
        throw err;
      }
      const list = res.result?.list;
      if (!Array.isArray(list)) {
        throw new Error('Bybit position list response is missing result.list');
      }
      all.push(...list);
      cursor = res.result?.nextPageCursor;
      if (!cursor) {
        // a row repeated across pages (list shifting while paging) is one position: keep its first copy
        const seen = new Set<string>();
        return all.filter((p) => { const k = `${p?.symbol}|${p?.positionIdx}|${p?.side}`; if (seen.has(k)) return false; seen.add(k); return true; });
      }
    }
    throw new Error('Bybit position list exceeded 50 pages; refusing to treat a partial list as complete');
  }

  // 5b. Closed P&L History
  public async getClosedPnl(symbol?: string, limit: number = 50): Promise<any[]> {
    const params: Record<string, any> = { category: 'linear', limit };
    if (symbol) params.symbol = symbol;
    try {
      const res = await this.request('GET', '/v5/position/closed-pnl', params, true);
      if (res.retCode === 0 && res.result?.list) {
        return res.result.list;
      }
    } catch (err: any) {
      console.warn('[BybitClient] getClosedPnl warning:', err.message);
    }
    return [];
  }

  /** Phase 6: closed-position history straight from Bybit (read-only). Errors are thrown, never hidden. */
  public async getClosedPnlPage(opts: { symbol?: string; startTime?: number; endTime?: number; limit?: number; cursor?: string }): Promise<{ list: any[]; nextPageCursor?: string }> {
    const params: Record<string, any> = { category: 'linear', limit: opts.limit ?? 100 };
    if (opts.symbol) params.symbol = opts.symbol;
    if (opts.startTime) params.startTime = opts.startTime;
    if (opts.endTime) params.endTime = opts.endTime;
    if (opts.cursor) params.cursor = opts.cursor;
    const res = await this.request('GET', '/v5/position/closed-pnl', params, true);
    if (res.retCode !== 0) throw retError(res, '/v5/position/closed-pnl');
    return { list: res.result?.list || [], nextPageCursor: res.result?.nextPageCursor || undefined };
  }

  // 6. Set Leverage
  /**
   * Phase 6: set Buy and Sell leverage of a symbol (hedge mode). Returns Bybit's own error text on failure.
   * retCode 110043 = "leverage not modified" (already set) counts as success.
   */
  public async setLeverage(symbol: string, buyLeverage: number, sellLeverage: number = buyLeverage): Promise<{ ok: boolean; error?: string }> {
    this.assertTrading('set-leverage');
    try {
      const res = await this.request('POST', '/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: String(buyLeverage), sellLeverage: String(sellLeverage) }, true);
      if (res.retCode === 0 || res.retCode === 110043) return { ok: true };
      return { ok: false, error: BybitClient.translateBybitError(res.retCode, res.retMsg) };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  // 7. Switch Position Mode to Hedge (mode 3)
  public async switchHedgeMode(symbol: string): Promise<boolean> {
    this.assertTrading('switch-mode');
    try {
      const res = await this.request(
        'POST',
        '/v5/position/switch-mode',
        {
          category: 'linear',
          symbol,
          mode: 3, // 3: Both Sides (Hedge Mode), 0: Merged Single
        },
        true
      );
      // 110025 means position mode is already hedge mode
      return res.retCode === 0 || res.retCode === 110025;
    } catch {
      return false;
    }
  }

  // 8. Create Order
  public async createOrder(order: BybitOrderParams): Promise<{ orderId: string; orderLinkId: string }> {
    this.assertTrading('order');
    const res = await this.request('POST', '/v5/order/create', order, true);
    if (res.retCode === 0 && res.result) {
      return {
        orderId: res.result.orderId,
        orderLinkId: res.result.orderLinkId,
      };
    }

    // Phase 1: no automatic retry of any kind. A rejected order is reported, never resent
    // (the former one-way-mode retry resent orders with positionIdx 0 on generic errors).
    // A Bybit response with a retCode means the order was definitively NOT accepted.
    const rejected: any = new Error(`Bybit Order Error (${res.retCode}): ${res.retMsg}`);
    rejected.retCode = res.retCode;
    rejected.rejected = true;
    throw rejected;
  }

  // 8b. Look up one order by its orderLinkId (open/recent first, then history).
  // Returns null when Bybit has no such order.
  public async getOrderByLinkId(symbol: string, orderLinkId: string): Promise<null | {
    orderId: string; orderStatus: string; qty: number; cumExecQty: number; avgPrice: number; cumExecFee: number; rejectReason?: string;
  }> {
    for (const endpoint of ['/v5/order/realtime', '/v5/order/history']) {
      const res = await this.request('GET', endpoint, { category: 'linear', symbol, orderLinkId }, true);
      if (res.retCode !== 0) {
        const err: any = new Error(`Bybit order lookup failed (${res.retCode}): ${res.retMsg}`);
        err.retCode = res.retCode;
        throw err;
      }
      const o = res.result?.list?.[0];
      if (o) {
        return {
          orderId: o.orderId,
          orderStatus: o.orderStatus,
          qty: parseFloat(o.qty || '0'),
          cumExecQty: parseFloat(o.cumExecQty || '0'),
          avgPrice: parseFloat(o.avgPrice || '0'),
          cumExecFee: parseFloat(o.cumExecFee || '0'),
          rejectReason: o.rejectReason,
        };
      }
    }
    return null;
  }

  // 9. Cancel Order
  public async cancelOrder(symbol: string, orderId: string): Promise<boolean> {
    this.assertTrading('cancel-order');
    const res = await this.request(
      'POST',
      '/v5/order/cancel',
      { category: 'linear', symbol, orderId },
      true
    );
    return res.retCode === 0;
  }

  // Phase 1: setTradingStop (native Bybit TP/SL) was removed. The bot never creates or
  // modifies exchange TP/SL orders; existing Bybit TP orders are left untouched.
}

