# Changelog

## 1.0.2 - 2026-09-18

Packaging only. Nothing about the server's behaviour or any tool has changed.

- Added the `mcpName` field, set to `io.github.meser10/meser10-mcp`. The official MCP
  Registry reads it from the published tarball to prove that the package and the registry
  entry belong to the same owner. Without it the registry refuses the listing.

## 1.0.1 - 2026-09-18

Packaging only. Nothing about the server's behaviour or any tool has changed.

- Added the `repository` field. Without it npm showed no link to the source, and the
  directories that index MCP servers had no way to tie the package to this repo.
- `bugs.url` now points at the GitHub issue tracker instead of the marketing page.

## 1.0.0 - 2026-09-12

First public release.

- `bugs` points at the Hebrew documentation page and at support@meser10.co.il. The GitHub
  mirror is not up yet, so the package ships no link that resolves to a 404.

- Verified against the production endpoint in read mode: authentication with `ApiKey` only,
  tool listing, and four operations returning live data.
- `MESER10_USER_ID` is now optional at start-up. 17 of the 61 operations never send an account
  id, so a key-only setup is valid; the constraint moved to the operations that need it.
- Fixed: operations whose payload arrives in sibling out-parameters (`oaGroups`, `sToken`,
  `oUserLimitsInfo`) returned only the status and discarded the data. The response now merges
  the status with every sibling element.
- `NotEnoughPermissions` now explains both causes: the key belongs to a different account, or
  the account id is real but out of reach. An id the platform cannot resolve fails differently
  (`ApplicationError`), and the message says so.
- 55 tests (43 unit, 12 end-to-end over real MCP stdio).

## 0.1.0 - 2026-09-11

Initial build. Tools generated from the live WSDL, four-level safety gate, recipient cap,
credential injection, `CCallResult` error mapping.
