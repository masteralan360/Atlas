import {
  ArrowRightLeft,
  BarChart3,
  Building2,
  CreditCard,
  type LucideIcon,
  UserRound,
  UsersRound,
  Warehouse,
  Wallet,
  Globe,
  CalendarClock,
  FileText,
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
  "real-estate",
  "currency-exchange",
  "manual-entry",
  "clinic-service",
  "agents",
  "partners-and-demand",
  "insights-and-trends",
  "people-and-workspace",
  "global",
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
  "real-estate": {
    title: "Real Estate",
    eyebrow: "Property operations",
    description:
      "Property deals, installment schedules, and real estate balances grouped apart from general finance.",
    icon: Building2,
    theme: {
      shell: "from-lime-500/18 via-emerald-500/10 to-transparent",
      surface: "bg-lime-500/12 ring-1 ring-lime-500/20",
      text: "text-lime-700 dark:text-lime-300",
      border: "border-lime-500/20 hover:border-lime-400/40",
      glow: "bg-lime-400/18",
    },
  },
  "currency-exchange": {
    title: "Currency Exchange",
    eyebrow: "FX operations",
    description:
      "Walk-in exchange deals, market-rate snapshots, and fee controls grouped apart from general finance.",
    icon: ArrowRightLeft,
    theme: {
      shell: "from-violet-500/18 via-fuchsia-500/10 to-transparent",
      surface: "bg-violet-500/12 ring-1 ring-violet-500/20",
      text: "text-violet-700 dark:text-violet-300",
      border: "border-violet-500/20 hover:border-violet-400/40",
      glow: "bg-violet-400/18",
    },
  },
  "manual-entry": {
    title: "Manual Entry",
    eyebrow: "Manual operations",
    description: "Create custom manual entries with reusable templates and editable A4 print forms.",
    icon: FileText,
    theme: {
      shell: "from-cyan-500/18 via-sky-500/10 to-transparent",
      surface: "bg-cyan-500/12 ring-1 ring-cyan-500/20",
      text: "text-cyan-700 dark:text-cyan-300",
      border: "border-cyan-500/20 hover:border-cyan-400/40",
      glow: "bg-cyan-400/18",
    },
  },
  "clinic-service": {
    title: "Clinic Service",
    eyebrow: "Healthcare operations",
    description:
      "Appointment scheduling, patient records, and clinical service workflows.",
    icon: CalendarClock,
    theme: {
      shell: "from-teal-500/18 via-cyan-500/10 to-transparent",
      surface: "bg-teal-500/12 ring-1 ring-teal-500/20",
      text: "text-teal-700 dark:text-teal-300",
      border: "border-teal-500/20 hover:border-teal-400/40",
      glow: "bg-teal-400/18",
    },
  },
  agents: {
    title: "Agents",
    eyebrow: "Field operations",
    description:
      "Drivers, field agents, assigned territories, vehicles, and accountable workspace users.",
    icon: UserRound,
    theme: {
      shell: "from-orange-500/18 via-amber-500/10 to-transparent",
      surface: "bg-orange-500/12 ring-1 ring-orange-500/20",
      text: "text-orange-700 dark:text-orange-300",
      border: "border-orange-500/20 hover:border-orange-400/40",
      glow: "bg-orange-400/18",
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
  global: {
    title: "Global",
    eyebrow: "Fallback settings",
    description:
      "Default permissions that apply across all modules unless overridden.",
    icon: Globe,
    theme: {
      shell: "from-blue-500/18 via-indigo-500/10 to-transparent",
      surface: "bg-blue-500/12 ring-1 ring-blue-500/20",
      text: "text-blue-700 dark:text-blue-300",
      border: "border-blue-500/20 hover:border-blue-400/40",
      glow: "bg-blue-400/18",
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
  "/car-rental": {
    section: "sell-and-serve",
    description: "Manage rental vehicles, availability, customer requests, and rental contracts.",
    badge: "Rental",
  },
  "/car-rental/vehicles": {
    section: "sell-and-serve",
    description: "Register rental vehicles, rates, condition, and availability.",
    badge: "Vehicles",
  },
  "/car-rental/requests": {
    section: "sell-and-serve",
    description: "Review customer rental requests and convert approved demand into contracts.",
    badge: "Requests",
  },
  "/car-rental/contracts": {
    section: "sell-and-serve",
    description: "Reserve, hand over, receive, collect, and close vehicle rental contracts.",
    badge: "Contracts",
  },
  "/real-estate": {
    section: "real-estate",
    description: "Record property deals, parties, balances, and installment schedules.",
    badge: "Property",
  },
  "/currency-exchange": {
    section: "currency-exchange",
    description: "Record walk-in buy and sell currency exchanges with rate snapshots.",
    badge: "FX",
  },
  "/currency-exchange/rules": {
    section: "currency-exchange",
    description: "Manage reusable exchange fee and commission rules.",
    badge: "Rules",
  },
  "/agents": {
    section: "agents",
    description: "Manage drivers and field agents with territories, vehicles, status, and user links.",
    badge: "Field team",
  },
  "/agents/commissions": {
    section: "agents",
    description: "Review earned agent commission, record payments, and collect commission recoveries.",
    badge: "Commissions",
  },
  "/agents/:agentId": {
    section: "agents",
    description: "Review an agent profile, territory, vehicle, and operational status.",
    badge: "Agent",
  },
  "/agents/fleet": {
    section: "agents",
    description: "Manage fleet vehicles, agent assignments, live locations, and movement history.",
    badge: "Fleet",
  },
  "/agents/location-sharing": {
    section: "agents",
    description: "Explicitly enable or stop foreground location sharing for a linked agent.",
    badge: "Location",
  },
  "/post-service": {
    section: "agents",
    description: "Operate COD shipments, courier dispatch, cash handovers, and merchant payouts.",
    badge: "Delivery",
  },
  "/manual-entry": {
    section: "manual-entry",
    description: "Create manual entries using reusable templates with editable A4 forms.",
    badge: "Entry",
  },
  "/manual-entry/templates": {
    section: "manual-entry",
    description: "Manage custom manual entry templates with addable, sortable rows.",
    badge: "Templates",
  },
  "/clinical-appointments": {
    section: "clinic-service",
    description: "Manage clinical appointments, scheduling, and patient visits.",
    badge: "Appointments",
  },
  "/clinical-appointments/patients": {
    section: "clinic-service",
    description: "View and manage patient records and medical history.",
    badge: "Patients",
  },
  "/clinical-appointments/patients/:patientId": {
    section: "clinic-service",
    description: "View patient details and appointment history.",
    badge: "Patient",
  },
  "/clinical-presets": {
    section: "clinic-service",
    description: "Configure reusable appointment presets: reasons for visit, services, and consultation fees.",
    badge: "Presets",
  },
  "/products": {
    section: "stock-and-supply",
    description: "Maintain product catalog, stock rules, and pricing.",
    badge: "Catalog",
  },
  "/services": {
    section: "stock-and-supply",
    description: "Manage the service catalog offered to customers.",
    badge: "Services",
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
  "/payment-accounts": {
    section: "cash-and-control",
    description: "Manage optional payment accounts, balances, and movement history.",
    badge: "Accounts",
  },
  "/payment-accounts/cashier-shifts": {
    section: "cash-and-control",
    description: "Assign cash drawers to workspace members.",
    badge: "Shifts",
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
    section: "people-and-workspace",
    description:
      "Check exchange values and switch currencies with current rates.",
    badge: "Rates",
  },
  "/business-partners": {
    section: "partners-and-demand",
    description: "View trading entities, balances, and relationship data.",
    badge: "Network",
  },
  "/business-partners/account-statement": {
    section: "partners-and-demand",
    description: "Review and print a business partner's account activity and running balance.",
    badge: "Statement",
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
  "/online-customers": {
    section: "partners-and-demand",
    description: "Customers who ordered through your marketplace storefronts.",
    badge: "Online",
  },
  "/orders/sales": {
    section: "partners-and-demand",
    description: "Create, manage, and track sales orders from customers.",
    badge: "Sales",
  },
  "/orders/purchase": {
    section: "partners-and-demand",
    description: "Create and manage purchase orders from suppliers.",
    badge: "Purchase",
  },
  "/orders": {
    section: "partners-and-demand",
    description: "Open, settle, and review purchase or sales orders.",
    badge: "Pipeline",
  },
  "/travel-transportation": {
    section: "sell-and-serve",
    description: "Create, book, and settle travel and transportation bookings.",
    badge: "Travel",
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
  "/custom-templates": {
    section: "people-and-workspace",
    description: "Manage workspace-specific custom print layouts.",
    badge: "Print",
  },
  "/settings": {
    section: "people-and-workspace",
    description:
      "Adjust workspace configuration, behavior, and system preferences.",
    badge: "Control",
  },
  "/logs": {
    section: "people-and-workspace",
    description: "Review console errors recorded locally on this device.",
    badge: "Errors",
  },
};
