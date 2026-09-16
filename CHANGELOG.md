# ScanBox Change Log

## v1.1.3 — 2026-09-16

### Document detection / perspective correction
- 첫 스캔에서 OpenCV 초기화를 실제로 기다리도록 비동기 대기 누락 수정
- 검출 해상도 1,600 px로 상향
- 다중 Canny + adaptive/Otsu threshold + contour 후보 점수화 적용
- contour 검출이 불충분할 때 HoughLinesP 기반 4변 fallback 추가
- 검출 후 각 변의 연속 gradient를 다시 탐색하는 edge refinement 추가
- 자동 검출 결과에 최소 inset을 적용해 얇은 배경 테두리 유입 감소
- OpenCV warp의 `BORDER_REPLICATE` 제거, 흰색 constant border 사용
- JS perspective fallback mesh 세분화
- 수동 4점 드래그 터치 범위 확대 및 확대경 추가

### OCR
- OCR 기본값 OFF
- 마지막 ON/OFF 선택을 `localStorage`에 저장
- OCR OFF에서는 OCR 확인/검색 PDF 선택 비활성화
- OCR 전용 렌더 해상도 상향
- 저장 이미지와 OCR 전처리 이미지를 완전히 분리
- OCR 입력에 grayscale + percentile contrast normalization 적용
- Tesseract PSM 3 기본, 낮은 신뢰도에서 PSM 6 재시도 후 더 나은 결과 선택
- OCR 기반 파일명 자동 추천 기능 삭제

### UI / Security
- 다크 모드에서 ON 토글 색상이 사라지는 CSS specificity 문제 수정
- 보안 · 오프라인 준비의 상태/동작을 하나의 컨트롤로 통합
- 외부 통신 허용 범위는 기존과 동일하게 고정 버전 엔진 다운로드용 jsDelivr만 허용
- 문서 이미지/OCR 결과/PDF의 외부 업로드 경로는 추가하지 않음

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
