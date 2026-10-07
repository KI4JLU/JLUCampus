import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // `src/env.ts` parses the environment on import, and CI has no `.env`. Fixed values also keep
    // a developer's `.env` out of the tests. Nothing here reaches a real service.
    env: {
      DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test',
      COMPONENT_SECRETS_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
      BETTER_AUTH_URL: 'http://localhost:3000',
      BETTER_AUTH_SECRET: 'test-secret',
      CORS_ORIGINS: 'http://localhost:5173',
      KEYCLOAK_ISSUER: 'http://localhost:8080/realms/test',
      KEYCLOAK_CLIENT_ID: 'test',
      KEYCLOAK_CLIENT_SECRET: 'test',
      TRANSCRIPTION_S3_ENDPOINT: 'http://127.0.0.1:1',
      TRANSCRIPTION_S3_BUCKET: 'test-transcription',
      TRANSCRIPTION_S3_ACCESS_KEY: 'test',
      TRANSCRIPTION_S3_SECRET_KEY: 'test'
    }
  }
})
