// 기기 화면 좌표(studio 03): 스크린샷은 비율을 지켜 패널에 맞춰(object-fit: contain) 그리므로 좌우나 위아래에 여백이 생긴다.
// 표시 좌표 → 기기 픽셀은 그 여백을 빼고 배율로 나눈다. 여백 클릭은 기기 밖이라 undefined.
export interface Size { width: number; height: number }
export interface Point { x: number; y: number }

/** box 안에 natural 비율을 지켜 가장 크게 넣은 사각형(가운데 정렬) */
export function fitRect(box: Size, natural: Size): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const width = Math.round(natural.width * scale), height = Math.round(natural.height * scale);
  return { x: Math.round((box.width - width) / 2), y: Math.round((box.height - height) / 2), width, height };
}

export function toDevicePoint(p: Point, box: Size, natural: Size): Point | undefined {
  const r = fitRect(box, natural);
  if (p.x < r.x || p.y < r.y || p.x > r.x + r.width || p.y > r.y + r.height) return undefined;
  return { x: Math.round(((p.x - r.x) / r.width) * natural.width), y: Math.round(((p.y - r.y) / r.height) * natural.height) };
}
