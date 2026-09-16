# ScanBox PWA v1.1.7 QA Report

검증일: 2026-09-16 KST

## 범위

v1.1.7은 v1.1.6의 문서 외곽 검출, seamless 원근 보정, KOR/ENG/CHI OCR 및 PDF 구조 편집 기능을 유지하면서 스캔 페이지 UI를 단순화한 버전입니다.

주요 변경:
- 별도 `페이지 순서` 썸네일 영역 제거
- 페이지 카드의 `≡` 손잡이 Drag & Drop만으로 스캔 순서 변경
- `[번호] 페이지` 직접 입력 순서 이동
- 편집 결과 전체화면 미리보기
- 스캔 필터 `컬러 / 흑백 / 문서` 3개로 축소
- 삭제 버튼을 빨간색 위험 버튼으로 분리
- 설정 탭 OCR 언어 중복 표시 제거
- PDF 규격 A5 / B4 / B5 / Letter / Legal 추가
- PDF 편집 빈 상태 UI 단순화
- 보안 준비 완료 문구 간소화

## 정적 검사

- `node --check app.js` 통과
- `node --check sw.js` 통과
- `node --check secure-runtime.js` 통과
- `node --check pdf-engine.js` 통과
- HTML id 중복 검사: 중복 없음
- `app.js`, `sw.js`, `secure-runtime.js`, `manifest.webmanifest`, 화면 표기의 v1.1.7 버전 일치 확인
- 제거 대상 `pageThumbSection`, `pageThumbList`, `bindThumbDrag`, 설정 탭 `ocrLangSummary` 참조가 실행 코드에 남아 있지 않음을 확인

## 스캔 페이지 UI

코드 검증 기준:
- `≡` 버튼에만 `data-sort-handle`이 적용되어 터치 정렬 시작 영역이 명확함
- 정렬 중 DOM 카드 순서를 기준으로 `state.pages`를 다시 구성함
- `[번호] 페이지` input의 change 이벤트가 `moveScannerPage()`로 연결됨
- 번호는 1 ~ 전체 페이지 수 범위로 clamp됨
- 삭제 버튼은 다른 편집 버튼 그룹과 분리되고 위험 색상 스타일을 사용함

실제 iPhone/Android 터치 Drag & Drop은 컨테이너 환경에서 물리 기기 검증이 불가능하므로 최종 기기 확인이 필요합니다.

## 스캔 미리보기

- 페이지 이미지를 누르면 `scanPreviewSheet`가 열리도록 연결
- 현재 `previewUrl`을 사용하므로 영역 보정 / 회전 / 필터가 적용된 최신 편집 결과를 표시
- 이전 / 다음 버튼 지원
- 좌우 55 px 이상 스와이프로 페이지 이동 지원
- 처음 / 마지막 페이지에서 해당 방향 버튼 비활성화

## 필터

화면 노출 필터는 다음 3개만 유지했습니다.
- `컬러`: 추가 픽셀 필터 없음
- `흑백`: RGB를 luminance 기반 grayscale로만 변환
- `문서`: 기존 document 모드의 adaptive threshold/OpenCV 또는 JS fallback 유지

기존 `자동`, `그레이` 버튼은 UI에서 제거했습니다. 기존 강한 binary `흑백` 모드는 제거하고 흑백 버튼을 단순 grayscale 의미로 변경했습니다.

## PDF 페이지 크기

자체 PDF 엔진으로 각 규격 PDF를 실제 생성한 뒤 `/MediaBox`를 확인했습니다.

- 사진에 맞춤(1000 × 1500 테스트 이미지): 561.26 × 841.89 pt
- A3: 841.89 × 1190.551 pt
- A4: 595.276 × 841.89 pt
- A5: 419.528 × 595.276 pt
- B4: 728.504 × 1031.811 pt (257 × 364 mm)
- B5: 515.906 × 728.504 pt (182 × 257 mm)
- Letter: 612 × 792 pt
- Legal: 612 × 1008 pt

규격 모드는 이미지가 페이지 전체를 채우도록 생성하므로 별도 흰 여백을 추가하지 않습니다.

## OCR / 검색 PDF 회귀 검사

A4 테스트 PDF에 `테스트 OCR 見積書 ABC 123`을 검색 레이어로 넣어 생성 후 `pdftotext`로 다시 추출했고 동일 텍스트가 추출되는 것을 확인했습니다.

OCR 언어 선택은 스캔 탭의 KOR / ENG / CHI에서만 관리하며 설정 탭에는 중복 표시하지 않습니다.

## 보안 · 캐시

- `secure-runtime.js`, `sw.js`, 앱 코드 버전을 v1.1.7로 통일
- Service Worker는 활성화 시 이전 `scanbox-*` 버전 캐시를 정리
- 앱 시작 시 이전 버전 offline-ready / vendor-pin 메타데이터 정리
- 같은 v1.1.7에서 보안 준비가 완료되면 상태를 `준비 완료 ✓`로 표시
- 사용자가 직접 다시 누르지 않는 한 준비 작업을 자동 반복하지 않음

## 제한 / 실제 기기 확인 필요

다음 항목은 코드 및 정적 검사만 수행했고 실제 iOS/Android 기기 확인이 필요합니다.
- iPhone Safari/PWA에서 `≡` 손잡이 장거리 Drag & Drop 감각
- Galaxy Chrome/PWA에서 Pointer Event 기반 Drag & Drop
- 미리보기 sheet의 좌우 스와이프 감각
- 실제 카메라/사진 입력 시 문서 검출 정확도
- CHI OCR 모델의 실제 초기 다운로드 시간 및 메모리 사용량
- 대용량/암호화/특수 PDF 구조 편집
