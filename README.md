# @pipeworx/china-stocks

Live data for the Chinese A-share market (Shanghai / Shenzhen / STAR / ChiNext) — real-time quotes, daily OHLCV history, the limit-up board, market-wide turnover ranking, and company earnings guidance/analyst consensus.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `ashares_market_snapshot()` — headline index levels (Shanghai Composite, Shenzhen Component, ChiNext, STAR 50, CSI 300) plus limit-up count as a sentiment gauge.
- `ashares_limit_up({ date?, limit? })` — the daily limit-up board (涨停板): how many stocks hit their daily price limit and the ranked pool with consecutive-board count, seal fund, industry, turnover.
- `ashares_quote({ symbols })` — real-time quote(s) by 6-digit code, comma-separated.
- `ashares_daily_history({ codes, start, end?, adjust? })` — daily OHLCV history (open/high/low/close/volume, day-over-day change %) for up to 20 codes over a date range. `adjust`: `qfq` (forward-adjusted, default), `hfq` (backward-adjusted), or `none` (raw). Turnover amount (成交额) is not exposed by the daily-bar source, so `amount_cny` reports `"not_available"` per row rather than being estimated — use `ashares_quote` or `ashares_turnover_ranking` for same-day turnover amount.
- `ashares_turnover_ranking({ limit?, sort?, order?, board? })` — market-wide ranking by turnover amount, change %, or volume, server-side sorted, with turnover in CNY.
- `ashares_earnings_forecast({ symbol, limit? })` — company-issued earnings guidance (业绩预告): predicted profit range, YoY change %, forecast type, stated reason.
- `ashares_analyst_consensus({ symbol })` — analyst consensus estimates (盈利预测) per forecast year: EPS, PE, net profit, revenue.

## Auth

Keyless. All upstreams are public, unauthenticated endpoints.

## Data sources

- `https://push2ex.eastmoney.com/getTopicZTPool` — limit-up pool (涨停板).
- `https://hq.sinajs.cn/list=...` — real-time quotes and index levels (GBK-encoded; decode with `TextDecoder('gbk')`).
- `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData` — market-wide ranked node listing (turnover/volume/change % ranking); no industry field.
- `https://datacenter-web.eastmoney.com/api/data/v1/get` — earnings guidance / analyst consensus datacenter reports. Note: this is a *different* Eastmoney host from `push2.eastmoney.com`, which is empty from any IP — don't lump them together.
- `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get` — Tencent/gtimg daily K-line bars. `param=<sym>,day,<start>,<end>,<count>,<adjust>` where `<sym>` is `sh`/`sz`/`bj` + 6-digit code and `<adjust>` is `qfq`/`hfq`/empty (unadjusted, still needs the trailing comma or the request 400s). Response key is `qfqday`/`hfqday`/`day` matching the adjust arg; an invalid code returns HTTP 200 with an empty `day` array rather than an error, so treat empty rows as `found: false`, not a fetch failure. Rows are `[date, open, close, high, low, volume]` — note the volume unit is 手 (lots of 100 shares), not raw shares, and there is no turnover-amount field in any adjust variant. A single request only accepts one `param=` (repeating the query param keeps only the last), so multi-code history is N parallel requests, not a batch call.

Turnover amount is deliberately absent from `ashares_daily_history`: checked both the gtimg row form (all three adjust variants) and Sina's `hisdata/klc_kl.js` second-leg endpoint (binary-encoded, not a usable JSON leg) — neither exposes daily amount, so it is reported as `not_available` rather than derived from price × volume.

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

Both URLs reach the same gateway and the same 1679+ data sources. The
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
