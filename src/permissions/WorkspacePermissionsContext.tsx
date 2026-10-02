import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useAuth } from "@/auth";
import { isSupabaseConfigured, supabase } from "@/auth/supabase";
import { useWorkspace } from "@/workspace";
import {
  isSupportedWorkspacePermissionKey,
  type WorkspacePermissionKey,
} from "./workspacePermissionDefinitions";
import {
  normalizeSupabaseActionError,
  runSupabaseAction,
} from "@/lib/supabaseRequest";
import {
  readCachedPermissions,
  writeCachedPermissions,
} from "./workspacePermissionCache";
import { getLocalModeSqliteConnection } from "@/local-db/localModeSqlite";
import {
  WorkspacePermissionsContext,
} from "./workspacePermissionsState";

import { resolveWorkspacePermission } from "./resolveWorkspacePermission";

export function WorkspacePermissionsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { user, isAuthenticated } = useAuth();
  const { hasCapability, isLocalMode } = useWorkspace();
  const [permissionKeys, setPermissionKeys] = useState<WorkspacePermissionKey[]>(
    [],
  );
  const [isLoading, setIsLoading] = useState(false);

  const workspaceId = user?.workspaceId ?? "";
  const userId = user?.id ?? "";
  const userRole = user?.role;
  const permissionsEnabled = hasCapability("workspaceManagementPermissions");

  const refreshPermissions = useCallback(async () => {
    if (!isAuthenticated || !workspaceId || !userId || !permissionsEnabled) {
      setPermissionKeys([]);
      setIsLoading(false);
      return;
    }

    if (userRole === "admin") {
      setPermissionKeys([]);
      setIsLoading(false);
      return;
    }

    if (isLocalMode || !isSupabaseConfigured) {
      if (isLocalMode) {
        const connection = await getLocalModeSqliteConnection()
        const keys: WorkspacePermissionKey[] = []
        if (connection) {
          const entities = await connection.select<Array<{
            entity_id: string
            payload: string
          }>>(
            `SELECT entity_id, payload
             FROM local_entities
             WHERE entity_type = 'workspace_permissions'
               AND workspace_id = $1
               AND json_extract(payload, '$.userUuid') = $2`,
            [workspaceId, userId]
          )
          for (const entity of entities) {
            const data = JSON.parse(entity.payload) as Record<string, unknown>
            if (typeof data.key === 'string' && isSupportedWorkspacePermissionKey(data.key)) {
              keys.push(data.key)
            }
          }
        }
        setPermissionKeys(keys);
        writeCachedPermissions(workspaceId, userId, keys);
      } else {
        const cached = readCachedPermissions(workspaceId, userId);
        setPermissionKeys(cached);
      }
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const { data, error } = (await runSupabaseAction(
        "workspacePermissions.fetchMine",
        () =>
          supabase
            .from("workspace_permissions")
            .select("key")
            .eq("workspace_id", workspaceId)
            .eq("user_uuid", userId),
        { timeoutMs: 8000, platform: "all" },
      )) as {
        data: Array<{ key: string }> | null;
        error?: unknown;
      };

      if (error) {
        throw error;
      }

      const nextKeys = (data ?? [])
        .map((row) => row.key)
        .filter(isSupportedWorkspacePermissionKey);

      setPermissionKeys(nextKeys);
      writeCachedPermissions(workspaceId, userId, nextKeys);
    } catch (error) {
      const normalized = normalizeSupabaseActionError(error);
      console.warn("[Permissions] Failed to fetch workspace permissions:", normalized);
      if (permissionKeys.length === 0) {
        setPermissionKeys([]);
      }
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated, isLocalMode, permissionsEnabled, userId, userRole, workspaceId]);

  useEffect(() => {
    void refreshPermissions();
  }, [refreshPermissions]);

  useEffect(() => {
    if (
      !isSupabaseConfigured ||
      isLocalMode ||
      !isAuthenticated ||
      !workspaceId ||
      !userId ||
      !permissionsEnabled ||
      userRole === "admin"
    ) {
      return;
    }

    const channel = supabase
      .channel(`workspace-permissions-${workspaceId}-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "workspace_permissions",
          filter: `user_uuid=eq.${userId}`,
        },
        () => {
          void refreshPermissions();
        },
      )
      .subscribe();

    const handlePermissionsChanged = () => {
      void refreshPermissions();
    };

    window.addEventListener(
      "workspace-permissions:changed",
      handlePermissionsChanged,
    );

    return () => {
      supabase.removeChannel(channel);
      window.removeEventListener(
        "workspace-permissions:changed",
        handlePermissionsChanged,
      );
    };
  }, [isAuthenticated, isLocalMode, permissionsEnabled, refreshPermissions, userId, userRole, workspaceId]);

  const permissionSet = useMemo(
    () => new Set<WorkspacePermissionKey>(permissionKeys),
    [permissionKeys],
  );

  const hasPermission = useCallback(
    (permission: WorkspacePermissionKey) => {
      return resolveWorkspacePermission(userRole, permissionsEnabled, permissionSet, permission);
    },
    [permissionSet, permissionsEnabled, userRole],
  );

  return (
    <WorkspacePermissionsContext.Provider
      value={{
        permissionKeys,
        isLoading,
        hasPermission,
        refreshPermissions,
      }}
    >
      {children}
    </WorkspacePermissionsContext.Provider>
  );
}

export function useWorkspacePermissions() {
  const context = useContext(WorkspacePermissionsContext);
  if (context === undefined) {
    throw new Error(
      "useWorkspacePermissions must be used within WorkspacePermissionsProvider",
    );
  }
  return context;
}

export { useOptionalWorkspacePermissions } from "./workspacePermissionsState";
