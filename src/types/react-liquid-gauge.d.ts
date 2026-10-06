declare module 'react-liquid-gauge' {
    import type { ComponentType, CSSProperties, ReactNode } from 'react'

    type LiquidGaugeProps = {
        id?: string
        style?: CSSProperties
        width?: number
        height?: number
        value?: number
        percent?: string | ReactNode
        textSize?: number
        textOffsetX?: number
        textOffsetY?: number
        textRenderer?: (props: {
            width: number
            height: number
            value: number
            percent: string | ReactNode
            textSize: number
        }) => ReactNode
        riseAnimation?: boolean
        riseAnimationTime?: number
        riseAnimationEasing?: string
        waveAnimation?: boolean
        waveAnimationTime?: number
        waveAnimationEasing?: string
        waveAmplitude?: number
        waveFrequency?: number
        gradient?: boolean
        gradientStops?: Array<{
            key?: string
            offset: string
            stopColor: string
            stopOpacity?: number
        }>
        innerRadius?: number
        outerRadius?: number
        margin?: number
        circleStyle?: CSSProperties
        waveStyle?: CSSProperties
        textStyle?: CSSProperties
        waveTextStyle?: CSSProperties
    }

    const LiquidFillGauge: ComponentType<LiquidGaugeProps>
    export default LiquidFillGauge
}
