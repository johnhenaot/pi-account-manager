import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Account, parseState, sameAccounts, serializeState, sortAccounts } from "./core.js";

export const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30_000;

export class StaleSnapshotError extends Error {}

export async function loadAccounts(file: string): Promise<Account[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  try {
    return parseState(text);
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
}

// ponytail: O_EXCL lockfile + 100ms polling; proper fcntl locks if this ever needs more than "two pi processes".
async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const mtime = await stat(lock).then(
        (s) => s.mtimeMs,
        () => undefined,
      );
      if (mtime !== undefined && Date.now() - mtime > STALE_LOCK_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("accounts.json is locked by another process; try again shortly");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

/**
 * Locked read-modify-write (spec §6). Rereads authoritative state, aborts on
 * semantic mismatch with the caller's snapshot, atomic-renames the new state.
 */
export async function mutateAccounts(
  file: string,
  snapshot: readonly Account[],
  change: (current: Account[]) => Account[],
): Promise<Account[]> {
  return withLock(file, async () => {
    const current = await loadAccounts(file);
    if (!sameAccounts(current, snapshot)) {
      throw new StaleSnapshotError(
        "Account state changed outside this process. Run /reload, then retry.",
      );
    }
    const next = sortAccounts(change(current));
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, serializeState(next), "utf8");
    await rename(tmp, file);
    return next;
  });
}
