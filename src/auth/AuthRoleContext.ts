import { createContext, useContext } from 'react'

const AuthRoleContext = createContext<string | null>(null)

export function useAuthRole(): string | null {
  return useContext(AuthRoleContext)
}

export { AuthRoleContext }
