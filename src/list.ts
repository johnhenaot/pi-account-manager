import { type Account, accountId, PROVIDERS, sortForDisplay } from "./account.ts";

export const EMPTY_LIST = "No named accounts. Use /account add NAME.";

export function formatList(accounts: readonly Account[], status: (account: Account) => string): string {
	if (accounts.length === 0) return EMPTY_LIST;
	const rows = [
		["NAME", "PROVIDER", "ALIAS ID", "STATUS"],
		...sortForDisplay(accounts).map((account) => [
			account.name,
			PROVIDERS[account.provider],
			accountId(account),
			status(account),
		]),
	];
	const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
	// trimEnd drops the trailing pad, so the last column needs no special case.
	return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}
