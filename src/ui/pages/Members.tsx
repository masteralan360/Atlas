import { useState, useEffect } from 'react'
import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    DialogDescription
} from '@/ui/components'
import { UsersRound, UserMinus, Loader2, Shield, Eye, Briefcase } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDate } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { getRetriableActionToast, isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'

interface Member {
    id: string
    name: string
    role: string
    profile_url?: string
    created_at: string
}

const roleIcons: Record<string, typeof Shield> = {
    admin: Shield,
    staff: Briefcase,
    viewer: Eye
}

const roleColors: Record<string, string> = {
    admin: 'bg-purple-500/10 text-purple-500',
    staff: 'bg-blue-500/10 text-blue-500',
    viewer: 'bg-slate-500/10 text-slate-500'
}

export function Members() {
    const { user } = useAuth()
    const { t } = useTranslation()
    const [members, setMembers] = useState<Member[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [kickingMemberId, setKickingMemberId] = useState<string | null>(null)
    const [memberToKick, setMemberToKick] = useState<Member | null>(null)
    const [error, setError] = useState<string | null>(null)

    const getErrorMessage = (err: unknown) => {
        const normalized = normalizeSupabaseActionError(err)
        if (isRetriableWebRequestError(normalized)) {
            return getRetriableActionToast(normalized).description
        }
        return normalized.message || t('common.error')
    }

    const fetchMembers = async () => {
        if (!user?.workspaceId) return

        setIsLoading(true)
        try {
            const { data, error } = await runSupabaseAction('members.fetch', () =>
                supabase
                    .from('profiles')
                    .select('id, name, role, created_at, profile_url')
                    .eq('workspace_id', user.workspaceId)
                    .order('created_at', { ascending: true })
            )

            if (error) throw normalizeSupabaseActionError(error)
            setMembers(data || [])
        } catch (err) {
            console.error('Error fetching members:', err)
            setError(getErrorMessage(err))
        } finally {
            setIsLoading(false)
        }
    }

    useEffect(() => {
        fetchMembers()
    }, [user?.workspaceId])

    const handleKick = async () => {
        if (!memberToKick) return

        setKickingMemberId(memberToKick.id)
        setError(null)

        try {
            const { error } = await runSupabaseAction('members.kick', () =>
                supabase.rpc('kick_member', {
                    target_user_id: memberToKick.id
                })
            )

            if (error) throw normalizeSupabaseActionError(error)

            // Remove member from local state
            setMembers(prev => prev.filter(m => m.id !== memberToKick.id))
            setMemberToKick(null)
        } catch (err: any) {
            console.error('Error kicking member:', err)
            setError(getErrorMessage(err))
        } finally {
            setKickingMemberId(null)
        }
    }

    const canKick = (member: Member) => {
        // Can't kick yourself
        if (member.id === user?.id) return false
        // Can't kick admins
        if (member.role === 'admin') return false
        // Only admins can kick
        return user?.role === 'admin'
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <UsersRound className="w-6 h-6 text-primary" />
                        {t('members.title')}
                    </h1>
                    <p className="text-muted-foreground">
                        {members.length} {t('members.subtitle')}
                    </p>
                </div>
            </div>

            {/* Error Alert */}
            {error && (
                <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive">
                    {error}
                </div>
            )}

            {/* Members Table */}
            <Card>
                <CardHeader>
                    <CardTitle>{t('members.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                    {isLoading ? (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                        </div>
                    ) : members.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                            {t('common.noData')}
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="text-start">{t('members.table.name')}</TableHead>
                                    <TableHead className="text-start">{t('members.table.role')}</TableHead>
                                    <TableHead className="text-start">{t('members.table.joinedAt')}</TableHead>
                                    {user?.role === 'admin' && (
                                        <TableHead className="text-end">{t('common.actions')}</TableHead>
                                    )}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {members.map((member) => {
                                    const RoleIcon = roleIcons[member.role] || Eye
                                    return (
                                        <TableRow key={member.id}>
                                            <TableCell>
                                                <div className="flex items-center gap-3">
                                                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary to-purple-600 flex items-center justify-center text-sm font-bold text-white overflow-hidden shadow-sm">
                                                        {member.profile_url ? (
                                                            <img
                                                                src={member.profile_url.startsWith('http') ? member.profile_url : platformService.convertFileSrc(member.profile_url)}
                                                                alt={member.name}
                                                                className="w-full h-full object-cover"
                                                            />
                                                        ) : (
                                                            member.name?.charAt(0).toUpperCase() || 'M'
                                                        )}
                                                    </div>
                                                    <div>
                                                        <p className="font-medium">
                                                            {member.name}
                                                            {member.id === user?.id && (
                                                                <span className="ms-2 text-xs text-muted-foreground">
                                                                    ({t('members.you')})
                                                                </span>
                                                            )}
                                                        </p>
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${roleColors[member.role]}`}>
                                                    <RoleIcon className="w-3 h-3" />
                                                    {t(`auth.roles.${member.role}`)}
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-muted-foreground text-start">
                                                {formatDate(member.created_at)}
                                            </TableCell>
                                            {user?.role === 'admin' && (
                                                <TableCell className="text-end">
                                                    {canKick(member) ? (
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() => setMemberToKick(member)}
                                                            disabled={kickingMemberId === member.id}
                                                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                                        >
                                                            {kickingMemberId === member.id ? (
                                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                            ) : (
                                                                <>
                                                                    <UserMinus className="w-4 h-4 mr-1" />
                                                                    {t('members.kick')}
                                                                </>
                                                            )}
                                                        </Button>
                                                    ) : member.role === 'admin' && member.id !== user?.id ? (
                                                        <span className="text-xs text-muted-foreground">
                                                            {t('members.cannotKickAdmin')}
                                                        </span>
                                                    ) : null}
                                                </TableCell>
                                            )}
                                        </TableRow>
                                    )
                                })}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card >

            {/* Kick Confirmation Dialog */}
            < Dialog open={!!memberToKick
            } onOpenChange={() => setMemberToKick(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('members.kickTitle')}</DialogTitle>
                        <DialogDescription>
                            {t('members.kickConfirm', { name: memberToKick?.name })}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="py-4">
                        <p className="text-sm text-muted-foreground">
                            {t('members.kickWarning')}
                        </p>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setMemberToKick(null)}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={handleKick}
                            disabled={!!kickingMemberId}
                        >
                            {kickingMemberId ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <>
                                    <UserMinus className="w-4 h-4 mr-1" />
                                    {t('members.kick')}
                                </>
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog >
        </div >
    )
}
