import type { Ref } from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Button,
} from '@/ui/components'
import {
    PieChart,
    Pie,
    Cell,
    ResponsiveContainer,
    Tooltip,
    Legend
} from 'recharts'
import { formatCurrency, cn } from '@/lib/utils'
import { User, TrendingUp, PieChart as PieChartIcon, Printer, CheckCircle2, HelpCircle, AlertTriangle } from 'lucide-react'

export interface DividendRecipient {
    name: string
    amount: number
    currency: string
    formula: string
    isLinked: boolean
    isFired?: boolean
    avatarUrl?: string
}

interface DividendDistributionPanelProps {
    recipients: DividendRecipient[]
    surplus: number
    paidAmount: number
    baseCurrency: string
    iqdPreference: string
    onPrint?: () => void
    className?: string
    containerRef?: Ref<HTMLDivElement>
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316']
const SURPLUS_COLOR = '#8b5cf6'

export function DividendDistributionPanel({
    recipients,
    surplus,
    paidAmount,
    baseCurrency,
    iqdPreference,
    onPrint,
    className,
    containerRef
}: DividendDistributionPanelProps) {
    const { t, i18n } = useTranslation()
    const isRtl = i18n.dir() === 'rtl'

    const chartData = useMemo(() => {
        const data = recipients
            .filter(r => r.amount > 0 && !r.isFired)
            .map(r => ({
                name: r.name,
                value: r.amount,
                type: 'dividend'
            }))

        if (surplus > 0) {
            data.push({
                name: t('budget.netProfit', 'Surplus'),
                value: surplus,
                type: 'surplus'
            })
        }
        return data
    }, [recipients, surplus, t])

    const totalToDistribute = useMemo(() => {
        const dividendsTotal = recipients.reduce((sum, recipient) => sum + recipient.amount, 0)
        return dividendsTotal + surplus
    }, [recipients, surplus])

    return (
        <div
            ref={containerRef}
            className={cn(
                "space-y-8 [print-color-adjust:exact] -webkit-print-color-adjust:exact",
                className
            )}
        >
            <div className="flex flex-row items-center justify-between text-start">
                <div className="flex items-center gap-4">
                    <div className="p-4 rounded-2xl shadow-inner bg-sky-500/10 text-sky-600 dark:text-sky-400">
                        <PieChartIcon className="w-6 h-6" />
                    </div>
                    <div>
                        <h3 className="text-2xl font-black tracking-tight">{t('budget.dividendsWithdrawal.title', 'Dividends Withdrawal')}</h3>
                        <p className="text-sm font-semibold text-muted-foreground/80">{t('budget.dividendsWithdrawal.subtitle', 'Review and distribute this month dividends')}</p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <div className="text-right">
                        <div className="text-[10px] font-black text-muted-foreground uppercase tracking-widest leading-none mb-1 opacity-60">
                            {t('budget.totalPool', 'Distribution Pool')}
                        </div>
                        <div className="text-3xl font-black tabular-nums tracking-tighter text-sky-600 dark:text-sky-400 leading-none">
                            {formatCurrency(totalToDistribute, baseCurrency as any, iqdPreference as any)}
                        </div>
                    </div>
                    {onPrint && (
                        <Button
                            variant="outline"
                            size="icon"
                            onClick={onPrint}
                            className="w-10 h-10 rounded-xl bg-sky-500/10 border-sky-500/20 text-sky-600 dark:text-sky-400 hover:bg-sky-500/20 transition-all"
                        >
                            <Printer className="w-5 h-5" />
                        </Button>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                <div className="h-[300px] relative">
                    <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                            <Pie
                                data={chartData}
                                cx="50%"
                                cy="50%"
                                innerRadius={80}
                                outerRadius={110}
                                paddingAngle={5}
                                dataKey="value"
                                stroke="none"
                            >
                                {chartData.map((entry, index) => (
                                    <Cell
                                        key={`cell-${index}`}
                                        fill={entry.type === 'surplus' ? SURPLUS_COLOR : COLORS[index % COLORS.length]}
                                        className="hover:opacity-80 transition-opacity cursor-pointer"
                                    />
                                ))}
                            </Pie>
                            <Tooltip
                                contentStyle={{
                                    backgroundColor: 'hsl(var(--card))',
                                    borderRadius: '20px',
                                    border: '1px solid hsl(var(--border))',
                                    padding: '12px',
                                    boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
                                    textAlign: isRtl ? 'right' : 'left'
                                }}
                                itemStyle={{ fontSize: '12px', fontWeight: 'bold' }}
                                formatter={(value: any) => formatCurrency(value, baseCurrency as any, iqdPreference as any)}
                            />
                            <Legend
                                verticalAlign="bottom"
                                height={36}
                                iconType="circle"
                                wrapperStyle={{ fontSize: '11px', fontWeight: 'bold', paddingTop: '10px' }}
                            />
                        </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none">
                        <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground opacity-60">
                            {surplus < 0 ? t('budget.deficit', 'Deficit') : t('budget.netProfit', 'Surplus')}
                        </div>
                        <div className={cn(
                            "text-xl font-black leading-none mt-1",
                            surplus < 0 ? 'text-red-600 dark:text-red-400' : 'text-violet-600 dark:text-violet-400'
                        )}>
                            {surplus < 0 ? '-' : ''}{Math.round((Math.abs(surplus) / (totalToDistribute || 1)) * 100)}%
                        </div>
                    </div>
                </div>

                <div className="space-y-4">
                    <Card className="bg-sky-500/5 border-sky-500/10 rounded-3xl overflow-hidden">
                        <CardContent className="p-5 flex items-center gap-4">
                            <div className="p-3.5 rounded-2xl bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20">
                                <PieChartIcon className="w-5 h-5" />
                            </div>
                            <div>
                                <div className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">{t('budget.dividends', 'Total Dividends')}</div>
                                <div className="text-2xl font-black tabular-nums tracking-tight">{formatCurrency(totalToDistribute - surplus, baseCurrency as any, iqdPreference as any)}</div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="bg-emerald-500/5 border-emerald-500/10 rounded-3xl overflow-hidden shadow-sm">
                        <CardContent className="p-5 flex items-center gap-4">
                            <div className="p-3.5 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                                <CheckCircle2 className="w-5 h-5" />
                            </div>
                            <div>
                                <div className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">
                                    {t('budget.dividendsWithdrawn', 'Dividends Withdrawn')}
                                </div>
                                <div className="text-2xl font-black tabular-nums tracking-tight text-emerald-700 dark:text-emerald-300">
                                    {formatCurrency(paidAmount, baseCurrency as any, iqdPreference as any)}
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className={cn(
                        "rounded-3xl overflow-hidden",
                        surplus < 0 ? 'bg-red-500/5 border-red-500/10' : 'bg-violet-500/5 border-violet-500/10'
                    )}>
                        <CardContent className="p-5 flex items-center gap-4">
                            <div className={cn(
                                "p-3.5 rounded-2xl border",
                                surplus < 0
                                    ? 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20'
                                    : 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20'
                            )}>
                                {surplus < 0 ? <AlertTriangle className="w-5 h-5" /> : <TrendingUp className="w-5 h-5" />}
                            </div>
                            <div>
                                <div className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">
                                    {surplus < 0 ? t('budget.deficit', 'Deficit') : t('budget.netProfit', 'Net Surplus')}
                                </div>
                                <div className={cn(
                                    "text-2xl font-black tabular-nums tracking-tight",
                                    surplus < 0 ? 'text-red-700 dark:text-red-300' : ''
                                )}>
                                    {surplus < 0 ? '-' : ''}{formatCurrency(Math.abs(surplus), baseCurrency as any, iqdPreference as any)}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>

            <Card className="bg-card/40 border-border/30 backdrop-blur-md overflow-hidden rounded-[2.5rem] shadow-sm">
                <CardHeader className="pb-3 px-8 pt-8">
                    <CardTitle className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground/70 flex items-center gap-2">
                        <User className="w-3.5 h-3.5" />
                        {t('budget.distributionDetails', 'Distribution Breakdown')}
                    </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow className="hover:bg-transparent border-border/40">
                                <TableHead className={cn("text-[10px] font-black uppercase tracking-widest px-8", isRtl ? "text-right" : "text-left")}>{t('hr.employee', 'Employee')}</TableHead>
                                <TableHead className="text-center text-[10px] font-black uppercase tracking-widest">{t('hr.status', 'Linked')}</TableHead>
                                <TableHead className="text-center text-[10px] font-black uppercase tracking-widest">{t('hr.formula', 'Formula')}</TableHead>
                                <TableHead className={cn("text-[10px] font-black uppercase tracking-widest px-8", isRtl ? "text-left" : "text-right")}>{t('budget.form.amount', 'Amount')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {recipients.map((recipient, idx) => (
                                <TableRow key={idx} className="hover:bg-primary/5 transition-colors border-border/40 group">
                                    <TableCell className={cn("px-8 py-5", isRtl ? "text-right" : "text-left")}>
                                        <div className="flex items-center gap-3">
                                            {recipient.avatarUrl ? (
                                                <img
                                                    src={recipient.avatarUrl}
                                                    alt={recipient.name}
                                                    className="w-10 h-10 rounded-xl object-cover border border-primary/20 shadow-sm"
                                                />
                                            ) : (
                                                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary font-black text-sm border border-primary/20">
                                                    {recipient.name.charAt(0)}
                                                </div>
                                            )}
                                            <div>
                                                <div className="font-bold group-hover:text-primary transition-colors">{recipient.name}</div>
                                                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-tight opacity-60">
                                                    {recipient.isLinked ? t('hr.linked', 'Account Active') : t('hr.notLinked', 'Manual Entry')}
                                                </div>
                                            </div>
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-center">
                                        {recipient.isLinked ? (
                                            <CheckCircle2 className="w-5 h-5 text-emerald-500 mx-auto" />
                                        ) : (
                                            <HelpCircle className="w-5 h-5 text-muted-foreground mx-auto" />
                                        )}
                                    </TableCell>
                                    <TableCell className="text-center">
                                        <span className="px-3 py-1 rounded-xl bg-secondary text-[11px] font-black uppercase tracking-tighter border border-border/50">
                                            {recipient.formula}
                                        </span>
                                    </TableCell>
                                    <TableCell className={cn("px-8 tabular-nums font-black text-sky-600 dark:text-sky-400 text-lg", isRtl ? "text-left" : "text-right")}>
                                        {formatCurrency(recipient.amount, recipient.currency as any, iqdPreference as any)}
                                    </TableCell>
                                </TableRow>
                            ))}
                            {surplus > 0 && (
                                <TableRow className="bg-violet-500/5 hover:bg-violet-500/10 transition-colors border-t-2 border-violet-500/20">
                                    <TableCell className={cn("px-8 py-5", isRtl ? "text-right" : "text-left")}>
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center text-violet-500 font-black text-sm border border-violet-500/20 shadow-inner">
                                                SIG
                                            </div>
                                            <div>
                                                <div className="font-bold text-violet-700 dark:text-violet-300">{t('budget.netProfit', 'Net Surplus')}</div>
                                                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-tight opacity-60">{t('budget.remainingAfterDivs', 'Retained Earnings')}</div>
                                            </div>
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-center" />
                                    <TableCell className="text-center">
                                        <span className="px-3 py-1 rounded-xl bg-violet-500/20 text-violet-600 dark:text-violet-400 text-[11px] font-black uppercase tracking-tighter border border-violet-500/30">
                                            {t('budget.remainder', 'Remainder')}
                                        </span>
                                    </TableCell>
                                    <TableCell className={cn("px-8 tabular-nums font-black text-violet-700 dark:text-violet-300 text-lg", isRtl ? "text-left" : "text-right")}>
                                        {formatCurrency(surplus, baseCurrency as any, iqdPreference as any)}
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    )
}
