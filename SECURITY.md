# ScanBox v1.2.0 Security Notes

## 개인정보 처리

ScanBox는 촬영/선택한 문서 이미지, PDF 원본, OCR 결과, 생성 결과를 자체 서버로 업로드하지 않습니다. 이미지 처리, OCR, PDF 생성 및 PDF 페이지 편집은 브라우저 내부에서 수행됩니다.

네트워크 연결은 고정 버전 실행 엔진을 준비하는 용도로 제한됩니다. Content Security Policy의 `connect-src`는 자체 출처와 `https://cdn.jsdelivr.net`만 허용합니다.

## 실행 엔진 공급망

다음 대용량 엔진은 고정 버전 jsDelivr URL에서 필요 시 다운로드합니다.

- OpenCV.js
- Tesseract.js / tesseract.js-core / 선택한 OCR 언어 데이터
- PDF.js
- pdf-lib

`secure-runtime.js`는 다음 절차를 적용합니다.

1. HTTPS 및 허용 호스트 검사
2. redirect 최종 URL 재검사
3. 파일 크기 제한
4. SHA-256 계산
5. 최초 지문을 앱 버전별 localStorage에 잠금
6. 앱 전용 Cache Storage의 same-origin 가상 경로에 저장
7. 이후 실행은 캐시 사본 사용
8. 같은 고정 URL의 바이트가 잠근 지문과 달라지면 실행 중단

이는 TOFU 방식이며 사전에 공식 해시를 박아 둔 구조는 아닙니다.

## PDF 입력 / 편집

PDF.js는 렌더링과 텍스트 추출에 사용하며 `isEvalSupported: false`, `useWasm: false`, 자동 가져오기/스트리밍 제한을 사용합니다. PDF 내부 JavaScript action을 실행하는 뷰어 기능은 제공하지 않습니다.

pdf-lib는 기존 PDF의 페이지 객체를 브라우저 내부에서 복사해 합치기/추출/나누기/순서 변경에 사용합니다. 암호 PDF, 손상 PDF 또는 일부 특수 구조는 처리되지 않을 수 있습니다.

PDF 편집 탭에서 OCR 텍스트 수정을 적용한 페이지만 PDF.js로 고해상도 이미지 재렌더링한 뒤 ScanBox PDF 엔진으로 검색 레이어를 재생성합니다. 이 경우 해당 페이지의 기존 벡터 구조는 이미지로 바뀝니다.

## 입력 / 메모리 보호

- 이미지 파일: 개별 최대 40 MB
- PDF 파일: 개별 최대 120 MB
- 한 번에 추가하는 파일: 합계 최대 약 200 MB
- 페이지: 작업당 최대 100장
- PDF → 이미지 ZIP: 최대 60장
- 캔버스: 약 2,000만 픽셀
- JPEG/PNG/WEBP: 한 변 최대 12,000 px, 약 5,000만 픽셀 사전 검사
- PDF 분석 / 페이지 렌더링: 개별 30초 제한
- SVG 입력 차단

## 업데이트 / 저장 공간

Service Worker 활성화 시 이전 `scanbox-*` 캐시를 삭제합니다. 앱 시작 시 이전 `scanbox.offline-ready.v*` 및 `scanbox.vendor-pin.v*` 메타데이터도 정리합니다. 따라서 앱 버전별 엔진 캐시가 무기한 누적되지 않습니다.

## 남는 위험

- TOFU 특성상 최초 다운로드 시점의 배포 경로가 이미 변조되었다면 사전에 탐지하지 못합니다.
- 웹 앱/PWA는 iOS의 사이트 데이터 정리 정책에 따라 캐시가 삭제될 수 있습니다.
- 브라우저 PDF/OCR 라이브러리 자체의 취약점 가능성을 완전히 제거할 수 없습니다.
- 고위험 조직 문서에서는 자체 검증한 엔진을 조직이 직접 호스팅하고 MDM/네이티브 보안 통제를 적용하는 구조가 더 강합니다.


## 준비 재실행 기준

- 같은 ScanBox 버전과 같은 기기에서 준비 완료 후에는 반복 실행할 필요가 없습니다.
- 앱 버전 업데이트, 사이트 데이터 삭제, 새 OCR 언어 선택 시 다시 준비합니다.
- 구버전 ScanBox 캐시와 버전별 보안 메타데이터는 새 버전 활성화 시 정리합니다.
