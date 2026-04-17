importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

const params = new URL(location).searchParams;

const firebaseConfig = {
    apiKey: params.get("apiKey"),
    projectId: params.get("projectId"),
    messagingSenderId: params.get("messagingSenderId"),
    appId: params.get("appId")
};

if (firebaseConfig.apiKey && firebaseConfig.projectId) {
    firebase.initializeApp(firebaseConfig);
    const messaging = firebase.messaging();

    messaging.onBackgroundMessage((payload) => {
        console.log('[firebase-messaging-sw.js] Received background message: ', payload);

        const title = payload.notification?.title || payload.data?.title || payload.data?.subject || 'Asaas';
        const body = payload.notification?.body || payload.data?.body || payload.data?.message || 'You have a new notification.';

        const notificationOptions = {
            body,
            icon: '/icon-192.png',
            data: payload.data || payload.notification?.data || {}
        };

        return self.registration.showNotification(title, notificationOptions);
    });

    self.addEventListener('notificationclick', (event) => {
        event.notification.close();
        const data = event.notification?.data || {};
        const route = data.actionUrl || data.route || '/';
        const targetUrl = new URL(route, self.location.origin).toString();

        event.waitUntil((async () => {
            const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
            for (const client of windowClients) {
                if ('focus' in client) {
                    if (client.url === targetUrl || client.url === new URL('/', self.location.origin).toString()) {
                        await client.navigate(targetUrl);
                        await client.focus();
                        return;
                    }
                }
            }

            await clients.openWindow(targetUrl);
        })());
    });
} else {
    console.warn('[firebase-messaging-sw.js] Missing Firebase config query parameters.');
}
