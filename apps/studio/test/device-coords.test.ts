// 기기 화면 좌표(studio 03): 비율을 지켜 패널에 맞춘(object-fit contain) 화면의 표시 좌표 → 기기 픽셀. 여백(레터박스) 클릭은 무시.
import { describe, it, expect } from 'vitest';
import { toDevicePoint, fitRect } from '../src/renderer/src/device-coords.ts';

describe('fitRect', () => {
  it('세로로 긴 기기 화면은 패널 높이에 맞추고 좌우에 여백', () => {
    expect(fitRect({ width: 400, height: 600 }, { width: 1080, height: 2400 })).toEqual({ x: 65, y: 0, width: 270, height: 600 });
  });
});

describe('toDevicePoint', () => {
  const box = { width: 400, height: 600 };
  const natural = { width: 1080, height: 2400 };
  it('표시 좌표를 기기 픽셀로(반올림)', () => {
    expect(toDevicePoint({ x: 65, y: 0 }, box, natural)).toEqual({ x: 0, y: 0 });
    expect(toDevicePoint({ x: 200, y: 300 }, box, natural)).toEqual({ x: 540, y: 1200 });
    expect(toDevicePoint({ x: 335, y: 600 }, box, natural)).toEqual({ x: 1080, y: 2400 });
  });
  it('여백(화면 밖) 클릭은 undefined', () => {
    expect(toDevicePoint({ x: 10, y: 300 }, box, natural)).toBeUndefined();
    expect(toDevicePoint({ x: 390, y: 300 }, box, natural)).toBeUndefined();
  });
});
