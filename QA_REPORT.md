# ScanBox PWA v1.1.5 QA Report

검토일: 2026-09-16 KST

## 이번 버전의 검증 대상

v1.1.5는 실제 iPhone `사진 불러오기`에서 자동 문서 경계가 종이 안/밖으로 벗어나던 문제를 우선 수정했습니다. 사용자 제공 원본 2장(1152 × 1536, 흰 문서 + 나무 바닥 + 강한 내부 표선)을 기준으로 OpenCV가 없는 호환 경로의 검출 방식을 재설계했습니다.

### 4점 검출
- 내장 1차 검출을 **edge-band sampling + robust four-line fitting** 방식으로 교체했습니다.
- 화면 테두리에서 배경 RGB 중앙값을, 화면 중앙에서 문서 RGB 중앙값을 추정합니다.
- 각 행/열을 따라 `종이 내부 ↔ 배경` 전이가 반복해서 나타나는 위치를 모으고, 좌/우/상/하 네 변을 개별적으로 robust line fitting합니다.
- 단일 contour의 가장 바깥 픽셀이나 가장 큰 사각형 하나에 의존하지 않아 나뭇결, 반사광, 내부 표선의 국소 이상치 영향을 줄였습니다.
- 후보 수, line-fit 잔차, 볼록성/면적, 실제 경계 대비가 기준에 못 미치면 4점을 반환하지 않습니다.
- 자동 검출 신뢰도가 낮으면 원근 보정을 강행하지 않고 원본을 유지하며 `영역 조정` 안내 toast를 표시합니다.
- 새 검출이 성립하지 않는 환경에는 기존 v1.1.4 검출기를 2차 fallback으로 유지합니다.

### 사용자 제공 원본 단위 검증
배포 JavaScript와 같은 색 거리/edge-band/robust-line 계산 구조를 Python prototype으로 재현해 사용자 제공 원본 2장에 적용했습니다.

- 테스트 원본 A: 종이의 좌/우/상/하 외곽을 따라 네 변이 수렴함을 overlay로 확인했습니다.
- 테스트 원본 B: 강한 내부 표선과 바닥 나뭇결이 있는 상태에서도 종이 외곽을 따라 네 변이 수렴함을 overlay로 확인했습니다.
- 두 사진 모두 720 px 검출 작업 해상도에서 네 변 후보가 충분히 모였고 robust fit이 성립했습니다.

이 검증은 알고리즘 prototype 검증이며 iPhone Safari에서 배포 JavaScript를 실행한 결과를 의미하지는 않습니다. 최종 동작은 실제 PWA에서 재확인이 필요합니다.

### 수동 영역 조정 확대경
- 기존 확대경과 넓은 드래그 터치 영역을 유지했습니다.
- 확대경 위치를 드래그 포인트의 반대 사분면으로 선택하도록 수정했습니다.
- 좌상단 점은 확대경이 우하단에 위치해 점/손가락/확대경이 같은 위치에 겹치는 현상을 줄였습니다.
- 화면 가장자리에서는 확대경이 stage 밖으로 나가지 않도록 최종 좌표를 clamp합니다.

### 원근 보정
- v1.1.4에서 삼각형 seam을 제거한 `warpDocumentWebGl()` 경로를 그대로 유지합니다.
- OpenCV가 준비되지 않으면 seamless WebGL projective sampling을 사용하고, WebGL도 불가한 경우 삼각형 mesh가 아닌 CPU inverse mapping을 사용합니다.
- 삼각형별 clip/draw mesh 함수는 배포 코드에 존재하지 않습니다.

### OpenCV 실패 처리
- OpenCV는 여전히 선택적 가속 엔진입니다.
- 한 세션에서 OpenCV 초기화가 실패한 뒤에는 페이지마다 긴 준비 과정을 반복하지 않고 내장 고정밀 검출 + WebGL 보정으로 바로 진행합니다.
- v1.1.5 패키지에 OpenCV.js 자체를 로컬 번들로 포함하지는 않았습니다. 고정 버전 jsDelivr 자산을 기존 보안 런타임 방식으로 준비하는 구조는 유지합니다.

## 자동 정적 검사

배포 전 다음 검사를 수행합니다.

- `app.js`, `sw.js`, `secure-runtime.js`, `pdf-engine.js`, `theme-init.js` Node.js 문법 검사
- HTML 중복 ID 및 `app.js` DOM 참조 확인
- `index.html`, `app.js`, `sw.js`, `secure-runtime.js`, `manifest.webmanifest` 버전 1.1.5 일치 확인
- `detectDocumentCornersEdgeBandJs`, `detectEdgeBandQuadFromRgba`, low-confidence 원본 유지 경로 존재 확인
- `warpDocumentWebGl`, `warpDocumentCpu` 존재 확인
- `drawMappedTriangle`, `squareToQuadMapper`, 구형 `warpDocumentJs`가 배포 코드에 없는지 확인
- 파일명 자동 추천 기능이 다시 들어오지 않았는지 확인
- SHA-256 manifest 전체 파일 검증
- 최종 ZIP 무결성 검사

## 보안 · 오프라인 저장공간

- Service Worker 활성화 시 현재 `scanbox-app-v1.1.5`, `scanbox-runtime-v1.1.5`를 제외한 구버전 `scanbox-*` Cache Storage를 정리합니다.
- 구버전 `scanbox.offline-ready.v*`와 `scanbox.vendor-pin.v*` localStorage 메타데이터도 현재 버전만 남도록 정리합니다.
- 문서 이미지, OCR 결과, 생성 PDF를 외부 서버로 업로드하는 경로는 추가하지 않았습니다.
- 인터넷 연결은 고정 버전 OCR/PDF/OpenCV 실행 자산을 준비하는 기존 용도로만 사용합니다.

## 확인 한계

이 환경에서는 실제 iPhone Safari/PWA 런타임을 실행할 수 없으므로 다음은 사용자 기기에서 확인이 필요합니다.

- 동일한 원본 2장을 `사진 불러오기` 했을 때 네 점이 실제 종이 모서리에 위치하는지
- 촬영 사진에서도 비슷한 검출 정확도가 유지되는지
- 곡률이 큰 종이, 흰색에 가까운 배경, 종이가 화면 밖으로 잘린 사진의 동작
- 확대경이 좌상단을 포함한 네 모서리에서 드래그 포인트를 가리지 않는지

따라서 v1.1.5의 4점 검출은 제공된 두 원본을 기준으로 알고리즘 단위 검증까지 마쳤지만, iPhone에서의 최종 검출률을 100% 보장하지는 않습니다.
