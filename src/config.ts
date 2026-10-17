import { getConfig } from "./configCompat";
import { getAliasPartition } from "./frameworks";

/** Flat alias list, with the legacy createElementAliases override taking precedence. */
export function getAliases(): string[] {
  const partition = getAliasPartition();
  const combined = [...partition.parens, ...partition.curried];
  const fromConfig = getConfig<string[]>("createElementAliases", combined);
  if (!Array.isArray(fromConfig) || fromConfig.length === 0) {
    return combined;
  }
  return fromConfig;
}

export interface AutoImportAlias {
  filesystemPath: string;
  robloxPath: string;
}

export interface AutoImportConfig {
  enabled: boolean;
  style: "relative" | "alias";
  aliases: AutoImportAlias[];
}

export function getAutoImportConfig(): AutoImportConfig {
  return {
    enabled: getConfig<boolean>("autoImport.enabled", false),
    style: getConfig<"relative" | "alias">(
      "autoImport.style",
      "relative"
    ),
    aliases: getConfig<AutoImportAlias[]>("autoImport.aliases", []) ?? [],
  };
}
