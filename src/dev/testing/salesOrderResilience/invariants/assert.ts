export class InvariantFailure extends Error {
    constructor(readonly invariant: string, readonly expected: unknown, readonly actual: unknown) {
        super(`${invariant}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`)
    }
}
export function equal(actual: unknown, expected: unknown, invariant: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new InvariantFailure(invariant, expected, actual)
}
export function near(actual: number | undefined, expected: number, invariant: string, tolerance = 0.00051) {
    if (!Number.isFinite(actual) || Math.abs(actual! - expected) > tolerance) throw new InvariantFailure(invariant, expected, actual)
}
export function ensure(condition: unknown, invariant: string, actual: unknown) {
    if (!condition) throw new InvariantFailure(invariant, true, actual)
}
