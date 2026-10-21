export interface PartnerAutocompleteAddPartnerConfig {
    /** Called with the current input value; callers own the inline form state. */
    onActivate: (partnerName: string) => void
    /** Highlights the input while the caller is collecting a new partner. */
    active?: boolean
    /** Hide creation actions when a partner is already selected. */
    canCreate?: boolean
}

export function canDisplayPartnerAutocompleteResults(
    isFocused: boolean,
    justSelected: boolean,
    isCreatingPartner: boolean,
) {
    return isFocused && !justSelected && !isCreatingPartner
}

export function activatePartnerCreation(
    config: PartnerAutocompleteAddPartnerConfig | undefined,
    partnerName: string,
    disabled: boolean,
) {
    if (!config || config.canCreate === false || disabled) return false
    config.onActivate(partnerName)
    return true
}
