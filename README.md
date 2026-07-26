# pi-account-manager

Pi extension for managing multiple named OAuth accounts per provider.

Log in to Anthropic twice — `anthropic@work` and `anthropic@personal` — and switch
between them with `/model`. Each account keeps its own OAuth credential and its own
usage attribution.

Supported providers: Anthropic, OpenAI Codex. Requires pi 0.82.

## Install

Point pi at a checkout via `settings.json`:

```json
{ "extensions": ["/path/to/pi-account-manager"] }
```

## Usage

```text
/account                        list named accounts
/account list                   list named accounts
/account add [name]             add a named account
/account remove [name|alias-id] remove a named account
```

`/account add work` prompts for a provider, registers `anthropic@work`, and prepares
`/login anthropic@work` for you to submit. From then on it is an ordinary pi provider:

```text
/login anthropic@work      authenticate the account
/logout                    remove its credential (the account stays registered)
/model                     switch between accounts and models
```

`/account` never touches credentials — it only creates, lists, and forgets names.
`/logout` remains the only way to remove a credential. Removing an account requires
logging out of it first and switching off its models.

Names are trimmed and lowercased, and must match `^[a-z0-9][a-z0-9_-]{0,31}$`. The same
name may be used once per provider.

## State

Named accounts are global across projects, stored at
`$PI_CODING_AGENT_DIR/pi-account-manager/accounts.json`:

```json
{
  "version": 1,
  "accounts": [{ "provider": "anthropic", "name": "work" }]
}
```

No credentials or model state live in that file. Credentials stay in pi's own
`auth.json`, keyed by alias ID. A corrupt or unreadable file disables named accounts
for that process — `/account` reports the error and native providers keep working.

## Anthropic subscription usage

Selecting an authenticated `anthropic@<name>` model warns once per process that
third-party harness usage is billed per token against extra usage rather than your
Claude plan limits. Silence it with `"warnings": { "anthropicExtraUsage": false }` in
settings.

## Development

```bash
npm install
npm test          # vitest, no network or live OAuth required
npm run typecheck
pi -e ./src/index.ts
```

Design: [`docs/superpowers/specs/2026-07-24-pi-account-manager-design.md`](docs/superpowers/specs/2026-07-24-pi-account-manager-design.md).
