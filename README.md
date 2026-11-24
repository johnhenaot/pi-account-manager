# pi-account-manager

Use more than one Anthropic or OpenAI subscription in pi, and switch between them with `/model`.

Sign in as `anthropic@work` and `anthropic@personal`, and each account keeps its own login and its own usage.

## Install

```bash
pi install npm:pi-account-manager
```

Restart pi, or run `/reload`. You need pi 1.6.0 or newer, and pi warns you at startup if yours is older.

## Add an account

```text
/account add work
```

Pick a provider. Pi puts `/login anthropic@work` in your editor, so press enter and sign in as usual.

That's it. `anthropic@work` now works like any other provider:

```text
/model                     switch between accounts and their models
/login anthropic@work      sign in again
/logout                    sign out of an account
```

The first time you sign in, pick one of the account's models with `/model`.

## Supported providers

| Choose       | Alias                 | Signs in with            |
| ------------ | --------------------- | ------------------------ |
| Anthropic    | `anthropic@<name>`    | Your Claude subscription |
| OpenAI       | `openai@<name>`       | Sign in with ChatGPT     |
| OpenAI Codex | `openai-codex@<name>` | The legacy Codex login   |

Each account signs in on its own. A named account never uses pi's built-in login for that provider, or an API key.

## Commands

```text
/account                        list your accounts
/account add [name]             add an account
/account remove [name|alias]    remove an account
```

`/account` shows each account and whether it's signed in:

```text
NAME      PROVIDER      ALIAS ID            STATUS
personal  Anthropic     anthropic@personal  not authenticated
work      Anthropic     anthropic@work      authenticated
work      OpenAI        openai@work         authenticated
```

`/account` only works in pi's interactive mode.

## Start on an account by default

Name the account and model in `/settings`:

```json
{ "defaultProvider": "anthropic@work", "defaultModel": "claude-sonnet-5" }
```

## Remove an account

```text
/account remove work
```

This only forgets the name and never deletes your login. Before removing an account, sign out with `/logout` and switch to another model. `/account remove` tells you if either step is still needed.

## Account names

Names can use 1 to 32 characters: lowercase letters, digits, `_` and `-`, starting with a letter or digit. Uppercase letters are lowercased. You can reuse a name across providers, so `anthropic@work` and `openai@work` can both exist.

## Good to know

- **Anthropic billing:** the first time in a pi run that you use an `anthropic@<name>` account, pi warns that third-party usage is billed per token as extra usage, not against your Claude plan limits. To turn the warning off, set `{ "warnings": { "anthropicExtraUsage": false } }` in `/settings`.
- **`models.json`:** named accounts follow the built-in provider's settings there, including any `headers`. An `Authorization` header there replaces the account's own login.
- **Where accounts live:** account names are kept in `~/.pi/agent/pi-account-manager/accounts.json`. Logins stay in pi's own `auth.json`, like any other provider.

## License

MIT
