import { afterEach, describe, expect, it, vi } from 'vitest'
import { preparePdfPageCapture } from './pdfPageCapture'

function chunk(top: number, bottom: number, options: {
    style?: string | null, overflow?: [number, number], definitions?: boolean, nested?: boolean
} = {}) {
    const children = [{ text: 'row 1' }, { text: 'row 2' }]
    let style = options.style ?? null
    const element = {
        children: [...children],
        parentElement: { closest: () => options.nested ? {} : null },
        style: { setProperty: vi.fn() },
        getBoundingClientRect: () => ({ top, bottom, width: 720, height: bottom - top }),
        querySelector: () => options.definitions ? {} : null,
        querySelectorAll: () => options.overflow ? [{
            getBoundingClientRect: () => ({ top: options.overflow![0], bottom: options.overflow![1], width: 20, height: 20 })
        }] : [],
        getAttribute: () => style,
        setAttribute: (_key: string, value: string) => { style = value },
        removeAttribute: () => { style = null },
        get firstChild() { return this.children[0] },
        appendChild(fragment: { nodes: typeof children }) { this.children.push(...fragment.nodes) },
    }
    return { element, children }
}

function container(chunks: ReturnType<typeof chunk>[], origin = 0) {
    return {
        getBoundingClientRect: () => ({ top: origin }),
        querySelectorAll: () => chunks.map((entry) => entry.element),
        ownerDocument: { createDocumentFragment: () => ({ nodes: [] as unknown[], appendChild(node: unknown) {
            const owner = chunks.find((entry) => entry.element.children.includes(node as { text: string }))!
            owner.element.children.splice(owner.element.children.indexOf(node as { text: string }), 1)
            this.nodes.push(node)
        } }) },
    } as unknown as HTMLElement
}

afterEach(() => vi.unstubAllGlobals())

describe('PDF page capture pruning', () => {
    function setup(chunks: ReturnType<typeof chunk>[], origin = 0) {
        vi.stubGlobal('getComputedStyle', vi.fn(() => ({ width: '720.375px', height: '800.125px' })))
        return preparePdfPageCapture(container(chunks, origin))
    }

    it('removes only off-page content, preserves exact fractional boxes, and restores original nodes/styles', () => {
        const first = chunk(0, 800, { style: 'border: 1px solid black' }), second = chunk(1150, 1950)
        const prepare = setup([first, second])
        const restore = prepare(1122, 1124)
        expect(first.element.children).toEqual([])
        expect(second.element.children).toEqual(second.children)
        expect(first.element.style.setProperty.mock.calls).toEqual([
            ['width', '720.375px', 'important'], ['height', '800.125px', 'important'],
        ])
        restore()
        expect(first.element.children[0]).toBe(first.children[0])
        expect(first.element.getAttribute()).toBe('border: 1px solid black')
        const restoreNext = prepare(0, 1123)
        expect(second.element.children).toEqual([])
        restoreNext()
        expect(second.element.getAttribute()).toBeNull()
        expect(second.element.children).toEqual(second.children)
    })

    it('keeps crossing chunks and boundary-adjacent borders without rounding away a pixel', () => {
        const boundary = chunk(10, 1106), crossing = chunk(1100, 1190), beyond = chunk(10, 1105.99)
        const restore = setup([boundary, crossing, beyond])(1122, 1124)
        expect(boundary.element.children).toEqual(boundary.children)
        expect(crossing.element.children).toEqual(crossing.children)
        expect(beyond.element.children).toEqual([])
        restore()
    })

    it('accounts for the render origin and positioned descendants overflowing their table', () => {
        const overflow = chunk(100, 800, { overflow: [1200, 1250] })
        const normal = chunk(100, 800)
        const restore = setup([overflow, normal], 100)(1122, 1124)
        expect(overflow.element.children).toEqual(overflow.children)
        expect(normal.element.children).toEqual([])
        restore()
    })

    it('keeps shared CSS/SVG definitions and avoids pruning nested chunks twice', () => {
        const definitions = chunk(0, 800, { definitions: true }), nested = chunk(0, 800, { nested: true })
        setup([definitions, nested])(1122, 1124)()
        expect(definitions.element.children).toEqual(definitions.children)
        expect(nested.element.children).toEqual(nested.children)
        expect(getComputedStyle).not.toHaveBeenCalled()
    })

    it('restores detached rows even when capture throws', () => {
        const first = chunk(0, 800), prepare = setup([first])
        expect(() => {
            const restore = prepare(1122, 1124)
            try { throw new Error('image capture failed') } finally { restore() }
        }).toThrow('image capture failed')
        expect(first.element.children).toEqual(first.children)
        expect(first.element.getAttribute()).toBeNull()
    })
})
