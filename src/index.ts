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
// Eastmoney datacenter report API (业绩预告 / 盈利预测) — verified CF-egress-OK
// 2026-07-17; note this is a DIFFERENT host from push2.eastmoney (which is
// empty from any IP — see project memory) so don't lump them together.
const DATACENTER = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

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

// The five headline A-share indices, Sina symbol → English name.
const MARKET_INDICES: Array<{ sym: string; name: string; cn: string }> = [
  { sym: 'sh000001', name: 'Shanghai Composite', cn: '上证指数' },
  { sym: 'sz399001', name: 'Shenzhen Component', cn: '深证成指' },
  { sym: 'sz399006', name: 'ChiNext', cn: '创业板指' },
  { sym: 'sh000688', name: 'STAR 50', cn: '科创50' },
  { sym: 'sh000300', name: 'CSI 300', cn: '沪深300' },
];

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
    name: 'ashares_market_snapshot',
    description:
      "Overall snapshot of the Chinese A-share market — the headline index levels (Shanghai Composite, Shenzhen Component, ChiNext, STAR 50, CSI 300) with change %, day range and turnover, plus how many stocks hit limit-up (涨停) today as a sentiment gauge. Answers 'how is the China A-share market doing', 'Shanghai Composite today', 'A-share market snapshot at close', 'how did Chinese stocks close'. Source: Sina + Eastmoney (keyless).",
    inputSchema: {
      type: 'object' as const,
      properties: {},
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
  {
    name: 'ashares_earnings_forecast',
    description:
      "Company-issued earnings guidance (业绩预告) for a Chinese A-share stock — the company's own forecast announcements with predicted profit range (lower/upper bounds in CNY), year-over-year change %, forecast type (略增/预增/扭亏 etc.), and the company's stated reason. Answers '业绩预测', '业绩预告', 'earnings forecast/guidance for a China A-share company like 华工科技 000988'. Most recent reports first. Source: Eastmoney datacenter (keyless).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: '6-digit A-share code, e.g. "000988" (华工科技) or "600519" (贵州茅台).' },
        limit: { type: 'number', description: 'How many forecast announcements to return, 1–20 (default 4, newest first).' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'ashares_analyst_consensus',
    description:
      'Analyst consensus estimates (盈利预测) for a Chinese A-share stock — per forecast year: consensus EPS, P/E at current price, net profit attributable to parent (归母净利润), and total operating revenue, in CNY. Answers "analyst estimates / 盈利预测 / forecast EPS for a China A-share like 000988". Source: Eastmoney datacenter (keyless).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: '6-digit A-share code, e.g. "000988" or "300750" (宁德时代).' },
      },
      required: ['symbol'],
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

async function marketSnapshot() {
  // Indices parse with the same Sina field layout as stock quotes.
  const list = MARKET_INDICES.map((i) => i.sym).join(',');
  const indices: Array<Record<string, unknown>> = [];
  let asOf: string | null = null;
  try {
    const res = await fetch(`${SINA}/list=${list}`, { headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0 (pipeworx.io)' } });
    if (res.ok) {
      const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
      const bySym = new Map<string, string[]>();
      for (const line of text.split('\n')) {
        const m = line.match(/hq_str_([a-z]{2}\d{6})="([^"]*)"/);
        if (m && m[2]) bySym.set(m[1], m[2].split(','));
      }
      for (const idx of MARKET_INDICES) {
        const f = bySym.get(idx.sym);
        if (!f || f.length < 10) { indices.push({ index: idx.name, cn_name: idx.cn, found: false }); continue; }
        const cur = Number(f[3]); const prev = Number(f[2]);
        if (!asOf && f[30] && f[31]) asOf = `${f[30]} ${f[31]}`;
        indices.push({
          index: idx.name,
          cn_name: idx.cn,
          level: Number.isFinite(cur) ? Math.round(cur * 100) / 100 : null,
          change: Number.isFinite(cur) && Number.isFinite(prev) ? Math.round((cur - prev) * 100) / 100 : null,
          change_pct: Number.isFinite(cur) && Number.isFinite(prev) && prev !== 0 ? Math.round(((cur - prev) / prev) * 1e4) / 100 : null,
          open: num(f[1]), high: num(f[4]), low: num(f[5]),
          turnover_yuan: num(f[9]),
        });
      }
    }
  } catch { /* indices best-effort */ }

  // Limit-up count (涨停家数) — a headline breadth/sentiment gauge for A-shares.
  let limitUpCount: number | null = null;
  const date = latestTradingDate();
  try {
    const params = new URLSearchParams({ ut: '7eea3edcaed734bea9cbfc24409ed989', dpt: 'wz.ztzt', Pageindex: '0', pagesize: '1', sort: 'fbt:asc', date });
    const res = await fetch(`${ZT_POOL}?${params}`, { headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://quote.eastmoney.com/' } });
    if (res.ok) {
      const body = (await res.json()) as { data?: { tc?: number } | null };
      limitUpCount = body.data?.tc ?? null;
    }
  } catch { /* breadth best-effort */ }

  return {
    market: 'China A-shares (Shanghai / Shenzhen / STAR / ChiNext)',
    as_of: asOf ?? date,
    indices,
    limit_up_count: limitUpCount,
    note: 'Index turnover is in CNY. limit_up_count = number of A-shares that closed at their daily price limit (+10%, or +20% for STAR/ChiNext) — a market-sentiment gauge. Use ashares_limit_up for the ranked limit-up pool. Source: Sina (indices) + Eastmoney (limit-up), keyless.',
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

function requireCode(args: Record<string, unknown>): string {
  const code = String(args.symbol ?? args.code ?? args.symbols ?? '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) {
    throw new Error('symbol must be a 6-digit A-share code, e.g. "000988" or "600519".');
  }
  return code;
}

async function datacenter(reportName: string, code: string, extra: Record<string, string>) {
  const params = new URLSearchParams({
    reportName,
    columns: 'ALL',
    filter: `(SECURITY_CODE="${code}")`,
    ...extra,
  });
  const res = await fetch(`${DATACENTER}?${params}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://data.eastmoney.com/' },
  });
  if (!res.ok) throw new Error(`Eastmoney datacenter ${res.status}`);
  const body = (await res.json()) as {
    success?: boolean;
    result?: { data?: Array<Record<string, unknown>>; count?: number } | null;
  };
  // Unknown codes come back success:false / result:null, not an HTTP error.
  return body.result?.data ?? [];
}

async function earningsForecast(args: Record<string, unknown>) {
  const code = requireCode(args);
  const want = Math.min(Math.max(Number(args.limit ?? 4), 1), 20);
  const rows = await datacenter('RPT_PUBLIC_OP_NEWPREDICT', code, {
    sortColumns: 'REPORT_DATE',
    sortTypes: '-1',
    pageSize: String(want),
    pageNumber: '1',
  });
  if (rows.length === 0) {
    return { symbol: code, found: false, message: `No company earnings guidance (业绩预告) on record for ${code} — check the code, or the company may not have issued guidance.` };
  }
  return {
    symbol: code,
    name: rows[0].SECURITY_NAME_ABBR ?? null,
    count: rows.length,
    note: 'Company-issued guidance (业绩预告), newest first. Amounts in CNY. predict_type is the company wording (预增=large increase, 略增=slight increase, 扭亏=turnaround, 预减=decrease).',
    forecasts: rows.map((r) => ({
      report_period: String(r.REPORT_DATE ?? '').slice(0, 10),
      announced: String(r.NOTICE_DATE ?? '').slice(0, 10),
      metric: r.PREDICT_FINANCE ?? null,
      predict_type: r.PREDICT_TYPE ?? null,
      forecast_state: r.FORECAST_STATE ?? null,
      amount_lower_cny: num(r.PREDICT_AMT_LOWER),
      amount_upper_cny: num(r.PREDICT_AMT_UPPER),
      yoy_change_lower_pct: num(r.ADD_AMP_LOWER),
      yoy_change_upper_pct: num(r.ADD_AMP_UPPER),
      prior_year_same_period_cny: num(r.PREYEAR_SAME_PERIOD),
      summary: r.PREDICT_CONTENT ?? null,
      company_reason: r.CHANGE_REASON_EXPLAIN ?? null,
      is_latest: r.IS_LATEST === 'T',
    })),
  };
}

async function analystConsensus(args: Record<string, unknown>) {
  const code = requireCode(args);
  const rows = await datacenter('RPT_RES_PROFITPREDICT', code, { pageSize: '10', pageNumber: '1' });
  if (rows.length === 0) {
    return { symbol: code, found: false, message: `No analyst consensus (盈利预测) on record for ${code} — small caps often have no analyst coverage.` };
  }
  return {
    symbol: code,
    name: rows[0].SECURITY_NAME_ABBR ?? null,
    note: 'Analyst consensus (盈利预测) per forecast year. Amounts in CNY; PE is at the current price.',
    estimates: rows
      .map((r) => ({
        year: num(r.PREDICT_YEAR),
        eps_cny: num(r.EPS),
        pe: num(r.PE) != null ? Math.round((num(r.PE) as number) * 100) / 100 : null,
        net_profit_cny: num(r.PARENT_NETPROFIT),
        revenue_cny: num(r.TOTAL_OPERATE_INCOME),
      }))
      .sort((a, b) => (a.year ?? 0) - (b.year ?? 0)),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ashares_market_snapshot':
      return marketSnapshot();
    case 'ashares_limit_up':
      return limitUp(args);
    case 'ashares_quote':
      return quote(args);
    case 'ashares_earnings_forecast':
      return earningsForecast(args);
    case 'ashares_analyst_consensus':
      return analystConsensus(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
