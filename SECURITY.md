# Security policy

## Reporting a vulnerability in this SDK

Report it privately through GitHub: open this repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue for security problems.

Useful details: the SDK version (`VERSION` export or `package.json`), Node version, a minimal
reproduction, and what an attacker could do with it.

## Problems with the hosted API

Issues with the MolochAI service itself (api.molochai.dev, the dashboard, billing) are not
handled in this repository. Contact support through
[molochai.dev/contact](https://molochai.dev/contact?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node).

## Never post API keys

Do not paste API keys in issues, pull requests, logs or screenshots. If a key was exposed,
revoke it in the dashboard
([dash.molochai.dev/account](https://dash.molochai.dev/account?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node))
and create a new one. Keys are not scoped: anyone holding one can read account details and create
invoices, not only send chat requests.

## What the SDK does to protect the key

- The key lives in a private class field. `console.log(client)`, `util.inspect` and
  `JSON.stringify(client)` show it masked (`****` plus the last four characters for long keys).
- Error messages and error bodies have the key replaced with `[redacted]` if a server or proxy
  ever echoes it back.
- `new MolochAI()` refuses to run in a browser unless you pass `dangerouslyAllowBrowser: true`,
  because a key in a web page can be read by anyone who opens it.

## Supported versions

Only the latest released version receives fixes.
