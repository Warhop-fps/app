/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버가 쓰는 맵. 브라우저와 같은 맵 데이터(js/maps)와 같은 충돌 빌더(buildCollision)로 물리 월드를 만들고,
 *          가림막 없는 서버 시험장(arena)을 더한다. 만든 월드는 맵마다 한 번만 만들어 방끼리 나눠 쓴다.
 */
/**
 * 월드를 방끼리 나눠 써도 되는 이유: 충돌체는 만든 뒤 바뀌지 않고, physics.js가 쓰는 작업 버퍼는 함수 한 번 안에서만 쓰인다.
 * node는 한 스레드라 두 방의 계산이 겹치지 않는다.
 */
import { MAP_IDS, TEST_MAP, getMap } from '../../js/maps/index.js';
import { buildCollision } from '../../js/maps/collision.js';

const R90 = Math.PI / 2;

/**
 * 서버 시험장: 40 m × 28 m 평지, 가림막 없음. 두 팀이 12 m 떨어져 마주 본다.
 * 가짜 클라이언트는 맵을 모르고 곧장 겨누므로 시험과 데모는 이 맵을 쓴다.
 */
export const ARENA = Object.freeze({
  id: 'arena',
  name: '서버 시험장',
  nameEn: 'Server Arena',
  desc: '권위 서버 시험용 평지. 가림막이 없다',
  rulesets: ['classic', 'knife', 'sniper'],
  size: { x: 40, z: 28 },
  theme: { ground: 'concrete' },
  spawns: {
    owner: [-4.5, -1.5, 1.5, 4.5].map((z) => ({ x: -6, z, rotY: -R90 })),
    charterer: [-4.5, -1.5, 1.5, 4.5].map((z) => ({ x: 6, z, rotY: R90 }))
  },
  solids: [],
  decor: []
});

/** 방을 만들 때 고를 수 있는 맵 id */
export const MAP_CHOICES = Object.freeze([...MAP_IDS, TEST_MAP.id, ARENA.id]);

const cache = new Map();

/** 맵 데이터(없으면 null) */
export function mapData(id) {
  if (id === ARENA.id) return ARENA;
  return getMap(id);
}

/**
 * 맵 id → { id, name, rulesets, world, spawns, fallback }. 모르는 id면 null.
 * fallback = 브라우저와 같이 맵 파일을 못 불러 테스트 맵으로 대신했다(js/maps/index.js).
 */
export function loadMap(id) {
  if (cache.has(id)) return cache.get(id);
  const data = mapData(id);
  if (!data) return null;
  const built = buildCollision(data);
  const out = Object.freeze({
    id,
    name: data.name || id,
    rulesets: Array.isArray(data.rulesets) ? data.rulesets.slice() : ['classic', 'sniper'],
    world: built.world,
    spawns: built.spawns,
    fallback: !!data.fallback
  });
  cache.set(id, out);
  return out;
}
