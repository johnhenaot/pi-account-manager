import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Optional offline verification with the actual adapters from the reviewed Pi
// source. No downloads, dependency upgrades, installed-Pi changes, or live HTTP.
// Usage: node test/fixtures/prepare-upstream-simulation.mjs /path/to/pi-checkout
// Then run the printed command. Other adapter dependencies remain pinned 1.2.0.
const ref = "b45e0ebcc5ae2fc42a6f2f23104d10e656e6bedb";
const checkout = process.argv[2];
if (!checkout) throw new Error("Supply a local upstream Pi checkout path");
execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], { cwd: checkout });

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = join(root, "node_modules/@earendil-works/pi-ai/dist");
const output = join(root, ".worktrees/upstream-simulation");
await mkdir(output, { recursive: true });
for (const filename of ["openai-responses.ts", "openai-responses-shared.ts"]) {
	// Read the pinned commit, regardless of local edits/current branch.
	const source = execFileSync("git", ["show", `${ref}:packages/ai/src/api/${filename}`], {
		cwd: checkout, encoding: "utf8",
	});
	const wired = source.replace(/from "(\.[^"]+)"/g, (_whole, specifier) => {
		const target = specifier === "./openai-responses-shared.ts"
			? join(output, "openai-responses-shared.mjs")
			: resolve(dist, "api", specifier.replace(/\.ts$/, ".js"));
		return `from ${JSON.stringify(target)}`;
	});
	// Only rewire imports and erase types; keep the actual request builder,
	// transcript conversion, simple-stream path, and stream parser intact.
	const result = ts.transpileModule(wired, { compilerOptions: {
		target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true,
	} });
	await writeFile(join(output, filename.replace(/\.ts$/, ".mjs")), result.outputText);
}

const fixture = "./fixtures/openai-responses-effort.ts";
const adapter = join(output, "openai-responses.mjs");
await writeFile(join(output, "vitest.config.mjs"), `export default {
	resolve: { alias: [{ find: ${JSON.stringify(fixture)}, replacement: ${JSON.stringify(adapter)} }] },
};\n`);
console.log(`Actual upstream adapters: ${ref}; supporting dependencies: locked Pi 1.2.0`);
console.log("npm test -- --config .worktrees/upstream-simulation/vitest.config.mjs test/openai-effort.test.ts");
