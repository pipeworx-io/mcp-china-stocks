# @pipeworx/china-stocks

Live data for the Chinese A-share market (Shanghai / Shenzhen / STAR / ChiNext) — real-time quotes, intraday minute bars, daily OHLCV history, technical indicators, the limit-up/limit-down boards, market-wide margin financing balance, market-wide turnover ranking, and company earnings guidance/analyst consensus.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1764+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ashares_market_snapshot()` — headline index levels (Shanghai Composite, Shenzhen Component, ChiNext, STAR 50, CSI 300) plus limit-up/limit-down counts as a sentiment gauge.
- `ashares_limit_up({ date?, limit? })` — the daily limit-up board (涨停板): how many stocks hit their daily price limit and the ranked pool with consecutive-board count, seal fund, industry, turnover.
- `ashares_limit_down({ date?, limit? })` — the daily limit-down board (跌停板), the counterpart to `ashares_limit_up`: how many stocks hit their daily down price limit and the ranked pool. Source: Eastmoney `getTopicDTPool` (same host/shape as the limit-up pool).
- `ashares_margin_financing({ symbol?, date? })` — China A-share margin financing and securities-lending balance (融资融券余额/两融余额): market-wide aggregate by exchange (SSE + SZSE) with day-over-day change when `symbol` is omitted, or one SZSE-listed stock's own balance when `symbol` is a 6-digit SZSE code (0/3/159-prefixed). SSE per-stock detail has no verified keyless route, so an SSE code (6xxxxx) returns a clear `not_available` message rather than guessing. Margin data publishes T+1 and SSE usually publishes before SZSE, so the aggregate reports both exchanges for the latest trading day BOTH have published (on or before `date`), says so in `date_note`, and never sums two different days into one market total.
- `ashares_quote({ symbols })` — real-time quote(s) by 6-digit code, comma-separated.
- `ashares_daily_history({ codes, start, end?, adjust? })` — daily OHLCV history (open/high/low/close/volume, day-over-day change %) for up to 20 codes over a date range. `adjust`: `qfq` (forward-adjusted, default), `hfq` (backward-adjusted), or `none` (raw). Turnover amount (成交额) is not exposed by the daily-bar source, so `amount_cny` reports `"not_available"` per row rather than being estimated — use `ashares_quote` or `ashares_turnover_ranking` for same-day turnover amount.
- `ashares_intraday_bars({ symbols, date, up_to?, interval? })` — intraday minute bars (分时/分钟K线) for a past trading day, up to 5 comma-separated codes, with `cumulative_volume_shares`/`cumulative_turnover_cny` summed from the day's open through `up_to` (e.g. `"11:05"`; omit for the whole day). `interval` is the bar size in minutes (`1`/`5`/`15`/`30`/`60`, default `5`). **Bounded lookback**: the upstream caps total bars at ~1950 regardless of interval, so retention shrinks with interval and slides forward daily — roughly 8 trading days at 1-minute, 40 at 5-minute (default), 110 at 15-minute, a year at 30-minute, two years at 60-minute. A result's `earliest_bar_date_available`/`latest_bar_date_available` state the live bound for that call; a `date` older than `earliest_bar_date_available` needs a coarser `interval` or `ashares_daily_history` (daily only, no intraday).
- `ashares_turnover_ranking({ limit?, sort?, order?, board? })` — market-wide ranking by turnover amount, change %, or volume, server-side sorted, with turnover in CNY.
- `ashares_earnings_forecast({ symbol, limit? })` — company-issued earnings guidance (业绩预告): predicted profit range, YoY change %, forecast type, stated reason.
- `ashares_analyst_consensus({ symbol })` — analyst consensus estimates (盈利预测) per forecast year: EPS, PE, net profit, revenue.

## Auth

Keyless. All upstreams are public, unauthenticated endpoints.

## Data sources

- `https://push2ex.eastmoney.com/getTopicZTPool` — limit-up pool (涨停板).
  **Date trap (both pools):** the response's `qdate` is always the LATEST trading day, whatever `date` you asked for, while `tc` and the pool are for the requested day — so the date to report is the one requested, never `qdate`. Data is kept for about the last 20 trading days; an older day or a non-trading day comes back as `tc: 0` with an empty pool, which the tools report as `found: false`, not as zero. Zero limit-DOWNs is a real outcome on a strong day, so an empty DT board is believed only when the ZT board for that day is non-empty.
- `https://push2ex.eastmoney.com/getTopicDTPool` — limit-down pool (跌停板), same host/params as the limit-up pool above. Verified live 2026-10-08; a 2026-09-07 project note recorded this endpoint as gated (`rc:206 data:null`) — that no longer holds, so don't skip it on the strength of the old note alone.
- `https://query.sse.com.cn/marketdata/tradedata/queryMargin.do` — SSE's own daily margin-trading summary (融资融券交易汇总), market-wide, newest-first with no date param. Fields are already native CNY (元) — no unit conversion. This is a different path from the generic `commonQuery.do`, which fails open (HTTP 200, `data: null`) on an unrecognized `sqlId` and will look like "no data" rather than "wrong endpoint" if you guess wrong.
- `https://www.szse.cn/api/report/ShowReport/data?CATALOGID=1837_xxpl` — SZSE's margin-trading report via the same ShowReport mechanism as `ashares_sector_flows`' sibling pack (`china-exchange-data`). `TABKEY=tab1` is the market-wide total, `TABKEY=tab2` + `txtZqdm=<6-digit code>` is per-stock detail. `txtDate` is `YYYY-MM-DD` and required — omitting it dumps the full history since 2010 instead of defaulting to latest. A date with nothing published yet (today, weekend, holiday) comes back as a real HTTP 200 with an empty `data` array and blank `metadata.subname`, not an error — callers must walk back trading days themselves (this pack does). **Unit trap**: `tab1`'s `jrrjye` (融券余额) is in 亿元 (×1e8); `tab2`'s `jrrjye` — same field name — is in 万元 (×1e4). Confirmed live 2026-10-08; reusing the tab1 factor on tab2 data is a 10,000× error.
- `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSDB` — Eastmoney's margin history split by exchange (`H_*` = SSE, `S_*` = SZSE, native CNY). The fallback for whichever exchange endpoint does not answer from Worker egress — both are intermittent from Cloudflare (SSE returned HTTP 500 to the gateway on 2026-10-09/10 while a laptop got 200; SZSE timed out on some edge probes). Its figures matched SSE and SZSE's own to the yuan for 2026-09-30, 10-08 and 10-09. A row exists before SZSE has published that day, with the `S_*` columns null — null means not yet, never zero. Accepts `filter=(DIM_DATE<='YYYY-MM-DD')`.
- `https://hq.sinajs.cn/list=...` — real-time quotes and index levels (GBK-encoded; decode with `TextDecoder('gbk')`).
- `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData` — market-wide ranked node listing (turnover/volume/change % ranking); no industry field.
- `https://datacenter-web.eastmoney.com/api/data/v1/get` — earnings guidance / analyst consensus datacenter reports. Note: this is a *different* Eastmoney host from `push2.eastmoney.com`, which is empty from any IP — don't lump them together.
- `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get` — Tencent/gtimg daily K-line bars. `param=<sym>,day,<start>,<end>,<count>,<adjust>` where `<sym>` is `sh`/`sz`/`bj` + 6-digit code and `<adjust>` is `qfq`/`hfq`/empty (unadjusted, still needs the trailing comma or the request 400s). Response key is `qfqday`/`hfqday`/`day` matching the adjust arg; an invalid code returns HTTP 200 with an empty `day` array rather than an error, so treat empty rows as `found: false`, not a fetch failure. Rows are `[date, open, close, high, low, volume]` — note the volume unit is 手 (lots of 100 shares), not raw shares, and there is no turnover-amount field in any adjust variant. A single request only accepts one `param=` (repeating the query param keeps only the last), so multi-code history is N parallel requests, not a batch call.

Turnover amount is deliberately absent from `ashares_daily_history`: checked both the gtimg row form (all three adjust variants) and Sina's `hisdata/klc_kl.js` second-leg endpoint (binary-encoded, not a usable JSON leg) — neither exposes daily amount, so it is reported as `not_available` rather than derived from price × volume.

- `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/CN_MarketDataService.getKLineData` — Sina's minute-bar kline (分钟K线), keyless. `?symbol=<sh|sz|bj><code>&scale=<1|5|15|30|60>&ma=no&datalen=1950`; `datalen` caps at ~1950 total bars regardless of `scale` (verified 2026-10-06: 1950 works, 2000 returns the literal string `null`), so retention shrinks as `scale` shrinks — the live window is reported per-call as `earliest_bar_date_available`/`latest_bar_date_available`. Response is JSONP-shaped text (`var _=([...]);`) rather than plain JSON, so it needs a regex extract, not `res.json()`. Each row's `volume` is already in **shares** (not the 100-share 手 lots `ashares_daily_history`'s gtimg source uses) and `amount` is CNY turnover — summing a full day's 5-minute bars for 515050 and 600519 on 2026-09-01 matched `ashares_daily_history`'s daily volume for the same code+day within ~0.1% (the residual is end-of-day call-auction handling). `ashares_intraday_bars` sums these bars client-side into `cumulative_volume_shares`/`cumulative_turnover_cny`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "china-stocks": {
      "url": "https://gateway.pipeworx.io/china-stocks/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/china-stocks/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1764+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ashares_limit_up \
  -H 'Content-Type: application/json' \
  -d '{}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ashares_limit_up`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "china-stocks": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-china-stocks"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-china-stocks
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about China Stocks data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
