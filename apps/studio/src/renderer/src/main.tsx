// 렌더러 진입: astryx 기본 스타일 → 테마 → 작업 화면. window.sinclair 는 preload 가 노출한 좁은 API(StudioApi)뿐이다.
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core/theme';
import { themes, defaultThemeSlug } from './astryx-themes.ts';
import { Workspace } from './Workspace.tsx';

createRoot(document.getElementById('root')!).render(
  <Theme theme={themes[defaultThemeSlug]}>
    <Workspace api={window.sinclair} />
  </Theme>,
);
