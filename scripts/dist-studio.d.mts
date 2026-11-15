export const STUDIO_TARGETS: Record<'mac-arm64' | 'mac-x64', 'arm64' | 'x64'>;
export const STUDIO_APP_ID: string;
export const STUDIO_PRODUCT: string;
export const URL_SCHEME: string;
export function builderConfig(i: { version: string; appDir: string; outDir: string; resDir: string; electronVersion: string; arch: string }): {
  appId: string; productName: string; electronVersion: string; npmRebuild: boolean; asar: boolean; files: string[];
  directories: { app: string; output: string }; extraResources: Array<{ from: string; to: string; filter: string[] }>;
  protocols: Array<{ name: string; schemes: string[] }>; artifactName: string; mac: { identity: null; target: string[]; category: string };
};
export function distStudio(o?: { targets?: string[]; outDir?: string; dirOnly?: boolean; log?: (l: string) => void }): Promise<{ outputs: string[]; appDirs: string[] }>;
export function studioCliLauncher(app: string): string;
export const STUDIO_CLI_BINS: Record<string, string>;
