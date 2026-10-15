// What each step of the Rekordbox wizard tells the user to do, in one place: a later
// Rekordbox may rename its menus, and these are the names of Rekordbox 7.2.7. Menu and
// command names stay as Rekordbox shows them, in English.
import {
  PHASE_A_STEPS,
  PHASE_B_STEPS,
  SETUP_STEPS,
  type WizardStep
} from '@shared/rekordbox-wizard'

export interface WizardStepText {
  /** The step in a few words, for the list of steps. */
  title: string
  /** What to do, one line each, in order. */
  instructions: string[]
  /** A remark under the instructions, or null. */
  note: string | null
}

export const WIZARD_STEP_TEXTS: Readonly<Record<WizardStep, WizardStepText>> = {
  'setup.showXml': {
    title: 'A rekordbox xml nézet bekapcsolása',
    instructions: [
      'Nyisd meg a Rekordboxban: Preferences → View.',
      'Kapcsold be a „rekordbox xml” megjelenítését a böngészőfában.'
    ],
    note: 'Ezt csak egyszer kell megcsinálni.'
  },
  'setup.importedLibrary': {
    title: 'Az XML útvonalának megadása',
    instructions: [
      'Nyisd meg a Rekordboxban: Preferences → Advanced → rekordbox xml.',
      'Az „Imported Library” mezőbe másold be az alábbi útvonalat.'
    ],
    note: 'Ezt csak egyszer kell megcsinálni.'
  },
  'a.writeXml': {
    title: 'Az XML megírása',
    instructions: ['Az app megírja az XML-t a könyvtár trackjeivel és a stílus playlistekkel.'],
    note: null
  },
  'a.refresh': {
    title: 'A rekordbox xml nézet frissítése',
    instructions: [
      'A Rekordbox böngészőfájában kattints a „rekordbox xml” melletti frissítés ikonra.'
    ],
    note: null
  },
  'a.importTracks': {
    title: 'Trackek importja',
    instructions: [
      'A „rekordbox xml” alatt nyisd meg az „All Tracks” listát.',
      'Jelölj ki minden tracket (Cmd + A).',
      'Jobb klikk → „Import To Collection”.'
    ],
    note: 'A kijelölt trackek importja a collectionben már bent lévő trackeket is frissíti.'
  },
  'a.importPlaylists': {
    title: 'Playlistek importja',
    instructions: [
      'Jobb klikk minden stílus playlistre és a „Playlists” folderre → „Import Playlist”.'
    ],
    note: null
  },
  'a.waitAnalysis': {
    title: 'Az elemzés megvárása',
    instructions: ['Várd meg, amíg a Rekordbox minden új tracknél elemzi a BPM-et és a gridet.'],
    note: null
  },
  'a.removeMissing': {
    title: 'A missing bejegyzések törlése',
    instructions: [
      'File → Display All Missing Files.',
      'Jelölj ki minden tracket (Cmd + A).',
      'Jobb klikk → „Remove from Collection”.'
    ],
    note: 'Ez csak a collection bejegyzéseit törli, fájlt nem. A régi bejegyzések playlistekből is kikerülnek, de a playlistek az új szerkezet szerint már bent vannak.'
  },
  'a.reloadTag': {
    title: 'A tagek frissítése',
    instructions: [
      'Jelöld ki a korábban is bent lévő, változatlan útvonalú trackeket.',
      'Jobb klikk → „Reload Tag”.'
    ],
    note: null
  },
  'a.export': {
    title: 'A collection exportja',
    instructions: ['File → Export Collection in xml format.', 'Mentsd az alábbi mappába.'],
    note: null
  },
  'a.check': {
    title: 'Az export ellenőrzése',
    instructions: [
      'Az app beolvassa a legújabb exportot, és megnézi, hogy minden track bent van-e, nincs-e missing bejegyzés, és minden track elemezve van-e.'
    ],
    note: 'Csak hibátlan ellenőrzés után lehet továbblépni.'
  },
  'b.writeXml': {
    title: 'Az XML megírása a hot cue-kkal',
    instructions: ['Az app megírja az XML-t a beatgriddel és a hot cue-kkal.'],
    note: null
  },
  'b.import': {
    title: 'Hot cue-k importja',
    instructions: [
      'Frissítsd a „rekordbox xml” nézetet.',
      'Az „All Tracks” listában jelölj ki minden tracket (Cmd + A).',
      'Jobb klikk → „Import To Collection”.'
    ],
    note: null
  },
  'b.export': {
    title: 'A collection exportja',
    instructions: ['File → Export Collection in xml format, az export mappájába.'],
    note: null
  },
  'b.check': {
    title: 'A hot cue-k ellenőrzése',
    instructions: ['Az app megnézi, hogy minden tracknél a helyén van-e minden hot cue (±10 ms).'],
    note: null
  }
}

/** The parts of the wizard, with the steps of each in order. */
export const WIZARD_PHASES: readonly { title: string; steps: readonly WizardStep[] }[] = [
  { title: 'Egyszeri beállítás', steps: SETUP_STEPS },
  { title: 'A fázis: trackek', steps: PHASE_A_STEPS },
  { title: 'B fázis: hot cue-k', steps: PHASE_B_STEPS }
]
