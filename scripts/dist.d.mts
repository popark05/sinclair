export const NODE_VERSION: string;
export const HELPER_APK_VERSION: string;
export const TARGETS: Record<string, { node: string; archive: string; exe: string; win: boolean }>;
export function defaultCacheDir(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
export function fetchNode(target: string, opts?: { version?: string; base?: string; cacheDir?: string; fetch?: typeof fetch }): Promise<{ exe: string; license: string; fromCache: boolean }>;
export function assembleDistributable(opts: {
  target: string; outDir?: string; version?: string; nodeBinary?: string; nodeLicense?: string; zip?: boolean; log?: (line: string) => void; bundlesDir?: string;
  nodeFetchOptions?: { version?: string; base?: string; cacheDir?: string; fetch?: typeof fetch }; helperApk?: string;
}): Promise<{ stageDir: string; zipPath?: string; files: string[] }>;
