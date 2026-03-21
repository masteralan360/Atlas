# Plan: Novu Unread Counter on Notification Bell

Add a real-time red circle badge on the notification bell icon showing the count of unread messages, streaming live from the Novu inbox.

## Architecture

The `NotificationCenter` component is rendered in two places:
- **TitleBar.tsx** (line 134) — Desktop Tauri title bar
- **Layout.tsx** (line 589) — Web/mobile/fullscreen header

Both share the same component, so the fix is centralized.

## Approach: `useCounts` Hook

The `@novu/react/hooks` subpath (v3.13.0) exports a `useCounts` hook:

```tsx
import { useCounts } from '@novu/react/hooks';

const { counts } = useCounts({
  filters: [{ read: false }]
});
// counts[0].count → number of unread notifications
```

This hook **auto-refetches** when the count changes (via Novu's WebSocket), giving us real-time streaming for free.

## Proposed Changes

### [MODIFY] [NotificationCenter.tsx](file:///e:/ERP%20System/Atlas/src/ui/components/NotificationCenter.tsx)

1. **Add `useCounts` import** from `@novu/react/hooks`
2. **Create inner component** `InboxWithBadge` that lives inside `<NovuProvider>` so the hook has context
3. **Use `useCounts({ filters: [{ read: false }] })`** to get live unread count
4. **Render red badge** on the bell icon showing the count (max "9+")
5. **Animation**: Use `animate-pop-in` CSS class for the badge entrance

### Component Structure

```
NotificationCenter
  └─ NovuProvider (subscriberId, appId, apiUrl, socketUrl)
       └─ InboxWithBadge (new inner component)
            ├─ useCounts({ filters: [{ read: false }] })  ← streaming hook
            └─ Inbox (appearance, tabs, renderBell with badge)
```

### Badge Design

- **Size**: `h-4 w-4` (slightly larger for readability)
- **Color**: `bg-red-500` solid red
- **Text**: `text-[9px] font-bold text-white`
- **Border**: `border-2 border-background` (creates cutout effect)
- **Position**: `absolute -top-1 -right-1`
- **Animation**: `animate-pop-in` on mount
- **Overflow**: Shows "9+" for counts > 9

## Verification Plan

### Manual Verification
1. Open the app and verify the notification bell appears in the title bar
2. If there are unread notifications, the red badge should appear with the correct count
3. Open the inbox popover and read a notification — the count should decrease in real-time
4. Switch between light/dark mode — the badge border should match the background
