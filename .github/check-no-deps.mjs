/**
 * 의존성이 0개로 남아 있는지 확인한다.
 *
 * "빌드 단계 없음 · 설치할 것 없음" 은 이 도구의 전제다 — 받아서 바로 실행되는 것이
 * 로컬 도구의 값어치이기 때문이다. 편의를 위해 패키지 하나를 넣는 순간 그 전제가 깨지는데,
 * 넣는 사람에게는 그 순간이 사소해 보인다. 그래서 사람이 아니라 검사가 지킨다.
 */
import fs from 'node:fs';

if (fs.existsSync('node_modules')) {
  console.error('node_modules 가 저장소에 들어 있습니다');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const names = Object.keys(deps);
if (names.length) {
  console.error(`의존성이 생겼습니다: ${names.join(', ')}`);
  process.exit(1);
}
console.log('의존성 0개 — 확인');
