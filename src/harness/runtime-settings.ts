import { join, resolve } from "node:path";
import { getAgentDir, CONFIG_DIR_NAME, SettingsManager } from "@earendil-works/pi-coding-agent";
import { canonicalJson, cloneJson } from "../core/json.ts";
import { mergeManagedSettings, RSIH_MANAGED_MARKER, withConfigurationFile } from "./settings-layer.ts";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parse(contents) {
  const value = contents === undefined ? {} : JSON.parse(contents.replace(/^\uFEFF/, ""));
  if (!object(value)) throw new Error("Pi settings must contain a JSON object.");
  return value;
}

/** Apply only user edits, preserving other processes' unrelated preference edits. */
function applyChanges(current, before, after, excluded = new Set()) {
  const result = cloneJson(current);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (excluded.has(key) || canonicalJson(before[key]) === canonicalJson(after[key])) continue;
    if (!(key in after)) {
      if (object(before[key]) && object(result[key])) {
        const remaining = applyChanges(result[key], before[key], {});
        if (Object.keys(remaining).length) result[key] = remaining;
        else delete result[key];
      } else delete result[key];
    } else if (object(after[key]) && (before[key] === undefined || object(before[key]))) {
      result[key] = applyChanges(object(result[key]) ? result[key] : {}, before[key] ?? {}, after[key]);
    } else result[key] = cloneJson(after[key]);
  }
  return result;
}

/**
 * A process-local Genome overlay. Auth, sessions and resource discovery keep
 * Pi's ordinary agent directory; only settings read/write behavior is scoped.
 * Pi CLI 0.84.3 accepts extension factories but no settings factory. Until it
 * exposes that seam, intercept its public SettingsManager.create for the CLI
 * lifetime and restore it afterwards. No dependency files or private fields
 * are modified. runPiCli already owns process.cwd and runs once per process.
 */
export function createRuntimeSettings(agentDirectory = getAgentDir()) {
  const directory = resolve(agentDirectory);
  let patch = {};
  let bindings = {};
  let stamp = {};
  const managers = new Set();
  const boundKeybindings = new WeakSet();
  let installed = false;

  function storage(cwd) {
    let observedGlobal;
    return {
      withLock(scope, update) {
        const path = scope === "global"
          ? join(directory, "settings.json")
          : join(resolve(cwd), CONFIG_DIR_NAME, "settings.json");
        withConfigurationFile(path, (contents) => {
          if (scope === "project") return update(contents);
          // Strip legacy on-disk projections before inheriting user defaults.
          const defaults = mergeManagedSettings(parse(contents), {}, {});
          const effective = mergeManagedSettings(defaults, patch, stamp);
          const next = update(JSON.stringify(effective));
          if (next === undefined) {
            observedGlobal = effective;
            return undefined;
          }
          const after = parse(next);
          const changed = applyChanges(defaults, observedGlobal ?? effective, after,
            new Set([RSIH_MANAGED_MARKER, ...Object.keys(patch)]));
          observedGlobal = after;
          return canonicalJson(changed) === canonicalJson(defaults)
            ? undefined : `${JSON.stringify(changed, null, 2)}\n`;
        });
      },
    };
  }

  return {
    apply(configuration) {
      patch = cloneJson(configuration.settings ?? {});
      bindings = cloneJson(configuration.keybindings ?? {});
      stamp = cloneJson(configuration.stamp ?? {});
    },
    bindKeybindings(manager) {
      if (boundKeybindings.has(manager)) return;
      boundKeybindings.add(manager);
      const reload = manager.reload.bind(manager);
      manager.reload = () => {
        reload();
        manager.setUserBindings({ ...manager.getEffectiveConfig(), ...bindings });
      };
      manager.reload();
    },
    async flush() {
      await Promise.all([...managers].map(manager => manager.flush()));
    },
    async run(action) {
      if (installed) throw new Error("A runtime settings scope cannot be entered twice.");
      installed = true;
      const originalCreate = SettingsManager.create;
      const create = (cwd, agentDir = getAgentDir(), options = {}) => {
        if (resolve(agentDir) !== directory) return originalCreate.call(SettingsManager, cwd, agentDir, options);
        const manager = SettingsManager.fromStorage(storage(cwd), options);
        managers.add(manager);
        return manager;
      };
      SettingsManager.create = create;
      try {
        return await action();
      } finally {
        try {
          await Promise.all([...managers].map(manager => manager.flush()));
        } finally {
          SettingsManager.create = originalCreate;
          installed = false;
        }
      }
    },
  };
}
