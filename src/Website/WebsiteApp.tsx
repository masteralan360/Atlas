import { useEffect, useRef } from 'react'
import { motion, useScroll, useTransform, type Variants } from 'motion/react'
import { ArrowRight, Check, ChevronRight } from 'lucide-react'

import {
    websiteArchitectureBlocks,
    websiteDesignSignals,
    websiteHeroCommands,
    websiteHeroMetrics,
    websiteNavItems,
    websitePricingPlans,
    websiteProofStrip,
    websiteSpotlights,
    websiteTestimonials,
    websiteWorkflowSteps
} from './content'
import './website.css'

const revealUp: Variants = {
    hidden: { opacity: 0, y: 28 },
    visible: {
        opacity: 1,
        y: 0,
        transition: {
            duration: 0.7,
            ease: [0.22, 1, 0.36, 1]
        }
    }
}

const stagger: Variants = {
    hidden: {},
    visible: {
        transition: {
            staggerChildren: 0.08,
            delayChildren: 0.06
        }
    }
}

const accentClasses = {
    teal: {
        icon: 'bg-emerald-500/12 text-emerald-800',
        border: 'border-emerald-700/10',
        pill: 'bg-emerald-500/10 text-emerald-800'
    },
    clay: {
        icon: 'bg-orange-500/12 text-orange-800',
        border: 'border-orange-800/10',
        pill: 'bg-orange-500/10 text-orange-800'
    },
    ink: {
        icon: 'bg-slate-950 text-white',
        border: 'border-slate-950/10',
        pill: 'bg-slate-950 text-white'
    },
    gold: {
        icon: 'bg-amber-500/14 text-amber-900',
        border: 'border-amber-800/10',
        pill: 'bg-amber-500/12 text-amber-900'
    }
} as const

function SectionHeading({
    eyebrow,
    title,
    description
}: {
    eyebrow: string
    title: string
    description: string
}) {
    return (
        <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.35 }}
            variants={revealUp}
            className="max-w-3xl space-y-5"
        >
            <p className="website-kicker">{eyebrow}</p>
            <h2 className="website-display text-4xl text-[var(--website-ink)] md:text-6xl">{title}</h2>
            <p className="website-copy max-w-2xl text-base md:text-lg">{description}</p>
        </motion.div>
    )
}

export function WebsiteApp() {
    const scrollRef = useRef<HTMLDivElement>(null)
    const { scrollYProgress } = useScroll({ container: scrollRef })
    const heroLift = useTransform(scrollYProgress, [0, 0.22], [0, -72])
    const canvasLift = useTransform(scrollYProgress, [0, 0.26], [0, -38])
    const auraDrift = useTransform(scrollYProgress, [0, 1], [0, 180])

    useEffect(() => {
        const previousTitle = document.title
        document.title = 'Atlas | Business Operating System'
        return () => {
            document.title = previousTitle
        }
    }, [])

    const scrollToSection = (id: string) => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    return (
        <div ref={scrollRef} className="website-shell">
            <motion.div className="website-progress" style={{ scaleX: scrollYProgress }} />
            <motion.div className="website-aura website-aura-left" style={{ y: auraDrift }} />
            <motion.div className="website-aura website-aura-right" style={{ y: useTransform(scrollYProgress, [0, 1], [0, -160]) }} />

            <div className="relative z-10">
                <header className="sticky top-0 z-50 px-4 pt-4 md:px-6">
                    <div className="website-nav-shell mx-auto flex max-w-7xl items-center justify-between gap-4 rounded-full px-4 py-3 md:px-6">
                        <button
                            type="button"
                            onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                            className="flex items-center gap-3 text-left"
                        >
                            <img src="/AtlasClear.svg" alt="Atlas logo" className="h-11 w-11 shrink-0 object-contain" />
                            <div>
                                <div className="text-[11px] font-black uppercase tracking-[0.34em] text-[var(--website-muted)]">Atlas</div>
                                <div className="text-sm font-semibold text-[var(--website-ink)]">Business operating system</div>
                            </div>
                        </button>

                        <nav className="hidden items-center gap-1 md:flex">
                            {websiteNavItems.map((item) => (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => scrollToSection(item.id)}
                                    className="rounded-full px-4 py-2 text-sm font-semibold text-[var(--website-muted)] transition hover:bg-white/70 hover:text-[var(--website-ink)]"
                                >
                                    {item.label}
                                </button>
                            ))}
                        </nav>

                        <button
                            type="button"
                            onClick={() => scrollToSection('pricing')}
                            className="website-cta-primary rounded-full px-4 py-2 text-sm font-semibold md:px-5"
                        >
                            Plan rollout
                        </button>
                    </div>
                </header>

                <main className="px-4 pb-24 md:px-6">
                    <section id="top" className="website-section mx-auto max-w-7xl pt-10 md:pt-16">
                        <div className="grid items-start gap-10 xl:grid-cols-[1.03fr_0.97fr]">
                            <motion.div
                                className="space-y-8 pt-4 md:space-y-10 md:pt-10"
                                style={{ y: heroLift }}
                                initial="hidden"
                                animate="visible"
                                variants={stagger}
                            >
                                <motion.div variants={revealUp} className="space-y-5">
                                    <span className="website-pill inline-flex items-center rounded-full px-4 py-2 text-xs font-black uppercase tracking-[0.28em]">
                                        Unified operations
                                    </span>
                                    <h1 className="website-display max-w-5xl text-5xl text-[var(--website-ink)] md:text-7xl xl:text-[6rem]">
                                        ATLAS ERP
                                    </h1>
                                    <p className="website-copy max-w-2xl text-base md:text-xl">
                                        Atlas brings POS, inventory, CRM, orders, marketplace storefronts, finance, HR, analytics, and
                                        workspace control into one system so teams can run the business without stitching together separate tools.
                                    </p>
                                </motion.div>

                                <motion.div variants={revealUp} className="flex flex-wrap gap-3">
                                    <button
                                        type="button"
                                        onClick={() => scrollToSection('architecture')}
                                        className="website-cta-primary inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold"
                                    >
                                        Explore architecture
                                        <ArrowRight className="h-4 w-4" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => scrollToSection('modules')}
                                        className="website-cta-secondary inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold"
                                    >
                                        View modules
                                        <ChevronRight className="h-4 w-4" />
                                    </button>
                                </motion.div>

                                <motion.div variants={stagger} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                    {websiteHeroMetrics.map((metric) => (
                                        <motion.div key={metric.label} variants={revealUp} className="website-stat-card rounded-[28px] px-5 py-5">
                                            <div className="text-3xl font-black tracking-tight text-[var(--website-ink)]">{metric.value}</div>
                                            <div className="mt-2 text-sm font-medium text-[var(--website-muted)]">{metric.label}</div>
                                        </motion.div>
                                    ))}
                                </motion.div>

                                <motion.div variants={stagger} className="grid gap-3 md:grid-cols-2">
                                    {websiteDesignSignals.map((item) => (
                                        <motion.div key={item.label} variants={revealUp} className="website-note-card rounded-[26px] px-5 py-4">
                                            <div className="flex items-start gap-4">
                                                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-[var(--website-ink)] shadow-sm">
                                                    <item.icon className="h-5 w-5" />
                                                </div>
                                                <div>
                                                    <div className="text-[11px] font-black uppercase tracking-[0.24em] text-[var(--website-muted)]">{item.label}</div>
                                                    <div className="mt-2 text-sm font-semibold text-[var(--website-ink)]">{item.value}</div>
                                                </div>
                                            </div>
                                        </motion.div>
                                    ))}
                                </motion.div>
                            </motion.div>

                            <motion.div
                                initial="hidden"
                                animate="visible"
                                variants={revealUp}
                                style={{ y: canvasLift }}
                                className="website-canvas-shell"
                            >
                                <div className="website-canvas rounded-[38px] p-5 md:p-6">
                                    <div className="website-canvas-header">
                                        <div>
                                            <p className="website-kicker text-white/52">Atlas workspace map</p>
                                            <h3 className="website-display mt-3 text-3xl text-white md:text-4xl">One board for the moving parts.</h3>
                                        </div>
                                        <span className="website-canvas-badge">Connected operating model</span>
                                    </div>

                                    <div className="mt-6 grid gap-3 md:grid-cols-2">
                                        {websiteHeroCommands.map((command) => (
                                            <div key={command.label} className="website-command-card rounded-[24px] p-4">
                                                <div className="flex items-start justify-between gap-4">
                                                    <div>
                                                        <div className="text-[10px] font-black uppercase tracking-[0.26em] text-white/46">{command.label}</div>
                                                        <div className="mt-2 text-lg font-black text-white">{command.value}</div>
                                                        <div className="mt-2 text-sm text-white/62">{command.note}</div>
                                                    </div>
                                                    <div className="website-command-icon">
                                                        <command.icon className="h-5 w-5" />
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>

                                    <div className="mt-6 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
                                        <div className="website-canvas-panel rounded-[28px] p-5">
                                            <div className="text-[10px] font-black uppercase tracking-[0.28em] text-white/44">Linked flow</div>
                                            <div className="mt-4 space-y-4">
                                                {websiteWorkflowSteps.map((step) => (
                                                    <div key={step.step} className="flex items-start gap-4">
                                                        <div className="website-step-chip">{step.step}</div>
                                                        <div>
                                                            <div className="text-sm font-black text-white">{step.title}</div>
                                                            <div className="mt-1 text-sm text-white/58">{step.outcome}</div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        <div className="space-y-4">
                                            <div className="website-canvas-panel rounded-[28px] p-5">
                                                <div className="text-[10px] font-black uppercase tracking-[0.28em] text-white/44">Deployment</div>
                                                <div className="mt-3 text-lg font-black text-white">Local, cloud, or hybrid</div>
                                                <p className="mt-2 text-sm text-white/58">
                                                    Atlas keeps the frontline usable and keeps reporting close to the source workflow.
                                                </p>
                                            </div>
                                            <div className="website-canvas-panel rounded-[28px] p-5">
                                                <div className="text-[10px] font-black uppercase tracking-[0.28em] text-white/44">Core module mix</div>
                                                <div className="mt-3 flex flex-wrap gap-2">
                                                    {websiteProofStrip.slice(0, 6).map((item) => (
                                                        <span key={item} className="website-chip-dark">
                                                            {item}
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        </div>
                    </section>

                    <section id="architecture" className="website-section mx-auto mt-24 max-w-7xl space-y-12 md:mt-32">
                        <SectionHeading
                            eyebrow="Architecture"
                            title="Atlas connects the business layers that usually break apart as teams grow."
                            description="Commerce, inventory, finance, customer operations, marketplace demand, and people management stay in one shared system so the handoff between teams becomes part of the flow."
                        />

                        <motion.div
                            initial="hidden"
                            whileInView="visible"
                            viewport={{ once: true, amount: 0.2 }}
                            variants={stagger}
                            className="grid gap-5 xl:grid-cols-[1.12fr_0.88fr]"
                        >
                            <motion.article variants={revealUp} className="website-featured-panel rounded-[36px] p-8 md:p-10">
                                <p className="website-kicker">Connected operations</p>
                                <h3 className="website-display mt-5 text-4xl text-[var(--website-ink)] md:text-5xl">
                                    Atlas is strongest when the handoff between selling, stock, finance, and reporting disappears.
                                </h3>
                                <p className="website-copy mt-5 max-w-2xl text-base">
                                    Every transaction, movement, and balance update stays closer to the source event, which gives managers a clearer read on the business without rebuilding the picture in spreadsheets.
                                </p>

                                <div className="mt-8 grid gap-4 md:grid-cols-3">
                                    {[
                                        'Checkout to invoice',
                                        'Stock move to ledger',
                                        'Customer demand to reporting'
                                    ].map((item) => (
                                        <div key={item} className="website-line-card rounded-[24px] p-4">
                                            <div className="text-sm font-black text-[var(--website-ink)]">{item}</div>
                                        </div>
                                    ))}
                                </div>
                            </motion.article>

                            <motion.div variants={revealUp} className="website-panel rounded-[36px] p-6 md:p-8">
                                <div className="text-[11px] font-black uppercase tracking-[0.28em] text-[var(--website-muted)]">Surface inventory</div>
                                <div className="mt-5 flex flex-wrap gap-2">
                                    {websiteProofStrip.map((item) => (
                                        <span key={item} className="website-chip-light">
                                            {item}
                                        </span>
                                    ))}
                                </div>
                            </motion.div>
                        </motion.div>
                    </section>

                    <section id="modules" className="website-section mx-auto mt-24 max-w-7xl space-y-12 md:mt-32">
                        <SectionHeading
                            eyebrow="Modules"
                            title="Each module is built for a distinct operating job, but the whole system stays coherent."
                            description="Atlas covers frontline sales, stock movement, finance control, customer operations, marketplace workflows, and people management inside one shared product model."
                        />

                        <motion.div
                            initial="hidden"
                            whileInView="visible"
                            viewport={{ once: true, amount: 0.12 }}
                            variants={stagger}
                            className="grid gap-5 xl:grid-cols-2"
                        >
                            {websiteArchitectureBlocks.map((block, index) => {
                                const tone = accentClasses[block.accent]

                                return (
                                    <motion.article
                                        key={block.title}
                                        variants={revealUp}
                                        className={[
                                            'website-panel website-card-hover rounded-[34px] p-6 md:p-8',
                                            tone.border,
                                            index === 0 ? 'xl:col-span-2' : ''
                                        ].join(' ')}
                                    >
                                        <div className="flex items-start justify-between gap-6">
                                            <div className="max-w-2xl">
                                                <p className="website-kicker">{block.eyebrow}</p>
                                                <h3 className="website-display mt-4 text-3xl text-[var(--website-ink)] md:text-4xl">{block.title}</h3>
                                                <p className="website-copy mt-4 text-base">{block.description}</p>
                                            </div>
                                            <div className={['flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px]', tone.icon].join(' ')}>
                                                <block.icon className="h-6 w-6" />
                                            </div>
                                        </div>

                                        <div className="mt-8 grid gap-3 md:grid-cols-2">
                                            {block.points.map((point) => (
                                                <div key={point} className="website-line-card rounded-[22px] p-4">
                                                    <div className="flex items-start gap-3">
                                                        <span className={['mt-0.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full text-[11px] font-black', tone.pill].join(' ')}>
                                                            <Check className="h-3.5 w-3.5" />
                                                        </span>
                                                        <span className="text-sm font-semibold text-[var(--website-ink)]">{point}</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </motion.article>
                                )
                            })}
                        </motion.div>

                        <motion.div
                            initial="hidden"
                            whileInView="visible"
                            viewport={{ once: true, amount: 0.12 }}
                            variants={stagger}
                            className="grid gap-5 md:grid-cols-2 xl:grid-cols-3"
                        >
                            {websiteSpotlights.map((spotlight) => (
                                <motion.article key={spotlight.title} variants={revealUp} className="website-spotlight rounded-[30px] p-6">
                                    <div className="flex h-12 w-12 items-center justify-center rounded-[18px] bg-white text-[var(--website-ink)] shadow-sm">
                                        <spotlight.icon className="h-5 w-5" />
                                    </div>
                                    <p className="website-kicker mt-5">{spotlight.eyebrow}</p>
                                    <h3 className="mt-3 text-2xl font-black tracking-tight text-[var(--website-ink)]">{spotlight.title}</h3>
                                    <p className="website-copy mt-3 text-sm">{spotlight.description}</p>
                                </motion.article>
                            ))}
                        </motion.div>
                    </section>

                    <section id="workflow" className="website-section mx-auto mt-24 max-w-7xl space-y-12 md:mt-32">
                        <SectionHeading
                            eyebrow="Workflow"
                            title="Atlas follows the actual motion of the business from demand to reporting."
                            description="Teams capture revenue, move stock and money in context, then read performance from the same operating trail instead of reconciling disconnected systems."
                        />

                        <motion.div
                            initial="hidden"
                            whileInView="visible"
                            viewport={{ once: true, amount: 0.15 }}
                            variants={stagger}
                            className="grid gap-5 lg:grid-cols-3"
                        >
                            {websiteWorkflowSteps.map((step) => (
                                <motion.article key={step.step} variants={revealUp} className="website-panel rounded-[32px] p-6 md:p-7">
                                    <div className="flex items-center justify-between gap-4">
                                        <div className="website-step-chip website-step-chip-light">{step.step}</div>
                                        <div className="text-[10px] font-black uppercase tracking-[0.28em] text-[var(--website-muted)]">Operating step</div>
                                    </div>
                                    <h3 className="mt-6 text-2xl font-black tracking-tight text-[var(--website-ink)]">{step.title}</h3>
                                    <p className="website-copy mt-4 text-sm">{step.description}</p>
                                    <div className="mt-5 rounded-[22px] bg-[var(--website-soft-strong)] px-4 py-3 text-sm font-semibold text-[var(--website-ink)]">
                                        {step.outcome}
                                    </div>
                                    <div className="mt-6 space-y-3">
                                        {step.points.map((point) => (
                                            <div key={point} className="flex items-center gap-3 text-sm font-medium text-[var(--website-ink)]">
                                                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--website-ink)] text-white">
                                                    <ChevronRight className="h-4 w-4" />
                                                </div>
                                                {point}
                                            </div>
                                        ))}
                                    </div>
                                </motion.article>
                            ))}
                        </motion.div>
                    </section>

                    <section className="mx-auto mt-24 max-w-7xl space-y-12 md:mt-32">
                        <SectionHeading
                            eyebrow="Customer teams"
                            title="Atlas fits businesses that need operations, finance, and service teams to work from the same source of truth."
                            description="These examples reflect the module combinations Atlas already supports across retail, wholesale, and service-heavy operating models."
                        />

                        <motion.div
                            initial="hidden"
                            whileInView="visible"
                            viewport={{ once: true, amount: 0.15 }}
                            variants={stagger}
                            className="grid gap-5 xl:grid-cols-[1.08fr_0.92fr]"
                        >
                            <motion.blockquote variants={revealUp} className="website-quote-card rounded-[36px] p-8 md:p-10">
                                <p className="website-display text-3xl text-white md:text-5xl">
                                    "{websiteTestimonials[0].quote}"
                                </p>
                                <footer className="mt-10 border-t border-white/10 pt-5">
                                    <div className="text-[11px] font-black uppercase tracking-[0.28em] text-white/52">{websiteTestimonials[0].role}</div>
                                    <div className="mt-2 text-sm font-semibold text-white/78">{websiteTestimonials[0].company}</div>
                                </footer>
                            </motion.blockquote>

                            <div className="grid gap-5">
                                {websiteTestimonials.slice(1).map((testimonial) => (
                                    <motion.blockquote key={testimonial.quote} variants={revealUp} className="website-panel rounded-[30px] p-6">
                                        <p className="text-lg font-semibold leading-8 text-[var(--website-ink)]">"{testimonial.quote}"</p>
                                        <footer className="mt-8 border-t border-[var(--website-border)] pt-5">
                                            <div className="text-[11px] font-black uppercase tracking-[0.24em] text-[var(--website-muted)]">{testimonial.role}</div>
                                            <div className="mt-2 text-sm font-medium text-[var(--website-ink)]">{testimonial.company}</div>
                                        </footer>
                                    </motion.blockquote>
                                ))}
                            </div>
                        </motion.div>
                    </section>

                    <section id="pricing" className="website-section mx-auto mt-24 max-w-7xl space-y-12 md:mt-32">
                        <SectionHeading
                            eyebrow="Pricing"
                            title="Choose the package that matches how much of the business you want Atlas to run."
                            description="The tiers expand from core sales and stock control into finance, CRM, marketplace workflows, and team operations."
                        />

                        <motion.div
                            initial="hidden"
                            whileInView="visible"
                            viewport={{ once: true, amount: 0.15 }}
                            variants={stagger}
                            className="grid gap-5 xl:grid-cols-3"
                        >
                            {websitePricingPlans.map((plan) => (
                                <motion.article
                                    key={plan.name}
                                    variants={revealUp}
                                    className={[
                                        'rounded-[34px] p-6 md:p-7',
                                        plan.highlight ? 'website-pricing-card-featured' : 'website-panel'
                                    ].join(' ')}
                                >
                                    <div className="flex items-start justify-between gap-4">
                                        <div>
                                            <div className="website-kicker">Atlas package</div>
                                            <h3 className="website-display mt-4 text-3xl text-[var(--website-ink)]">{plan.name}</h3>
                                        </div>
                                        {plan.highlight ? (
                                            <span className="website-cta-primary rounded-full px-3 py-1.5 text-xs font-black uppercase tracking-[0.18em]">
                                                Recommended
                                            </span>
                                        ) : null}
                                    </div>

                                    <div className="mt-8 text-3xl font-black tracking-tight text-[var(--website-ink)]">{plan.priceLabel}</div>
                                    <p className="website-copy mt-4 text-sm">{plan.description}</p>

                                    <div className="mt-8 space-y-3">
                                        {plan.features.map((feature) => (
                                            <div key={feature} className="flex items-center gap-3 text-sm font-medium text-[var(--website-ink)]">
                                                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--website-ink)] text-white">
                                                    <Check className="h-4 w-4" />
                                                </div>
                                                {feature}
                                            </div>
                                        ))}
                                    </div>

                                    <button
                                        type="button"
                                        onClick={() => scrollToSection('top')}
                                        className={[
                                            'mt-8 inline-flex w-full items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold transition',
                                            plan.highlight ? 'website-cta-primary' : 'website-cta-secondary'
                                        ].join(' ')}
                                    >
                                        {plan.cta}
                                        <ArrowRight className="h-4 w-4" />
                                    </button>
                                </motion.article>
                            ))}
                        </motion.div>
                    </section>

                    <section className="mx-auto mt-24 max-w-7xl md:mt-32">
                        <motion.div
                            initial="hidden"
                            whileInView="visible"
                            viewport={{ once: true, amount: 0.3 }}
                            variants={revealUp}
                            className="website-final-panel rounded-[40px] p-8 md:p-12"
                        >
                            <div className="grid gap-8 lg:grid-cols-[1.08fr_0.92fr] lg:items-end">
                                <div className="space-y-5">
                                    <p className="website-kicker text-white/52">Atlas rollout</p>
                                    <h2 className="website-display max-w-3xl text-4xl text-white md:text-6xl">
                                        Atlas is strongest when the business no longer has to switch mental models every hour.
                                    </h2>
                                    <p className="max-w-2xl text-base leading-8 text-white/68 md:text-lg">
                                        Bring sales, inventory, marketplace demand, finance, and team visibility into one operating system built around how the work actually moves.
                                    </p>
                                </div>

                                <div className="grid gap-3 sm:grid-cols-2">
                                    <button
                                        type="button"
                                        onClick={() => scrollToSection('modules')}
                                        className="website-cta-primary rounded-full px-6 py-3 text-sm font-semibold"
                                    >
                                        Review modules
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => scrollToSection('pricing')}
                                        className="rounded-full border border-white/16 bg-white/6 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
                                    >
                                        Plan scope
                                    </button>
                                </div>
                            </div>
                        </motion.div>
                    </section>
                </main>
            </div>
        </div>
    )
}
