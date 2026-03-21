# PLAN: Revenue Dashboard Refinements

This plan outlines the steps to refine the Revenue dashboard by removing target-specific UI from the profit margin card and making the KPI trend badges dynamic based on actual sales data.

## User Review Required

> [!IMPORTANT]
> **Trend Calculation Logic**: I propose calculating the "Dynamic Pill Badges" by comparing the **Total of the Last 7 Days** against the **Total of the Previous 7 Days** (if data exists). This provides a more meaningful "Week-over-Week" growth metric.
> - Emerald (+) if growth >= 0.
> - Red (-) if growth < 0.

## Proposed Changes

### Revenue Dashboard
#### [MODIFY] [Revenue.tsx](file:///e:/ERP%20System/Atlas/src/ui/pages/Revenue.tsx)
-   **Dynamic Trend Logic**:
    -   Update `calculateStats` or add a new `useMemo` to compute growth percentages for Revenue, Cost, and Profit.
    -   Formula: `((Current7DaySum - Previous7DaySum) / Previous7DaySum) * 100`.
-   **KPI Cards UI**:
    -   Replace hardcoded percentages (+12.5%, etc.) with calculated trend values.
    -   Dynamically switch pill colors (emerald/red) and icons (TrendingUp/TrendingDown) based on trend direction.
-   **Profit Margin UI**:
    -   Remove "Target: 60%" and "Above/Below Target" text.
    -   Retain the progress bar but remove the target-related labeling.

## Verification Plan

### Automated Tests
-   Verify components still render correctly without lint errors.
-   `npm run build` to ensure no regression in types.

### Manual Verification
1.  **Trend Data**: Change the date range or add new sales and verify the percentages in the KPI cards update dynamically.
2.  **Profit Margin**: Confirm that the "Target" text is gone and the margin progress bar correctly reflects the percentage.
3.  **UI Consistency**: Check both light and dark modes for visual correctness of the new dynamic badges.
