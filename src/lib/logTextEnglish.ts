import ar from '@/i18n/locales/ar.json'
import en from '@/i18n/locales/en.json'
import ku from '@/i18n/locales/ku.json'

const INTERPOLATION_TOKEN = /\{\{\s*-?([\w.]+)(?:\s*,[^}]*)?\s*\}\}/g

interface ParameterizedTranslation {
    expression: RegExp
    englishTemplate: string
    variableNames: string[]
}

function collectTranslationStrings(value: unknown, prefix = '', result = new Map<string, string>()) {
    if (typeof value === 'string') {
        result.set(prefix, value)
        return result
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) return result

    for (const [key, nestedValue] of Object.entries(value)) {
        collectTranslationStrings(nestedValue, prefix ? `${prefix}.${key}` : key, result)
    }

    return result
}

function escapeRegularExpression(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function createParameterizedTranslation(localizedTemplate: string, englishTemplate: string): ParameterizedTranslation | undefined {
    const matches = Array.from(localizedTemplate.matchAll(INTERPOLATION_TOKEN))
    if (matches.length === 0) return undefined

    const literalText = localizedTemplate.replace(INTERPOLATION_TOKEN, '').trim()
    if (!literalText) return undefined

    let position = 0
    let expression = '^'
    const variableNames: string[] = []

    for (const match of matches) {
        const matchPosition = match.index ?? 0
        expression += escapeRegularExpression(localizedTemplate.slice(position, matchPosition))
        expression += '([\\s\\S]*?)'
        variableNames.push(match[1])
        position = matchPosition + match[0].length
    }

    expression += `${escapeRegularExpression(localizedTemplate.slice(position))}$`

    return {
        expression: new RegExp(expression),
        englishTemplate,
        variableNames,
    }
}

let exactTranslations: Map<string, string> | undefined
let parameterizedTranslations: ParameterizedTranslation[] | undefined

function getTranslations() {
    if (exactTranslations && parameterizedTranslations) {
        return { exactTranslations, parameterizedTranslations }
    }

    const englishStrings = collectTranslationStrings(en)
    const localizedEnglishCandidates = new Map<string, Set<string>>()
    const nextParameterizedTranslations: ParameterizedTranslation[] = []

    for (const locale of [ar, ku]) {
        for (const [key, localizedText] of collectTranslationStrings(locale)) {
            const englishText = englishStrings.get(key)
            if (!englishText || localizedText === englishText) continue

            const parameterizedTranslation = createParameterizedTranslation(localizedText, englishText)
            if (parameterizedTranslation) {
                nextParameterizedTranslations.push(parameterizedTranslation)
                continue
            }

            const candidates = localizedEnglishCandidates.get(localizedText) ?? new Set<string>()
            candidates.add(englishText)
            localizedEnglishCandidates.set(localizedText, candidates)
        }
    }

    exactTranslations = new Map(
        Array.from(localizedEnglishCandidates)
            .filter(([, candidates]) => candidates.size === 1)
            .map(([localizedText, candidates]) => [localizedText, Array.from(candidates)[0] as string]),
    )
    parameterizedTranslations = nextParameterizedTranslations

    return { exactTranslations, parameterizedTranslations }
}

function renderEnglishTemplate(template: string, variableNames: string[], values: string[]) {
    const variables = new Map<string, string>()
    variableNames.forEach((name, index) => {
        if (!variables.has(name)) variables.set(name, values[index])
    })

    return template.replace(INTERPOLATION_TOKEN, (token, variableName: string) => variables.get(variableName) ?? token)
}

/**
 * Converts a rendered Atlas translation to the corresponding English text for
 * persistence only. Text that does not match a known Atlas translation is
 * external input and is deliberately returned unchanged.
 */
export function toEnglishLogText(text: string) {
    const translations = getTranslations()
    const exactTranslation = translations.exactTranslations.get(text)
    if (exactTranslation) return exactTranslation

    for (const translation of translations.parameterizedTranslations) {
        const match = translation.expression.exec(text)
        if (match) {
            return renderEnglishTemplate(translation.englishTemplate, translation.variableNames, match.slice(1))
        }
    }

    return text
}
