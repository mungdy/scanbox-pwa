/* ScanBox PWA v1.1.1 - Security Hardened
 * - v1.1 기능 유지 + 공급망/파일 입력/PDF 처리 보안 강화
 * - 외부 엔진은 버전 고정 URL에서 받아 SHA-256 TOFU 잠금 후 같은 출처 가상 캐시에 저장
 * - CSP, PDF.js eval 비활성화, 파일/페이지/캔버스 상한, 같은 출처 Service Worker 캐시
 * - PDF 생성은 자체 경량 엔진 사용(외부 PDF 생성 라이브러리/폰트 의존 제거)
 */
(() => {
  'use strict';

  const APP_VERSION = '1.1.1';
  const DETECT_MAX = 1300;
  const IMPORT_MAX = 5200;
  const PDFJS_VERSION = '6.3.289';
  const TESS_VERSION = '7.0.0';
  const TESS_CORE_VERSION = '7.0.0';

  const LIMITS = Object.freeze({
    imageFileBytes: 40 * 1024 * 1024,
    pdfFileBytes: 120 * 1024 * 1024,
    batchBytes: 200 * 1024 * 1024,
    pages: 100,
    canvasPixels: 20_000_000,
    maxInputPixels: 50_000_000,
    maxInputDimension: 12_000,
    ocrWords: 12_000,
    zipPages: 60,
    pdfLoadMs: 30_000,
    pdfRenderMs: 30_000,
  });

  const QUALITY = {
    economy: { label: '용량 절약', max: 2000, jpg: 0.82, ocr: 2000 },
    standard: { label: '표준', max: 3000, jpg: 0.90, ocr: 2600 },
    high: { label: '고화질', max: 4500, jpg: 0.94, ocr: 3200 },
    max: { label: '원본에 가깝게', max: 5500, jpg: 0.97, ocr: 3800 },
  };

  const asset = (name, remoteUrl, virtualPath, contentType='text/javascript; charset=utf-8') => ({ name, remoteUrl, virtualPath, contentType });
  const SOURCES = Object.freeze({
    opencv: asset('opencv-techstark-5.0.0-release.1', 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@5.0.0-release.1/dist/opencv.js', 'opencv/opencv.js'),
    tesseractMain: asset(`tesseract-main-${TESS_VERSION}`, `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VERSION}/dist/tesseract.min.js`, 'tesseract/tesseract.min.js'),
    tesseractWorker: asset(`tesseract-worker-${TESS_VERSION}`, `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VERSION}/dist/worker.min.js`, 'tesseract/worker.min.js'),
    pdfjsMain: asset(`pdfjs-main-${PDFJS_VERSION}`, `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.min.mjs`, 'pdfjs/pdf.min.mjs'),
    pdfjsWorker: asset(`pdfjs-worker-${PDFJS_VERSION}`, `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.worker.min.mjs`, 'pdfjs/pdf.worker.min.mjs'),
    kor: asset('tessdata-kor-1.0.0', 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/kor@1.0.0/4.0.0_best_int/kor.traineddata.gz', 'tesseract/lang/kor.traineddata.gz', 'application/gzip'),
    eng: asset('tessdata-eng-1.0.0', 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz', 'tesseract/lang/eng.traineddata.gz', 'application/gzip'),
  });
  const TESS_CORE_FILES = [
    'tesseract-core.wasm.js','tesseract-core-simd.wasm.js','tesseract-core-lstm.wasm.js',
    'tesseract-core-simd-lstm.wasm.js','tesseract-core-relaxedsimd.wasm.js','tesseract-core-relaxedsimd-lstm.wasm.js'
  ];
  const TESS_CORE_ASSETS = TESS_CORE_FILES.map(file => asset(
    `tesscore-${TESS_CORE_VERSION}-${file}`,
    `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESS_CORE_VERSION}/${file}`,
    `tesseract/core/${file}`
  ));
  const ALL_RUNTIME_ASSETS = [SOURCES.opencv, SOURCES.tesseractMain, SOURCES.tesseractWorker, ...TESS_CORE_ASSETS, SOURCES.kor, SOURCES.eng, SOURCES.pdfjsMain, SOURCES.pdfjsWorker];

  const state = {
    pages: [],
    cvReady: false,
    cvFailed: false,
    cvPromise: null,
    busy: false,
    latestOutput: null,
    ocrWorker: null,
    ocrWorkerTimer: null,
    ocrLogger: null,
    ocrAssetsPromise: null,
    pdfjs: null,
    pdfjsPromise: null,
    cropEditor: null,
    drag: null,
    defaultName: '',
  };

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const els = {};

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    if (window.top !== window.self) { document.body.textContent = 'ScanBox는 보안을 위해 다른 사이트의 프레임 안에서 실행되지 않습니다.'; return; }
    Object.assign(els, {
      networkBadge: $('#networkBadge'), aboutBtn: $('#aboutBtn'),
      cameraBtn: $('#cameraBtn'), galleryBtn: $('#galleryBtn'), pdfEditBtn: $('#pdfEditBtn'),
      cameraInput: $('#cameraInput'), galleryInput: $('#galleryInput'), pdfEditInput: $('#pdfEditInput'),
      autoCorrectToggle: $('#autoCorrectToggle'), opencvState: $('#opencvState'),
      pageCount: $('#pageCount'), clearPagesBtn: $('#clearPagesBtn'), emptyPages: $('#emptyPages'), pageList: $('#pageList'),
      fileNameInput: $('#fileNameInput'), suggestNameBtn: $('#suggestNameBtn'), nameSuggestion: $('#nameSuggestion'),
      exportFormat: $('#exportFormat'), qualityPreset: $('#qualityPreset'), estimatedSize: $('#estimatedSize'),
      ocrPreviewBtn: $('#ocrPreviewBtn'), createOutputBtn: $('#createOutputBtn'),
      pdfImageFormat: $('#pdfImageFormat'), pdfToImageBtn: $('#pdfToImageBtn'), pdfInput: $('#pdfInput'),
      imagePdfMode: $('#imagePdfMode'), imagesToPdfBtn: $('#imagesToPdfBtn'), imagesForPdfInput: $('#imagesForPdfInput'),
      offlinePrepBtn: $('#offlinePrepBtn'), securityBadge: $('#securityBadge'), securityDetail: $('#securityDetail'),
      cropSheet: $('#cropSheet'), cropCanvas: $('#cropCanvas'), resetCropBtn: $('#resetCropBtn'), applyCropBtn: $('#applyCropBtn'),
      progressOverlay: $('#progressOverlay'), progressTitle: $('#progressTitle'), progressText: $('#progressText'), progressBar: $('#progressBar'), progressPercent: $('#progressPercent'),
      outputSheet: $('#outputSheet'), outputInfo: $('#outputInfo'), saveOutputBtn: $('#saveOutputBtn'), shareOutputBtn: $('#shareOutputBtn'),
      ocrSheet: $('#ocrSheet'), ocrTextArea: $('#ocrTextArea'), copyOcrBtn: $('#copyOcrBtn'), aboutSheet: $('#aboutSheet'), toast: $('#toast'),
    });

    state.defaultName = `${kstDateString()}_스캔`;
    els.fileNameInput.value = state.defaultName;

    bindNavigation();
    bindScanner();
    bindConverter();
    bindSheets();
    bindCropEditor();
    bindOfflinePrep();
    bindPageDrag();

    updateNetworkState();
    updateSecurityStatus();
    window.addEventListener('online', updateNetworkState);
    window.addEventListener('offline', updateNetworkState);
    els.exportFormat.addEventListener('change', updateEstimatedSize);
    els.qualityPreset.addEventListener('change', updateEstimatedSize);

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js').then(() => {
        navigator.serviceWorker.addEventListener('message', onServiceWorkerMessage);
        updateSecurityStatus();
      }).catch(err => {
        console.warn('Service Worker 등록 실패:', err);
        updateSecurityStatus('제한', 'Service Worker를 사용할 수 없어 보안 엔진 캐시 기능이 제한됩니다.');
      });
    } else {
      updateSecurityStatus('제한', 'HTTPS가 아니거나 Service Worker를 지원하지 않는 환경입니다.');
    }

    renderPages();
    els.opencvState.textContent = '문서 보정 엔진 · 필요할 때 보안 로딩';
    els.opencvState.className = 'engine-state';
    window.addEventListener('pagehide', cleanupRuntime);
    console.info(`ScanBox PWA v${APP_VERSION} Security Hardened`);
  }


  function cleanupRuntime() {
    cleanupPages(state.pages);
    if (state.ocrWorkerTimer) { clearTimeout(state.ocrWorkerTimer); state.ocrWorkerTimer = null; }
    const worker = state.ocrWorker; state.ocrWorker = null;
    if (worker?.terminate) { try { worker.terminate(); } catch {} }
    if (state.latestOutput?.url) { try { URL.revokeObjectURL(state.latestOutput.url); } catch {} }
  }

  function bindNavigation() {
    $$('.segment').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
    $$('[data-go-tab]').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.goTab)));
    els.aboutBtn.addEventListener('click', () => openSheet(els.aboutSheet));
  }

  function switchTab(name) {
    $$('.segment').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    $(`#${name}Tab`)?.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function bindScanner() {
    els.cameraBtn.addEventListener('click', () => els.cameraInput.click());
    els.galleryBtn.addEventListener('click', () => els.galleryInput.click());
    els.pdfEditBtn.addEventListener('click', () => els.pdfEditInput.click());

    els.cameraInput.addEventListener('change', onImageInput);
    els.galleryInput.addEventListener('change', onImageInput);
    els.pdfEditInput.addEventListener('change', async e => {
      const file = e.target.files?.[0]; e.target.value = '';
      if (!file) return;
      try { await importPdfToEditor(file); } catch (err) { handleError(err, 'PDF를 편집기로 불러오지 못했습니다.'); }
    });

    els.clearPagesBtn.addEventListener('click', () => {
      cleanupPages(state.pages); state.pages = []; renderPages(); showToast('페이지를 모두 삭제했습니다.');
    });

    els.pageList.addEventListener('click', async e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn || state.busy || state.drag) return;
      const card = btn.closest('[data-page-id]');
      const idx = state.pages.findIndex(p => p.id === card?.dataset.pageId);
      if (idx < 0) return;
      const page = state.pages[idx];
      try {
        if (btn.dataset.action === 'delete') {
          revokePageUrls(page); state.pages.splice(idx, 1);
        } else if (btn.dataset.action === 'rotate') {
          page.rotation = (page.rotation + 90) % 360; invalidateOcr(page); await refreshPreview(page);
        } else if (btn.dataset.action === 'filter') {
          page.filter = btn.dataset.filter;
          if ((page.filter === 'document' || page.filter === 'bw') && !state.cvReady) await waitForCv(5000);
          invalidateOcr(page); await refreshPreview(page);
        } else if (btn.dataset.action === 'crop') {
          await openCropEditor(page); return;
        }
        renderPages();
      } catch (err) { handleError(err, '페이지 편집 중 오류가 발생했습니다.'); }
    });

    els.suggestNameBtn.addEventListener('click', async () => {
      if (!state.pages.length || state.busy) return;
      state.busy = true;
      try {
        await ensureOcrData(state.pages.slice(0, Math.min(2, state.pages.length)), 0, 100, '파일명 추천');
        const text = state.pages.slice(0, 2).map(p => p.ocr?.text || '').join('\n');
        const suggested = suggestFileName(text);
        if (!suggested) return showToast('파일명으로 사용할 정보를 찾지 못했습니다.');
        els.nameSuggestion.textContent = `추천 · ${suggested}`;
        els.nameSuggestion.dataset.name = suggested;
        els.nameSuggestion.classList.remove('hidden');
      } catch (err) { handleError(err, '파일명 추천용 OCR에 실패했습니다.'); }
      finally { state.busy = false; hideProgress(); }
    });
    els.nameSuggestion.addEventListener('click', () => {
      const name = els.nameSuggestion.dataset.name;
      if (name) { els.fileNameInput.value = name; els.nameSuggestion.classList.add('hidden'); showToast('추천 파일명을 적용했습니다.'); }
    });

    els.ocrPreviewBtn.addEventListener('click', async () => {
      if (!state.pages.length || state.busy) return;
      state.busy = true;
      try {
        await ensureOcrData(state.pages, 0, 100, 'OCR 실행');
        els.ocrTextArea.value = state.pages.map((p, i) => `--- ${i + 1}페이지 ---\n${p.ocr?.text || ''}`).join('\n\n');
        renderPages(); hideProgress(); openSheet(els.ocrSheet);
      } catch (err) { handleError(err, 'OCR 처리에 실패했습니다.'); }
      finally { state.busy = false; hideProgress(); }
    });

    els.createOutputBtn.addEventListener('click', async () => {
      if (!state.pages.length) return;
      const base = sanitizeFileName(els.fileNameInput.value || state.defaultName);
      const format = els.exportFormat.value;
      try {
        const output = format === 'searchable-pdf'
          ? await createPdfFromPages(state.pages, base, true)
          : format === 'pdf'
            ? await createPdfFromPages(state.pages, base, false)
            : await createImagesOutput(state.pages, base, format);
        setLatestOutput(output);
      } catch (err) { handleError(err, '파일 생성에 실패했습니다.'); }
    });
  }

  async function onImageInput(e) {
    const files = [...(e.target.files || [])]; e.target.value = '';
    if (files.length) await addImageFiles(files, { autoCorrect: els.autoCorrectToggle.checked });
  }

  function bindConverter() {
    els.pdfToImageBtn.addEventListener('click', () => els.pdfInput.click());
    els.pdfInput.addEventListener('change', async e => {
      const file = e.target.files?.[0]; e.target.value = '';
      if (!file) return;
      try { setLatestOutput(await convertPdfToImages(file, els.pdfImageFormat.value)); }
      catch (err) { handleError(err, 'PDF를 이미지로 변환하지 못했습니다. 암호 PDF이거나 지원하지 않는 파일일 수 있습니다.'); }
    });

    els.imagesToPdfBtn.addEventListener('click', () => els.imagesForPdfInput.click());
    els.imagesForPdfInput.addEventListener('change', async e => {
      const files = [...(e.target.files || [])]; e.target.value = '';
      if (!files.length) return;
      const temp = [];
      try {
        await validateImageBatch(files, 0);
        showProgress('이미지 준비', 'PDF에 넣을 이미지를 준비하고 있습니다.', 0);
        for (let i = 0; i < files.length; i++) {
          const blob = await normalizeImageFile(files[i], IMPORT_MAX, 0.95);
          const page = makePage(blob, files[i].name, blob);
          await refreshPreview(page); temp.push(page);
          updateProgress((i + 1) / files.length * 30, `${i + 1} / ${files.length} 이미지 준비`);
        }
        const base = sanitizeFileName(stripExtension(files[0].name) || `${kstDateString()}_이미지`);
        const searchable = els.imagePdfMode.value === 'searchable-pdf';
        setLatestOutput(await createPdfFromPages(temp, base, searchable, 30));
      } catch (err) { handleError(err, '이미지를 PDF로 변환하지 못했습니다.'); }
      finally { cleanupPages(temp); }
    });
  }

  function bindSheets() {
    $$('[data-close-output]').forEach(el => el.addEventListener('click', () => closeSheet(els.outputSheet)));
    $$('[data-close-ocr]').forEach(el => el.addEventListener('click', () => closeSheet(els.ocrSheet)));
    $$('[data-close-about]').forEach(el => el.addEventListener('click', () => closeSheet(els.aboutSheet)));
    $$('[data-close-crop]').forEach(el => el.addEventListener('click', closeCropEditor));
    els.saveOutputBtn.addEventListener('click', () => state.latestOutput && downloadBlob(state.latestOutput.blob, state.latestOutput.name));
    els.shareOutputBtn.addEventListener('click', () => state.latestOutput && shareBlob(state.latestOutput.blob, state.latestOutput.name));
    els.copyOcrBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(els.ocrTextArea.value); }
      catch { els.ocrTextArea.select(); document.execCommand('copy'); }
      showToast('OCR 텍스트를 복사했습니다.');
    });
  }

  function bindOfflinePrep() {
    els.offlinePrepBtn.addEventListener('click', async () => {
      if (!('serviceWorker' in navigator)) return showToast('이 브라우저에서는 보안 오프라인 준비를 지원하지 않습니다.');
      if (!window.ScanBoxRuntime) return showToast('보안 런타임을 불러오지 못했습니다.');
      if (state.busy) return;
      state.busy = true;
      try {
        const reg = await navigator.serviceWorker.ready;
        const worker = reg.active || reg.waiting || reg.installing;
        if (!worker) throw new Error('Service Worker가 아직 준비되지 않았습니다.');
        showProgress('보안 · 오프라인 준비', '앱 파일을 먼저 저장하고 있습니다.', 0);
        worker.postMessage({ type: 'PREPARE_OFFLINE' });
      } catch (err) {
        state.busy = false;
        handleError(err, '보안 오프라인 준비를 시작하지 못했습니다.');
      }
    });
  }

  function onServiceWorkerMessage(e) {
    const data = e.data || {};
    if (data.type === 'OFFLINE_PROGRESS') updateProgress(data.percent || 0, data.label || '앱 파일 저장 중');
    if (data.type === 'OFFLINE_DONE') warmOfflineEngines(data.failures || 0);
    if (data.type === 'OFFLINE_ERROR') { state.busy = false; hideProgress(); showToast(`일부 앱 파일 저장 실패: ${data.label || '네트워크를 확인해 주세요.'}`); }
  }

  async function warmOfflineEngines(baseFailures = 0) {
    let failures = baseFailures;
    try {
      const rt = window.ScanBoxRuntime;
      if (!rt) throw new Error('보안 런타임이 없습니다.');
      updateProgress(20, '엔진 파일의 최초 SHA-256 지문을 만들고 보안 캐시에 저장 중');
      await rt.warmAssets(ALL_RUNTIME_ASSETS, (p, item) => {
        updateProgress(20 + p * 62, `${item?.name || '엔진'} 지문 생성 · 저장 중`);
      });
    } catch (err) {
      failures++;
      console.warn('Secure runtime warm failed', err);
    }

    try {
      updateProgress(84, '문서 보정 엔진 검증 중');
      await ensureOpenCv();
    } catch (err) { failures++; console.warn('OpenCV warm failed', err); }

    try {
      updateProgress(88, '한국어 · 영어 OCR 모델 초기화 중');
      const worker = await getOcrWorker(m => {
        if (m.status === 'loading language traineddata') updateProgress(88 + (m.progress || 0) * 7, 'OCR 언어 모델 준비 중');
      });
      if (state.ocrWorkerTimer) { clearTimeout(state.ocrWorkerTimer); state.ocrWorkerTimer = null; }
      try { await worker.terminate(); } catch {}
      state.ocrWorker = null;
    } catch (err) { failures++; console.warn('OCR warm failed', err); }

    try {
      updateProgress(96, 'PDF 안전 렌더링 엔진 확인 중');
      await getPdfJs();
    } catch (err) { failures++; console.warn('PDF.js warm failed', err); }

    updateProgress(100, failures ? '준비 완료 · 일부 항목 확인 필요' : '보안 · 오프라인 준비 완료');
    state.busy = false;
    updateSecurityStatus(failures ? '확인 필요' : '강화', failures ? `${failures}개 구성 요소 준비에 실패했습니다. 인터넷 연결 후 다시 준비해 주세요.` : '실행 엔진의 최초 SHA-256 지문 잠금과 앱 전용 로컬 캐시 준비가 완료되었습니다.');
    setTimeout(hideProgress, 650);
    showToast(failures ? `준비 완료 · ${failures}개 항목은 다시 시도해 주세요.` : '보안 · 오프라인 사용 준비가 완료되었습니다.');
  }

  async function validateImageBatch(files, existingPages = 0) {
    if (!files?.length) return;
    if (existingPages + files.length > LIMITS.pages) throw new Error(`한 작업에서 최대 ${LIMITS.pages}페이지까지 처리할 수 있습니다.`);
    let total = 0;
    for (const file of files) {
      total += file.size || 0;
      if ((file.size || 0) > LIMITS.imageFileBytes) throw new Error(`${file.name || '이미지'} 파일이 40 MB를 초과합니다.`);
      const name = String(file.name || '').toLowerCase();
      const type = String(file.type || '').toLowerCase();
      if (type === 'image/svg+xml' || /\.svgz?$/.test(name)) throw new Error('SVG 파일은 보안을 위해 입력할 수 없습니다. JPG, PNG, HEIC, WEBP를 사용해 주세요.');
      const allowedType = ['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(type);
      const allowedExt = /\.(jpe?g|png|webp|heic|heif)$/i.test(name);
      if (type && !allowedType) throw new Error(`${file.name || '이미지'} 형식은 지원하지 않습니다.`);
      if (!type && name && !allowedExt) throw new Error(`${file.name || '이미지'} 형식을 확인할 수 없습니다.`);

      const dims = await probeImageDimensions(file);
      if (dims) {
        if (dims.width > LIMITS.maxInputDimension || dims.height > LIMITS.maxInputDimension || dims.width * dims.height > LIMITS.maxInputPixels) {
          throw new Error(`${file.name || '이미지'} 해상도가 너무 큽니다. 최대 ${LIMITS.maxInputDimension.toLocaleString()}px / 약 5,000만 픽셀까지 지원합니다.`);
        }
      }
    }
    if (total > LIMITS.batchBytes) throw new Error('한 번에 선택한 이미지의 총 용량이 200 MB를 초과합니다. 나누어 처리해 주세요.');
  }

  async function probeImageDimensions(file) {
    try {
      const size = Math.min(file.size || 0, 256 * 1024);
      if (!size) return null;
      const b = new Uint8Array(await file.slice(0, size).arrayBuffer());
      const type = String(file.type || '').toLowerCase();
      const name = String(file.name || '').toLowerCase();
      if (type === 'image/png' || name.endsWith('.png')) return probePngDimensions(b);
      if (type === 'image/jpeg' || /\.jpe?g$/.test(name)) return probeJpegDimensions(b);
      if (type === 'image/webp' || name.endsWith('.webp')) return probeWebpDimensions(b);
      return null; // HEIC/HEIF: 브라우저 디코더 + 파일 크기 제한에 맡김
    } catch (err) {
      console.warn('이미지 헤더 검사 생략:', err);
      return null;
    }
  }

  function probePngDimensions(b) {
    if (b.length < 24) return null;
    const sig = [137,80,78,71,13,10,26,10];
    if (!sig.every((v,i)=>b[i]===v)) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const width = dv.getUint32(16, false), height = dv.getUint32(20, false);
    return width && height ? { width, height } : null;
  }

  function probeJpegDimensions(b) {
    if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      while (i < b.length && b[i] === 0xFF) i++;
      const marker = b[i++];
      if (marker === 0xD8 || marker === 0xD9) continue;
      if (i + 1 >= b.length) break;
      const len = (b[i] << 8) | b[i + 1];
      if (len < 2 || i + len > b.length) break;
      const sof = (marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF);
      if (sof && len >= 7) {
        const height = (b[i + 3] << 8) | b[i + 4];
        const width = (b[i + 5] << 8) | b[i + 6];
        return width && height ? { width, height } : null;
      }
      i += len;
    }
    return null;
  }

  function probeWebpDimensions(b) {
    if (b.length < 30 || String.fromCharCode(...b.slice(0,4)) !== 'RIFF' || String.fromCharCode(...b.slice(8,12)) !== 'WEBP') return null;
    const kind = String.fromCharCode(...b.slice(12,16));
    if (kind === 'VP8X' && b.length >= 30) {
      const width = 1 + b[24] + (b[25] << 8) + (b[26] << 16);
      const height = 1 + b[27] + (b[28] << 8) + (b[29] << 16);
      return { width, height };
    }
    if (kind === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      const width = ((b[27] << 8) | b[26]) & 0x3fff;
      const height = ((b[29] << 8) | b[28]) & 0x3fff;
      return width && height ? { width, height } : null;
    }
    if (kind === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      const width = 1 + (bits & 0x3fff);
      const height = 1 + ((bits >> 14) & 0x3fff);
      return { width, height };
    }
    return null;
  }

  async function validatePdfFile(file) {
    if (!file) throw new Error('PDF 파일이 없습니다.');
    if ((file.size || 0) > LIMITS.pdfFileBytes) throw new Error('PDF 파일은 최대 120 MB까지 지원합니다.');
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const sig = String.fromCharCode(...head.slice(0, 5));
    if (sig !== '%PDF-') throw new Error('PDF 파일 서명이 올바르지 않습니다.');
  }

  async function ensureOpenCv() {
    if (state.cvReady && window.cv?.Mat) return true;
    if (state.cvPromise) return state.cvPromise;
    state.cvPromise = (async () => {
      try {
        if (!window.ScanBoxRuntime) throw new Error('보안 런타임을 불러오지 못했습니다.');
        els.opencvState.textContent = '문서 보정 엔진 · SHA-256 확인 중';
        els.opencvState.className = 'engine-state';
        await window.ScanBoxRuntime.loadScript({ ...SOURCES.opencv, globalCheck: () => !!window.cv });
        if (window.cv instanceof Promise) window.cv = await window.cv;
        if (!window.cv?.Mat) throw new Error('OpenCV 초기화 실패');
        state.cvReady = true; state.cvFailed = false;
        els.opencvState.textContent = '자동 · 수동 문서 보정 사용 가능';
        els.opencvState.className = 'engine-state ok';
        updateSecurityStatus();
        return true;
      } catch (err) {
        state.cvFailed = true;
        els.opencvState.textContent = '문서 보정 엔진 준비 실패 · 원본 사용 가능';
        els.opencvState.className = 'engine-state warn';
        throw err;
      } finally {
        if (!state.cvReady) state.cvPromise = null;
      }
    })();
    return state.cvPromise;
  }

  async function addImageFiles(files, { autoCorrect }) {
    if (state.busy) return;
    state.busy = true;
    try {
      await validateImageBatch(files, state.pages.length);
      showProgress('문서 가져오기', '이미지를 준비하고 있습니다.', 0);
      const cvAvailable = autoCorrect ? (state.cvReady || await waitForCv(6500)) : false;
      for (let i = 0; i < files.length; i++) {
        updateProgress((i / files.length) * 92, `${i + 1} / ${files.length} 페이지 처리`);
        const sourceBlob = await normalizeImageFile(files[i], IMPORT_MAX, 0.95);
        let pageBlob = sourceBlob;
        let corners = null;
        if (autoCorrect && cvAvailable) {
          try {
            corners = await detectDocumentCorners(sourceBlob);
            if (corners) pageBlob = await warpDocument(sourceBlob, corners);
          } catch (err) { console.warn('자동 보정 실패:', err); }
        }
        const page = makePage(pageBlob, files[i].name, sourceBlob);
        page.cropCorners = corners;
        await refreshPreview(page);
        state.pages.push(page);
      }
      renderPages();
      updateProgress(100, '페이지 추가 완료');
      if (autoCorrect && !cvAvailable) showToast('보정 엔진을 사용할 수 없어 원본으로 추가했습니다.');
    } catch (err) { handleError(err, '이미지를 불러오지 못했습니다.'); }
    finally { state.busy = false; hideProgress(); }
  }

  function makePage(blob, sourceName = '문서', sourceBlob = blob) {
    return {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      blob, sourceBlob, sourceName, cropCorners: null,
      filter: 'color', rotation: 0, previewUrl: null, ocr: null,
    };
  }

  function invalidateOcr(page) { page.ocr = null; }

  async function refreshPreview(page) {
    if (page.previewUrl) URL.revokeObjectURL(page.previewUrl);
    const canvas = await renderPageToCanvas(page, 760);
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.82);
    releaseCanvas(canvas);
    page.previewUrl = URL.createObjectURL(blob);
  }

  function renderPages() {
    const count = state.pages.length;
    els.pageCount.textContent = `${count}장`;
    els.emptyPages.classList.toggle('hidden', count > 0);
    els.clearPagesBtn.disabled = count === 0;
    els.ocrPreviewBtn.disabled = count === 0;
    els.createOutputBtn.disabled = count === 0;
    els.suggestNameBtn.disabled = count === 0;

    els.pageList.innerHTML = state.pages.map((page, idx) => `
      <article class="page-card" data-page-id="${escapeHtml(page.id)}">
        <div class="page-preview-wrap"><img class="page-preview" src="${escapeHtml(page.previewUrl || '')}" alt="${idx + 1}페이지" /></div>
        <div class="page-content">
          <div class="page-head">
            <button class="drag-handle" data-sort-handle aria-label="페이지 순서 이동">≡</button>
            <strong>${idx + 1}페이지</strong>
            <span class="page-source">${escapeHtml(page.sourceName || '')}</span>
          </div>
          ${page.ocr ? `<span class="ocr-chip">OCR ${page.ocr.words.length.toLocaleString()}단어</span>` : ''}
          <div class="filter-tabs">
            ${filterButton(page, 'color', '컬러')}${filterButton(page, 'auto', '자동')}${filterButton(page, 'gray', '그레이')}${filterButton(page, 'document', '문서')}${filterButton(page, 'bw', '흑백')}
          </div>
          <div class="page-actions">
            <button data-action="crop">영역 조정</button><button data-action="rotate">↻ 회전</button><button data-action="delete" class="danger">삭제</button>
          </div>
        </div>
      </article>`).join('');
    updateEstimatedSize();
  }

  function filterButton(page, value, label) {
    return `<button data-action="filter" data-filter="${value}" class="filter-btn ${page.filter === value ? 'active' : ''}">${label}</button>`;
  }

  function bindPageDrag() {
    els.pageList.addEventListener('pointerdown', e => {
      const handle = e.target.closest('[data-sort-handle]');
      if (!handle || state.busy) return;
      const card = handle.closest('.page-card');
      if (!card) return;
      e.preventDefault();
      state.drag = { card, pointerId: e.pointerId };
      card.classList.add('dragging');
      try { handle.setPointerCapture(e.pointerId); } catch {}
    });
    window.addEventListener('pointermove', e => {
      if (!state.drag || e.pointerId !== state.drag.pointerId) return;
      e.preventDefault();
      const { card } = state.drag;
      card.style.transform = `scale(1.015) translateY(${Math.max(-12, Math.min(12, e.movementY || 0))}px)`;
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.page-card');
      if (!target || target === card || target.parentNode !== els.pageList) return;
      const rect = target.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) els.pageList.insertBefore(card, target);
      else els.pageList.insertBefore(card, target.nextSibling);
    }, { passive: false });
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }

  function endDrag(e) {
    if (!state.drag || (e.pointerId != null && e.pointerId !== state.drag.pointerId)) return;
    const { card } = state.drag;
    card.classList.remove('dragging'); card.style.transform = '';
    const ids = [...els.pageList.querySelectorAll('.page-card')].map(el => el.dataset.pageId);
    const byId = new Map(state.pages.map(p => [p.id, p]));
    state.pages = ids.map(id => byId.get(id)).filter(Boolean);
    state.drag = null; renderPages();
  }

  async function normalizeImageFile(fileOrBlob, maxDimension, quality = 0.95) {
    const img = await loadImage(fileOrBlob);
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    const fitted = fitDimensions(w0, h0, maxDimension);
    const canvas = document.createElement('canvas'); canvas.width = fitted.width; canvas.height = fitted.height;
    const ctx = canvas.getContext('2d', { alpha: false }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    cleanupLoadedImage(img);
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality); releaseCanvas(canvas); return blob;
  }

  function fitDimensions(width, height, maxDimension) {
    width = Math.max(1, Number(width) || 1); height = Math.max(1, Number(height) || 1);
    let scale = Math.min(1, maxDimension / Math.max(width, height));
    const scaledPixels = width * height * scale * scale;
    if (scaledPixels > LIMITS.canvasPixels) scale *= Math.sqrt(LIMITS.canvasPixels / scaledPixels);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
  }

  async function detectDocumentCorners(blob) {
    if (!state.cvReady || !window.cv) return null;
    const img = await loadImage(blob);
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    const scale = Math.min(1, DETECT_MAX / Math.max(w0, h0));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(w0 * scale); canvas.height = Math.round(h0 * scale); canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height); cleanupLoadedImage(img);
    const cv = window.cv; let src, gray, blur, edges, contours, hierarchy;
    try {
      src = cv.imread(canvas); gray = new cv.Mat(); blur = new cv.Mat(); edges = new cv.Mat(); contours = new cv.MatVector(); hierarchy = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0); cv.GaussianBlur(gray, blur, new cv.Size(5,5), 0, 0, cv.BORDER_DEFAULT); cv.Canny(blur, edges, 45, 150, 3, false);
      const kernel = cv.Mat.ones(3,3,cv.CV_8U); cv.dilate(edges, edges, kernel, new cv.Point(-1,-1), 1); kernel.delete();
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      let best = null, bestArea = 0; const imageArea = canvas.width * canvas.height;
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i); const area = Math.abs(cv.contourArea(cnt));
        if (area > imageArea * 0.10 && area > bestArea) {
          const peri = cv.arcLength(cnt, true); const approx = new cv.Mat(); cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
          if (approx.rows === 4) {
            const pts = []; for (let r=0;r<4;r++) pts.push({x:approx.intPtr(r,0)[0],y:approx.intPtr(r,0)[1]});
            best = pts; bestArea = area;
          }
          approx.delete();
        }
        cnt.delete();
      }
      if (!best || bestArea < imageArea * 0.16) return null;
      const ordered = orderQuad(best);
      return ordered.map(p => ({ x: clamp(p.x / canvas.width, 0, 1), y: clamp(p.y / canvas.height, 0, 1) }));
    } finally {
      [src,gray,blur,edges,contours,hierarchy].forEach(x => { try{x?.delete?.();}catch{} }); releaseCanvas(canvas);
    }
  }

  async function warpDocument(blob, normalizedCorners) {
    if (!state.cvReady || !window.cv) throw new Error('문서 보정 엔진이 준비되지 않았습니다.');
    const img = await loadImage(blob); const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const source = document.createElement('canvas'); source.width=w; source.height=h; source.getContext('2d',{alpha:false}).drawImage(img,0,0); cleanupLoadedImage(img);
    const pts = orderQuad(normalizedCorners.map(p => ({x:p.x*w,y:p.y*h})));
    const [tl,tr,br,bl] = pts; let outW = Math.round(Math.max(distance(br,bl), distance(tr,tl))); let outH = Math.round(Math.max(distance(tr,br), distance(tl,bl)));
    if (outW < 120 || outH < 120) { releaseCanvas(source); throw new Error('선택한 문서 영역이 너무 작습니다.'); }
    const fitted = fitDimensions(outW, outH, IMPORT_MAX); outW = fitted.width; outH = fitted.height;
    const cv=window.cv; let src, srcPts, dstPts, matrix, dst;
    try {
      src=cv.imread(source); srcPts=cv.matFromArray(4,1,cv.CV_32FC2,[tl.x,tl.y,tr.x,tr.y,br.x,br.y,bl.x,bl.y]); dstPts=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,outW-1,0,outW-1,outH-1,0,outH-1]); matrix=cv.getPerspectiveTransform(srcPts,dstPts); dst=new cv.Mat();
      cv.warpPerspective(src,dst,matrix,new cv.Size(outW,outH),cv.INTER_LINEAR,cv.BORDER_REPLICATE,new cv.Scalar());
      const out=document.createElement('canvas'); cv.imshow(out,dst); const result=await canvasToBlob(out,'image/jpeg',0.96); releaseCanvas(out); return result;
    } finally { [src,srcPts,dstPts,matrix,dst].forEach(x=>{try{x?.delete?.();}catch{}}); releaseCanvas(source); }
  }

  function orderQuad(points) {
    const sum=p=>p.x+p.y, diff=p=>p.x-p.y;
    const tl=points.reduce((a,b)=>sum(a)<sum(b)?a:b), br=points.reduce((a,b)=>sum(a)>sum(b)?a:b), tr=points.reduce((a,b)=>diff(a)>diff(b)?a:b), bl=points.reduce((a,b)=>diff(a)<diff(b)?a:b);
    return [tl,tr,br,bl];
  }
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));

  function bindCropEditor() {
    els.cropCanvas.addEventListener('pointerdown', e => {
      const c = state.cropEditor; if (!c) return;
      const p = canvasPoint(e, els.cropCanvas); let best=-1, dist=Infinity;
      c.points.forEach((q,i)=>{const d=Math.hypot(q.x-p.x,q.y-p.y); if(d<dist){dist=d;best=i;}});
      if (dist < Math.max(32, els.cropCanvas.width * .05)) { c.dragIndex=best; try{els.cropCanvas.setPointerCapture(e.pointerId);}catch{} e.preventDefault(); }
    });
    els.cropCanvas.addEventListener('pointermove', e => {
      const c=state.cropEditor; if(!c || c.dragIndex==null) return; e.preventDefault(); const p=canvasPoint(e,els.cropCanvas); c.points[c.dragIndex]={x:clamp(p.x,0,els.cropCanvas.width),y:clamp(p.y,0,els.cropCanvas.height)}; drawCropEditor();
    }, {passive:false});
    const stop=()=>{if(state.cropEditor) state.cropEditor.dragIndex=null;}; els.cropCanvas.addEventListener('pointerup',stop); els.cropCanvas.addEventListener('pointercancel',stop);
    els.resetCropBtn.addEventListener('click', async()=>{
      const c=state.cropEditor;if(!c)return; try{const found=await detectDocumentCorners(c.page.sourceBlob); setCropPoints(found || defaultCorners()); drawCropEditor(); if(!found)showToast('자동 감지에 실패해 전체 영역으로 초기화했습니다.');}catch(err){handleError(err,'문서 영역 자동 감지에 실패했습니다.');}
    });
    els.applyCropBtn.addEventListener('click', async()=>{
      const c=state.cropEditor;if(!c)return; try{
        state.busy=true;showProgress('영역 보정','선택한 네 모서리를 기준으로 문서를 펴고 있습니다.',10);
        const norm=orderQuad(c.points.map(p=>({x:p.x/els.cropCanvas.width,y:p.y/els.cropCanvas.height}))); const newBlob=await warpDocument(c.page.sourceBlob,norm); c.page.blob=newBlob;c.page.cropCorners=norm;invalidateOcr(c.page);await refreshPreview(c.page);updateProgress(100,'보정 완료');closeCropEditor();renderPages();
      }catch(err){handleError(err,'문서 영역 보정에 실패했습니다.');}finally{state.busy=false;hideProgress();}
    });
  }

  async function openCropEditor(page) {
    if (!(state.cvReady || await waitForCv(5000))) return showToast('문서 보정 엔진이 준비되지 않아 영역 조정을 사용할 수 없습니다.');
    const img=await loadImage(page.sourceBlob); const w=img.naturalWidth||img.width,h=img.naturalHeight||img.height; const scale=Math.min(1,1000/Math.max(w,h));
    els.cropCanvas.width=Math.max(1,Math.round(w*scale));els.cropCanvas.height=Math.max(1,Math.round(h*scale));
    const ctx=els.cropCanvas.getContext('2d',{alpha:false});ctx.fillStyle='#111';ctx.fillRect(0,0,els.cropCanvas.width,els.cropCanvas.height);ctx.drawImage(img,0,0,els.cropCanvas.width,els.cropCanvas.height);cleanupLoadedImage(img);
    state.cropEditor={page,base:ctx.getImageData(0,0,els.cropCanvas.width,els.cropCanvas.height),points:[],dragIndex:null};
    let corners=page.cropCorners; if(!corners){try{corners=await detectDocumentCorners(page.sourceBlob);}catch{}}
    setCropPoints(corners||defaultCorners());drawCropEditor();openSheet(els.cropSheet);
  }
  function defaultCorners(){return[{x:.025,y:.025},{x:.975,y:.025},{x:.975,y:.975},{x:.025,y:.975}];}
  function setCropPoints(norm){state.cropEditor.points=orderQuad(norm).map(p=>({x:p.x*els.cropCanvas.width,y:p.y*els.cropCanvas.height}));}
  function drawCropEditor(){const c=state.cropEditor;if(!c)return;const ctx=els.cropCanvas.getContext('2d');ctx.putImageData(c.base,0,0);ctx.save();ctx.fillStyle='rgba(0,0,0,.45)';ctx.beginPath();ctx.rect(0,0,els.cropCanvas.width,els.cropCanvas.height);ctx.moveTo(c.points[0].x,c.points[0].y);for(let i=1;i<c.points.length;i++)ctx.lineTo(c.points[i].x,c.points[i].y);ctx.closePath();ctx.fill('evenodd');ctx.strokeStyle='#4c9aff';ctx.lineWidth=Math.max(3,els.cropCanvas.width*.004);ctx.beginPath();c.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.stroke();c.points.forEach(p=>{ctx.fillStyle='#fff';ctx.strokeStyle='#3182f6';ctx.lineWidth=4;ctx.beginPath();ctx.arc(p.x,p.y,Math.max(9,els.cropCanvas.width*.012),0,Math.PI*2);ctx.fill();ctx.stroke();});ctx.restore();}
  function canvasPoint(e,canvas){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height};}
  function closeCropEditor(){if(state.cropEditor){state.cropEditor.base=null;state.cropEditor=null;}closeSheet(els.cropSheet);}

  async function renderPageToCanvas(page, maxDimension) {
    const img = await loadImage(page.blob);
    const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
    const rotated = page.rotation % 180 !== 0;
    const naturalW = rotated ? sh : sw, naturalH = rotated ? sw : sh;
    const fitted = fitDimensions(naturalW, naturalH, maxDimension);
    const drawScale = fitted.scale;
    const dw = Math.max(1, Math.round(sw * drawScale)), dh = Math.max(1, Math.round(sh * drawScale));
    const canvas = document.createElement('canvas'); canvas.width = fitted.width; canvas.height = fitted.height;
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: page.filter !== 'color' });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate((page.rotation || 0) * Math.PI / 180); ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh); ctx.restore();
    cleanupLoadedImage(img); if (page.filter !== 'color') applyFilter(canvas, page.filter); return canvas;
  }

  function applyFilter(canvas, filter) {
    if ((filter==='document'||filter==='bw') && state.cvReady && window.cv) {
      const cv=window.cv;let src,gray,out,rgba;try{src=cv.imread(canvas);gray=new cv.Mat();out=new cv.Mat();rgba=new cv.Mat();cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY,0);if(filter==='document'){cv.GaussianBlur(gray,gray,new cv.Size(3,3),0);cv.adaptiveThreshold(gray,out,255,cv.ADAPTIVE_THRESH_GAUSSIAN_C,cv.THRESH_BINARY,31,13);}else{cv.threshold(gray,out,0,255,cv.THRESH_BINARY+cv.THRESH_OTSU);}cv.cvtColor(out,rgba,cv.COLOR_GRAY2RGBA,0);cv.imshow(canvas,rgba);return;}catch(err){console.warn('OpenCV 필터 실패, JS 필터로 전환',err);}finally{[src,gray,out,rgba].forEach(x=>{try{x?.delete?.();}catch{}});}
    }
    const ctx=canvas.getContext('2d',{willReadFrequently:true});const image=ctx.getImageData(0,0,canvas.width,canvas.height);const d=image.data;
    let mean=0,count=0;for(let i=0;i<d.length;i+=Math.max(4,Math.floor(d.length/600000/4)*4||4)){mean+=.299*d[i]+.587*d[i+1]+.114*d[i+2];count++;}mean/=Math.max(1,count);
    for(let i=0;i<d.length;i+=4){const y=.299*d[i]+.587*d[i+1]+.114*d[i+2];if(filter==='gray'){const v=clamp((y-128)*1.12+135,0,255);d[i]=d[i+1]=d[i+2]=v;}else if(filter==='auto'){const lift=128-mean;d[i]=clamp((d[i]+lift*.18-128)*1.08+128,0,255);d[i+1]=clamp((d[i+1]+lift*.18-128)*1.08+128,0,255);d[i+2]=clamp((d[i+2]+lift*.18-128)*1.08+128,0,255);}else{const threshold=clamp(mean*.88,125,205);const v=y>threshold?255:0;d[i]=d[i+1]=d[i+2]=v;}}
    ctx.putImageData(image,0,0);
  }

  async function ensureOcrData(pages, startPct=0, endPct=65, title='OCR PDF 만들기') {
    showProgress(title,'한국어 + 영어 OCR 엔진을 준비하고 있습니다.',startPct);
    const worker=await getOcrWorker(m=>{if(m.status==='recognizing text'){const base=state._ocrBase??startPct,span=state._ocrSpan??1;updateProgress(base+m.progress*span,'문서의 글자를 인식하고 있습니다.');}});
    const q=getQuality();
    for(let i=0;i<pages.length;i++){
      const a=startPct+(i/pages.length)*(endPct-startPct),b=startPct+((i+1)/pages.length)*(endPct-startPct);if(pages[i].ocr)continue;state._ocrBase=a;state._ocrSpan=b-a;updateProgress(a,`${i+1} / ${pages.length} 페이지 OCR`);const canvas=await renderPageToCanvas(pages[i],q.ocr);const result=await worker.recognize(canvas,{}, {text:true,tsv:true});const text=(result?.data?.text||'').trim();const words=parseTsv(result?.data?.tsv||'');pages[i].ocr={text,words,width:canvas.width,height:canvas.height};releaseCanvas(canvas);
    }
    delete state._ocrBase;delete state._ocrSpan;renderPages();scheduleOcrWorkerRelease();
  }

  function scheduleOcrWorkerRelease(){
    if(state.ocrWorkerTimer)clearTimeout(state.ocrWorkerTimer);
    state.ocrWorkerTimer=setTimeout(async()=>{const worker=state.ocrWorker;state.ocrWorker=null;state.ocrWorkerTimer=null;if(worker){try{await worker.terminate();console.info('OCR worker released');}catch{}}},90000);
  }

  async function ensureOcrRuntimeAssets(onProgress) {
    if (state.ocrAssetsPromise) return state.ocrAssetsPromise;
    state.ocrAssetsPromise = (async () => {
      const rt = window.ScanBoxRuntime;
      if (!rt) throw new Error('보안 런타임을 불러오지 못했습니다.');
      const assets = [SOURCES.tesseractMain, SOURCES.tesseractWorker, ...TESS_CORE_ASSETS, SOURCES.kor, SOURCES.eng];
      await rt.warmAssets(assets, (p, item) => onProgress?.(p, item));
      await rt.loadScript({ ...SOURCES.tesseractMain, globalCheck: () => !!window.Tesseract });
      if (!window.Tesseract?.createWorker) throw new Error('OCR 라이브러리 초기화에 실패했습니다.');
      return true;
    })().catch(err => { state.ocrAssetsPromise = null; throw err; });
    return state.ocrAssetsPromise;
  }

  async function getOcrWorker(logger) {
    state.ocrLogger = logger;
    if (state.ocrWorkerTimer) { clearTimeout(state.ocrWorkerTimer); state.ocrWorkerTimer = null; }
    if (state.ocrWorker) return state.ocrWorker;
    await ensureOcrRuntimeAssets((p, item) => {
      if (state.busy) updateProgress(Math.min(35, 4 + p * 28), `${item?.name || 'OCR 엔진'} 보안 캐시 준비 중`);
    });
    const rt = window.ScanBoxRuntime;
    const workerPath = rt.virtualUrl('tesseract/worker.min.js');
    const corePath = rt.virtualUrl('tesseract/core').replace(/\/$/, '');
    const langPath = rt.virtualUrl('tesseract/lang').replace(/\/$/, '');
    state.ocrWorker = await window.Tesseract.createWorker(['kor','eng'], 1, {
      workerPath, corePath, langPath, gzip: true,
      logger: m => state.ocrLogger?.(m),
      errorHandler: err => console.error('Tesseract worker:', err)
    });
    return state.ocrWorker;
  }

  function parseTsv(tsv){
    if(!tsv)return[];const lines=tsv.split(/\r?\n/);const words=[];
    for(let i=1;i<lines.length&&words.length<LIMITS.ocrWords;i++){
      const c=lines[i].split('\t');if(c.length<12||c[0]!=='5')continue;
      const text=c.slice(11).join('\t').replace(/[\u0000-\u001F\u007F]/g,'').trim().slice(0,500);const conf=Number(c[10]);if(!text||conf<0)continue;
      words.push({left:Number(c[6])||0,top:Number(c[7])||0,width:Number(c[8])||0,height:Number(c[9])||0,conf,text});
    }return words;
  }


  async function createPdfFromPages(pages, baseName, searchable, initialPct=0) {
    if (!window.ScanBoxPDF?.build) throw new Error('로컬 PDF 엔진을 불러오지 못했습니다.');
    if (state.busy) throw new Error('다른 작업이 진행 중입니다.');
    if (pages.length > LIMITS.pages) throw new Error(`PDF는 최대 ${LIMITS.pages}페이지까지 처리할 수 있습니다.`);
    state.busy = true;
    try {
      const q = getQuality();
      const ocrEnd = searchable ? Math.max(initialPct + 48, 64) : initialPct;
      if (searchable) await ensureOcrData(pages, initialPct, ocrEnd, '정밀 OCR PDF 만들기');
      else showProgress('PDF 만들기', '페이지를 안전한 로컬 PDF로 변환하고 있습니다.', initialPct);
      const startPct = searchable ? Math.max(72, ocrEnd + 4) : Math.max(5, initialPct), endPct = 94;
      const pdfPages = [];
      for (let i = 0; i < pages.length; i++) {
        updateProgress(startPct + (i / pages.length) * (endPct - startPct), `${i + 1} / ${pages.length} 페이지 PDF 생성`);
        const canvas = await renderPageToCanvas(pages[i], q.max);
        try {
          const jpeg = await canvasToBlob(canvas, 'image/jpeg', q.jpg);
          const bytes = new Uint8Array(await jpeg.arrayBuffer());
          const ow = Math.max(1, pages[i].ocr?.width || canvas.width), oh = Math.max(1, pages[i].ocr?.height || canvas.height);
          const sx = canvas.width / ow, sy = canvas.height / oh;
          const ocrWords = searchable && pages[i].ocr ? pages[i].ocr.words.slice(0, LIMITS.ocrWords).map(w => ({
            text: w.text, x: w.left * sx, y: w.top * sy, w: w.width * sx, h: w.height * sy
          })) : [];
          pdfPages.push({ jpegBytes: bytes, width: canvas.width, height: canvas.height, ocrWords });
        } finally { releaseCanvas(canvas); }
      }
      updateProgress(96, 'PDF 구조와 검색 레이어를 저장하고 있습니다.');
      const pdfBytes = window.ScanBoxPDF.build({ pages: pdfPages, title: baseName, searchable });
      updateProgress(100, 'PDF 완료');
      return { blob: new Blob([pdfBytes], { type: 'application/pdf' }), name: `${baseName}${searchable ? '_OCR' : ''}.pdf` };
    } finally { state.busy = false; hideProgress(); renderPages(); }
  }

  async function createImagesOutput(pages,baseName,format){if(state.busy)throw new Error('다른 작업이 진행 중입니다.');if(pages.length>LIMITS.zipPages)throw new Error(`여러 이미지 내보내기는 메모리 보호를 위해 최대 ${LIMITS.zipPages}페이지까지 지원합니다.`);state.busy=true;const q=getQuality(),mime=format==='png'?'image/png':'image/jpeg',ext=format==='png'?'png':'jpg';try{showProgress('이미지 만들기','페이지를 이미지로 변환하고 있습니다.',0);const blobs=[];for(let i=0;i<pages.length;i++){updateProgress((i/pages.length)*90,`${i+1} / ${pages.length} 페이지 변환`);const canvas=await renderPageToCanvas(pages[i],q.max);blobs.push(await canvasToBlob(canvas,mime,format==='png'?undefined:q.jpg));releaseCanvas(canvas);}if(blobs.length===1)return{blob:blobs[0],name:`${baseName}.${ext}`};if(!window.JSZip)throw new Error('ZIP 라이브러리를 불러오지 못했습니다.');updateProgress(93,'여러 페이지를 ZIP으로 묶고 있습니다.');const zip=new window.JSZip();blobs.forEach((b,i)=>zip.file(`${baseName}_${String(i+1).padStart(2,'0')}.${ext}`,b));const out=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:5}});return{blob:out,name:`${baseName}_${ext.toUpperCase()}.zip`};}finally{state.busy=false;hideProgress();}}

  function pdfLoadOptions(bytes){
    return {
      data: bytes,
      isEvalSupported: false,
      useWasm: false,
      disableAutoFetch: true,
      disableStream: true,
      maxImageSize: LIMITS.canvasPixels,
      enableXfa: false,
      verbosity: 0,
    };
  }

  function safePdfViewport(page, baseScale=2.2, maxDimension=IMPORT_MAX){
    const initial=page.getViewport({scale:baseScale});
    const fitted=fitDimensions(initial.width,initial.height,maxDimension);
    return page.getViewport({scale:baseScale*fitted.scale});
  }

  function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function loadPdfDocument(pdfjs, bytes) {
    const task = pdfjs.getDocument(pdfLoadOptions(bytes));
    try {
      return await withTimeout(task.promise, LIMITS.pdfLoadMs, 'PDF 분석 시간이 30초를 초과해 안전을 위해 중단했습니다.');
    } catch (err) {
      try { await task.destroy?.(); } catch {}
      throw err;
    }
  }

  async function renderPdfPageSafely(page, canvasContext, viewport) {
    const task = page.render({ canvasContext, viewport });
    try {
      await withTimeout(task.promise, LIMITS.pdfRenderMs, 'PDF 페이지 렌더링이 30초를 초과해 안전을 위해 중단했습니다.');
    } catch (err) {
      try { task.cancel?.(); } catch {}
      throw err;
    }
  }

  async function importPdfToEditor(file){
    if(state.busy)return;
    await validatePdfFile(file);
    state.busy=true;
    let pdf=null;
    try{
      showProgress('PDF 편집 준비','PDF 실행 기능을 끄고 안전 모드로 페이지를 렌더링합니다.',0);
      const pdfjs=await getPdfJs();
      pdf=await loadPdfDocument(pdfjs,new Uint8Array(await file.arrayBuffer()));
      if(pdf.numPages>LIMITS.pages)throw new Error(`PDF 편집은 최대 ${LIMITS.pages}페이지까지 지원합니다.`);
      if(state.pages.length+pdf.numPages>LIMITS.pages)throw new Error(`현재 페이지와 합쳐 최대 ${LIMITS.pages}페이지까지 처리할 수 있습니다.`);
      for(let n=1;n<=pdf.numPages;n++){
        updateProgress(((n-1)/pdf.numPages)*95,`${n} / ${pdf.numPages} 페이지 가져오기`);
        const page=await pdf.getPage(n);
        const viewport=safePdfViewport(page,2.2,IMPORT_MAX);
        const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
        const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
        await renderPdfPageSafely(page,ctx,viewport);
        const blob=await canvasToBlob(canvas,'image/jpeg',0.94);releaseCanvas(canvas);
        const p=makePage(blob,`${file.name} · ${n}p`,blob);await refreshPreview(p);state.pages.push(p);page.cleanup?.();
      }
      renderPages();switchTab('scanner');updateProgress(100,'PDF 가져오기 완료');showToast(`${pdf.numPages}개의 편집 페이지가 준비되었습니다.`);
    }finally{
      try{pdf?.cleanup?.();pdf?.destroy?.();}catch{}
      state.busy=false;hideProgress();
    }
  }

  async function convertPdfToImages(file,format){
    if(state.busy)throw new Error('다른 작업이 진행 중입니다.');
    await validatePdfFile(file);
    state.busy=true;let pdf=null;
    try{
      showProgress('PDF 읽기','PDF 실행 기능을 끄고 안전 모드로 읽고 있습니다.',0);
      const pdfjs=await getPdfJs();
      pdf=await loadPdfDocument(pdfjs,new Uint8Array(await file.arrayBuffer()));
      if(pdf.numPages>LIMITS.zipPages)throw new Error(`PDF → 이미지 변환은 메모리 보호를 위해 최대 ${LIMITS.zipPages}페이지까지 지원합니다.`);
      const mime=format==='png'?'image/png':'image/jpeg',ext=format==='png'?'png':'jpg',base=sanitizeFileName(stripExtension(file.name)),blobs=[];
      for(let n=1;n<=pdf.numPages;n++){
        updateProgress(((n-1)/pdf.numPages)*90,`${n} / ${pdf.numPages} 페이지 렌더링`);
        const page=await pdf.getPage(n);const viewport=safePdfViewport(page,2.2,4000);
        const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
        const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
        await renderPdfPageSafely(page,ctx,viewport);
        blobs.push(await canvasToBlob(canvas,mime,format==='png'?undefined:.92));releaseCanvas(canvas);page.cleanup?.();
      }
      if(blobs.length===1)return{blob:blobs[0],name:`${base}.${ext}`};
      if(!window.JSZip)throw new Error('로컬 ZIP 라이브러리를 불러오지 못했습니다.');
      updateProgress(93,'ZIP으로 묶고 있습니다.');const zip=new window.JSZip();
      blobs.forEach((b,i)=>zip.file(`${base}_${String(i+1).padStart(2,'0')}.${ext}`,b));
      return{blob:await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:4}}),name:`${base}_${ext.toUpperCase()}.zip`};
    }finally{
      try{pdf?.cleanup?.();pdf?.destroy?.();}catch{}
      state.busy=false;hideProgress();
    }
  }

  async function getPdfJs(){
    if(state.pdfjs)return state.pdfjs;
    if(state.pdfjsPromise)return state.pdfjsPromise;
    state.pdfjsPromise=(async()=>{
      const rt=window.ScanBoxRuntime;if(!rt)throw new Error('보안 런타임을 불러오지 못했습니다.');
      await rt.warmAssets([SOURCES.pdfjsMain,SOURCES.pdfjsWorker]);
      const loaded=await rt.loadModule(SOURCES.pdfjsMain);
      state.pdfjs=loaded.module;
      state.pdfjs.GlobalWorkerOptions.workerSrc=rt.virtualUrl('pdfjs/pdf.worker.min.mjs');
      return state.pdfjs;
    })().catch(err=>{state.pdfjsPromise=null;throw err;});
    return state.pdfjsPromise;
  }


  function suggestFileName(text){
    const clean=String(text||'').replace(/\r/g,'');if(!clean.trim())return null;const types=['견적서','거래명세서','세금계산서','영수증','계약서','사업자등록증','발주서','청구서','거래내역서','검사성적서','보고서'];const type=types.find(t=>clean.replace(/\s/g,'').includes(t))||'문서';
    let date=kstDateString();const patterns=[/(20\d{2})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})/,/(20\d{2})\s*(\d{2})\s*(\d{2})/];for(const re of patterns){const m=clean.match(re);if(m){date=`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;break;}}
    const lines=clean.split('\n').map(s=>s.trim().replace(/\s{2,}/g,' ')).filter(Boolean);let company=lines.find(l=>/(주식회사|\(주\)|㈜)/.test(l)&&l.length<=45)||'';company=company.replace(/^(공급자|상호|회사명|업체명)\s*[:：]?\s*/,'').replace(/[\\/:*?"<>|]/g,'').trim();if(company.length>28)company=company.slice(0,28);return sanitizeFileName([date,company,type].filter(Boolean).join('_'));
  }

  function getQuality(){return QUALITY[els.qualityPreset?.value]||QUALITY.standard;}
  function updateEstimatedSize(){if(!els.estimatedSize)return;if(!state.pages.length){els.estimatedSize.textContent='페이지를 추가하면 예상 용량을 표시합니다.';return;}const sum=state.pages.reduce((s,p)=>s+(p.blob?.size||0),0),q=getQuality(),fmt=els.exportFormat.value;let factor=(q.jpg/.9)*(q.max/3000)**.45;if(fmt==='png')factor*=2.1;if(fmt==='pdf'||fmt==='searchable-pdf')factor*=1.05;if(fmt==='searchable-pdf')factor*=1.04;els.estimatedSize.textContent=`예상 약 ${formatBytes(Math.round(sum*factor))} · ${q.label}`;}

  function setLatestOutput(output){if(!output?.blob||!output?.name)return;state.latestOutput=output;els.outputInfo.textContent=`${output.name} · ${formatBytes(output.blob.size)}`;const f=new File([output.blob],output.name,{type:output.blob.type||'application/octet-stream'});const can=!!(navigator.share&&(!navigator.canShare||navigator.canShare({files:[f]})));els.shareOutputBtn.disabled=!navigator.share;els.shareOutputBtn.textContent=can?'공유 / 파일에 저장':'공유';openSheet(els.outputSheet);}
  async function shareBlob(blob,name){if(!navigator.share){downloadBlob(blob,name);return showToast('공유 기능이 없어 다운로드로 저장했습니다.');}const file=new File([blob],name,{type:blob.type||'application/octet-stream'});try{if(!navigator.canShare||navigator.canShare({files:[file]}))await navigator.share({files:[file],title:name});else await navigator.share({title:name,text:'ScanBox에서 만든 파일입니다.'});}catch(err){if(err?.name!=='AbortError'){downloadBlob(blob,name);showToast('공유 대신 다운로드로 저장했습니다.');}}}
  function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.rel='noopener';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}

  async function waitForCv(ms){
    if(state.cvReady)return true;
    try{
      return await Promise.race([
        ensureOpenCv().then(()=>true).catch(()=>false),
        new Promise(r=>setTimeout(()=>r(false),ms))
      ]);
    }catch{return false;}
  }

  function showProgress(title,text,percent=0){els.progressTitle.textContent=title;els.progressText.textContent=text;updateProgress(percent);els.progressOverlay.classList.remove('hidden');}
  function updateProgress(percent,text){const p=clamp(Number(percent)||0,0,100);els.progressBar.style.width=`${p}%`;els.progressPercent.textContent=`${Math.round(p)}%`;if(text)els.progressText.textContent=text;}
  function hideProgress(){els.progressOverlay.classList.add('hidden');}
  function openSheet(el){el?.classList.remove('hidden');document.body.style.overflow='hidden';}
  function closeSheet(el){el?.classList.add('hidden');if(!document.querySelector('.sheet:not(.hidden)'))document.body.style.overflow='';}
  function showToast(msg){els.toast.textContent=msg;els.toast.classList.remove('hidden');clearTimeout(showToast._t);showToast._t=setTimeout(()=>els.toast.classList.add('hidden'),2800);}
  function handleError(err,fallback){console.error(err);hideProgress();state.busy=false;const msg=err?.message?`${fallback}\n${err.message}`:fallback;alert(msg);}
  function updateSecurityStatus(label, detail){
    if(!els.securityBadge)return;
    if(label){els.securityBadge.textContent=label;if(detail)els.securityDetail.textContent=detail;return;}
    const rt=window.ScanBoxRuntime;
    if(!rt){els.securityBadge.textContent='제한';els.securityDetail.textContent='보안 런타임을 불러오지 못했습니다.';return;}
    const st=rt.status();
    if(!st.persistentPins){els.securityBadge.textContent='세션 잠금';els.securityDetail.textContent='브라우저 저장 제한으로 SHA-256 잠금이 현재 세션에만 유지됩니다.';}
    else if(!st.pinCount){els.securityBadge.textContent='준비 전';els.securityDetail.textContent='문서 보정/OCR/PDF 엔진은 최초 사용 또는 보안 준비 시 SHA-256 지문을 생성해 잠급니다.';}
    else{els.securityBadge.textContent='강화';els.securityDetail.textContent=`${st.pinCount}개 실행 자산을 버전 고정 + 최초 SHA-256 지문 잠금 후 앱 전용 캐시에서 사용합니다.`;}
  }

  function updateNetworkState(){const on=navigator.onLine;els.networkBadge.classList.toggle('offline',!on);els.networkBadge.querySelector('span').textContent=on?'온라인':'오프라인';}

  function loadImage(blob){return new Promise((resolve,reject)=>{const img=new Image(),url=URL.createObjectURL(blob);img._url=url;img.onload=()=>resolve(img);img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('이미지를 열 수 없습니다. HEIC 등 일부 형식은 브라우저 버전에 따라 제한될 수 있습니다.'));};img.src=url;});}
  function cleanupLoadedImage(img){if(img?._url)URL.revokeObjectURL(img._url);}
  function canvasToBlob(canvas,type,quality){return new Promise((resolve,reject)=>canvas.toBlob(b=>{if(b)return resolve(b);try{resolve(dataUrlToBlob(canvas.toDataURL(type,quality)));}catch(e){reject(e);}},type,quality));}
  function dataUrlToBlob(url){const [meta,data]=url.split(','),mime=meta.match(/data:(.*?);/)?.[1]||'application/octet-stream',bin=atob(data),arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);return new Blob([arr],{type:mime});}
  function releaseCanvas(canvas){try{const ctx=canvas.getContext('2d');ctx?.clearRect(0,0,canvas.width,canvas.height);canvas.width=1;canvas.height=1;}catch{}}
  function cleanupPages(pages){pages.forEach(revokePageUrls);}
  function revokePageUrls(page){if(page.previewUrl){URL.revokeObjectURL(page.previewUrl);page.previewUrl=null;}}
  function kstDateString(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()),get=t=>parts.find(p=>p.type===t)?.value;return`${get('year')}-${get('month')}-${get('day')}`;}
  function sanitizeFileName(name){const s=String(name||'ScanBox').replace(/[\\/:*?"<>|]/g,'_').replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g,'').replace(/\s+/g,' ').trim().replace(/^\.+/,'').slice(0,100);return s||'ScanBox';}
  function stripExtension(name){return String(name||'').replace(/\.[^.]+$/,'');}
  function formatBytes(b){if(!Number.isFinite(b))return'';if(b<1024)return`${b} B`;if(b<1048576)return`${(b/1024).toFixed(1)} KB`;return`${(b/1048576).toFixed(1)} MB`;}
  function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));}
})();
