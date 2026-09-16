# ScanBox PWA v1.1.2 QA Report

검토일: 2026-09-16 KST

## 이번 수정의 핵심 검증

- OpenCV 5.x 초기화가 `Promise` 객체인지 여부만 보지 않고 `then` 가능 객체(thenable)까지 기다리도록 수정했습니다.
- OpenCV 가속 엔진이 실패해도 `detectDocumentCornersJs()`와 `warpDocumentJs()`가 자동으로 사용되는 것을 정적 검사했습니다.
- 수동 4점 영역 조정에서 OpenCV 준비 여부 때문에 진입을 차단하던 조건을 제거했습니다.
- 내장 자동 문서 감지 알고리즘을 400 × 300 합성 이미지의 기울어진 사각 문서로 계산 테스트했습니다. 예상 모서리 `(55,40) / (340,25) / (365,255) / (38,270)`에 대해 `(52,37) / (343,23) / (367,258) / (36,272)`를 검출했습니다.
- 내장 원근 보정의 unit-square → quadrilateral projective mapping이 네 입력 모서리를 정확히 다시 매핑하는 수치 테스트를 통과했습니다.

## UI / 상태 검증

- 설정에 `시스템 / 라이트 / 다크` 화면 모드가 연결되어 있습니다.
- 화면 모드는 `localStorage`에 저장되며 초기 렌더 전에 `theme-init.js`가 적용합니다.
- 다크 모드용 배경, 카드, 입력, 시트, 진행창, 배지 색상 정의를 확인했습니다.
- `보안 · 오프라인 준비` 상태는 `준비 전 / 준비 중 / 완료 ✓ / 확인 필요`로 구분됩니다.
- 성공 상태는 앱 버전별 키로 저장되어 재실행 후에도 `완료 ✓`를 표시합니다.
- OpenCV 가속만 실패하고 OCR/PDF 필수 항목이 성공한 경우에는 전체 준비를 실패로 처리하지 않고 내장 문서 보정 엔진 사용을 안내합니다.

## 자동 정적 검사

다음 21개 항목을 자동 검사했고 모두 통과했습니다.

- HTML 중복 ID 없음
- JavaScript DOM 참조 누락 없음
- 원격 `<script src>` 없음
- 화면 모드 selector 존재
- 다크 테마 CSS 존재
- 오프라인 준비 완료 배지/설명 존재
- 오프라인 준비 상태 영속화 로직 존재
- OpenCV thenable 처리 존재
- 내장 JS 문서 모서리 검출 존재
- 내장 JS 원근 보정 존재
- 수동 영역 조정 OpenCV 차단 문구 제거
- OpenCV가 필수 오프라인 준비 항목에서 분리됨
- Service Worker 버전 1.1.2
- 보안 런타임 버전 1.1.2
- `theme-init.js` Service Worker app shell 포함
- CSP 존재
- PDF.js eval 비활성화
- SVG 입력 차단
- 앱 자체 코드에 XHR / WebSocket / sendBeacon 직접 전송 경로 없음
- manifest 버전명 1.1.2
- Service Worker app shell 파일 누락 없음

`app.js`, `secure-runtime.js`, `pdf-engine.js`, `sw.js`, `theme-init.js`, 로컬 JSZip은 모두 JavaScript 문법 검사를 통과했습니다.

## 검색 가능한 PDF 엔진 재검증

`pdf-engine.js`로 JPEG 1페이지와 한국어/영문 OCR 단어 좌표를 넣은 테스트 PDF를 다시 생성했습니다.

- PDF 1.7
- A4 1페이지
- JavaScript 없음
- 암호화 없음
- 텍스트 추출: `한글테스트`, `ABC` 확인

테스트용 PDF는 배포 ZIP에 포함하지 않습니다.

## 실기 테스트 한계

현재 작업 환경에서는 실제 iPhone Safari/PWA의 카메라, WebKit WASM, 홈 화면 PWA, iOS 공유 시트를 직접 조작할 수 없습니다. 따라서 아래 항목은 사용자 기기에서 최종 확인이 필요합니다.

- 카메라 촬영 후 자동 문서 감지
- 실제 사진에서 내장 fallback 감지 품질
- 수동 네 모서리 드래그 후 원근 보정
- OpenCV 가속 엔진 초기화 여부
- 보안 · 오프라인 준비 완료 상태
- 다크/라이트 전환 후 PWA 재실행 상태 유지
- 한국어 + 영어 OCR
- iOS 공유 / 파일에 저장

v1.1.2에서는 OpenCV가 실패해도 수동 영역 조정과 문서 보정 기능 자체가 차단되지 않도록 장애 격리를 적용했습니다.
