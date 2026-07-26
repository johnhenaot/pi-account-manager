# pi-account-manager

Pi extension for managing multiple named OAuth accounts per provider.

Log in to Anthropic twice — `anthropic@work` and `anthropic@personal` — and switch
between them with `/model`. Each account keeps its own login and its own usage.

Supported providers: Anthropic, OpenAI Codex. Requires pi 0.82.

## Install

```bash
pi install git:github.com/johnhenaot/pi-account-manager
```

SSH and a pinned tag work too:

```bash
pi install git:git@github.com:johnhenaot/pi-account-manager
pi install git:github.com/johnhenaot/pi-account-manager@v0.1.0
```

## Adding an account

```text
/account add work
```

Pick a provider when prompted. Pi prepares `/login anthropic@work` in your editor —
press enter to run it and sign in as usual.

That's it. `anthropic@work` is now an ordinary provider, so:

```text
/model                     switch between your accounts and their models
/login anthropic@work      sign in again later
/logout                    sign out of an account
```

A named account starts on the same default model its provider normally uses, so signing
in leaves you ready to go. To start on a different one, name it in `/settings`:

```json
{ "defaultProvider": "anthropic@work", "defaultModel": "claude-sonnet-5" }
```

## Commands

```text
/account                        list your accounts
/account list                   list your accounts
/account add [name]             add an account
/account remove [name|alias-id] remove an account
```

`/account` shows each account's name, provider, and whether it's signed in:

```text
NAME      PROVIDER      ALIAS ID            STATUS
personal  Anthropic     anthropic@personal  not authenticated
work      Anthropic     anthropic@work      authenticated
work      OpenAI Codex  openai-codex@work   authenticated
```

Removing an account only forgets the name — it never deletes your login. Sign out with
`/logout` first, and switch off its models with `/model`; `/account remove` will tell you
if either is still needed.

## Account names

Names are trimmed and lowercased, and must be 1–32 characters of `a-z`, `0-9`, `_` or
`-`, starting with a letter or digit. The same name can be used once per provider, so
`anthropic@work` and `openai-codex@work` can both exist.

## Anthropic subscription usage

The first time you pick an `anthropic@<name>` model, pi warns you that usage through a
third-party harness is billed per token against extra usage rather than your Claude plan
limits. To silence it, set this in `/settings`:

```json
{ "warnings": { "anthropicExtraUsage": false } }
```
