interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * China A-shares MCP. Keyless.
 *
 * Live data for the Chinese A-share market (Shanghai / Shenzhen / STAR / ChiNext):
 *  - Daily LIMIT-UP board (涨停板) — how many stocks hit the +10%/+20% daily limit,
 *    and the ranked pool with consecutive-board count (连板), seal fund (封板资金),
 *    industry, turnover. Source: Eastmoney push2ex (JSON, keyless).
 *  - Real-time A-share QUOTES by symbol. Source: Sina hq.sinajs.cn (keyless; names
 *    are GBK-encoded, decoded via TextDecoder).
 *
 * Note: both upstreams are China-hosted; verified reachable, but see egress notes.
 */


const ZT_POOL = 'https://push2ex.eastmoney.com/getTopicZTPool';
const SINA = 'https://hq.sinajs.cn';

// ── helpers ──────────────────────────────────────────────────────────
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
/** Eastmoney encodes limit-up-pool prices as an integer × 1000 (e.g. 24650 → 24.65). */
function price(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.round((n / 1000) * 1e4) / 1e4;
}
/** HHMMSS integer (e.g. 92500) → "09:25:00". */
function hms(v: unknown): string | null {
  const n = num(v);
  if (n == null) return null;
  const s = String(Math.trunc(n)).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}
function latestTradingDate(): string {
  // A-shares trade Mon–Fri; step back over the weekend for a sensible default.
  const d = new Date();
  const day = d.getUTCDay();
  if (day === 0) d.setUTCDate(d.getUTCDate() - 2);
  else if (day === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
/** Map a bare 6-digit code to a Sina symbol (sh/sz/bj prefix). */
function sinaSym(code: string): string {
  const c = code.trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(c)) return c;
  const n = c.replace(/\D/g, '');
  if (/^(6|9)/.test(n)) return `sh${n}`; // Shanghai main + B
  if (/^(0|3)/.test(n)) return `sz${n}`; // Shenzhen main + ChiNext
  if (/^(4|8)/.test(n)) return `bj${n}`; // Beijing exchange
  return `sh${n}`;
}

// ── tools ────────────────────────────────────────────────────────────
const tools: McpToolExport['tools'] = [
  {
    name: 'ashares_limit_up',
    description:
      "The Chinese A-share market's LIMIT-UP board (涨停板) for a trading day — how many stocks hit their daily price limit (+10%, or +20% for STAR/ChiNext) and the ranked list of those stocks. Answers 'how many A-shares hit limit up today', 'top limit-up stocks', 'which stocks 涨停'. Each stock includes code, name, price, change %, turnover (成交额), float market cap, turnover rate (换手率), consecutive-board count (连板数 lbc), first/last seal time, seal fund (封板资金), and industry (行业). Source: Eastmoney (keyless).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Trading day as YYYYMMDD or YYYY-MM-DD (default: most recent trading day).' },
        limit: { type: 'number', description: 'How many stocks to return, 1–100 (default 30). The total count is always returned regardless.' },
      },
    },
  },
  {
    name: 'ashares_quote',
    description:
      'Real-time quote(s) for Chinese A-share stocks by 6-digit code (Shanghai 6xxxxx, Shenzhen 0xxxxx/3xxxxx, STAR 688xxx, ChiNext 30xxxx, Beijing 8xxxxx/4xxxxx). Returns name, current price, change and change %, open, previous close, day high/low, volume, turnover, and the quote timestamp. Accepts one code or a comma-separated list. Example: ashares_quote({ symbols: "600519,000858" }) for Kweichow Moutai and Wuliangye. Source: Sina (keyless).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbols: { type: 'string', description: 'One 6-digit code or a comma-separated list, e.g. "600519" or "600519,000001,300750". sh/sz/bj prefixes are accepted but optional.' },
      },
      required: ['symbols'],
    },
  },
];

// ── handlers ─────────────────────────────────────────────────────────
async function limitUp(args: Record<string, unknown>) {
  const date = (typeof args.date === 'string' && args.date.trim() ? args.date.replace(/-/g, '') : latestTradingDate()).slice(0, 8);
  const want = Math.min(Math.max(Number(args.limit ?? 30), 1), 100);
  const params = new URLSearchParams({
    ut: '7eea3edcaed734bea9cbfc24409ed989',
    dpt: 'wz.ztzt',
    Pageindex: '0',
    pagesize: String(Math.max(want, 100)),
    sort: 'fbt:asc',
    date,
  });
  const res = await fetch(`${ZT_POOL}?${params}`, { headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://quote.eastmoney.com/' } });
  if (!res.ok) throw new Error(`Eastmoney ${res.status}`);
  const body = (await res.json()) as { rc?: number; data?: { tc?: number; qdate?: number; pool?: Array<Record<string, unknown>> } | null };
  if (!body.data || !Array.isArray(body.data.pool)) {
    return { date, found: false, message: `No limit-up data for ${date} (not a trading day, or data not yet published).` };
  }
  const pool = body.data.pool.slice(0, want).map((s) => ({
    code: s.c ?? null,
    name: s.n ?? null,
    price: price(s.p),
    change_pct: num(s.zdp) != null ? Math.round((num(s.zdp) as number) * 100) / 100 : null,
    turnover_yuan: num(s.amount),
    float_mktcap_yuan: num(s.ltsz),
    turnover_rate_pct: num(s.hs) != null ? Math.round((num(s.hs) as number) * 100) / 100 : null,
    consecutive_boards: num(s.lbc),
    first_seal_time: hms(s.fbt),
    last_seal_time: hms(s.lbt),
    seal_fund_yuan: num(s.fund),
    times_unsealed: num(s.zbc),
    industry: s.hybk ?? null,
  }));
  return {
    date: String(body.data.qdate ?? date),
    limit_up_count: body.data.tc ?? pool.length,
    returned: pool.length,
    note: 'Daily price limit is +10% for main-board A-shares, +20% for STAR (688xxx) and ChiNext (30xxxx). consecutive_boards>1 = a multi-day 连板 streak.',
    stocks: pool,
  };
}

async function quote(args: Record<string, unknown>) {
  const raw = String(args.symbols ?? '').trim();
  if (!raw) throw new Error('symbols is required, e.g. "600519" or "600519,000001".');
  const codes = raw.split(/[,\s]+/).filter(Boolean).slice(0, 50);
  const syms = codes.map(sinaSym);
  const res = await fetch(`${SINA}/list=${syms.join(',')}`, { headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0 (pipeworx.io)' } });
  if (!res.ok) throw new Error(`Sina ${res.status}`);
  // Sina returns GBK-encoded text (Chinese names). Decode from the raw bytes.
  const text = new TextDecoder('gbk').decode(await res.arrayBuffer());

  const quotes = [];
  for (const line of text.split('\n')) {
    const m = line.match(/hq_str_([a-z]{2}\d{6})="([^"]*)"/);
    if (!m) continue;
    const sym = m[1];
    const f = m[2].split(',');
    if (f.length < 32 || !f[0]) {
      quotes.push({ symbol: sym, code: sym.slice(2), found: false });
      continue;
    }
    const cur = Number(f[3]);
    const prev = Number(f[2]);
    quotes.push({
      symbol: sym,
      code: sym.slice(2),
      name: f[0],
      price: Number.isFinite(cur) ? cur : null,
      prev_close: Number.isFinite(prev) ? prev : null,
      change: Number.isFinite(cur) && Number.isFinite(prev) ? Math.round((cur - prev) * 1000) / 1000 : null,
      change_pct: Number.isFinite(cur) && Number.isFinite(prev) && prev !== 0 ? Math.round(((cur - prev) / prev) * 1e4) / 100 : null,
      open: num(f[1]),
      high: num(f[4]),
      low: num(f[5]),
      volume_shares: num(f[8]),
      turnover_yuan: num(f[9]),
      as_of: `${f[30]} ${f[31]}`,
    });
  }
  return { count: quotes.length, quotes };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ashares_limit_up':
      return limitUp(args);
    case 'ashares_quote':
      return quote(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
