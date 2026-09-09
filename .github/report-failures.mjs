/**
 * 실패한 검사를 GitHub 주석(annotation)으로 내보낸다.
 *
 * 워크플로 로그와 잡 요약은 저장소 **관리자만** 볼 수 있다. 주석만 공개로 읽히므로,
 * 실패한 검사의 이름과 그 아래 세부 내용을 주석에 담는다. 안 그러면 "리눅스에서 실패"
 * 라는 사실만 남고 무엇이 왜 깨졌는지는 아무도 알 수 없다.
 *
 * 워크플로 YAML 안에 인라인으로 쓰지 않는 이유: bash 큰따옴표 안의 자바스크립트 안의
 * 정규식이라 따옴표가 세 겹으로 겹친다. 실제로 한 번 망가뜨려 봤다.
 */
import fs from 'node:fs';

const path = process.argv[2] || 'test-output.txt';
let text;
try {
  text = fs.readFileSync(path, 'utf8');
} catch {
  console.log('::error::검사 출력을 읽지 못했습니다 — 검사가 아예 시작되지 못했을 수 있습니다');
  process.exit(0);
}

const lines = text.split('\n').map((l) => l.replace(/\r/g, ''));
const blocks = [];
lines.forEach((line, i) => {
  if (/^not ok/.test(line)) blocks.push(lines.slice(i, i + 12));
});

if (!blocks.length) {
  console.log('::error::실패한 검사를 찾지 못했습니다 — 검사 이전 단계에서 넘어졌을 수 있습니다');
  process.exit(0);
}

// GitHub 는 주석 하나를 한 줄로 받는다. 줄바꿈은 %0A 로 적어 넣는다.
for (const block of blocks.slice(0, 8)) {
  console.log(`::error::${block.join('%0A')}`);
}
