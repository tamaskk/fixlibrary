import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { cn } from './cn'

const globalsCss = readFileSync(join(import.meta.dirname, '../styles/globals.css'), 'utf8')
// `--text-small: 13px;` defines a size; `--text-small--line-height` belongs to one.
const themeFontSizes = [...globalsCss.matchAll(/^\s*--text-([a-z0-9]+):/gm)].map(
  (match) => match[1] as string
)

describe('cn', () => {
  it('finds the font sizes of the theme', () => {
    // Assert
    expect(themeFontSizes).toEqual(['h1', 'h2', 'h3', 'body', 'small', 'label', 'data'])
  })

  it.each(themeFontSizes)('keeps the font size text-%s next to a text color', (size) => {
    // Act
    const sizeFirst = cn(`text-${size} text-text-muted uppercase`)
    const colorFirst = cn('text-danger-text', `text-${size}`)

    // Assert
    expect(sizeFirst).toBe(`text-${size} text-text-muted uppercase`)
    expect(colorFirst).toBe(`text-danger-text text-${size}`)
  })

  it('lets a later font size replace an earlier one', () => {
    // Act
    const merged = cn('text-body text-text', 'text-small')

    // Assert
    expect(merged).toBe('text-text text-small')
  })

  it('lets a later text color replace an earlier one', () => {
    // Act
    const merged = cn('text-small text-text-muted', 'text-success')

    // Assert
    expect(merged).toBe('text-small text-success')
  })

  it('leaves out what is false, and still resolves the other conflicts', () => {
    // Act
    const merged = cn('px-3 text-label', false, undefined, 'px-0')

    // Assert
    expect(merged).toBe('text-label px-0')
  })
})
