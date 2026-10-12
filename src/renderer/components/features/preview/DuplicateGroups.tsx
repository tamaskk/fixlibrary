import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { RadioGroup, RadioRow } from '@/components/ui/radio-group'
import { cn } from '@/lib/cn'
import { formatCount, formatElapsed } from '@/lib/format'
import { DUPLICATES_FOLDER, type DuplicateGroup, type DuplicateMember } from '@shared/duplicates'

// DESIGN_SYSTEM §04: table rows are 36px high. The heading of a group is 40px.
const ROW_HEIGHT = 36
const HEADING_HEIGHT = 40
// The border around a group, and the room between two groups (space-4).
const GROUP_BORDER = 2
const GROUP_GAP = 16
// After the circle: the name of the file, its format, bitrate and length, what
// happens to the copy, and whether it is the one the app would keep. With their
// gaps, the circle, the padding of a row and the border of a group these need
// 706px; `min-w-176` below gives 704px and the name its last 2px. Both are less
// than the page has at the minimum window, so nothing scrolls sideways there.
const ROW_TEMPLATE = 'minmax(160px, 1fr) 64px 96px 64px 160px 64px'
// Copies of one track mostly differ at the end of their names (`(1)`, `- Copy`),
// so the end of a name is never cut: the ellipsis goes before these characters.
const NAME_TAIL_LENGTH = 14

type DuplicateGroupsProps = {
  groups: readonly DuplicateGroup[]
  /** While a change is on its way no other can be made. */
  disabled: boolean
  /** The element that says why, for a choice that cannot be made right now. */
  disabledReasonId?: string
  onKeep: (trackId: number) => void
}

/** `Artist – Title (Mix)`, with what is not known left out. */
function groupName(group: DuplicateGroup): string {
  const names = [group.artist, group.title].filter((name) => name !== null).join(' – ')
  const named = names === '' ? 'Ismeretlen track' : names
  return group.mix === null ? named : `${named} (${group.mix})`
}

// By what a reader sees as one character: a file name on macOS holds a letter and
// its accent as two code points, and the two must not land in different parts.
const characters = new Intl.Segmenter('hu', { granularity: 'grapheme' })

/** A name as its start, which may be cut, and its end, which is always shown. */
function splitName(name: string): { head: string; tail: string } {
  const parts = [...characters.segment(name)].map((part) => part.segment)
  // A name this short is its own end: there is nothing to cut before it.
  if (parts.length <= NAME_TAIL_LENGTH) return { head: '', tail: name }
  return {
    head: parts.slice(0, -NAME_TAIL_LENGTH).join(''),
    tail: parts.slice(-NAME_TAIL_LENGTH).join('')
  }
}

/**
 * The end of a path, two folders deep: enough to tell two copies of one name apart
 * by ear, also when both sit in a folder of the same name. Null for no folder.
 */
function lastFolders(folder: string): string | null {
  const parts = folder.split('/').filter((part) => part !== '')
  return parts.length === 0 ? null : parts.slice(-2).join('/')
}

function bitrateOf(member: DuplicateMember): string | null {
  return member.bitrateKbps === null ? null : `${formatCount(member.bitrateKbps)} kbps`
}

function lengthOf(member: DuplicateMember): string | null {
  return member.durationMs === null ? null : formatElapsed(member.durationMs)
}

/** What an approval does with the copy. */
function fateOf(member: DuplicateMember): string {
  if (member.keep) return 'Marad'
  return member.excluded ? 'Kimaradt, nem mozdul' : `${DUPLICATES_FOLDER} mappába`
}

function Value({ children }: { children: string | null }): React.JSX.Element {
  return children === null ? (
    <span className="text-right text-text-muted">–</span>
  ) : (
    <span className="text-right font-mono text-data tabular-nums">{children}</span>
  )
}

/**
 * The groups of duplicates of a batch: per group one copy stays, chosen with a
 * radio button, and the others are set aside when the batch is approved.
 */
export function DuplicateGroups({
  groups,
  disabled,
  disabledReasonId,
  onKeep
}: DuplicateGroupsProps): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const listId = React.useId()
  // The virtualizer's functions change with every scroll and are meant to be called
  // during render; nothing here memoizes them.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      HEADING_HEIGHT + (groups[index]?.members.length ?? 0) * ROW_HEIGHT + GROUP_BORDER + GROUP_GAP,
    overscan: 4
  })
  // The sizes follow from the groups: a group that lost a copy is shorter.
  React.useEffect(() => virtualizer.measure(), [virtualizer, groups])

  return (
    <div
      ref={scrollRef}
      role="list"
      // A Tab stop of its own, like the tables: with the focus on it the arrows and
      // Page Up and Down scroll, which brings the groups further down into the page.
      // Without it only the groups that happen to be rendered could be reached by keys.
      tabIndex={0}
      aria-label="Duplikátumcsoportok"
      className="min-h-48 flex-1 overflow-auto rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <div className="relative min-w-176" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const group = groups[item.index]
          if (!group) return null
          const name = groupName(group)
          const headingId = `${listId}-${group.id}`
          const kept = group.members.find((member) => member.keep)
          return (
            <div
              key={group.id}
              role="listitem"
              aria-setsize={groups.length}
              aria-posinset={item.index + 1}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {/* A group, not a region: a landmark per group would crowd the list of landmarks. */}
              <div
                role="group"
                aria-labelledby={headingId}
                className="overflow-hidden rounded-lg border border-border"
              >
                <div
                  className="flex items-center gap-4 border-b border-border bg-surface px-4"
                  style={{ height: HEADING_HEIGHT }}
                >
                  <h2
                    id={headingId}
                    title={name}
                    className="min-w-0 flex-1 truncate text-body font-medium"
                  >
                    {name}
                  </h2>
                  <p className="shrink-0 text-small text-text-muted">
                    <span className="font-mono text-data text-text tabular-nums">
                      {formatCount(group.members.length)}
                    </span>{' '}
                    példány
                  </p>
                </div>
                <RadioGroup
                  aria-label={`Megtartandó példány: ${name}`}
                  value={kept === undefined ? '' : String(kept.trackId)}
                  disabled={disabled}
                  aria-describedby={disabled ? disabledReasonId : undefined}
                  onValueChange={(value) => onKeep(Number(value))}
                >
                  {group.members.map((member) => {
                    const fate = fateOf(member)
                    const fileName = splitName(member.fileName)
                    const folders = lastFolders(member.folder)
                    const sameName = group.members.some(
                      (other) =>
                        other.trackId !== member.trackId && other.fileName === member.fileName
                    )
                    return (
                      <RadioRow
                        key={member.trackId}
                        value={String(member.trackId)}
                        aria-label={[
                          member.fileName,
                          // Two copies of one name are told apart by their folders.
                          sameName && folders !== null ? `${folders} mappa` : null,
                          member.format.toUpperCase(),
                          bitrateOf(member),
                          lengthOf(member),
                          fate,
                          member.suggested ? 'javasolt' : null
                        ]
                          .filter((part) => part !== null)
                          .join(', ')}
                        className={cn(
                          'border-b border-border px-4 text-body last:border-b-0',
                          // What is set aside steps back; the copy that stays does not.
                          !member.keep && 'text-text-muted'
                        )}
                        style={{ height: ROW_HEIGHT }}
                      >
                        <span
                          className="grid min-w-0 flex-1 items-center gap-2"
                          style={{ gridTemplateColumns: ROW_TEMPLATE }}
                        >
                          <span
                            title={`${member.folder}/${member.fileName}`}
                            className="flex min-w-0"
                          >
                            {/* Not `truncate`: that would drop a space at the cut. */}
                            <span className="overflow-hidden text-ellipsis whitespace-pre">
                              {fileName.head}
                            </span>
                            <span className="max-w-full shrink-0 overflow-hidden whitespace-pre">
                              {fileName.tail}
                            </span>
                          </span>
                          <span className="text-small text-text-muted uppercase">
                            {member.format}
                          </span>
                          <Value>{bitrateOf(member)}</Value>
                          <Value>{lengthOf(member)}</Value>
                          <span className="truncate pl-2 text-small">{fate}</span>
                          <span className="text-small text-text-muted">
                            {member.suggested ? 'Javasolt' : ''}
                          </span>
                        </span>
                      </RadioRow>
                    )
                  })}
                </RadioGroup>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
