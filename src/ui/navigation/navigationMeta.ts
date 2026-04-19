import {
  BarChart3,
  CreditCard,
  type LucideIcon,
  UsersRound,
  Warehouse,
  Wallet,
} from "lucide-react";

export interface LauncherSection {
  title: string;
  eyebrow: string;
  description: string;
  icon: LucideIcon;
  theme: {
    shell: string;
    surface: string;
    text: string;
    border: string;
    glow: string;
  };
}

export const launcherSectionOrder = [
  "sell-and-serve",
  "stock-and-supply",
  "cash-and-control",
  "partners-and-demand",
  "insights-and-trends",
  "people-and-workspace",
] as const;

export type NavigationSectionKey = (typeof launcherSectionOrder)[number];

export const launcherSections: Record<NavigationSectionKey, LauncherSection> = {
  "sell-and-serve": {
    title: "Sell & Serve",
    eyebrow: "Frontline operations",
    description:
      "Checkout, service, and sales-touch workflows grouped into one fast-launch section.",
    icon: CreditCard,
    theme: {
      shell: "from-emerald-500/18 via-teal-500/10 to-transparent",
      surface: "bg-emerald-500/12 ring-1 ring-emerald-500/20",
      text: "text-emerald-700 dark:text-emerald-300",
      border: "border-emerald-500/20 hover:border-emerald-400/40",
      glow: "bg-emerald-400/18",
    },
  },
  "stock-and-supply": {
    title: "Stock & Supply",
    eyebrow: "Inventory control",
    description:
      "Inventory visibility, movement, and warehouse control in one place.",
    icon: Warehouse,
    theme: {
      shell: "from-amber-500/18 via-orange-500/10 to-transparent",
      surface: "bg-amber-500/12 ring-1 ring-amber-500/20",
      text: "text-amber-700 dark:text-amber-300",
      border: "border-amber-500/20 hover:border-amber-400/40",
      glow: "bg-amber-400/18",
    },
  },
  "cash-and-control": {
    title: "Cash & Control",
    eyebrow: "Finance operations",
    description:
      "Money movement, finance records, and payment follow-up organized for faster scanning.",
    icon: Wallet,
    theme: {
      shell: "from-sky-500/18 via-cyan-500/10 to-transparent",
      surface: "bg-sky-500/12 ring-1 ring-sky-500/20",
      text: "text-sky-700 dark:text-sky-300",
      border: "border-sky-500/20 hover:border-sky-400/40",
      glow: "bg-sky-400/18",
    },
  },
  "partners-and-demand": {
    title: "Partners & Demand",
    eyebrow: "Relationship management",
    description:
      "Customer-facing and partner-facing workflows grouped around trade relationships.",
    icon: UsersRound,
    theme: {
      shell: "from-rose-500/18 via-orange-500/10 to-transparent",
      surface: "bg-rose-500/12 ring-1 ring-rose-500/20",
      text: "text-rose-700 dark:text-rose-300",
      border: "border-rose-500/20 hover:border-rose-400/40",
      glow: "bg-rose-400/18",
    },
  },
  "insights-and-trends": {
    title: "Insights & Trends",
    eyebrow: "Analytics",
    description:
      "Performance reading and comparison views that turn activity into direction.",
    icon: BarChart3,
    theme: {
      shell: "from-indigo-500/18 via-blue-500/10 to-transparent",
      surface: "bg-indigo-500/12 ring-1 ring-indigo-500/20",
      text: "text-indigo-700 dark:text-indigo-300",
      border: "border-indigo-500/20 hover:border-indigo-400/40",
      glow: "bg-indigo-400/18",
    },
  },
  "people-and-workspace": {
    title: "People & Workspace",
    eyebrow: "Operations support",
    description:
      "Internal team operations and workspace-level tools collected into one calmer utility layer.",
    icon: UsersRound,
    theme: {
      shell: "from-slate-500/18 via-zinc-500/10 to-transparent",
      surface: "bg-slate-500/12 ring-1 ring-slate-500/20",
      text: "text-slate-700 dark:text-slate-300",
      border: "border-slate-500/20 hover:border-slate-400/40",
      glow: "bg-slate-400/16",
    },
  },
};

export interface ModuleMeta {
  section: NavigationSectionKey;
  description: string;
  badge: string;
}

export const moduleMetaByHref: Record<string, ModuleMeta> = {
  "/": {
    section: "insights-and-trends",
    description: "Return to the main business overview and headline numbers.",
    badge: "Overview",
  },
  "/pos": {
    section: "sell-and-serve",
    description: "Run the main checkout and in-store selling flow.",
    badge: "Checkout",
  },
  "/instant-pos": {
    section: "sell-and-serve",
    description: "Handle rapid-service orders with the faster POS flow.",
    badge: "Fast lane",
  },
  "/kds": {
    section: "sell-and-serve",
    description: "Track kitchen-ready work and live preparation status.",
    badge: "Live",
  },
  "/sales": {
    section: "sell-and-serve",
    description: "Review completed sales, returns, and sales records.",
    badge: "History",
  },
  "/travel-agency": {
    section: "sell-and-serve",
    description: "Manage travel-related bookings and service sales.",
    badge: "Service",
  },
  "/products": {
    section: "stock-and-supply",
    description: "Maintain product catalog, stock rules, and pricing.",
    badge: "Catalog",
  },
  "/discounts": {
    section: "stock-and-supply",
    description:
      "Manage product promotions, seasonal offers, and campaign-based price reductions.",
    badge: "Promos",
  },
  "/storages": {
    section: "stock-and-supply",
    description: "Manage warehouses, storage locations, and availability.",
    badge: "Warehouses",
  },
  "/inventory-transfer": {
    section: "stock-and-supply",
    description: "Move stock across locations and coordinate replenishment.",
    badge: "Movement",
  },
  "/inventory-transactions": {
    section: "stock-and-supply",
    description:
      "Review transfer and stock adjustment records in one permanent log.",
    badge: "Log",
  },
  "/stock-adjustments": {
    section: "stock-and-supply",
    description:
      "Adjust stock levels, review manual changes, and manage product batches.",
    badge: "Audit",
  },
  "/ledger": {
    section: "cash-and-control",
    description: "Inspect cross-module inflows, outflows, and payment trails.",
    badge: "Flow",
  },
  "/payments": {
    section: "cash-and-control",
    description: "Settle obligations and review transaction timelines.",
    badge: "Settlement",
  },
  "/direct-transactions": {
    section: "cash-and-control",
    description:
      "Record standalone inflows and outflows outside linked records.",
    badge: "Manual",
  },
  "/loans": {
    section: "cash-and-control",
    description: "Manage issued and received loans with their histories.",
    badge: "Credit",
  },
  "/installments": {
    section: "cash-and-control",
    description: "Review staged repayments and installment collection flow.",
    badge: "Plans",
  },
  "/budget": {
    section: "cash-and-control",
    description: "Track accounting records, budgets, and financial controls.",
    badge: "Books",
  },
  "/invoices-history": {
    section: "cash-and-control",
    description: "Browse invoice records and audit issued invoice activity.",
    badge: "Archive",
  },
  "/currency-converter": {
    section: "cash-and-control",
    description:
      "Check exchange values and switch currencies with current rates.",
    badge: "Rates",
  },
  "/business-partners": {
    section: "partners-and-demand",
    description: "View trading entities, balances, and relationship data.",
    badge: "Network",
  },
  "/customers": {
    section: "partners-and-demand",
    description: "Track customer records, histories, and engagement context.",
    badge: "Demand",
  },
  "/suppliers": {
    section: "partners-and-demand",
    description: "Manage supplier relationships and procurement context.",
    badge: "Supply",
  },
  "/orders": {
    section: "partners-and-demand",
    description: "Open, settle, and review purchase or sales orders.",
    badge: "Pipeline",
  },
  "/ecommerce": {
    section: "partners-and-demand",
    description: "Track and manage incoming marketplace orders.",
    badge: "Marketplace",
  },
  "/revenue": {
    section: "insights-and-trends",
    description: "Analyze revenue behavior, inflows, and reporting trends.",
    badge: "Revenue",
  },
  "/monthly-comparison": {
    section: "insights-and-trends",
    description:
      "Compare monthly movement side by side and track change over time.",
    badge: "Compare",
  },
  "/hr": {
    section: "people-and-workspace",
    description: "Manage HR workflows, records, and team operations.",
    badge: "People",
  },
  "/performance": {
    section: "people-and-workspace",
    description: "Read team output, progress, and contribution trends.",
    badge: "Performance",
  },
  "/whatsapp": {
    section: "people-and-workspace",
    description: "Open the desktop communication surface for live follow-up.",
    badge: "Desktop",
  },
  "/members": {
    section: "people-and-workspace",
    description: "Review workspace members and role visibility.",
    badge: "Access",
  },
  "/settings": {
    section: "people-and-workspace",
    description:
      "Adjust workspace configuration, behavior, and system preferences.",
    badge: "Control",
  },
};
