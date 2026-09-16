# ScanBox PWA v1.1.3 QA Report

검토일: 2026-09-16 KST

## 이번 버전에서 확인한 수정

### 문서 검출 / 원근 보정
- v1.1.2에서 `waitForCv()`를 호출만 하고 기다리지 않던 경로를 수정해, 자동 보정 시작 전에 최대 5.5초 동안 OpenCV 가속 초기화를 실제로 기다립니다.
- OpenCV 검출기는 여러 Canny 조건, adaptive threshold, Otsu threshold의 contour 후보를 함께 평가합니다.
- contour 후보가 충분하지 않을 때 `HoughLinesP` 기반 4변 fallback을 시도하도록 추가했습니다.
- 검출 후 네 변 주변의 평균 gradient가 강한 위치를 다시 찾는 edge refinement를 추가했습니다.
- 자동 검출 결과에는 아주 작은 inset을 적용해 원근 보정 시 문서 밖 배경이 얇게 끼는 현상을 줄이도록 했습니다.
- OpenCV `warpPerspective()`의 border를 `BORDER_REPLICATE`에서 흰색 `BORDER_CONSTANT`로 변경했습니다.
- 내장 JS perspective fallback mesh를 기존보다 촘촘하게 변경했습니다.
- 수동 네 모서리 조정의 터치 허용 범위를 넓히고 드래그 확대경을 추가했습니다.

### OCR
- OCR 기본값이 OFF인지 코드와 HTML 초기 상태를 확인했습니다.
- 마지막 OCR ON/OFF 상태를 `localStorage`에 저장하고 다음 실행에서 읽는 로직을 확인했습니다.
- OCR OFF에서는 `OCR 확인` 버튼 및 `검색 가능한 PDF` 옵션이 비활성화됩니다.
- OCR용 렌더 해상도를 높이고 저장용 이미지와 별도 canvas에서 grayscale + percentile contrast normalization을 수행하도록 분리했습니다.
- Tesseract 기본 PSM 3을 적용하고, 텍스트/신뢰도 점수가 낮을 때 PSM 6으로 한 번 더 인식해 점수가 더 높은 결과를 선택하도록 했습니다.
- OCR 기반 파일명 자동 추천 관련 DOM 및 JavaScript 경로가 제거된 것을 확인했습니다.

### UI
- 다크 모드에서 일반 `.toggle-line i` 규칙이 checked 배경색을 덮던 CSS 우선순위 문제를 별도 checked 규칙으로 수정했습니다.
- `보안 · 오프라인 준비`를 상태 배지와 별도 버튼 두 요소가 아니라 하나의 클릭 가능한 컨트롤 안에서 상태와 동작을 표시하도록 변경했습니다.

## 자동 정적 검사

다음 검사를 실행했습니다.

- `app.js`, `sw.js`, `secure-runtime.js`, `pdf-engine.js` Node.js 문법 검사 통과
- HTML 중복 ID 없음
- `app.js`에서 참조하는 `#id`가 모두 `index.html`에 존재
- 파일명 자동 추천 관련 `suggestNameBtn`, `nameSuggestion`, `suggestFileName` 참조 없음
- `app.js`, Service Worker, 보안 런타임, manifest, 화면 표시 버전이 모두 1.1.3으로 일치
- 외부 실행 자산 URL은 jsDelivr 고정 버전 경로로 제한
- 앱 자체 전송 API 검색 결과: 외부 `fetch()`는 `secure-runtime.js`의 검증된 엔진 다운로드 경로에만 존재하며, Service Worker의 `fetch()`는 same-origin 앱 파일 처리에 사용됨
- XHR / WebSocket / `sendBeacon` 문서 전송 경로 없음

## PDF 엔진 재검증

`pdf-engine.js`에 120 × 160 JPEG 1페이지와 `한글테스트`, `ABC` OCR 단어 좌표를 넣어 테스트 PDF를 생성했습니다.

- PDF 1.7
- A4 1페이지
- JavaScript 없음
- 암호화 없음
- `pdftotext`에서 `한글테스트`, `ABC` 추출 확인

테스트용 PDF는 배포 ZIP에 포함하지 않습니다.

## 확인 한계

현재 작업 환경에서는 실제 iPhone Safari/PWA의 카메라와 WebKit에서 촬영 문서를 직접 조작할 수 없습니다. 따라서 아래는 사용자 기기에서 실기 확인이 필요합니다.

- 실제 촬영 문서에서 4개 모서리 자동 검출률
- 흰 종이/유색 배경, 그림자, 원근이 큰 촬영에서 배경 유입 정도
- 평행사변형 형태의 반복 흔적이 실제 iPhone 결과에서 사라졌는지
- 확대경을 이용한 수동 4점 드래그 감각
- 한국어/영어 혼합 문서의 OCR 정확도 개선 폭
- 홈 화면 PWA 업데이트 및 Service Worker 캐시 교체

이번 수정은 위 현상들의 코드상 원인을 직접 수정했지만, 실제 카메라 조건별 검출 정확도를 100% 보장하는 검증은 아닙니다.
