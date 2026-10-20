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
//       that the release holds every file it names, uploads the signature and publishes it
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
  if (!match) fail('usage: publish <tag> [private key path]')
  // The draft the workflow made: its files as GitHub holds them.
  const release = JSON.parse(
    execFileSync('gh', ['release', 'view', tag as string, '--json', 'isDraft,assets'], {
      encoding: 'utf8'
    })
  ) as { isDraft: boolean; assets: { name: string; size: number }[] }
  if (!release.isDraft) fail(`${tag} is published already`)
  const folder = mkdtempSync(join(tmpdir(), 'fixlibrary-release-'))
  try {
    execFileSync(
      'gh',
      ['release', 'download', tag as string, '--pattern', 'manifest.json', '--dir', folder],
      {
        stdio: 'inherit'
      }
    )
    const bytes = readFileSync(join(folder, 'manifest.json'))
    const manifest = JSON.parse(bytes.toString('utf8')) as {
      appVersion: string
      files: { name: string; size: number }[]
    }
    if (manifest.appVersion !== match?.[1])
      fail(`the manifest names ${manifest.appVersion}, not ${tag}`)
    // What is signed is what the release holds: every file, at its size.
    for (const file of manifest.files) {
      const asset = release.assets.find((each) => each.name === file.name)
      if (asset?.size !== file.size)
        fail(`the release does not hold ${file.name} as the manifest names it`)
    }
    const signature = sign(null, bytes, createPrivateKey(readFileSync(privatePath)))
    if (!verify(null, bytes, createPublicKey(appPublicKey()), signature)) {
      fail('the private key is not the one the app trusts')
    }
    writeFileSync(join(folder, 'manifest.json.sig'), `${signature.toString('base64')}\n`)
    execFileSync(
      'gh',
      ['release', 'upload', tag as string, join(folder, 'manifest.json.sig'), '--clobber'],
      {
        stdio: 'inherit'
      }
    )
    execFileSync('gh', ['release', 'edit', tag as string, '--draft=false'], { stdio: 'inherit' })
    console.log(`${tag} is signed and published`)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
} else {
  fail('usage: keygen | manifest | sign | publish (see the top of this file)')
}
