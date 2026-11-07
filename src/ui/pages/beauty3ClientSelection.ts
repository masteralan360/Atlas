import type { Beauty3Client } from '@/local-db/models'

export type Beauty3ClientOptionsStatus = 'loading' | 'ready' | 'error'

export interface Beauty3ClientSelectionState {
  search: string
  selectedClient: Beauty3Client | null
  optionsStatus: Beauty3ClientOptionsStatus
  selectedUnavailable: boolean
}

export type Beauty3ClientSelectionAction =
  | { type: 'options-loading' }
  | { type: 'options-error' }
  | { type: 'options-loaded'; clients: readonly Beauty3Client[] }
  | { type: 'select'; client: Beauty3Client }
  | { type: 'input'; value: string }
  | { type: 'clear' }
  | { type: 'create-new'; search: string }

export const initialBeauty3ClientSelectionState: Beauty3ClientSelectionState = {
  search: '',
  selectedClient: null,
  optionsStatus: 'loading',
  selectedUnavailable: false,
}

function clientsMatch(left: Beauty3Client, right: Beauty3Client) {
  return left.id === right.id
    && left.updatedAt === right.updatedAt
    && left.name === right.name
    && left.age === right.age
    && left.maritalStatus === right.maritalStatus
    && left.address === right.address
    && left.phoneNumber === right.phoneNumber
}

export function beauty3ClientSelectionReducer(
  state: Beauty3ClientSelectionState,
  action: Beauty3ClientSelectionAction,
): Beauty3ClientSelectionState {
  switch (action.type) {
    case 'options-loading':
      return state.optionsStatus === 'loading'
        ? state
        : { ...state, optionsStatus: 'loading' }
    case 'options-error':
      return state.optionsStatus === 'error'
        ? state
        : { ...state, optionsStatus: 'error' }
    case 'options-loaded': {
      const refreshedClient = state.selectedClient
        ? action.clients.find((client) => client.id === state.selectedClient?.id) ?? null
        : null
      const selectedUnavailable = Boolean(state.selectedClient && !refreshedClient)
      const selectedClient = refreshedClient ?? state.selectedClient
      if (
        state.optionsStatus === 'ready'
        && state.selectedUnavailable === selectedUnavailable
        && ((!selectedClient && !state.selectedClient)
          || (selectedClient && state.selectedClient && clientsMatch(selectedClient, state.selectedClient)))
      ) return state
      return {
        ...state,
        selectedClient,
        optionsStatus: 'ready',
        selectedUnavailable,
      }
    }
    case 'select':
      return {
        search: action.client.name,
        selectedClient: action.client,
        optionsStatus: 'ready',
        selectedUnavailable: false,
      }
    case 'input':
      if (state.search === action.value && !state.selectedClient) return state
      return {
        search: action.value,
        selectedClient: null,
        optionsStatus: 'loading',
        selectedUnavailable: false,
      }
    case 'clear':
      if (!state.search && !state.selectedClient && !state.selectedUnavailable) return state
      return {
        search: '',
        selectedClient: null,
        optionsStatus: 'loading',
        selectedUnavailable: false,
      }
    case 'create-new':
      if (!state.selectedClient && state.search === action.search && !state.selectedUnavailable) return state
      return {
        search: action.search,
        selectedClient: null,
        optionsStatus: 'ready',
        selectedUnavailable: false,
      }
  }
}
