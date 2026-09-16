# Third-party components

ScanBox v1.1.6에서 사용하는 주요 외부 구성요소와 고정 버전입니다.

| Component | Version | Purpose | Runtime distribution |
|---|---:|---|---|
| JSZip | 3.10.1 | 여러 이미지 / 분할 PDF ZIP 생성 | 프로젝트에 로컬 포함 |
| OpenCV.js | OpenCV 5.0.0 via `@techstark/opencv-js` 5.0.0-release.1 | 문서 영역 검출, 원근 보정 가속 | 최초 필요 시 jsDelivr 고정 npm 버전을 HTTPS로 받아 TOFU SHA-256 잠금 |
| Tesseract.js | 7.0.0 | OCR orchestration | 최초 필요 시 jsDelivr 고정 npm 버전을 받아 TOFU SHA-256 잠금 |
| tesseract.js-core | 7.0.0 | WebAssembly OCR core | 고정 버전 core 파일을 앱 전용 런타임 캐시에 준비 |
| `@tesseract.js-data/kor` | 1.0.0 | Korean OCR data | `4.0.0_best_int/kor.traineddata.gz` |
| `@tesseract.js-data/eng` | 1.0.0 | English OCR data | `4.0.0_best_int/eng.traineddata.gz` |
| `@tesseract.js-data/chi_tra` | 1.0.0 | Traditional Chinese / Hanja-support OCR data | `4.0.0_best_int/chi_tra.traineddata.gz` |
| PDF.js / `pdfjs-dist` | 6.3.289 | PDF 안전 렌더링 / 텍스트 추출 / 썸네일 | jsDelivr 고정 npm 버전을 받아 TOFU SHA-256 잠금 |
| pdf-lib | 1.17.1 | PDF 페이지 복사, 합치기, 추출, 나누기, 순서 변경 | jsDelivr 고정 npm 버전을 받아 TOFU SHA-256 잠금 |

스캔 탭의 새 PDF 생성은 `pdf-engine.js`의 ScanBox 자체 경량 PDF writer를 사용합니다. 기존 PDF의 구조 편집은 pdf-lib를 사용합니다.

## 라이선스

- JSZip: MIT
- OpenCV / @techstark/opencv-js: Apache-2.0 계열
- Tesseract.js / tesseract.js-core: Apache-2.0
- @tesseract.js-data 언어 패키지: MIT
- PDF.js: Apache-2.0
- pdf-lib: MIT

JSZip 라이선스 텍스트는 `vendor/jszip/LICENSE.markdown`에 포함되어 있습니다. 런타임 다운로드 구성요소의 상세 라이선스 및 저작권 고지는 각 upstream 고정 버전을 따릅니다.

## 공급망 관련 주의

런타임 엔진은 HTML 원격 `<script>` 태그에서 직접 실행하지 않습니다. 고정 URL의 바이트를 먼저 다운로드하고 SHA-256 지문을 생성해 앱 버전별로 잠근 뒤, same-origin 가상 Cache Storage 경로에서 실행합니다.

이는 **사전 등록 공식 해시가 아니라 TOFU(Trust On First Use)** 방식이므로 최초 다운로드 시점의 배포 경로 자체를 독립적으로 검증하는 방식은 아닙니다.
