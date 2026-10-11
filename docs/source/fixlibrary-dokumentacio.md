# FixLibrary – Dokumentáció

Oct 10, 2026 · @tamas

## Áttekintés

A FixLibrary egy Mac desktop app, ami egy DJ zenei könyvtárát rendbe teszi, és az eredményt Rekordboxban használható formában adja vissza. A könyvtár kb. 2700–3000 track, 90–95%-ban MP3, a többi WAV.

Fő funkciók:

1. Fájlnév és tag fixálás
2. Cover kép hozzáadása
3. Stílus szerinti mappába rendezés
4. Energy level meghatározás
5. Auto cue pointok és hot cue-k megadott séma alapján
6. Playlist létrehozás és track ajánlás meglévő playlistbe
7. Playlist generálás
8. Zene letöltés yt-dlp-vel
9. Hangerő normalizálás (loudness fix)

Minden funkció kimenete Rekordboxban használható kell legyen.

## Globális döntések

Az app a Rekordboxszal XML-en keresztül kommunikál, a `master.db`-hez nem nyúl.

| Téma | Döntés |
| --- | --- |
| Rekordbox integráció | Rekordbox XML export, a Rekordbox ezt importálja (Preferences → rekordbox xml). A 6-os és 7-es verzió XML-je azonos, így a pontos verzió nem blokkoló. |
| Könyvtár | \~2700–3000 track, 90–95% MP3, a maradék WAV |
| Meglévő Rekordbox adatok | Vannak meglévő cue-k és playlistek, de a playlisteket az új mappastruktúra alapján újratervezi |
| Fájlkezelési mód | Switch a GUI-ban: helyben módosítás VAGY másolat egy új „clean library” mappába, az eredeti érintetlen marad |
| AI | Claude CLI (Claude Code headless módban, `claude -p`). Feltétel: a Claude Code telepítve van és be van jelentkezve a Macen, külön API kulcs nem kell |
| Felület | GUI-s Mac desktop app |
| Végtermék | Macre telepíthető fájl (formátum a „Telepíthető Mac app” szekcióban) |

## 1. Fájlnév és tag fixálás

Minden track egységes fájlnevet és teljesen javított tageket kap, egy közös batch preview jóváhagyása után.

**Fájlnév formátum:** `Artist feat. X - Title (Mix) [8A Am - 124 - E7].mp3`

- A key Camelot és zenei jelöléssel is szerepel, a BPM egész számra kerekítve, az energy a 4. funkcióból jön.
- Az ékezetek és a speciális karakterek maradnak. Csak a fájlrendszer által tiltott karakterek cserélődnek (pl. `/`, `:`).
- Az „(Original Mix)” marad, minden más junk törlődik: „(Official Video)”, „\[Free Download\]”, „\[HD\]”, URL-ek és hasonlók.
- A feat. előadó az artist mezőbe kerül, nem a title-be.

**Folyamat trackenként:**

1. BPM és key meghatározása audio elemzéssel (pl. `essentia` vagy `keyfinder`).
2. Metadata online lookup: AcoustID fingerprint → MusicBrainz, majd Discogs. A Beatport scrapinggel kiegészítő forrás lehet.
3. Ha nincs online találat, a meglévő ID3 tagek az alap.
4. Junk tisztítás és feat. normalizálás.
5. A fájlnév és az összes tag frissítése: artist, title, album, label, year, BPM, key.

**Bizonytalan találat:** 70% alatti match confidence esetén a track meg van jelölve a preview-ban, és kézzel kell dönteni.

**Duplikátumok:** az app felismeri (fingerprint és artist + title alapján) és jelzi őket, automatikusan nem töröl.

**WAV → AIFF:** a WAV fájlok lossless módon AIFF-re konvertálódnak, így a tagek és a cover kép rendesen működnek a Rekordboxban.

**Batch preview:** egy listában látszik minden track: régi név → új név, az adat forrása (lookup vagy ID3), a confidence és a figyelmeztetések. Egyes sorok szerkeszthetők vagy kizárhatók, a jóváhagyás egyben történik.

**Rekordbox:** az átnevezés megtöri a régi útvonalakat. Az XML már az új útvonalakat tartalmazza, a régi bejegyzések a Rekordboxban „missing” állapotba kerülhetnek, ezek takarítása a playlist újratervezéssel együtt történik.

## 2. Cover kép hozzáadása

Minden track kap egy 600×600-as, fájlba ágyazott covert. Ahol már van kép, ott csak a 300×300 alattit cseréli.

**Mikor kerül be kép:**

- Nincs cover → kap egyet.
- Van cover, de 300×300 alatti → lecseréli.
- Van cover, és legalább 300×300 → marad.

**Források, ebben a sorrendben:**

1. iTunes Search API
2. Cover Art Archive (MusicBrainz)
3. Discogs
4. Beatport
5. YouTube thumbnail, csak a yt-dlp-vel letöltött trackeknél, négyzetesre vágva
6. Generált placeholder, ha egyik forrás sem ad találatot

**Formátum:** 600×600 JPEG, a fájlba ágyazva (MP3-nál és AIFF-nél ID3 APIC frame).

**Generált placeholder:** a track stílusához rendelt háttérszín, rajta az artist és a title. A stílust a 3. funkció határozza meg, ezért a placeholder generálása a stílus besorolás után fut.

**Preview:** a cover thumbnailként megjelenik ugyanabban a batch preview-ban, ahol a fájlnevek, a forrás jelölésével.

**Kézi csere:** drag & drop-pal bármelyik tracknek saját kép adható.

**Rekordbox:** importkor beolvassa a beágyazott képet. A már bent lévő trackeknél „Reload Tag” kellhet.

## 3. Stílus szerinti mappába rendezés

Minden track egy elsődleges stílust kap, ez határozza meg a mappáját. Ugyanez a struktúra playlist folderként a Rekordbox XML-ben is megjelenik.

**Stílusok:**

- House stílusok: Afro House, Organic House, Melodic House, Tech House, Latin House. A lista a beállításokban szerkeszthető.
- A nem house trackek is saját stílus mappát kapnak (például Techno, Disco, Hip-Hop), nem egy közös „Other” mappába kerülnek.
- A bizonytalan besorolású trackek az „Unsorted” mappába kerülnek.

**Mappastruktúra (példa):**

```
Library/
├── Afro House/
├── Organic House/
├── Melodic House/
├── Tech House/
├── Latin House/
├── Techno/
├── Disco/
└── Unsorted/
```

**Besorolás módja:**

1. Online lookupból jövő genre (Beatport, Discogs).
2. A track címe és mix neve.
3. Remixnél a remix verzió számít, nem az eredeti: a lookup a remix kiadást keresi, és a remixer stílusa dönt.
4. A végső döntést ezekből a Claude CLI hozza meg.

**Több stílus:** az elsődleges stílus dönti el a mappát, a másodlagos stílus a comment tagbe kerül.

**Genre tag:** az elsődleges stílus beíródik az ID3 genre mezőbe, így Rekordboxban oszlop szerint szűrhető.

**Bizonytalan besorolás:** az „Unsorted” mappába kerül, és a batch preview-ban kézzel lehet dönteni róla.

**Rekordbox:** a mappastruktúrából ugyanilyen playlist folder struktúra jön létre az XML-ben.

**Új trackek:** a később hozzáadott trackek (például a yt-dlp letöltések) automatikusan ugyanígy sorolódnak be.

## 4. Energy level

Minden track egy 1–10 közötti energy értéket kap, stíluson belül értve. Az érték a comment mezőbe és a fájlnévbe is bekerül.

**Skála:** 1–10, relatív: a 7-es érték a saját stílusán belül jelent magas energiát, így egy Organic House 7 és egy Tech House 7 nem azonos intenzitás.

**Számítás:**

1. Audio elemzés Essentia feature-ökkel: loudness, BPM, percussive energy, onset density, spectral jellemzők.
2. Kalibráció: kézzel besorolsz stílusonként néhány tracket (összesen kb. 20–30), és az app ehhez igazítja a skálát.
3. Az értékek stílusonként normalizálódnak 1–10 közé.

**Kimenet:** egy érték a teljes trackre, szakaszonkénti görbe nincs.

**Rekordbox:** a comment mezőbe kerül, a másodlagos stílussal együtt, például `E7 | Melodic House`.

**Fájlnév:** a formátum kiegészül az energyvel: `[8A Am - 124 - E7]`.

**Kézi felülírás:** az érték a batch preview-ban módosítható.

## 5. Auto cue pointok és hot cue-k

Minden track 8 fix helyű hot cue-t kap egy egységes séma szerint, a Rekordbox saját beatgridjére igazítva. Memory cue-k és loopok nincsenek.

**Séma (minden stílusra ugyanaz):**

| Hot cue | Név | Jelentés | Szín (javaslat) |
| --- | --- | --- | --- |
| A (1) | Start | A szám kezdete | Zöld |
| B (2) | Bassline | A bassline kezdete (általában 16 beat után) | Aqua |
| C (3) | Vocal | A vocal kezdete | Lila |
| D (4) | Drop 1 | Első drop | Piros |
| E (5) | Breakdown | Átmenet / breakdown | Kék |
| F (6) | Drop 2 | Második drop | Narancs |
| G (7) | Outro | Outro kezdete | Sárga |
| H (8) | Drop 3 | Extra drop, ha van | Rózsaszín |

Ha egy rész hiányzik a trackből (például nincs vocal), a helye üresen marad. Így minden tracknél ugyanaz a szám ugyanazt jelenti.

**Folyamat:**

1. A javított fájlok bekerülnek a Rekordboxba, ami lefuttatja a saját elemzését (beatgrid).
2. A könyvtár XML-be exportálódik a Rekordboxból.
3. Az app az XML-ből veszi a beatgridet, és szerkezet felismeréssel megkeresi a részeket (bassline, vocal, drop, breakdown, outro).
4. A cue-k a gridre és a phrase határokra (8/16/32 bar) igazodnak.
5. Az app új XML-t ír a cue-kkal, ezt importálja vissza a Rekordbox.

**Szerkezet felismerés:** a bassline és a vocal kezdetét stem separation (Demucs) alapján keresi, ez a pontosabb megoldás. A teljes könyvtár első feldolgozása Apple Silicon Macen kb. fél–egy nap, a háttérben fut, megszakítható és folytatható. Az új trackek egyenként, gyorsan feldolgozhatók.

**Meglévő cue-k:** felülíródnak.

**Waveform nézet:** a GUI-ban minden track waveformja látható a hot cue-kkal, ahol a cue-k mozgathatók és törölhetők, a mozgatás a gridhez illesztve történik.

## 6. Playlist létrehozás és ajánlás

Kézzel létrehozott playlisthez az app 10 hasonló tracket ajánl a saját könyvtárból és 10-et online, a playlist egészéhez illesztve.

**Működés:** létrehozol egy playlistet (például „Sunset set”), beraksz pár tracket, és az app ezek alapján ajánl. Az ajánlások egy kattintással hozzáadhatók.

**Hasonlóság alapja, prioritási sorrendben:**

1. Stílus
2. BPM tartomány
3. Key kompatibilitás (Camelot szomszédok)
4. Energy
5. Hangulat, amit a Claude CLI a metadata alapján ítél meg

**Ajánlás forrásai:**

- **Saját könyvtár**: 10 track, a fenti szempontok szerint rangsorolva.
- **Online**: 10 track a Claude CLI javaslataiból és a Beatport stílus listáiból. Minden javaslat Beatport vagy YouTube kereséssel ellenőrződik, így csak létező track jelenik meg. Az online trackek egy kattintással letölthetők a 8. funkcióval (yt-dlp), és a letöltés után automatikusan átesnek az 1–5. funkciókon.

**Viszonyítás:** az ajánlás a playlist egészéhez illik, nem az utolsó trackhez. A sorrend kialakítása a 7. funkció része.

**Rekordbox:** a playlistek az XML-ben egy külön „Playlists” folderbe kerülnek, a stílus folderek mellé.

## 7. Playlist generálás

Az app egy szöveges promptból vagy GUI paraméterekből teljes, sorba rendezett playlistet generál, megadott hosszal és energy görbével.

**Bemenet (mindkettő használható, akár együtt):**

- Szöveges prompt, például: „2 órás sunset set, Organic House-ból Afro House-ba, 118–124 BPM”. A promptot a Claude CLI értelmezi.
- GUI paraméterek: stílus(ok), hossz, BPM tartomány, energy görbe.

**Hossz:** megadható időtartamban (például 2 óra) vagy track számban.

**Energy görbe:**

- Előre megadott profilok: warm-up (lassan emelkedő), peak time (végig magas), sunset (hullámzó), closing (csökkenő).
- Saját görbe rajzolható a GUI-ban.

**Sorrend szabályok:**

1. Csak harmonikusan kompatibilis key-ek követik egymást (Camelot szomszédok).
2. Két track között legfeljebb ±3 BPM az ugrás.
3. A stílusváltások fokozatosak.
4. Az energy értékek a választott görbét követik.

**Források:** elsődlegesen a saját könyvtár. Ahol hiány van (például nincs elég 122 BPM-es Afro House), az app online trackeket javasol, amik a 8. funkcióval letölthetők.

**Ismétlés:** nem számít, hogy egy track szerepel-e már más playlistben.

**Szerkesztés:** generálás után bármelyik track cserélhető, az app a helyére a szabályoknak megfelelő alternatívákat ajánl. A kész playlist a „Playlists” folderbe mentődik, és bekerül a Rekordbox XML-be.

## 8. Zene letöltés yt-dlp-vel

Az app URL-ből vagy keresésből tölt le MP3 320-ba, a letöltött track automatikusan átmegy az összes funkción, és egy szerkeszthető preview után kerül a helyére.

**Források:** minden, amit a yt-dlp támogat, elsősorban YouTube, SoundCloud és Bandcamp.

**Bemenet:**

- URL beillesztés, egyesével vagy többet egyszerre.
- Keresés az appon belül artist és cím alapján. Ezt használják a 6–7. funkció online ajánlásai is.

**Formátum:** MP3 320. A forrás minősége ettől nem javul (a YouTube audio kb. 160 kbps-ig megy), de a könyvtár egységes marad.

**Minőség figyelmeztetés:** 128 kbps alatti forrásnál figyelmeztetés jelenik meg „Confirm” és „Decline” gombokkal.

**Duplikátum ellenőrzés:** letöltés előtt az app megnézi, hogy a track már megvan-e a könyvtárban, és ha igen, jelzi.

**Folyamat:**

1. Letöltés egy „Inbox” mappába.
2. Automatikus feldolgozás: fájlnév és tagek (1.), cover (2.), stílus (3.), energy (4.), hangerő normalizálás (9.).
3. Preview: minden adat és a célmappa látható, és minden módosítható.
4. Jóváhagyás után a track a stílus mappájába kerül.
5. A hot cue-k a Rekordbox elemzése után kerülnek rá az 5. funkció szerint.

## 9. Hangerő normalizálás

Az app minden tracket egy közös LUFS célszintre hoz, alapértelmezetten −11 LUFS-ra, limiter nélkül. A változás előtt és után A/B meghallgatással ellenőrizhető.

**Módszer (a beállításokban választható):**

- **Veszteségmentes** (alapértelmezett): mp3gain-szerű gain állítás átkódolás nélkül, 1,5 dB-es lépésekben.
- **Pontos**: átkódolás pontosan a célértékre, MP3-nál minimális minőségvesztéssel.

**Célszint:** alapértelmezetten −11 LUFS. Választható még a hangosabb −8 LUFS, vagy egyedi érték.

**Limiter:** nincs. Ha egy track limiter nélkül nem érhető el a célszintre (mert a felhúzástól clippelne), az app kihagyja és megjelöli a preview-ban.

**Preview:**

- A/B meghallgatás: az eredeti és a normalizált verzió között egy gombbal lehet váltani, ugyanazon a ponton.
- Mért értékek előtte és utána: integrated loudness (LUFS), true peak (dBTP), és a gain változás (dB).

**Rekordbox:** a Rekordbox saját Auto Gain funkciója (Preferences → Analysis) ettől függetlenül használható. A fájl szintű normalizálás akkor is számít, ha a trackeket más lejátszón vagy szoftverben (például CDJ-n USB-ről) játszod.

## Telepíthető Mac app

A FixLibrary egy Electron app, ami egyetlen .dmg fájlból települ, és minden függőség benne van, a Claude CLI kivételével.

| Téma | Döntés |
| --- | --- |
| Név | FixLibrary |
| Tech stack | Electron + React + TypeScript |
| Python részek | Az Essentia (elemzés) és a Demucs (stem separation, PyTorch) beágyazott Python runtime-ként az appba csomagolva |
| Külső eszközök | A yt-dlp és az ffmpeg az appba csomagolva |
| Claude | A gépre telepített, bejelentkezett Claude CLI, ez nem csomagolható az appba |
| Telepítő | Egy .dmg fájl, kb. 2–3 GB |
| Platform | MacBook Pro 13" Apple M1, csak arm64 (Apple Silicon) build. A Demucs a GPU-t (MPS) használja |
| Aláírás | Nincs Apple Developer fiók, első indításkor jobb klikk → Megnyitás kell. Csak saját használatra |
| Frissítés | Félautomata auto-update: indításkor az app megnézi a GitHub Releases-t, letölti az új verziót és szól, a cserét egy kattintással megnyitott .dmg-ből te végzed. A Python runtime és a yt-dlp az apptól függetlenül frissül, így egy app frissítés nem tölti le újra a teljes 2–3 GB-ot, a yt-dlp pedig gyakran frissíthető (a YouTube változásai miatt erre szükség van) |
