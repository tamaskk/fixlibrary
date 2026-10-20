// The Ed25519 public key the releases are signed with (T-043), as PEM. The private key
// stays with the owner, outside the repository (scripts/release-keygen.sh writes both).
// Null: the app has no key yet and trusts no release, so it never updates itself.
export const RELEASE_PUBLIC_KEY: string | null = null
