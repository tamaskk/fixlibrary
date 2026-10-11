import { safeStorage } from 'electron'

export interface SecretCipher {
  isAvailable: () => boolean
  encrypt: (plainText: string) => Buffer
  decrypt: (cipherText: Buffer) => string
}

/**
 * Encrypts with a key that macOS keeps in the user's Keychain. Usable only after the
 * app is ready. With ad-hoc signing the Keychain item belongs to one build, so a value
 * stored by another build may not decrypt; the caller treats that as unreadable.
 */
export const keychainCipher: SecretCipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plainText) => safeStorage.encryptString(plainText),
  decrypt: (cipherText) => safeStorage.decryptString(cipherText)
}
