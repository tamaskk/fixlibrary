import { createCn } from 'cn/config'

/**
 * The font sizes of docs/DESIGN_SYSTEM.md §03, as they are named in globals.css.
 * Add a size here when it is added there.
 */
const FONT_SIZES = ['h1', 'h2', 'h3', 'body', 'small', 'label', 'data'] as const

/**
 * Joins class names and lets a later class win over an earlier one it conflicts with.
 *
 * Told about the project's own font sizes: without that, `text-small` looks like a
 * text color to the merger, and it is dropped whenever a real color such as
 * `text-text-muted` follows it.
 */
export const cn = createCn({
  extend: { classGroups: { 'font-size': [{ text: [...FONT_SIZES] }] } }
})
