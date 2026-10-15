// A remix is another record than its original: its own release, its own genre. The
// mix name says which: `Somebody Remix`, `Somebody Edit`.

const REMIX = /\b(?:remix|edit|rework|bootleg)$/iu
const PLAIN =
  /^(?:radio|extended|club|original|vocal|dub|instrumental|short|long|album|single|vip)\b/iu

/** True for a mix name that makes the track a version of its own: `Bicep Remix`, `Club Edit`. */
export function isRemixMix(mix: string | null | undefined): mix is string {
  return typeof mix === 'string' && REMIX.test(mix.trim())
}

/**
 * Who made the remix, from its mix name: `Bicep Remix` → `Bicep`. Null for a mix that
 * names no one (`Radio Edit`, `Extended Remix`) and for one that is no remix.
 */
export function remixerOf(mix: string | null | undefined): string | null {
  if (!isRemixMix(mix)) return null
  // `Bicep's Remix` is Bicep's.
  const name = mix
    .trim()
    .replace(REMIX, '')
    .trim()
    .replace(/['’]s$/u, '')
    .trim()
  if (name === '' || PLAIN.test(name)) return null
  return name
}

/** The title with the mix in brackets, unless it names the mix already. */
export function titleWithRemix(title: string, mix: string): string {
  return title.toLowerCase().includes(mix.toLowerCase()) ? title : `${title} (${mix})`
}
