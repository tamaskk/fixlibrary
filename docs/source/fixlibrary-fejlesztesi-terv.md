# FixLibrary – Fejlesztési terv

A FixLibrary egy nulláról induló Electron alapú Mac app (MacBook Pro 13" M1, Rekordbox 7.2.7), amit Claude Code-dal, agentic módon fejlesztünk. A terv a „FixLibrary – Dokumentáció” döntéseire épül.

**Keretek**

- Kód még nincs, ezért a „Jelenlegi állapot” minden feladatnál a dokumentáció vonatkozó szekciójára és a korábbi feladatokban elkészült modulokra hivatkozik.
- Méret: S ≤ 1 nap · M 2–5 nap · L 1+ hét, teljes 8 órás munkanapban, Claude Code-os agentic fejlesztéssel.
- Súly: 🔴 blokkoló · 🟠 komoly · 🟡 csiszolás
- Repo: `tamaskk/fixlibrary` (nyilvános GitHub repo, a release-ek a GitHub Releases-en).
- Stack: `electron-vite` + `electron-builder`, React + TypeScript + Tailwind + shadcn/ui, Zustand, SQLite (`better-sqlite3` + Drizzle), Python sidecar JSON-RPC-vel stdio-n, `python-build-standalone` + `uv`, `wavesurfer.js`, `mutagen` (ID3v2.3), Vitest, Playwright, pytest.
- API kulcsok: `ACOUSTID_API_KEY`, `DISCOGS_CONSUMER_KEY`, `DISCOGS_CONSUMER_SECRET`. Fejlesztéskor a `.env.local` fájlban (a `.gitignore`-ban szerepel), az appban a Settings oldalon adhatók meg, és a macOS Keychainben tárolódnak. Értékük sem a repóba, sem ebbe a tervbe nem kerül.

---

## 1. Összesítő táblázat

### A. Projekt alapok

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Projekt váz | `package.json`, `electron.vite.config.ts`, `src/main`, `src/preload`, `src/renderer`, `src/shared` | Nincs repo és nincs futtatható app | Minden további feladat erre épül | 🔴 | M |
| 2 | Python környezet spike M1-en | `python/pyproject.toml`, `python/uv.lock` | Nem ismert, hogy az Essentia és a Demucs (PyTorch, MPS) együtt telepíthető-e arm64-en `python-build-standalone`-nal | Ha nem megy, az elemzés és a cue funkció nem épülhet erre a stackre | 🔴 | S |
| 3 | Python sidecar és bridge | `python/fixlib_py/server.py`, `src/main/services/python-bridge.ts` | Nincs kapcsolat a TypeScript és a Python oldal között | Minden audio művelet a Pythonon fut | 🔴 | M |
| 4 | Adatbázis séma | `src/main/db/schema.ts`, `src/main/db/migrations/` | Nincs hely a trackek, elemzések, batchek, backupok, playlistek, beállítások és a lookup cache tárolására | Az app állapota újraindítás után is megmarad, és a 3000 track nem dolgozódik fel újra | 🔴 | M |
| 5 | Külső binárisok | `resources/bin/`, `src/main/services/binaries.ts` | Nincs `yt-dlp`, `ffmpeg`, `fpcalc`, `mp3gain` az appban | A konverzió, a fingerprint, a letöltés és a normalizálás ezekre épül | 🔴 | S |
| 6 | Settings és Keychain | `src/main/services/keychain.ts`, `src/renderer/pages/Settings.tsx` | Nincs hol megadni az API kulcsokat, mappákat, módokat, célszintet, stílusokat és színeket | A kulcsok nem kerülhetnek a kódba, a beállítások minden funkciót vezérelnek | 🟠 | M |
| 7 | Logolás és hibakezelési keret | `src/main/services/logger.ts`, `python/fixlib_py/logging_setup.py` | Nincs log, és nincs egységes „kihagy és listáz” viselkedés | 3000 tracknél az elakadások nyom nélkül elvesznének | 🟠 | S |

### B. Könyvtár és pipeline keret

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 8 | Könyvtár beolvasás és kijelölés | `src/main/pipeline/scanner.ts`, `src/renderer/pages/Library.tsx` | Az app nem látja a külső lemezen lévő trackeket, és nem lehet kijelölni belőlük | A teljes könyvtáras és a kijelölt trackes futtatás alapja | 🔴 | M |
| 9 | Pipeline orchestrator és job queue | `src/main/pipeline/orchestrator.ts`, `src/main/pipeline/queue.ts` | Nincs ütemezés, párhuzamosság, megszakítás és folytatás | A Demucs fél–egy napos futása csak így kezelhető | 🔴 | L |
| 10 | Fájlműveletek, backup és undo | `src/main/services/file-ops.ts` | Nincs in-place / clean library switch, backup és „Undo last batch” | Hibás batch esetén elveszhet az eredeti fájl | 🔴 | M |
| 11 | Batch preview keret | `src/renderer/components/BatchPreviewTable.tsx`, `src/main/pipeline/preview.ts` | Nincs közös felület a változások megtekintésére, szerkesztésére és jóváhagyására | Az 1–4., 8. és 9. funkció mind ezen keresztül hagyatja jóvá a változásokat | 🔴 | L |
| 12 | Claude CLI service | `src/main/services/claude-cli.ts` | Nincs `claude -p` hívás, JSON kimenet feldolgozás és 20-as batching | A stílus döntés, a hangulat és a prompt alapú generálás erre épül | 🔴 | M |

### C. Fájlnév és tag fixálás (1. funkció)

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 13 | BPM és key elemzés | `python/fixlib_py/analysis/bpm_key.py` | Nincs saját BPM és key meghatározás | A fájlnév, a playlist szabályok és az ajánlások erre épülnek | 🔴 | M |
| 14 | Fingerprint és online metadata lookup | `python/fixlib_py/fingerprint.py`, `src/main/services/lookup/` | Nincs AcoustID → MusicBrainz → Discogs → Beatport lánc, cache és confidence | A helyes artist, title, label és year forrása | 🔴 | L |
| 15 | Név tisztítás és fájlnév formátum | `src/main/pipeline/naming.ts` | Nincs junk eltávolítás, feat. normalizálás és `[8A Am - 124 - E7]` formátum | Ez adja az egységes fájlneveket | 🔴 | M |
| 16 | Tag írás | `python/fixlib_py/tags.py` | Nincs ID3v2.3 írás az összes mezőre | A Rekordbox a tagekből olvassa az adatokat | 🔴 | S |
| 17 | Duplikátumok | `src/main/pipeline/duplicates.ts` | Nincs duplikátum felismerés és „melyik maradjon” választás | Duplikátumok foglalják a helyet és zavarják az ajánlásokat | 🟠 | M |
| 18 | WAV → AIFF konverzió | `python/fixlib_py/convert.py` | A WAV fájlok tagjei és covere nem működnek, és a 48 kHz feletti fájlok nem játszhatók le minden Pioneer lejátszón | CDJ, XDJ és DDJ lejátszhatóság | 🟠 | S |

### D. Cover kép (2. funkció)

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 19 | Cover lookup és beágyazás | `src/main/services/lookup/cover.ts`, `python/fixlib_py/tags.py` | Nincs forráslánc, méret szabály és 600×600-as beágyazás | A trackek többségénél nincs cover | 🟠 | M |
| 20 | Placeholder és kézi csere | `python/fixlib_py/placeholder.py`, `src/renderer/components/CoverDrop.tsx` | Nincs generált kép találat nélkül, és nincs drag & drop | Minden track kapjon képet, és legyen kézi felülírás | 🟡 | S |

### E. Stílus szerinti rendezés (3. funkció)

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 21 | Stílus besorolás | `src/main/pipeline/style.ts` | Nincs genre alapú, remixet figyelembe vevő, Claude által hozott döntés | A mappák, a placeholder színek, az energy és a playlistek erre épülnek | 🔴 | M |
| 22 | Mappába rendezés és tagek | `src/main/pipeline/organize.ts` | Nincs fizikai mappastruktúra, genre és comment tag | Ez a könyvtár új felépítése | 🔴 | S |

### F. Energy level (4. funkció)

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 23 | Energy feature-ök | `python/fixlib_py/analysis/energy.py` | Nincs loudness, percussive energy, onset density és spectral elemzés | Az energy érték nyersanyaga | 🟠 | M |
| 24 | Kalibráció és 1–10 skála | `src/renderer/pages/Calibration.tsx`, `src/main/pipeline/energy.ts` | Nincs kalibrációs felület és stílusonkénti normalizálás | Az érték csak a saját érzésedre kalibrálva használható | 🟠 | M |

### G. Rekordbox integráció

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 25 | Rekordbox XML író | `src/main/services/rekordbox-xml.ts` | Nincs XML export a collectionnel, playlist folderekkel és hot cue-kkal | Ez az egyetlen út a Rekordboxba | 🔴 | M |
| 26 | Rekordbox XML olvasó | `src/main/services/rekordbox-xml.ts` | Nincs beatgrid és track beolvasás a Rekordbox exportjából | A cue-k a Rekordbox gridjére épülnek | 🔴 | S |
| 27 | Rekordbox varázsló és missing takarítás | `src/renderer/pages/RekordboxWizard.tsx`, `src/main/pipeline/rekordbox-check.ts` | Nincs végigvezetett import → elemzés → export lépés, és nincs missing takarítás és ellenőrzés | Az átnevezett fájlok régi bejegyzései hibásan maradnának a collectionben | 🟠 | M |

### H. Auto cue pointok és hot cue-k (5. funkció)

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 28 | Demucs stem separation | `python/fixlib_py/analysis/stems.py` | Nincs bass és vocal stem, háttérfutás és cache | A bassline és a vocal kezdetének pontos felismerése | 🔴 | L |
| 29 | Szerkezet felismerés és cue elhelyezés | `python/fixlib_py/analysis/structure.py`, `src/main/pipeline/cues.ts` | Nincs drop, breakdown és outro felismerés, és nincs a 8 helyes sémára illesztés | Ez maga az 5. funkció | 🔴 | L |
| 30 | Waveform cue editor | `src/renderer/pages/CueEditor.tsx`, `src/renderer/components/Waveform.tsx` | Nincs waveform nézet, gridhez illesztett mozgatás és törlés | A cue-k ellenőrzése és javítása | 🟠 | L |

### I. Hangerő normalizálás (9. funkció)

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 31 | Loudness mérés | `python/fixlib_py/analysis/loudness.py` | Nincs LUFS és true peak mérés | A normalizálás és a preview alapja | 🟠 | S |
| 32 | Normalizálás | `python/fixlib_py/normalize.py` | Nincs veszteségmentes és pontos mód, és nincs kihagyás clippelés esetén | A trackek közötti hangerőkülönbség megszüntetése | 🟠 | M |
| 33 | A/B lejátszó és mért értékek | `src/renderer/components/AbPlayer.tsx` | Nincs összehasonlító meghallgatás és előtte/utána érték | A változás ellenőrzése jóváhagyás előtt | 🟡 | M |

### J. Letöltés yt-dlp-vel (8. funkció)

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 34 | Letöltő | `src/main/services/downloader.ts`, `src/renderer/pages/Download.tsx` | Nincs URL-es és keresés alapú letöltés, MP3 320 kimenet, bitrate figyelmeztetés és duplikátum előellenőrzés | Új trackek bekerülése a könyvtárba | 🟠 | M |
| 35 | Inbox feldolgozás | `src/main/pipeline/inbox.ts` | A letöltött trackek nem mennek végig automatikusan a funkciókon | Az új trackek ugyanolyan rendezettek legyenek, mint a meglévők | 🟠 | S |

### K. Playlistek (6–7. funkció)

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 36 | Hasonlósági motor | `src/main/pipeline/similarity.ts` | Nincs stílus, BPM, Camelot, energy és hangulat alapú pontozás | Az ajánlás és a generálás közös alapja | 🟠 | M |
| 37 | Playlist kezelés és helyi ajánlás | `src/renderer/pages/Playlists.tsx`, `src/main/pipeline/playlists.ts` | Nincs playlist létrehozás és 10 helyi ajánlás | A 6. funkció helyi része | 🟠 | M |
| 38 | Online ajánlás | `src/main/pipeline/online-recs.ts` | Nincs Claude és Beatport alapú, létezésre ellenőrzött online ajánlás | A 6. funkció online része, és a 7. funkció hiánypótlása | 🟡 | M |
| 39 | Playlist generátor | `src/main/pipeline/generator.ts`, `src/renderer/pages/Generator.tsx` | Nincs prompt és paraméter alapú generálás, energy görbe, sorrend szabályok és track csere | Ez maga a 7. funkció | 🟠 | L |

### L. Teljes pipeline

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 40 | Egy gombos teljes futtatás | `src/main/pipeline/full-run.ts`, `src/renderer/pages/Library.tsx` | Nincs 1 → 2 → 3 → 4 → 9 → Rekordbox lépés → 5 állapotgép | A teljes könyvtár első rendbetétele egy folyamatként | 🟠 | S |

### M. Csomagolás és kiadás

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 41 | Python runtime csomagolás | `scripts/build-python.sh`, `src/main/services/python-runtime.ts` | A Python környezet nincs az appba csomagolva, és nem frissíthető az apptól függetlenül | Egy .dmg-ből működjön minden | 🔴 | M |
| 42 | DMG build | `electron-builder.yml` | Nincs arm64 .dmg | Ez a végtermék | 🔴 | S |
| 43 | Félautomata frissítés | `src/main/services/updater.ts` | Nincs verzió ellenőrzés, app frissítés és komponens frissítés (yt-dlp, Python környezet) | A yt-dlp a YouTube változásai miatt gyakori frissítést igényel | 🟠 | M |
| 44 | Release workflow | `.github/workflows/release.yml` | A .dmg buildelése és feltöltése kézi | Minden kiadás egyformán és hibamentesen készüljön | 🟡 | S |

### N. Tesztelés

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 45 | Teszt készlet és éles próba | `tests/fixtures/`, `tests/e2e/` | Nincs valós trackeken végzett teljes futtatás és Pioneer USB próba | Csak így derül ki, hogy a könyvtár CDJ-n, XDJ-n és DDJ-n is működik | 🔴 | M |

---

## 2. Részletes kidolgozás

### A. Projekt alapok

#### 1. Projekt váz

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Projekt váz | `package.json`, `electron.vite.config.ts`, `src/main`, `src/preload`, `src/renderer`, `src/shared` | Nincs repo és nincs futtatható app | Minden további feladat erre épül | 🔴 | M |

**Jelenlegi állapot**
Nincs kód és nincs repo. A dokumentáció „Telepíthető Mac app” szekciója rögzíti: Electron + React + TypeScript, arm64 build, `tamaskk/fixlibrary` nyilvános repo.

**Probléma**
Futtatható váz nélkül egyik funkció sem kezdhető el, és ha a konvenciók (mappastruktúra, IPC minta, tesztkeret) nincsenek az elején rögzítve, a Claude Code minden feladatnál más mintát követhet.

**Megoldás**
1. Repo létrehozása: `gh repo create tamaskk/fixlibrary --public --clone`.
2. Scaffold: `npm create @quick-start/electron@latest fixlibrary -- --template react-ts`. Node 22 LTS, rögzítve egy `.nvmrc` fájlban.
3. Mappák a javasolt struktúra szerint: `src/main/{ipc,pipeline,services,db}`, `src/preload`, `src/renderer/{pages,components,stores}`, `src/shared`.
4. Tailwind v4: `npm i -D tailwindcss @tailwindcss/vite`, a plugin a `electron.vite.config.ts` renderer részébe kerül. A `@/` alias a `tsconfig.web.json`-ban és a renderer Vite configban is beáll.
5. shadcn/ui: `npx shadcn@latest init` a rendererben, majd az alap komponensek: `button`, `table`, `dialog`, `tabs`, `input`, `select`, `switch`, `progress`, `sonner`.
6. Zustand: `npm i zustand`, első store a `src/renderer/stores/app-store.ts`.
7. Biztonságos IPC minta: a `BrowserWindow` beállításai `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. A `src/preload/index.ts` a `contextBridge.exposeInMainWorld('api', …)` hívással ad ki egy típusos API-t, a típusok a `src/shared/ipc.ts` fájlban vannak.
8. Tesztkeret: Vitest (`vitest.config.ts`, minta teszt a `src/shared`-ben), Playwright (`playwright.config.ts`, a `tests/e2e/app.spec.ts` az `_electron.launch()` hívással indítja az appot).
9. `.gitignore` kiegészítés: `.env.local`, `python/.venv`, `resources/bin/*` (a binárisokat egy script tölti le, lásd 5. feladat), `release/`. Mellé egy `.env.example` kerül, benne csak a három változónév, értékek nélkül.
10. `CLAUDE.md` a repo gyökerében a Claude Code-nak: a mappastruktúra, a parancsok (`npm run dev`, `npm test`, `npm run test:e2e`, `uv run pytest`), az IPC minta, és az a szabály, hogy kulcs vagy jelszó soha nem kerül a kódba.
11. Az ablak címe „FixLibrary”, az első oldal egy üres Library képernyő.

**Elfogadási feltételek**
- `npm run dev` megnyit egy „FixLibrary” című ablakot az üres Library oldallal.
- `npm test` lefut, és a minta teszt zöld.
- `npm run test:e2e` elindítja az appot, és ellenőrzi az ablak címét.
- `git status` friss klón után nem mutatja a `.env.local` fájlt, a `.env.example` viszont benne van a repóban.
- A rendererben a `window.require` nem létezik (nincs Node elérés), a `window.api` igen.

**Tesztelés**
Kézzel: `npm run dev`, és a DevTools konzolban a `typeof window.require` értéke `undefined`. Automatikusan: Vitest és Playwright, ahogy fent.

**Függőségek és kockázatok**
- Nincs előfeltétel.
- Kockázat: a `better-sqlite3` natív modul (4. feladat) az Electron Node verziójára fordítandó. Ezt már itt kezeljük egy `postinstall: electron-builder install-app-deps` scripttel, különben az app induláskor „NODE_MODULE_VERSION” hibával áll le.

#### 2. Python környezet spike M1-en

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | Python környezet spike M1-en | `python/pyproject.toml`, `python/uv.lock` | Nem ismert, hogy az Essentia és a Demucs (PyTorch, MPS) együtt telepíthető-e arm64-en `python-build-standalone`-nal | Ha nem megy, az elemzés és a cue funkció nem épülhet erre a stackre | 🔴 | S |

**Jelenlegi állapot**
A dokumentáció az Essentiát (BPM, key, energy) és a Demucst (stem separation, M1 GPU) írja elő, beágyazott Python runtime-mal. Python környezet még nincs.

**Probléma**
Az Essentia és a PyTorch natív csomagok. Ha valamelyiknek nincs működő arm64 buildje a választott Python verzióra, az csak késői fázisban derülne ki, amikor már sok kód épül rájuk.

**Megoldás**
1. `python-build-standalone` letöltése: CPython 3.11, `aarch64-apple-darwin`, `install_only` változat, a `python/runtime/` mappába (ez a mappa a `.gitignore`-ban van).
2. `uv init python --package --name fixlib_py`, majd `uv venv --python python/runtime/bin/python3`.
3. Függőségek: `uv add essentia demucs torch torchaudio mutagen numpy pyloudnorm soundfile pillow`.
4. Spike script a `python/spike/run_spike.py` fájlban, ami egy tesztfájlon:
    - Essentiával kiszámolja a BPM-et (`RhythmExtractor2013`) és a key-t (`KeyExtractor`),
    - kiírja, hogy a `torch.backends.mps.is_available()` igaz-e,
    - lefuttatja a Demucs `htdemucs` modellt egy tracken MPS-en (`PYTORCH_ENABLE_MPS_FALLBACK=1` mellett), és méri az időt.
5. Döntési szabály, amit a spike eredménye alapján alkalmazunk:
    - Ha az `uv add essentia` arm64 wheelt telepít és a script lefut, ez a végleges megoldás.
    - Ha nincs arm64 wheel, az Essentia forrásból épül egy `scripts/build-essentia.sh` scripttel (Homebrew függőségekkel: `fftw`, `libsamplerate`, `taglib`, `libyaml`, `ffmpeg`), és a kész wheel a `python/wheels/` mappából települ.
    - Ha a Demucs MPS-en hibát dob, CPU-n fut (`-d cpu`), és a mért időt a 28. feladat becslésébe vezetjük.
6. Az eredmény (verziók, a választott út, track per idő a Demucsnál) a `python/SPIKE.md` fájlba kerül.

**Elfogadási feltételek**
- `uv run python spike/run_spike.py <track.mp3>` kiírja a BPM-et, a key-t, az MPS elérhetőségét és a Demucs futásidejét.
- A `python/SPIKE.md` tartalmazza a választott utat és a mért Demucs időt egy tracken.
- A `uv.lock` commitolva van.

**Tesztelés**
A spike scriptet 3 különböző trackkel futtatjuk (egy MP3, egy WAV, egy hosszabb, 8 perc feletti track), és az eredményeket kézzel összevetjük a Rekordbox által mért BPM-mel és key-jel.

**Függőségek és kockázatok**
- Előtte: 1. feladat.
- Kockázat: az Essentia AGPL-3.0 licencű. Mivel a repo és a release-ek nyilvánosak, a repo licence legyen AGPL-3.0 (`LICENSE` fájl), különben a nyilvános terjesztés sérti az Essentia licencét.
- Kockázat: a PyTorch, az Essentia és a `librosa` adja a Python környezet méretének nagyját, ez határozza meg a .dmg méretét. A spike a `python/SPIKE.md`-be rögzíti a környezet tényleges méretét, mert a 42. feladatban a .dmg-nek a GitHub Releases fájlonkénti 2 GiB-os korlátja alatt kell maradnia.

#### 3. Python sidecar és bridge

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | Python sidecar és bridge | `python/fixlib_py/server.py`, `src/main/services/python-bridge.ts` | Nincs kapcsolat a TypeScript és a Python oldal között | Minden audio művelet a Pythonon fut | 🔴 | M |

**Jelenlegi állapot**
A 2. feladat után működik a Python környezet, de az Electron még nem tudja hívni.

**Probléma**
Ha minden művelethez új Python folyamat indul, az Essentia és a PyTorch betöltése trackenként több másodperc, ami 3000 tracknél órákat jelent. Ha a folyamat összeomlik, és ezt semmi nem kezeli, az app lefagy.

**Megoldás**
1. `python/fixlib_py/server.py`: egy folyamatosan futó JSON-RPC 2.0 szerver, ami soronként olvas JSON-t a stdinről, és soronként ír a stdoutra.
    - A `sys.stdout`-ot csak a protokoll író használja. Minden más kimenet (print, könyvtárak logjai) a stderrre és a log fájlba megy, hogy ne törje meg a protokollt.
    - Metódus regiszter: `@rpc("analysis.bpm_key")` dekorátor.
    - Két executor: egy `ProcessPoolExecutor(max_workers=os.cpu_count() - 1)` a CPU-s elemzéseknek, és egy egyszálas executor a Demucsnak.
    - Haladás jelentése notificationnel: `{"method": "progress", "params": {"jobId", "percent"}}`.
    - Beépített metódusok: `ping` (verziót ad vissza), `shutdown`.
2. `src/main/services/python-bridge.ts`:
    - indítás: `spawn(pythonPath, ['-m', 'fixlib_py.server'], { env: { FIXLIB_LOG_DIR, PYTORCH_ENABLE_MPS_FALLBACK: '1' } })`,
    - `call<M extends keyof RpcMethods>(method, params, { timeoutMs })`, ami Promise-t ad vissza, a függőben lévő hívások egy `Map<id, {resolve, reject, timer}>`-ben,
    - összeomlásnál a függő hívások `PYTHON_CRASHED` hibakóddal elutasítódnak, és a folyamat 1 s, 2 s, 4 s várakozással újraindul (legfeljebb 5-ször egymás után),
    - az app kilépésekor (`before-quit`) `shutdown` hívás, 3 s után `SIGKILL`.
3. `src/shared/rpc.ts`: a metódusok paramétereinek és visszatérési értékeinek típusai, amit a TypeScript és (kézzel szinkronban tartva) a Python oldal is követ.
4. A Python útvonala fejlesztéskor `python/.venv/bin/python`, a csomagolt appban a 41. feladat határozza meg.

**Elfogadási feltételek**
- A `ping` hívás 1 s-on belül visszaadja a `fixlib_py` verzióját.
- A Python folyamat kézi leölése után (`kill -9`) a függő hívások `PYTHON_CRASHED` hibával térnek vissza, és 5 s-on belül egy új `ping` sikeres.
- 100 párhuzamos `echo` hívás mind helyes választ kap.
- Egy Pythonban hagyott `print()` nem töri meg a protokollt.

**Tesztelés**
- pytest: a `server.py` diszpécsere, hibás JSON kezelése, ismeretlen metódus (`-32601` hibakód).
- Vitest: a bridge valódi Python folyamattal fejlesztői környezetben: ping, timeout, crash utáni újraindulás, 100 párhuzamos hívás.

**Függőségek és kockázatok**
- Előtte: 1. és 2. feladat.
- Kockázat: a `ProcessPoolExecutor` alatt a PyTorch modell folyamatonként töltődne be. Ezért a Demucs külön, egyetlen folyamatban fut, ahol a modell egyszer töltődik be és a memóriában marad.

#### 4. Adatbázis séma

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 4 | Adatbázis séma | `src/main/db/schema.ts`, `src/main/db/migrations/` | Nincs hely a trackek, elemzések, batchek, backupok, playlistek, beállítások és a lookup cache tárolására | Az app állapota újraindítás után is megmarad, és a 3000 track nem dolgozódik fel újra | 🔴 | M |

**Jelenlegi állapot**
Nincs adattárolás. A dokumentáció szerint a könyvtár külső lemezen van, és a feldolgozás megszakítható és folytatható.

**Probléma**
Tárolt állapot nélkül minden indításkor újra kellene elemezni és lookupolni mindent, a Demucs futás nem lenne folytatható, és az undo-hoz sem lenne mihez visszanyúlni.

**Megoldás**
1. `npm i better-sqlite3 drizzle-orm` és `npm i -D drizzle-kit @types/better-sqlite3`.
2. Az adatbázis helye: `app.getPath('userData')/fixlibrary.db` (`~/Library/Application Support/FixLibrary/`), WAL módban (`PRAGMA journal_mode = WAL`).
3. Táblák a `src/main/db/schema.ts` fájlban:
    - `tracks`: azonosító, aktuális és eredeti útvonal, kötet neve, formátum, hossz, bitrate, sample rate, artist, title, mix, album, label, year, BPM, Camelot key, zenei key, energy, elsődleges és másodlagos stílus, cover állapot, LUFS, true peak, AcoustID és MusicBrainz azonosító, feldolgozási állapot funkciónként, `updated_at`.
    - `analyses`: track, típus (`bpm_key`, `energy_features`, `stems`, `structure`, `loudness`), JSON eredmény, elemző verzió.
    - `lookup_cache`: forrás, lekérdezés kulcs, JSON válasz, időpont.
    - `batches` és `batch_items`: batch típusa, módja (in-place vagy clean library), állapota, illetve trackenként az előtte és utána állapot, jóváhagyás, kizárás, hiba.
    - `backups`: batch, track, eredeti útvonal, backup útvonal.
    - `cues`: track, slot (1–8), pozíció ms-ban, név, szín.
    - `playlists` és `playlist_tracks` (pozícióval).
    - `styles`: név, szín, house-e, sorrend.
    - `energy_calibration`: track, a te értéked.
    - `settings`: kulcs, JSON érték.
4. Migrációk: `drizzle-kit generate` a fejlesztésben, induláskor a `migrate()` hívás (`drizzle-orm/better-sqlite3/migrator`) futtatja őket. A migrációs mappa az `electron-builder.yml`-ben `extraResources`-ként kerül az appba.
5. Külső lemez kezelése: a track rekord tárolja a kötet nevét (`/Volumes/<név>`). Ha a kötet nincs csatlakoztatva, a trackek „offline” állapotban látszanak, és a feldolgozás nem indítható rajtuk.

**Elfogadási feltételek**
- Friss telepítés után az első indítás létrehozza az adatbázist az összes táblával.
- Egy beírt rekord újraindítás után is megvan.
- Új migráció hozzáadása után a meglévő adatbázis adatvesztés nélkül frissül.
- A külső lemez leválasztásakor a Library offline állapotot mutat, és az app nem omlik össze.

**Tesztelés**
Vitest ideiglenes adatbázis fájllal: migrációk futása, CRUD a fő táblákon, offline jelölés egy nem létező kötet útvonalára.

**Függőségek és kockázatok**
- Előtte: 1. feladat.
- Kockázat: a natív modul újrafordítása (lásd 1. feladat).
- Kockázat: a sémát a későbbi feladatok bővítik. Ez rendben van, minden bővítés új migráció, meglévő migrációt nem módosítunk.

#### 5. Külső binárisok

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 5 | Külső binárisok | `resources/bin/`, `src/main/services/binaries.ts` | Nincs `yt-dlp`, `ffmpeg`, `fpcalc`, `mp3gain` az appban | A konverzió, a fingerprint, a letöltés és a normalizálás ezekre épül | 🔴 | S |

**Jelenlegi állapot**
A dokumentáció szerint a `yt-dlp` és az `ffmpeg` az appba csomagolva kerül a gépre. Az AcoustID fingerprinthez az `fpcalc` (Chromaprint), a veszteségmentes MP3 normalizáláshoz az `mp3gain` kell.

**Probléma**
Ha az app a rendszerre telepített eszközökre támaszkodik, a .dmg egy másik gépen vagy egy macOS frissítés után nem működik. Ha egy bináris nem arm64-es, Rosettán fut lassabban, vagy el sem indul.

**Megoldás**
1. `scripts/fetch-binaries.sh`, ami rögzített verziókat tölt le vagy fordít a `resources/bin/` mappába:
    - `yt-dlp`: a hivatalos `yt-dlp_macos` release fájl.
    - `ffmpeg`: az `ffmpeg-static` npm csomag darwin-arm64 binárisa, átmásolva a `resources/bin/` mappába.
    - `fpcalc`: a hivatalos Chromaprint release macOS változata. Ha az nem tartalmaz arm64 architektúrát, a script forrásból fordítja (`cmake -DBUILD_TOOLS=ON`).
    - `mp3gain`: forrásból fordítva (1.6.2). Ha a fordítás nem sikerül, az `aacgain` forrásból fordítva, ami ugyanazt a veszteségmentes MP3 gain állítást tudja.
2. A script minden bináris után ellenőrzi a `lipo -archs` kimenetét: `arm64`-et kell tartalmaznia, különben hibával kilép.
3. `src/main/services/binaries.ts`:
    - útvonal feloldás: fejlesztéskor `resources/bin/`, csomagolva `process.resourcesPath/bin/`, a frissíthető `yt-dlp` esetén előbb a `userData/bin/` (lásd 43. feladat),
    - `checkAll()`: mind a négy binárist lefuttatja verziókapcsolóval, és visszaadja a verziókat vagy a hibát.
4. A Settings oldal (6. feladat) mutatja a `checkAll()` eredményét.

**Elfogadási feltételek**
- `scripts/fetch-binaries.sh` tiszta klónon lefut, és mind a négy bináris arm64.
- `checkAll()` mind a négy verziót visszaadja fejlesztői és csomagolt appban is.

**Tesztelés**
Vitest: a `checkAll()` valódi binárisokkal. Kézzel: a csomagolt appban a Settings oldalon zöld minden bináris.

**Függőségek és kockázatok**
- Előtte: 1. feladat.
- Kockázat: az `mp3gain` és az `fpcalc` forrásból fordítása Xcode Command Line Tools-t igényel (`xcode-select --install`).

#### 6. Settings és Keychain

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | Settings és Keychain | `src/main/services/keychain.ts`, `src/renderer/pages/Settings.tsx` | Nincs hol megadni az API kulcsokat, mappákat, módokat, célszintet, stílusokat és színeket | A kulcsok nem kerülhetnek a kódba, a beállítások minden funkciót vezérelnek | 🟠 | M |

**Jelenlegi állapot**
A dokumentáció szerint az API kulcsok a Settings oldalon adhatók meg és a Keychainben tárolódnak, az in-place / clean library mód switch, a LUFS célszint, a normalizálási módszer, a stílus lista és a placeholder színek a beállításokban szerkeszthetők, a Rekordbox XML útvonalak fix mappák. A 4. feladat után van `settings` és `styles` tábla.

**Probléma**
Beállítások nélkül minden érték kódba égetett lenne, és az API kulcsok a nyilvános repóba vagy a .dmg-be kerülnének, ahonnan bárki kiolvashatja őket.

**Megoldás**
1. `src/main/services/keychain.ts`: az Electron beépített `safeStorage` API-ja titkosítja a kulcsokat a macOS Keychainben tárolt kulccsal. A titkosított érték a `settings` táblába kerül, nyílt szöveg sehol nem tárolódik.
2. Fejlesztéskor, ha `!app.isPackaged`, a `dotenv` beolvassa a `.env.local` fájlt, és ha a Keychainben nincs érték, ez lesz a tartalék. A csomagolt app a `.env` fájlokat figyelmen kívül hagyja.
3. `src/renderer/pages/Settings.tsx` szekciói:
    - **Könyvtár**: könyvtár gyökér mappa, mód switch (in-place vagy clean library), clean library célmappa, backup mappa.
    - **Rekordbox**: az app által írt XML helye, a Rekordboxból exportált XML helye.
    - **API kulcsok**: AcoustID, Discogs consumer key, Discogs consumer secret, mentés gomb és egy „Teszt” gomb, ami egy próbakéréssel ellenőrzi a kulcsot.
    - **Hangerő**: célszint (−11 LUFS alapértelmezett, −8 LUFS, egyedi érték), módszer (veszteségmentes alapértelmezett, pontos).
    - **Stílusok**: lista szerkesztése (név, szín, house-e, sorrend). Alapértékek: Afro House, Organic House, Melodic House, Tech House, Latin House, Unsorted.
    - **Hot cue-k**: a 8 slot neve és színe, alapértékek a dokumentáció 5. funkciójának táblázatából.
    - **Teljesítmény**: párhuzamos szálak száma (alapértelmezett a CPU magok száma mínusz 1).
    - **Rendszer**: a binárisok állapota (5. feladat), a Claude CLI elérhetősége (12. feladat), „Log mappa megnyitása” gomb.
4. A beállítások típusai a `src/shared/settings.ts` fájlban vannak, alapértékekkel. Mentés IPC-n keresztül, a main process validál.

**Elfogadási feltételek**
- A megadott kulcsok újraindítás után is megvannak.
- A `fixlibrary.db` fájlban (`sqlite3` paranccsal megnézve) egyik kulcs sem szerepel nyílt szövegként.
- Fejlesztéskor üres Keychain mellett a `.env.local` értékei működnek, a csomagolt appban nem.
- A „Teszt” gomb érvényes kulccsal zöld, érvénytelennel piros jelzést ad.
- Minden beállítás alapértéke megegyezik a dokumentációban rögzítettel.

**Tesztelés**
Vitest: mentés és visszaolvasás, a nyílt szöveg hiányának ellenőrzése az adatbázis fájlban. Playwright: a Settings oldal kitöltése és újraindítás utáni ellenőrzése.

**Függőségek és kockázatok**
- Előtte: 1. és 4. feladat. A „Rendszer” szekció teljes működéséhez az 5. és a 12. feladat.
- Kockázat: a `safeStorage` csak az `app.whenReady()` után használható, ezért a kulcsok olvasása az app indulása utánra kerül.

#### 7. Logolás és hibakezelési keret

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 7 | Logolás és hibakezelési keret | `src/main/services/logger.ts`, `python/fixlib_py/logging_setup.py` | Nincs log, és nincs egységes „kihagy és listáz” viselkedés | 3000 tracknél az elakadások nyom nélkül elvesznének | 🟠 | S |

**Jelenlegi állapot**
A dokumentáció szerint a log a `~/Library/Logs/FixLibrary` mappába kerül, és az elakadó track kimarad, a batch végén pedig listázódik. A 3. feladat után a Python stderr kimenete elérhető a bridge-ben.

**Probléma**
Egységes hibakezelés nélkül egy sérült fájl az egész batch-et leállíthatja, log nélkül pedig nem derül ki utólag, melyik lépés és miért hibázott.

**Megoldás**
1. `npm i electron-log`. A `src/main/services/logger.ts` beállítja, hogy a main process logja a `~/Library/Logs/FixLibrary/main.log` fájlba menjen, 10 MB-onként rotálva, 5 fájlt megtartva.
2. `python/fixlib_py/logging_setup.py`: `RotatingFileHandler` a `FIXLIB_LOG_DIR/python.log` fájlba, ugyanígy 10 MB × 5. A bridge a stderr sorait is a `main.log`-ba írja `[python]` előtaggal.
3. Egységes hibatípus a `src/shared/errors.ts` fájlban: `TrackError { trackId, stage, code, message }`. Kódok: `FILE_UNREADABLE`, `TIMEOUT`, `LOOKUP_FAILED`, `PYTHON_CRASHED`, `CLAUDE_FAILED`, `WRITE_FAILED`.
4. Lépésenkénti timeoutok a `src/shared/timeouts.ts` fájlban: lookup 30 s, BPM és key elemzés 120 s, energy elemzés 120 s, Demucs 15 perc, konverzió 120 s, normalizálás 120 s.
5. A pipeline (9. feladat) minden tracket és lépést `try/catch`-be tesz: hiba esetén a track a `batch_items.error` mezőbe kerül, és a batch folytatódik.
6. A batch preview-ban (11. feladat) egy „Hibák” fül listázza a kimaradt trackeket a lépéssel és az üzenettel, és egy „Újrapróbálás” gombbal újra lehet futtatni őket.

**Elfogadási feltételek**
- Egy szándékosan sérült MP3-at tartalmazó batch végigfut, a sérült track a „Hibák” fülön szerepel a lépés nevével és az üzenettel.
- A `main.log` és a `python.log` a `~/Library/Logs/FixLibrary` mappában jön létre, és rotálódik.
- Egy timeoutot túllépő lépés `TIMEOUT` kóddal kerül a hibák közé.

**Tesztelés**
Vitest: a pipeline hibakezelése egy mockolt, hibát dobó lépéssel. pytest: a log fájl létrejötte és rotációja. Kézzel: egy 0 bájtos `.mp3` fájl a teszt mappában.

**Függőségek és kockázatok**
- Előtte: 1. és 3. feladat. A „Hibák” fül a 11. feladattal készül el.
- Kockázat: túl rövid timeout esetén a lassú, de jó trackek is hibának számítanak. Ezért a timeout értékek a `src/shared/timeouts.ts` egy helyén módosíthatók.

### B. Könyvtár és pipeline keret

#### 8. Könyvtár beolvasás és kijelölés

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 8 | Könyvtár beolvasás és kijelölés | `src/main/pipeline/scanner.ts`, `src/renderer/pages/Library.tsx` | Az app nem látja a külső lemezen lévő trackeket, és nem lehet kijelölni belőlük | A teljes könyvtáras és a kijelölt trackes futtatás alapja | 🔴 | M |

**Jelenlegi állapot**
A dokumentáció szerint a könyvtár kb. 2700–3000 track egy külső lemezen, 90–95%-ban MP3, a többi WAV. Minden funkció futtatható a teljes könyvtáron vagy tetszőleges számú kijelölt trackeken. A 3., 4. és 7. feladat után van Python bridge, adatbázis és hibakezelés.

**Probléma**
Beolvasás nélkül az app nem tud a trackekről, kijelölés nélkül pedig csak a teljes könyvtárra lehetne futtatni, ami a teszteléshez és a 20-as próbákhoz használhatatlan.

**Megoldás**
1. `src/main/pipeline/scanner.ts`:
    - rekurzív bejárás `fs.promises.opendir`-rel a Settingsben megadott könyvtár gyökértől,
    - kiterjesztések: `.mp3`, `.wav`, `.aif`, `.aiff`,
    - kihagyja a rejtett fájlokat, a macOS által külső lemezen létrehozott `._*` AppleDouble fájlokat, valamint a `.Trashes`, `.Spotlight-V100`, `.fseventsd` mappákat és a backup mappát (10. feladat),
    - inkrementális: ha az útvonal, a méret és a módosítási idő változatlan, a track kimarad.
2. Az új vagy változott fájlok alap tagjeit és audio adatait (hossz, bitrate, sample rate) a Python `tags.read` metódusa olvassa be `mutagen`-nel, 50-es csoportokban. Az eredmény a `tracks` táblába kerül.
3. Újrabeolvasás: induláskor, ha a kötet csatlakoztatva van, és a Library oldalon a „Rescan” gombbal.
4. `src/renderer/pages/Library.tsx`:
    - virtualizált táblázat (`@tanstack/react-virtual`), hogy 3000 sor is akadás nélkül görgethető legyen,
    - oszlopok: cover thumbnail, artist, title, BPM, key, energy, stílus, formátum, és funkciónként egy állapot ikon (kész, hiányzik, hiba),
    - keresőmező, rendezés oszlop szerint, szűrés stílusra és állapotra,
    - kijelölés: kattintás, Shift + kattintás tartományra, Cmd + kattintás egyesével, Cmd + A mindre,
    - kijelölés számláló („20 track kijelölve”) és egy műveletsáv: funkció választó és „Futtatás a kijelöltekre” / „Futtatás a teljes könyvtárra” gomb.
5. A kijelölés a `src/renderer/stores/library-store.ts` Zustand store-ban van, a futtatáskor a track azonosítók IPC-n mennek a main processbe.
6. IPC csatornák a `src/main/ipc/library.ts` fájlban: `library:scan`, `library:list` (lapozva), `library:run`.

**Elfogadási feltételek**
- Egy 3000 fájlos mappa első beolvasása 5 percen belül lefut, a második, változatlan beolvasás 30 s-on belül.
- A `._*` fájlok és a rejtett mappák nem jelennek meg a listában.
- 20 track kijelölése után a számláló 20-at mutat, és a futtatás pontosan ezt a 20 tracket dolgozza fel.
- A 3000 soros lista görgetése akadásmentes.
- Ha a lemezt beolvasás közben leválasztják, a beolvasás hibaüzenettel leáll, az app nem omlik össze.

**Tesztelés**
- Vitest: a scanner ideiglenes mappán, `ffmpeg`-gel generált rövid MP3 és WAV fájlokkal, `._` fájlokkal és rejtett mappákkal, valamint az inkrementális újrabeolvasás.
- Playwright: kijelölés Shift és Cmd billentyűvel, a számláló ellenőrzése.
- Kézzel: a valódi külső lemezen a teljes könyvtár beolvasása.

**Függőségek és kockázatok**
- Előtte: 3., 4. és 7. feladat.
- Kockázat: a külső lemez fájlrendszere (exFAT esetén) lassabb a metaadat olvasásnál. Az 50-es csoportos olvasás ezt csökkenti.

#### 9. Pipeline orchestrator és job queue

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 9 | Pipeline orchestrator és job queue | `src/main/pipeline/orchestrator.ts`, `src/main/pipeline/queue.ts` | Nincs ütemezés, párhuzamosság, megszakítás és folytatás | A Demucs fél–egy napos futása csak így kezelhető | 🔴 | L |

**Jelenlegi állapot**
A dokumentáció szerint az elemzés a CPU magok száma mínusz 1 szálon fut, a Demucs egyszerre egy tracken, a hosszú futás a háttérben megy, megszakítható és folytatható, és minden változás csak batch preview jóváhagyás után kerül a fájlokba. A 8. feladat után vannak trackek és kijelölés.

**Probléma**
Központi ütemező nélkül minden funkció saját párhuzamosságot kezelne, a gép túlterhelődne, egy újraindítás után elveszne a félig kész munka, és a Mac alvó módba kapcsolva megszakíthatná a többórás futást.

**Megoldás**
1. Új migráció: `jobs` tábla (azonosító, batch, track, lépés, állapot: `queued`, `running`, `done`, `failed`, `skipped`, próbálkozások száma, időbélyegek).
2. Lépések egységes felülete a `src/main/pipeline/stages/` mappában, lépésenként egy fájl:
    `Stage { name, resource: 'cpu' | 'gpu' | 'network' | 'claude' | 'io', dependsOn: StageName[], run(ctx, track): Promise<StageResult> }`.
3. `src/main/pipeline/queue.ts`: erőforrásonként egy `p-queue` példány a saját korlátjával:
    - `cpu`: a Settings szerinti szálszám (alapértelmezett a CPU magok száma mínusz 1),
    - `gpu`: 1 (Demucs),
    - `network`: forrásonként külön rate limiterrel (a lookup szolgáltatások korlátait a 14. feladat rögzíti),
    - `claude`: 1 egyidejű hívás (a 20-as csoportosítást a 12. feladat végzi),
    - `io`: 2 (másolás, átnevezés a külső lemezen).
4. Függőségek: egy track egy lépése csak akkor indul, ha a `dependsOn` lépései készen vannak (például a fájlnév a BPM és key elemzésre és a lookupra vár). Induláskor a lépések gráfját ciklus ellenőrzés validálja.
5. Két fázis minden batch-ben:
    - **compute**: elemzés, lookup, javaslatok. A fájlokhoz nem nyúl, az eredmény a `batch_items` táblába és az elemzési cache-be kerül,
    - **apply**: csak a batch preview jóváhagyása után fut, a 10. feladat fájlműveleteivel.
6. Vezérlés: szünet (új jobot nem indít, a futók befejeződnek), folytatás, megszakítás (`AbortSignal` a TypeScript lépéseknek, `job.cancel` RPC hívás a Python oldalnak, 5 s-on belüli leállással).
7. Folytatás újraindítás után: induláskor a `running` állapotú jobok visszakerülnek `queued` állapotba, a `done` jobok nem futnak újra.
8. Alvás megakadályozása futás közben: `powerSaveBlocker.start('prevent-app-suspension')`, a futás végén `powerSaveBlocker.stop()`.
9. Haladás: `pipeline:progress` IPC esemény legfeljebb másodpercenként 4-szer, a `src/renderer/stores/pipeline-store.ts` tárolja. A felületen összesített százalék, lépésenkénti darabszám és a hátralévő idő becslése (mozgóátlag az utolsó 50 job idejéből).

**Elfogadási feltételek**
- Egy 200 tracket és kamu lépéseket tartalmazó futásban egyszerre soha nem fut több `cpu` job, mint a beállított szálszám, és soha nem fut 1-nél több `gpu` job.
- Az app futás közbeni bezárása és újraindítása után a futás folytatódik, és a már kész lépések nem futnak újra.
- A szünet, a folytatás és a megszakítás működik, a megszakítás 5 s-on belül leállítja a futó jobokat.
- Futás közben a Mac nem alszik el (`pmset -g assertions` mutatja a FixLibrary assertiont).
- A compute fázis után egyetlen fájl sem módosult (sha256 ellenőrzéssel).

**Tesztelés**
- Vitest: kamu lépésekkel és fake timerekkel a párhuzamossági korlátok, a függőségi sorrend, a ciklus felismerés, a szünet, a megszakítás és az újraindítás utáni folytatás.
- Playwright: futás indítása 20 tracken, szünet és folytatás a felületen.

**Függőségek és kockázatok**
- Előtte: 3., 4., 7. és 8. feladat.
- Kockázat: egy elakadt Python job blokkolhatja a `gpu` sort. Ezt a 7. feladat timeoutja (Demucs 15 perc) és a `job.cancel` hívás oldja fel.

#### 10. Fájlműveletek, backup és undo

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | Fájlműveletek, backup és undo | `src/main/services/file-ops.ts` | Nincs in-place / clean library switch, backup és „Undo last batch” | Hibás batch esetén elveszhet az eredeti fájl | 🔴 | M |

**Jelenlegi állapot**
A dokumentáció szerint a GUI-ban egy switch választ a helyben módosítás és a „clean library” mappába dolgozás között, helyben módosítás módban minden batch előtt mentés készül az érintett fájlokról, és van „Undo last batch” gomb. A 4. feladat után van `backups` tábla, a 9. feladat után van apply fázis.

**Probléma**
Ha egy batch rossz adatot ír (például hibás lookup), backup nélkül az eredeti fájlok elvesznek. Ha az app írás közben leáll, félig megírt, lejátszhatatlan fájl maradhat.

**Megoldás**
1. Műveletlista trackenként a `src/shared/file-ops.ts` típusaival: `move`, `writeTags`, `convert`, `replaceAudio` (normalizálás), `embedCover`. Az apply fázis ezeket sorban hajtja végre.
2. **Helyben módosítás mód**:
    - a track első művelete előtt az eredeti fájl a backup mappába másolódik: `<backup mappa>/<batch azonosító>/<track azonosító>.<kiterjesztés>`,
    - a backup mappa alapértéke a könyvtárral azonos lemezen egy `FixLibrary Backups` mappa, a Settingsben módosítható,
    - a másolás `fs.copyFile` `COPYFILE_FICLONE` kapcsolóval megy: APFS-en azonnali klón, más fájlrendszeren sima másolás,
    - a backup rekord a `backups` táblába kerül.
3. **Clean library mód**: az eredeti fájl soha nem változik. Az első művelet egy másolatot készít a clean library célmappába, minden további művelet ezen fut. A track aktuális útvonala a másolatra mutat, az eredeti útvonal megmarad.
4. Atomi írás: minden fájlt módosító lépés egy ideiglenes fájlba ír ugyanabban a mappában (`.<név>.fixlib-tmp`), és csak a sikeres írás után nevezi át a végleges névre. Induláskor az app törli a megmaradt `.fixlib-tmp` fájlokat.
5. Névütközés: ha a célnév már létezik, az app ` (2)`, ` (3)` utótagot ad, és a batch preview-ban figyelmeztetést mutat.
6. Helyellenőrzés: a batch előtt az app kiszámolja a backuphoz vagy a másolatokhoz szükséges helyet, és ha a lemezen nincs elég, a batch nem indul el. Az üzenet mutatja a szükséges és a szabad GB-ot.
7. **Undo last batch**:
    - helyben módosítás módban a backupok visszamásolódnak az eredeti útvonalra, a batch által létrehozott új fájlok törlődnek,
    - clean library módban a batch által létrehozott másolatok törlődnek,
    - az adatbázis rekordok a `batch_items.before_json` alapján visszaállnak.
8. Backup megőrzés: mivel csak az utolsó batch vonható vissza, egy új batch sikeres alkalmazása után az előző batch backupjai törlődnek. Így egy teljes könyvtáras batch backupja (kb. 25–35 GB) nem halmozódik.

**Elfogadási feltételek**
- Helyben módosítás módban egy 20 trackes batch után a backup mappában 20 eredeti fájl van.
- Undo után mind a 20 fájl bájtra azonos az eredetivel (sha256).
- Clean library módban a batch után az eredeti fájlok sha256 értéke változatlan.
- Ha az appot az apply fázis közben leállítják, nem marad félig megírt fájl, és a következő indításkor nincs `.fixlib-tmp` fájl.
- Kevés szabad helynél a batch nem indul el, és az üzenet mutatja a szükséges és a szabad GB-ot.

**Tesztelés**
Vitest ideiglenes mappákkal: mindkét mód, undo sha256 összevetéssel, névütközés, megszakított írás szimulálása (az ideiglenes fájl írása utáni folyamatleállítás), helyhiány szimulálása.

**Függőségek és kockázatok**
- Előtte: 4., 7. és 9. feladat. A `writeTags` és a `convert` művelet tényleges megvalósítása a 16. és a 18. feladatban készül el, addig a fájlműveletek átnevezéssel és áthelyezéssel tesztelhetők.
- Kockázat: exFAT lemezen nincs klónozás, ezért egy teljes könyvtáras batch backupja valódi másolás, ami a lemez sebességétől függően perceket vagy órákat vehet igénybe. A haladás ezért a 9. feladat progress felületén látszik.
- Kockázat: ha a lemezt az apply közben leválasztják, az apply leáll. A már alkalmazott trackek backupja megvan, így az undo ezekre működik.

#### 11. Batch preview keret

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 11 | Batch preview keret | `src/renderer/components/BatchPreviewTable.tsx`, `src/main/pipeline/preview.ts` | Nincs közös felület a változások megtekintésére, szerkesztésére és jóváhagyására | Az 1–4., 8. és 9. funkció mind ezen keresztül hagyatja jóvá a változásokat | 🔴 | L |

**Jelenlegi állapot**
A dokumentáció szerint a batch preview egy listában mutat minden tracket (régi név → új név, az adat forrása, a confidence, a figyelmeztetések), a sorok szerkeszthetők vagy kizárhatók, és a jóváhagyás egyben történik. Ugyanitt látszik a cover thumbnail, itt dönthető el az „Unsorted” trackek stílusa, itt írható felül az energy érték, itt választható ki a megtartandó duplikátum, a letöltéseknél itt látszik a célmappa, és itt jelennek meg a kihagyott trackek. A 9. feladat után a compute fázis eredménye a `batch_items` táblában van.

**Probléma**
Közös preview nélkül minden funkció saját jóváhagyó felületet kapna, eltérő viselkedéssel, és nem lenne biztosítva, hogy semmi nem kerül a fájlokba jóváhagyás nélkül.

**Megoldás**
1. `src/main/pipeline/preview.ts`: a `batch_items` sorokból preview sorokat épít mezőnként előtte és utána értékkel, eltérés jelöléssel, forrással (lookup, ID3, elemzés, Claude, kézi), confidence értékkel és figyelmeztetésekkel. Figyelmeztetés típusok: `LOW_CONFIDENCE` (70% alatt), `DUPLICATE`, `NAME_COLLISION`, `LOW_BITRATE`, `CANNOT_NORMALIZE`, `UNSORTED`.
2. `src/renderer/components/BatchPreviewTable.tsx`:
    - virtualizált táblázat,
    - batch típusonként konfigurálható oszlopkészlet (fájlnév, cover, stílus, energy, normalizálás, letöltés), az oszlopokat a 15., 19., 21., 24., 32. és 34. feladat adja hozzá,
    - eltérés kiemelés: a régi érték áthúzva, az új kiemelve,
    - közvetlenül szerkeszthető cellák: artist, title, mix, stílus (legördülő lista a Settings stílusaiból), energy (1–10),
    - kizárás checkbox soronként,
    - szűrők: „Csak figyelmeztetések”, „Bizonytalan (70% alatt)”, „Duplikátumok”, „Hibák”,
    - fülek: „Változások”, „Hibák” (7. feladat), „Duplikátumok” (17. feladat),
    - billentyűk: nyilak a mozgáshoz, szóköz a kizáráshoz, Enter a szerkesztéshez.
3. Szerkesztéskor a sor IPC-n újraszámolódik a main processben (például a cím javítása után az új fájlnév is frissül), az eredmény a `batch_items.after_json`-ba kerül.
4. Kézi felülírás védelme: a kézzel szerkesztett mezők a `tracks.locked_fields` JSON mezőbe kerülnek (új migráció). A későbbi automatikus futások ezeket a mezőket nem írják felül.
5. Jóváhagyás: a „Jóváhagyás” gomb egy megerősítő ablakot nyit (alkalmazandó trackek száma, kizártak száma, a mód: helyben vagy clean library), majd elindítja az apply fázist (10. feladat).

**Elfogadási feltételek**
- Egy 3000 soros preview akadás nélkül görgethető.
- Egy title kézi javítása után az új fájlnév azonnal frissül a sorban.
- A kizárt sorok fájljai a jóváhagyás után sha256 szerint változatlanok.
- Egy kézzel javított mezőt a következő automatikus futás nem ír felül.
- Minden szűrő pontosan a hozzá tartozó sorokat mutatja.
- Jóváhagyás nélkül egyetlen fájl sem változik.

**Tesztelés**
- Vitest: a preview sorok építése mockolt `batch_items` adatokból, a figyelmeztetések kiosztása, a `locked_fields` tiszteletben tartása.
- Playwright: 20 tracken szerkesztés, kizárás, szűrés és jóváhagyás.

**Függőségek és kockázatok**
- Előtte: 9. és 10. feladat.
- Kockázat: a sok funkció miatt a komponens túl nagyra nőhet. Ezért a batch típusonkénti oszlopkészletek külön fájlokban vannak (`src/renderer/components/preview-columns/`), a táblázat maga általános marad.

#### 12. Claude CLI service

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 12 | Claude CLI service | `src/main/services/claude-cli.ts` | Nincs `claude -p` hívás, JSON kimenet feldolgozás és 20-as batching | A stílus döntés, a hangulat és a prompt alapú generálás erre épül | 🔴 | M |

**Jelenlegi állapot**
A dokumentáció szerint az AI a gépre telepített és bejelentkezett Claude Code-on keresztül, headless módban (`claude -p`) fut, külön API kulcs nélkül, a hívások 20-as csoportokban mennek, és az előfizetés Max 20x.

**Probléma**
A Finderből indított Mac appok nem kapják meg a shell `PATH` változóját, ezért az app egyszerűen nem találná a `claude` parancsot. Ha a hívás a Claude Code alapértelmezett környezetében fut, betöltheti egy mappa `CLAUDE.md`-jét, MCP szervereit vagy hookjait, és eszközöket használhat. Strukturált kimenet nélkül a válaszok feldolgozása törékeny.

**Megoldás**
1. Megkeresés: induláskor `zsh -lc 'command -v claude'` (login shell, így a felhasználó `PATH`-ja érvényes), az útvonal a beállításokba kerül. A Settings oldalon kézzel is megadható.
2. Állapot ellenőrzés:
    - `claude --version` a verzióhoz,
    - `claude auth status`, ami 0-s kilépési kóddal jelzi a bejelentkezett állapotot,
    - a Settings „Rendszer” szekciója mutatja mindkettőt.
3. Hívás `spawn`-nal, egy semleges munkakönyvtárból (`userData/claude-workdir`, üres mappa), ezekkel a kapcsolókkal:
    - `-p`,
    - `--output-format stream-json --verbose`,
    - `--json-schema '<a feladat JSON sémája>'`,
    - `--tools ""` (beépített eszközök nélkül),
    - `--strict-mcp-config` (`--mcp-config` nélkül, így egyetlen MCP szerver sem töltődik be),
    - `--no-session-persistence`.
    A `--bare` mód nem használható, mert az nem az előfizetéses bejelentkezéssel fut.
4. Eredmény: a stream utolsó, `result` típusú üzenete. A strukturált válasz a `structured_output` mezőben van, amit a feladathoz tartozó `zod` séma még egyszer validál. Hibás válasz esetén egy újrapróbálás jön a validációs hibával kiegészített prompttal, utána `CLAUDE_FAILED` hiba.
5. Prompt sablonok a `src/main/services/claude-prompts/` mappában: `style.ts` (stílus döntés), `mood.ts` (hangulat), `playlist-prompt.ts` (szöveges prompt értelmezése), `online-recs.ts` (online ajánlás). Mindegyik exportálja a promptot, a JSON sémát és a `zod` sémát.
6. Csoportosítás: a service legfeljebb 20 elemet tesz egy hívásba, minden elem azonosítóval. A válaszból hiányzó azonosítók egyszer újra sorba kerülnek.
7. Limitek: ha a streamben `system/api_retry` esemény jön `rate_limit` hibával, vagy a hívás limit miatt hibával tér vissza, a `claude` erőforrás sor szünetel, a felületen „Claude usage limit elérve” üzenet jelenik meg, és az app 15 percenként újrapróbálja.
8. Timeout: 120 s hívásonként.

**Elfogadási feltételek**
- A Finderből indított csomagolt app megtalálja a `claude` parancsot, és a Settings mutatja a verziót és a bejelentkezett állapotot.
- Egy 45 trackes stílus kérés pontosan 3 hívásból áll (20, 20, 5), és mind a 45 eredmény feldolgozódik.
- Egy hibás JSON válasz után az újrapróbálás lefut, a második hiba után a track `CLAUDE_FAILED` kóddal a hibák közé kerül.
- Ha a `claude` nincs telepítve vagy nincs bejelentkezve, a Settings ezt mutatja telepítési és bejelentkezési útmutatóval, a Claude-ot nem igénylő funkciók pedig működnek.
- A hívás nem tölt be `CLAUDE.md`-t, MCP szervert és eszközt (a stream `system/init` üzenetében a tools és az MCP szerverek listája üres).

**Tesztelés**
- Vitest: egy kamu `claude` script a `PATH`-on, ami előre megírt streameket ad vissza (helyes válasz, hibás JSON, hiányzó azonosító, `rate_limit` esemény, nem bejelentkezett állapot).
- Kézzel: egy valódi hívás 5 trackkel a Settings „Teszt” gombjával.

**Függőségek és kockázatok**
- Előtte: 1., 6., 7. és 9. feladat.
- Kockázat: a Claude Code kapcsolói verziók között változhatnak. Ezért induláskor ellenőrizzük a verziót, és ha egy kapcsoló ismeretlen (a kilépési kód és a stderr alapján), a Settings frissítést javasol (`claude update`).
- Kockázat: a Max 20x előfizetés limitje a teljes könyvtáras futásnál elérhető. A 7. pont szünet és újrapróbálás logikája ezt kezeli, a futás nem vész el.

### C. Fájlnév és tag fixálás (1. funkció)

Ettől a témakörtől kell a kb. 50 trackes valódi teszt készlet (rossz nevű, WAV, YouTube-ról letöltött és remix trackekkel). Helye a `tests/fixtures/real/` mappa, ami a `.gitignore`-ban szerepel: zenei fájl nem kerülhet a nyilvános repóba. A repóba csak a generált, szintetikus tesztfájlok kerülnek (`tests/fixtures/synthetic/`).

#### 13. BPM és key elemzés

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 13 | BPM és key elemzés | `python/fixlib_py/analysis/bpm_key.py` | Nincs saját BPM és key meghatározás | A fájlnév, a playlist szabályok és az ajánlások erre épülnek | 🔴 | M |

**Jelenlegi állapot**
A dokumentáció szerint a BPM és a key elsődleges forrása a saját audio elemzés, az online adat csak ellenőrzésre szolgál. A key Camelot és zenei jelöléssel is szerepel (`8A Am`), a BPM egész számra kerekítve. A 2. feladat igazolta az Essentia működését, a 3. feladat után a Python hívható.

**Probléma**
Az online BPM és key adat sokszor hiányos vagy pontatlan. Saját elemzés nélkül a fájlnév, a harmonikus mix szabályok (7. funkció) és az ajánlások hibás adatra épülnének.

**Megoldás**
1. `python/fixlib_py/analysis/bpm_key.py`, RPC metódus: `analysis.bpm_key(path) → { bpm, bpmConfidence, keyName, scale, keyStrength, camelot, musical }`.
2. Betöltés: `essentia.standard.MonoLoader(filename=path, sampleRate=44100)`.
3. BPM: `RhythmExtractor2013(method="multifeature")`. Oktávhiba javítás: az érték egy beállítható tartományba kerül (alapérték 85–175 BPM), alatta duplázva, felette felezve. Így a house trackek 62 helyett 124-et kapnak, a 174-es drum and bass pedig marad. A tartomány a Settings „Elemzés” részébe kerül (a 6. feladat bővítése).
4. Key: `KeyExtractor(profileType="edma")`, ami az Essentia elektronikus tánczenére hangolt profilja.
5. Átváltás a `src/shared/keys.ts` táblázatával (a Python oldalon ugyanez a `python/fixlib_py/keys.py` fájlban), pitch class alapon, így az enharmonikus nevek (például `C#` és `Db`) ugyanarra a kódra képződnek:

    | Camelot | Zenei | Camelot | Zenei |
    | --- | --- | --- | --- |
    | 1A | Abm | 1B | B |
    | 2A | Ebm | 2B | F# |
    | 3A | Bbm | 3B | Db |
    | 4A | Fm | 4B | Ab |
    | 5A | Cm | 5B | Eb |
    | 6A | Gm | 6B | Bb |
    | 7A | Dm | 7B | F |
    | 8A | Am | 8B | C |
    | 9A | Em | 9B | G |
    | 10A | Bm | 10B | D |
    | 11A | F#m | 11B | A |
    | 12A | Dbm | 12B | E |

6. Az eredmény az `analyses` táblába kerül `bpm_key` típussal és elemző verzióval. A tracks táblába a kerekített BPM, a Camelot és a zenei key kerül. Ha az elemző verzió nem változott, a track nem elemződik újra.
7. A lépés a 9. feladat `cpu` erőforrásán fut, a 7. feladat 120 s-os timeoutjával.

**Elfogadási feltételek**
- A valódi teszt készleten a BPM a trackek legalább 95%-ánál ±1 BPM-en belül egyezik a Rekordbox által mért értékkel.
- A key a trackek legalább 75%-ánál egyezik a Rekordbox értékével. Az eltérések listája a tesztkimenetben megjelenik.
- Egy szintetikus, 62 BPM-re detektált 124 BPM-es ütem 124-et kap.
- Mind a 24 key helyesen képződik Camelot és zenei jelölésre.

**Tesztelés**
- pytest: a Camelot táblázat mind a 24 kulcsra, az oktávhiba javítás határértékei (84,9 / 85 / 175 / 175,1).
- pytest a valódi teszt készleten (csak helyben fut, CI-ban kimarad): a Rekordboxból exportált XML `AverageBpm` és `Tonality` értékeivel összevetve, a fenti arányokkal.

**Függőségek és kockázatok**
- Előtte: 2., 3. és 9. feladat. A valódi teszthez a teszt készlet.
- Kockázat: a key felismerés modális vagy atonális trackeken eltérhet. A batch preview-ban (11. feladat) a key cella kézzel javítható, és a javítás a `locked_fields` miatt megmarad.

#### 14. Fingerprint és online metadata lookup

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 14 | Fingerprint és online metadata lookup | `python/fixlib_py/fingerprint.py`, `src/main/services/lookup/` | Nincs AcoustID → MusicBrainz → Discogs → Beatport lánc, cache és confidence | A helyes artist, title, label és year forrása | 🔴 | L |

**Jelenlegi állapot**
A dokumentáció szerint a metadata forrása az online lookup: AcoustID fingerprint → MusicBrainz, majd Discogs, a Beatport scrapinggel kiegészítő forrás. Ha nincs online találat, a meglévő ID3 tagek az alapok. 70% alatti confidence esetén a track meg van jelölve a preview-ban. Az `fpcalc` (5. feladat), az API kulcsok (6. feladat) és a `lookup_cache` tábla (4. feladat) megvan.

**Probléma**
Rate limit kezelés nélkül a szolgáltatások letiltják a kéréseket. Cache nélkül minden újrafuttatás újra lekérdezi a 3000 tracket. Confidence nélkül egy rossz találat csendben felülírná a jó adatot.

**Megoldás**
1. Fingerprint: `python/fixlib_py/fingerprint.py`, RPC metódus `fingerprint.compute(path) → { fingerprint, duration }`, ami az `fpcalc -json -length 120 <fájl>` kimenetét adja vissza.
2. Kliensek a `src/main/services/lookup/` mappában, mindegyik saját rate limiterrel (`p-queue` `intervalCap` + `interval`) és egységes `User-Agent` fejléccel: `FixLibrary/<verzió> (https://github.com/tamaskk/fixlibrary)`.
    - `acoustid.ts`: `GET https://api.acoustid.org/v2/lookup?client=<ACOUSTID_API_KEY>&meta=recordings+releasegroups+compress&duration=<s>&fingerprint=<fp>`, legfeljebb 3 kérés másodpercenként.
    - `musicbrainz.ts`: `GET https://musicbrainz.org/ws/2/recording/<mbid>?inc=artist-credits+releases+labels&fmt=json`, illetve szöveges keresés `GET /ws/2/recording?query=...`, legfeljebb 1 kérés másodpercenként.
    - `discogs.ts`: `GET https://api.discogs.com/database/search?q=<artist title>&type=release`, `Authorization: Discogs key=<DISCOGS_CONSUMER_KEY>, secret=<DISCOGS_CONSUMER_SECRET>` fejléccel, legfeljebb 60 kérés percenként.
    - `beatport.ts`: a `https://www.beatport.com/search?q=<artist title>` oldal letöltése, a beágyazott `__NEXT_DATA__` JSON feldolgozása (artist, title, mix name, label, kiadási év, genre). Saját korlát: 1 kérés 2 másodpercenként. Ha a válasz szerkezete nem a várt, a Beatport forrás kimarad, és a lánc a többi forrással megy tovább.
3. Lánc trackenként (`src/main/services/lookup/chain.ts`):
    1. AcoustID a fingerprinttel. Ha van találat, a legjobb pontszámú recording MusicBrainz azonosítójával MusicBrainz lekérés.
    2. Ha nincs AcoustID találat, MusicBrainz szöveges keresés a meglévő tagekből vagy a fájlnévből kinyert artist és title alapján.
    3. Discogs keresés a label és year kiegészítésére, illetve ha az előző lépések nem adtak eredményt.
    4. Beatport keresés a mix name, a label és a genre kiegészítésére.
    5. Ha egyik forrás sem ad 70% feletti találatot, a meglévő ID3 tagek maradnak, „ID3” forrásjelöléssel.
4. Confidence (0–100%) a `src/main/services/lookup/confidence.ts` fájlban:
    - fingerprint találatnál: 0,6 × AcoustID pontszám + 0,3 × szöveges hasonlóság (a meglévő artist és title és a jelölt között, normalizált Levenshtein alapon) + 0,1 × hossz egyezés (1, ha a hosszkülönbség legfeljebb 3 s, egyébként 0),
    - szöveges keresésnél: 0,75 × szöveges hasonlóság + 0,25 × hossz egyezés.
    70% alatt a sor `LOW_CONFIDENCE` figyelmeztetést kap a batch preview-ban.
5. Mezőnkénti forrás: minden mező (artist, title, mix, album, label, year) mellé eltárolódik, melyik forrásból jött. A preview ezt mutatja.
6. Cache: minden válasz a `lookup_cache` táblába kerül forrással és lekérdezés kulccsal. Ugyanaz a kérés nem megy ki újra, csak a preview „Lookup frissítése” gombjával.
7. Az online BPM és key (Beatport) csak összevetésre szolgál: ha eltér a 13. feladat eredményétől (BPM-ben 2-nél többel, vagy más Camelot kód), a sor figyelmeztetést kap, de a saját elemzés marad.

**Elfogadási feltételek**
- A valódi teszt készleten a hibás nevű trackek legalább 80%-a 70% feletti confidence-szel helyes artist és title adatot kap (kézi ellenőrzés a preview-ban).
- Egy 200 trackes futás alatt egyik szolgáltatás sem ad 429-es vagy 503-as választ a rate limit miatt.
- Az újrafuttatás ugyanazon a trackeken nem indít új hálózati kérést (cache találat).
- Egy kitalált, nem létező track 70% alatti confidence-et vagy „ID3” forrást kap, és a preview megjelöli.
- Az API kulcsok egyetlen logsorban sem jelennek meg.

**Tesztelés**
- Vitest: a kliensek rögzített válaszokkal (`msw` mock szerverrel), a confidence képlet, a lánc sorrendje és a forrás kihagyása Beatport hibánál, a rate limiter időzítése fake timerekkel.
- Kézzel: a valódi teszt készlet lookupja és a találatok átnézése a preview-ban.

**Függőségek és kockázatok**
- Előtte: 3., 4., 5., 6. és 9. feladat.
- Kockázat: a Beatport scraping a Beatport felhasználási feltételeibe ütközhet, és az oldal szerkezetének változásakor működésképtelenné válik. Ezért kiegészítő forrás: kiesése nem állítja meg a láncot.
- Kockázat: a MusicBrainz 1 kérés per másodperces korlátja miatt a teljes könyvtár lookupja egy órát is igénybe vehet. A futás a háttérben megy, és a cache miatt csak egyszer kell kivárni.

#### 15. Név tisztítás és fájlnév formátum

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 15 | Név tisztítás és fájlnév formátum | `src/main/pipeline/naming.ts` | Nincs junk eltávolítás, feat. normalizálás és `[8A Am - 124 - E7]` formátum | Ez adja az egységes fájlneveket | 🔴 | M |

**Jelenlegi állapot**
A dokumentáció szerint a formátum `Artist feat. X - Title (Mix) [8A Am - 124 - E7].mp3`. Az ékezetek maradnak, csak a fájlrendszer által tiltott karakterek cserélődnek. Az „(Original Mix)” marad, minden más junk törlődik. A feat. előadó az artist mezőbe kerül. A 13. és 14. feladat adja a BPM-et, a key-t és a metaadatot.

**Probléma**
A letöltött és régi fájlok nevei vegyesek („01. Artist_-_Title [Official Video]”, „Title ft. X”). Egységes szabály nélkül a könyvtár nem kereshető és nem rendezhető.

**Megoldás**
1. Bemenet elemzés a `src/main/pipeline/naming.ts` fájlban, ha nincs lookup találat: a fájlnév felbontása a gyakori mintákra (`Artist - Title`, `01. Artist - Title`, `01 Artist - Title`, `Artist_-_Title`, aláhúzások szóközre cserélése).
2. Junk minták a `src/shared/junk-patterns.ts` fájlban (kis- és nagybetű független reguláris kifejezések), a teljes zárójeles résszel együtt törlődnek:
    - `(Official Video)`, `(Official Music Video)`, `(Official Audio)`, `(Official Visualizer)`, `(Visualizer)`, `(Lyric Video)`, `(Lyrics)`, `(Audio)`, `(Premiere)`,
    - `[HD]`, `[HQ]`, `[4K]`, `[320kbps]`, `[OUT NOW]`,
    - `(Free Download)`, `[Free Download]`, `[Free DL]`,
    - URL-ek (`http…`, `www.…`) és domain végű szavak (`.com`, `.net`, `.org`),
    - sorszám előtagok (`01.`, `01 -`, `A1 `).
    A `(Original Mix)` és minden más mix megnevezés (`(Extended Mix)`, `(X Remix)`, `(X Edit)`) megmarad, ez lesz a Mix rész.
3. feat. normalizálás: a `ft.`, `ft`, `feat`, `featuring`, `Feat.` változatok egységesen `feat.` alakra kerülnek, és ha a címben szerepelnek (például `Title (feat. X)`), az artist mező végére kerülnek: `Artist feat. X`.
4. Formázás: `{artist} - {title}{ (mix)} [{camelot} {musical} - {bpm}{ - E{energy}}].{kiterjesztés}`.
    - Ha az energy még nincs kiszámolva (külön futtatott 1. funkció), a ` - E{energy}` rész kimarad, és a 4. funkció futása után a fájlnév frissül.
5. Fájlrendszer szabályok:
    - a `/` és a `:` karakter `-` jelre cserélődik,
    - a kezdő pont és a vezető, záró szóközök törlődnek,
    - a név Unicode NFC normalizálást kap, így az ékezetes betűk összehasonlítása és megjelenítése egységes,
    - ha a név meghaladná a 255 bájtot (UTF-8), a title rész rövidül, a szögletes zárójeles rész mindig megmarad.
6. A Title tag a mix megnevezéssel együtt kerül írásra (`Title (Mix)`), az artist tag a feat. előadóval együtt.
7. A batch preview (11. feladat) fájlnév oszlopkészlete: régi név, új név, forrás, confidence, figyelmeztetések.

**Elfogadási feltételek**
- Az `01. Artist_-_Title (Official Video) [HD].mp3` bemenetből `Artist - Title [8A Am - 124 - E7].mp3` lesz (a megfelelő elemzési értékekkel).
- A `Title (feat. X)` címből `Artist feat. X - Title …` lesz.
- Az `(Original Mix)` és az `(X Remix)` megmarad, az összes junk minta eltűnik.
- Az ékezetes nevek (például `Ákos`) változatlanok maradnak, a `/` és a `:` kicserélődik.
- 255 bájt feletti nevek rövidülnek, a `[…]` rész megmarad.

**Tesztelés**
Vitest: táblázatos tesztek legalább 60 bemeneti névvel (a valódi teszt készlet neveiből és kitalált szélsőséges esetekből), mindegyikhez a várt kimenettel.

**Függőségek és kockázatok**
- Előtte: 13. és 14. feladat. Az energy rész a 24. feladat után kerül a nevekbe.
- Kockázat: egy túl általános junk minta érvényes címrészt törölhet (például egy „Audio” szót tartalmazó cím). Ezért a minták csak zárójelben vagy szögletes zárójelben álló teljes kifejezésre illeszkednek, és a preview-ban minden törlés látható.

#### 16. Tag írás

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 16 | Tag írás | `python/fixlib_py/tags.py` | Nincs ID3v2.3 írás az összes mezőre | A Rekordbox a tagekből olvassa az adatokat | 🔴 | S |

**Jelenlegi állapot**
A dokumentáció szerint a fájlnév mellett az összes tag is javul: artist, title, album, label, year, BPM, key, és később a genre (3. funkció), a comment (3–4. funkció) és a cover (2. funkció). A 10. feladat `writeTags` művelete erre a metódusra vár.

**Probléma**
Ha a tagek nem egyeznek a fájlnévvel, a Rekordbox a régi, hibás adatot mutatja. Rossz ID3 verzió vagy kódolás esetén az ékezetes betűk hibásan jelennek meg.

**Megoldás**
1. `python/fixlib_py/tags.py`, RPC metódusok: `tags.read(path)` és `tags.write(path, fields)`.
2. MP3: `mutagen.id3.ID3`, AIFF: `mutagen.aiff.AIFF` (ID3 chunk). Mentés mindkettőnél `save(v2_version=3, v1=0)`: ID3v2.3, a régi ID3v1 tag törlődik, hogy ne legyen két eltérő adatforrás.
3. Kódolás: UTF-16 (`encoding=1`), mert az ID3v2.3 nem ismeri az UTF-8-at, és csak így maradnak helyesek az ékezetes betűk.
4. Mezők:
    - `TPE1` artist, `TIT2` title (mixszel), `TALB` album, `TPUB` label, `TYER` year,
    - `TBPM` a kerekített BPM, `TKEY` a zenei key (például `Am`, az ID3 szabvány szerinti jelölés),
    - `TCON` az elsődleges stílus (22. feladat),
    - `COMM` (nyelv `eng`, üres leírás) az energy és a másodlagos stílus, például `E7 | Melodic House` (22. és 24. feladat),
    - `APIC` a cover (19. feladat).
5. Írás után a metódus visszaolvassa a tageket, és ha bármelyik mező eltér, `WRITE_FAILED` hibát ad.
6. Az írás a 10. feladat atomi írási szabályát követi: ideiglenes másolatba ír, és csak a sikeres visszaolvasás után cseréli le az eredetit.

**Elfogadási feltételek**
- Az írás után a `tags.read` minden mezőt pontosan visszaad, ékezetes értékekkel is.
- A fájlban csak ID3v2.3 tag van, ID3v1 nincs (`mid3v2 --list` vagy `mutagen` ellenőrzéssel).
- A Rekordboxba importálva az artist, title, album, label, year, BPM, genre és comment helyesen jelenik meg, ékezetekkel.

**Tesztelés**
- pytest: írás és visszaolvasás szintetikus MP3 és AIFF fájlon, ékezetes és speciális karakterekkel, ID3v1 eltávolítás ellenőrzése.
- Kézzel: 5 tagelt fájl importja a Rekordboxba, a mezők ellenőrzése.

**Függőségek és kockázatok**
- Előtte: 3. és 10. feladat.
- Kockázat: a már a Rekordboxban lévő trackeknél a Rekordbox nem olvassa újra automatikusan a tageket. A dokumentáció szerint ilyenkor „Reload Tag” kell, ezt a 27. feladat varázslója jelzi.

#### 17. Duplikátumok

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 17 | Duplikátumok | `src/main/pipeline/duplicates.ts` | Nincs duplikátum felismerés és „melyik maradjon” választás | Duplikátumok foglalják a helyet és zavarják az ajánlásokat | 🟠 | M |

**Jelenlegi állapot**
A dokumentáció szerint az app fingerprint és artist + title alapján felismeri a duplikátumokat és jelzi őket, automatikusan nem töröl, és a preview-ban kiválasztható, melyik példány maradjon. A 14. feladat után minden tracknek van AcoustID azonosítója és normalizált metaadata.

**Probléma**
A duplikátumok kétszer jelennek meg a playlistekben és az ajánlásokban, és ha két példány eltérő adatot kap, a könyvtár ellentmondásos lesz.

**Megoldás**
1. Felismerés a `src/main/pipeline/duplicates.ts` fájlban. Két track duplikátum, ha:
    - azonos az AcoustID recording azonosítójuk, és a mix megnevezésük is azonos, vagy
    - a normalizált artist + title + mix egyezik (kisbetű, ékezetek megtartva, felesleges szóközök nélkül), és a hosszkülönbség legfeljebb 2 s.
    Az eltérő mixek (például Extended és Radio Edit) nem duplikátumok.
2. Csoportok: a duplikátumok csoportokba rendeződnek, a csoport javasolt megtartandó példánya a legjobb minőségű: AIFF/WAV előbb, mint MP3; MP3-ak között a nagyobb bitrate; azonos minőségnél a hosszabb.
3. A batch preview „Duplikátumok” fülén csoportonként rádiógombbal választható a megtartandó példány.
4. A nem megtartott példányok a jóváhagyáskor egy `_Duplicates` mappába kerülnek a könyvtár gyökerében. Az app nem töröl zenei fájlt. A `_Duplicates` mappa kimarad a stílus mappákból, a Rekordbox XML-ből és a könyvtár beolvasásból, a törlést te végzed el, amikor átnézted.
5. A 34. feladat letöltés előtti ellenőrzése ugyanezt a felismerést használja.

**Elfogadási feltételek**
- Egy MP3 320 és egy AIFF példányból álló csoportban az AIFF a javasolt megtartandó.
- Egy track Extended és Radio Edit verziója nem kerül egy csoportba.
- Jóváhagyás után a nem megtartott példányok a `_Duplicates` mappában vannak, és nem szerepelnek a Library listában és az XML-ben.
- Egyetlen fájl sem törlődik.

**Tesztelés**
Vitest: a felismerés táblázatos esetekkel (azonos AcoustID, eltérő mix, hosszkülönbség a határon), a megtartási javaslat sorrendje, a mozgatás ideiglenes mappán.

**Függőségek és kockázatok**
- Előtte: 10., 11. és 14. feladat.
- Kockázat: AcoustID azonosító nélküli trackeknél csak a szöveges egyezés működik, ami eltérő írásmódnál (például `&` és `and`) nem talál. Ezért a szöveges normalizálás a `&` és az `and` jelet azonosnak veszi.

#### 18. WAV → AIFF konverzió

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 18 | WAV → AIFF konverzió | `python/fixlib_py/convert.py` | A WAV fájlok tagjei és covere nem működnek, és a 48 kHz feletti fájlok nem játszhatók le minden Pioneer lejátszón | CDJ, XDJ és DDJ lejátszhatóság | 🟠 | S |

**Jelenlegi állapot**
A dokumentáció szerint a WAV fájlok lossless módon AIFF-re konvertálódnak, a 48 kHz feletti mintavételezés 48 kHz-re csökken, a bitmélység marad, hogy minden Pioneer lejátszón (CDJ, XDJ, DDJ) lejátszható legyen. A könyvtár 5–10%-a WAV. Az `ffmpeg` az 5. feladatból megvan.

**Probléma**
A WAV fájlokban a tagek és a cover a Rekordboxban nem működnek rendesen, és a 48 kHz feletti fájlokat egyes Pioneer lejátszók nem játsszák le, ami élő fellépésen derülne ki.

**Megoldás**
1. `python/fixlib_py/convert.py`, RPC metódus: `convert.wav_to_aiff(src, dst)`.
2. Forrás vizsgálat `soundfile.info(src)`: sample rate és subtype (`PCM_16`, `PCM_24`, `PCM_32`, `FLOAT`, `DOUBLE`).
3. Kimeneti formátum:
    - `PCM_16` → `pcm_s16be`, `PCM_24` → `pcm_s24be`,
    - `PCM_32`, `FLOAT` és `DOUBLE` → `pcm_s24be` (a 24 bit a legnagyobb, amit minden Pioneer lejátszó kezel).
4. Mintavételezés: 44,1 és 48 kHz változatlan, 48 kHz felett `-ar 48000`.
5. Parancs: `ffmpeg -i <src> -map 0:a:0 -c:a <codec> [-ar 48000] -write_id3v2 1 <dst.aiff>`, a 10. feladat atomi írási szabályával.
6. A forrás meglévő tagjei (RIFF INFO vagy id3 chunk) a `tags.read` metódussal kiolvasva, a konverzió után a `tags.write` metódussal az AIFF-be kerülnek.
7. Ellenőrzés: a kimenet hossza legfeljebb 10 ms-mal tér el a forrásétól, a sample rate legfeljebb 48 kHz, a bitmélység 16 vagy 24.
8. Helyben módosítás módban az eredeti WAV a 10. feladat szerint a backup mappába kerül, majd törlődik a könyvtárból. Clean library módban az eredeti érintetlen marad.

**Elfogadási feltételek**
- Egy 44,1 kHz / 16 bites WAV-ból 44,1 kHz / 16 bites AIFF lesz, azonos hosszal.
- Egy 96 kHz / 24 bites WAV-ból 48 kHz / 24 bites AIFF lesz.
- Egy 32 bites float WAV-ból 24 bites AIFF lesz.
- A konvertált fájlban megvannak az eredeti tagek.
- A konvertált AIFF lejátszható Pioneer lejátszón USB-ről (ezt a 45. feladat éles próbája igazolja).

**Tesztelés**
- pytest: `ffmpeg`-gel generált szintetikus WAV-ok (16 bit / 44,1 kHz, 24 bit / 96 kHz, 32 bit float / 48 kHz), a kimenet sample rate, bitmélység és hossz ellenőrzése.
- Kézzel: a valódi teszt készlet WAV-jai a Rekordboxban.

**Függőségek és kockázatok**
- Előtte: 3., 5., 10. és 16. feladat.
- Kockázat: a kiterjesztés változása (`.wav` → `.aiff`) új útvonalat jelent a Rekordbox számára. Ezt a 27. feladat missing takarítása kezeli, ugyanúgy, mint az átnevezéseket.

### D. Cover kép (2. funkció)

#### 19. Cover lookup és beágyazás

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 19 | Cover lookup és beágyazás | `src/main/services/lookup/cover.ts`, `python/fixlib_py/tags.py` | Nincs forráslánc, méret szabály és 600×600-as beágyazás | A trackek többségénél nincs cover | 🟠 | M |

**Jelenlegi állapot**
A dokumentáció szerint minden track 600×600-as, fájlba ágyazott JPEG covert kap. Ahol nincs kép, kap egyet, a 300×300 alatti lecserélődik, a legalább 300×300-as marad. A források sorrendje: iTunes Search API, Cover Art Archive, Discogs, Beatport, a yt-dlp-vel letöltött trackeknél a YouTube thumbnail, végül a generált placeholder. A cover thumbnailként a batch preview-ban látszik. A 14. feladat után megvan a MusicBrainz release azonosító, a Discogs és a Beatport találat, a 16. feladat után az `APIC` írás.

**Probléma**
A Rekordboxban és a Pioneer lejátszókon a cover segít gyorsan megtalálni a tracket. Ha egy nem egyező kép kerül be (rossz találat), az félrevezet, ha pedig minden track nagy felbontású képet kap, a könyvtár feleslegesen nő.

**Megoldás**
1. Meglévő cover vizsgálata: a `tags.read` visszaadja a beágyazott `APIC` kép méretét (Pillow-val megnyitva). Döntés: nincs kép → keresés, 300×300 alatt → keresés és csere, legalább 300×300 → kimarad.
2. Forráslánc a `src/main/services/lookup/cover.ts` fájlban, az első megfelelő találatnál megáll:
    1. **iTunes Search API**: `GET https://itunes.apple.com/search?term=<artist title>&entity=song&limit=5`. Csak akkor fogadja el, ha a találat artist és title értéke legalább 0,8-es normalizált hasonlóságú a trackével. Az `artworkUrl100` URL-ben a `100x100bb` rész `600x600bb`-re cserélve adja a 600 px-es képet.
    2. **Cover Art Archive**: `GET https://coverartarchive.org/release/<MusicBrainz release azonosító>/front-1200`, csak ha a 14. feladat lookupja legalább 70%-os confidence-szel talált.
    3. **Discogs**: a 14. feladat Discogs találatának elsődleges képe (`images[0].uri`), a kulccsal hitelesített kéréssel.
    4. **Beatport**: a Beatport találat kiadásának képe a `__NEXT_DATA__` JSON-ból.
    5. **YouTube thumbnail**: csak a 34. feladat letöltéseinél, a letöltéskor elmentett thumbnail fájlból.
    6. Ha egyik sem adott képet, a 20. feladat placeholdere következik.
3. Képfeldolgozás a `python/fixlib_py/cover.py` fájlban, RPC metódus `cover.prepare(src) → jpegPath`:
    - ha a kép nem négyzetes (az oldalarány 2%-nál jobban eltér), középre vágás négyzetre,
    - átméretezés 600×600-ra Pillow `LANCZOS` szűrővel,
    - sRGB színtér, EXIF adatok nélkül, JPEG minőség 90.
4. Beágyazás a `tags.write` `cover` mezőjével: a meglévő `APIC` keretek törlődnek, az új `APIC` típusa 3 (front cover), MIME típusa `image/jpeg`.
5. A letöltött és feldolgozott képek a `userData/covers/` mappában cache-elődnek a forrás URL SHA-1 hash-e szerinti fájlnéven.
6. Batch preview oszlopkészlet (11. feladat): régi cover thumbnail, új cover thumbnail, forrás (iTunes, CAA, Discogs, Beatport, YouTube, placeholder, kézi).

**Elfogadási feltételek**
- A feldolgozás után minden tracknek van legalább 300×300-as beágyazott covere, és minden újonnan beágyazott cover pontosan 600×600-as JPEG.
- A már meglévő, legalább 300×300-as coverek bájtra azonosak maradnak.
- A 300×300 alatti coverek lecserélődnek.
- A valódi teszt készleten a preview-ban szúrópróbával ellenőrzött online coverek mind a helyes kiadáshoz tartoznak.
- A Rekordboxba importálva a cover megjelenik.

**Tesztelés**
- Vitest: a lánc sorrendje és a hasonlósági küszöb rögzített API válaszokkal (`msw`).
- pytest: a négyzetre vágás, az átméretezés, a JPEG kimenet, és az `APIC` csere szintetikus fájlokon.
- Kézzel: a valódi teszt készlet coverjeinek átnézése a preview-ban.

**Függőségek és kockázatok**
- Előtte: 11., 14. és 16. feladat. A YouTube thumbnail ág a 34. feladattal, a placeholder a 20. feladattal készül el.
- Kockázat: az iTunes keresés szöveges egyezésre épül, ezért azonos nevű, de más kiadásból való képet adhat. A 0,8-as hasonlósági küszöb és a preview szúrópróbája ezt szűri.

#### 20. Placeholder és kézi csere

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 20 | Placeholder és kézi csere | `python/fixlib_py/placeholder.py`, `src/renderer/components/CoverDrop.tsx` | Nincs generált kép találat nélkül, és nincs drag & drop | Minden track kapjon képet, és legyen kézi felülírás | 🟡 | S |

**Jelenlegi állapot**
A dokumentáció szerint ha nincs találat, az app placeholdert generál a track stílusához automatikusan rendelt, a beállításokban módosítható háttérszínnel, rajta az artisttal és a title-lel. A placeholder generálása a stílus besorolás után fut. Drag & drop-pal bármelyik tracknek saját kép adható. A 6. feladat után a `styles` táblában megvannak a színek.

**Probléma**
Placeholder nélkül a találat nélküli trackek kép nélkül maradnának, kézi csere nélkül pedig egy rossz online képet nem lehetne javítani.

**Megoldás**
1. `python/fixlib_py/placeholder.py`, RPC metódus: `cover.placeholder(artist, title, colorHex) → jpegPath`.
    - 600×600-as kép a stílus színével,
    - betűtípus: az appba csomagolt Inter (SIL Open Font License, `python/fixlib_py/assets/fonts/`), ami tartalmazza a magyar ékezetes betűket,
    - felül az artist, középen a title, automatikusan csökkenő betűmérettel és legfeljebb 3 soros tördeléssel, hogy elférjen,
    - a szöveg színe a háttér relatív fényessége (WCAG képlet) alapján fehér vagy majdnem fekete, a nagyobb kontraszt szerint.
2. Sorrend a pipeline-ban (9. feladat): a `cover_placeholder` lépés `dependsOn` mezője a `style` lépés, és csak akkor fut, ha a 19. feladat lánca nem talált képet.
3. Ha a track stílusa „Unsorted”, az „Unsorted” stílus színe kerül a placeholderre. Ha a stílust később kézzel módosítod, a placeholder az új színnel újragenerálódik (csak placeholder forrású covernél).
4. `src/renderer/components/CoverDrop.tsx`: drag & drop terület a preview soraiban és a Library track részlet paneljén. Elfogad JPG, PNG és WebP fájlt.
    - A fájl útvonalát a preload a `webUtils.getPathForFile(file)` hívással adja át, mert a sandboxolt rendererben a fájl útvonala közvetlenül nem érhető el.
    - A kép ugyanazon a feldolgozáson megy át, mint az online coverek (19. feladat 3. pont), a forrása „kézi”, és a cover mező a `locked_fields`-be kerül, így automatikus futás nem írja felül.

**Elfogadási feltételek**
- Egy találat nélküli track 600×600-as placeholdert kap a stílusa színével, olvasható artist és title felirattal, ékezetekkel is.
- Egy nagyon hosszú title is elfér legfeljebb 3 sorban.
- Világos és sötét háttérszínnél is olvasható a szöveg.
- Egy behúzott kép a következő jóváhagyás után beágyazódik, és egy újabb automatikus futás nem cseréli le.

**Tesztelés**
- pytest: placeholder generálás rövid, hosszú és ékezetes szöveggel, világos (`#F5F5F5`) és sötét (`#111111`) háttérrel, a kép méretének és a szövegszín választásának ellenőrzése.
- Playwright: egy kép behúzása a preview egy sorára.

**Függőségek és kockázatok**
- Előtte: 6., 19. és 21. feladat.
- Kockázat: nincs jelentős kockázat. Az Inter licence megengedi a csomagolást az appba.

### E. Stílus szerinti rendezés (3. funkció)

#### 21. Stílus besorolás

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 21 | Stílus besorolás | `src/main/pipeline/style.ts` | Nincs genre alapú, remixet figyelembe vevő, Claude által hozott döntés | A mappák, a placeholder színek, az energy és a playlistek erre épülnek | 🔴 | M |

**Jelenlegi állapot**
A dokumentáció szerint a house stílusok Afro House, Organic House, Melodic House, Tech House és Latin House (a lista szerkeszthető), a nem house trackek saját stílus mappát kapnak, a bizonytalanok „Unsorted”-ba kerülnek. A besorolás alapja az online genre (Beatport, Discogs), a cím és a mix név, remixnél a remix verzió és a remixer stílusa, a végső döntést a Claude CLI hozza. Az elsődleges stílus dönti el a mappát, a másodlagos a comment tagbe kerül. A 12. és 14. feladat után megvan a Claude service és az online genre adat.

**Probléma**
Döntési szabályok nélkül a nem house stílusok nevei szétszóródnak (például „Hip Hop”, „Hip-Hop”, „HipHop” három külön mappa), a remixek az eredeti track stílusát kapnák, és a bizonytalan esetek csendben rossz mappába kerülnének.

**Megoldás**
1. Bemenet trackenként a `src/main/pipeline/style.ts` fájlban: azonosító, artist, title, mix, a mixből kinyert remixer neve, a Beatport genre, a Discogs genre és style lista, a meglévő ID3 genre, a BPM és a label.
2. Remix kezelés: ha a mix megnevezés `Remix` vagy `Edit` szóra végződik, a 14. feladat lookupja a mix névvel együtt keres, így a Beatport és a Discogs genre a remix kiadásra vonatkozik. A Claude prompt külön mezőben kapja a remixer nevét azzal az utasítással, hogy a remix verzió stílusa döntsön.
3. Claude hívás a 12. feladat service-én keresztül, 20 track hívásonként, a `src/main/services/claude-prompts/style.ts` sablonnal. A prompt tartalmazza:
    - a Settings stílus listáját (a house stílusokat és a korábban már létrehozott nem house stílusokat),
    - az utasítást, hogy elsősorban a meglévő stílusokból válasszon, és új stílust csak nem house tracknél, rövid, általánosan használt genre névvel javasoljon.
    JSON séma trackenként: `{ id, primary, secondary | null, confidence (0–100), isNewStyle }`.
4. Döntési szabályok:
    - ha a confidence 70 alatt van, vagy a tracknek se online genre, se ID3 genre adata nincs, az elsődleges stílus „Unsorted” lesz, `UNSORTED` figyelmeztetéssel,
    - egy új stílus javaslat a preview-ban „Új stílus: <név>” jelöléssel jelenik meg, és csak jóváhagyáskor kerül a `styles` táblába, automatikusan kiosztott színnel (a 20. feladat placeholderéhez),
    - a stílus nevek összevetése kis- és nagybetű, szóköz és kötőjel független, így egy „Tech-House” javaslat a meglévő „Tech House”-ra képződik.
5. Az eredmény a `tracks` tábla elsődleges és másodlagos stílus mezőjébe kerül, a `locked_fields` tiszteletben tartásával.
6. Batch preview oszlopkészlet (11. feladat): régi genre, új elsődleges stílus (legördülő lista), másodlagos stílus, confidence, a felhasznált források.

**Elfogadási feltételek**
- A valódi teszt készleten az elsődleges stílus legalább 85%-ban egyezik a te besorolásoddal. Ehhez a teszt készlet mellé egy `tests/fixtures/real/styles.csv` kell (fájlnév, elsődleges stílus).
- Egy remix a remix verzió stílusát kapja, nem az eredetiét (legalább 3 remix a teszt készletben).
- Egy online és ID3 genre nélküli track „Unsorted”-ba kerül.
- Egy új stílus csak a preview jóváhagyása után jelenik meg a Settings stílus listájában.
- Egy „Tech-House” javaslatból nem jön létre új stílus.

**Tesztelés**
- Vitest: a döntési szabályok és a névösszevetés a kamu `claude` scripttel (12. feladat), előre megírt válaszokkal.
- Kézzel: a valódi teszt készlet besorolása, összevetve a `styles.csv` fájllal egy `scripts/eval-styles.ts` scripttel, ami kiírja az egyezési arányt és az eltéréseket.

**Függőségek és kockázatok**
- Előtte: 11., 12. és 14. feladat.
- Kockázat: a Claude a modell tudásának dátuma után megjelent artistokat nem ismeri. Ilyenkor az online genre adat dönt, ennek hiányában a track „Unsorted”-ba kerül, és a preview-ban kézzel dönthető el.

#### 22. Mappába rendezés és tagek

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 22 | Mappába rendezés és tagek | `src/main/pipeline/organize.ts` | Nincs fizikai mappastruktúra, genre és comment tag | Ez a könyvtár új felépítése | 🔴 | S |

**Jelenlegi állapot**
A dokumentáció szerint a könyvtár stílusonként egy mappába rendeződik (`Library/Afro House/`, …, `Library/Unsorted/`), az elsődleges stílus az ID3 genre mezőbe, a másodlagos a comment mezőbe kerül, és a később hozzáadott trackek automatikusan ugyanígy sorolódnak be. A 10. feladat után megvannak a fájlműveletek, a 21. feladat után a stílusok.

**Probléma**
Fizikai rendezés nélkül a stílus csak adatbázis adat maradna, és a Rekordboxban, valamint a Finderben is a régi, vegyes mappaszerkezet látszana.

**Megoldás**
1. `src/main/pipeline/organize.ts`: minden jóváhagyott tracknél a célútvonal `<gyökér>/<elsődleges stílus>/<új fájlnév>`, ahol a gyökér helyben módosítás módban a könyvtár gyökér, clean library módban a clean library célmappa.
2. A mappanév a stílus neve a 15. feladat fájlrendszer szabályaival (tiltott karakterek cseréje, NFC normalizálás).
3. Az áthelyezés a 10. feladat `move` műveletével történik, backuppal, atomi lépésekkel és névütközés kezeléssel.
4. Tagek a 16. feladat `writeTags` műveletével:
    - `TCON`: az elsődleges stílus,
    - `COMM`: a meglévő részek ` | ` jellel összefűzve, ebben a sorrendben: `E<energy>` (ha már van), a másodlagos stílus (ha van). Például `E7 | Melodic House`, `E7`, vagy `Melodic House`.
5. Takarítás: helyben módosítás módban az áthelyezések után a könyvtár gyökér alatt kiürült régi mappák törlődnek, ha csak `.DS_Store` fájlt tartalmaznak. A stílus mappák, a `_Duplicates` és a backup mappa soha nem törlődik.
6. Az új trackek automatikus besorolását a 35. feladat Inbox feldolgozása indítja ugyanezzel a lépéssel.

**Elfogadási feltételek**
- Jóváhagyás után minden track a `<gyökér>/<elsődleges stílus>/` mappában van, a fájlnév a 15. feladat formátuma szerinti.
- A `TCON` tag az elsődleges stílus, a `COMM` tag a fenti szabály szerinti.
- A kiürült régi mappák eltűnnek, a nem üres mappák (például ismeretlen fájlokkal) megmaradnak.
- Undo után minden fájl az eredeti mappájában van, az eredeti tagekkel (10. feladat).

**Tesztelés**
Vitest ideiglenes mappán: áthelyezés mindkét módban, a comment összefűzés minden esete, az üres mappák takarítása, undo.

**Függőségek és kockázatok**
- Előtte: 10., 15., 16. és 21. feladat.
- Kockázat: a `COMM` mező felülírása törli a trackekben korábban tárolt más commenteket (például egy másik szoftver kulcsjelölését). Ez a dokumentáció szerinti szándékos működés, a régi érték a batch preview-ban látszik, és undo-val visszaállítható.

### F. Energy level (4. funkció)

#### 23. Energy feature-ök

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 23 | Energy feature-ök | `python/fixlib_py/analysis/energy.py` | Nincs loudness, percussive energy, onset density és spectral elemzés | Az energy érték nyersanyaga | 🟠 | M |

**Jelenlegi állapot**
A dokumentáció szerint az energy Essentia feature-ökből számolódik: loudness, BPM, percussive energy, onset density és spectral jellemzők, egy értékkel a teljes trackre. A BPM a 13. feladatból megvan.

**Probléma**
Ha a feature-ök a teljes track átlagából számolódnak, a hosszú intro és outro lehúzza az értéket, így egy erős dropokkal rendelkező track is alacsony energiát kapna.

**Megoldás**
1. `python/fixlib_py/analysis/energy.py`, RPC metódus: `analysis.energy_features(path) → { features: Record<string, number>, version }`.
2. A track 10 másodperces ablakokra bontva elemződik, és minden ablak-feature 75. percentilise kerül az eredménybe. Így a csúcsrészek (dropok) határozzák meg az értéket, nem az intro és az outro.
3. Feature-ök:
    - integrated loudness (LUFS) a teljes trackre, `essentia.standard.LoudnessEBUR128`,
    - RMS energia ablakonként, `essentia.standard.RMS`,
    - percussive arány ablakonként: a percussive rész RMS-e osztva a teljes RMS-sel, `librosa.effects.hpss` szétválasztással (a `librosa` új függőség a `pyproject.toml`-ban),
    - onset density (onset per másodperc), `essentia.standard.OnsetRate`,
    - spectral centroid és spectral flux ablakonként, `essentia.standard.Centroid` és `essentia.standard.Flux`,
    - mélyfrekvenciás arány: a 20–150 Hz sáv energiája a teljes energiához képest, `essentia.standard.EnergyBand`,
    - a BPM a 13. feladat eredményéből.
4. Az eredmény az `analyses` táblába kerül `energy_features` típussal és elemző verzióval.
5. A lépés a 9. feladat `cpu` erőforrásán fut, 120 s-os timeouttal.

**Elfogadási feltételek**
- Minden feature minden trackre véges szám (nincs `NaN` vagy végtelen).
- Egy track, aminek az elejére 2 perc csend került, legfeljebb 5%-kal eltérő feature értékeket kap, mint az eredeti (a percentilis módszer miatt).
- Egy track elemzése az M1 gépen legfeljebb 20 s.

**Tesztelés**
pytest: szintetikus jelek (csak lábdob, lábdob és basszus, csend, fehér zaj) feature értékeinek iránya (például a lábdob és basszus magasabb percussive arányt és mélyfrekvenciás arányt ad, mint a fehér zaj), a csend hozzáadásának hatása, futásidő mérés.

**Függőségek és kockázatok**
- Előtte: 2., 3., 9. és 13. feladat.
- Kockázat: a `librosa` HPSS lassú lehet hosszú trackeken. Ezért a HPSS 22 050 Hz-re csökkentett mono jelen fut.

#### 24. Kalibráció és 1–10 skála

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 24 | Kalibráció és 1–10 skála | `src/renderer/pages/Calibration.tsx`, `src/main/pipeline/energy.ts` | Nincs kalibrációs felület és stílusonkénti normalizálás | Az érték csak a saját érzésedre kalibrálva használható | 🟠 | M |

**Jelenlegi állapot**
A dokumentáció szerint az energy 1–10 közötti, stíluson belül értendő (relatív) érték. Stílusonként néhány tracket (összesen kb. 20–30) kézzel besorolsz, és az app ehhez igazítja a skálát. Az érték a comment mezőbe (`E7 | Melodic House`) és a fájlnévbe (`[8A Am - 124 - E7]`) kerül, és a batch preview-ban felülírható. A 23. feladat után megvannak a feature-ök, a 21. feladat után a stílusok.

**Probléma**
Egy fix képlet nem a te érzésedet követi, és stílusonkénti normalizálás nélkül egy Organic House track soha nem kaphatna magas értéket egy Tech House mellett, ami ellentmond a dokumentáció relatív skálájának.

**Megoldás**
1. Kalibrációs minta kiválasztása a `src/main/pipeline/energy.ts` fájlban: stílusonként legalább 3, legfeljebb 5 track, összesen legfeljebb 30. A trackek a feature-ökből számolt egyszerű nyers pontszám (a standardizált feature-ök átlaga) szerint a stílus alsó, középső és felső tartományából kerülnek ki, hogy a minta lefedje a skálát. A 10 tracknél kisebb stílusok közös mintában vannak.
2. `src/renderer/pages/Calibration.tsx`:
    - trackenként egy egyszerű lejátszó (HTML `<audio>` elem a 30. feladat `fixlib-audio` protokollján) és egy 1–10-es csúszka,
    - stílusonként csoportosítva, haladásjelzővel („18 / 27 besorolva”),
    - a besorolások az `energy_calibration` táblába kerülnek.
3. Modell a Python oldalon, `python/fixlib_py/analysis/energy_model.py`, RPC metódusok `energy.fit(samples)` és `energy.predict(features[])`:
    - ridge regresszió (`numpy`-val, zárt képlettel) a standardizált feature-ökből a te értékeidre,
    - a modell együtthatói és a standardizálás paraméterei a `settings` táblába kerülnek.
4. Stílusonkénti skála: minden track nyers predikciója a saját stílusán belül az 5. és 95. percentilis közé normalizálódik, és 1–10 közötti egész számra kerekítődik (a széleken levágva). A 10 tracknél kisebb stílusok és az „Unsorted” a teljes könyvtár eloszlásán normalizálódnak.
5. Pontosság kijelzés: a kalibráció után az oldal kiírja a leave-one-out átlagos abszolút hibát a te értékeidhez képest („Átlagos eltérés: 0,9”).
6. Újrakalibrálás bármikor indítható. Az új trackek a tárolt modellel és a stílus percentilisekkel kapnak értéket, a percentilisek minden teljes futáskor újraszámolódnak.
7. Kimenet: a `tracks.energy` mezőbe, a `locked_fields` tiszteletben tartásával. Az apply fázisban a fájlnév (15. feladat) és a `COMM` tag (22. feladat) frissül.
8. Batch preview oszlopkészlet (11. feladat): régi energy, új energy (szerkeszthető 1–10), stílus.

**Elfogadási feltételek**
- A kalibrációs minta minden legalább 10 trackes stílusból legalább 3 tracket tartalmaz, összesen legfeljebb 30-at.
- A leave-one-out átlagos abszolút hiba a kalibrációs mintán legfeljebb 1,5.
- Minden legalább 10 trackes stílusban az értékek kihasználják a skálát: a legkisebb érték legfeljebb 3, a legnagyobb legalább 8.
- A kézzel felülírt energy értéket egy újabb futás nem írja felül.
- A fájlnévben és a `COMM` tagben az energy a jóváhagyás után megjelenik.

**Tesztelés**
- pytest: a ridge regresszió egy ismert, szintetikus összefüggésen, a stílusonkénti normalizálás és a levágás.
- Vitest: a mintaválasztás szabályai.
- Kézzel: a kalibráció elvégzése a valódi teszt készleten, utána szúrópróba: 10 track meghallgatása és az érték összevetése az érzéseddel.

**Függőségek és kockázatok**
- Előtte: 11., 15., 21., 22., 23. és 30. feladat (a lejátszó a 30. feladat `fixlib-audio` protokollját használja).
- Kockázat: 20–30 minta kevés lehet egy jól általánosító modellhez. A ridge regresszió erős regularizációval kevés mintán is stabil, és ha a hiba nagy, a kalibráció bármikor bővíthető további trackekkel.

### G. Rekordbox integráció

Az XML formátum leírása a [pyrekordbox dokumentációja](https://pyrekordbox.readthedocs.io/en/stable/formats/xml.html) szerinti. Az XML import korlátját (a már a collectionben lévő trackek csak a trackek kijelölésével írhatók felül) a [rekordcloud leírása](https://rekord.cloud/blog/the-rekordbox-xml-import-bug), a Rekordbox oldali beállításokat a [Mixed In Key Rekordbox workflow-ja](https://mixedinkey.com/workflows/export-cue-points-to-rekordbox/) rögzíti.

#### 25. Rekordbox XML író

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 25 | Rekordbox XML író | `src/main/services/rekordbox-xml.ts` | Nincs XML export a collectionnel, playlist folderekkel és hot cue-kkal | Ez az egyetlen út a Rekordboxba | 🔴 | M |

**Jelenlegi állapot**
A dokumentáció szerint az app a Rekordbox XML-en keresztül kommunikál, a `master.db`-hez nem nyúl. A stílus mappastruktúrából playlist folder struktúra jön létre, a playlistek külön „Playlists” folderbe kerülnek, a hot cue-k a 8 slotos séma szerint. Az XML helye a beállításokban egy fix mappa.

**Probléma**
XML író nélkül egyik eredmény sem jut el a Rekordboxba. Hibás `Location` kódolás esetén a Rekordbox nem találja a fájlokat, hibás szerkezet esetén az import csendben elhagyja a playlisteket.

**Megoldás**
1. `npm i fast-xml-parser` (íráshoz és olvasáshoz is).
2. `writeRekordboxXml(tracks, playlists, options) → string`, a kimenet szerkezete:
    - `<?xml version="1.0" encoding="UTF-8"?>`, gyökér `DJ_PLAYLISTS Version="1.0.0"`, `PRODUCT Name="FixLibrary" Version="<app verzió>" Company="FixLibrary"`,
    - `COLLECTION Entries="<n>"`, trackenként `TRACK`: `TrackID` (az adatbázis track azonosítója, stabil egész szám), `Name` (title a mixszel), `Artist`, `Album`, `Genre` (elsődleges stílus), `Label`, `Mix`, `Year`, `Comments` (a `COMM` tartalma), `Kind` (`MP3 File` vagy `AIFF File`), `Size`, `TotalTime` (másodperc), `BitRate`, `SampleRate`, `AverageBpm`, `Tonality` (zenei key, például `Am`), `Location`.
    - `Location`: `file://localhost` + az abszolút útvonal URL-kódolva (a Node `pathToFileURL` kimenetéből a `file://` előtag cseréjével), így a szóközök `%20`, az ékezetes betűk UTF-8 százalékkódolással szerepelnek.
    - ha a track a 26. feladat exportjából beatgriddel rendelkezik: a `TEMPO` elemek (`Inizio`, `Bpm`, `Metro`, `Battito`) változatlanul visszaírva, hogy az import ne írja felül a Rekordbox gridjét,
    - hot cue-k (29. feladat): `POSITION_MARK Name="<név>" Type="0" Start="<másodperc>" Num="<0–7>" Red="…" Green="…" Blue="…"`, ahol a `Num` 0 = A … 7 = H, a szín a Settings hot cue színe.
    - `PLAYLISTS`: `NODE Type="0" Name="ROOT"`, alatta stílusonként egy `NODE Type="1" KeyType="0"` playlist a stílus nevével (a track `Key` értéke a `TrackID`), és egy `NODE Type="0" Name="Playlists"` folder a 6–7. funkció playlistjeivel.
3. Az XML a Settingsben megadott fix mappába íródik (alapérték `~/Documents/FixLibrary/fixlibrary.xml`), atomi írással. A mappa ne legyen külső lemezen vagy felhőben szinkronizált mappában, mert a Mixed In Key leírása szerint ez importhibákat okozhat. A Settings figyelmeztet, ha ilyen helyet adsz meg.
4. A `_Duplicates` mappa trackjei és az offline trackek kimaradnak.

**Elfogadási feltételek**
- A generált XML-t a Rekordbox 7.2.7 hiba nélkül betölti a rekordbox xml nézetbe, és minden track, playlist és a Playlists folder megjelenik.
- Ékezetes és szóközös útvonalú trackek is megtalálhatók a Rekordboxban (nem „missing”).
- Az import után a hot cue-k a helyükön vannak, a megfelelő névvel és színnel.
- Az import után a Rekordbox beatgridje változatlan.

**Tesztelés**
- Vitest: snapshot teszt egy 5 trackes XML-re, `Location` kódolás ékezetes és speciális karakteres útvonalakkal, a playlist szerkezet.
- Kézzel: import a Rekordbox 7.2.7-be 5 trackkel, a fenti feltételek ellenőrzése.

**Függőségek és kockázatok**
- Előtte: 4., 21. és 22. feladat. A hot cue rész a 29., a playlist rész a 37. és 39. feladattal töltődik fel, a `TEMPO` rész a 26. feladattal.
- Kockázat: a `POSITION_MARK` `Red`, `Green`, `Blue` attribútumai nem szerepelnek a pyrekordbox formátumleírásában, de a Rekordbox saját exportja ezekkel adja a hot cue színeket. Ha az import a színt mégsem veszi át, a cue-k szín nélkül, de helyesen kerülnek be, és ez a kézi teszten azonnal kiderül.

#### 26. Rekordbox XML olvasó

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 26 | Rekordbox XML olvasó | `src/main/services/rekordbox-xml.ts` | Nincs beatgrid és track beolvasás a Rekordbox exportjából | A cue-k a Rekordbox gridjére épülnek | 🔴 | S |

**Jelenlegi állapot**
A dokumentáció szerint a cue folyamat a Rekordbox elemzésével kezdődik, a könyvtár XML-be exportálódik a Rekordboxból, és az app ebből veszi a beatgridet. Az export helye a beállításokban egy fix mappa.

**Probléma**
Ha az app saját gridet számolna, a cue-k eltérhetnének a Rekordbox gridjétől, és a lejátszón nem az ütemre esnének.

**Megoldás**
1. `readRekordboxXml(path) → { tracks: Map<location, RbTrack>, playlists }` a `fast-xml-parser`-rel.
2. `RbTrack`: `TrackID`, `Location` (dekódolva abszolút útvonallá), `AverageBpm`, `Tonality`, `TotalTime`, a `TEMPO` elemek listája és a meglévő `POSITION_MARK` elemek.
3. Párosítás az app trackjeivel az abszolút útvonal alapján (NFC normalizálva mindkét oldalon).
4. A `TEMPO` lista az `analyses` táblába kerül `rb_grid` típussal, a beolvasás időpontjával.
5. Ellenőrző lista (a 27. feladat használja):
    - a FixLibrary trackjei közül melyik hiányzik az exportból,
    - melyik exportbeli track mutat nem létező fájlra (missing),
    - melyik tracknek nincs `TEMPO` eleme (nincs elemezve).

**Elfogadási feltételek**
- Egy valódi Rekordbox 7.2.7 export minden trackje beolvasódik, a `Location` dekódolása után a fájlok léteznek.
- Ékezetes útvonalú trackek is párosulnak.
- A missing és az elemzetlen trackek pontosan listázódnak.

**Tesztelés**
- Vitest: egy kézzel szerkesztett minta export (ékezetes útvonal, több `TEMPO` elemes track, nem létező fájl, `TEMPO` nélküli track).
- Kézzel: a valódi teszt készlet exportja a Rekordboxból.

**Függőségek és kockázatok**
- Előtte: 4. és 25. feladat.
- Kockázat: egy 3000 trackes export több tíz MB lehet. A `fast-xml-parser` ezt másodpercek alatt feldolgozza, ezért nincs szükség streamelő olvasóra.

#### 27. Rekordbox varázsló és missing takarítás

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 27 | Rekordbox varázsló és missing takarítás | `src/renderer/pages/RekordboxWizard.tsx`, `src/main/pipeline/rekordbox-check.ts` | Nincs végigvezetett import → elemzés → export lépés, és nincs missing takarítás és ellenőrzés | Az átnevezett fájlok régi bejegyzései hibásan maradnának a collectionben | 🟠 | M |

**Jelenlegi állapot**
A dokumentáció szerint a régi bejegyzések az átnevezés után „missing” állapotba kerülnek, ezeket az app egy varázslóval végigvezetve a Rekordbox saját Missing Files funkciójával törli a collectionből, majd egy friss XML exportból ellenőrzi az eredményt. A cue-khoz előbb a Rekordbox elemzése és exportja kell, a már bent lévő trackeknél pedig „Reload Tag”. A Rekordbox verzió 7.2.7. A 25. és 26. feladat után megvan az XML írás és olvasás.

**Probléma**
A Rekordbox XML importja a már a collectionben lévő trackeket nem frissíti, ha csak a playlistet importálod, ezért pontos lépések nélkül a hot cue-k és a javított adatok nem jutnának be. A lépések kézi elvégzése útmutató nélkül hibalehetőséget jelent, ellenőrzés nélkül pedig nem derül ki, ha valami kimaradt.

**Megoldás**
1. `src/renderer/pages/RekordboxWizard.tsx`: lépésenkénti varázsló, minden lépésnél a pontos teendővel és egy „Kész” gombbal. Ahol lehet, az app maga ellenőrzi a lépést.
2. **Egyszeri beállítás** (csak az első futáskor jelenik meg):
    1. Rekordbox → Preferences → View: a „rekordbox xml” megjelenítés bekapcsolása.
    2. Rekordbox → Preferences → Advanced → rekordbox xml: az „Imported Library” mező a FixLibrary XML útvonalára (a varázsló kiírja és vágólapra másolja).
3. **A fázis: trackek bejuttatása** (az 1–4. és 9. funkció jóváhagyása után):
    1. Az app megírja az XML-t (25. feladat, cue-k nélkül).
    2. Rekordboxban a rekordbox xml nézet frissítése (reload ikon a böngészőfában).
    3. A rekordbox xml alatt az „All Tracks” listában minden track kijelölése (Cmd + A), jobb klikk → „Import To Collection”. A kijelölt trackes import a már a collectionben lévő trackeket is frissíti.
    4. A stílus playlistek és a Playlists folder importja: jobb klikk a playlistre vagy a folderre → „Import Playlist”.
    5. A Rekordbox elemzésének megvárása (a trackek BPM és grid elemzése).
    6. Missing takarítás: File → Display All Missing Files, minden track kijelölése, jobb klikk → „Remove from Collection”. Ez csak a collection bejegyzéseket törli, fájlt nem.
    7. A korábban is bent lévő, változatlan útvonalú trackeknél a tagek frissítése: kijelölés, jobb klikk → „Reload Tag”.
    8. Export: File → Export Collection in xml format, a Settingsben megadott export útvonalra.
4. **Ellenőrzés** (`src/main/pipeline/rekordbox-check.ts`, a 26. feladat ellenőrző listájával): a varázsló beolvassa az exportot, és mutatja:
    - a hiányzó FixLibrary trackeket (ha van, a 3.3 lépés ismétlését kéri),
    - a missing bejegyzéseket (ha van, a 3.6 lépés ismétlését kéri),
    - az elemzetlen trackeket (ha van, a 3.5 lépés várakozását kéri).
    Csak hibátlan ellenőrzés után lép tovább.
5. **B fázis: hot cue-k** (a 29. feladat után):
    1. Az app megírja az XML-t a `TEMPO` és a `POSITION_MARK` elemekkel.
    2. Rekordboxban a rekordbox xml nézet frissítése, az „All Tracks” minden trackjének kijelölése, jobb klikk → „Import To Collection”.
    3. Export: File → Export Collection in xml format.
    4. Az app ellenőrzi, hogy minden tracknél megvannak-e a várt hot cue-k a helyes pozíción (±10 ms).
6. A varázsló állapota az adatbázisban tárolódik, így félbehagyva is folytatható.

**Elfogadási feltételek**
- A valódi teszt készleten végigvitt varázsló után a Rekordbox collectionben minden track az új útvonalon van, és a File → Display All Missing Files lista üres.
- A hot cue-k a Rekordboxban a helyükön vannak, és a B fázis ellenőrzése hibátlan.
- A Rekordbox gridje a folyamat után változatlan (az export `TEMPO` elemei megegyeznek a folyamat előttiekkel).
- A varázsló bezárás és újraindítás után ugyanattól a lépéstől folytatható.

**Tesztelés**
- Vitest: az ellenőrzés logikája mintaexportokkal (hiányzó track, missing bejegyzés, elemzetlen track, eltérő cue pozíció).
- Kézzel: a teljes varázsló a Rekordbox 7.2.7-tel a valódi teszt készleten, a menünevek ellenőrzésével.

**Függőségek és kockázatok**
- Előtte: 25. és 26. feladat. A B fázis a 29. feladattal teljes.
- Kockázat: a Rekordbox egy későbbi verziója átnevezheti a menüpontokat. A varázsló szövegei ezért egy helyen, a `src/renderer/pages/rekordbox-wizard-steps.ts` fájlban vannak, és a kézi teszt a 7.2.7-es menüneveken készül.
- Kockázat: a „Remove from Collection” a missing bejegyzések playlist tagságát is törli. Ez szándékos, mert a playlistek az új struktúra szerint újra létrejönnek.

### H. Auto cue pointok és hot cue-k (5. funkció)

#### 28. Demucs stem separation

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 28 | Demucs stem separation | `python/fixlib_py/analysis/stems.py` | Nincs bass és vocal stem, háttérfutás és cache | A bassline és a vocal kezdetének pontos felismerése | 🔴 | L |

**Jelenlegi állapot**
A dokumentáció szerint a bassline és a vocal kezdetét stem separation (Demucs) alapján keresi az app. A teljes könyvtár első feldolgozása az M1 gépen kb. fél–egy nap, a háttérben fut, megszakítható és folytatható, az új trackek egyenként, gyorsan feldolgozhatók. A 2. feladat mérte a trackenkénti időt, a 9. feladat adja a `gpu` sort és az alvás megakadályozását.

**Probléma**
A teljes stem hangfájlok tárolása 3000 tracknél több száz GB lenne. Ha a futás nem folytatható, egy megszakítás után az egész napos munka elveszne.

**Megoldás**
1. `python/fixlib_py/analysis/stems.py`, RPC metódus: `analysis.stems(path) → { envelopePath, version }`.
2. Modell: `demucs.pretrained.get_model("htdemucs")`, futtatás `demucs.apply.apply_model`-lel MPS eszközön (`PYTORCH_ENABLE_MPS_FALLBACK=1`), ha a 2. feladat spike-ja szerint az MPS hibát adott, CPU-n. A modell egyszer töltődik be a sidecar Demucs folyamatában, és a memóriában marad (3. feladat).
3. A modell súlyfájljai nem futás közben töltődnek le: a `TORCH_HOME` környezeti változó az app saját mappájára mutat, a súlyok fejlesztéskor egy `scripts/fetch-demucs-weights.sh` scripttel kerülnek oda, a csomagolt appba pedig a 41. feladat teszi be őket.
4. Kimenet: hangfájl helyett tömör burkológörbék. A négy stem (drums, bass, other, vocals) RMS értéke 100 ms-os ablakokban, `float16` tömbként, egy `.npz` fájlban: `userData/stems/<track azonosító>.npz`. A stem hanganyag a memóriából törlődik.
5. Állapot: az eredmény az `analyses` táblába kerül `stems` típussal. A kész trackek újraindítás után nem futnak újra (9. feladat folytatás).
6. A futás a 9. feladat `gpu` sorában, egyszerre egy tracken megy, 15 perces timeouttal (7. feladat). A haladás és a hátralévő idő a progress felületen látszik, a becslés a mért trackenkénti időből.

**Elfogadási feltételek**
- 50 track feldolgozása után mindegyikhez van `.npz` fájl, egyenként legfeljebb 200 KB.
- Egy instrumentális teszt track vocal burkológörbéje a track 95%-ában a track saját maximumának 5%-a alatt marad.
- Az app futás közbeni bezárása után az újraindított futás a következő feldolgozatlan tracktől folytatódik.
- A futás internetkapcsolat nélkül is működik (a súlyok helyben vannak).

**Tesztelés**
- pytest: egy szintetikus jel (külön csatornán generált basszus és szinusz „ének”) szétválasztása után a megfelelő burkológörbék iránya, a kimeneti fájl mérete.
- Kézzel: 50 track a valódi teszt készletből, a futásidő mérése és a teljes könyvtár becsült idejének kiszámolása.

**Függőségek és kockázatok**
- Előtte: 2., 3., 7. és 9. feladat.
- Kockázat: hosszú trackeken a Demucs memóriaigénye nagy. Az `apply_model` alapértelmezett darabolása (`split=True`) ezt korlátozza.
- Kockázat: ha a 2. feladat szerint csak CPU-n fut, a teljes könyvtár ideje többszöröse lehet a fél–egy napnak. A futás akkor is a háttérben, folytathatóan megy.

#### 29. Szerkezet felismerés és cue elhelyezés

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 29 | Szerkezet felismerés és cue elhelyezés | `python/fixlib_py/analysis/structure.py`, `src/main/pipeline/cues.ts` | Nincs drop, breakdown és outro felismerés, és nincs a 8 helyes sémára illesztés | Ez maga az 5. funkció | 🔴 | L |

**Jelenlegi állapot**
A dokumentáció szerint minden track 8 fix helyű hot cue-t kap: A Start, B Bassline, C Vocal, D Drop 1, E Breakdown, F Drop 2, G Outro, H Drop 3. A hiányzó rész helye üresen marad, a cue-k a Rekordbox gridjére és a phrase határokra (8/16/32 bar) igazodnak, a meglévő cue-k felülíródnak. A 26. feladat után megvan a Rekordbox grid, a 28. feladat után a stem burkológörbék.

**Probléma**
Ez a funkció adja a legtöbb időt megspóroló eredményt, de ha a cue-k nem a beatre esnek, vagy rossz helyre kerülnek, a lejátszón használhatatlanok, és kézi javításuk több munka, mint a kézi beállítás.

**Megoldás**
1. `python/fixlib_py/analysis/structure.py`, RPC metódus: `analysis.structure(envelopePath, grid, duration) → { cues: [{ slot, timeSec }] }`.
2. Rács: a `TEMPO` elemekből beat időpontok, a `Battito` értékből az ütemek (bar) kezdete, a phrase-ek 8 bar hosszúak az első ütemtől számítva. Beat és bar szintű energiák a burkológörbék beatenkénti átlagából: `drums`, `bass`, `vocals`, `other`, és a `drums + bass` összeg (a továbbiakban „lüktetés”).
3. Felismerési szabályok (a küszöbértékek a `python/fixlib_py/analysis/structure_params.py` fájlban állíthatók):
    - **A Start**: az első bar kezdete, ahol a teljes energia a track maximumának 1%-a fölé emelkedik.
    - **B Bassline**: az első bar, ahonnan legalább 2 egymást követő bar basszus energiája a track basszus 90. percentilisének 25%-a fölött van.
    - **C Vocal**: az első bar, ahol a vocal energia a vocal 90. percentilisének 20%-a fölé emelkedik. Ha a vocal 90. percentilise a teljes energia 90. percentilisének 3%-a alatt van, a track instrumentális, a slot üres marad.
    - **D, F, H Drop**: azok a phrase határok, ahol a phrase lüktetése a track maximális phrase lüktetésének legalább 80%-a, és az előző phrase lüktetése legfeljebb ennek 60%-a. Az első a D (Drop 1), a második az F (Drop 2), a harmadik a H (Drop 3).
    - **E Breakdown**: az első phrase határ a Drop 1 után, ahol a lüktetés a Drop 1 phrase lüktetésének 50%-a alá esik.
    - **G Outro**: a legkorábbi phrase határ az utolsó drop után, ahonnan a track végéig a vocal és az other energia a saját 90. percentilisük 30%-a alatt marad. Ha ilyen nincs, a track utolsó beatje előtti 32. bar kezdete.
4. Igazítás: minden pont a legközelebbi beatre kerül. A B és a C pont a legközelebbi phrase határra kerül, ha az legfeljebb 2 bar távolságra van, egyébként a legközelebbi bar kezdetére. Az A, D, E, F, G és H pont eleve phrase határ vagy bar kezdet.
5. Sorrend ellenőrzés: A < B, A ≤ C, Drop 1 < Breakdown < Drop 2 < Drop 3, Outro az utolsó drop után. Ami sérti a sorrendet, az a slot üresen marad, és a track `CUE_REVIEW` figyelmeztetést kap a preview-ban.
6. `src/main/pipeline/cues.ts`: az eredményt a `cues` táblába írja (slot, pozíció ms-ban, a Settings szerinti név és szín), a `locked_fields` szerint a kézzel szerkesztett cue-kat nem írja felül. Az XML a 25. feladat írójával, a varázsló B fázisával kerül a Rekordboxba (27. feladat).

**Elfogadási feltételek**
- Minden cue pontosan egy Rekordbox beat időpontjára esik (±1 ms).
- 10 tracken, amelyekhez kézzel megadod a 8 pont helyét (`tests/fixtures/real/cues.csv`: fájlnév, slot, másodperc), a felismert pontok legalább 80%-a legfeljebb 1 bar távolságra van a te jelölésedtől.
- Az instrumentális trackeknél a C slot üres.
- Egyetlen tracknél sem sérül a sorrend szabály (a sértő slotok üresek).

**Tesztelés**
- pytest: szintetikus burkológörbék ismert szerkezettel (intro, basszus belépés, drop, breakdown, második drop, outro), a felismert pontok és az igazítás ellenőrzése.
- Kézzel: a `cues.csv` szerinti 10 track kiértékelése egy `scripts/eval-cues.ts` scripttel, ami kiírja a találati arányt és az eltéréseket bar-ban.

**Függőségek és kockázatok**
- Előtte: 25., 26., 27. és 28. feladat.
- Kockázat: a drop és az outro szabályok house szerkezetre készülnek, más műfajoknál (például hip-hop) pontatlanabbak lehetnek. A küszöbök a `structure_params.py`-ban hangolhatók, és a 30. feladat editorában a cue-k gyorsan javíthatók.

#### 30. Waveform cue editor

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 30 | Waveform cue editor | `src/renderer/pages/CueEditor.tsx`, `src/renderer/components/Waveform.tsx` | Nincs waveform nézet, gridhez illesztett mozgatás és törlés | A cue-k ellenőrzése és javítása | 🟠 | L |

**Jelenlegi állapot**
A dokumentáció szerint a GUI-ban minden track waveformja látható a hot cue-kkal, ahol a cue-k mozgathatók és törölhetők, a mozgatás a gridhez illesztve történik. A 29. feladat után megvannak a cue-k, a 26. feladat után a grid.

**Probléma**
Az automatikus cue-k egy része javítást igényel. Waveform nézet nélkül ezt csak a Rekordboxban lehetne megtenni, ahol a javítás nem kerül vissza az appba, és a következő XML import felülírná.

**Megoldás**
1. Hangfájl elérés: a main process egy saját protokollt regisztrál (`protocol.handle('fixlib-audio', …)`), ami a track fájlját HTTP range kérések támogatásával streameli, mert a sandboxolt renderer közvetlenül nem olvashat fájlt.
2. Waveform adat: a Python `analysis.peaks(path)` metódus `ffmpeg` dekódolással másodpercenként 100 csúcsértéket számol, az eredmény a `userData/peaks/<track azonosító>.json` fájlba cache-elődik. A renderer a `wavesurfer.js` (v7) `peaks` és `duration` opciójával tölti be, így nem kell a teljes hangfájlt dekódolnia.
3. `src/renderer/components/Waveform.tsx`:
    - a waveform fölött a beat vonalak halványan, a bar vonalak erősebben, a phrase (8 bar) vonalak a legerősebben,
    - hot cue jelölők a slot betűjével (A–H), a nevével és a színével, a `wavesurfer.js` Regions pluginjának nulla hosszú régióival,
    - görgetéssel nagyítás, húzással mozgatás.
4. `src/renderer/pages/CueEditor.tsx`:
    - track lista bal oldalt (szűrhető a `CUE_REVIEW` figyelmeztetésre), előző és következő track gomb,
    - jelölő húzása: elengedéskor a legközelebbi beatre ugrik, Shift lenyomásával a legközelebbi bar kezdetére,
    - törlés: kijelölés és Backspace,
    - üres slot kitöltése: a slot gombjára („+ C”) kattintás, majd kattintás a waveformon,
    - lejátszás a cue-tól: kattintás a jelölő betűjére, szóköz a lejátszás és szünet váltásához.
5. Mentés: a változások a `cues` táblába kerülnek, a módosított slotok a `locked_fields`-be. Az oldal egy „XML frissítése a Rekordboxhoz” gombbal elindítja a 27. feladat varázslójának B fázisát.

**Elfogadási feltételek**
- Egy track waveformja cache-elt csúcsértékekkel 1 s-on belül megjelenik.
- Egy elengedett jelölő pontosan egy beatre kerül, Shifttel egy bar kezdetére.
- A törölt és az áthelyezett cue-k az XML frissítés és a Rekordbox import után a Rekordboxban is így jelennek meg.
- A kézzel javított cue-kat egy újabb automatikus futás nem írja felül.
- A lejátszás a kiválasztott cue pozíciójától indul.

**Tesztelés**
- Vitest: a beatre és barra illesztés logikája.
- Playwright: egy jelölő húzása, törlése és egy üres slot kitöltése egy szintetikus tracken, a `cues` tábla ellenőrzése.
- Kézzel: 10 track cue-jainak javítása és az eredmény ellenőrzése a Rekordboxban.

**Függőségek és kockázatok**
- Előtte: 26., 27. és 29. feladat.
- Kockázat: a `fixlib-audio` protokoll rossz megvalósítása a könyvtáron kívüli fájlokat is elérhetővé tehetné. Ezért a protokoll csak az adatbázisban szereplő track azonosítókat fogadja el, útvonalat nem.

### I. Hangerő normalizálás (9. funkció)

#### 31. Loudness mérés

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 31 | Loudness mérés | `python/fixlib_py/analysis/loudness.py` | Nincs LUFS és true peak mérés | A normalizálás és a preview alapja | 🟠 | S |

**Jelenlegi állapot**
A dokumentáció szerint a normalizálás egy közös LUFS célszintre hozza a trackeket, a preview előtte és utána mutatja az integrated loudness (LUFS), a true peak (dBTP) és a gain változás (dB) értékét. Az `ffmpeg` az 5. feladatból megvan.

**Probléma**
Pontos mérés nélkül a normalizálás rossz irányba vagy rossz mértékben állítaná a hangerőt, és nem lehetne megállapítani, mely trackek clippelnének.

**Megoldás**
1. `python/fixlib_py/analysis/loudness.py`, RPC metódus: `analysis.loudness(path) → { integratedLufs, truePeakDbtp, lra }`.
2. Mérés az `ffmpeg` EBU R128 szűrőjével: `ffmpeg -nostats -i <fájl> -filter_complex ebur128=peak=true -f null -`, a kimenet összesítő részéből az `I:` (integrated loudness), a `Peak:` (true peak) és az `LRA:` érték.
3. Az eredmény az `analyses` táblába (`loudness` típussal) és a `tracks` tábla LUFS és true peak mezőjébe kerül.
4. A lépés a 9. feladat `cpu` sorában fut, 120 s-os timeouttal.

**Elfogadási feltételek**
- A valódi teszt készleten a mért integrated loudness legfeljebb 0,2 LU-val tér el a `pyloudnorm` által mért értéktől.
- Minden trackre véges LUFS és true peak érték születik, a csendes vagy sérült fájlok `FILE_UNREADABLE` hibával a hibák közé kerülnek.

**Tesztelés**
pytest: szintetikus jelek ismert szintkülönbséggel (ugyanaz a jel 0 és −6 dB-lel, a mért különbség 6 ± 0,1 LU), az `ffmpeg` kimenet feldolgozása rögzített mintaszövegekből, összevetés a `pyloudnorm`-mal.

**Függőségek és kockázatok**
- Előtte: 3., 5. és 9. feladat.
- Kockázat: az `ffmpeg` kimenetének formátuma verziók között változhat. A rögzített `ffmpeg-static` verzió és a mintaszöveges teszt ezt védi.

#### 32. Normalizálás

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 32 | Normalizálás | `python/fixlib_py/normalize.py` | Nincs veszteségmentes és pontos mód, és nincs kihagyás clippelés esetén | A trackek közötti hangerőkülönbség megszüntetése | 🟠 | M |

**Jelenlegi állapot**
A dokumentáció szerint a célszint alapértelmezetten −11 LUFS (választható −8 LUFS vagy egyedi érték), a módszer a beállításokban választható: veszteségmentes (alapértelmezett, mp3gain-szerű gain állítás átkódolás nélkül, 1,5 dB-es lépésekben; AIFF-nél a PCM adat újraírása) vagy pontos (átkódolás pontosan a célértékre). Limiter nincs: ha egy track limiter nélkül nem érhető el a célszintre, az app kihagyja és megjelöli. A 31. feladat után megvannak a mért értékek, az `mp3gain` az 5. feladatból.

**Probléma**
A könyvtár trackjei között nagy a hangerőkülönbség. Ha a normalizálás clippelést okoz, a hang torzul, ha pedig dinamikus feldolgozást használ, a zene karaktere változik.

**Megoldás**
1. `python/fixlib_py/normalize.py`, RPC metódusok: `normalize.plan(track, target, method)` (compute fázis) és `normalize.apply(path, plan)` (apply fázis).
2. Szükséges gain: `g = célszint − mért integrated loudness`.
3. **Veszteségmentes mód**:
    - MP3: a lépések száma `n = round(g / 1,5)`, alkalmazás az `mp3gain -g <n> -s s <fájl>` paranccsal (a `-s s` kapcsolóval, hogy ne írjon APEv2 taget), a 10. feladat atomi szabálya szerint egy ideiglenes másolaton.
    - AIFF: a PCM adat beolvasása `soundfile`-lal lebegőpontosan, szorzás a pontos gainnel, visszaírás az eredeti bitmélységgel (16 bitnél TPDF ditherrel).
4. **Pontos mód** (MP3): `ffmpeg -i <src> -map 0:a:0 -af volume=<g>dB -c:a libmp3lame -b:a 320k <dst>`, csak lineáris gain, dinamikus feldolgozás nélkül. A tagek és a cover a 16. feladat `tags.write` metódusával kerülnek vissza. AIFF-nél a pontos mód ugyanaz, mint a veszteségmentes, mert ott a PCM gain eleve pontos.
5. Clippelés szabály: a várható true peak a normalizálás után `mért true peak + alkalmazott gain`. Ha ez −1,0 dBTP fölé menne, a track kimarad, és `CANNOT_NORMALIZE` figyelmeztetést kap a szükséges és a lehetséges gain értékével. Negatív gain (halkítás) mindig alkalmazható.
6. Utólagos ellenőrzés: az apply után a 31. feladat mérése újra lefut. Elvárt eltérés a célszinttől: pontos módban legfeljebb 0,2 LU, veszteségmentes MP3-nál legfeljebb 0,75 LU (a fél lépés).
7. Batch preview oszlopkészlet (11. feladat): mért LUFS, várható LUFS, gain (dB), true peak előtte és utána, módszer, állapot.

**Elfogadási feltételek**
- Pontos módban a normalizált trackek a célszinttől legfeljebb 0,2 LU-val térnek el.
- Veszteségmentes MP3 módban legfeljebb 0,75 LU-val, és a hanganyag átkódolás nélkül változik (az MP3 frame-ek száma és mérete azonos).
- Egy track sem lépi túl a −1,0 dBTP true peak értéket a normalizálás után. Ami túllépné, az kimarad és meg van jelölve.
- Az MP3 fájlokban nincs APEv2 tag a normalizálás után.
- A tagek és a cover a normalizálás után is megvannak.

**Tesztelés**
- pytest: mindkét mód szintetikus MP3 és AIFF fájlokon, a gain számítás és a lépés kerekítés, a clippelés szabály egy majdnem 0 dBTP csúcsú, halk tracken, a tagek megmaradása, az APEv2 tag hiánya.
- Kézzel: a valódi teszt készlet normalizálása és meghallgatása a 33. feladat lejátszójával.

**Függőségek és kockázatok**
- Előtte: 5., 10., 11., 16. és 31. feladat.
- Kockázat: a −11 LUFS célszintnél a halk, de nagy csúcsú trackek nem húzhatók fel, ezért kimaradnak. Ez a dokumentáció szerinti szándékos működés. A kimaradt trackek listája a preview „Figyelmeztetések” szűrőjével átnézhető.

#### 33. A/B lejátszó és mért értékek

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 33 | A/B lejátszó és mért értékek | `src/renderer/components/AbPlayer.tsx` | Nincs összehasonlító meghallgatás és előtte/utána érték | A változás ellenőrzése jóváhagyás előtt | 🟡 | M |

**Jelenlegi állapot**
A dokumentáció szerint a preview-ban az eredeti és a normalizált verzió között egy gombbal lehet váltani, ugyanazon a ponton, és látszanak a mért értékek előtte és utána. A 30. feladat `fixlib-audio` protokollja és a 32. feladat terve megvan.

**Probléma**
A preview a jóváhagyás előtt fut, amikor a normalizált fájl még nem létezik. Meghallgatás nélkül nem derül ki, hogy a változás jó-e.

**Megoldás**
1. `src/renderer/components/AbPlayer.tsx` a Web Audio API-val: egy forrás (a `fixlib-audio` protokollon betöltött eredeti fájl), két `GainNode` ágon. Az A ág 0 dB, a B ág a 32. feladat terve szerinti gain (veszteségmentes módban a lépésekre kerekítve), így a B ág pontosan azt szólaltatja meg, amit a normalizálás eredményezne, hiszen mindkét mód lineáris gain.
2. Váltás az A és a B ág között 20 ms-os crossfade-del, a lejátszási pozíció változatlan. Billentyű: `A` és `B`, vagy a gomb.
3. Kijelzett értékek: integrated loudness előtte és utána (LUFS), true peak előtte és utána (dBTP), gain (dB), és a két verzió közötti különbség LU-ban.
4. A lejátszó a batch preview normalizálás oszlopkészletében soronként egy „Meghallgatás” gombbal nyílik.

**Elfogadási feltételek**
- Az A és a B közötti váltás a lejátszási pozíciót legfeljebb 10 ms-mal változtatja, kattanás nélkül.
- A kijelzett értékek megegyeznek a preview sor értékeivel.
- A B ág hangereje mérhetően a tervezett gainnel tér el az A ágtól (a Web Audio `AnalyserNode` RMS értéke alapján, ±0,5 dB).

**Tesztelés**
- Vitest: a gain számítás és a kerekítés.
- Playwright: lejátszás indítása, váltás A és B között, a pozíció és a kijelzett értékek ellenőrzése.
- Kézzel: 10 normalizálandó track meghallgatása.

**Függőségek és kockázatok**
- Előtte: 11., 30. és 32. feladat.
- Kockázat: a pontos mód MP3 átkódolása apró hangszínbeli különbséget okozhat, amit a lineáris gain szimuláció nem mutat meg. 320 kbps-nál ez hallhatatlan, ezért elfogadható.

### J. Letöltés yt-dlp-vel (8. funkció)

#### 34. Letöltő

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 34 | Letöltő | `src/main/services/downloader.ts`, `src/renderer/pages/Download.tsx` | Nincs URL-es és keresés alapú letöltés, MP3 320 kimenet, bitrate figyelmeztetés és duplikátum előellenőrzés | Új trackek bekerülése a könyvtárba | 🟠 | M |

**Jelenlegi állapot**
A dokumentáció szerint a források a YouTube és a SoundCloud, URL beillesztéssel (egyesével vagy többet egyszerre) és az appon belüli kereséssel, a teljes playlist URL nem kell, Bandcamp nem kell. A kimenet MP3 320, 128 kbps alatti forrásnál figyelmeztetés jelenik meg „Confirm” és „Decline” gombbal, letöltés előtt duplikátum ellenőrzés fut, a letöltés egy „Inbox” mappába érkezik. A `yt-dlp` és az `ffmpeg` az 5. feladatból, a duplikátum felismerés a 17. feladatból megvan.

**Probléma**
Egy rossz minőségű forrás észrevétlenül rontaná a könyvtár minőségét, egy már meglévő track letöltése pedig duplikátumot okozna. Egy playlist URL véletlenül több tucat tracket töltene le.

**Megoldás**
1. Inbox mappa: `<könyvtár gyökér>/Inbox/`, a 8. feladat beolvasása ezeket a trackeket „inbox” állapotban veszi fel.
2. Információ lekérés letöltés előtt: `yt-dlp -J --no-playlist <url>`. Ebből jön a cím, a feltöltő, a hossz és a legjobb audio formátum bitrate-je (`abr`). A `--no-playlist` kapcsoló miatt egy playlist paramétert tartalmazó URL is csak az adott videót tölti le.
3. Minőség ellenőrzés: ha a legjobb audio formátum `abr` értéke 128 kbps alatt van, egy ablak jelenik meg a mért értékkel, „Confirm” és „Decline” gombbal. Decline esetén a letöltés nem indul el.
4. Duplikátum előellenőrzés: a cím a 15. feladat bemeneti elemzésével artistra és title-re bontva, a 17. feladat szöveges szabályával összevetve a könyvtárral. Ha egyezik, ablak jelenik meg a meglévő trackkel, „Letöltés mégis” és „Mégse” gombbal. A letöltés után a fingerprint alapú ellenőrzés is lefut (35. feladat).
5. Letöltés: `yt-dlp --no-playlist -f bestaudio/best -x --audio-format mp3 --audio-quality 320K --ffmpeg-location <a csomagolt ffmpeg> --write-thumbnail --convert-thumbnails jpg --newline -o "<Inbox>/%(id)s.%(ext)s" <url>`. A thumbnail a 19. feladat YouTube cover forrása.
6. Keresés: `yt-dlp -J --flat-playlist "ytsearch10:<keresés>"` és `"scsearch10:<keresés>"`. A találatok (cím, feltöltő, hossz, forrás) egy listában jelennek meg, a kiválasztott találat a fenti folyamaton megy át.
7. `src/renderer/pages/Download.tsx`: szövegmező URL-eknek (soronként egy), keresőmező forrás választóval (YouTube, SoundCloud), letöltési sor haladással (a `--newline` kimenet soraiból számolva), hibaüzenetekkel.
8. A letöltések a 9. feladat `network` erőforrásán futnak, egyszerre legfeljebb 2.
9. Hibakezelés: ha a `yt-dlp` hibával lép ki, és a hibaüzenet a kinyerés sikertelenségére utal, a felület a `yt-dlp` frissítését javasolja (43. feladat).

**Elfogadási feltételek**
- Egy YouTube és egy SoundCloud URL letöltése után az Inboxban egy-egy 320 kbps-os MP3 és egy JPG thumbnail van.
- Egy `&list=` paramétert tartalmazó YouTube URL csak egy tracket tölt le.
- Egy 128 kbps alatti forrásnál megjelenik a Confirm és Decline ablak, és Decline után nem jön létre fájl.
- Egy a könyvtárban már meglévő track letöltésekor megjelenik a duplikátum figyelmeztetés.
- Öt egyszerre beillesztett URL-ből egyszerre legfeljebb kettő töltődik.
- A keresés YouTube-on és SoundCloudon is 10 találatot ad.

**Tesztelés**
- Vitest: a `yt-dlp -J` kimenet feldolgozása rögzített JSON mintákból (normál, alacsony bitrate, playlist URL), a keresési találatok feldolgozása, a haladás sorainak értelmezése.
- Kézzel: valódi letöltés YouTube-ról és SoundCloudról.

**Függőségek és kockázatok**
- Előtte: 5., 8., 9., 15. és 17. feladat.
- Kockázat: a YouTube rendszeresen változtat, ami miatt a `yt-dlp` adott verziója működésképtelenné válhat. Ezt a 43. feladat független `yt-dlp` frissítése kezeli.

#### 35. Inbox feldolgozás

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 35 | Inbox feldolgozás | `src/main/pipeline/inbox.ts` | A letöltött trackek nem mennek végig automatikusan a funkciókon | Az új trackek ugyanolyan rendezettek legyenek, mint a meglévők | 🟠 | S |

**Jelenlegi állapot**
A dokumentáció szerint a letöltött track automatikusan végigmegy a fájlnév és tag (1.), cover (2.), stílus (3.), energy (4.) és hangerő (9.) funkción, utána egy preview mutat minden adatot és a célmappát, minden módosítható, és a jóváhagyás után a track a stílus mappájába kerül. A hot cue-k a Rekordbox elemzése után kerülnek rá. A később hozzáadott trackek (például a yt-dlp letöltések) automatikusan ugyanígy sorolódnak be.

**Probléma**
Automatikus feldolgozás nélkül minden új tracket kézzel kellene végigvinni az összes funkción, és az Inbox mappa idővel rendezetlen gyűjtőhellyé válna.

**Megoldás**
1. `src/main/pipeline/inbox.ts`: a `chokidar` figyeli az Inbox mappát. Minden új hangfájl (a letöltések és a kézzel bemásolt fájlok is) 10 s várakozás után (hogy a fájl írása biztosan befejeződjön) egy Inbox batch-be kerül.
2. Az Inbox batch lépései a 9. feladat orchestratorán: BPM és key (13.), fingerprint és lookup (14.), duplikátum ellenőrzés (17.), név (15.), cover (19–20., a YouTube thumbnail forrással), stílus (21.), energy (24., a tárolt kalibrált modellel), loudness és normalizálás terv (31–32.), valamint a Demucs stemek (28.) a háttérben.
3. Preview: a batch preview (11. feladat) egy „Inbox” nézete, ami soronként minden oszlopkészletet mutat, és egy „Célmappa” oszlopot (például `Afro House/`), ami a stílus legördülő listával együtt változik. Minden mező szerkeszthető.
4. Jóváhagyás után az apply fázis a trackeket a stílus mappájukba helyezi (22. feladat), és a felület jelzi, hogy a hot cue-khoz a Rekordbox varázsló (27. feladat) A és B fázisa szükséges.
5. Ha a feldolgozás közben egy track a fingerprint alapján duplikátumnak bizonyul, a preview „Duplikátumok” fülén jelenik meg (17. feladat).

**Elfogadási feltételek**
- Egy letöltött track legfeljebb 1 perccel a letöltés befejezése után megjelenik az Inbox preview-ban (a Demucs nélkül), kitöltött névvel, coverrel, stílussal, energyvel és normalizálási tervvel.
- Egy kézzel az Inboxba másolt MP3 ugyanígy feldolgozódik.
- A stílus módosítása a preview-ban a célmappát is módosítja.
- Jóváhagyás után az Inbox üres, a track a stílus mappájában van.

**Tesztelés**
- Vitest: a mappafigyelés és a 10 s-os várakozás fake timerekkel, a batch lépéseinek összeállítása.
- Playwright: egy fájl bemásolása az Inboxba, a preview megjelenése, jóváhagyás.

**Függőségek és kockázatok**
- Előtte: 11., 13–17., 19–24., 28., 31–32. és 34. feladat.
- Kockázat: ha a kalibrált energy modell még nincs meg (első használat), az energy lépés kimarad, és a preview jelzi, hogy előbb a kalibráció (24. feladat) szükséges.

### K. Playlistek (6–7. funkció)

#### 36. Hasonlósági motor

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 36 | Hasonlósági motor | `src/main/pipeline/similarity.ts` | Nincs stílus, BPM, Camelot, energy és hangulat alapú pontozás | Az ajánlás és a generálás közös alapja | 🟠 | M |

**Jelenlegi állapot**
A dokumentáció szerint a hasonlóság alapja, prioritási sorrendben: stílus, BPM tartomány, key kompatibilitás (Camelot szomszédok), energy, és a hangulat, amit a Claude CLI a metadata alapján ítél meg. Az ajánlás a playlist egészéhez illeszkedik. A 13., 21. és 24. feladat után megvan a BPM, a key, a stílus és az energy.

**Probléma**
Közös pontozás nélkül az ajánlás (37–38.) és a generálás (39.) eltérő logikát követne, és a prioritási sorrend nem érvényesülne.

**Megoldás**
1. Hangulat: a 12. feladat service-ével, a `src/main/services/claude-prompts/mood.ts` sablonnal, 20 track hívásonként. A Claude trackenként legfeljebb 3 hangulat címkét ad egy rögzített szótárból: `deep`, `dark`, `uplifting`, `groovy`, `melodic`, `percussive`, `vocal`, `sensual`, `euphoric`, `hypnotic`. A bemenet az artist, title, mix, label, stílus, BPM és energy. Az eredmény a `tracks.mood_tags` mezőbe kerül (új migráció), egyszer számolódik és cache-elődik.
2. Részpontszámok (0–1) a `src/main/pipeline/similarity.ts` fájlban:
    - **stílus**: azonos elsődleges stílus 1, az egyik elsődleges a másik másodlagosa 0,6, egyébként 0,
    - **BPM**: legfeljebb 3 BPM eltérés 1, 3 és 8 BPM között lineárisan csökken 0-ig,
    - **key**: azonos Camelot kód 1, szomszédos szám ugyanazzal a betűvel (±1) vagy ugyanaz a szám a másik betűvel 0,8, egyébként 0 (a 12 és az 1 szomszédos),
    - **energy**: 1 − |különbség| / 9,
    - **hangulat**: a címkék Jaccard hasonlósága.
3. Súlyok a prioritási sorrend szerint: stílus 0,35, BPM 0,25, key 0,20, energy 0,12, hangulat 0,08.
4. Playlist profil (`buildProfile(tracks)`): a stílusok eloszlása, a BPM medián, a key-ek halmaza, az energy átlag, a hangulat címkék gyakorisága. Egy jelölt pontszáma a profilhoz: a stílus részpontszám a profil stílus eloszlásából súlyozva, a BPM a mediánhoz, a key a profil legjobban illeszkedő key-éhez, az energy az átlaghoz, a hangulat a profil leggyakoribb címkéihez mérve.
5. A függvények tiszta függvények (mellékhatás nélkül), így a 37., 38. és 39. feladat és a tesztek is közvetlenül használják.

**Elfogadási feltételek**
- Két azonos stílusú, 124 BPM-es, 8A key-ű, azonos energyjű track pontszáma legalább 0,92.
- A 12A és az 1A key-ű trackek key részpontszáma 0,8.
- Egy eltérő stílusú, de minden más szempontból azonos jelölt pontszáma alacsonyabb, mint egy azonos stílusú, de 5 BPM-mel eltérő jelölté.
- A hangulat címkék csak a rögzített szótárból kerülhetnek ki (a JSON séma ezt kikényszeríti).

**Tesztelés**
Vitest: táblázatos tesztek minden részpontszámra (a határértékekkel), a súlyozott összeg, a profil építés, a prioritási sorrend érvényesülése a fenti összehasonlításokkal.

**Függőségek és kockázatok**
- Előtte: 12., 13., 21. és 24. feladat.
- Kockázat: a hangulat címkék a metadata alapján pontatlanok lehetnek, mert a Claude nem hallja a zenét. Ezért ez a legkisebb súlyú szempont.

#### 37. Playlist kezelés és helyi ajánlás

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 37 | Playlist kezelés és helyi ajánlás | `src/renderer/pages/Playlists.tsx`, `src/main/pipeline/playlists.ts` | Nincs playlist létrehozás és 10 helyi ajánlás | A 6. funkció helyi része | 🟠 | M |

**Jelenlegi állapot**
A dokumentáció szerint létrehozol egy playlistet (például „Sunset set”), beraksz pár tracket, és az app 10 hasonló tracket ajánl a saját könyvtárból, egy kattintással hozzáadhatóan. A playlistek az XML-ben a „Playlists” folderbe kerülnek. A 4. feladat után megvannak a `playlists` és `playlist_tracks` táblák, a 36. feladat után a pontozás.

**Probléma**
Playlist kezelés nélkül az ajánlásnak nincs mire épülnie, és a Rekordboxban kellene összerakni a playlisteket, ahol az app ajánlásai nem érhetők el.

**Megoldás**
1. `src/main/pipeline/playlists.ts`: létrehozás, átnevezés, törlés, track hozzáadása, eltávolítása és átrendezése, IPC csatornákkal (`playlists:*`).
2. `src/renderer/pages/Playlists.tsx`:
    - bal oldalt a playlistek listája, „Új playlist” gombbal,
    - középen a kiválasztott playlist trackjei, húzással átrendezhetők, soronként eltávolítás gombbal, alatta összesített hossz, BPM tartomány és key-ek,
    - jobb oldalt az „Ajánlott a könyvtárból” panel 10 trackkel (cover, artist, title, BPM, key, energy, stílus, pontszám), soronként „+” gombbal és meghallgatás gombbal.
3. A Library oldalon (8. feladat) a kijelölt trackek a műveletsávban a „Hozzáadás playlisthez” menüponttal is playlistbe tehetők.
4. Ajánlás: a 36. feladat profil pontszáma szerinti első 10 track, kihagyva a playlistben már szereplőket, a `_Duplicates` mappa trackjeit és az offline trackeket. Minden playlist változás után újraszámolódik. Ha a playlist üres, a panel azt írja ki, hogy legalább egy track kell.
5. A playlistek a következő XML írásnál (25. feladat) a „Playlists” folderbe kerülnek a megadott sorrendben, és a varázsló (27. feladat) 3.4 lépésével jutnak a Rekordboxba.

**Elfogadási feltételek**
- Egy playlist létrehozható, átnevezhető, törölhető, a trackek hozzáadhatók, eltávolíthatók és átrendezhetők, és mindez újraindítás után is megmarad.
- Egy 3 trackes playlisthez 10 ajánlás jelenik meg, egyik sem szerepel a playlistben.
- A „+” gomb után a track a playlist végére kerül, és az ajánlások frissülnek.
- A Rekordbox importja után a playlist a Playlists folderben, helyes sorrendben jelenik meg.

**Tesztelés**
- Vitest: a playlist műveletek, az ajánlás szűrése (playlistben lévő, duplikátum, offline track kizárása).
- Playwright: playlist létrehozás, három track hozzáadása, egy ajánlás hozzáadása, átrendezés.

**Függőségek és kockázatok**
- Előtte: 4., 8., 25. és 36. feladat.
- Kockázat: egy nagyon vegyes playlist profilja szétszórt, ezért az ajánlások kevésbé pontosak. Ez a playlist egészéhez illesztés dokumentált következménye.

#### 38. Online ajánlás

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 38 | Online ajánlás | `src/main/pipeline/online-recs.ts` | Nincs Claude és Beatport alapú, létezésre ellenőrzött online ajánlás | A 6. funkció online része, és a 7. funkció hiánypótlása | 🟡 | M |

**Jelenlegi állapot**
A dokumentáció szerint az app 10 online tracket is ajánl a Claude CLI javaslataiból és a Beatport stílus listáiból, minden javaslatot Beatport vagy YouTube kereséssel ellenőriz, így csak létező track jelenik meg, és az online trackek egy kattintással letölthetők (8. funkció), majd átesnek az 1–5. funkciókon. A 7. funkció is online trackeket javasol, ahol a könyvtárban hiány van. A 12., 14., 34. és 36. feladat megvan.

**Probléma**
A Claude a modell tudásának dátuma utáni kiadásokat nem ismeri, és kitalált címeket is javasolhat. Ellenőrzés nélkül nem létező trackek jelennének meg.

**Megoldás**
1. Két jelölt forrás a `src/main/pipeline/online-recs.ts` fájlban:
    - **Claude**: a `src/main/services/claude-prompts/online-recs.ts` sablon a playlist profilját és legfeljebb 20 reprezentatív trackjét kapja, és 20 jelöltet kér (artist, title, mix) JSON sémával.
    - **Beatport lista**: a playlist domináns stílusához tartozó Beatport genre oldal „Top 100” listája. A stílus és a Beatport genre oldal URL-jének párosítása a Settings „Stílusok” részében stílusonként megadható (a 6. feladat bővítése). Ahol nincs megadva URL, ez a forrás kimarad.
2. Kiszűrés: a jelöltek közül kimarad, ami a 17. feladat szöveges szabálya szerint már megvan a könyvtárban.
3. Létezés ellenőrzés: minden jelöltre `yt-dlp -J --flat-playlist "ytsearch1:<artist> - <title> <mix>"`. A jelölt csak akkor marad, ha a találat címe legalább 0,8-as hasonlóságú, és a hossza 2 és 15 perc között van. Ha a YouTube nem ad megfelelő találatot, a 14. feladat Beatport keresése a második ellenőrzés.
4. Rangsorolás a 36. feladat profil pontszámával. A Beatport jelöltek BPM, key és genre adata a Beatportból jön (a genre a Settings párosítása alapján stílusra fordítva), a Claude jelölteknél a hiányzó szempontok részpontszáma semleges 0,5.
5. Megjelenítés a 37. feladat panelén egy második, „Online ajánlás” fülön, 10 trackkel, soronként forrás jelöléssel és „Letöltés” gombbal. A letöltés a 34. feladat folyamatával, az ellenőrzéskor talált URL-lel indul, és a track az Inbox feldolgozás (35. feladat) jóváhagyása után automatikusan bekerül a playlistbe.
6. A 39. feladat hiánypótlása ugyanezt a modult használja egy célprofillal (stílus, BPM, key, energy) a playlist profil helyett.

**Elfogadási feltételek**
- Egy playlisthez 10 online ajánlás jelenik meg, mindegyikhez működő YouTube vagy Beatport találattal.
- Egyik ajánlás sem szerepel már a könyvtárban.
- A „Letöltés” gomb után a track az Inbox jóváhagyása után a playlist végén jelenik meg.
- Ha egy stílushoz nincs Beatport URL megadva, a Claude forrás egyedül is ad ajánlásokat.

**Tesztelés**
- Vitest: a szűrés, az ellenőrzés logikája rögzített `yt-dlp` és Beatport válaszokkal (egyező, nem egyező, túl rövid találat), a rangsorolás a semleges részpontszámokkal.
- Kézzel: online ajánlás egy valódi playlisthez, a találatok meghallgatása.

**Függőségek és kockázatok**
- Előtte: 12., 14., 17., 34., 35., 36. és 37. feladat.
- Kockázat: a Beatport oldalak szerkezete változhat, ilyenkor a Beatport forrás kimarad, a Claude forrás működik tovább.
- Kockázat: a Claude jelöltek egy része az ellenőrzésen elbukik. Ezért a Claude 20 jelöltet ad a 10 megjelenítendő helyett.

#### 39. Playlist generátor

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 39 | Playlist generátor | `src/main/pipeline/generator.ts`, `src/renderer/pages/Generator.tsx` | Nincs prompt és paraméter alapú generálás, energy görbe, sorrend szabályok és track csere | Ez maga a 7. funkció | 🟠 | L |

**Jelenlegi állapot**
A dokumentáció szerint a generálás bemenete szöveges prompt vagy GUI paraméterek (akár együtt), a hossz időtartamban vagy track számban adható meg, az energy görbe előre megadott profil (warm-up, peak time, sunset, closing) vagy saját rajzolt görbe. A sorrend szabályai: csak harmonikusan kompatibilis key-ek követik egymást, legfeljebb ±3 BPM ugrás, fokozatos stílusváltás, és az energy a görbét követi. Hiánynál az app online trackeket javasol, az ismétlés más playlistekhez képest nem számít, és generálás után bármelyik track cserélhető alternatívákra. A 36. és 38. feladat megvan.

**Probléma**
Mohó (lépésenként a legjobbat választó) algoritmussal a generálás zsákutcába futhat, ahol a szabályoknak megfelelő következő track már nincs. Szabályok nélkül a sorrend nem lenne keverhető.

**Megoldás**
1. Prompt értelmezés: a `src/main/services/claude-prompts/playlist-prompt.ts` sablon a szöveges promptból JSON paramétereket készít: stílus sorrend (például Organic House → Afro House), hossz percben vagy track számban, BPM tartomány, energy profil neve, hangulat címkék. A felület ezekkel kitölti a paraméter mezőket, amelyek generálás előtt szerkeszthetők.
2. Hossz: időtartamnál a trackek teljes hosszának összege számít, és a generálás addig tart, amíg az összeg el nem éri a célt. A felület ezt a mezőnél jelzi („a trackek teljes hossza”).
3. Energy görbék a `src/shared/energy-curves.ts` fájlban, a set normalizált idejének (t = 0…1) függvényeként:
    - warm-up: 3-ról 6-ra lineárisan,
    - peak time: végig 8,
    - sunset: 4-ről 7-re emelkedő alapvonal ±1,5 amplitúdójú, két teljes hullámmal,
    - closing: 8-ról 3-ra lineárisan,
    - saját: 5–10 kontrollpontos görbe, amit a `src/renderer/components/EnergyCurveEditor.tsx` SVG szerkesztőjében húzással rajzolsz, a pontok között lineáris interpolációval.
4. Algoritmus a `src/main/pipeline/generator.ts` fájlban: beam search 5-ös nyalábszélességgel. Minden pozíciónál a jelöltek:
    - **kemény szabályok**: a key azonos vagy Camelot szomszéd az előző trackhez képest, a BPM eltérés legfeljebb 3, a BPM a megadott tartományban van, a track még nincs a generált listában,
    - **pontozás**: a célstílus egyezése (a stílus sorrend az idő arányában vált, az átmeneti szakaszban mindkét stílus elfogadott), az energy közelsége a görbe adott pontjához, és a 36. feladat hangulat részpontszáma.
5. Hiány: ha egy pozícióra nincs a kemény szabályoknak megfelelő jelölt, a pozíció „hiány” jelölést kap a célprofillal (stílus, BPM, key, energy), és a 38. feladat online ajánlást ad rá. A generálás a következő pozícióval folytatódik, a hiány előtti track értékeihez képest.
6. `src/renderer/pages/Generator.tsx`:
    - bal oldalt a prompt mező és a paraméterek (stílusok, hossz típusa és értéke, BPM tartomány, energy profil választó vagy a görbe szerkesztő),
    - jobb oldalt a generált lista: soronként a track adatai és egy „Csere” gomb, alatta az energy görbe és a trackek tényleges energy értékei egy közös grafikonon,
    - a „Csere” a két szomszédos trackhez képest a kemény szabályoknak megfelelő 5 legjobb alternatívát mutatja,
    - a hiány sorok az online ajánlásokkal és „Letöltés” gombbal jelennek meg,
    - „Mentés playlistként” gomb: a lista a 37. feladat playlistjei közé, onnan a Playlists folderbe kerül.

**Elfogadási feltételek**
- A generált listában minden szomszédos pár megfelel a kemény szabályoknak, kivéve a hiányként jelölt pozíciókat.
- A trackek energy értékeinek átlagos eltérése a görbétől legfeljebb 1,5.
- Időtartamos célnál a lista összhossza legfeljebb egy track hosszával tér el a céltól, track számos célnál pontosan annyi track van.
- A „2 órás sunset set, Organic House-ból Afro House-ba, 118–124 BPM” prompt helyesen tölti ki a paramétereket (120 perc, sunset profil, a két stílus sorrendben, 118–124 BPM).
- Egy track cseréje után a lista továbbra is megfelel a szabályoknak.
- A saját rajzolt görbe szerint generált lista energy értékei a görbét követik a fenti eltérésen belül.

**Tesztelés**
- Vitest: a beam search egy szintetikus, 300 trackes könyvtáron (ismert BPM, key, stílus, energy), a kemény szabályok, a görbék, a hiány kezelése, a csere alternatívák. A prompt értelmezés a kamu `claude` scripttel.
- Kézzel: három generálás (warm-up, peak time, saját görbe) a valódi könyvtáron, és a listák meghallgatása.

**Függőségek és kockázatok**
- Előtte: 12., 24., 36., 37. és 38. feladat.
- Kockázat: egy szűk BPM tartomány és kevés trackes stílus esetén sok hiány keletkezhet. A felület ilyenkor a hiányok számát a generálás tetején kiírja, és a BPM tartomány bővítését javasolja.

### L. Teljes pipeline

#### 40. Egy gombos teljes futtatás

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 40 | Egy gombos teljes futtatás | `src/main/pipeline/full-run.ts`, `src/renderer/pages/Library.tsx` | Nincs 1 → 2 → 3 → 4 → 9 → Rekordbox lépés → 5 állapotgép | A teljes könyvtár első rendbetétele egy folyamatként | 🟠 | S |

**Jelenlegi állapot**
A dokumentáció szerint van egy gombos teljes pipeline (1 → 2 → 3 → 4 → 9 → Rekordbox lépés → 5), és minden funkció külön is indítható. A teljes futás a kijelölt trackeken vagy a teljes könyvtáron indulhat. A 9–35. feladat után minden lépés külön működik.

**Probléma**
A lépések külön futtatása a teljes könyvtárnál sok kézi váltást és várakozást jelent, és könnyű kihagyni egy lépést (például a kalibrációt vagy a Rekordbox exportot).

**Megoldás**
1. `src/main/pipeline/full-run.ts`: állapotgép, aminek az állapota az adatbázisban tárolódik, így újraindítás után folytatható. Állapotok:
    1. **Compute**: BPM és key, fingerprint és lookup, duplikátumok, név, WAV konverzió terve, cover, stílus, energy, loudness és normalizálás terve. Ezzel párhuzamosan indul a Demucs (28.) a `gpu` sorban, mert a stemek a hanganyagtól függnek, nem a fájlnévtől, így a teljes futás ideje rövidül.
    2. **Kalibráció**: ha még nincs kalibrált energy modell, a folyamat itt megáll, és a 24. feladat kalibrációs oldalára visz. A kalibráció után az energy lépés lefut.
    3. **Közös preview**: egy batch preview az összes oszlopkészlettel, fülekre bontva (fájlnév, cover, stílus, energy, normalizálás, duplikátumok, hibák).
    4. **Apply**: egyetlen jóváhagyás után az összes fájlművelet (10. feladat).
    5. **Rekordbox A fázis**: a 27. feladat varázslója az ellenőrzésig.
    6. **Cue-k**: a Demucs befejezésének megvárása (ha még fut), majd a 29. feladat szerkezet felismerése a Rekordbox gridjével.
    7. **Rekordbox B fázis**: a varázsló B fázisa az ellenőrzésig.
    8. **Kész**: összefoglaló a feldolgozott, kihagyott és hibás trackek számával.
2. A Library oldalon (8. feladat) a „Teljes futtatás” gomb a kijelölt trackeken, kijelölés nélkül a teljes könyvtáron indítja a folyamatot.
3. Egy lépcsőzetes kijelző (stepper) a Library oldal tetején mutatja az aktuális állapotot, az eltelt időt és a hátralévő idő becslését.

**Elfogadási feltételek**
- A valódi teszt készleten a teljes futás egy indítással végigmegy az összes állapoton, a kalibrációs és a Rekordbox lépéseknél a te közreműködéseddel.
- Az app bármelyik állapotban bezárható, és újraindítás után ugyanonnan folytatódik.
- A Demucs a compute fázissal párhuzamosan indul, és a cue állapotnál csak a hátralévő trackekre kell várni.
- A futás végén a Rekordboxban minden track az új útvonalon, a helyes tagekkel, coverrel, stílus playlistben és hot cue-kkal szerepel.

**Tesztelés**
- Vitest: az állapotgép átmenetei, a megszakítás és a folytatás minden állapotból, kamu lépésekkel.
- Kézzel: a teljes futás a valódi teszt készleten, majd a Rekordbox ellenőrzése (ez egyben a 45. feladat első része).

**Függőségek és kockázatok**
- Előtte: 9–35. feladat.
- Kockázat: a teljes könyvtárnál a közös preview 3000 sort és több fület tartalmaz. A 11. feladat virtualizálása és szűrői („Csak figyelmeztetések”) teszik átnézhetővé: elég a figyelmeztetéses sorokat egyenként megnézni.

### M. Csomagolás és kiadás

#### 41. Python runtime csomagolás

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 41 | Python runtime csomagolás | `scripts/build-python.sh`, `src/main/services/python-runtime.ts` | A Python környezet nincs az appba csomagolva, és nem frissíthető az apptól függetlenül | Egy .dmg-ből működjön minden | 🔴 | M |

**Jelenlegi állapot**
A dokumentáció szerint az Essentia és a Demucs beágyazott Python runtime-ként az appba csomagolva kerül a gépre, a végtermék egyetlen .dmg, és a Python környezet az apptól függetlenül frissül, így egy app frissítés nem tölti le újra a teljes környezetet. Fejlesztéskor a `python/.venv` működik (2. feladat).

**Probléma**
Egy virtuális környezet (`.venv`) nem helyezhető át másik útvonalra, ezért nem csomagolható be változatlanul. Apple Silicon Macen a módosított natív bináris aláírás nélkül nem indul el. Ha a környezet minden app frissítésben benne van, minden frissítés a teljes méretet tölti le.

**Megoldás**
1. `scripts/build-python.sh`:
    1. letölti a rögzített verziójú `python-build-standalone` CPython 3.11 `aarch64-apple-darwin` `install_only` csomagot a `build/python-runtime/` mappába,
    2. a függőségeket közvetlenül ebbe a runtime-ba telepíti: `uv export --frozen --no-dev > requirements.txt`, majd `uv pip install --python build/python-runtime/bin/python3 -r requirements.txt`, végül a `fixlib_py` csomagot is,
    3. bemásolja a Demucs súlyait a `build/python-runtime/torch-home/` mappába (28. feladat),
    4. a Python fájlokat előre lefordítja (`python -m compileall`),
    5. minden Mach-O binárist (`.so`, `.dylib`, futtatható fájlok) ad-hoc aláír: `codesign --force -s - <fájl>`,
    6. a runtime-ot egy `python-runtime-<runtime verzió>.tar.gz` archívumba csomagolja.
2. Runtime verzió: a `python/runtime-version.txt` fájlban, minden függőség vagy Python kód változásnál növelve.
3. `src/main/services/python-runtime.ts`:
    - a használt runtime helye: `~/Library/Application Support/FixLibrary/python/<runtime verzió>/`,
    - indításkor, ha a szükséges verzió nincs ott, az app kicsomagolja az appba csomagolt archívumból (teljes .dmg), vagy letölti a GitHub Release-ből (43. feladat),
    - kicsomagolás közben egy indító képernyő mutatja a haladást,
    - sikeres váltás után a régi runtime verziók törlődnek,
    - a 3. feladat bridge-e innen indítja a Pythont, a `TORCH_HOME` a runtime `torch-home` mappájára mutat.

**Elfogadási feltételek**
- Egy olyan felhasználói fiókban, ahol nincs Python, `uv` és Homebrew, a csomagolt app első indításkor kicsomagolja a runtime-ot, és a `ping`, a BPM elemzés és egy Demucs futás működik.
- `codesign -v` minden Mach-O fájlra hibátlan a runtime-ban.
- Az app internetkapcsolat nélkül is elindul és elemez (a teljes .dmg-ből telepítve).
- Egy új runtime verzió után a régi verzió mappája törlődik.

**Tesztelés**
- Kézzel: egy új, üres macOS felhasználói fiókban a csomagolt app telepítése és a fenti ellenőrzések.
- Automatikusan: a 44. feladat workflow-ja a build után egy `scripts/smoke-runtime.sh` scripttel elindítja a kicsomagolt runtime-ot, és lefuttatja a `ping` és a `analysis.bpm_key` hívást egy szintetikus fájlon.

**Függőségek és kockázatok**
- Előtte: 2., 3. és 28. feladat.
- Kockázat: egyes Python csomagok abszolút útvonalakat írnak a telepítéskor a fájljaikba. A runtime a `python-build-standalone` saját, áthelyezhető könyvtárában van, és a smoke teszt egy másik útvonalra kicsomagolva fut, így ez a hiba a buildnél kiderül.

#### 42. DMG build

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 42 | DMG build | `electron-builder.yml` | Nincs arm64 .dmg | Ez a végtermék | 🔴 | S |

**Jelenlegi állapot**
A dokumentáció szerint a végtermék egyetlen .dmg az M1 MacBook Pro-ra (csak arm64 build), Apple Developer fiók és aláírás nélkül, csak saját használatra. A 41. feladat után megvan a runtime archívum, az 5. feladat után a binárisok.

**Probléma**
Apple Silicon Macen egy egyáltalán nem aláírt app nem indul el. Az electron-builder alapbeállításai a natív modulokat (`better-sqlite3`) az `asar` archívumba tennék, ahonnan nem tölthetők be.

**Megoldás**
1. `electron-builder.yml`:
    - `appId: com.tamaskk.fixlibrary`, `productName: FixLibrary`,
    - `mac.target: dmg`, `mac.arch: arm64`, `mac.category: public.app-category.music`,
    - `mac.identity: "-"` (ad-hoc aláírás, Apple Developer fiók nélkül),
    - `asarUnpack: ["**/*.node"]` a natív modulokhoz,
    - `extraResources`: `resources/bin` (yt-dlp, ffmpeg, fpcalc, mp3gain), a Drizzle migrációk, és a `python-runtime-<verzió>.tar.gz`.
2. Két változat ugyanabból a configból (`scripts/build-dmg.sh`):
    - **teljes**: `FixLibrary-<verzió>-arm64.dmg`, a Python runtime archívummal, ez az első telepítéshez,
    - **lite**: `FixLibrary-<verzió>-arm64-lite.dmg`, runtime nélkül, ezt a 43. feladat frissítője tölti le, ha a runtime verzió nem változott.
3. Méret ellenőrzés: a script hibával kilép, ha a teljes .dmg eléri a 2 GiB-ot, mert a GitHub Releases ennél nagyobb fájlt nem fogad el.
4. Első indítás aláírás nélkül: egy böngészőből letöltött, nem hitelesített app első indításakor a macOS figyelmeztet. A macOS 15-től a jobb klikk → Megnyitás már nem elég, helyette: Rendszerbeállítások → Adatvédelem és biztonság → „Megnyitás mindenképp”. A frissítések (43. feladat) az appon belül töltődnek le, ezért azoknál ez a lépés nem jelenik meg. A lépés leírása a repo `README.md` fájljába kerül.

**Elfogadási feltételek**
- A `npm run build:mac` létrehozza a teljes és a lite .dmg-t, a teljes 2 GiB alatt van.
- A teljes .dmg-ből az Applications mappába húzott app az M1 gépen elindul (az első indítási lépés után), és minden funkció működik.
- A `codesign -dv /Applications/FixLibrary.app` ad-hoc aláírást mutat.
- A `better-sqlite3` modul betöltődik a csomagolt appban (az adatbázis létrejön).

**Tesztelés**
Kézzel: a teljes .dmg telepítése egy új felhasználói fiókban, első indítás, egy 5 trackes teljes futás.

**Függőségek és kockázatok**
- Előtte: 4., 5. és 41. feladat.
- Kockázat: ha a teljes .dmg a 2 GiB-os korlát fölé nőne, a runtime-ot külön archívumként kell letölteni az első indításkor, ami ellentmond az egy .dmg-s telepítésnek. A 2. feladat spike-ja ezért már az elején méri a környezet méretét.

#### 43. Félautomata frissítés

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 43 | Félautomata frissítés | `src/main/services/updater.ts` | Nincs verzió ellenőrzés, app frissítés és komponens frissítés (yt-dlp, Python környezet) | A yt-dlp a YouTube változásai miatt gyakori frissítést igényel | 🟠 | M |

**Jelenlegi állapot**
A dokumentáció szerint az app indításkor megnézi a GitHub Releases-t, letölti az új verziót és szól, a cserét egy kattintással megnyitott .dmg-ből te végzed. A Python runtime és a yt-dlp az apptól függetlenül, automatikusan, a háttérben frissül. A repo nyilvános (`tamaskk/fixlibrary`). A 41. és 42. feladat után megvannak a release fájlok.

**Probléma**
Aláírás nélkül a teljesen automatikus Electron frissítés nem működik. Független komponens frissítés nélkül minden yt-dlp javításhoz új app verzió kellene, és minden app frissítés a teljes runtime-ot letöltené.

**Megoldás**
1. Release fájlok (44. feladat készíti): a teljes és a lite .dmg, a `python-runtime-<runtime verzió>.tar.gz`, és egy `manifest.json` (app verzió, runtime verzió, minden fájl SHA-256 hash-e).
2. **App frissítés** (`src/main/services/updater.ts`):
    - indításkor és utána 24 óránként `GET https://api.github.com/repos/tamaskk/fixlibrary/releases/latest` (nyilvános repo, token nélkül),
    - ha a verzió nagyobb (semver), letölti a `manifest.json`-t, majd a lite .dmg-t, ha a runtime verzió nem változott, egyébként a teljeset, a `userData/updates/` mappába, és ellenőrzi a SHA-256 hash-t,
    - értesítés: „Új verzió: <verzió>. Megnyitás” gomb, ami `shell.openPath`-szal megnyitja a .dmg-t, és felajánlja az app bezárását, hogy az új verziót az Applications mappába húzhasd.
3. **Python runtime frissítés**: ha a manifest runtime verziója újabb, mint a telepített, a háttérben letöltődik a `python-runtime-<verzió>.tar.gz`, a hash ellenőrzés után kicsomagolódik a 41. feladat helyére, és a következő indításkor (vagy a futó feldolgozások után) aktiválódik.
4. **yt-dlp frissítés**: hetente, és amikor a 34. feladat kinyerési hibát jelez, `GET https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest`. Ha újabb, letölti a `yt-dlp_macos` fájlt és a release `SHA2-256SUMS` fájlját, ellenőrzi a hash-t, és a `userData/bin/yt-dlp` helyre teszi futtathatóként. Az 5. feladat útvonal feloldása ezt előnyben részesíti a csomagolt verzióval szemben.
5. A Settings „Rendszer” szekciójában látszik az app, a runtime és a yt-dlp verziója, és van „Frissítések keresése” gomb.

**Elfogadási feltételek**
- Egy régebbi verziójú telepített app indításkor jelzi az új verziót, letölti a lite .dmg-t (ha a runtime verzió azonos), és a megnyitás után a csere működik.
- Egy új runtime verziójú release után a runtime a háttérben frissül, a következő indítás már az új runtime-mal fut.
- Egy hibás hash-ű letöltés elvetődik, és nem települ.
- A yt-dlp frissítés után a Settings az új verziót mutatja, és a letöltés működik.

**Tesztelés**
- Vitest: a verzió összehasonlítás, a lite vagy teljes választás, a hash ellenőrzés, rögzített GitHub API válaszokkal (`msw`).
- Kézzel: egy `0.0.1` és egy `0.0.2` teszt release a repóban, a frissítési folyamat végigvitele.

**Függőségek és kockázatok**
- Előtte: 5., 41., 42. és 44. feladat.
- Kockázat: a GitHub API token nélkül óránként 60 kérést enged egy IP címről. Napi egy app és heti egy yt-dlp ellenőrzés ennél nagyságrendekkel kevesebb.

#### 44. Release workflow

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 44 | Release workflow | `.github/workflows/release.yml` | A .dmg buildelése és feltöltése kézi | Minden kiadás egyformán és hibamentesen készüljön | 🟡 | S |

**Jelenlegi állapot**
A release fájlokat a 41–42. feladat scriptjei készítik, a 43. feladat frissítője a GitHub Releases-ből olvas. Jelenleg a kiadás kézi.

**Probléma**
Kézi kiadásnál könnyű kihagyni egy lépést (például a manifest hash-eit vagy a lite .dmg-t), ami a frissítőt elrontja.

**Megoldás**
1. `.github/workflows/release.yml`, indítás `v*` tag pusholásakor, `macos-14` runneren (Apple Silicon).
2. Lépések:
    1. checkout, Node 22 (`actions/setup-node`), `npm ci`,
    2. `uv` telepítése, `scripts/fetch-binaries.sh`, `scripts/fetch-demucs-weights.sh`, `scripts/build-python.sh`,
    3. tesztek: `npm test`, `uv run pytest` (a valódi teszt készletet igénylő tesztek kimaradnak), `scripts/smoke-runtime.sh`,
    4. `scripts/build-dmg.sh` (teljes és lite),
    5. `manifest.json` generálása a SHA-256 hash-ekkel,
    6. `gh release create <tag> <fájlok> --generate-notes`.
3. A verzió a `package.json` `version` mezőjéből jön, a workflow ellenőrzi, hogy egyezik a taggel.

**Elfogadási feltételek**
- Egy `v0.0.1` tag pusholása után a release automatikusan létrejön a teljes és a lite .dmg-vel, a runtime archívummal és a manifesttel.
- Egy elbukó teszt megállítja a workflow-t, és release nem jön létre.
- A workflow-ban egyetlen API kulcs sem szerepel (a build nem igényel kulcsot).

**Tesztelés**
Kézzel: egy teszt tag (`v0.0.1-test`) pusholása, a release fájlok letöltése és a teljes .dmg telepítése.

**Függőségek és kockázatok**
- Előtte: 41. és 42. feladat.
- Kockázat: a GitHub által hosztolt runner tárhelye és ideje korlátozott, a teljes build (runtime + két .dmg) ezen belül marad, de ha nem, a Demucs súlyok és a runtime a `actions/cache`-ből jönnek a következő futásoknál.

### N. Tesztelés

#### 45. Teszt készlet és éles próba

| # | Feladat | Hol (fájl/modul) | Probléma | Miért fontos | Súly | Méret |
| --- | --- | --- | --- | --- | --- | --- |
| 45 | Teszt készlet és éles próba | `tests/fixtures/`, `tests/e2e/` | Nincs valós trackeken végzett teljes futtatás és Pioneer USB próba | Csak így derül ki, hogy a könyvtár CDJ-n, XDJ-n és DDJ-n is működik | 🔴 | M |

**Jelenlegi állapot**
A dokumentáció szerint a könyvtárnak CDJ-n, XDJ-n és DDJ-n is működnie kell USB-ről, az USB exportot a Rekordbox végzi. A teszt készletet (kb. 50 track), a `styles.csv` és a `cues.csv` fájlt te állítod össze. A 40. feladat után a teljes futás működik.

**Probléma**
A unit és E2E tesztek nem igazolják, hogy a Pioneer lejátszók valóban lejátsszák a konvertált fájlokat, és helyesen mutatják a covert, a hot cue-kat és a gridet. Egy hiba itt fellépésen derülne ki.

**Megoldás**
1. Teszt készlet a `tests/fixtures/real/` mappában (nem kerül a repóba): kb. 50 track, köztük rossz nevűek, WAV-ok (legalább egy 96 kHz-es), YouTube-ról letöltöttek, remixek és legalább 3 instrumentális track. Mellette a `styles.csv` (fájlnév, elsődleges stílus) és a `cues.csv` (10 track, fájlnév, slot, másodperc).
2. Teljes futás a teszt készleten clean library módban (40. feladat), egy külön célmappába a külső lemezen.
3. Rekordbox ellenőrzés: minden track az új útvonalon, a File → Display All Missing Files lista üres, a tagek, a cover, a stílus playlistek és a hot cue-k helyesek.
4. USB export a Rekordboxból egy pendrive-ra, majd lejátszás mindhárom lejátszó típuson (CDJ, XDJ, DDJ). Ellenőrző lista minden lejátszón, a `tests/LIVE_TEST.md` fájlban táblázatként (lejátszó típus és modell, ellenőrzött pont, eredmény):
    - MP3, eredetileg 44,1 kHz-es WAV-ból konvertált AIFF, és eredetileg 96 kHz-es WAV-ból konvertált 48 kHz-es AIFF lejátszása,
    - a cover megjelenése,
    - a hot cue-k A–H helye, neve és színe,
    - a BPM, a key és a grid,
    - az ékezetes nevek megjelenése,
    - a hangerő egyenletessége a trackek között (füllel, a keverő gain állításának változtatása nélkül).
5. A hibák új feladatként kerülnek a tervbe, a javításuk után az ellenőrző lista érintett sorai újra lefutnak.
6. A sikeres éles próba után következhet a teljes könyvtár feldolgozása.

**Elfogadási feltételek**
- A `tests/LIVE_TEST.md` minden sora sikeres mindhárom lejátszó típuson.
- A Rekordboxban nincs missing bejegyzés, és minden track tagjei, covere, stílus playlistje és hot cue-i helyesek.
- A 13., 21. és 29. feladat valódi teszt készletes kiértékelése teljesíti az ott megadott arányokat (BPM 95%, key 75%, stílus 85%, cue 80%).

**Tesztelés**
Ez a feladat maga a tesztelés: a fenti ellenőrző lista kézi végrehajtása.

**Függőségek és kockázatok**
- Előtte: a teljes futáshoz a 40. feladat. A teszt készlet már a 13. feladattól kell, a `styles.csv` a 21., a `cues.csv` a 29. feladattól.
- Kockázat: ha egy lejátszó modell egy formátumot nem kezel, a 18. feladat konverziós szabálya módosul (például minden AIFF 44,1 kHz-re), és a teszt készlet újra lefut.

---

## 3. Javasolt sorrend

A csomagok egymásra épülnek, a sorrendjük a függőségeket követi. Az időbecslés a feladatok méretéből jön: S = 1 nap, M = 2–5 nap, L = 5–10 nap (teljes, 8 órás munkanap, Claude Code-os agentic fejlesztéssel).

| Csomag | Tartalom | Feladatok | Becsült idő |
| --- | --- | --- | --- |
| 1. Alapok | Projekt váz, Python spike és sidecar, adatbázis, binárisok, Settings, logolás | 1, 2, 3, 4, 5, 6, 7 | 11–23 nap |
| 2. Pipeline keret | Könyvtár beolvasás és kijelölés, orchestrator, fájlműveletek és undo, batch preview, Claude CLI | 8, 9, 10, 11, 12 | 16–35 nap |
| 3. Fájlnév és tag | BPM és key, lookup, név, tag írás, duplikátumok, WAV → AIFF (innentől kell a teszt készlet) | 13, 14, 15, 16, 17, 18 | 13–27 nap |
| 4. Stílus és cover | Stílus besorolás, mappába rendezés, cover lookup, placeholder (a `styles.csv` itt kell) | 21, 22, 19, 20 | 6–12 nap |
| 5. Rekordbox integráció | XML író és olvasó, varázsló és missing takarítás | 25, 26, 27 | 5–11 nap |
| 6. Hot cue-k | Demucs, szerkezet felismerés és cue elhelyezés, waveform editor (a `cues.csv` itt kell) | 28, 29, 30 | 15–30 nap |
| 7. Energy | Energy feature-ök, kalibráció és 1–10 skála | 23, 24 | 4–10 nap |
| 8. Normalizálás | Loudness mérés, normalizálás, A/B lejátszó | 31, 32, 33 | 5–11 nap |
| 9. Letöltés | yt-dlp letöltő, Inbox feldolgozás | 34, 35 | 3–6 nap |
| 10. Playlistek | Hasonlósági motor, playlist kezelés, online ajánlás, generátor | 36, 37, 38, 39 | 11–25 nap |
| 11. Teljes pipeline | Egy gombos teljes futtatás | 40 | 1 nap |
| 12. Csomagolás | Python runtime, DMG, félautomata frissítés, release workflow | 41, 42, 43, 44 | 6–12 nap |
| 13. Éles próba | Teljes futás a teszt készleten, Rekordbox és Pioneer USB próba | 45 | 2–5 nap |
| **Összesen** | | **1–45** | **98–208 nap** |

A 6. csomag (hot cue-k) a 7. csomag (energy) elé került, mert a 24. feladat kalibrációs lejátszója a 30. feladat `fixlib-audio` protokollját használja, és mert a Demucs a legnagyobb technikai kockázat, amit érdemes minél előbb a valódi könyvtáron kipróbálni.
