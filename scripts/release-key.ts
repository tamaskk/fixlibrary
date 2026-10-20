// The release key of the updater (T-043). The app trusts a release only through
// `manifest.json` signed with this Ed25519 key; the private key never enters the repo.
//
//   npm run release:key -- keygen <private key path> [--force]
//       makes the key pair: the private key at the path (mode 600, never overwritten),
//       the public key into src/main/services/release-key.ts
//   npm run release:key -- manifest <release folder> <app version> <runtime version>
//       writes manifest.json naming the DMGs and the runtime archive with their SHA-256
//   npm run release:key -- sign <release folder> <private key path>
//       writes manifest.json.sig next to manifest.json, and checks it with the app's key
//   npm run release:publish -- <tag> [private key path]
//       signs the manifest of the draft release the workflow made (T-044), after checking
//       its build attestation, its tag on main, and that the release holds exactly the files
//       it names, byte for byte; uploads the signature and publishes it. A prerelease is
//       published unsigned.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  MANIFEST_NAME,
  MANIFEST_SIGNATURE_NAME,
  RELEASE_REPOSITORY,
  releaseFileNames,
  releaseManifestSchema
} from '../src/shared/release'

// npm runs it from the repository root.
const KEY_FILE = join(process.cwd(), 'src/main/services/release-key.ts')

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

function appPublicKey(): string {
  const match = /RELEASE_PUBLIC_KEY: string \| null = (`[^`]*`|null)/.exec(
    readFileSync(KEY_FILE, 'utf8')
  )
  if (!match || match[1] === 'null') fail('the app has no release key yet: run keygen first')
  return (match?.[1] ?? '').slice(1, -1)
}

const [command, ...args] = process.argv.slice(2)

if (command === 'keygen') {
  const [privatePath, flag] = args
  if (!privatePath) fail('name the path of the private key')
  if (existsSync(privatePath))
    fail(`${privatePath} exists; a release key is never replaced by accident`)
  const current = /RELEASE_PUBLIC_KEY: string \| null = (`[^`]*`|null)/.exec(
    readFileSync(KEY_FILE, 'utf8')
  )
  // A new key makes every installed app refuse the releases signed with it.
  if (current?.[1] !== 'null' && flag !== '--force') {
    fail(
      'the app has a release key already; a new one needs --force, and every installed app must be updated by hand'
    )
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  // Its folder is made for it, readable by the owner only.
  mkdirSync(dirname(privatePath), { recursive: true, mode: 0o700 })
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
    flag: 'wx'
  })
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim()
  try {
    const source = readFileSync(KEY_FILE, 'utf8').replace(
      /RELEASE_PUBLIC_KEY: string \| null = (`[^`]*`|null)/,
      `RELEASE_PUBLIC_KEY: string | null = \`${pem}\``
    )
    writeFileSync(KEY_FILE, source)
  } catch (error) {
    // A private key the app does not know is of no use: it does not stay.
    rmSync(privatePath, { force: true })
    throw error
  }
  console.log(`Private key: ${privatePath} (keep it out of the repo, and back it up)`)
  console.log('Public key written to src/main/services/release-key.ts')
} else if (command === 'manifest') {
  const [folder, appVersion, runtimeVersion] = args
  if (!folder || !/^\d+\.\d+\.\d+$/.test(appVersion ?? '') || !/^\d+$/.test(runtimeVersion ?? '')) {
    fail('usage: manifest <release folder> <app version> <runtime version>')
  }
  const names = [
    `FixLibrary-${appVersion}-arm64.dmg`,
    `FixLibrary-${appVersion}-arm64-lite.dmg`,
    `python-runtime-${runtimeVersion}.tar.gz`
  ]
  const files = names.map((name) => {
    const path = join(folder, name)
    if (!existsSync(path)) fail(`${path} is missing`)
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
    return { name, sha256, size: statSync(path).size }
  })
  const manifest = { appVersion, runtimeVersion: Number(runtimeVersion), files }
  writeFileSync(join(folder, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${join(folder, 'manifest.json')}`)
} else if (command === 'sign') {
  const [folder, privatePath] = args
  if (!folder || !privatePath) fail('usage: sign <release folder> <private key path>')
  const bytes = readFileSync(join(folder, 'manifest.json'))
  const signature = sign(null, bytes, createPrivateKey(readFileSync(privatePath)))
  // Checked with the key the app holds: a release the app would refuse is never published.
  if (!verify(null, bytes, createPublicKey(appPublicKey()), signature)) {
    fail('the private key is not the one the app trusts')
  }
  writeFileSync(join(folder, 'manifest.json.sig'), `${signature.toString('base64')}\n`)
  console.log(`Wrote ${join(folder, 'manifest.json.sig')}`)
} else if (command === 'publish') {
  const [tag, keyPath] = args
  const privatePath = keyPath ?? join(homedir(), '.fixlibrary/release-signing-key.pem')
  const match = /^v(\d+\.\d+\.\d+)(-[A-Za-z0-9.]+)?$/.exec(tag ?? '')
  if (!match || tag === undefined) fail('usage: publish <tag> [private key path]')
  const prerelease = match[2] !== undefined
  const gh = (ghArgs: string[]): string =>
    execFileSync('gh', [...ghArgs, '--repo', RELEASE_REPOSITORY], { encoding: 'utf8' })
  // The files of the release as GitHub holds them, each with the SHA-256 GitHub computed.
  const viewRelease = (): {
    isDraft: boolean
    isPrerelease: boolean
    assets: { name: string; size: number; digest: string | null }[]
  } => JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft,isPrerelease,assets']))
  const release = viewRelease()
  if (!release.isDraft) fail(`${tag} is published already`)
  if (release.isPrerelease !== prerelease) fail(`${tag} is not marked as its tag says`)
  // The tag is the owner's commit on main, and the one the workflow built.
  execFileSync('git', ['fetch', '--quiet', 'origin', 'main', `refs/tags/${tag}:refs/tags/${tag}`])
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', `${tag}^{commit}`, 'origin/main'])
  } catch {
    fail(`${tag} names a commit that is not on main`)
  }
  const runtimeVersion = Number(
    execFileSync('git', ['show', `${tag}:python/runtime-version.txt`], { encoding: 'utf8' }).trim()
  )
  const folder = mkdtempSync(join(tmpdir(), 'fixlibrary-release-'))
  try {
    gh(['release', 'download', tag, '--pattern', MANIFEST_NAME, '--dir', folder])
    const manifestPath = join(folder, MANIFEST_NAME)
    // Built by this repository's release workflow from this tag, not uploaded by hand.
    execFileSync(
      'gh',
      [
        'attestation',
        'verify',
        manifestPath,
        '--repo',
        RELEASE_REPOSITORY,
        '--signer-workflow',
        `${RELEASE_REPOSITORY}/.github/workflows/release.yml`,
        '--source-ref',
        `refs/tags/${tag}`
      ],
      { stdio: 'inherit' }
    )
    const bytes = readFileSync(manifestPath)
    const parsed = releaseManifestSchema.safeParse(JSON.parse(bytes.toString('utf8')))
    if (!parsed.success) fail(`the manifest is not valid: ${parsed.error.message}`)
    const manifest = parsed.data
    if (manifest.appVersion !== match[1])
      fail(`the manifest names ${manifest.appVersion}, not ${tag}`)
    if (manifest.runtimeVersion !== runtimeVersion) {
      fail(`the manifest names runtime ${manifest.runtimeVersion}, the tag ${runtimeVersion}`)
    }
    const names = Object.values(releaseFileNames(manifest))
    if (
      manifest.files.length !== names.length ||
      !names.every((name) => manifest.files.some((file) => file.name === name))
    ) {
      fail(`the manifest must name exactly ${names.join(', ')}`)
    }
    const sha256Of = (data: Buffer | string): string =>
      createHash('sha256').update(data).digest('hex')
    // What is signed is what the release holds: every file, byte for byte, and nothing else.
    const checkAssets = (
      assets: ReturnType<typeof viewRelease>['assets'],
      signature: string | null
    ): void => {
      const expected = new Map(manifest.files.map((file) => [file.name, file.sha256]))
      expected.set(MANIFEST_NAME, sha256Of(bytes))
      if (signature !== null) expected.set(MANIFEST_SIGNATURE_NAME, sha256Of(signature))
      for (const asset of assets) {
        const sha256 = expected.get(asset.name)
        if (sha256 === undefined || asset.digest !== `sha256:${sha256}`) {
          fail(`the release holds ${asset.name} not as the manifest names it`)
        }
      }
      for (const name of expected.keys()) {
        if (!assets.some((asset) => asset.name === name)) fail(`the release misses ${name}`)
      }
    }
    // A signature of an earlier, interrupted publish is replaced below; a prerelease has none.
    checkAssets(
      release.assets.filter((asset) => prerelease || asset.name !== MANIFEST_SIGNATURE_NAME),
      null
    )
    // A prerelease is never signed: its manifest names the version of the release to come,
    // and its signature would make a test build installable as that release.
    let signatureText: string | null = null
    if (!prerelease) {
      const signature = sign(null, bytes, createPrivateKey(readFileSync(privatePath)))
      if (!verify(null, bytes, createPublicKey(appPublicKey()), signature)) {
        fail('the private key is not the one the app trusts')
      }
      signatureText = `${signature.toString('base64')}\n`
      const signaturePath = join(folder, MANIFEST_SIGNATURE_NAME)
      writeFileSync(signaturePath, signatureText)
      gh(['release', 'upload', tag, signaturePath, '--clobber'])
    }
    gh(['release', 'edit', tag, '--draft=false'])
    // The release as published: nothing was swapped while it was being signed.
    checkAssets(viewRelease().assets, signatureText)
    console.log(
      `${tag} is ${prerelease ? 'published unsigned (prerelease)' : 'signed and published'}`
    )
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
} else {
  fail('usage: keygen | manifest | sign | publish (see the top of this file)')
}
