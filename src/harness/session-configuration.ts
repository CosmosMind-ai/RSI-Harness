import { readFileSync } from "node:fs";
import { applyManagedConfiguration } from "./settings-layer.ts";
import {
  configurationEquals,
  createConfigurationSnapshot,
  findLatestSnapshot,
  sessionBranchEntries,
} from "./configuration-snapshot.ts";

function readBranch(path) {
  const entries = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  return sessionBranchEntries(entries);
}

/** Session history selects the patch; the existing compiler still owns file writes. */
export function createSessionConfiguration({ agentDirectory, baseSettings, projection, stamp, preferCurrentOnStartup }) {
  let current = createConfigurationSnapshot(projection.settings, projection.keybindings, stamp);
  let pendingReload;

  function apply(snapshot) {
    current = createConfigurationSnapshot(snapshot.settings, snapshot.keybindings, snapshot.stamp);
    applyManagedConfiguration({
      agentDirectory,
      settings: { ...baseSettings, ...current.settings },
      keybindings: current.keybindings,
      stamp: current.stamp,
    });
  }

  function restore(entries) {
    const saved = findLatestSnapshot(entries);
    if (!saved || configurationEquals(current, saved)) return false;
    apply(saved);
    return true;
  }

  function reload(pi) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingReload = undefined;
        reject(new Error("The configuration restore command was not dispatched."));
      }, 5000);
      pendingReload = { resolve, reject, timer };
      // Pi exposes runtime replacement only to command contexts.
      pi.sendUserMessage("/restore-configuration", { expandPromptTemplates: true });
    });
  }

  return {
    apply(projection, stamp = current.stamp) {
      apply(createConfigurationSnapshot(projection.settings, projection.keybindings, stamp));
    },
    bind(pi) {
      pi.registerCommand("restore-configuration", {
        description: "Restore the settings and keybindings saved on the current branch",
        async handler(_args, ctx) {
          const pending = pendingReload;
          pendingReload = undefined;
          if (pending) clearTimeout(pending.timer);
          try {
            if (!pending) {
              const saved = findLatestSnapshot(ctx.sessionManager.getBranch());
              if (!saved) return;
              apply(saved);
            }
            const file = ctx.sessionManager.getSessionFile();
            if (file) {
              const editor = ctx.mode === "tui" ? ctx.ui.getEditorText() : undefined;
              const result = await ctx.switchSession(file, editor === undefined ? undefined : {
                withSession: async nextCtx => nextCtx.ui.setEditorText(editor),
              });
              if (result.cancelled) throw new Error("Configuration restore was cancelled.");
            } else await ctx.reload();
            pending?.resolve();
          } catch (error) {
            if (pending) pending.reject(error);
            else throw error;
          }
        },
      });
      pi.on("session_before_switch", event => {
        if (event.reason === "resume" && event.targetSessionFile) restore(readBranch(event.targetSessionFile));
      });
      pi.on("session_before_fork", (event, ctx) => {
        const entries = ctx.sessionManager.getEntries();
        const target = entries.find(entry => entry.id === event.entryId);
        if (target) restore(sessionBranchEntries(entries,
          event.position === "at" ? target.id : target.parentId ?? null));
      });
      pi.on("session_tree", async (_event, ctx) => {
        if (!restore(ctx.sessionManager.getBranch())) return;
        // Persist the selected ancestry before another process opens this file.
        pi.appendEntry("rsih.branch", {});
        await reload(pi);
      });
    },
    async start(pi, event, ctx) {
      if (event.reason === "startup" && !preferCurrentOnStartup && restore(ctx.sessionManager.getBranch())) {
        await reload(pi);
        return true;
      }
      return false;
    },
    save(pi, entries) {
      if (!configurationEquals(current, findLatestSnapshot(entries))) {
        pi.appendEntry("rsih.configuration", current);
      }
    },
  };
}
