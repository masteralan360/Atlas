import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isDesktop } from '@/lib/platform'

type KdsEvent = {
    event: string
    payload: any
}

export function useKdsStream(isMain: boolean = true) {
    const [status, setStatus] = useState<'idle' | 'host' | 'connected' | 'error' | 'reconnecting'>('idle')
    const [streamUrl, setStreamUrl] = useState<string | null>(null)
    const socketRef = useRef<WebSocket | null>(null)
    const [lastEvent, setLastEvent] = useState<KdsEvent | null>(null)

    useEffect(() => {
        if (isMain && isDesktop()) {
            // Main terminal logic: Start the server if not already started
            const initHost = async () => {
                try {
                    const existingUrl = await invoke<string | null>('get_kds_stream_url')
                    if (existingUrl) {
                        setStreamUrl(existingUrl)
                        setStatus('host')
                    }
                } catch (err) {
                    console.error('Failed to check KDS stream status:', err)
                }
            }
            initHost()

            // Listen for Tauri events from remote clients
            let unlisten: (() => void) | null = null
            import('@tauri-apps/api/event').then(({ listen }) => {
                listen<string>('kds-remote-update', (event) => {
                    try {
                        const data = JSON.parse(event.payload)
                        if (data.event === 'TICKET_UPDATED') {
                            window.dispatchEvent(new CustomEvent('kds-remote-sync', { detail: data.payload }))
                        }
                    } catch (err) {
                        console.error('Failed to parse remote KDS update:', err)
                    }
                }).then(fn => { unlisten = fn })
            }).catch(() => {})

            return () => {
                if (unlisten) unlisten()
            }
        } else {
            // Remote client logic: Connect to the websocket
            const host = window.location.hostname
            const port = window.location.port || '4004' // Default port
            const wsUrl = `ws://${host}:${port}/ws`

            const connect = () => {
                setStatus('reconnecting')
                const ws = new WebSocket(wsUrl)
                socketRef.current = ws

                ws.onopen = () => {
                    setStatus('connected')
                }

                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data)
                        setLastEvent(data)
                        // Trigger local storage sync or state update
                        if (data.event === 'TICKET_UPDATED') {
                             window.dispatchEvent(new CustomEvent('kds-stream-update', { detail: data.payload }))
                        }
                    } catch (err) {
                        console.error('Failed to parse KDS message:', err)
                    }
                }

                ws.onclose = () => {
                    setStatus('error')
                    setTimeout(connect, 3000) // Reconnect after 3s
                }

                ws.onerror = () => {
                    setStatus('error')
                }
            }

            connect()

            return () => {
                socketRef.current?.close()
            }
        }
    }, [isMain])

    const startStream = async (port: number = 4004) => {
        if (!isMain) return
        try {
            const url = await invoke<string>('start_kds_stream', { port })
            setStreamUrl(url)
            setStatus('host')
            return url
        } catch (err) {
            console.error('Failed to start KDS stream:', err)
            setStatus('error')
            throw err
        }
    }

    const broadcast = async (event: string, payload: any) => {
        if (!isMain) return
        try {
            await invoke('broadcast_kds_update', { event, payload })
        } catch (err) {
            console.error('Failed to broadcast KDS update:', err)
        }
    }

    // Remote clients send updates via WebSocket
    const sendViaSocket = (event: string, payload: any) => {
        const ws = socketRef.current
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event, payload }))
        }
    }

    return {
        status,
        streamUrl,
        lastEvent,
        startStream,
        broadcast,
        sendViaSocket,
    }
}

