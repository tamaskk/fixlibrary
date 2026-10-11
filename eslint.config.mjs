import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      'release',
      'python',
      'resources/bin',
      'test-results',
      'playwright-report'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    // `electron-log/main` registers IPC handlers of its own, outside src/main/ipc/handle.ts.
    // The app logs through src/main/services/logger.ts, which uses the plain Node entry.
    //
    // The bare `cn` does not know the project's font sizes and drops them next to a
    // text color. Components use the configured one in src/renderer/lib/cn.ts.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/main/services/logger.ts', 'src/renderer/lib/cn.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron-log', 'electron-log/*'],
              message: 'Use src/main/services/logger.ts.'
            }
          ],
          paths: ['cn', 'cn/config', 'clsx', 'tailwind-merge'].map((name) => ({
            name,
            message: 'Use cn from @/lib/cn.'
          }))
        }
      ]
    }
  },
  {
    files: ['src/main/services/logger.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron-log', message: 'Import electron-log/node.' },
            { name: 'electron-log/main', message: 'Import electron-log/node.' },
            { name: 'electron-log/renderer', message: 'Import electron-log/node.' }
          ]
        }
      ]
    }
  },
  eslintConfigPrettier
)
