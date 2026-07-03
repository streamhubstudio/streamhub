import { forwardRef, useEffect, useState } from 'react'
import type { Ref, JSX } from 'react'
import classNames from 'classnames'
import ReactSelect from 'react-select'
import CreatableSelect from 'react-select/creatable'
import AsyncSelect from 'react-select/async'
import isEmpty from 'lodash/isEmpty'
import get from 'lodash/get'
import { useConfig } from '../ConfigProvider'
import { useForm } from '../Form/context'
import { useInputGroup } from '../InputGroup/context'
import { HiCheck, HiChevronDown, HiX } from 'react-icons/hi'
import Spinner from '../Spinner/Spinner'
import { CONTROL_SIZES } from '../utils/constants'
import type { CommonProps, TypeAttributes } from '../@types/common'
import type {
    ControlProps,
    Props as ReactSelectProps,
    GroupBase,
} from 'react-select'
import type { AsyncProps } from 'react-select/async'
import type { CreatableProps } from 'react-select/creatable'
import type { ForwardedRef } from 'react'

interface DefaultOptionProps {
    innerProps: JSX.IntrinsicElements['div']
    label: string
    selectProps: { themeColor?: string }
    isSelected: boolean
    isDisabled: boolean
    isFocused: boolean
}

const DefaultOption = ({
    innerProps,
    label,
    selectProps,
    isSelected,
    isDisabled,
    isFocused,
}: DefaultOptionProps) => {
    const { themeColor } = selectProps
    return (
        <div
            className={classNames(
                'select-option',
                isSelected && 'selected',
                isDisabled && 'disabled',
                isFocused && 'focused',
            )}
            {...innerProps}
        >
            <span className="ml-2">{label}</span>
            {isSelected && (
                <HiCheck
                    className={`text-${themeColor} dark:text-white text-xl`}
                />
            )}
        </div>
    )
}

const DefaultDropdownIndicator = () => {
    return (
        <div className="select-dropdown-indicator">
            <HiChevronDown />
        </div>
    )
}

interface DefaultClearIndicatorProps {
    innerProps: JSX.IntrinsicElements['div']
    ref: Ref<HTMLElement>
}

const DefaultClearIndicator = ({
    innerProps: { ref, ...restInnerProps },
}: DefaultClearIndicatorProps) => {
    return (
        <div {...restInnerProps} ref={ref}>
            <div className="select-clear-indicator">
                <HiX />
            </div>
        </div>
    )
}

interface DefaultLoadingIndicatorProps {
    selectProps: { themeColor?: string }
}

const DefaultLoadingIndicator = ({
    selectProps,
}: DefaultLoadingIndicatorProps) => {
    const { themeColor } = selectProps
    return (
        <Spinner className={`select-loading-indicatior text-${themeColor}`} />
    )
}

export interface SelectProps<
    Option,
    IsMulti extends boolean = false,
    Group extends GroupBase<Option> = GroupBase<Option>,
> extends CommonProps,
        ReactSelectProps<Option, IsMulti, Group>,
        AsyncProps<Option, IsMulti, Group>,
        CreatableProps<Option, IsMulti, Group> {
    size?: TypeAttributes.ControlSize
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    field?: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    form?: any
    componentAs?: ReactSelect | CreatableSelect | AsyncSelect
}

function SelectImpl<
    Option,
    IsMulti extends boolean = false,
    Group extends GroupBase<Option> = GroupBase<Option>,
>(
    props: SelectProps<Option, IsMulti, Group>,
    ref: ForwardedRef<ReactSelect | CreatableSelect | AsyncSelect>,
) {
    const {
        size,
        style,
        className,
        form,
        field,
        components,
        componentAs: Component = ReactSelect,
        ...rest
    } = props

    const { themeColor, controlSize, primaryColorLevel, mode } = useConfig()
    const formControlSize = useForm()?.size
    const inputGroupSize = useInputGroup()?.size

    const selectSize = size || inputGroupSize || formControlSize || controlSize

    let isInvalid = false
    
    const [tw, setTw] = useState({
        primary: '',
        primary50: '',
        primary100: '',
        red: '',
        gray50: '',
        gray300: '',
        gray400: '',
        gray600: '',
        gray700: '',
        gray800: '',
        white: '',
        radiusMd: '',
    });

  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    const primary = styles.getPropertyValue(`--color-${themeColor}-${primaryColorLevel}`).trim();
    const primary50 = styles.getPropertyValue(`--color-${themeColor}-50`).trim();
    const primary100 = styles.getPropertyValue(`--color-${themeColor}-100`).trim();
    const red = styles.getPropertyValue('--color-red-500').trim();
    const gray50 = styles.getPropertyValue('--color-gray-50').trim();
    const gray300 = styles.getPropertyValue('--color-gray-300').trim();
    const gray400 = styles.getPropertyValue('--color-gray-400').trim();
    const gray600 = styles.getPropertyValue('--color-gray-600').trim();
    const gray700 = styles.getPropertyValue('--color-gray-700').trim();
    const gray800 = styles.getPropertyValue('--color-gray-800').trim();
    const white = styles.getPropertyValue('--color-white').trim();
    const radiusMd = styles.getPropertyValue('--radius-md').trim();

    setTw({
        primary,
        primary50,
        primary100,
        red,
        gray50,
        gray300,
        gray400,
        gray600,
        gray700,
        gray800,
        white,
        radiusMd
    });
  }, [primaryColorLevel, themeColor]);

    if (!isEmpty(form)) {
        const { touched, errors } = form

        const touchedField = get(touched, field.name)
        const errorField = get(errors, field.name)

        isInvalid = touchedField && errorField
    }

    const getBoxShadow = (state: ControlProps<Option, IsMulti, Group>) => {
        const shadowBase = '0 0 0 1px '

        if (isInvalid) {
            return shadowBase + tw.red
        }

        if (state.isFocused) {
            return shadowBase + tw.primary
        }

        return 'none'
    }

    const selectClass = classNames('select', `select-${selectSize}`, className)

    return (
        <Component<Option, IsMulti, Group>
            ref={ref}
            className={selectClass}
            classNamePrefix={'select'}
            classNames={{
                control: () =>
                    `h-${CONTROL_SIZES[selectSize]} min-h-${CONTROL_SIZES[selectSize]}`,
            }}
            styles={{
                control: (provided, state) => {
                    return {
                        ...provided,
                        '&:hover': {
                            boxShadow: getBoxShadow(state),
                            cursor: 'pointer',
                        },
                        boxShadow: getBoxShadow(state),
                        borderRadius: tw.radiusMd,
                        ...(isInvalid
                            ? { borderColor: tw.red }
                            : {}),
                    }
                },
                input: (css) => {
                    return {
                        ...css,
                        input: {
                            outline: 'none',
                            outlineOffset: 0,
                            boxShadow: 'none !important',
                        },
                    }
                },
                menu: (provided) => ({ ...provided, zIndex: 50 }),
                ...style,
            }}
            theme={(theme) => ({
                ...theme,
                colors: {
                    ...theme.colors,
                    neutral0:
                        mode === 'dark' ? tw.gray800 : tw.white,
                    neutral20:
                        mode === 'dark'
                            ? tw.gray600
                            : tw.gray300,
                    neutral30:
                        mode === 'dark'
                            ? tw.gray600
                            : tw.gray300,
                    neutral80: mode === 'dark' ? tw.gray400 : tw.gray700,
                    neutral10:
                        mode === 'dark'
                            ? tw.gray600
                            : tw.gray300,
                    primary25: tw.primary50,
                    primary50: tw.primary100,
                    primary: tw.primary,
                },
            })}
            themeColor={`${themeColor}-${primaryColorLevel}`}
            components={{
                IndicatorSeparator: () => null,
                Option: DefaultOption,
                LoadingIndicator: DefaultLoadingIndicator,
                DropdownIndicator: DefaultDropdownIndicator,
                ClearIndicator: DefaultClearIndicator,
                ...components,
            }}
            {...field}
            {...rest}
        />
    )
}

const Select = forwardRef(SelectImpl) as <
    Option,
    IsMulti extends boolean = false,
    Group extends GroupBase<Option> = GroupBase<Option>,
>(
    props: SelectProps<Option, IsMulti, Group> & {
        ref?: ForwardedRef<ReactSelect | CreatableSelect | AsyncSelect>
    },
) => ReturnType<typeof SelectImpl>

export default Select
