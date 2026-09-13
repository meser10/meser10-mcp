# Meser10 MCP Server

Connect the Meser10 email & SMS platform to any MCP client (Claude, Cursor, or your own agent).

> תיעוד בעברית, כולל התקנה מודרכת: https://www.meser10.co.il/features/mcp-server/

**Tools are generated from the live WSDL.** Nobody hand-writes 61 tool definitions here, which
means the server covers every API capability by construction and does not drift when the platform
ships a new operation.

## Quick start

```bash
export MESER10_API_KEY=...      # issued in the Meser10 UI
export MESER10_USER_ID=...      # your account number - optional, see below
npx @meser10/mcp-server
```

`MESER10_USER_ID` is optional at start-up. 17 of the 61 operations are authenticated by the key
alone; the other 44 carry an explicit account number, and those fail with a clear message if it is
not set. Set it unless you know you only need the first group. The account number is an identifier,
not a secret - it is visible in the Meser10 UI.

Claude Desktop / Claude Code:

```json
{
  "mcpServers": {
    "meser10": {
      "command": "npx",
      "args": ["-y", "@meser10/mcp-server"],
      "env": { "MESER10_API_KEY": "...", "MESER10_USER_ID": "..." }
    }
  }
}
```

## Safety model

The server starts **read-only**. Nothing that spends money, messages a real person, or deletes a
record is reachable until you opt in.

| `MESER10_MODE` | Adds | Tools |
|---|---|---|
| `read` *(default)* | the `Get*` family | 16 |
| `write` | contacts, groups, campaign drafts | +27 |
| `send` | **delivers to real recipients, spends credit** | +13 |
| `destructive` | **permanent deletes** | +5 |

Two more guards:

- **`MESER10_MAX_RECIPIENTS`** (default 100) refuses any single send that targets more addresses
  than the cap. A model that misreads a prompt cannot mail your whole list.
- **Credentials are injected, never exposed.** `oLogin` and `iUserID` are stripped from every tool
  schema and filled in by the server. A model cannot see, guess, or leak them. `CLoginInfo` does
  accept `UserName`/`Password`, and this server deliberately never populates them - `ApiKey` only.

## The one thing to know about errors

Every operation returns HTTP 200, including failures. Success lives in the `Result` field of
`CCallResult`, not in the status code. This server reads `Result`, throws on anything that is not
`Success` or `PartialSuccess`, and attaches a remedy:

```
LoginFailed: bad key - MESER10_API_KEY was rejected. Reissue the key in the Meser10 UI and restart.
```

`PartialSuccess` is surfaced as a warning rather than silent success, because it means some records
in a batch did not land.

## Design notes

**Legacy variants are hidden.** The contract exposes five `Ex`/`Ex2` families (15 operations for 5
capabilities). Offering all of them makes a model choose between near-identical tools and pick
wrong. The richest variant is exposed; the rest are hidden behind `MESER10_EXPOSE_LEGACY=true`.

**Names are written for callers.** `GetGroupsList` is what the platform calls it. `list_groups` is
what a developer reaches for. The underlying operation name is always in the description, so
nothing is hidden.

**Hungarian prefixes become type hints.** `saGroups` is an array of strings, `eLang` is an enum,
`iUserID` is an int. The generator uses that to produce better schemas and human titles.

## Troubleshooting

**`LoginFailed` on a key that worked five minutes ago.** The platform blocks the *calling IP*
after a few failed authentications, and the block is long - measured at over three and three
quarter hours. It reports itself as `Incorrect user name or password`, which is indistinguishable
from a wrong key, so the instinct to reissue the key and retry makes it worse: the new key is
blocked too, because the block is not on the key.

If this happens: **stop calling**, wait, and do not put a retry loop around authentication. Never
retry an auth failure automatically - retrying is what creates the block, and on a shared server
it takes down every other integration sending from the same address.

**`NotEnoughPermissions`.** Either the key belongs to a different account than the
`MESER10_USER_ID` you set, or that account is real but out of your key's reach. An account number
the platform cannot resolve at all fails differently, as `ApplicationError`, so this message does
mean the number exists.

**A tool returns a status and no data.** Fixed in 1.0.0. Upgrade.

**`PartialSuccess`.** Part of a batch did not land. The server surfaces it as a warning rather
than silent success; check which records are missing before you retry the whole batch.

## Support

support@meser10.co.il · 03-7440020 · Sunday to Thursday, 9:00-17:00 Israel time.

Include the operation name and the `Result` value you got back. Never include your API key, and
if one has been shared anywhere, reissue it.

## Development

```bash
npm install && npm run build
npm test            # 43 unit tests + 12 end-to-end tests over real MCP stdio
```

The e2e suite runs a local stand-in for the platform, so it needs no credentials and sends nothing.

## Status

Verified against the production endpoint on 2026-09-12, in read mode: authentication with `ApiKey`
only, tool listing, and four operations returning live data through the whole chain.

Also verified locally: WSDL parsing, schema generation, safety gate, envelope construction,
credential injection, error mapping, recipient cap, and the MCP protocol over stdio.

Write, send and delete operations are implemented and covered by tests against a stand-in, and
have deliberately never been executed against a live account by this project.
