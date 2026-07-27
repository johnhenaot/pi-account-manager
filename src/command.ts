import { type Account, accountId, isValidName, normalizeName, sortForDisplay } from "./account.ts";

export type Command =
	| { kind: "list" }
	| { kind: "add"; name?: string }
	| { kind: "remove"; target?: string }
	| { kind: "usage" };

export const USAGE = [
	"Usage:",
	"  /account                        list named accounts",
	"  /account list                   list named accounts",
	"  /account add [name]             add a named account",
	"  /account remove [name|alias-id] remove a named account",
].join("\n");

export function parseCommand(args: string): Command {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "list" };
	if (tokens.length > 2) return { kind: "usage" };
	const [head, argument] = tokens;
	if (head === "list") return argument === undefined ? { kind: "list" } : { kind: "usage" };
	if (head === "add") return { kind: "add", name: argument };
	if (head === "remove") return { kind: "remove", target: argument };
	return { kind: "usage" };
}

export type RemoveTarget =
	| { kind: "one"; account: Account }
	| { kind: "choose"; accounts: Account[] }
	| { kind: "none" };

export function resolveRemoveTarget(accounts: readonly Account[], argument: string | undefined): RemoveTarget {
	const loaded = sortForDisplay(accounts);
	if (argument === undefined) return loaded.length === 0 ? { kind: "none" } : { kind: "choose", accounts: loaded };

	const exact = loaded.find((account) => accountId(account) === argument);
	if (exact) return { kind: "one", account: exact };

	const name = normalizeName(argument);
	if (!isValidName(name)) return { kind: "none" };
	const matches = loaded.filter((account) => account.name === name);
	if (matches.length === 0) return { kind: "none" };
	if (matches.length === 1) return { kind: "one", account: matches[0] };
	return { kind: "choose", accounts: matches };
}
