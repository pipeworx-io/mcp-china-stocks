# mcp-china-stocks

China A-shares MCP. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `ashares_limit_up` | The Chinese A-share market's LIMIT-UP board (涨停板) for a trading day — how many stocks hit their daily price limit (+10%, or +20% for STAR/ChiNext) and the ranked list of those stocks. Answers 'how many A-shares hit limit up today', 'top limit-up stocks', 'which stocks 涨停'. Each stock includes code, name, price, change %, turnover (成交额), float market cap, turnover rate (换手率), consecutive-board count (连板数 lbc), first/last seal time, seal fund (封板资金), and industry (行业). Source: Eastmoney (keyless). |
| `ashares_market_snapshot` | Overall snapshot of the Chinese A-share market — the headline index levels (Shanghai Composite, Shenzhen Component, ChiNext, STAR 50, CSI 300) with change %, day range and turnover, plus how many stocks hit limit-up (涨停) today as a sentiment gauge. Answers 'how is the China A-share market doing', 'Shanghai Composite today', 'A-share market snapshot at close', 'how did Chinese stocks close'. Source: Sina + Eastmoney (keyless). |
| `ashares_quote` | Real-time quote(s) for Chinese A-share stocks by 6-digit code (Shanghai 6xxxxx, Shenzhen 0xxxxx/3xxxxx, STAR 688xxx, ChiNext 30xxxx, Beijing 8xxxxx/4xxxxx). Returns name, current price, change and change %, open, previous close, day high/low, volume, turnover, and the quote timestamp. Accepts one code or a comma-separated list. Example: ashares_quote({ symbols: "600519,000858" }) for Kweichow Moutai and Wuliangye. Source: Sina (keyless). |
| `ashares_earnings_forecast` | Company-issued earnings guidance (业绩预告) for a Chinese A-share stock — the company's own forecast announcements with predicted profit range (lower/upper bounds in CNY), year-over-year change %, forecast type (略增/预增/扭亏 etc.), and the company's stated reason. Answers '业绩预测', '业绩预告', 'earnings forecast/guidance for a China A-share company like 华工科技 000988'. Most recent reports first. Source: Eastmoney datacenter (keyless). |
| `ashares_analyst_consensus` | Analyst consensus estimates (盈利预测) for a Chinese A-share stock — per forecast year: consensus EPS, P/E at current price, net profit attributable to parent (归母净利润), and total operating revenue, in CNY. Answers "analyst estimates / 盈利预测 / forecast EPS for a China A-share like 000988". Source: Eastmoney datacenter (keyless). |

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

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

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
