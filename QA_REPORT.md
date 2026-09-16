# ScanBox PWA v1.1.10 QA Report

작성일: 2026-09-16 KST

## 변경 검증 범위

- 스캔 페이지 compact card 레이아웃
- 스캔/PDF 편집 Drag & Drop 시각 피드백
- 전용 `↕` 손잡이 기반 터치/포인터 정렬
- v1.1.8 기능 회귀 여부
- v1.1.10 캐시/보안 런타임 버전 일치

## 정적 검사

- `app.js`, `sw.js`, `secure-runtime.js`, `pdf-engine.js` JavaScript 문법 검사
- HTML 주요 ID와 `app.js` 참조 연결 확인
- `APP_VERSION`, Service Worker cache version, secure runtime version, manifest 표시를 1.1.10로 통일
- ZIP 생성 전 `SHA256SUMS.txt` 재생성 및 검증

## 스캔 페이지 UI

- 한 페이지 카드를 작은 문서 썸네일 + 오른쪽 컨트롤의 2열 compact layout으로 변경
- 썸네일은 `object-fit: contain`으로 전체 문서가 잘리지 않게 표시
- 썸네일 클릭 시 기존 전체화면 미리보기 유지
- 좁은 모바일 화면에서도 카드가 다시 대형 세로 이미지로 돌아가지 않도록 v1.1.10 responsive override 적용
- `현재/전체 페이지`, 필터 3종, 영역 조정, 회전, 삭제 기능 유지

## Drag & Drop

- Drag 중 검은색 테두리 + 투명 삽입 placeholder 적용

- 스캔 및 PDF 편집에서 `↕` 손잡이만 drag 시작점으로 사용
- drag 시작 시 카드 그림자/윤곽/투명도 변화로 잡은 항목을 강조
- 실제 삽입 위치에는 투명 `drop-indicator`만 유지해 레이아웃 재배치 기준으로 사용
- drag 중 상·하단 접근 시 자동 스크롤 지원
- pointer up 시 표시된 삽입 위치를 실제 배열 순서에 반영하고 indicator 정리

## v1.1.8 회귀 확인 항목

- 스캔 문서 0장일 때 페이지 영역 숨김
- PDF 0장일 때 PDF 편집 작업 영역 숨김
- PDF 편집 순서 번호 입력 / 선택 / 삭제 / 합치기 / 추출 / 나누기 유지
- PDF → 이미지 미리보기 / 페이지별 90° 회전 유지

## 남은 실기기 확인 항목

정적/코드 검사는 수행했지만 실제 iPhone Safari 및 Android Chrome에서 다음은 최종 사용자 테스트가 필요합니다.

- `↕` 손잡이를 길게 끌 때 카드 이동감과 투명 placeholder 기반 재배치가 손가락 동작과 자연스럽게 일치하는지
- 긴 페이지 목록에서 자동 스크롤 속도가 적절한지
- 320 ~ 430 px 폭의 작은 화면에서 compact card 버튼이 과밀하지 않은지


## v1.1.10 UI 검증
- 스캔/PDF 카드가 동일한 compact 2-column 레이아웃을 사용함.
- 스캔 컨트롤 5개가 한 줄에 유지됨.
- 삭제 버튼은 카드 우측 상단의 danger 스타일로 분리됨.
- Drag 중 검은색 테두리를 사용하고 drop indicator는 투명 placeholder로만 동작함.
- 스캔/PDF 페이지 번호는 `현재/전체 페이지`로 표시되며 현재 숫자 입력 이동을 유지함.
- PDF bulk toolbar는 줄바꿈 없이 한 줄로 유지되며 좁은 화면에서는 가로 스크롤 가능함.
