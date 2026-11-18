import {
  isSupportedWorkspacePermissionKey,
  type WorkspacePermissionKey,
} from "./workspacePermissionDefinitions";

function getCacheKey(workspaceId: string, userId: string) {
  return `atlas_workspace_permissions:${workspaceId}:${userId}`;
}

export function hasCachedPermissions(workspaceId: string, userId: string) {
  return typeof localStorage !== "undefined"
    && localStorage.getItem(getCacheKey(workspaceId, userId)) !== null;
}

export function readCachedPermissions(
  workspaceId: string,
  userId: string,
): WorkspacePermissionKey[] {
  if (typeof localStorage === "undefined") {
    return [];
  }

  try {
    const raw = localStorage.getItem(getCacheKey(workspaceId, userId));
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (key): key is WorkspacePermissionKey =>
        typeof key === "string" && isSupportedWorkspacePermissionKey(key),
    );
  } catch (error) {
    console.warn("[Permissions] Failed to read cached permissions:", error);
    return [];
  }
}

export function writeCachedPermissions(
  workspaceId: string,
  userId: string,
  keys: readonly string[],
) {
  if (typeof localStorage === "undefined") {
    return;
  }

  const supportedKeys = keys.filter(isSupportedWorkspacePermissionKey);

  try {
    localStorage.setItem(
      getCacheKey(workspaceId, userId),
      JSON.stringify(supportedKeys),
    );
  } catch (error) {
    console.warn("[Permissions] Failed to cache permissions:", error);
  }
}

export function clearCachedPermissionsForWorkspace(workspaceId: string) {
  if (typeof localStorage === "undefined" || !workspaceId) {
    return;
  }

  const prefix = `atlas_workspace_permissions:${workspaceId}:`;
  const keysToRemove: string[] = [];

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) {
      keysToRemove.push(key);
    }
  }

  keysToRemove.forEach((key) => localStorage.removeItem(key));
}
