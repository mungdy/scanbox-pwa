# ScanBox PWA v1.1.1 QA Report

검토일: 2026-09-16 KST

## 통과한 정적 검사

- `app.js`, `secure-runtime.js`, `pdf-engine.js`, `sw.js`, 로컬 JSZip JavaScript 문법 검사
- `manifest.webmanifest` JSON 파싱
- HTML 중복 ID 0개 및 JavaScript DOM 참조 연결 검사
- 원격 `<script src>` 0개 확인
- Service Worker app shell 필수 파일 존재 확인
- CSP, iframe 런타임 차단, PDF.js `isEvalSupported:false`, `useWasm:false`, `enableXfa:false` 적용 확인
- SVG/SVGZ 입력 차단, PDF `%PDF-` signature, 파일/페이지/캔버스 상한 확인
- JPEG/PNG/WEBP 헤더 기반 해상도 사전 검사: 한 변 12,000 px / 약 50 MP 상한
- PDF 분석 및 개별 페이지 렌더링 30초 타임아웃
- 앱 자체 코드의 `eval`, `new Function`, XHR, WebSocket, `sendBeacon`, `document.write` 부재 확인
- Service Worker가 cross-origin 응답을 캐시하지 않는 구조 확인
- 프로젝트에 폰트 파일을 포함하지 않음

## 검색 가능한 PDF 엔진 테스트

`pdf-engine.js`로 JPEG 1페이지와 한국어/영문 OCR 단어 좌표를 넣은 테스트 PDF를 생성해 로컬 PDF 검사 도구로 확인했습니다.

- PDF 1.7, A4 1페이지
- JavaScript: 없음
- Form: 없음
- Encryption: 없음
- 텍스트 추출: `한글테스트`, `공급가액`, `ABC`, `1,200,000원` 확인

테스트용 임시 파일은 배포 ZIP에 포함하지 않습니다.

## 공급망 검사 범위

- OpenCV/Tesseract/PDF.js는 정확한 패키지 버전 URL로 고정
- 허용 네트워크 호스트는 최초 엔진 준비용 `cdn.jsdelivr.net`으로 제한
- redirect 최종 목적지도 동일 allowlist로 재검증
- HTML 응답을 엔진 파일로 오인해 실행하지 않도록 차단
- 최초 SHA-256 지문을 잠그고 이후 동일 버전 내용 변경 시 실행 중단

단, 사전 등록된 upstream SHA-256을 포함하는 구조는 아니므로 최초 정상 다운로드를 신뢰하는 TOFU 방식입니다.

## 실기 테스트 한계

이 환경에서는 실제 iPhone Safari의 카메라, PWA 홈 화면 설치, iOS 공유 시트를 직접 조작할 수 없습니다. 따라서 아래는 사용자 기기에서 최종 확인이 필요합니다.

- 카메라 호출
- OpenCV 최초 준비 및 자동/수동 문서 보정
- Tesseract 한국어 + 영어 OCR
- PDF.js PDF 불러오기/편집
- iOS 공유 시트 및 `파일에 저장`
- 홈 화면 PWA 업데이트/오프라인 재실행

정적 검증과 PDF 생성 smoke test는 통과했지만, 실제 iOS 런타임 호환성을 100% 보장한다는 의미는 아닙니다.
