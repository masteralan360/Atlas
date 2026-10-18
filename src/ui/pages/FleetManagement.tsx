import { Car, History, MapPinned, Route, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness';

import { useAuth } from "@/auth";
import { useWorkspacePermissions } from "@/permissions";
import {
  FleetAssignmentsPanel,
  FleetHistoryPanel,
  FleetLiveMap,
  FleetVehiclesPanel,
} from "@/ui/components/fleet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/ui/components";
import { useWorkspace } from "@/workspace/WorkspaceContext";

export function FleetManagement() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { isLocalMode, isDemoMode } = useWorkspace();
  const { hasPermission } = useWorkspacePermissions();
  const workspaceId = user?.workspaceId;
  const canViewLive = hasPermission("fleet.viewLiveLocations");
  const canViewHistory = hasPermission("fleet.viewHistory");
  const canManageVehicles = hasPermission("fleet.manageVehicles");
  const canManageAssignments = hasPermission("fleet.manageAssignments");
  const defaultTab = canViewLive ? "live" : "vehicles";

  if (!workspaceId) {
    return null;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <MapPinned className="h-6 w-6 text-primary" />
          {t("fleet.title")}
        </h1>
        <p className="text-muted-foreground">
          {t("fleet.subtitle")} <ModulePageFreshness className="ms-2" />
        </p>
      </div>
      {(isLocalMode || isDemoMode) && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
          {t("fleet.localWorkspaceNotice")}
        </div>
      )}
      <Tabs defaultValue={defaultTab}>
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:w-auto sm:grid-cols-4">
          {canViewLive && (
            <TabsTrigger value="live">
              <Route className="mr-2 h-4 w-4" />
              {t("fleet.tabs.liveMap")}
            </TabsTrigger>
          )}
          <TabsTrigger value="vehicles">
            <Car className="mr-2 h-4 w-4" />
            {t("fleet.tabs.vehicles")}
          </TabsTrigger>
          <TabsTrigger value="assignments">
            <Users className="mr-2 h-4 w-4" />
            {t("fleet.tabs.assignments")}
          </TabsTrigger>
          {canViewHistory && (
            <TabsTrigger value="history">
              <History className="mr-2 h-4 w-4" />
              {t("fleet.tabs.history")}
            </TabsTrigger>
          )}
        </TabsList>
        {canViewLive && (
          <TabsContent value="live" className="mt-4">
            {isLocalMode || isDemoMode ? (
              <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
                {t("fleet.liveTrackingUnavailable")}
              </div>
            ) : (
              <FleetLiveMap workspaceId={workspaceId} />
            )}
          </TabsContent>
        )}
        <TabsContent value="vehicles" className="mt-4">
          <FleetVehiclesPanel
            workspaceId={workspaceId}
            canManage={canManageVehicles}
          />
        </TabsContent>
        <TabsContent value="assignments" className="mt-4">
          <FleetAssignmentsPanel
            workspaceId={workspaceId}
            canManage={canManageAssignments}
          />
        </TabsContent>
        {canViewHistory && (
          <TabsContent value="history" className="mt-4">
            {isLocalMode || isDemoMode ? (
              <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
                {t("fleet.historyUnavailable")}
              </div>
            ) : (
              <FleetHistoryPanel workspaceId={workspaceId} />
            )}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
