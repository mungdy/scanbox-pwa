# ScanBox Change Log

## v1.1.2 — 2026-09-16

### iPhone 문서 보정 호환성
- OpenCV 5.x의 Promise/thenable 초기화를 Safari에서도 안전하게 대기하도록 수정
- OpenCV 가속 실패 시 자동으로 내장 JavaScript 문서 감지·원근 보정으로 전환
- 수동 4점 영역 조정은 OpenCV 상태와 무관하게 항상 사용 가능
- 문서/흑백 필터도 OpenCV 실패 시 JS 경로를 즉시 사용해 불필요한 대기를 줄임

### UI / UX
- 설정에 시스템 / 라이트 / 다크 화면 모드 추가
- 다크 테마 전용 색상, 카드, 시트, 입력 UI 최적화
- 보안 · 오프라인 준비 상태에 `준비 전 / 완료 ✓ / 확인 필요` 배지 추가
- 필수 준비 성공 후 버튼을 `다시 확인`으로 변경하고 성공 상태를 기기에 저장

### 준비 로직 안정화
- OpenCV를 필수 엔진이 아닌 선택적 가속 엔진으로 분리
- OCR/PDF 필수 엔진 준비를 항목별로 계속 진행하여 하나의 실패가 나머지 준비를 중단하지 않도록 변경
- OpenCV 실패 시에도 내장 보정 엔진 사용을 명확히 표시

## v1.1.1 — 2026-09-16

### Security
- 외부 CDN `<script src>` 직접 실행 제거
- 실행 엔진을 정확한 버전 URL로 고정
- 허용 호스트/HTTPS 및 redirect 최종 목적지 검증
- 브라우저 SHA-256 기반 TOFU(최초 지문 잠금) 추가
- 검증된 실행 자산을 앱 전용 same-origin 가상 캐시에서 실행
- CSP 추가: 기본 self-only 실행, object/frame/form 차단, 네트워크 허용 범위 제한
- Referrer Policy `no-referrer`
- iframe 내부 실행 차단
- PDF.js `isEvalSupported: false`, `useWasm: false`, 자동 가져오기/스트리밍 제한
- PDF `%PDF-` signature 검사 + 분석/페이지 렌더링 30초 타임아웃
- SVG 이미지 입력 차단
- 파일/페이지/캔버스 상한 + JPEG/PNG/WEBP 해상도 헤더 사전 검사 추가
- Service Worker가 제3자 요청을 가로채거나 캐시하지 않도록 변경
- 오래된 ScanBox 캐시 자동 정리

### Privacy / Supply chain
- `pdf-lib`, `fontkit`, 원격 한글 폰트 제거
- 검색 가능한 PDF를 ScanBox 자체 경량 PDF 엔진으로 생성
- JSZip 3.10.1을 프로젝트에 로컬 포함
- OpenCV.js 5.0.0 (@techstark/opencv-js 5.0.0-release.1), Tesseract.js 7.0.0, PDF.js 6.3.289로 버전 고정

### Performance
- Tesseract.js 7 계열 사용
- 엔진 lazy-load 유지: 해당 기능을 실제로 쓸 때만 준비
- OCR worker 90초 유휴 후 종료
- pagehide 시 worker/Blob URL 정리
- 이미지 40 MB, 배치 200 MB, PDF 120 MB, 작업 100페이지, 다중 이미지 60페이지 제한
- 캔버스 약 2,000만 픽셀 상한

### Compatibility
- v1.1의 스캔, 수동 4점 보정, 필터, OCR, 검색 PDF, PDF 편집/변환, 파일명 추천, 드래그 정렬, 화질 설정 기능 유지
- 임시 작업 자동 저장은 계속 미포함
