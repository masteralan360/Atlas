import { forwardRef, useMemo, useEffect, useRef, useCallback, useState, type ComponentPropsWithoutRef } from 'react';
import {
    CourierInbox,
    type CourierInboxFeed,
    type CourierInboxTheme,
    type InboxMessage,
    useCourier,
} from '@trycourier/courier-react';
import { useAuth } from '@/auth';
import { fetchCourierToken, getCourierUserId } from '@/auth/courier';
import { Bell } from 'lucide-react';
import { useTheme } from './theme-provider';
import { useTranslation } from 'react-i18next';
import { toast } from '@/ui/components/use-toast';
import { connectionManager } from '@/lib/connectionManager';
import { cn } from '@/lib/utils';
import { isMobile, isTauri } from '@/lib/platform';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

let trackedCourierUserId = '';
let hasPrimedCourierInbox = false;
const seenCourierMessageIds = new Set<string>();

function syncCourierMessageTracker(userId: string) {
    if (trackedCourierUserId === userId) {
        return;
    }

    trackedCourierUserId = userId;
    hasPrimedCourierInbox = false;
    seenCourierMessageIds.clear();
}

function playNotificationSound() {
    try {
        const ctx = new AudioContext();
        const now = ctx.currentTime;

        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(830, now);
        gain1.gain.setValueAtTime(0.15, now);
        gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        osc1.connect(gain1).connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.15);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1050, now + 0.12);
        gain2.gain.setValueAtTime(0.001, now);
        gain2.gain.setValueAtTime(0.15, now + 0.12);
        gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
        osc2.connect(gain2).connect(ctx.destination);
        osc2.start(now + 0.12);
        osc2.stop(now + 0.3);

        setTimeout(() => ctx.close(), 500);
    } catch {
        // Audio not available
    }
}

function flattenInboxMessages(feeds: Record<string, { messages?: InboxMessage[] }>): InboxMessage[] {
    const messageMap = new Map<string, InboxMessage>();

    for (const dataset of Object.values(feeds)) {
        for (const message of dataset?.messages ?? []) {
            if (!message?.messageId || messageMap.has(message.messageId)) {
                continue;
            }

            messageMap.set(message.messageId, message);
        }
    }

    return Array.from(messageMap.values()).sort((left, right) => {
        const leftTime = left.created ? new Date(left.created).getTime() : 0;
        const rightTime = right.created ? new Date(right.created).getTime() : 0;
        return rightTime - leftTime;
    });
}

function readPayloadValue(payload: Record<string, unknown>, key: string) {
    const value = payload[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function rememberCourierMessages(messages: InboxMessage[]) {
    for (const message of messages) {
        if (message.messageId) {
            seenCourierMessageIds.add(message.messageId);
        }
    }
}

type BellButtonProps = ComponentPropsWithoutRef<'button'> & {
    unreadCount: number;
    style: string;
};

const BellButton = forwardRef<HTMLButtonElement, BellButtonProps>(function BellButton(
    { unreadCount, style, className, type = 'button', ...props },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            className={cn(
                'relative transition-colors cursor-pointer mr-1 p-1.5',
                style === 'neo-orange' ? 'neo-indicator' : 'hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground',
                className,
            )}
            {...props}
        >
            <Bell className="w-4 h-4 transition-transform active:scale-90" />
            {unreadCount > 0 && (
                <span
                    className={cn(
                        'absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center text-[9px] font-bold text-white border-2 border-background animate-pop-in shadow-lg',
                        style === 'neo-orange' ? 'rounded-none bg-black border-white' : 'rounded-full bg-red-500'
                    )}
                >
                    {unreadCount > 9 ? '9+' : unreadCount}
                </span>
            )}
        </button>
    );
});

export function NotificationCenter() {
    const { user, session, isLoading } = useAuth();
    const { theme, style } = useTheme();
    const { t, i18n } = useTranslation();
    const courier = useCourier();
    const courierUserId = getCourierUserId(user?.id);
    const courierSharedRef = useRef(courier.shared);
    const courierInboxRef = useRef(courier.inbox);
    const courierAuthRef = useRef(courier.auth);

    const [reconnectKey, setReconnectKey] = useState(0);
    const [isCourierReady, setIsCourierReady] = useState(false);
    const [isSigningIn, setIsSigningIn] = useState(false);
    const [authError, setAuthError] = useState<string | null>(null);
    const reconnectDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const signedInUserRef = useRef('');
    const lastSignInAttemptRef = useRef('');
    const lastInboxLoadRef = useRef('');

    useEffect(() => {
        courierSharedRef.current = courier.shared;
        courierInboxRef.current = courier.inbox;
        courierAuthRef.current = courier.auth;
    }, [courier.auth, courier.inbox, courier.shared]);

    useEffect(() => {
        const unsubscribe = connectionManager.subscribe((event) => {
            if (event === 'wake' || event === 'online') {
                if (reconnectDebounceRef.current) clearTimeout(reconnectDebounceRef.current);
                reconnectDebounceRef.current = setTimeout(() => {
                    console.log('[NotificationCenter] Reconnecting Courier inbox due to:', event);
                    setReconnectKey((key) => key + 1);
                }, 2000);
            }
        });

        return () => {
            unsubscribe();
            if (reconnectDebounceRef.current) clearTimeout(reconnectDebounceRef.current);
        };
    }, []);

    const isDark = useMemo(() => {
        return theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }, [theme]);

    const mode = theme === 'system' ? 'system' : isDark ? 'dark' : 'light';
    const baseRadius = style === 'modern' ? '1rem' : '0.75rem';

    const lightTheme = useMemo<CourierInboxTheme>(() => ({
        popup: {
            window: {
                backgroundColor: '#ffffff',
                border: '1px solid rgba(15, 23, 42, 0.08)',
                borderRadius: baseRadius,
                shadow: '0 24px 48px rgba(15, 23, 42, 0.18)',
            },
        },
        inbox: {
            header: {
                backgroundColor: '#ffffff',
                border: '1px solid rgba(15, 23, 42, 0.06)',
                tabs: {
                    default: {
                        font: { color: '#64748b', weight: '600' },
                        hoverBackgroundColor: '#f8fafc',
                        activeBackgroundColor: '#f1f5f9',
                        unreadIndicator: {
                            backgroundColor: '#e2e8f0',
                            font: { color: '#0f172a', weight: '700', size: '11px' },
                        },
                    },
                    selected: {
                        backgroundColor: '#eff6ff',
                        hoverBackgroundColor: '#dbeafe',
                        activeBackgroundColor: '#dbeafe',
                        font: { color: '#2563eb', weight: '700' },
                        indicatorColor: '#2563eb',
                        unreadIndicator: {
                            backgroundColor: '#2563eb',
                            font: { color: '#ffffff', weight: '700', size: '11px' },
                        },
                    },
                },
            },
            list: {
                backgroundColor: '#ffffff',
                item: {
                    backgroundColor: '#ffffff',
                    hoverBackgroundColor: '#f8fafc',
                    activeBackgroundColor: '#eff6ff',
                    unreadIndicatorColor: '#ef4444',
                    divider: '1px solid rgba(15, 23, 42, 0.06)',
                    title: { color: '#0f172a', weight: '600' },
                    subtitle: { color: '#64748b' },
                    time: { color: '#94a3b8' },
                },
            },
            empty: {
                title: {
                    text: t('notifications.empty') || 'No notifications yet',
                    font: { color: '#64748b', weight: '600' },
                },
            },
            error: {
                title: {
                    text: t('notifications.error') || 'Failed to load notifications',
                    font: { color: '#dc2626', weight: '600' },
                },
            },
        },
    }), [baseRadius, t, i18n.language]);

    const darkTheme = useMemo<CourierInboxTheme>(() => ({
        popup: {
            window: {
                backgroundColor: '#0f172a',
                border: '1px solid rgba(148, 163, 184, 0.18)',
                borderRadius: baseRadius,
                shadow: '0 24px 48px rgba(2, 6, 23, 0.55)',
            },
        },
        inbox: {
            header: {
                backgroundColor: '#0f172a',
                border: '1px solid rgba(148, 163, 184, 0.12)',
                tabs: {
                    default: {
                        font: { color: '#94a3b8', weight: '600' },
                        hoverBackgroundColor: 'rgba(148, 163, 184, 0.08)',
                        activeBackgroundColor: 'rgba(148, 163, 184, 0.12)',
                        unreadIndicator: {
                            backgroundColor: 'rgba(148, 163, 184, 0.18)',
                            font: { color: '#e2e8f0', weight: '700', size: '11px' },
                        },
                    },
                    selected: {
                        backgroundColor: 'rgba(59, 130, 246, 0.18)',
                        hoverBackgroundColor: 'rgba(59, 130, 246, 0.24)',
                        activeBackgroundColor: 'rgba(59, 130, 246, 0.24)',
                        font: { color: '#bfdbfe', weight: '700' },
                        indicatorColor: '#60a5fa',
                        unreadIndicator: {
                            backgroundColor: '#60a5fa',
                            font: { color: '#0f172a', weight: '700', size: '11px' },
                        },
                    },
                },
            },
            list: {
                backgroundColor: '#0f172a',
                item: {
                    backgroundColor: '#0f172a',
                    hoverBackgroundColor: 'rgba(148, 163, 184, 0.08)',
                    activeBackgroundColor: 'rgba(59, 130, 246, 0.14)',
                    unreadIndicatorColor: '#60a5fa',
                    divider: '1px solid rgba(148, 163, 184, 0.12)',
                    title: { color: '#f8fafc', weight: '600' },
                    subtitle: { color: '#94a3b8' },
                    time: { color: '#64748b' },
                },
            },
            empty: {
                title: {
                    text: t('notifications.empty') || 'No notifications yet',
                    font: { color: '#94a3b8', weight: '600' },
                },
            },
            error: {
                title: {
                    text: t('notifications.error') || 'Failed to load notifications',
                    font: { color: '#fca5a5', weight: '600' },
                },
            },
        },
    }), [baseRadius, t, i18n.language]);

    const feeds = useMemo<CourierInboxFeed[]>(() => ([
        {
            feedId: 'notifications',
            title: t('notifications.title') || 'Notifications',
            tabs: [
                { datasetId: 'all', title: t('notifications.tabs.all'), filter: {} },
                { datasetId: 'workspace', title: t('notifications.tabs.workspace'), filter: { tags: ['workspace'] } },
                { datasetId: 'user', title: t('notifications.tabs.user'), filter: { tags: ['user'] } },
            ],
        },
    ]), [t, i18n.language]);

    const signInAttemptKey = `${courierUserId}:${session?.access_token ?? ''}:${reconnectKey}`;
    const inboxLoadKey = `${signedInUserRef.current}:${reconnectKey}`;

    useEffect(() => {
        if (!courierUserId || !session?.access_token) {
            signedInUserRef.current = '';
            lastSignInAttemptRef.current = '';
            lastInboxLoadRef.current = '';
            setIsCourierReady(false);
            setIsSigningIn(false);
            setAuthError(null);
            courierAuthRef.current.signOut();
            return;
        }

        if (lastSignInAttemptRef.current === signInAttemptKey) {
            return;
        }

        lastSignInAttemptRef.current = signInAttemptKey;
        let cancelled = false;

        const signInToCourier = async () => {
            syncCourierMessageTracker(courierUserId);
            setIsSigningIn(true);
            setIsCourierReady(false);
            setAuthError(null);

            try {
                const { jwt, userId } = await fetchCourierToken(session.access_token);
                if (cancelled) return;

                courierSharedRef.current.signIn({ userId, jwt });
                signedInUserRef.current = userId;
                lastInboxLoadRef.current = '';
                setIsCourierReady(true);
            } catch (error) {
                if (cancelled) return;
                const message = error instanceof Error ? error.message : 'Failed to sign in to Courier';
                console.error('[NotificationCenter] Courier sign-in failed:', message);
                setAuthError(message);
                setIsCourierReady(false);
            } finally {
                if (!cancelled) {
                    setIsSigningIn(false);
                }
            }
        };

        void signInToCourier();

        return () => {
            cancelled = true;
        };
    }, [courierUserId, reconnectKey, session?.access_token, signInAttemptKey]);

    useEffect(() => {
        if (!isCourierReady) {
            return;
        }

        courierInboxRef.current.registerFeeds(feeds);
    }, [feeds, isCourierReady]);

    useEffect(() => {
        if (!isCourierReady || !signedInUserRef.current) {
            return;
        }

        if (lastInboxLoadRef.current === inboxLoadKey) {
            return;
        }

        lastInboxLoadRef.current = inboxLoadKey;
        let cancelled = false;

        const loadInbox = async () => {
            try {
                await courierInboxRef.current.load({ canUseCache: reconnectKey === 0 });
                if (cancelled) return;

                rememberCourierMessages(flattenInboxMessages(courierInboxRef.current.feeds));
                hasPrimedCourierInbox = true;

                await courierInboxRef.current.listenForUpdates();
            } catch (error) {
                if (cancelled) return;
                const message = error instanceof Error ? error.message : 'Failed to load Courier inbox';
                console.error('[NotificationCenter] Courier inbox sync failed:', message);
                setAuthError(message);
            }
        };

        void loadInbox();

        return () => {
            cancelled = true;
        };
    }, [inboxLoadKey, isCourierReady, reconnectKey]);

    const messages = useMemo(() => flattenInboxMessages(courier.inbox.feeds), [courier.inbox.feeds]);

    const showNotificationToast = useCallback(() => {
        playNotificationSound();
        toast({
            title: t('notifications.newNotificationTitle'),
            description: t('notifications.newNotification'),
            duration: 4000,
        });
    }, [t]);

    const sendDesktopNotification = useCallback(async (message: InboxMessage) => {
        if (!isTauri() || isMobile()) return;

        try {
            const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification');
            let permission = await isPermissionGranted();
            if (!permission) {
                const requested = await requestPermission();
                permission = requested === 'granted';
            }
            if (!permission) return;

            const payload = message.data && typeof message.data === 'object'
                ? (message.data as Record<string, unknown>)
                : {};
            const title = message.title || readPayloadValue(payload, 'title') || t('notifications.newNotificationTitle') || 'New Notification';
            const marketplaceBody = readPayloadValue(payload, 'customer_name')
                ? `${readPayloadValue(payload, 'customer_name')}${readPayloadValue(payload, 'order_number') ? ` (${readPayloadValue(payload, 'order_number')})` : ''}`
                : readPayloadValue(payload, 'order_number');
            const amount = readPayloadValue(payload, 'amount');
            const currency = readPayloadValue(payload, 'currency');
            const body = message.body
                || message.preview
                || readPayloadValue(payload, 'content')
                || readPayloadValue(payload, 'borrower_name')
                || marketplaceBody
                || (amount ? `${amount}${currency ? ` ${currency}` : ''}` : '');

            sendNotification({ title, body });
        } catch (error) {
            console.warn('[NotificationCenter] Failed to show desktop notification:', error);
        }
    }, [t]);

    useEffect(() => {
        if (!courierUserId || !isCourierReady) {
            return;
        }

        syncCourierMessageTracker(courierUserId);

        if (!hasPrimedCourierInbox) {
            return;
        }

        let hasNew = false;

        for (const message of messages) {
            if (!message.messageId || seenCourierMessageIds.has(message.messageId)) {
                continue;
            }

            seenCourierMessageIds.add(message.messageId);
            hasNew = true;
            void sendDesktopNotification(message);
        }

        if (hasNew) {
            showNotificationToast();
        }
    }, [courierUserId, isCourierReady, messages, sendDesktopNotification, showNotificationToast]);

    const unreadCount = courier.inbox.totalUnreadCount ?? 0;

    if (isLoading || isSigningIn) {
        return (
            <button className="relative p-2 rounded-md text-muted-foreground animate-pulse">
                <Bell className="w-4 h-4" />
            </button>
        );
    }

    if (!courierUserId || !session?.access_token) {
        return (
            <button
                className="relative hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-foreground cursor-pointer mr-1 opacity-50"
                title="Waiting for user session..."
            >
                <Bell className="w-4 h-4" />
            </button>
        );
    }

    if (authError && !isCourierReady) {
        return (
            <button
                className="relative hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-foreground cursor-pointer mr-1 opacity-50"
                title={authError}
            >
                <Bell className="w-4 h-4" />
            </button>
        );
    }

    return (
        <Popover>
            <PopoverTrigger asChild>
                <BellButton unreadCount={unreadCount} style={style} />
            </PopoverTrigger>
            <PopoverContent
                align="end"
                side="bottom"
                sideOffset={10}
                className="w-[420px] max-w-[calc(100vw-1rem)] border-none bg-transparent p-0 shadow-none"
            >
                <div
                    className={cn(
                        'overflow-hidden rounded-2xl border shadow-2xl',
                        isDark
                            ? 'border-white/10 bg-slate-950'
                            : 'border-slate-200 bg-white'
                    )}
                >
                    <CourierInbox
                        height="560px"
                        mode={mode}
                        feeds={feeds}
                        lightTheme={lightTheme}
                        darkTheme={darkTheme}
                    />
                </div>
            </PopoverContent>
        </Popover>
    );
}
