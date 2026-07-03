/**
 * StreamHub design system — ported & re-skinned from the Elstar React/Tailwind
 * template. Components keep Elstar's structure/behaviour but resolve their
 * accent through the StreamHub brand token (`themeColor: 'primary'` →
 * `primary-*` scale in src/index.css). See MIGRATION.md.
 *
 * Only the curated set used by StreamHub is re-exported here. Styling lives in
 * src/ui/ui.css (imported from src/index.css).
 */
export { default as Alert } from './Alert'
export { default as Avatar } from './Avatar'
export { default as Badge } from './Badge'
export { default as Button } from './Button'
export { default as Card } from './Card'
export { ConfigProvider, useConfig, defaultConfig } from './ConfigProvider'
export { default as Dialog } from './Dialog'
export { default as Drawer } from './Drawer'
export { default as Dropdown } from './Dropdown'
export { default as FormItem } from './Form/FormItem'
export { default as FormContainer } from './Form/FormContainer'
export { default as Input } from './Input'
export { default as InputGroup } from './InputGroup'
export { default as Menu } from './Menu'
export { default as MenuItem } from './MenuItem'
export { default as Notification } from './Notification'
export { default as Pagination } from './Pagination'
export { default as ScrollBar } from './ScrollBar'
export { default as Segment } from './Segment'
export { default as Select } from './Select'
export { default as Skeleton } from './Skeleton'
export { default as Spinner } from './Spinner'
export { default as Steps } from './Steps'
export { default as Switcher } from './Switcher'
export { default as Table } from './Table'
export { default as Tabs } from './Tabs'
export { default as Tag } from './Tag'
export { default as toast } from './toast'
export { default as Tooltip } from './Tooltip'

export type { AlertProps } from './Alert'
export type { AvatarProps, AvatarGroupProps } from './Avatar'
export type { BadgeProps } from './Badge'
export type { ButtonProps } from './Button'
export type { CardProps } from './Card'
export type { Config } from './ConfigProvider'
export type { DialogProps } from './Dialog'
export type { DrawerProps } from './Drawer'
export type {
    DropdownProps,
    DropdownItemProps,
    DropdownMenuProps,
} from './Dropdown'
export type { FormContainerProps, FormItemProps } from './Form'
export type { InputProps } from './Input'
export type { InputGroupProps, AddonProps } from './InputGroup'
export type {
    MenuProps,
    MenuCollapseProps,
    MenuGroupProps,
    MenuItemProps,
} from './Menu'
export type { MenuItemProps as BaseMenuItemProps } from './MenuItem'
export type { NotificationProps } from './Notification'
export type { PaginationProps } from './Pagination'
export type { ScrollbarProps, ScrollbarRef } from './ScrollBar'
export type { SegmentProps, SegmentItemProps } from './Segment'
export type { SelectProps } from './Select'
export type { SkeletonProps } from './Skeleton'
export type { SpinnerProps } from './Spinner'
export type { StepsProps, StepItemProps } from './Steps'
export type { SwitcherProps } from './Switcher'
export type {
    TableProps,
    TBodyProps,
    TFootProps,
    THeadProps,
    TdProps,
    ThProps,
    TrProps,
    SorterProps,
} from './Table'
export type {
    TabsProps,
    TabContentProps,
    TabListProps,
    TabNavProps,
} from './Tabs'
export type { TagProps } from './Tag'
export type { ToastProps } from './toast'
export type { TooltipProps } from './Tooltip'
