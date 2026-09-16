# ScanBox PWA v1.1.8 QA Report

작성일: 2026-09-16 KST

## 변경 검증 범위

- 스캔 페이지 영역 조건부 표시
- PDF 편집 작업 영역 조건부 표시
- PDF 편집 `≡` 손잡이 기반 터치/포인터 순서 변경
- PDF → 이미지 미리보기 및 페이지별 90° 회전
- v1.1.8 캐시/보안 런타임 버전 일치

## 정적 검사

- `app.js`, `sw.js`, `secure-runtime.js`, `pdf-engine.js` JavaScript 문법 검사
- HTML에서 사용되는 주요 ID와 `app.js` 참조 연결 확인
- `APP_VERSION`, Service Worker cache version, secure runtime version, manifest 표시를 1.1.8로 통일
- ZIP 생성 전 `SHA256SUMS.txt` 재생성 및 검증

## 스캔 탭

- 초기 `scannerPagesSection`은 `hidden` 상태
- `renderPages()`에서 0장일 때 숨김, 1장 이상일 때 표시
- 전체 삭제 후 다시 0장이 되면 페이지 영역이 자동으로 숨겨짐

## PDF 편집 탭

- 초기에는 `PDF 추가` 진입점과 독립 `PDF → 이미지` 도구만 표시
- PDF 페이지가 생기면 `pdfEditorWorkspace`, `pdfEditorActions`, `pdfEditorInfo` 표시
- 모든 페이지 삭제/전체 비우기 후 편집 작업 영역을 다시 숨김
- 각 페이지의 `≡` 버튼만 Drag handle로 사용해 오조작을 줄임
- pointer move로 카드 DOM 순서를 바꾸고 pointer up에서 실제 `state.pdfEditor.pages` 순서를 동기화

## PDF → 이미지

- PDF 선택 후 최대 60페이지 미리보기 생성
- 페이지마다 수동 회전 상태(0/90/180/270°)를 독립 저장
- 미리보기/썸네일/이전·다음 이동 지원
- 저장 시 PDF 원래 rotation + 사용자가 지정한 수동 rotation을 합산해 렌더링
- JPG/PNG 단일 페이지는 단일 파일, 다중 페이지는 ZIP으로 저장
- 미리보기 닫기/완료 시 PDF document와 Object URL 정리

## 남은 실기기 확인 항목

정적/코드 검사는 수행했지만 실제 iPhone Safari 및 Android Chrome에서 다음은 최종 사용자 테스트가 필요합니다.

- 긴 PDF 목록에서 `≡` 터치 Drag & Drop의 조작감
- PDF → 이미지 미리보기 시 대용량 PDF 메모리 사용량
- 90° 회전 후 실제 JPG/PNG 방향이 사용자 기대와 일치하는지

