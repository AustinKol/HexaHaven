export const ClientEnv = {
  serverUrl: import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3000',
  // Opt-in: set VITE_DEV_UNLIMITED_MATERIALS=true to build without spending resources (default uses starting inventory).
  devUnlimitedMaterials:
    import.meta.env.DEV && (import.meta.env.VITE_DEV_UNLIMITED_MATERIALS ?? 'false').toLowerCase() === 'true',
} as const;
