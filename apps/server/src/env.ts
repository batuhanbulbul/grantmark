/** Loads the repository's `.env` file into `process.env`, if there is one. */
export function loadEnvFile(): void {
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
