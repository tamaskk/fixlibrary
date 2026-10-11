import { readFileSync } from 'fs'
import { parseEnv } from 'util'

/**
 * Reads a `.env` style file into an object. The values are deliberately not put into
 * `process.env`, where every child process would inherit them. A missing file is empty.
 */
export function readEnvFile(filePath: string): Record<string, string> {
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const values: Record<string, string> = {}
  for (const [name, value] of Object.entries(parseEnv(content))) {
    if (value !== undefined && value !== '') values[name] = value
  }
  return values
}
