# Pi Account Manager Design

<!-- markdownlint-disable MD013 -->

- **Status:** Approved
- **Date:** 2026-07-24
- **Repository:** `pi-account-manager`

## 1. Scope

Version 1 MUST support named OAuth accounts for exactly:

| Provider ID | Display name |
| --- | --- |
| `anthropic` | Anthropic |
| `openai-codex` | OpenAI Codex |

It MUST target `@earendil-works/pi-coding-agent` 0.82.0 and its matching `@earendil-works/pi-ai` version.

It MUST NOT:

- Support API keys, ambient credentials, custom providers, or other built-in providers.
- Override `/login`, `/logout`, or `/model`.
- Switch or remember models from `/account`.
- Rename accounts.
- Directly read, copy, move, refresh, or delete OAuth credential material. It MAY query configured-auth status only through Pi's auth-status API.
- Manage accounts outside interactive TUI mode.
- Promise account or model behavior in RPC, JSON, print, or other non-interactive modes; those modes are outside version 1's acceptance surface.

## 2. Account identity

An account is a unique `(provider, name)` pair.

Names MUST be normalized by ECMAScript `String.prototype.trim()`, followed by ASCII `A`–`Z` lowercasing, then validated against:

```text
^[a-z0-9][a-z0-9_-]{0,31}$
```

The same name MAY exist once for each supported provider.

For provider ID `P`, display name `D` from section 1, and normalized name `N`:

```text
alias ID = P + "@" + N
alias display name = D + " (" + N + ")"
```

Examples are `anthropic@work` and `openai-codex@personal`.

## 3. `/account` command

All `/account` forms MUST be TUI-only:

```text
/account
/account list
/account add [name]
/account remove [name|alias-id]
```

Unknown subcommands or excess arguments MUST show usage and make no state change.

### 3.1 List

`/account` and `/account list` MUST use the process's loaded account snapshot, not reread persistent state.

They MUST list named accounts only, ordered by provider display name and account name. Each row MUST show name, provider, alias ID, and one status:

- `authenticated`: Pi explicitly reports configured OAuth.
- `not authenticated`: Pi explicitly reports no configured OAuth.
- `status unavailable`: status lookup throws or returns no determinate result for a registered alias.

A load error MUST be shown instead of account rows. An empty snapshot MUST show exactly:

```text
No named accounts. Use /account add NAME.
```

Listing MUST NOT change accounts, authentication, or the active model.

### 3.2 Add

`/account add [name]` MUST:

1. Prompt when the name is omitted; cancellation makes no state change.
2. Normalize and validate the name.
3. Prompt for Anthropic or OpenAI Codex; cancellation makes no state change.
4. Reject an existing `(provider, name)` and suggest `/login <alias-id>` for reauthentication.
5. Verify that the effective native provider, OAuth flow, and model catalog exist; the alias ID is unowned; and an alias satisfying section 5 can be constructed without native API-key or ambient authentication.
6. Persist and register the account as one all-or-nothing operation.
7. Prepare `/login <alias-id>` without submitting it.

If the editor is empty, the command MUST prefill `/login <alias-id>`. Otherwise it MUST preserve the editor and display that exact command in a notification.

Add failure before registration MUST leave no persistent or runtime account. A later cancelled or failed OAuth flow MUST leave the account registered but unauthenticated.

### 3.3 Remove

Removal MUST resolve its target as follows:

1. No argument: show all loaded accounts in a selector.
2. Exact case-sensitive alias ID: use that account.
3. Otherwise normalize the argument as a name and match loaded accounts.
4. One name match: use it; two matches: show those matches in a selector.

Cancellation, invalid input, or no match MUST make no state change.

Removal MUST fail closed when authentication status is unavailable. It MUST refuse:

- An authenticated account, instructing `/logout` first.
- The active model's account, instructing `/model` first.

If both apply, both instructions MUST be shown. Successful removal MUST unregister and forget the account atomically without changing credentials, native providers, models, or sessions.

## 4. Native Pi commands

### 4.1 Login

Aliases MUST participate in native `/login`. `/login <alias-id>` MUST authenticate only that alias through native OAuth.

An alias MUST expose OAuth only and MUST NOT use a base provider's credential or API-key environment variable.

`/account add` MUST require the user to submit the prepared `/login <alias-id>` command.

### 4.2 Logout

Aliases MUST participate in native `/logout`, which remains the only credential-removal path. Logout MUST leave the named account registered but unauthenticated.

### 4.3 Model selection

Native `/model` MUST remain the only account/model switching interface. Authenticated alias models MUST appear under the alias ID; unauthenticated alias models MUST be unavailable.

## 5. Alias behavior

Each alias MUST:

- Keep OAuth credentials isolated under its alias ID.
- Expose exactly the native provider's current models with equivalent IDs, names, capabilities, limits, costs, and compatibility behavior.
- Preserve native request behavior.
- Emit the alias ID as the provider on every assistant stream event and finalized assistant message. Pi MUST consequently persist that ID in assistant-message and model-change session entries and attribute their usage to that alias.
- Never fall back to a native or different named account.

Native model catalog changes MUST appear after reload without changing account state.

## 6. Persistence and lifecycle

Named accounts MUST persist across Pi restarts and reloads. State MUST be global across projects and stored at `join(getAgentDir(), "pi-account-manager", "accounts.json")` using this exact version 1 shape:

```json
{
  "version": 1,
  "accounts": [
    { "provider": "anthropic", "name": "work" }
  ]
}
```

The top-level object MUST contain exactly `version` and `accounts`; each account MUST contain exactly `provider` and `name`. Records MUST be canonicalized by provider ID, then name. The file MUST contain no credentials or model/session state. A missing file means an empty account set. Invalid JSON, an unsupported version, unexpected fields, an unsupported provider, an invalid normalized name, or a duplicate pair MUST produce a load error rather than partial recovery.

Extension loading MUST validate every persisted account and bootstrap every alias against Pi 0.82's exact bundled provider factory before exposing any alias. Bootstrap is all-or-none. Before the first user command, `session_start` MUST validate and replace every bootstrap alias against the effective provider registry; that replacement is also all-or-none. If either phase fails, no named alias may remain loaded. `/account` MUST remain available to report the load error, while add and remove MUST refuse changes until a successful reload. Native providers MUST remain usable.

A successful local add or remove MUST update that process immediately. Other running processes MUST retain their loaded snapshot until reload or restart.

Cross-process mutations MUST:

- Complete or fail from contention within five seconds.
- Never overwrite another successful update or expose partial persistent state.
- Reread authoritative state before changing it.
- Abort with a `/reload` instruction when the authoritative normalized account set differs semantically from the process snapshot, including a duplicate appearing or a removal target disappearing.
- Leave persistent and runtime state either both changed or both unchanged.

A successful update means an atomic rename completed during normal filesystem operation. Power-loss durability after that rename is outside version 1.

Externally deleting account state does not delete Pi's credential for its alias ID. Re-adding the same `(provider, name)` recreates the same alias. If Pi still reports that credential as configured, the account MUST immediately be authenticated; otherwise native login is required.

## 7. Sessions

Accounts MUST NOT partition sessions.

Any available native or alias model MUST be selectable in any resumable session. Switching models affects subsequent requests only. Logout or account removal MUST NOT delete or rewrite history.

A session referencing an unavailable alias MUST remain readable and continuable with another model. Re-adding and authenticating the same alias MUST make it available to earlier sessions again.

## 8. Anthropic warning

In TUI mode, selecting or restoring an authenticated `anthropic@<name>` model MUST show this warning at most once per process unless `warnings.anthropicExtraUsage` is explicitly `false` in the merged persisted global and trusted-project settings. The extension MUST read that value with Pi 0.82's `SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() })`. Session-only `SettingsManager.applyOverrides()` values are outside version 1 because Pi 0.82 does not expose its live settings manager to extensions:

```text
Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.
```

Failure to read the setting MUST be treated as warning enabled and MUST NOT block model use.

## 9. Acceptance testing

Automated tests MUST cover:

- Name normalization, validation, command parsing, target resolution, ordering, and every cancellation or refusal path.
- State schema validation, missing/corrupt files, atomic add/remove rollback, lock contention, stale snapshots, and concurrent writers.
- Alias construction from both exact bundled factories and effective providers, OAuth-only isolation, model parity, auth availability, provider attribution, and registration rollback.
- Native login, logout, and model-selection integration; session restore and history behavior; editor preservation; and Anthropic warning suppression and once-per-process behavior.

Tests MUST NOT require live OAuth or provider network access. Test doubles MAY replace interaction, credential-store, and transport boundaries, while contract tests MUST still exercise Pi 0.82's real provider and extension APIs.
