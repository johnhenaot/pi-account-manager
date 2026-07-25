import type { Provider } from "@earendil-works/pi-ai";
import { vi } from "vitest";

/** Captures registrations; enough ExtensionAPI surface for this extension. */
export function makeFakePi() {
  const providers = new Map<string, Provider>();
  const commands = new Map<
    string,
    { description?: string; handler: (args: string, ctx: any) => Promise<void> }
  >();
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const pi = {
    registerProvider: vi.fn((p: Provider) => {
      providers.set(p.id, p);
    }),
    unregisterProvider: vi.fn((id: string) => {
      providers.delete(id);
    }),
    registerCommand: vi.fn((name: string, opts: any) => {
      commands.set(name, opts);
    }),
    on: vi.fn((event: string, handler: any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
  };
  return {
    // `any`, not `never`: tests reach through this for `.mockImplementationOnce` (Task 7).
    pi: pi as any,
    providers,
    commands,
    emit: async (event: string, eventArg: any, ctx: any) => {
      for (const h of handlers.get(event) ?? []) await h(eventArg, ctx);
    },
    account: (args: string, ctx: any) => commands.get("account")!.handler(args, ctx),
  };
}

export interface FakeCtxOptions {
  mode?: string;
  cwd?: string;
  /** provider id -> Provider for modelRegistry.getProvider */
  registry?: Map<string, Provider>;
  /** provider id -> boolean (configured) | "throw" | "indeterminate" */
  authStatus?: Map<string, boolean | "throw" | "indeterminate">;
  /** scripted answers for ui.input then ui.select, consumed in order */
  inputs?: (string | undefined)[];
  selections?: (string | undefined)[];
  activeModelProvider?: string;
  editorText?: string;
  projectTrusted?: boolean;
}

export function makeFakeCtx(opts: FakeCtxOptions = {}) {
  const notifications: { message: string; type?: string }[] = [];
  const inputs = [...(opts.inputs ?? [])];
  const selections = [...(opts.selections ?? [])];
  let editorText = opts.editorText ?? "";
  const ctx = {
    mode: opts.mode ?? "tui",
    cwd: opts.cwd ?? "/tmp",
    isProjectTrusted: () => opts.projectTrusted ?? false,
    model: opts.activeModelProvider ? { provider: opts.activeModelProvider } : undefined,
    modelRegistry: {
      getProvider: (id: string) => opts.registry?.get(id),
      getProviderAuthStatus: (id: string) => {
        const v = opts.authStatus?.get(id);
        if (v === "throw") throw new Error("auth store unavailable");
        if (v === "indeterminate" || v === undefined) return undefined as never;
        return { configured: v };
      },
    },
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      input: async () => inputs.shift(),
      select: async () => selections.shift(),
      getEditorText: () => editorText,
      setEditorText: (t: string) => {
        editorText = t;
      },
    },
  };
  return { ctx: ctx as never as any, notifications, getEditor: () => editorText };
}
