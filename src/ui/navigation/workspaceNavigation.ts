import type { TFunction } from "i18next";
import {
  ArrowRightLeft,
  Car,
  Plane,
  BarChart3,
  Boxes,
  Building2,
  BriefcaseBusiness,
  Calculator,
  CalendarClock,
  CircleHelp,
  Copy,
  CreditCard,
  FileSpreadsheet,
  FileText,
  FileWarning,
  HandCoins,
  History,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Monitor,
  Package,
  PackageCheck,
  Pen,
  Percent,
  Receipt,
  Settings,
  Store,
  ShoppingCart,
  TrendingUp,
  Truck,
  Users,
  UserRound,
  MapPinned,
  LocateFixed,
  UsersRound,
  Upload,
  Warehouse,
  Vault,
  Wallet,
  Zap,
  Ruler,
} from "lucide-react";
import type { WorkspaceFeatures } from "@/workspace";
import type { ModuleFeatureKey } from "@/workspace/WorkspaceContext";
import type { WorkspacePermissionKey } from "@/permissions";
import type { ClinicalRegistryType } from "@/local-db/models";
import { supportsClinicalPatientsAndServicePresets } from "@/i18n/clinicalRegistry";

export interface WorkspaceNavigationChild {
  name: string;
  href: string;
  icon?: LucideIcon;
}

export interface WorkspaceNavigationItem {
  name: string;
  href: string;
  icon: LucideIcon;
  status?: string;
  alert?: boolean;
  mobileOnly?: boolean;
  popup?: boolean;
  children?: WorkspaceNavigationChild[];
}

export interface WorkspaceNavigationGroup {
  sectionKey?: NavigationSectionKey;
  title: string;
  items: WorkspaceNavigationItem[];
  icon: LucideIcon;
}

export interface FlattenedWorkspaceNavigationItem {
  name: string;
  href: string;
  icon: LucideIcon;
  mobileOnly?: boolean;
  parentHref?: string;
}

interface BuildWorkspaceNavigationOptions {
  t: TFunction;
  role?: string;
  hasFeature: (feature: ModuleFeatureKey) => boolean;
  hasPermission?: (permission: WorkspacePermissionKey) => boolean;
  features: WorkspaceFeatures;
  clinicalRegistryType?: ClinicalRegistryType;
  isDesktopDevice: boolean;
  whatsappStatus?: "live" | "off";
}

import {
  launcherSectionOrder,
  launcherSections,
  moduleMetaByHref,
  type NavigationSectionKey,
} from "./navigationMeta";

export function buildWorkspaceNavigation({
  t,
  role,
  hasFeature,
  hasPermission,
  features,
  clinicalRegistryType = "medical",
  isDesktopDevice,
  whatsappStatus,
}: BuildWorkspaceNavigationOptions): WorkspaceNavigationGroup[] {
  const isCoreRole = role === "admin" || role === "staff" || role === "viewer";
  const canAccessPermission = hasPermission ?? (() => true);

  const canUseEcommerce =
    features.data_mode !== "local" &&
    features.data_mode !== "demo" &&
    hasFeature("ecommerce");
  const canAccessSuppliers =
    canAccessPermission("suppliers.access")
    && (!features.suppliers_admin_only || role === "admin");

  // 1. Define all possible individual navigation items with their visibility logic
  const dashboardItem: WorkspaceNavigationItem = {
    name: t("nav.dashboard", { defaultValue: "Dashboard" }),
    href: "/",
    icon: LayoutDashboard,
  };

  const helpItem: WorkspaceNavigationItem = {
    name: t("nav.help", { defaultValue: "Help" }),
    href: "/help",
    icon: CircleHelp,
  };

  const otherItems: WorkspaceNavigationItem[] = [
    ...(isCoreRole && hasFeature("pos") && canAccessPermission("pos.access")
      ? [
        {
          name: t("nav.pos", { defaultValue: "Point of Sale" }),
          href: "/pos",
          icon: CreditCard,
        },
      ]
      : []),
    ...(isCoreRole && hasFeature("instant_pos") && canAccessPermission("instantPos.access")
      ? [
        {
          name: t("nav.instantPos", { defaultValue: "Instant POS" }),
          href: "/instant-pos",
          icon: Zap,
        },
      ]
      : []),
    ...(isCoreRole && hasFeature("kds")
      ? [
        {
          name: t("nav.kdsDashboard", { defaultValue: "KDS Dashboard" }),
          href: "/kds",
          icon: Monitor,
        },
      ]
      : []),
    ...(hasFeature("sales_history") && canAccessPermission("salesHistory.access")
      ? [
        {
          name: t("nav.sales", { defaultValue: "Sales History" }),
          href: "/sales",
          icon: Receipt,
        },
      ]
      : []),
    ...(isCoreRole && hasFeature("crm")
      ? [
        ...(canAccessPermission("businessPartners.access") ||
        canAccessPermission("customers.access") ||
        canAccessSuppliers
          ? [
            {
              name: t("businessPartners.title", {
                defaultValue: "Business Partners",
              }),
              href: "/business-partners",
              icon: UsersRound,
              children: [
                ...(canAccessPermission("customers.access")
                  ? [
                    {
                      name: t("nav.customers", { defaultValue: "Customers" }),
                      href: "/customers",
                      icon: Users,
                    },
                  ]
                  : []),
                ...(canAccessSuppliers
                  ? [
                    {
                      name: t("nav.suppliers", { defaultValue: "Suppliers" }),
                      href: "/suppliers",
                      icon: Truck,
                    },
                  ]
                  : []),
                ...(canAccessPermission("businessPartners.access")
                  ? [
                    {
                      name: t("businessPartners.accountStatement.title", { defaultValue: "Account Statement" }),
                      href: "/business-partners/account-statement",
                      icon: FileText,
                    },
                  ]
                  : []),
                ...(canUseEcommerce && canAccessPermission("ecommerce.access")
                  ? [
                    {
                      name: t("nav.onlineCustomers", { defaultValue: "Online Customers" }),
                      href: "/online-customers",
                      icon: Users,
                    },
                  ]
                  : []),
              ],
            },
          ]
          : []),
        ...(hasFeature("orders") && (canAccessPermission("orders.saleOrdersAccess") || (canAccessSuppliers && canAccessPermission("orders.purchaseOrdersAccess")))
          ? [
            {
              name: t("nav.orders", { defaultValue: "Orders" }),
              href: "/orders",
              icon: ShoppingCart,
              children: [
                ...(canAccessPermission("orders.saleOrdersAccess")
                  ? [{
                    name: t("nav.saleOrders", { defaultValue: "Sale Orders" }),
                    href: "/orders/sales",
                    icon: ShoppingCart,
                  }]
                  : []),
                ...(canAccessSuppliers && canAccessPermission("orders.purchaseOrdersAccess")
                  ? [{
                    name: t("nav.purchaseOrders", { defaultValue: "Purchase Orders" }),
                    href: "/orders/purchase",
                    icon: Truck,
                  }]
                  : []),
              ],
            },
          ]
          : []),
      ]
      : []),
    ...(isCoreRole && canUseEcommerce && canAccessPermission("ecommerce.access")
      ? [
        {
          name: t("nav.ecommerce", { defaultValue: "E-Commerce" }),
          href: "/ecommerce",
          icon: Store,
        },
      ]
      : []),
    ...(isCoreRole && hasFeature("agents") && canAccessPermission("agents.access")
      ? [
        {
          name: t("agents.title", { defaultValue: "Agents" }),
          href: "/agents",
          icon: UserRound,
          children: [
            ...(hasFeature("sales_agent_commissions")
              && (
                canAccessPermission("salesAgentCommissions.viewAll")
                || canAccessPermission("salesAgentCommissions.viewOwn")
                || canAccessPermission("salesAgentCommissions.pay")
              )
              ? [{
                name: t("salesAgentCommissions.title", { defaultValue: "Sales Agent Commissions" }),
                href: "/agents/commissions",
                icon: HandCoins,
              }]
              : []),
            ...(canAccessPermission("fleet.access")
              ? [{
                name: t("fleet.title", { defaultValue: "Fleet Management" }),
                href: "/agents/fleet",
                icon: MapPinned,
              }]
              : []),
          ],
        },
      ]
      : []),
    ...(isCoreRole && hasFeature("post_service") && canAccessPermission("postService.access")
      ? [
        {
          name: t("nav.postService", { defaultValue: "Post Service" }),
          href: "/post-service",
          icon: PackageCheck,
        },
      ]
      : []),
    ...(isCoreRole && hasFeature("car_rental") && canAccessPermission("carRental.access")
      ? [
        {
          name: t("carRental.title"),
          href: "/car-rental",
          icon: Car,
          children: [
            {
              name: t("carRental.tabs.vehicles"),
              href: "/car-rental/vehicles",
              icon: Car,
            },
            {
              name: t("carRental.tabs.requests"),
              href: "/car-rental/requests",
              icon: CalendarClock,
            },
            {
              name: t("carRental.tabs.contracts"),
              href: "/car-rental/contracts",
              icon: FileText,
            },
          ],
        },
      ]
      : []),
    ...(isCoreRole && hasFeature("travel_transportation") && canAccessPermission("travelTransportation.access")
      ? [
        {
          name: t("travelTransportation.title", { defaultValue: "Travel & Transportation" }),
          href: "/travel-transportation",
          icon: Plane,
        },
      ]
      : []),
    ...(isCoreRole &&
      hasFeature("agents") &&
      !canAccessPermission("agents.access") &&
      canAccessPermission("fleet.access")
      ? [
        {
          name: t("fleet.title", { defaultValue: "Fleet Management" }),
          href: "/agents/fleet",
          icon: MapPinned,
        },
      ]
      : []),
    ...(isCoreRole && hasFeature("agents") && canAccessPermission("fleet.shareLocation")
      ? [
        {
          name: t("fleet.shareLocation", { defaultValue: "Share My Location" }),
          href: "/agents/location-sharing",
          icon: LocateFixed,
        },
      ]
      : []),
    ...(isCoreRole && hasFeature("real_estate") && canAccessPermission("realEstate.access")
      ? [
        {
          name: t("realEstate.title", { defaultValue: "Real Estate" }),
          href: "/real-estate",
          icon: Building2,
        },
      ]
      : []),
    ...(isCoreRole && hasFeature("activities") && canAccessPermission("activities.access")
      ? [
        {
          name: t("activities.title", { defaultValue: "Activities" }),
          href: "/activities",
          icon: ListChecks,
        },
      ]
      : []),
    ...(isCoreRole && hasFeature("currency_exchange") && canAccessPermission("currencyExchange.access")
      ? [
        {
          name: t("currencyExchange.serviceTitle", { defaultValue: "Currency Exchange Service" }),
          href: "/currency-exchange",
          icon: ArrowRightLeft,
          children: (() => {
            const result: WorkspaceNavigationChild[] = []
            if (canAccessPermission("currencyExchangeFeeRules.access")) {
              result.push({
                name: t("currencyExchange.feeRules.title", { defaultValue: "Fee/Commission Rules" }),
                href: "/currency-exchange/rules",
                icon: Percent,
              })
            }
            result.push({
              name: t("currencyExchange.safes.title", { defaultValue: "Safes" }),
              href: "/currency-exchange/safes",
              icon: Vault,
            })
            return result
          })(),
        },
      ]
      : []),
    ...(isCoreRole && hasFeature("manual_entry")
      ? [
        {
          name: t("manualEntry.title", { defaultValue: "Manual Entry" }),
          href: "/manual-entry",
          icon: Pen,
          children: [
            {
              name: t("manualEntry.templates", { defaultValue: "Manual Entry Templates" }),
              href: "/manual-entry/templates",
              icon: FileText,
            },
          ],
        },
      ]
      : []),
    ...(isCoreRole && hasFeature("clinical_appointments") && canAccessPermission("clinicalAppointments.access")
      ? [
        {
          name: t("clinicalAppointments.title", { defaultValue: "Clinical Appointments Registry" }),
          href: "/clinical-appointments",
          icon: CalendarClock,
          children: supportsClinicalPatientsAndServicePresets(clinicalRegistryType)
            ? [
                {
                  name: t("clinicalAppointments.patients", { defaultValue: "Patients" }),
                  href: "/clinical-appointments/patients",
                  icon: Users,
                },
                {
                  name: t("clinicalPresets.title", { defaultValue: "Clinical Presets" }),
                  href: "/clinical-presets",
                  icon: ListChecks,
                },
              ]
            : undefined,
        },
      ]
      : []),
    ...(hasFeature("loans") || hasFeature("installments") || hasFeature("crm") || hasFeature("real_estate")
      ? [
        ...(canAccessPermission("loans.access")
          && hasFeature("loans")
          ? [
            {
              name: t("nav.loans", { defaultValue: "Loans" }),
              href: "/loans",
              icon: HandCoins,
            },
          ]
          : []),
        ...((hasFeature("installments") || hasFeature("crm") || hasFeature("real_estate"))
          && canAccessPermission("installments.access")
          ? [
            {
              name: t("nav.installments", {
                defaultValue: t("loans.title", { defaultValue: "Installments" }),
              }),
              href: "/installments",
              icon: Copy,
              children: hasFeature("installments")
                ? [
                    {
                      name: t("installmentSales.title", {
                        defaultValue: "Installment Sales",
                      }),
                      href: "/installments/sales",
                      icon: Receipt,
                    },
                  ]
                : undefined,
            },
          ]
          : []),
      ]
      : []),
    ...(isCoreRole
      ? [
        ...(hasFeature("ledger") && canAccessPermission("ledger.access")
          ? [
            {
              name: t("nav.ledger", { defaultValue: "Ledger" }),
              href: "/ledger",
              icon: Wallet,
            },
          ]
          : []),
        ...(hasFeature("payments") && canAccessPermission("payment.access")
          ? [
            {
              name: t("nav.payments", { defaultValue: "Payments" }),
              href: "/payments",
              icon: CreditCard,
            },
          ]
          : []),
        ...(hasFeature("payment_accounts") && canAccessPermission("paymentAccounts.access")
          ? [
            {
              name: t("nav.paymentAccounts", { defaultValue: "Payment Accounts" }),
              href: "/payment-accounts",
              icon: Wallet,
              children: hasFeature("cashier_shift_control") && canAccessPermission("cashierShiftControl.access")
                ? [{
                  name: t("paymentAccounts.cashierShifts", { defaultValue: "Cashier Shifts" }),
                  href: "/payment-accounts/cashier-shifts",
                  icon: CalendarClock,
                }]
                : undefined,
            },
          ]
          : []),
        ...(hasFeature("payment_accounts")
          && hasFeature("cashier_shift_control")
          && !canAccessPermission("paymentAccounts.access")
          && canAccessPermission("cashierShiftControl.access")
          ? [
            {
              name: t("paymentAccounts.cashierShifts", { defaultValue: "Cashier Shifts" }),
              href: "/payment-accounts/cashier-shifts",
              icon: CalendarClock,
            },
          ]
          : []),
        ...(hasFeature("direct_transactions") && canAccessPermission("directTransaction.access")
          ? [
            {
              name: t("nav.directTransactions", {
                defaultValue: "Direct Transactions",
              }),
              href: "/direct-transactions",
              icon: ArrowRightLeft,
            },
          ]
          : []),
        ...(hasFeature("net_revenue") && canAccessPermission("revenueAnalytics.access")
          ? [
            {
              name: t("nav.revenue", { defaultValue: "Revenue Analytics" }),
              href: "/revenue",
              icon: BarChart3,
            },
          ]
          : []),
        ...(hasFeature("budget") && canAccessPermission("budget.access")
          ? [
            {
              name: t("nav.budget", { defaultValue: "Accounting" }),
              href: "/budget",
              icon: FileSpreadsheet,
            },
          ]
          : []),
        // ...(hasFeature("monthly_comparison")
        //   ? [
        //     {
        //       name: t("monthlyComparison.title", {
        //         defaultValue: "Monthly Comparison",
        //       }),
        //       href: "/monthly-comparison",
        //       icon: ArrowRightLeft,
        //     },
        //   ]
        //   : []),
        ...(hasFeature("team_performance") && canAccessPermission("teamPerformance.access")
          ? [
            {
              name: t("nav.performance", {
                defaultValue: "Team Performance",
              }),
              href: "/performance",
              icon: TrendingUp,
            },
          ]
          : []),
      ]
      : []),
    ...(isCoreRole && hasFeature("allow_whatsapp") && isDesktopDevice
      ? [
        {
          name: t("nav.whatsapp", { defaultValue: "WhatsApp" }),
          href: "/whatsapp",
          icon: MessageSquare,
          status: whatsappStatus,
        },
      ]
      : []),
    ...(hasFeature("products") && canAccessPermission("products.access")
      ? [
        {
          name: t("nav.products", { defaultValue: "Products" }),
          href: "/products",
          icon: Package,
          children: [
            {
              name: t("nav.units", { defaultValue: "Units" }),
              href: "/units",
              icon: Ruler,
            },
          ],
        },
      ]
      : []),
    ...(hasFeature("services") && canAccessPermission("products.access")
      ? [
        {
          name: t("nav.services", { defaultValue: "Services" }),
          href: "/services",
          icon: BriefcaseBusiness,
        },
      ]
      : []),
    ...(hasFeature("discounts") && canAccessPermission("discounts.access")
      ? [
        {
          name: t("nav.discounts", { defaultValue: "Discounts" }),
          href: "/discounts",
          icon: Percent,
        },
      ]
      : []),
    ...(hasFeature("storages") && canAccessPermission("storages.access")
      ? [
        {
          name: t("nav.storages", { defaultValue: "Storages" }),
          href: "/storages",
          icon: Warehouse,
        },
      ]
      : []),
    ...(hasFeature("inventory_transfer") && canAccessPermission("inventoryTransfer.access")
      ? [
        {
          name: t("nav.inventoryTransfer", {
            defaultValue: "Inventory Transfer",
          }),
          href: "/inventory-transfer",
          icon: ArrowRightLeft,
        },
      ]
      : []),
    ...(hasFeature("inventory_transactions") && canAccessPermission("inventoryTransactions.access")
      ? [
        {
          name: t("nav.inventoryTransactions", {
            defaultValue: "Inventory Transactions",
          }),
          href: "/inventory-transactions",
          icon: History,
        },
      ]
      : []),
    ...(hasFeature("stock_adjustments") && canAccessPermission("stockAdjustments.access")
      ? [
        {
          name: t("nav.stockAdjustments", {
            defaultValue: "Stock Adjustments",
          }),
          href: "/stock-adjustments",
          icon: Boxes,
        },
      ]
      : []),
    ...(hasFeature("invoices_history") && canAccessPermission("invoiceHistory.access")
      ? [
        {
          name: t("nav.invoicesHistory", {
            defaultValue: "Invoices History",
          }),
          href: "/invoices-history",
          icon: FileText,
          children: [
            {
              name: t("nav.uploadFiles", { defaultValue: "Upload Files" }),
              href: "/invoices-history/upload-files",
              icon: Upload,
            },
          ],
        },
      ]
      : []),
    ...(isCoreRole
      ? [
        ...(hasFeature("hr") && canAccessPermission("hr.access")
          ? [
            {
              name: t("nav.hr", { defaultValue: "HR" }),
              href: "/hr",
              icon: UsersRound,
            },
          ]
          : []),
        ...(hasFeature("members")
          ? [
            {
              name: role === "admin"
                ? t("members.title", { defaultValue: "Members & Admin Control" })
                : t("members.titleShort", { defaultValue: "Members" }),
              href: "/members",
              icon: Users,
            },
          ]
          : []),
        ...(role === "admin"
          ? [
            {
              name: t("customTemplates.title", { defaultValue: "Custom Templates" }),
              href: "/custom-templates",
              icon: FileText,
            },
          ]
          : []),
        ...(features.allowed_currencies.length > 1
          ? [
            {
              name: t("nav.currencyConverter", { defaultValue: "Currency Converter" }),
              href: "/currency-converter",
              icon: Calculator,
            },
          ]
          : []),
        ...(role === "admin"
          ? [
            {
              name: t("nav.logs", { defaultValue: "Logs" }),
              href: "/logs",
              icon: FileWarning,
            },
          ]
          : []),
        {
          name: t("nav.settings", { defaultValue: "Settings" }),
          href: "/settings",
          icon: Settings,
        },
      ]
      : []),
  ];

  // 2. Group items into launcher-style sections
  const grouped = new Map<NavigationSectionKey, WorkspaceNavigationItem[]>();

  otherItems.forEach((item) => {
    const meta = moduleMetaByHref[item.href] || {
      section: "people-and-workspace" as const,
    };
    const sectionItems = grouped.get(meta.section) || [];
    sectionItems.push(item);
    grouped.set(meta.section, sectionItems);
  });

  // 3. Convert map back to ordered array of WorkspaceNavigationGroup
  const launcherGroups = launcherSectionOrder
    .map((key) => ({
      sectionKey: key,
      title: t(`nav.sections.${key}.title`, {
        defaultValue: launcherSections[key].title,
      }),
      icon: launcherSections[key].icon,
      items: grouped.get(key) || [],
    }))
    .filter((group) => group.items.length > 0);

  return [
    {
      title: "", // Standalone Dashboard has no group title
      icon: LayoutDashboard,
      items: [dashboardItem, helpItem],
    },
    ...launcherGroups,
  ];
}

export function flattenWorkspaceNavigation(
  groups: WorkspaceNavigationGroup[],
): FlattenedWorkspaceNavigationItem[] {
  return groups.flatMap((group) =>
    group.items.flatMap((item) => [
      {
        name: item.name,
        href: item.href,
        icon: item.icon,
        mobileOnly: item.mobileOnly,
      },
      ...(item.children || []).map((child) => ({
        name: child.name,
        href: child.href,
        icon: child.icon || item.icon,
        mobileOnly: item.mobileOnly,
        parentHref: item.href,
      })),
    ]),
  );
}
