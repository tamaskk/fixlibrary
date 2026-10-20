// The release key of the updater (T-043). The app trusts a release only through
// `manifest.json` signed with this Ed25519 key; the private key never enters the repo.
//
//   npm run release:key -- keygen <private key path>
//       makes the key pair: the private key at the path (mode 600, never overwritten),
//       the public key into src/main/services/release-key.ts
//   npm run release:key -- manifest <release folder> <app version> <runtime version>
//       writes manifest.json naming the DMGs and the runtime archive with their SHA-256
//   npm run release:key -- sign <release folder> <private key path>
//       writes manifest.json.sig next to manifest.json, and checks it with the app's key
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
  const [privatePath] = args
  if (!privatePath) fail('name the path of the private key')
  if (existsSync(privatePath))
    fail(`${privatePath} exists; a release key is never replaced by accident`)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
    flag: 'wx'
  })
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim()
  const source = readFileSync(KEY_FILE, 'utf8').replace(
    /RELEASE_PUBLIC_KEY: string \| null = (`[^`]*`|null)/,
    `RELEASE_PUBLIC_KEY: string | null = \`${pem}\``
  )
  writeFileSync(KEY_FILE, source)
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
} else {
  fail('usage: keygen | manifest | sign (see the top of this file)')
}
