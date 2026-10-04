import { useState } from 'react'
import { useLocation } from 'wouter'
import { Button, Input, Label, LanguageSwitcher, ThemeToggle } from '@/ui/components'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/components/select'
import { Loader2, Timer, Briefcase, FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useFavicon } from '@/hooks/useFavicon'
import { useAuth } from '@/auth'
import type { CurrencyCode } from '@/local-db/models'
import {
  DEMO_JOBS,
  DEMO_OPTIONAL_MODULE_CODES,
  DEMO_TIME_DEFAULT,
  inspectDemoOptionalModuleCodes,
  parseDemoOptionalModuleCodes,
} from './demoConfig'
import { createDemoWorkspace } from './demoService'
import { captureDemoBrowserState, clearStoredDemoWorkspaces } from './demoCleanup'
import { OptionalModuleCodesInput } from './OptionalModuleCodesInput'

export function DemoConfigPage() {
  const [, setLocation] = useLocation()
  const { signInWithDemo } = useAuth()
  const { t } = useTranslation()

  const [workspaceName, setWorkspaceName] = useState('')
  const [optionalModuleCodes, setOptionalModuleCodes] = useState('')
  const [timeLimit, setTimeLimit] = useState(DEMO_TIME_DEFAULT)
  const [currency, setCurrency] = useState<CurrencyCode>('iqd')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const optionalModuleCodeIssues = inspectDemoOptionalModuleCodes(optionalModuleCodes)
  let optionalModuleCodesValid = true
  try {
    parseDemoOptionalModuleCodes(optionalModuleCodes)
  } catch {
    optionalModuleCodesValid = false
  }

  useFavicon()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      // Validate before starting, then demoService validates again before persistence.
      parseDemoOptionalModuleCodes(optionalModuleCodes)
    } catch {
      return
    }

    setIsLoading(true)

    const name = workspaceName.trim() || t('demo.job.general', { defaultValue: 'General Demo' })

    try {
      await clearStoredDemoWorkspaces()
      const result = await createDemoWorkspace(name, 'general', timeLimit, currency, optionalModuleCodes)
      await captureDemoBrowserState(result.workspaceId)
      await signInWithDemo(result)
      setLocation('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('demo.createError', { defaultValue: 'Failed to create demo workspace' }))
    } finally {
      setIsLoading(false)
    }
  }

  const timeOptions = [5, 10, 15, 45]

  return (
    <div className={cn(
      "flex bg-white dark:bg-slate-950 transition-colors duration-300",
      // @ts-ignore
      !!window.__TAURI_INTERNALS__
        ? "h-[calc(100vh-var(--titlebar-height))] mt-[var(--titlebar-height)]"
        : "h-screen w-full"
    )}>
      <div className="hidden lg:flex lg:w-1/2 relative bg-white dark:bg-slate-950 transition-colors duration-300">
        <div className="absolute inset-4 overflow-hidden rounded-[2.5rem] bg-teal-950 shadow-2xl shadow-teal-900/20 border border-teal-800/50">
          <div className="absolute inset-0 overflow-hidden bg-[#042f2e]">
            <svg className="absolute inset-0 w-full h-full opacity-60" viewBox="0 0 100 100" preserveAspectRatio="none">
              <defs>
                <linearGradient id="dd1" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#0d9488" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="transparent" />
                </linearGradient>
                <linearGradient id="dd2" x1="100%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#14b8a6" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="transparent" />
                </linearGradient>
              </defs>
              <path d="M0 0L40 0L20 40Z" fill="url(#dd1)" />
              <path d="M40 0L100 0L70 30Z" fill="url(#dd2)" />
              <path d="M100 0L100 60L60 40Z" fill="url(#dd1)" />
              <path d="M100 60L100 100L40 80Z" fill="url(#dd2)" />
              <path d="M100 100L0 100L30 50Z" fill="url(#dd1)" />
              <path d="M0 100L0 40L40 60Z" fill="url(#dd2)" />
              <path d="M0 40L0 0L50 50Z" fill="url(#dd1)" />
              <path d="M20 40L70 30L60 70Z" fill="#0d9488" opacity="0.1" />
              <path d="M30 50L60 40L40 80Z" fill="#14b8a6" opacity="0.1" />
            </svg>
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(45,212,191,0.15),transparent_60%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_80%,rgba(13,148,136,0.2),transparent_70%)]" />
          </div>
          <div className="relative z-10 w-full h-full p-12 flex flex-col justify-between text-white">
            <div className="space-y-12">
              <img src="/logo-wide.png" alt="Atlas Logo" className="h-10 w-auto object-contain brightness-0 invert" />
              <div className="space-y-4">
                <h2 className="text-5xl font-bold tracking-tight leading-tight">
                  {t('demo.title', 'Try Atlas Demo')}
                </h2>
                <p className="text-xl text-teal-100/80 max-w-md font-light leading-relaxed">
                  {t('demo.subtitle', 'Configure your demo workspace to explore Atlas features before signing up.')}
                </p>
              </div>
            </div>
            <div className="relative mt-auto group w-full max-w-2xl self-center">
              <div className="relative overflow-hidden rounded-2xl shadow-[0_32px_64px_-16px_rgba(0,0,0,0.6)] border border-gray-500/30 bg-teal-900/40 backdrop-blur-sm">
                <div className="p-8 space-y-4">
                  <div className="flex items-center gap-3">
                    <Timer className="w-5 h-5 text-teal-400" />
                    <span className="text-teal-100/80">{t('demo.autoDelete', 'Auto-deletes after the configured time limit')}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Briefcase className="w-5 h-5 text-teal-400" />
                    <span className="text-teal-100/80">{t('demo.pickJob', 'Pick a demo type to see relevant features')}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <FileText className="w-5 h-5 text-teal-400" />
                    <span className="text-teal-100/80">{t('demo.noSignup', 'No account required — just configure and explore')}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="w-full lg:w-1/2 flex flex-col items-center p-6 md:p-12 lg:p-16 bg-white dark:bg-slate-950 overflow-y-auto">
        <div className="w-full max-w-sm space-y-8 my-auto">
          <div className="flex flex-col items-center text-center space-y-4">
            <div className="w-16 h-16 bg-black dark:bg-slate-900 rounded-2xl flex items-center justify-center p-2 shadow-lg border border-white/10">
              <img src="/logo.png" alt="Atlas" className="w-full h-full object-contain" />
            </div>
            <div className="space-y-1">
              <h1 className="text-2xl font-bold text-teal-800 dark:text-teal-400 tracking-tight">{t('demo.configureDemo', 'Configure Demo')}</h1>
              <p className="text-sm text-gray-500 dark:text-slate-400 font-medium">{t('demo.setupSubtitle', 'Set up your temporary workspace')}</p>
            </div>
          </div>

          {error && (
            <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/30 text-sm text-red-600 dark:text-red-400 animate-in fade-in slide-in-from-top-1">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="ws-name" className="text-xs font-semibold text-gray-700 dark:text-slate-300 uppercase tracking-wider pl-1">
                  {t('demo.workspaceName', 'Workspace Name')}
                </Label>
                <Input
                  id="ws-name"
                  type="text"
                  placeholder={t('demo.wsPlaceholder', 'My Demo Workspace')}
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  className="h-12 bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 rounded-xl focus:ring-teal-500 dark:focus:ring-teal-400 focus:border-teal-500 dark:focus:border-teal-400 transition-all text-gray-900 dark:text-white placeholder:text-gray-300 dark:placeholder:text-slate-600"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-semibold text-gray-700 dark:text-slate-300 uppercase tracking-wider pl-1">
                  {t('demo.demoType', 'Workspace Job / Demo Type')}
                </Label>
                <div className="grid gap-2">
                  {DEMO_JOBS.map((job) => (
                    <div
                      key={job.id}
                      className="rounded-xl border border-teal-500 bg-teal-50 p-3 text-sm font-semibold text-teal-800 dark:bg-teal-950/30 dark:text-teal-300"
                    >
                      {t(`demo.job.${job.id}`, job.label)}
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-semibold text-gray-700 dark:text-slate-300 uppercase tracking-wider pl-1">
                  {t('demo.currency', 'Currency')}
                </Label>
                <Select value={currency} onValueChange={(v) => setCurrency(v as CurrencyCode)}>
                  <SelectTrigger className="h-12 bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 rounded-xl focus:ring-teal-500 dark:focus:ring-teal-400 transition-all">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="iqd">IQD (دينار عراقي)</SelectItem>
                    <SelectItem value="usd">USD ($)</SelectItem>
                    <SelectItem value="eur">EUR (€)</SelectItem>
                    <SelectItem value="try">TRY (₺)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="optional-module-codes" className="text-xs font-semibold text-gray-700 dark:text-slate-300 uppercase tracking-wider pl-1">
                  {t('demo.optionalModules', 'Optional Modules')}
                </Label>
                <OptionalModuleCodesInput
                  id="optional-module-codes"
                  value={optionalModuleCodes}
                  onChange={setOptionalModuleCodes}
                  placeholder={t('demo.optionalModulesPlaceholder', 'CE-CA-OFB')}
                  invalidDescriptionId="optional-module-codes-help"
                  invalid={!optionalModuleCodesValid}
                />
                <p
                  id="optional-module-codes-help"
                  className={cn(
                    'text-xs leading-relaxed pl-1',
                    optionalModuleCodesValid
                      ? 'text-gray-500 dark:text-slate-400'
                      : 'text-red-600/70 dark:text-red-400/70',
                  )}
                >
                  {optionalModuleCodeIssues.invalidCodes.length
                    ? t('demo.optionalModulesInvalidCodes', {
                      codes: optionalModuleCodeIssues.invalidCodes.join(', '),
                      defaultValue: 'Unsupported module code(s): {{codes}}.',
                    })
                    : optionalModuleCodeIssues.incompleteCode
                      ? t('demo.optionalModulesIncompleteCode', {
                        code: optionalModuleCodeIssues.incompleteCode,
                        defaultValue: 'Complete the module code: {{code}}.',
                      })
                      : optionalModuleCodeIssues.hasMalformedSeparator
                        ? t('demo.optionalModulesMalformedSeparator', {
                          defaultValue: 'Remove the extra or trailing hyphen.',
                        })
                        : optionalModuleCodeIssues.requiresAgentCode
                          ? t('demo.agentModuleRequired', 'SAC and ASA require the AGENT code.')
                          : t('demo.optionalModulesHelp', 'Enter supported module codes separated by hyphens or spaces. Each code must be complete.')}
                </p>
                <p className="text-xs leading-relaxed text-gray-400 dark:text-slate-500 pl-1">
                  {t('demo.optionalModulesSupported', 'Supported codes')}: {DEMO_OPTIONAL_MODULE_CODES.join(', ')}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-semibold text-gray-700 dark:text-slate-300 uppercase tracking-wider pl-1">
                  {t('demo.timeLimit', 'Demo Time Limit')}
                </Label>
                <div className="flex gap-2">
                  {timeOptions.map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      onClick={() => setTimeLimit(minutes)}
                      className={cn(
                        'flex-1 p-3 rounded-xl border text-sm font-medium transition-all',
                        timeLimit === minutes
                          ? 'border-teal-500 bg-teal-50 dark:bg-teal-950/30 text-teal-700 dark:text-teal-300 ring-1 ring-teal-500'
                          : 'border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-gray-700 dark:text-slate-300 hover:border-teal-300 dark:hover:border-teal-700'
                      )}
                    >
                      {minutes} {t('demo.minutes', 'min')}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-400 dark:text-slate-500 mt-1 pl-1">
                  {t('demo.timeRange', 'Between 5 and 45 minutes')}
                </p>
              </div>
            </div>

            <Button
              type="submit"
              className="w-full h-12 bg-teal-600 hover:bg-teal-700 dark:bg-teal-500 dark:hover:bg-teal-600 text-white font-semibold rounded-xl shadow-md hover:shadow-lg transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isLoading || !optionalModuleCodesValid}
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                  {t('demo.creating', 'Creating Demo...')}
                </>
              ) : (
                t('demo.start', 'Start Demo')
              )}
            </Button>
          </form>

          <div className="text-center">
            <button
              onClick={() => setLocation('/login')}
              className="text-sm text-gray-500 dark:text-slate-400 hover:text-teal-600 dark:hover:text-teal-400 transition-colors"
            >
              {t('demo.backToLogin', 'Back to Sign In')}
            </button>
          </div>

          <div className={cn(
            "fixed max-sm:hidden flex flex-col sm:flex-row items-center gap-3 transition-all duration-300 z-[100]",
            // @ts-ignore
            !!window.__TAURI_INTERNALS__ ? "top-[60px] end-6" : "top-2 end-6"
          )}>
            <LanguageSwitcher className="w-[110px] sm:w-[140px]" />
            <ThemeToggle className="w-[100px] sm:w-[130px]" />
          </div>
        </div>
      </div>
    </div>
  )
}
