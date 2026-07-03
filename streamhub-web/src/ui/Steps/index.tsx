import type { ForwardRefExoticComponent, RefAttributes } from 'react'
import _Steps from './Steps'
import type { StepsProps } from './Steps'
import StepItem from './StepItem'

export type { StepsProps } from './Steps'
export type { StepItemProps } from './StepItem'

type CompoundedComponent = ForwardRefExoticComponent<
    StepsProps & RefAttributes<HTMLDivElement>
> & {
    Item: typeof StepItem
}

const Steps = _Steps as CompoundedComponent

Steps.Item = StepItem

export { Steps }

export default Steps
