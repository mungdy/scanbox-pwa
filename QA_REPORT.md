# ScanBox PWA v1.1.4 QA Report

검토일: 2026-09-16 KST

## 이번 버전에서 확인한 수정

### 문서 검출 / 원근 보정
- 자동 문서 보정 시작 전에 4.5 ~ 5.5초짜리 단기 `waitForCv()`로 OpenCV를 조기에 포기하던 경로를 제거했습니다.
- Service Worker가 현재 페이지를 제어할 수 있게 되면 OpenCV를 백그라운드에서 선행 초기화하고, 실제 보정 요청에서는 OpenCV가 준비되거나 실패 판정이 날 때까지 기다립니다.
- OpenCV 후보 사각형 평가에 문서 내부/외부 RGB 경계 대비를 추가했습니다.
- 화면 가장자리 색 중앙값을 배경으로 추정해 종이 영역을 찾는 background-contrast mask를 OpenCV 후보군에 추가했습니다.
- 동일한 배경 대비 방식의 내장 JavaScript 후보 검출도 추가해 OpenCV 실패 시의 검출 경로를 보완했습니다.
- 검출 후 edge refinement와 미세 inset은 유지했습니다.
- v1.1.3의 `warpDocumentJs()` / `drawMappedTriangle()` / `squareToQuadMapper()` 삼각형 mesh 보정 구현이 `app.js`에서 완전히 제거된 것을 확인했습니다.
- OpenCV 실패 시 WebGL fragment shader가 destination pixel마다 하나의 projective homography로 source texture를 샘플링하는 `warpDocumentWebGl()`을 사용합니다. 삼각형별 2D canvas clip/draw 반복이 없으므로 이전 mesh 경계 seam이 생기는 구조를 제거했습니다.
- WebGL을 사용할 수 없는 환경은 삼각형 mesh가 아닌 CPU inverse mapping을 최종 fallback으로 사용합니다.
- 수동 4점 조정 확대경과 넓은 터치 허용 범위를 유지했습니다.

### UI
- 자동 문서 보정 / OCR 스위치의 ON 색상은 기존 파란색을 유지했습니다.
- 스위치 트랙을 44 × 26 px, thumb를 22 px로 조정하고 두꺼운 테두리를 제거했습니다.
- thumb 이동 easing, 그림자, 눌림 피드백, 라이트/다크 OFF 상태 대비를 정리했습니다.
- 체크박스는 완전히 `display:none` 처리하지 않고 시각적으로 숨겨 native label 동작과 키보드 포커스 가능성을 유지하도록 했습니다.

### 보안 · 오프라인 저장공간
- Service Worker는 활성화 시 현재 `scanbox-app-v1.1.4`, `scanbox-runtime-v1.1.4`를 제외한 구버전 `scanbox-*` Cache Storage를 삭제합니다.
- v1.1.4부터 앱 시작 시 구버전 `scanbox.offline-ready.v*`와 `scanbox.vendor-pin.v*` localStorage 메타데이터도 현재 버전만 남기도록 정리합니다.
- 문서 이미지, OCR 결과, 생성 PDF를 외부 서버로 업로드하는 네트워크 경로는 추가하지 않았습니다.

## 자동 정적 검사

다음 검사를 실행했습니다.

- `app.js`, `sw.js`, `secure-runtime.js`, `pdf-engine.js` Node.js 문법 검사 통과
- HTML 중복 ID 없음
- `app.js`에서 참조하는 DOM ID가 모두 `index.html`에 존재
- CSS 중괄호 수 일치
- 화면 표시, `app.js`, Service Worker, 보안 런타임, manifest 버전이 모두 1.1.4로 일치
- `drawMappedTriangle`, `squareToQuadMapper`, `warpDocumentJs` 코드가 배포 `app.js`에 존재하지 않음
- `warpDocumentWebGl`, `warpDocumentCpu`, `buildBackgroundContrastMask`, `scoreQuadBoundaryContrast`, `cleanupLegacySecurityMetadata` 존재 확인
- 파일명 자동 추천 관련 `suggestNameBtn`, `nameSuggestion`, `suggestFileName` 참조 없음
- 외부 URL은 고정 버전 jsDelivr 엔진 경로로 제한
- 네트워크 API 검색 결과: 외부 `fetch()`는 `secure-runtime.js`의 검증된 엔진 다운로드 경로에만 있고, Service Worker의 `fetch()`는 same-origin 앱 셸 처리에 사용
- XHR / WebSocket / `sendBeacon` 문서 전송 경로 없음

## 알고리즘 단위 검사

### Homography
서로 다른 원근 사각형 3개를 대상으로 `squareToQuadCoefficients()`와 동일한 계산식을 실행해 `(0,0)`, `(1,0)`, `(1,1)`, `(0,1)` 네 점이 각각 요청한 TL/TR/BR/BL에 1e-6 이하 오차로 매핑되는 것을 확인했습니다.

### 배경 대비 검출
유색 배경 위에 원근이 적용된 흰 문서를 만들고 내부에 강한 검은 표 가로/세로선을 다수 넣은 합성 RGBA 입력으로 v1.1.4의 JavaScript background-region 검출 알고리즘을 단위 시험했습니다. 내부 표선이 강한 상태에서도 종이 외곽에 해당하는 네 극점을 선택했고, 선택 영역은 합성 화면의 약 59.4%였습니다.

## PDF 엔진 재검증

`pdf-engine.js`에 120 × 160 JPEG 1페이지와 `한글테스트`, `ABC` OCR 단어 좌표를 넣어 테스트 PDF를 생성했습니다.

- PDF 1.7
- A4 1페이지
- JavaScript 없음
- 암호화 없음
- `pdftotext`에서 `한글테스트`, `ABC` 추출 확인

테스트용 JPG/PDF는 배포 ZIP에 포함하지 않습니다.

## 확인 한계

현재 컨테이너의 headless Chromium은 EGL/WebGL 그래픽 컨텍스트를 초기화하지 못해 실제 `warpDocumentWebGl()` shader 실행 결과를 화면으로 검증할 수 없었습니다. 따라서 다음 항목은 실제 iPhone Safari/PWA에서 확인이 필요합니다.

- 실제 카메라 사진의 4개 모서리 자동 검출률
- 흰 종이/유색 배경, 그림자, 원근이 큰 촬영에서 background-contrast mask의 개선 폭
- 이전에 보였던 삼각형 대각선 seam이 실제 iPhone 결과에서 완전히 사라졌는지
- iPhone WebGL에서 보정 이미지 상하 방향과 품질이 정상인지
- 자동 문서 보정 / OCR 스위치의 실제 터치 감각
- 홈 화면 PWA 업데이트 후 구버전 Cache Storage 정리

코드상 삼각형 mesh 원인은 제거했지만 실제 iPhone GPU/WebKit 결과까지 이 환경에서 100% 보장할 수는 없습니다.
