import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, CircleHelp, Play, Search } from 'lucide-react'
import { HintPlayerOverlay } from '@/ui/components/HintPlayerOverlay'
import { VideoThumbnail } from '@/ui/components/VideoThumbnail'
import { HELP_TOPICS, getTopicVideoSrc, searchHelp, type HelpTopic } from '@/help/helpIndex'

interface ChatMessage {
    id: number
    role: 'user' | 'assistant'
    query?: string
    topic?: HelpTopic
    /** True when the query had no strong match and the video is only suggested. */
    isSuggested?: boolean
}

export function Help() {
    const { t, i18n } = useTranslation()
    const [query, setQuery] = useState('')
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [playingTopic, setPlayingTopic] = useState<HelpTopic | null>(null)
    const idRef = useRef(0)
    const scrollRef = useRef<HTMLDivElement>(null)

    const popularQueries = HELP_TOPICS.map((topic) => t(topic.titleKey))

    const ask = (rawQuery: string) => {
        const trimmed = rawQuery.trim()
        if (!trimmed) return
        const [best] = searchHelp(trimmed, i18n.language)
        setMessages((current) => [
            ...current,
            { id: ++idRef.current, role: 'user', query: trimmed },
            {
                id: ++idRef.current,
                role: 'assistant',
                topic: best?.topic,
                isSuggested: !best,
            },
        ])
        setQuery('')
    }

    const handleSubmit = (event: React.FormEvent) => {
        event.preventDefault()
        ask(query)
    }

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }, [messages])

    return (
        <div className="mx-auto flex h-full max-w-3xl flex-col gap-4">
            <header className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
                    <CircleHelp className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                    <h1 className="text-2xl font-black">{t('help.title', { defaultValue: 'Help Center' })}</h1>
                    <p className="truncate text-sm text-muted-foreground">
                        {t('help.subtitle', { defaultValue: 'Search for video guides and answers' })}
                    </p>
                </div>
            </header>

            <form
                onSubmit={handleSubmit}
                className="flex items-center gap-2 rounded-2xl border border-border/60 bg-background/80 p-2 shadow-sm transition-colors focus-within:border-primary/40"
            >
                <Search className="ms-2 h-5 w-5 shrink-0 text-muted-foreground" />
                <input
                    autoComplete="off"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('help.placeholder', { defaultValue: 'Ask a question, e.g. "How to add stock"...' })}
                    aria-label={t('help.placeholder', { defaultValue: 'Ask a question' })}
                    className="h-10 w-full min-w-0 bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground/70"
                />
                <button
                    type="submit"
                    aria-label={t('help.send', { defaultValue: 'Send' })}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                    disabled={!query.trim()}
                >
                    <ArrowUp className="h-5 w-5" />
                </button>
            </form>

            <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70">
                    {t('help.popular', { defaultValue: 'Popular' })}
                </span>
                {popularQueries.map((popularQuery) => (
                    <button
                        key={popularQuery}
                        type="button"
                        onClick={() => ask(popularQuery)}
                        className="flex items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-3 py-1.5 text-xs font-semibold text-foreground/80 transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
                    >
                        <Play className="h-3 w-3 fill-current" />
                        {popularQuery}
                    </button>
                ))}
            </div>

            <div
                ref={scrollRef}
                className="custom-scrollbar flex-1 space-y-4 overflow-y-auto rounded-2xl border border-border/40 bg-muted/20 p-4"
            >
                {messages.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-center">
                        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                            <CircleHelp className="h-7 w-7" />
                        </div>
                        <h2 className="text-lg font-black">
                            {t('help.welcome.title', { defaultValue: 'How can we help you?' })}
                        </h2>
                        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                            {t('help.welcome.text', {
                                defaultValue: 'Ask anything about Atlas and a video guide will appear. Try a popular topic above.',
                            })}
                        </p>
                    </div>
                ) : (
                    messages.map((message) => {
                        if (message.role === 'user') {
                            return (
                                <div key={message.id} className="flex justify-end rtl:justify-start">
                                    <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm rtl:rounded-br-2xl rtl:rounded-bl-sm">
                                        {message.query}
                                    </div>
                                </div>
                            )
                        }

                        if (!message.topic) {
                            return (
                                <div key={message.id} className="flex items-start gap-3">
                                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                                        <CircleHelp className="h-4 w-4" />
                                    </div>
                                    <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-border/50 bg-background px-4 py-3 text-sm font-medium text-foreground/90 shadow-sm">
                                        {t('help.noResults', { defaultValue: 'I could not find a matching guide yet. Try a different wording, or pick a popular topic above.' })}
                                    </div>
                                </div>
                            )
                        }

                        const topic = message.topic
                        const topicVideoSrc = getTopicVideoSrc(topic, i18n.language)
                        return (
                            <div key={message.id} className="flex items-start gap-3">
                                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                                    <CircleHelp className="h-4 w-4" />
                                </div>
                                <div className="min-w-0 max-w-[85%] space-y-2">
                                    {message.isSuggested && (
                                        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold text-amber-700">
                                            {t('help.suggested', { defaultValue: 'No exact match — this might help' })}
                                        </div>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => setPlayingTopic(topic)}
                                        className="group block w-full overflow-hidden rounded-2xl border border-border/50 bg-background text-start shadow-sm transition-all hover:border-primary/30 hover:shadow-md"
                                    >
                                        <VideoThumbnail src={topicVideoSrc} />
                                        <div className="space-y-1 p-4">
                                            <h3 className="line-clamp-2 text-sm font-black">
                                                {t(topic.titleKey)}
                                            </h3>
                                            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                                                {t(topic.descriptionKey)}
                                            </p>
                                            <div className="flex items-center gap-2 pt-1">
                                                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                                                    <Play className="h-3.5 w-3.5 fill-current" />
                                                    {t('help.watchNow', { defaultValue: 'Watch now' })}
                                                </span>
                                            </div>
                                        </div>
                                    </button>
                                </div>
                            </div>
                        )
                    })
                )}
            </div>

            <p className="text-center text-xs font-medium text-muted-foreground/70">
                {t('help.comingSoon', { defaultValue: 'More video guides are on the way.' })}
            </p>

            {playingTopic && (
                <HintPlayerOverlay
                    open
                    onClose={() => setPlayingTopic(null)}
                    src={getTopicVideoSrc(playingTopic, i18n.language)}
                    title={t(playingTopic.titleKey)}
                />
            )}
        </div>
    )
}
