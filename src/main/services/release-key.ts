// The Ed25519 public key the releases are signed with (T-043), as PEM. The private key
// stays with the owner, outside the repository (`npm run release:key -- keygen` writes both).
// Null: the app has no key yet and trusts no release, so it never updates itself.
export const RELEASE_PUBLIC_KEY: string | null = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEATnhoAWT5FD43thZmamghm7h9aQ960UZkjoAxwTFhab4=
-----END PUBLIC KEY-----`
