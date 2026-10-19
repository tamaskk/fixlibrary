import * as React from 'react'
import { Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CHART_HEIGHT, CHART_WIDTH, PAD, xOf, yOf } from './chart-geometry'
import { MAX_CURVE_POINTS, MIN_CURVE_POINTS, type CurvePoint } from '@shared/energy-curves'

const ENERGY_STEP = 0.5
const TIME_STEP = 0.02

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/** The grid of the energy axis, shared with the chart of the list. */
export function EnergyGrid(): React.JSX.Element {
  return (
    <g aria-hidden="true">
      {[1, 5, 10].map((energy) => (
        <g key={energy}>
          <line
            x1={xOf(0)}
            x2={xOf(1)}
            y1={yOf(energy)}
            y2={yOf(energy)}
            stroke="var(--color-border)"
            strokeWidth={1}
          />
          <text
            x={2}
            y={yOf(energy) + 3}
            fontSize={8}
            fill="var(--color-text-muted)"
            className="font-mono"
          >
            {energy}
          </text>
        </g>
      ))}
    </g>
  )
}

/**
 * A curve of 5 to 10 points, drawn by dragging them. Each point is also a slider: the
 * up and down arrows change its energy, left and right its time.
 */
export function EnergyCurveEditor({
  points,
  onChange
}: {
  points: readonly CurvePoint[]
  onChange: (points: CurvePoint[]) => void
}): React.JSX.Element {
  const svg = React.useRef<SVGSVGElement>(null)
  const [dragging, setDragging] = React.useState<number | null>(null)
  const [chosen, setChosen] = React.useState<number | null>(null)

  /** Moves a point; the first stays at the start and the last at the end. */
  function move(index: number, t: number, energy: number): void {
    const before = points[index - 1]
    const after = points[index + 1]
    const time =
      index === 0 ? 0 : index === points.length - 1 ? 1 : clamp(t, before?.t ?? 0, after?.t ?? 1)
    onChange(
      points.map((point, at) =>
        at === index ? { t: time, energy: Math.round(clamp(energy, 1, 10) * 10) / 10 } : point
      )
    )
  }

  function pointerMove(event: React.PointerEvent<SVGSVGElement>): void {
    const matrix = svg.current?.getScreenCTM()
    if (dragging === null || !matrix || !svg.current) return
    const place = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    move(
      dragging,
      (place.x - PAD) / (CHART_WIDTH - 2 * PAD),
      1 + ((CHART_HEIGHT - PAD - place.y) / (CHART_HEIGHT - 2 * PAD)) * 9
    )
  }

  function keyDown(event: React.KeyboardEvent, index: number): void {
    const point = points[index]
    if (point === undefined) return
    const steps: Record<string, [number, number]> = {
      ArrowUp: [0, ENERGY_STEP],
      ArrowDown: [0, -ENERGY_STEP],
      ArrowLeft: [-TIME_STEP, 0],
      ArrowRight: [TIME_STEP, 0]
    }
    const step = steps[event.key]
    if (step === undefined) return
    event.preventDefault()
    move(index, point.t + step[0], point.energy + step[1])
  }

  /** A new point in the middle of the widest stretch. */
  function addPoint(): void {
    let widest = 1
    for (let index = 1; index < points.length; index += 1) {
      const span = (points[index]?.t ?? 0) - (points[index - 1]?.t ?? 0)
      if (span > (points[widest]?.t ?? 0) - (points[widest - 1]?.t ?? 0)) widest = index
    }
    const left = points[widest - 1] as CurvePoint
    const right = points[widest] as CurvePoint
    onChange([
      ...points.slice(0, widest),
      {
        t: (left.t + right.t) / 2,
        energy: Math.round(((left.energy + right.energy) / 2) * 10) / 10
      },
      ...points.slice(widest)
    ])
  }

  /** Removes the chosen point, or the one before the last; never the first or the last. */
  function removePoint(): void {
    const index =
      chosen !== null && chosen > 0 && chosen < points.length - 1 ? chosen : points.length - 2
    setChosen(null)
    onChange(points.filter((_, at) => at !== index))
  }

  return (
    <div className="flex flex-col gap-2">
      <svg
        ref={svg}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="w-full touch-none rounded-sm border border-border bg-surface"
        onPointerMove={pointerMove}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
      >
        <EnergyGrid />
        <polyline
          points={points.map((point) => `${xOf(point.t)},${yOf(point.energy)}`).join(' ')}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth={2}
        />
        {points.map((point, index) => (
          <circle
            // The points keep their order; an index names one well enough.
            key={index}
            cx={xOf(point.t)}
            cy={yOf(point.energy)}
            r={chosen === index ? 6 : 5}
            fill="var(--color-surface)"
            stroke="var(--color-primary)"
            strokeWidth={2}
            tabIndex={0}
            role="slider"
            aria-label={`${index + 1}. pont, a set ${Math.round(point.t * 100)}%-ánál`}
            aria-valuemin={1}
            aria-valuemax={10}
            aria-valuenow={point.energy}
            aria-valuetext={`Energy ${point.energy}`}
            className="cursor-grab focus-visible:outline-2 focus-visible:outline-primary"
            onPointerDown={(event) => {
              event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId)
              setDragging(index)
              setChosen(index)
            }}
            onFocus={() => setChosen(index)}
            onKeyDown={(event) => keyDown(event, index)}
          />
        ))}
      </svg>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-small text-text-muted">
          Húzd a pontokat, vagy válaszd ki őket, és mozgasd a nyilakkal.
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Pont hozzáadása"
          disabled={points.length >= MAX_CURVE_POINTS}
          onClick={addPoint}
        >
          <Plus />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Pont törlése"
          disabled={points.length <= MIN_CURVE_POINTS}
          onClick={removePoint}
        >
          <Minus />
        </Button>
      </div>
    </div>
  )
}
