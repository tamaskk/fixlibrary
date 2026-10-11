import { defineConfig } from 'drizzle-kit'

// Only `drizzle-kit generate` uses this file; the app applies the migrations itself at startup.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/schema.ts',
  out: './src/main/db/migrations'
})
