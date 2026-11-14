import type { StudioApi } from '../../shared/studio-ipc.ts';

declare global {
  interface Window { sinclair: StudioApi }
}
