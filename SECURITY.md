# ScanBox v1.1.4 Security Notes

## 문서 보정 엔진의 장애 격리

v1.1.4는 OpenCV를 우선 문서 검출·원근 보정 엔진으로 사용하고, Service Worker가 페이지를 제어할 수 있게 되면 백그라운드에서 선행 초기화합니다. 자동 문서 보정 시에는 짧은 고정 대기시간 때문에 OpenCV를 조기에 포기하지 않고 실제 초기화 완료 또는 실패 판정까지 기다립니다.

OpenCV가 실제로 실패한 경우에도 촬영 문서를 외부 서버로 보내지 않습니다. 원근 보정은 브라우저 내부의 seamless WebGL projective sampling으로 전환하며, WebGL도 사용할 수 없는 예외 환경에서는 삼각형 mesh가 아닌 CPU inverse mapping을 최종 fallback으로 사용합니다. 수동 4점 보정 역시 로컬에서 동작합니다.

`보안 · 오프라인 준비`의 **완료 ✓**는 앱 셸과 필수 OCR/PDF 엔진의 로컬 준비 및 검증이 성공했다는 뜻입니다. OpenCV 가속은 실패해도 핵심 스캔 기능을 막지 않으며 UI에서 호환 보정 경로 사용을 알립니다.

## 목표
ScanBox는 선택한 문서/이미지를 별도 ScanBox 서버로 보내지 않고 브라우저 내부에서 처리하는 개인용 PWA를 목표로 합니다.

## 주요 방어
1. 외부 스크립트를 HTML에서 직접 실행하지 않음
2. 엔진 다운로드는 HTTPS + 정확한 버전 + 호스트 allowlist 적용
3. redirect 최종 호스트 재검증
4. SHA-256 TOFU 잠금 및 버전별 Cache Storage 분리
5. 최초 지문과 일치하는 자산은 same-origin 가상 URL에서 실행
6. 강한 CSP와 no-referrer
7. Service Worker는 제3자 네트워크 요청을 캐시하지 않음
8. PDF.js eval 비활성화 및 렌더링 용도로 제한
9. SVG 금지, PDF signature 검사, 크기/페이지/픽셀 제한, PDF 분석/페이지 렌더링 30초 타임아웃
10. 검색 PDF 생성은 자체 경량 PDF writer 사용
11. 새 버전 실행 시 구버전 `scanbox.offline-ready.v*` 및 `scanbox.vendor-pin.v*` localStorage 기록을 자동 정리
12. Service Worker 활성화 시 현재 버전을 제외한 구버전 `scanbox-*` Cache Storage 자동 삭제

## 네트워크가 발생하는 경우
최초 기능 사용 또는 `보안 · 오프라인 준비`에서 다음 실행 자산만 내려받습니다.
- OpenCV.js 5.0.0 (TechStark npm repack): cdn.jsdelivr.net
- Tesseract.js 7.0.0 / tesseract.js-core 7.0.0 / 언어 데이터: cdn.jsdelivr.net
- PDF.js 6.3.289: cdn.jsdelivr.net

사용자의 문서 이미지, OCR 결과, 생성 PDF를 이 호스트로 업로드하도록 구현하지 않았습니다.

## 업데이트 시 저장공간
앱 버전마다 Cache Storage 이름은 바뀌지만 Service Worker가 활성화될 때 이전 `scanbox-*` 캐시는 삭제합니다. v1.1.4부터는 이전 버전의 작은 SHA-256 pin/오프라인 준비 완료 localStorage 메타데이터도 현재 버전만 남도록 정리합니다. 따라서 정상적으로 새 Service Worker가 활성화된 상태라면 버전 업데이트마다 대용량 엔진 캐시가 계속 누적되는 구조는 아닙니다.

단, iOS/WebKit가 Service Worker 업데이트를 아직 활성화하지 못한 짧은 전환 구간에는 구버전과 신버전 캐시가 일시적으로 함께 존재할 수 있습니다. 새 버전이 활성화되면 정리됩니다.

## TOFU 한계
SHA-256은 최초 정상 다운로드 후 변경을 탐지합니다. 최초 다운로드 순간 공급망이 이미 침해되어 있다면 이를 독립적으로 판별하지 못합니다. 고보안 환경에서는 조직이 직접 검증한 엔진 파일과 사전 등록 SHA-256을 자체 호스팅해야 합니다.

## 호스팅 계정 위험
GitHub Pages 저장소가 탈취되거나 앱 코드가 변조되면 PWA 자체가 바뀔 수 있습니다. 저장소 2FA, 강한 비밀번호, 변경 이력 확인이 중요합니다.

## PWA의 한계
- 네이티브 코드 서명과 동일한 보장을 제공하지 않습니다.
- GitHub Pages에서는 커스텀 HTTP 보안 헤더를 자유롭게 설정하기 어렵기 때문에 CSP 일부는 meta 태그로 적용합니다.
- iOS가 Cache Storage / 사이트 데이터를 삭제할 수 있습니다.
- 브라우저/WebKit 자체 취약점은 앱에서 완전히 방어할 수 없습니다.

## 입력 제한
- 이미지 40 MB / 개
- 이미지 배치 200 MB
- PDF 120 MB
- PDF 분석 / 페이지 렌더링: 각 30초 타임아웃
- 작업 100 페이지
- PDF ↔ 이미지 다중 출력 60 페이지
- 캔버스 약 20 MP
- JPEG/PNG/WEBP 입력은 헤더에서 최대 한 변 12,000 px / 약 50 MP 사전 검사
- HEIC/HEIF는 브라우저 사전 헤더 파싱 한계로 파일 크기 및 디코딩 후 캔버스 상한으로 방어
- SVG 금지

이 제한은 악성/비정상 파일로 인한 메모리 고갈 위험을 줄이기 위한 것입니다.
