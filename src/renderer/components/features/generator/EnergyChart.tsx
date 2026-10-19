import * as React from 'react'
import { formatDecimal } from '@/lib/format'
import { CHART_HEIGHT, CHART_WIDTH, xOf, yOf } from './chart-geometry'
import { EnergyGrid } from './EnergyCurveEditor'
import { energyAt, type CurvePoint, type EnergyProfile } from '@shared/energy-curves'
import type { GeneratedEntry } from '@shared/generator'

const SAMPLES = 60

/**
 * The curve the set should follow, and the energy of each track of the list as a dot
 * on it; a gap is a hollow square at the energy it should have had.
 */
export function EnergyChart({
  profile,
  curve,
  entries
}: {
  profile: EnergyProfile
  curve: readonly CurvePoint[] | null
  entries: readonly GeneratedEntry[]
}): React.JSX.Element {
  const line = Array.from({ length: SAMPLES + 1 }, (_, index) => {
    const t = index / SAMPLES
    return `${xOf(t)},${yOf(energyAt(profile, t, curve))}`
  }).join(' ')
  const tracks = entries.filter((entry) => entry.kind === 'track')
  const mean =
    tracks.length === 0
      ? null
      : tracks.reduce(
          (sum, entry) =>
            sum +
            (entry.kind === 'track' ? Math.abs((entry.item.energy ?? 0) - entry.targetEnergy) : 0),
          0
        ) / tracks.length

  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="w-full rounded-sm border border-border bg-surface"
        role="img"
        aria-label={`A set energyje: a görbe és a trackek${mean === null ? '' : `, átlagos eltérés ${formatDecimal(mean)}`}`}
      >
        <EnergyGrid />
        <polyline points={line} fill="none" stroke="var(--color-primary)" strokeWidth={2} />
        {entries.map((entry, index) => {
          const x = xOf((index + 0.5) / entries.length)
          if (entry.kind === 'gap') {
            const y = yOf(entry.target.energy)
            return (
              <rect
                key={index}
                x={x - 3}
                y={y - 3}
                width={6}
                height={6}
                fill="none"
                stroke="var(--color-warning)"
                strokeWidth={1.5}
              />
            )
          }
          return entry.item.energy === null ? null : (
            <circle key={index} cx={x} cy={yOf(entry.item.energy)} r={3} fill="var(--color-text)" />
          )
        })}
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-small text-text-muted">
        <span>Vonal: a görbe</span>
        <span>Pont: a track energyje</span>
        <span>Üres négyzet: hiány</span>
        {mean !== null && (
          <span>
            Átlagos eltérés:{' '}
            <span className="font-mono text-data tabular-nums">{formatDecimal(mean)}</span>
          </span>
        )}
      </figcaption>
    </figure>
  )
}
