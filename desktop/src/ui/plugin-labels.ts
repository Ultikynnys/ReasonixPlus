import type { PluginInfo } from "../protocol";

/** A plugin's manifest qualifier: its marketplace category, then its version. */
export function pluginQualifier(plugin: PluginInfo): string {
  return [plugin.category, plugin.version].filter(Boolean).join(" - ");
}
