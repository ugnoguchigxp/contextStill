import {
  ensureRuntimeSettingsLoaded,
  getRuntimeSettingsSnapshot,
  invalidateRuntimeSettingsCache,
  reloadRuntimeSettingsCache,
} from "./settings.service.js";

export type RuntimeSettingsCacheState = {
  loadedAt: Date | null;
  version: number;
};

const cacheState: RuntimeSettingsCacheState = {
  loadedAt: null,
  version: 0,
};

export async function getRuntimeSettings() {
  await ensureRuntimeSettingsLoaded();
  if (!cacheState.loadedAt) {
    cacheState.loadedAt = new Date();
    cacheState.version += 1;
  }
  return getRuntimeSettingsSnapshot();
}

export function readRuntimeSettingsSnapshot() {
  return getRuntimeSettingsSnapshot();
}

export function readRuntimeSettingsCacheState(): RuntimeSettingsCacheState {
  return { ...cacheState };
}

export function invalidateRuntimeSettings(): void {
  invalidateRuntimeSettingsCache();
  cacheState.loadedAt = null;
  cacheState.version += 1;
}

export async function reloadRuntimeSettings(): Promise<void> {
  await reloadRuntimeSettingsCache();
  cacheState.loadedAt = new Date();
  cacheState.version += 1;
}

