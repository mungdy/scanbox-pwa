# ScanBox PWA v1.2.0 QA Report

## 변경 범위
- 스캔/PDF 페이지 순서 손잡이를 굵고 둥근 상·하 분리 화살표 SVG로 변경
- 스캔 카드의 개별 회전 버튼 제거
- 스캔 전체화면 미리보기에 현재 페이지 90° 회전 추가
- 스캔 `전체 삭제` 옆에 `전체 회전` 추가
- 전체 회전 시 각 페이지 OCR 캐시 무효화 및 썸네일 재생성

## 정적 검증
- `app.js`, `sw.js`, `secure-runtime.js` JavaScript 문법 검사
- HTML id 중복 검사
- 주요 DOM id와 `app.js` 참조 일치 검사
- CSS 중괄호 균형 및 v1.2.0 override 적용 확인
- 앱/Service Worker/보안 런타임/manifest 버전 1.2.0 일치 확인
- 스캔 카드에 개별 `data-action="rotate"`가 남지 않는지 확인
- 미리보기 `scanPreviewRotate`, 전체 `rotateAllPagesBtn` 이벤트 연결 확인
- 스캔/PDF Drag 손잡이에 동일 SVG 아이콘 적용 확인
- SHA256SUMS 전체 검증 및 ZIP 무결성 검사

## 실기기 확인 권장
- iPhone/Android에서 굵은 상·하 화살표의 크기와 터치 영역
- 미리보기 회전 후 썸네일/저장 결과 방향 동기화
- 여러 장에서 `전체 회전` 반복 탭 시 90° 단위 회전

실제 iOS/Android 물리 기기 터치 체감은 이 환경에서 직접 검증할 수 없습니다.
