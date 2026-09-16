# Third-party components

ScanBox v1.1.2에서 사용하는 주요 외부 구성요소와 고정 버전입니다.

| Component | Version | Purpose | Runtime distribution |
|---|---:|---|---|
| JSZip | 3.10.1 | 여러 이미지 ZIP 생성 | 프로젝트에 로컬 포함 |
| OpenCV.js | OpenCV 5.0.0 via `@techstark/opencv-js` 5.0.0-release.1 | 문서 영역 검출, 원근 보정, 문서 필터 | 최초 필요 시 jsDelivr 고정 npm 버전을 HTTPS로 받아 TOFU SHA-256 잠금 |
| Tesseract.js | 7.0.0 | OCR orchestration | 최초 필요 시 jsDelivr 고정 npm 버전을 받아 TOFU SHA-256 잠금 |
| tesseract.js-core | 7.0.0 | WebAssembly OCR core | 일반/SIMD/Relaxed-SIMD 계열 core 파일을 고정 버전으로 준비 |
| `@tesseract.js-data/kor` | 1.0.0 | Korean OCR data | 고정 npm 버전의 `kor.traineddata.gz` |
| `@tesseract.js-data/eng` | 1.0.0 | English OCR data | 고정 npm 버전의 `eng.traineddata.gz` |
| PDF.js / `pdfjs-dist` | 6.3.289 | PDF 페이지 렌더링 | 최초 필요 시 jsDelivr 고정 npm 버전을 받아 TOFU SHA-256 잠금 |

PDF 생성은 `pdf-engine.js`의 ScanBox 자체 경량 PDF writer를 사용합니다. 검색 가능한 한글 PDF를 만들기 위해 별도의 폰트 파일을 배포하지 않습니다.

## 라이선스

- JSZip: MIT
- OpenCV / @techstark/opencv-js: Apache-2.0 계열 고지에 따름
- Tesseract.js / tesseract.js-core: Apache-2.0
- @tesseract.js-data 언어 패키지: MIT
- PDF.js: Apache-2.0

JSZip 라이선스 텍스트는 `vendor/jszip/LICENSE.markdown`에 포함되어 있습니다. 런타임에 내려받는 구성요소의 상세 라이선스 및 저작권 고지는 각 upstream 패키지의 고정 버전을 따릅니다.

## 공급망 관련 주의

런타임 엔진은 HTML의 원격 `<script>` 태그로 직접 실행하지 않습니다. 먼저 고정 URL의 바이트를 받아 최초 SHA-256 지문을 저장하고, same-origin 가상 캐시에 넣은 후 그 사본을 실행합니다. 이는 **사전 등록된 공식 해시 검증이 아니라 TOFU(Trust On First Use)** 입니다. 최초 다운로드 시점의 공급망을 독립적으로 검증하는 구조는 아닙니다.
