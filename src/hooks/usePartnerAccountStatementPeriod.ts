import { useEffect, useMemo, useRef, useState } from 'react'

import { supabase } from '@/auth/supabase'
import type { BusinessPartner } from '@/local-db/models'
import type {
  PartnerAccountStatementCurrencyLedger,
  PartnerAccountStatementData,
  PartnerAccountStatementPeriod
} from '@/lib/partnerAccountStatement'

type PeriodStatementResponse = {
  partner: Pick<BusinessPartner, 'id' | 'workspaceId' | 'partnerName' | 'phone' | 'address' | 'city' | 'role' | 'netExposure' | 'defaultCurrency'>
  ledgers: PartnerAccountStatementCurrencyLedger[]
  isAgentCommissionStatement: boolean
}

type LoadState = {
  key: string | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: Error | null
  response: PeriodStatementResponse | null
  fallbackRequired: boolean
}

type PendingStatementRequest = {
  key: string
  controller: AbortController
  promise: Promise<PeriodStatementResponse>
}

const STATEMENT_REQUEST_TIMEOUT_MS = 30_000

function normalizeError(error: unknown) {
  if (isRequestTimeout(error)) {
    return new Error('Partner account statement request timed out')
  }
  return error instanceof Error ? error : new Error('Partner account statement could not be loaded')
}

function isRequestTimeout(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const context = (error as { context?: unknown }).context
  return Boolean(
    context
    && typeof context === 'object'
    && (context as { name?: unknown }).name === 'AbortError'
  )
}

/**
 * Loads a remote statement through a partner-scoped server read. The server
 * computes the opening balance from prior activity and returns only the
 * selected period's rows to the browser.
 */
export function usePartnerAccountStatementPeriod(
  workspaceId: string | undefined,
  partnerId: string | null | undefined,
  period: PartnerAccountStatementPeriod,
  options: {
    enabled: boolean
    itemizeSalesOrders: boolean
    itemizePosSaleLoans: boolean
  }
) {
  const [retryGeneration, setRetryGeneration] = useState(0)
  const [state, setState] = useState<LoadState>({
    key: null,
    status: 'idle',
    error: null,
    response: null,
    fallbackRequired: false
  })
  const pendingRequestRef = useRef<PendingStatementRequest | null>(null)
  const periodKey = useMemo(() => JSON.stringify({
    workspaceId,
    partnerId,
    period,
    itemizeSalesOrders: options.itemizeSalesOrders,
    itemizePosSaleLoans: options.itemizePosSaleLoans
  }), [
    options.itemizePosSaleLoans,
    options.itemizeSalesOrders,
    partnerId,
    period,
    workspaceId
  ])
  const requestKey = options.enabled && workspaceId && partnerId
    ? `${periodKey}:${retryGeneration}`
    : null

  useEffect(() => {
    if (!requestKey || !workspaceId || !partnerId) return

    let cancelled = false
    setState({ key: requestKey, status: 'loading', error: null, response: null, fallbackRequired: false })

    let pendingRequest = pendingRequestRef.current
    if (pendingRequest?.key !== requestKey || pendingRequest.controller.signal.aborted) {
      pendingRequest?.controller.abort()
      const controller = new AbortController()
      const promise = supabase.functions.invoke<PeriodStatementResponse>('partner-account-statement-period', {
        body: {
          workspaceId,
          partnerId,
          period,
          itemizeSalesOrders: options.itemizeSalesOrders,
          itemizePosSaleLoans: options.itemizePosSaleLoans
        },
        signal: controller.signal,
        timeout: STATEMENT_REQUEST_TIMEOUT_MS
      }).then(({ data, error }) => {
        if (error) throw error
        if (!data || data.partner?.id !== partnerId || !Array.isArray(data.ledgers)) {
          throw new Error('Partner account statement response was incomplete')
        }
        return data
      })
      pendingRequest = { key: requestKey, controller, promise }
      pendingRequestRef.current = pendingRequest
    }

    const request = pendingRequest
    void request.promise.then((response) => {
      if (cancelled) return
      setState({ key: requestKey, status: 'ready', error: null, response, fallbackRequired: false })
    }).catch((error: unknown) => {
      if (cancelled) return
      setState({
        key: requestKey,
        status: 'error',
        error: normalizeError(error),
        response: null,
        // A timeout means the server path is stalled; falling back would start
        // the much broader legacy load and keep the user waiting even longer.
        fallbackRequired: !isRequestTimeout(error)
      })
    }).finally(() => {
      if (pendingRequestRef.current === request) pendingRequestRef.current = null
    })

    return () => { cancelled = true }
  }, [
    options.itemizePosSaleLoans,
    options.itemizeSalesOrders,
    partnerId,
    period,
    requestKey,
    workspaceId
  ])

  const response = state.key === requestKey && state.status === 'ready' ? state.response : null
  const statementData = useMemo<PartnerAccountStatementData | null>(() => {
    if (!response || !period) return null
    return {
      partnerId: response.partner.id,
      period,
      itemizeSalesOrders: options.itemizeSalesOrders,
      itemizePosSaleLoans: options.itemizePosSaleLoans,
      isAgentCommissionStatement: response.isAgentCommissionStatement,
      salesOrders: [],
      purchaseOrders: [],
      precomputedLedgers: response.ledgers
    }
  }, [options.itemizePosSaleLoans, options.itemizeSalesOrders, period, response])

  const isLoading = Boolean(requestKey && (
    state.key !== requestKey || state.status === 'loading'
  ))
  const fallbackRequired = Boolean(requestKey && state.key === requestKey && state.status === 'error')

  return {
    partner: response?.partner,
    statementData,
    isLoading,
    error: state.key === requestKey && state.status === 'error' ? state.error : null,
    fallbackRequired: fallbackRequired && state.fallbackRequired,
    retry: () => setRetryGeneration((generation) => generation + 1)
  }
}
