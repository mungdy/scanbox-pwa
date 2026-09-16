# ScanBox PWA v1.1.6 QA Report

검토일: 2026-09-16 KST

## 검증 범위

v1.1.6은 v1.1.5의 문서 외곽 검출 / seamless 원근 보정을 유지하면서 다음 기능을 추가하거나 재구성한 버전입니다.

- 스캔 페이지 썸네일 정렬 / 번호 이동 / 즉시 삭제
- PDF 페이지 크기 `사진에 맞춤 / A4 / A3`
- OCR 언어 `KOR / ENG / CHI` 독립 선택 및 선택 기억
- OCR 검색 텍스트 교정
- 기존 변환 탭을 `PDF 편집` 탭으로 재구성
- PDF 여러 개 합치기 / 나누기 / 선택 추출 / 삭제 / 재정렬
- PDF 편집 페이지의 OCR 검색 텍스트 교정
- PDF → JPG / PNG 유지

## 정적 코드 검사

배포 소스에 대해 다음 검사를 수행했고 통과했습니다.

- `app.js`, `pdf-engine.js`, `secure-runtime.js`, `sw.js`, `theme-init.js` Node.js 문법 검사
- HTML 중복 ID 검사
- `app.js`의 고정 `#id` DOM 참조가 실제 HTML ID와 모두 연결되는지 검사
- `index.html`, `app.js`, `sw.js`, `secure-runtime.js`, `manifest.webmanifest`의 1.1.6 버전 일치 확인
- Service Worker `APP_SHELL`에 선언된 로컬 파일이 실제 패키지에 존재하는지 확인
- CSS 중괄호 구조 검사
- v1.1.4 이전 삼각형 mesh 보정 코드(`drawMappedTriangle`, `squareToQuadMapper`, 구형 `warpDocumentJs`) 부재 확인
- 스캔 탭의 구형 `importPdfToEditor` 경로 제거 확인
- `이미지 → PDF` 변환 UI 제거 확인

## 스캔 페이지 관리

- 여러 이미지 추가 후 `pageThumbList`에 썸네일이 표시되도록 구현했습니다.
- Pointer Event 기반 터치 Drag & Drop으로 아이폰에서도 정렬할 수 있는 구조입니다.
- 번호 입력으로 직접 페이지 위치를 변경할 수 있습니다.
- 썸네일에서 즉시 삭제할 수 있습니다.
- 기존 상세 페이지 카드의 드래그 정렬도 유지합니다.

실제 iPhone Safari의 터치 감도와 스크롤 충돌 여부는 기기 테스트가 필요합니다.

## PDF 페이지 크기 / 흰 여백

`pdf-engine.js`를 실제로 실행해 1000 × 1500 JPEG 한 장으로 PDF를 생성한 뒤 `pdfinfo`로 MediaBox를 확인했습니다.

- `사진에 맞춤`: 561.26 × 841.89 pt — 이미지 종횡비와 동일
- `A4`: 595.276 × 841.89 pt
- `A3`: 841.89 × 1190.551 pt

세 모드 모두 이미지 배치 행렬이 `(0, 0)`에서 PDF 페이지 전체 폭/높이를 사용하도록 생성됩니다. 따라서 기존처럼 A4 페이지 안에서 이미지를 `contain`해 상·하단에 흰 여백을 만드는 경로는 제거했습니다.

- `사진에 맞춤`: 비율 유지, 흰 여백 없음, 왜곡 없음
- `A4 / A3`: 고정 규격 페이지 전체를 채우므로 흰 여백 없음. 원본 비율과 규격 비율이 다르면 미세한 비율 정규화가 발생할 수 있음

마지막 선택은 `localStorage`에 저장됩니다. JPG/PNG 출력 시에는 PDF 페이지 크기 UI를 비활성화합니다.

## OCR 언어

- `KOR → kor`
- `ENG → eng`
- `CHI → chi_tra`

세 언어를 각각 독립 체크할 수 있으며 최소 하나는 항상 선택되어야 합니다. 선택 상태는 `localStorage`에 저장됩니다.

OCR 언어를 바꾸면 기존 페이지 OCR 결과를 무효화하고 OCR worker를 다시 생성합니다. 또한 `보안 · 오프라인 준비` 완료 기록을 초기화해 새로 선택한 언어 모델이 오프라인 준비 대상에 반영되도록 했습니다.

`@tesseract.js-data/chi_tra` 1.0.0 패키지의 존재는 공개 패키지 메타데이터로 확인했습니다. 실제 iPhone에서 KOR / ENG / CHI 조합별 OCR 정확도와 초기 다운로드 시간은 기기 테스트가 필요합니다.

## OCR 텍스트 교정

### 스캔 탭
`OCR 확인`의 텍스트를 수정하고 적용하면 페이지별 `editedText`로 저장됩니다. 검색 PDF 생성 시 해당 페이지는 보이는 스캔 이미지를 변경하지 않고 교정 텍스트를 숨김 `/ActualText` 레이어로 기록합니다.

### PDF 편집 탭
선택한 PDF 페이지의 기존 검색 텍스트를 PDF.js로 읽어 수정할 수 있습니다. 수정이 적용된 페이지만 고해상도 이미지로 다시 렌더링한 뒤 교정된 검색 레이어를 추가합니다.

이 동작은 **보이는 글씨를 수정하는 기능이 아닙니다.** 또한 OCR 텍스트 수정이 적용된 PDF 편집 페이지는 기존 벡터 구조가 이미지로 바뀔 수 있습니다.

PDF 엔진 단위 시험에서 `테스트 OCR 見積書 ABC 123`을 `/ActualText`로 기록한 PDF를 만들고 `pdftotext`로 동일 문자열이 추출되는 것을 확인했습니다.

## PDF 편집

v1.1.6은 구조 편집에 `pdf-lib` 1.17.1 UMD 빌드를 고정 버전 런타임 자산으로 사용하도록 구현했습니다.

지원 흐름:

- PDF 여러 개 추가
- 각 PDF를 PDF.js로 안전 렌더링해 썸네일 생성
- 현재 편집 순서대로 페이지 객체 복사 후 합치기
- Pointer Event 기반 Drag & Drop 순서 변경
- 번호 입력 순서 변경
- 다중 선택 / 선택 삭제
- 선택 페이지만 별도 PDF 추출
- `1-3, 4-6, 7` 형태 범위별 PDF 나누기
- 여러 분할 결과는 JSZip으로 ZIP 생성
- PDF → JPG / PNG

일반 구조 편집 페이지는 원본 페이지 객체를 복사하도록 작성되어 있습니다. 다만 디지털 서명, 문서 수준 메타데이터, 일부 폼/주석 등 모든 PDF 기능의 보존을 보장하지는 않습니다.

`pdf-lib` 1.17.1 UMD가 `window.PDFLib`을 제공하고 `PDFDocument.create/load/copyPages/save` API를 제공하는 구조는 공개 공식 문서와 패키지 정보를 기준으로 확인했습니다. 이 QA 환경은 외부 CDN 런타임 파일을 직접 다운로드해 브라우저 통합 실행하지 못했기 때문에 실제 iPhone PWA에서 여러 PDF를 합치는 end-to-end 시험은 필요합니다.

## 보안 / 오프라인 준비

- `pdf-lib`도 기존 외부 엔진과 동일하게 고정 버전 HTTPS URL → SHA-256 TOFU 잠금 → same-origin 가상 Cache Storage 실행 흐름을 사용합니다.
- 선택된 OCR 언어 데이터만 오프라인 준비 대상에 포함합니다.
- Service Worker 활성화 시 이전 `scanbox-*` Cache Storage를 삭제합니다.
- 앱 시작 시 이전 버전 `scanbox.offline-ready.v*`, `scanbox.vendor-pin.v*` 메타데이터를 정리합니다.
- 문서 이미지, PDF 원본, OCR 결과, 생성 PDF를 외부 서버로 전송하는 경로는 추가하지 않았습니다.

## 브라우저 런타임 확인 한계

이 컨테이너의 headless Chromium은 환경 문제로 페이지 로딩 전에 timeout되어 DOM 실행 검증에 사용할 수 없었습니다. 따라서 다음은 실제 iPhone Safari / 홈 화면 PWA에서 최종 확인이 필요합니다.

- 스캔 썸네일 Drag & Drop의 터치 감도
- PDF 편집 썸네일 Drag & Drop
- pdf-lib 최초 보안 준비 및 PDF 합치기 / 추출 / 나누기
- KOR / ENG / CHI 각 조합의 OCR 실행
- `사진에 맞춤` PDF가 실제 iOS 미리보기에서도 흰 여백 없이 보이는지
- OCR 텍스트 수정 후 iOS PDF 검색/복사 결과

정적 검사와 자체 PDF 생성 엔진 단위 시험은 통과했지만 위 iOS 전용 동작을 100% 보장하는 것은 아닙니다.
