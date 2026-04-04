export const ClientEnv = {
  serverUrl: import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3000',
  // Enabled by default for local development; set VITE_DEV_UNLIMITED_MATERIALS=false to disable.
  devUnlimitedMaterials:
    import.meta.env.DEV && (import.meta.env.VITE_DEV_UNLIMITED_MATERIALS ?? 'true').toLowerCase() !== 'false',
} as const;
