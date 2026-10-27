export const JUMLA_KHALEEJ_REWARD_NODE_TYPES = ['FreeDelivery', 'ProgressNode', 'Gift'] as const

export type JumlaKhaleejRewardNodeType = typeof JUMLA_KHALEEJ_REWARD_NODE_TYPES[number]

export type JumlaKhaleejRewardMilestone = {
    id?: string
    threshold: string
    node_types?: JumlaKhaleejRewardNodeType[]
    /** Compatibility with milestones stored by older storefront clients. */
    node_type?: JumlaKhaleejRewardNodeType
}

export type EvaluatedJumlaKhaleejRewardMilestone = JumlaKhaleejRewardMilestone & {
    node_types: JumlaKhaleejRewardNodeType[]
    reached: boolean
}

function decimalToThousandths(value: unknown): bigint | null {
    const normalized = typeof value === 'number'
        ? Number.isFinite(value) ? String(value) : ''
        : typeof value === 'string' ? value.trim() : ''
    const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(normalized)
    if (!match) return null

    const whole = BigInt(match[1])
    const fraction = BigInt((match[2] ?? '').padEnd(3, '0') || '0')
    return whole * 1_000n + fraction
}

function normalizeThreshold(value: unknown): { threshold: string; thousandths: bigint } | null {
    const thousandths = decimalToThousandths(value)
    if (thousandths === null || thousandths <= 0n || thousandths > 999_999_999_999n) return null

    const whole = thousandths / 1_000n
    const fraction = String(thousandths % 1_000n).padStart(3, '0').replace(/0+$/, '')
    return {
        threshold: fraction ? `${whole}.${fraction}` : String(whole),
        thousandths
    }
}

function normalizeNodeTypes(value: unknown, legacyValue: unknown): JumlaKhaleejRewardNodeType[] | null {
    const nodes = Array.isArray(value) ? value : value === undefined ? [legacyValue] : null
    if (!nodes || nodes.length === 0) return null

    const normalized: JumlaKhaleejRewardNodeType[] = []
    for (const node of nodes) {
        if (!JUMLA_KHALEEJ_REWARD_NODE_TYPES.some((allowed) => allowed === node)) return null
        if (normalized.includes(node as JumlaKhaleejRewardNodeType)) return null
        normalized.push(node as JumlaKhaleejRewardNodeType)
    }
    return normalized
}

export function validateJumlaKhaleejRewardMilestones(value: unknown): {
    milestones: JumlaKhaleejRewardMilestone[]
    error: string | null
} {
    if (!Array.isArray(value) || value.length === 0) {
        return { milestones: [], error: 'Add at least one milestone before saving.' }
    }

    const milestones: JumlaKhaleejRewardMilestone[] = []
    const thresholds = new Set<string>()
    let freeDeliveryCount = 0

    for (const row of value) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            return { milestones: [], error: 'Each milestone needs a valid threshold and at least one node type.' }
        }

        const candidate = row as {
            threshold?: unknown
            node_types?: unknown
            nodeTypes?: unknown
            node_type?: unknown
            nodeType?: unknown
        }
        const normalized = normalizeThreshold(candidate.threshold)
        if (!normalized) {
            return { milestones: [], error: 'Enter a positive order-total threshold with up to three decimal places.' }
        }

        const nodesValue = candidate.node_types ?? candidate.nodeTypes
        const nodeTypes = normalizeNodeTypes(
            nodesValue,
            candidate.node_type ?? candidate.nodeType
        )
        if (!nodeTypes) {
            return { milestones: [], error: 'Choose at least one valid milestone type.' }
        }
        if (thresholds.has(String(normalized.thousandths))) {
            return { milestones: [], error: 'Milestone thresholds must be unique within a shopping mode.' }
        }
        thresholds.add(String(normalized.thousandths))

        if (nodeTypes.includes('FreeDelivery')) {
            freeDeliveryCount += 1
            if (freeDeliveryCount > 1) {
                return { milestones: [], error: 'Free delivery can appear only once in a shopping mode.' }
            }
        }

        milestones.push({
            threshold: normalized.threshold,
            node_types: nodeTypes,
            node_type: nodeTypes.includes('FreeDelivery') ? 'FreeDelivery' : 'ProgressNode'
        })
    }

    milestones.sort((left, right) => {
        const leftValue = decimalToThousandths(left.threshold) ?? 0n
        const rightValue = decimalToThousandths(right.threshold) ?? 0n
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
    })

    return { milestones, error: null }
}

function amountToThousandths(value: number): bigint | null {
    if (!Number.isFinite(value) || value < 0) return null
    const rounded = Math.round((value + Number.EPSILON) * 1_000)
    if (!Number.isSafeInteger(rounded)) return null
    return BigInt(rounded)
}

type RewardNodeHandler = {
    apply: (effects: { deliveryFeeWaived: boolean }) => void
}

const rewardNodeHandlers: Record<JumlaKhaleejRewardNodeType, RewardNodeHandler> = {
    FreeDelivery: {
        apply(effects) {
            effects.deliveryFeeWaived = true
        }
    },
    ProgressNode: {
        apply() {
            // Progress nodes are status-only markers with no pricing effect.
        }
    },
    Gift: {
        apply() {
            // Gift nodes are status-only markers; gift fulfillment is not configured yet.
        }
    }
}

export function evaluateJumlaKhaleejOrderRewards(
    milestones: JumlaKhaleejRewardMilestone[],
    qualifyingSubtotal: number
) {
    const subtotal = amountToThousandths(qualifyingSubtotal)
    const effects = { deliveryFeeWaived: false }
    const evaluatedMilestones: EvaluatedJumlaKhaleejRewardMilestone[] = milestones
        .map((milestone) => {
            const threshold = decimalToThousandths(milestone.threshold)
            const reached = subtotal !== null && threshold !== null && subtotal >= threshold
            const nodeTypes = normalizeNodeTypes(milestone.node_types, milestone.node_type) ?? []
            if (reached) {
                for (const nodeType of nodeTypes) rewardNodeHandlers[nodeType].apply(effects)
            }
            return { ...milestone, node_types: nodeTypes, reached }
        })
        .sort((left, right) => {
            const leftValue = decimalToThousandths(left.threshold) ?? 0n
            const rightValue = decimalToThousandths(right.threshold) ?? 0n
            return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
        })

    return { milestones: evaluatedMilestones, deliveryFeeWaived: effects.deliveryFeeWaived }
}
