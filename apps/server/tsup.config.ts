import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/migrate.ts', 'src/admin.ts'],
  format: ['esm'],
  target: 'node22',
  noExternal: ['@justcampus/shared'],
  clean: true
})
