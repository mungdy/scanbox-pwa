/* ScanBox PWA v1.1.7 - Robust Edge-Band Detection + Seamless Perspective
 * - v1.1 기능 유지 + 공급망/파일 입력/PDF 처리 보안 강화
 * - 외부 엔진은 버전 고정 URL에서 받아 SHA-256 TOFU 잠금 후 같은 출처 가상 캐시에 저장
 * - CSP, PDF.js eval 비활성화, 파일/페이지/캔버스 상한, 같은 출처 Service Worker 캐시
 * - 스캔 PDF 생성은 자체 경량 엔진, PDF 구조 편집은 고정 버전 pdf-lib 사용
 */
(() => {
  'use strict';

  const APP_VERSION = '1.1.7';
  const OFFLINE_READY_KEY = `scanbox.offline-ready.v${APP_VERSION}`;
  const THEME_KEY = 'scanbox.theme';
  const OCR_ENABLED_KEY = 'scanbox.ocr.enabled';
  const OCR_LANG_KEY = 'scanbox.ocr.languages';
  const PDF_PAGE_SIZE_KEY = 'scanbox.pdf.page-size';
  const DETECT_MAX = 1600;
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
    economy: { label: '용량 절약', max: 2000, jpg: 0.82, ocr: 2800 },
    standard: { label: '표준', max: 3000, jpg: 0.90, ocr: 3400 },
    high: { label: '고화질', max: 4500, jpg: 0.94, ocr: 4200 },
    max: { label: '원본에 가깝게', max: 5500, jpg: 0.97, ocr: 4600 },
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
    chiTra: asset('tessdata-chi-tra-1.0.0', 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_tra@1.0.0/4.0.0_best_int/chi_tra.traineddata.gz', 'tesseract/lang/chi_tra.traineddata.gz', 'application/gzip'),
    pdfLib: asset('pdf-lib-1.17.1', 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js', 'pdf-lib/pdf-lib.min.js'),
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
  const ALL_RUNTIME_ASSETS = [SOURCES.opencv, SOURCES.tesseractMain, SOURCES.tesseractWorker, ...TESS_CORE_ASSETS, SOURCES.kor, SOURCES.eng, SOURCES.chiTra, SOURCES.pdfjsMain, SOURCES.pdfjsWorker, SOURCES.pdfLib];
  const ESSENTIAL_RUNTIME_ASSETS = [SOURCES.tesseractMain, SOURCES.tesseractWorker, ...TESS_CORE_ASSETS, SOURCES.pdfjsMain, SOURCES.pdfjsWorker, SOURCES.pdfLib];

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
    ocrAssetsKey: '',
    ocrWorkerLangKey: '',
    pdfjs: null,
    pdfjsPromise: null,
    pdfLibPromise: null,
    pdfEditor: { docs: new Map(), pages: [], drag: null, ocrEditPageIds: [] },
    cropEditor: null,
    drag: null,
    scanPreviewIndex: -1,
    defaultName: '',
  };

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const els = {};

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    if (window.top !== window.self) { document.body.textContent = 'ScanBox는 보안을 위해 다른 사이트의 프레임 안에서 실행되지 않습니다.'; return; }
    cleanupLegacySecurityMetadata();
    Object.assign(els, {
      networkBadge: $('#networkBadge'), aboutBtn: $('#aboutBtn'),
      cameraBtn: $('#cameraBtn'), galleryBtn: $('#galleryBtn'),
      cameraInput: $('#cameraInput'), galleryInput: $('#galleryInput'),
      autoCorrectToggle: $('#autoCorrectToggle'), ocrToggle: $('#ocrToggle'), opencvState: $('#opencvState'),
      ocrLangRow: $('#ocrLangRow'), ocrLangKor: $('#ocrLangKor'), ocrLangEng: $('#ocrLangEng'), ocrLangChi: $('#ocrLangChi'),
      pageCount: $('#pageCount'), clearPagesBtn: $('#clearPagesBtn'), emptyPages: $('#emptyPages'), pageList: $('#pageList'),
      fileNameInput: $('#fileNameInput'),
      exportFormat: $('#exportFormat'), qualityPreset: $('#qualityPreset'), pdfPageSize: $('#pdfPageSize'), estimatedSize: $('#estimatedSize'),
      ocrPreviewBtn: $('#ocrPreviewBtn'), createOutputBtn: $('#createOutputBtn'),
      pdfEditorAddBtn: $('#pdfEditorAddBtn'), pdfEditorInput: $('#pdfEditorInput'), pdfEditorCount: $('#pdfEditorCount'), pdfEditorEmpty: $('#pdfEditorEmpty'), pdfEditorPages: $('#pdfEditorPages'),
      pdfSelectAllBtn: $('#pdfSelectAllBtn'), pdfExtractBtn: $('#pdfExtractBtn'), pdfOcrTextBtn: $('#pdfOcrTextBtn'), pdfDeleteBtn: $('#pdfDeleteBtn'), pdfClearBtn: $('#pdfClearBtn'), pdfMergeSaveBtn: $('#pdfMergeSaveBtn'), pdfSplitBtn: $('#pdfSplitBtn'), pdfSplitRanges: $('#pdfSplitRanges'),
      pdfImageFormat: $('#pdfImageFormat'), pdfToImageBtn: $('#pdfToImageBtn'), pdfInput: $('#pdfInput'),
      offlinePrepBtn: $('#offlinePrepBtn'), offlinePrepBadge: $('#offlinePrepBadge'), offlinePrepDetail: $('#offlinePrepDetail'), securityBadge: $('#securityBadge'), securityDetail: $('#securityDetail'), themeMode: $('#themeMode'),
      cropSheet: $('#cropSheet'), cropCanvas: $('#cropCanvas'), cropMagnifier: $('#cropMagnifier'), resetCropBtn: $('#resetCropBtn'), applyCropBtn: $('#applyCropBtn'),
      scanPreviewSheet: $('#scanPreviewSheet'), scanPreviewStage: $('#scanPreviewStage'), scanPreviewImage: $('#scanPreviewImage'), scanPreviewCounter: $('#scanPreviewCounter'), scanPreviewPrev: $('#scanPreviewPrev'), scanPreviewNext: $('#scanPreviewNext'),
      progressOverlay: $('#progressOverlay'), progressTitle: $('#progressTitle'), progressText: $('#progressText'), progressBar: $('#progressBar'), progressPercent: $('#progressPercent'),
      outputSheet: $('#outputSheet'), outputInfo: $('#outputInfo'), saveOutputBtn: $('#saveOutputBtn'), shareOutputBtn: $('#shareOutputBtn'),
      ocrSheet: $('#ocrSheet'), ocrTextArea: $('#ocrTextArea'), applyOcrTextBtn: $('#applyOcrTextBtn'), copyOcrBtn: $('#copyOcrBtn'), pdfOcrSheet: $('#pdfOcrSheet'), pdfOcrTextArea: $('#pdfOcrTextArea'), applyPdfOcrTextBtn: $('#applyPdfOcrTextBtn'), aboutSheet: $('#aboutSheet'), toast: $('#toast'),
    });

    state.defaultName = `${kstDateString()}_스캔`;
    els.fileNameInput.value = state.defaultName;

    bindNavigation();
    bindScanner();
    bindOcrPreference();
    bindPdfPageSize();
    bindPdfEditor();
    bindSheets();
    bindCropEditor();
    bindOfflinePrep();
    bindTheme();
    bindPageDrag();
    bindScanPreview();

    updateNetworkState();
    updateSecurityStatus();
    updateOfflinePrepStatus();
    window.addEventListener('online', updateNetworkState);
    window.addEventListener('offline', updateNetworkState);
    els.exportFormat.addEventListener('change', () => { updatePdfPageSizeUi(); updateEstimatedSize(); });
    els.qualityPreset.addEventListener('change', updateEstimatedSize);
    els.pdfPageSize?.addEventListener('change', updateEstimatedSize);

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js').then(() => {
        navigator.serviceWorker.addEventListener('message', onServiceWorkerMessage);
        updateSecurityStatus();
        // iPhone 첫 스캔에서 5초대 타임아웃으로 JS fallback이 먼저 실행되던 문제를 막기 위해
        // Service Worker가 현재 페이지를 제어하는 즉시 OpenCV를 백그라운드에서 선행 초기화합니다.
        if (navigator.serviceWorker.controller) setTimeout(preloadOpenCv, 80);
        else navigator.serviceWorker.addEventListener('controllerchange', () => setTimeout(preloadOpenCv, 80), { once: true });
      }).catch(err => {
        console.warn('Service Worker 등록 실패:', err);
        updateSecurityStatus('제한', 'Service Worker를 사용할 수 없어 보안 엔진 캐시 기능이 제한됩니다.');
      });
    } else {
      updateSecurityStatus('제한', 'HTTPS가 아니거나 Service Worker를 지원하지 않는 환경입니다.');
    }

    renderPages();
    els.opencvState.textContent = '문서 보정 · OpenCV 가속 엔진 준비 대기';
    els.opencvState.className = 'engine-state';
    window.addEventListener('pagehide', cleanupRuntime);
    console.info(`ScanBox PWA v${APP_VERSION} Security Hardened + Compatibility Fallback`);
  }


  function cleanupLegacySecurityMetadata() {
    // 앱 캐시는 Service Worker가 구버전을 지웁니다. localStorage의 작은 버전별 보안 기록도
    // 현재 버전만 남겨 장기간 업데이트 시 불필요한 메타데이터가 쌓이지 않게 합니다.
    const keepOffline = OFFLINE_READY_KEY;
    const keepPinPrefix = `scanbox.vendor-pin.v${APP_VERSION}.`;
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i) || '';
        if (key.startsWith('scanbox.offline-ready.v') && key !== keepOffline) localStorage.removeItem(key);
        else if (key.startsWith('scanbox.vendor-pin.v') && !key.startsWith(keepPinPrefix)) localStorage.removeItem(key);
      }
    } catch (err) { console.warn('구버전 보안 메타데이터 정리 생략:', err); }
  }

  function preloadOpenCv() {
    if (state.cvReady || state.cvPromise || state.busy) return;
    state.cvFailed = false;
    // 세션 시작 시 한 번만 적극적으로 시도합니다. iOS에서 실패 판정이 난 뒤 매 페이지마다
    // 60초 초기화를 반복하지 않고, 고정밀 JS 검출 + WebGL 보정으로 즉시 이어갑니다.
    ensureOpenCv(true).catch(err => console.warn('OpenCV 백그라운드 준비 실패 · 호환 엔진을 사용합니다.', err));
  }

  async function prepareOpenCvForCorrection() {
    if (state.cvReady && window.cv?.Mat) return true;
    if (state.cvFailed) return false;
    try {
      await ensureOpenCv(false);
      return !!(state.cvReady && window.cv?.Mat);
    } catch (err) {
      console.warn('OpenCV 준비 실패 · 고정밀 호환 검출/WebGL 보정으로 전환:', err);
      return false;
    }
  }

  function cleanupRuntime() {
    cleanupPages(state.pages);
    cleanupPdfEditor();
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

    els.cameraInput.addEventListener('change', onImageInput);
    els.galleryInput.addEventListener('change', onImageInput);
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
        if (btn.dataset.action === 'preview') {
          openScanPreview(idx); return;
        } else if (btn.dataset.action === 'delete') {
          revokePageUrls(page); state.pages.splice(idx, 1);
        } else if (btn.dataset.action === 'rotate') {
          page.rotation = (page.rotation + 90) % 360; invalidateOcr(page); await refreshPreview(page);
        } else if (btn.dataset.action === 'filter') {
          page.filter = btn.dataset.filter;
          if (page.filter === 'document' && !state.cvReady) prepareOpenCvForCorrection().catch(() => false);
          invalidateOcr(page); await refreshPreview(page);
        } else if (btn.dataset.action === 'crop') {
          await openCropEditor(page); return;
        }
        renderPages();
      } catch (err) { handleError(err, '페이지 편집 중 오류가 발생했습니다.'); }
    });

    els.ocrPreviewBtn.addEventListener('click', async () => {
      if (!els.ocrToggle?.checked) return showToast('OCR을 먼저 켜 주세요.');
      if (!state.pages.length || state.busy) return;
      state.busy = true;
      try {
        await ensureOcrData(state.pages, 0, 100, 'OCR 실행');
        els.ocrTextArea.value = state.pages.map((p, i) => `--- ${i + 1}페이지 ---\n${p.ocr?.editedText ?? p.ocr?.text ?? ''}`).join('\n\n');
        renderPages(); hideProgress(); openSheet(els.ocrSheet);
      } catch (err) { handleError(err, 'OCR 처리에 실패했습니다.'); }
      finally { state.busy = false; hideProgress(); }
    });

    els.createOutputBtn.addEventListener('click', async () => {
      if (!state.pages.length) return;
      const base = sanitizeFileName(els.fileNameInput.value || state.defaultName);
      const format = els.exportFormat.value;
      if (format === 'searchable-pdf' && !els.ocrToggle?.checked) return showToast('검색 가능한 PDF는 OCR을 켜야 사용할 수 있습니다.');
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

  function bindOcrPreference() {
    if (!els.ocrToggle) return;
    let enabled = false;
    let langs = ['kor','eng'];
    try {
      enabled = localStorage.getItem(OCR_ENABLED_KEY) === '1';
      const raw = localStorage.getItem(OCR_LANG_KEY);
      if (raw) {
        const parsed = raw.split(',').filter(v => ['kor','eng','chi_tra'].includes(v));
        if (parsed.length) langs = parsed;
      }
    } catch {}
    els.ocrToggle.checked = enabled;
    els.ocrLangKor.checked = langs.includes('kor');
    els.ocrLangEng.checked = langs.includes('eng');
    els.ocrLangChi.checked = langs.includes('chi_tra');
    updateOcrUi();
    els.ocrToggle.addEventListener('change', () => {
      try { localStorage.setItem(OCR_ENABLED_KEY, els.ocrToggle.checked ? '1' : '0'); } catch {}
      updateOcrUi();
      renderPages();
      if (els.ocrToggle.checked) showToast('OCR을 켰습니다. 선택한 언어만 필요할 때 불러옵니다.');
    });
    [els.ocrLangKor, els.ocrLangEng, els.ocrLangChi].forEach(input => input?.addEventListener('change', async e => {
      if (!getSelectedOcrLanguages().length) {
        e.target.checked = true;
        return showToast('OCR 언어를 하나 이상 선택해 주세요.');
      }
      try {
        localStorage.setItem(OCR_LANG_KEY, getSelectedOcrLanguages().join(','));
        localStorage.removeItem(OFFLINE_READY_KEY);
      } catch {}
      invalidateAllOcr();
      await resetOcrWorker();
      updateOcrUi();
      updateOfflinePrepStatus();
      renderPages();
    }));
  }

  function getSelectedOcrLanguages() {
    const out = [];
    if (els.ocrLangKor?.checked) out.push('kor');
    if (els.ocrLangEng?.checked) out.push('eng');
    if (els.ocrLangChi?.checked) out.push('chi_tra');
    return out;
  }

  function getSelectedOcrLanguageAssets() {
    const langs = getSelectedOcrLanguages();
    const out = [];
    if (langs.includes('kor')) out.push(SOURCES.kor);
    if (langs.includes('eng')) out.push(SOURCES.eng);
    if (langs.includes('chi_tra')) out.push(SOURCES.chiTra);
    return out;
  }

  function ocrLanguageLabel() {
    return getSelectedOcrLanguages().map(v => v === 'kor' ? 'KOR' : v === 'eng' ? 'ENG' : 'CHI').join(' + ');
  }

  async function resetOcrWorker() {
    if (state.ocrWorkerTimer) { clearTimeout(state.ocrWorkerTimer); state.ocrWorkerTimer = null; }
    const worker = state.ocrWorker;
    state.ocrWorker = null;
    state.ocrWorkerLangKey = '';
    state.ocrAssetsPromise = null;
    state.ocrAssetsKey = '';
    if (worker?.terminate) { try { await worker.terminate(); } catch {} }
  }

  function invalidateAllOcr() {
    state.pages.forEach(invalidateOcr);
  }

  function updateOcrUi() {
    const enabled = !!els.ocrToggle?.checked;
    const searchable = els.exportFormat?.querySelector('option[value="searchable-pdf"]');
    if (searchable) {
      searchable.disabled = !enabled;
      searchable.textContent = enabled ? '검색 가능한 PDF' : '검색 가능한 PDF · OCR 필요';
    }
    if (!enabled && els.exportFormat?.value === 'searchable-pdf') els.exportFormat.value = 'pdf';
    if (els.ocrPreviewBtn) els.ocrPreviewBtn.disabled = !enabled || state.pages.length === 0;
    if (els.ocrLangRow) els.ocrLangRow.classList.toggle('disabled', !enabled);
    updateEstimatedSize();
  }

  function updatePdfPageSizeUi() {
    if (!els.pdfPageSize) return;
    const isPdf = ['pdf','searchable-pdf'].includes(els.exportFormat?.value);
    els.pdfPageSize.disabled = !isPdf;
    els.pdfPageSize.closest('.field-group')?.classList.toggle('field-disabled', !isPdf);
  }

  function bindPdfPageSize() {
    if (!els.pdfPageSize) return;
    let value = 'fit';
    try { value = localStorage.getItem(PDF_PAGE_SIZE_KEY) || 'fit'; } catch {}
    if (!['fit','a3','a4','a5','b4','b5','letter','legal'].includes(value)) value = 'fit';
    els.pdfPageSize.value = value;
    updatePdfPageSizeUi();
    els.pdfPageSize.addEventListener('change', () => {
      try { localStorage.setItem(PDF_PAGE_SIZE_KEY, els.pdfPageSize.value); } catch {}
      updateEstimatedSize();
    });
  }

  function bindPdfEditor() {
    els.pdfEditorAddBtn?.addEventListener('click', () => els.pdfEditorInput.click());
    els.pdfEditorInput?.addEventListener('change', async e => {
      const files = [...(e.target.files || [])]; e.target.value = '';
      if (!files.length || state.busy) return;
      try { await addPdfFilesToEditor(files); }
      catch (err) { handleError(err, 'PDF를 편집기에 추가하지 못했습니다.'); }
    });

    els.pdfEditorPages?.addEventListener('change', e => {
      const card = e.target.closest('[data-editor-page-id]');
      const page = state.pdfEditor.pages.find(p => p.id === card?.dataset.editorPageId);
      if (!page) return;
      if (e.target.matches('[data-editor-select]')) {
        page.selected = !!e.target.checked;
        renderPdfEditor();
      } else if (e.target.matches('[data-editor-order]')) {
        movePdfEditorPage(page.id, e.target.value);
      }
    });
    els.pdfEditorPages?.addEventListener('click', e => {
      const btn = e.target.closest('button[data-editor-action]');
      if (!btn || state.busy) return;
      const card = btn.closest('[data-editor-page-id]');
      const idx = state.pdfEditor.pages.findIndex(p => p.id === card?.dataset.editorPageId);
      if (idx < 0) return;
      if (btn.dataset.editorAction === 'delete') {
        revokeEditorPage(state.pdfEditor.pages[idx]);
        state.pdfEditor.pages.splice(idx, 1);
        prunePdfEditorDocs();
        renderPdfEditor();
      }
    });

    els.pdfSelectAllBtn?.addEventListener('click', () => {
      const all = state.pdfEditor.pages.length > 0 && state.pdfEditor.pages.every(p => p.selected);
      state.pdfEditor.pages.forEach(p => p.selected = !all);
      renderPdfEditor();
    });
    els.pdfDeleteBtn?.addEventListener('click', () => {
      const keep = [];
      for (const page of state.pdfEditor.pages) {
        if (page.selected) revokeEditorPage(page); else keep.push(page);
      }
      state.pdfEditor.pages = keep;
      prunePdfEditorDocs();
      renderPdfEditor();
    });
    els.pdfClearBtn?.addEventListener('click', () => { cleanupPdfEditor(); renderPdfEditor(); });
    els.pdfExtractBtn?.addEventListener('click', async () => {
      const selected = state.pdfEditor.pages.filter(p => p.selected);
      if (!selected.length || state.busy) return;
      try {
        state.busy = true;
        showProgress('PDF 추출', '선택한 페이지를 원본 구조로 복사하고 있습니다.', 5);
        const bytes = await buildPdfEditorBytes(selected, p => updateProgress(10 + p * 82, '선택 페이지 추출 중'));
        setLatestOutput({ blob: new Blob([bytes], { type: 'application/pdf' }), name: `${kstDateString()}_선택페이지.pdf` });
      } catch (err) { handleError(err, '선택 페이지를 추출하지 못했습니다.'); }
      finally { state.busy = false; hideProgress(); }
    });
    els.pdfOcrTextBtn?.addEventListener('click', async () => {
      const selected = state.pdfEditor.pages.filter(p => p.selected);
      if (!selected.length || state.busy) return;
      try {
        state.busy = true;
        showProgress('OCR 텍스트 읽기', '선택한 PDF의 검색 텍스트를 읽고 있습니다.', 0);
        const chunks = [];
        for (let i = 0; i < selected.length; i++) {
          const page = selected[i];
          const text = page.ocrTextOverride != null ? page.ocrTextOverride : await extractPdfPageText(page);
          chunks.push(`--- ${i + 1}선택 · 편집 ${state.pdfEditor.pages.indexOf(page) + 1}페이지 ---\n${text}`);
          updateProgress(((i + 1) / selected.length) * 100, `${i + 1} / ${selected.length} 페이지 텍스트 읽기`);
        }
        state.pdfEditor.ocrEditPageIds = selected.map(p => p.id);
        els.pdfOcrTextArea.value = chunks.join('\n\n');
        hideProgress(); openSheet(els.pdfOcrSheet);
      } catch (err) { handleError(err, 'PDF OCR 텍스트를 읽지 못했습니다.'); }
      finally { state.busy = false; hideProgress(); }
    });

    els.pdfMergeSaveBtn?.addEventListener('click', async () => {
      if (!state.pdfEditor.pages.length || state.busy) return;
      try {
        state.busy = true;
        showProgress('PDF 저장', '현재 순서대로 페이지를 합치고 있습니다.', 5);
        const bytes = await buildPdfEditorBytes(state.pdfEditor.pages, p => updateProgress(10 + p * 82, 'PDF 페이지 복사 중'));
        setLatestOutput({ blob: new Blob([bytes], { type: 'application/pdf' }), name: `${kstDateString()}_PDF편집.pdf` });
      } catch (err) { handleError(err, 'PDF를 저장하지 못했습니다.'); }
      finally { state.busy = false; hideProgress(); }
    });
    els.pdfSplitBtn?.addEventListener('click', async () => {
      if (!state.pdfEditor.pages.length || state.busy) return;
      try {
        const groups = parsePdfSplitRanges(els.pdfSplitRanges.value, state.pdfEditor.pages.length);
        if (!groups.length) return showToast('나눌 범위를 입력해 주세요. 예: 1-3, 4-6');
        state.busy = true;
        showProgress('PDF 나누기', '범위별 PDF를 만들고 있습니다.', 2);
        const outputs = [];
        for (let i = 0; i < groups.length; i++) {
          const entries = groups[i].map(n => state.pdfEditor.pages[n - 1]).filter(Boolean);
          const bytes = await buildPdfEditorBytes(entries, p => updateProgress(((i + p) / groups.length) * 88, `${i + 1} / ${groups.length} PDF 생성`));
          outputs.push({ bytes, label: groups[i].length === 1 ? `${groups[i][0]}` : `${groups[i][0]}-${groups[i][groups[i].length - 1]}` });
        }
        if (outputs.length === 1) {
          setLatestOutput({ blob: new Blob([outputs[0].bytes], { type: 'application/pdf' }), name: `${kstDateString()}_분할_${outputs[0].label}.pdf` });
        } else {
          if (!window.JSZip) throw new Error('ZIP 라이브러리를 불러오지 못했습니다.');
          const zip = new window.JSZip();
          outputs.forEach((o, i) => zip.file(`${kstDateString()}_분할_${String(i + 1).padStart(2, '0')}_${o.label}.pdf`, o.bytes));
          updateProgress(94, '분할 PDF를 ZIP으로 묶고 있습니다.');
          const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
          setLatestOutput({ blob, name: `${kstDateString()}_PDF분할.zip` });
        }
      } catch (err) { handleError(err, 'PDF를 나누지 못했습니다.'); }
      finally { state.busy = false; hideProgress(); }
    });

    els.pdfToImageBtn?.addEventListener('click', () => els.pdfInput.click());
    els.pdfInput?.addEventListener('change', async e => {
      const file = e.target.files?.[0]; e.target.value = '';
      if (!file) return;
      try { setLatestOutput(await convertPdfToImages(file, els.pdfImageFormat.value)); }
      catch (err) { handleError(err, 'PDF를 이미지로 변환하지 못했습니다. 암호 PDF이거나 지원하지 않는 파일일 수 있습니다.'); }
    });

    bindPdfEditorDrag();
    renderPdfEditor();
  }

  async function addPdfFilesToEditor(files) {
    const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
    if (totalBytes > LIMITS.batchBytes) throw new Error('한 번에 추가한 PDF 총 용량이 200 MB를 초과합니다.');
    for (const file of files) await validatePdfFile(file);
    state.busy = true;
    let added = 0;
    try {
      showProgress('PDF 편집 준비', '페이지 정보를 안전하게 읽고 있습니다.', 0);
      const pdfjs = await getPdfJs();
      for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        const raw = new Uint8Array(await file.arrayBuffer());
        const sourceId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
        let pdf = null;
        try {
          pdf = await loadPdfDocument(pdfjs, raw.slice());
          if (state.pdfEditor.pages.length + pdf.numPages > LIMITS.pages) throw new Error(`PDF 편집은 최대 ${LIMITS.pages}페이지까지 지원합니다.`);
          state.pdfEditor.docs.set(sourceId, { id: sourceId, name: file.name, bytes: raw });
          for (let n = 1; n <= pdf.numPages; n++) {
            updateProgress(((fi + (n - 1) / pdf.numPages) / files.length) * 92, `${file.name} · ${n} / ${pdf.numPages} 페이지`);
            const page = await pdf.getPage(n);
            const viewport = safePdfViewport(page, 0.65, 520);
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
            const ctx = canvas.getContext('2d', { alpha: false }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
            await renderPdfPageSafely(page, ctx, viewport);
            const thumb = await canvasToBlob(canvas, 'image/jpeg', 0.78); releaseCanvas(canvas); page.cleanup?.();
            state.pdfEditor.pages.push({
              id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
              sourceId, pageIndex: n - 1, sourceName: file.name, originalPage: n,
              previewUrl: URL.createObjectURL(thumb), selected: false,
            });
            added++;
          }
        } finally { try { pdf?.cleanup?.(); await pdf?.destroy?.(); } catch {} }
      }
      renderPdfEditor();
      updateProgress(100, 'PDF 편집 준비 완료');
      showToast(`${added}페이지를 PDF 편집기에 추가했습니다.`);
    } finally { state.busy = false; hideProgress(); }
  }

  function renderPdfEditor() {
    if (!els.pdfEditorPages) return;
    const pages = state.pdfEditor.pages;
    const selected = pages.filter(p => p.selected).length;
    els.pdfEditorCount.textContent = pages.length ? `${pages.length}페이지 · ${selected}개 선택` : 'PDF를 추가해 주세요.';
    els.pdfEditorEmpty.classList.toggle('hidden', pages.length > 0);
    [els.pdfSelectAllBtn, els.pdfClearBtn, els.pdfMergeSaveBtn, els.pdfSplitBtn].forEach(b => { if (b) b.disabled = pages.length === 0; });
    [els.pdfExtractBtn, els.pdfOcrTextBtn, els.pdfDeleteBtn].forEach(b => { if (b) b.disabled = selected === 0; });
    if (els.pdfSelectAllBtn) els.pdfSelectAllBtn.textContent = pages.length && selected === pages.length ? '선택 해제' : '전체 선택';
    els.pdfEditorPages.innerHTML = pages.map((page, idx) => `
      <article class="pdf-page-card ${page.selected ? 'selected' : ''}" data-editor-page-id="${escapeHtml(page.id)}">
        <label class="pdf-page-check"><input type="checkbox" data-editor-select ${page.selected ? 'checked' : ''} /><span>${idx + 1}</span></label>
        <div class="pdf-thumb-drag" data-editor-sort-handle><img src="${escapeHtml(page.previewUrl)}" alt="${idx + 1}페이지" /></div>
        <div class="pdf-page-meta"><strong>${idx + 1}페이지${page.ocrTextOverride != null ? ' · OCR 수정됨' : ''}</strong><span>${escapeHtml(page.sourceName)} · 원본 ${page.originalPage}p</span></div>
        <label class="pdf-order-field"><span>순서</span><input type="number" data-editor-order min="1" max="${pages.length}" value="${idx + 1}" inputmode="numeric" /></label>
        <button class="pdf-page-delete" data-editor-action="delete">삭제</button>
      </article>`).join('');
  }

  function movePdfEditorPage(pageId, targetOneBased) {
    const pages = state.pdfEditor.pages;
    const from = pages.findIndex(p => p.id === pageId);
    if (from < 0) return;
    const target = clamp(Math.round(Number(targetOneBased) || 1), 1, pages.length) - 1;
    if (target === from) return;
    const [page] = pages.splice(from, 1); pages.splice(target, 0, page); renderPdfEditor();
  }

  function bindPdfEditorDrag() {
    const host = els.pdfEditorPages;
    if (!host) return;
    host.addEventListener('pointerdown', e => {
      const handle = e.target.closest('[data-editor-sort-handle]');
      if (!handle || state.busy) return;
      const card = handle.closest('.pdf-page-card'); if (!card) return;
      e.preventDefault(); state.pdfEditor.drag = { card, pointerId: e.pointerId }; card.classList.add('dragging');
      try { handle.setPointerCapture(e.pointerId); } catch {}
    });
    window.addEventListener('pointermove', e => {
      const d = state.pdfEditor.drag; if (!d || e.pointerId !== d.pointerId) return;
      e.preventDefault();
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.pdf-page-card');
      if (!target || target === d.card || target.parentNode !== host) return;
      const rect = target.getBoundingClientRect();
      host.insertBefore(d.card, e.clientY < rect.top + rect.height / 2 ? target : target.nextSibling);
    }, { passive: false });
    const finish = e => {
      const d = state.pdfEditor.drag; if (!d || (e.pointerId != null && e.pointerId !== d.pointerId)) return;
      d.card.classList.remove('dragging');
      const ids = [...host.querySelectorAll('.pdf-page-card')].map(el => el.dataset.editorPageId);
      const byId = new Map(state.pdfEditor.pages.map(p => [p.id, p]));
      state.pdfEditor.pages = ids.map(id => byId.get(id)).filter(Boolean);
      state.pdfEditor.drag = null; renderPdfEditor();
    };
    window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
  }

  async function ensurePdfLib() {
    if (window.PDFLib?.PDFDocument) return window.PDFLib;
    if (state.pdfLibPromise) return state.pdfLibPromise;
    state.pdfLibPromise = (async () => {
      const rt = window.ScanBoxRuntime; if (!rt) throw new Error('보안 런타임을 불러오지 못했습니다.');
      await rt.loadScript({ ...SOURCES.pdfLib, globalCheck: () => !!window.PDFLib?.PDFDocument });
      return window.PDFLib;
    })().catch(err => { state.pdfLibPromise = null; throw err; });
    return state.pdfLibPromise;
  }

  async function buildPdfEditorBytes(entries, onProgress) {
    if (!entries.length) throw new Error('저장할 PDF 페이지가 없습니다.');
    const lib = await ensurePdfLib();
    const out = await lib.PDFDocument.create();
    const loaded = new Map();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const source = state.pdfEditor.docs.get(entry.sourceId);
      if (!source) throw new Error('PDF 원본 페이지 정보를 찾지 못했습니다.');
      let src = loaded.get(entry.sourceId);
      if (!src) {
        src = await lib.PDFDocument.load(source.bytes.slice(), { ignoreEncryption: false, updateMetadata: false });
        loaded.set(entry.sourceId, src);
      }
      if (entry.ocrTextOverride != null) {
        const rebuiltBytes = await rebuildPdfEditorPageWithOcr(entry);
        const rebuilt = await lib.PDFDocument.load(rebuiltBytes, { ignoreEncryption: false });
        const [copied] = await out.copyPages(rebuilt, [0]);
        out.addPage(copied);
      } else {
        const [copied] = await out.copyPages(src, [entry.pageIndex]);
        out.addPage(copied);
      }
      onProgress?.((i + 1) / entries.length);
    }
    return await out.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
  }

  async function extractPdfPageText(entry) {
    const source = state.pdfEditor.docs.get(entry.sourceId);
    if (!source) throw new Error('PDF 원본을 찾지 못했습니다.');
    const pdfjs = await getPdfJs();
    let pdf = null;
    try {
      pdf = await loadPdfDocument(pdfjs, source.bytes.slice());
      const page = await pdf.getPage(entry.pageIndex + 1);
      const content = await page.getTextContent({ disableNormalization: false });
      page.cleanup?.();
      return (content.items || []).map(item => String(item.str || '')).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    } finally { try { pdf?.cleanup?.(); await pdf?.destroy?.(); } catch {} }
  }

  function applyPdfOcrTextEdits() {
    const ids = state.pdfEditor.ocrEditPageIds || [];
    const raw = String(els.pdfOcrTextArea?.value || '');
    const re = /^---\s*(\d+)선택\s*·\s*편집\s*(\d+)페이지\s*---\s*$/gm;
    const marks = []; let m;
    while ((m = re.exec(raw))) marks.push({ selection: Number(m[1]), start: re.lastIndex, markerStart: m.index });
    if (!marks.length) return showToast('페이지 구분 표시를 찾지 못했습니다.');
    for (let i = 0; i < marks.length; i++) {
      const id = ids[marks[i].selection - 1];
      const page = state.pdfEditor.pages.find(p => p.id === id);
      if (!page) continue;
      const end = i + 1 < marks.length ? marks[i + 1].markerStart : raw.length;
      page.ocrTextOverride = raw.slice(marks[i].start, end).trim();
    }
    closeSheet(els.pdfOcrSheet); renderPdfEditor(); showToast('선택한 페이지의 OCR 검색 텍스트 수정을 저장했습니다.');
  }

  async function rebuildPdfEditorPageWithOcr(entry) {
    const source = state.pdfEditor.docs.get(entry.sourceId);
    if (!source) throw new Error('PDF 원본을 찾지 못했습니다.');
    const pdfjs = await getPdfJs();
    let pdf = null;
    try {
      pdf = await loadPdfDocument(pdfjs, source.bytes.slice());
      const page = await pdf.getPage(entry.pageIndex + 1);
      const viewport = safePdfViewport(page, 2.25, 4200);
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { alpha: false }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await renderPdfPageSafely(page, ctx, viewport);
      const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.94); const jpegBytes = new Uint8Array(await jpeg.arrayBuffer());
      const bytes = window.ScanBoxPDF.build({ pages: [{ jpegBytes, width: canvas.width, height: canvas.height, ocrWords: [], ocrTextOverride: entry.ocrTextOverride }], title: 'ScanBox OCR edit', searchable: true, pageSize: 'fit' });
      releaseCanvas(canvas); page.cleanup?.(); return bytes;
    } finally { try { pdf?.cleanup?.(); await pdf?.destroy?.(); } catch {} }
  }

  function parsePdfSplitRanges(text, total) {
    const groups = [];
    for (const part of String(text || '').split(',').map(v => v.trim()).filter(Boolean)) {
      const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!m) throw new Error(`범위 형식이 올바르지 않습니다: ${part}`);
      let a = Number(m[1]), b = Number(m[2] || m[1]);
      if (a < 1 || b < 1 || a > total || b > total) throw new Error(`페이지 범위는 1 ~ ${total} 사이여야 합니다.`);
      if (a > b) [a, b] = [b, a];
      groups.push(Array.from({ length: b - a + 1 }, (_, i) => a + i));
    }
    return groups;
  }

  function revokeEditorPage(page) { if (page?.previewUrl) { try { URL.revokeObjectURL(page.previewUrl); } catch {} } }
  function prunePdfEditorDocs() {
    const used = new Set(state.pdfEditor.pages.map(p => p.sourceId));
    for (const id of state.pdfEditor.docs.keys()) if (!used.has(id)) state.pdfEditor.docs.delete(id);
  }
  function cleanupPdfEditor() {
    if (!state.pdfEditor) return;
    state.pdfEditor.pages.forEach(revokeEditorPage);
    state.pdfEditor.pages = []; state.pdfEditor.docs.clear(); state.pdfEditor.drag = null; state.pdfEditor.ocrEditPageIds = [];
  }

  function bindSheets() {
    $$('[data-close-output]').forEach(el => el.addEventListener('click', () => closeSheet(els.outputSheet)));
    $$('[data-close-ocr]').forEach(el => el.addEventListener('click', () => closeSheet(els.ocrSheet)));
    $$('[data-close-about]').forEach(el => el.addEventListener('click', () => closeSheet(els.aboutSheet)));
    $$('[data-close-pdf-ocr]').forEach(el => el.addEventListener('click', () => closeSheet(els.pdfOcrSheet)));
    els.applyPdfOcrTextBtn?.addEventListener('click', applyPdfOcrTextEdits);
    $$('[data-close-crop]').forEach(el => el.addEventListener('click', closeCropEditor));
    els.saveOutputBtn.addEventListener('click', () => state.latestOutput && downloadBlob(state.latestOutput.blob, state.latestOutput.name));
    els.shareOutputBtn.addEventListener('click', () => state.latestOutput && shareBlob(state.latestOutput.blob, state.latestOutput.name));
    els.applyOcrTextBtn?.addEventListener('click', applyOcrTextEdits);
    els.copyOcrBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(els.ocrTextArea.value); }
      catch { els.ocrTextArea.select(); document.execCommand('copy'); }
      showToast('OCR 텍스트를 복사했습니다.');
    });
  }

  function applyOcrTextEdits() {
    const raw = String(els.ocrTextArea?.value || '');
    const re = /^---\s*(\d+)페이지\s*---\s*$/gm;
    const marks = [];
    let m;
    while ((m = re.exec(raw))) marks.push({ page: Number(m[1]), start: re.lastIndex, markerStart: m.index });
    if (!marks.length) return showToast('페이지 구분 표시를 찾지 못했습니다.');
    for (let i = 0; i < marks.length; i++) {
      const page = state.pages[marks[i].page - 1];
      if (!page?.ocr) continue;
      const end = i + 1 < marks.length ? marks[i + 1].markerStart : raw.length;
      page.ocr.editedText = raw.slice(marks[i].start, end).trim();
    }
    renderPages();
    showToast('OCR 수정 내용을 검색 PDF에 반영하도록 저장했습니다.');
  }

  function bindTheme() {
    if (!els.themeMode) return;
    let pref = 'system';
    try { pref = localStorage.getItem(THEME_KEY) || document.documentElement.dataset.themePreference || 'system'; } catch {}
    if (!['system','light','dark'].includes(pref)) pref = 'system';
    els.themeMode.value = pref;
    applyTheme(pref, false);
    els.themeMode.addEventListener('change', () => applyTheme(els.themeMode.value, true));
    try {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener?.('change', () => {
        if ((els.themeMode?.value || 'system') === 'system') applyTheme('system', false);
      });
    } catch {}
  }

  function applyTheme(pref, persist = true) {
    if (!['system','light','dark'].includes(pref)) pref = 'system';
    const dark = pref === 'dark' || (pref === 'system' && !!globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
    const actual = dark ? 'dark' : 'light';
    document.documentElement.dataset.themePreference = pref;
    document.documentElement.dataset.theme = actual;
    if (persist) { try { localStorage.setItem(THEME_KEY, pref); } catch {} }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#0f1115' : '#ffffff';
    const status = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (status) status.content = dark ? 'black-translucent' : 'default';
  }

  function readOfflinePrepRecord() {
    try { return JSON.parse(localStorage.getItem(OFFLINE_READY_KEY) || 'null'); } catch { return null; }
  }

  function writeOfflinePrepRecord(record) {
    try { localStorage.setItem(OFFLINE_READY_KEY, JSON.stringify(record)); } catch {}
  }

  function updateOfflinePrepStatus(record = readOfflinePrepRecord()) {
    if (!els.offlinePrepBadge || !els.offlinePrepBtn || !els.offlinePrepDetail) return;
    els.offlinePrepBtn.classList.remove('is-ready','is-warn','is-busy');
    els.offlinePrepBadge.classList.remove('offline-ready','offline-warn');
    if (record?.ready) {
      els.offlinePrepBadge.textContent = '준비 완료 ✓';
      els.offlinePrepBadge.classList.add('offline-ready');
      els.offlinePrepBtn.classList.add('is-ready');
      els.offlinePrepDetail.textContent = record.compatMode
        ? '현재 버전 준비 완료 · 문서 보정은 고정밀 호환 엔진 사용'
        : '현재 버전 엔진 검증과 로컬 캐시 준비 완료';
    } else if (record?.failed) {
      els.offlinePrepBadge.textContent = '확인 필요 · 다시 준비';
      els.offlinePrepBadge.classList.add('offline-warn');
      els.offlinePrepBtn.classList.add('is-warn');
      els.offlinePrepDetail.textContent = `${record.failed}개 필수 구성 요소 준비 실패 · 인터넷 연결 후 다시 시도`;
    } else {
      els.offlinePrepBadge.textContent = '준비 전 · 준비하기';
      els.offlinePrepDetail.textContent = '필요한 엔진을 검증해 앱 전용 캐시에 준비합니다.';
    }
  }

  function bindOfflinePrep() {
    els.offlinePrepBtn.addEventListener('click', async () => {
      if (!('serviceWorker' in navigator)) return showToast('이 브라우저에서는 보안 오프라인 준비를 지원하지 않습니다.');
      if (!window.ScanBoxRuntime) return showToast('보안 런타임을 불러오지 못했습니다.');
      if (state.busy) return;
      state.busy = true;
      if (els.offlinePrepBadge) { els.offlinePrepBadge.textContent = '준비 중…'; els.offlinePrepBadge.classList.remove('offline-ready','offline-warn'); }
      els.offlinePrepBtn?.classList.add('is-busy');
      if (els.offlinePrepDetail) els.offlinePrepDetail.textContent = '앱 파일과 필수 엔진을 검증하고 있습니다.';
      try {
        const reg = await navigator.serviceWorker.ready;
        const worker = reg.active || reg.waiting || reg.installing;
        if (!worker) throw new Error('Service Worker가 아직 준비되지 않았습니다.');
        showProgress('보안 · 오프라인 준비', '앱 파일을 먼저 저장하고 있습니다.', 0);
        worker.postMessage({ type: 'PREPARE_OFFLINE' });
      } catch (err) {
        state.busy = false;
        const record={ready:false,failed:1,at:Date.now(),version:APP_VERSION}; writeOfflinePrepRecord(record); updateOfflinePrepStatus(record);
        handleError(err, '보안 오프라인 준비를 시작하지 못했습니다.');
      }
    });
  }

  function onServiceWorkerMessage(e) {
    const data = e.data || {};
    if (data.type === 'OFFLINE_PROGRESS') updateProgress(data.percent || 0, data.label || '앱 파일 저장 중');
    if (data.type === 'OFFLINE_DONE') warmOfflineEngines(data.failures || 0);
    if (data.type === 'OFFLINE_ERROR') { state.busy = false; hideProgress(); const record={ready:false,failed:1,at:Date.now(),version:APP_VERSION}; writeOfflinePrepRecord(record); updateOfflinePrepStatus(record); showToast(`일부 앱 파일 저장 실패: ${data.label || '네트워크를 확인해 주세요.'}`); }
  }

  async function warmOfflineEngines(baseFailures = 0) {
    let essentialFailures = baseFailures;
    let compatMode = false;
    const rt = window.ScanBoxRuntime;

    if (!rt) {
      essentialFailures++;
    } else {
      const essentialAssets = [...ESSENTIAL_RUNTIME_ASSETS, ...getSelectedOcrLanguageAssets()];
      for (let i = 0; i < essentialAssets.length; i++) {
        const item = essentialAssets[i];
        try {
          const base = 20 + (i / essentialAssets.length) * 54;
          const span = 54 / essentialAssets.length;
          await rt.ensureAsset({ ...item, onProgress: p => updateProgress(base + span * (p || 0), `${item.name} 지문 생성 · 저장 중`) });
        } catch (err) {
          essentialFailures++;
          console.warn('필수 런타임 준비 실패:', item.name, err);
        }
      }

      // OpenCV는 가속 엔진입니다. 실패해도 내장 JS 보정 엔진으로 스캔/4점 보정이 계속 동작합니다.
      try {
        updateProgress(75, '문서 보정 가속 엔진 확인 중');
        await rt.ensureAsset(SOURCES.opencv);
        await ensureOpenCv();
      } catch (err) {
        compatMode = true;
        console.warn('OpenCV 가속 준비 실패 · 고정밀 호환 엔진 사용:', err);
        state.cvFailed = true;
        els.opencvState.textContent = '문서 보정 · 고정밀 호환 엔진 활성화';
        els.opencvState.className = 'engine-state ok';
      }
    }

    try {
      updateProgress(82, `${ocrLanguageLabel()} OCR 모델 초기화 중`);
      const worker = await getOcrWorker(m => {
        if (m.status === 'loading language traineddata') updateProgress(82 + (m.progress || 0) * 10, 'OCR 언어 모델 준비 중');
      });
      if (state.ocrWorkerTimer) { clearTimeout(state.ocrWorkerTimer); state.ocrWorkerTimer = null; }
      try { await worker.terminate(); } catch {}
      state.ocrWorker = null;
      state.ocrWorkerLangKey = '';
    } catch (err) { essentialFailures++; console.warn('OCR warm failed', err); }

    try {
      updateProgress(94, 'PDF 안전 렌더링 엔진 확인 중');
      await getPdfJs();
      await ensurePdfLib();
    } catch (err) { essentialFailures++; console.warn('PDF engine warm failed', err); }

    const ready = essentialFailures === 0;
    updateProgress(100, ready ? '보안 · 오프라인 준비 완료' : '준비 완료 · 일부 필수 항목 확인 필요');
    state.busy = false;
    const record = ready
      ? { ready: true, at: Date.now(), compatMode, version: APP_VERSION }
      : { ready: false, failed: essentialFailures, at: Date.now(), version: APP_VERSION };
    writeOfflinePrepRecord(record);
    updateOfflinePrepStatus(record);
    updateSecurityStatus(ready ? '강화' : '확인 필요', ready
      ? (compatMode ? 'OCR·PDF 검증 완료 · 문서 보정은 고정밀 호환 엔진 사용' : '실행 엔진 SHA-256 검증 및 앱 전용 캐시 준비 완료')
      : `${essentialFailures}개 필수 구성 요소 준비 실패 · 다시 준비해 주세요.`);
    setTimeout(hideProgress, 850);
    showToast(ready ? '보안 · 오프라인 준비가 완료되었습니다.' : `필수 구성 요소 ${essentialFailures}개를 다시 확인해 주세요.`);
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

  async function ensureOpenCv(forceRetry = false) {
    if (state.cvReady && window.cv?.Mat) return true;
    if (forceRetry && state.cvFailed && !state.cvPromise) state.cvFailed = false;
    if (state.cvPromise) return state.cvPromise;
    state.cvPromise = (async () => {
      try {
        if (!window.ScanBoxRuntime) throw new Error('보안 런타임을 불러오지 못했습니다.');
        els.opencvState.textContent = '문서 보정 가속 엔진 · 초기화 중';
        els.opencvState.className = 'engine-state';
        await window.ScanBoxRuntime.loadScript({ ...SOURCES.opencv, globalCheck: () => !!window.cv });

        // OpenCV 5.x는 Promise/thenable로 노출될 수 있습니다. instanceof Promise만으로 판별하면
        // Safari 등에서 초기화가 끝났는데도 실패로 오인할 수 있어 thenable을 명시적으로 처리합니다.
        let module = window.cv;
        if (module && typeof module.then === 'function' && !module.Mat) {
          module = await withTimeout(Promise.resolve(module), 60000, 'OpenCV Promise 초기화 시간 초과');
          if (module) window.cv = module;
        }
        if (!window.cv?.Mat) {
          const ok = await waitFor(() => !!window.cv?.Mat, 60000, 100);
          if (!ok) throw new Error('OpenCV 런타임 초기화 시간 초과');
        }
        state.cvReady = true; state.cvFailed = false;
        els.opencvState.textContent = '문서 보정 · OpenCV 가속 활성화';
        els.opencvState.className = 'engine-state ok';
        updateSecurityStatus();
        return true;
      } catch (err) {
        state.cvFailed = true;
        els.opencvState.textContent = '문서 보정 · 고정밀 호환 엔진 활성화';
        els.opencvState.className = 'engine-state ok';
        throw err;
      } finally {
        if (!state.cvReady) state.cvPromise = null;
      }
    })();
    return state.cvPromise;
  }

  function withTimeout(promise, ms, message = '처리 시간이 초과되었습니다.') {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
    ]).finally(() => clearTimeout(timer));
  }

  async function waitFor(predicate, timeoutMs = 30000, intervalMs = 100) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try { if (predicate()) return true; } catch {}
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
  }

  async function addImageFiles(files, { autoCorrect }) {
    if (state.busy) return;
    state.busy = true;
    try {
      await validateImageBatch(files, state.pages.length);
      showProgress('문서 가져오기', '이미지를 준비하고 있습니다.', 0);
      if (autoCorrect && !state.cvReady) {
        updateProgress(2, '문서 보정 엔진을 준비하고 있습니다.');
        await prepareOpenCvForCorrection();
      }
      let detectionMisses = 0;
      for (let i = 0; i < files.length; i++) {
        updateProgress((i / files.length) * 92, `${i + 1} / ${files.length} 페이지 처리`);
        const sourceBlob = await normalizeImageFile(files[i], IMPORT_MAX, 0.95);
        let pageBlob = sourceBlob;
        let corners = null;
        if (autoCorrect) {
          try {
            corners = await detectDocumentCorners(sourceBlob);
            if (corners) pageBlob = await warpDocument(sourceBlob, corners);
            else detectionMisses++;
          } catch (err) { detectionMisses++; console.warn('자동 보정 실패:', err); }
        }
        const page = makePage(pageBlob, files[i].name, sourceBlob);
        page.cropCorners = corners;
        await refreshPreview(page);
        state.pages.push(page);
      }
      renderPages();
      updateProgress(100, '페이지 추가 완료');
      if (autoCorrect && detectionMisses > 0) {
        const subject = detectionMisses === 1 ? '1장의 문서' : `${detectionMisses}장의 문서`;
        showToast(`${subject} 경계를 확신하지 못해 원본으로 유지했습니다. 영역 조정에서 직접 맞출 수 있습니다.`);
      }
      if (autoCorrect && !state.cvReady) console.info('ScanBox: OpenCV 미사용 · 고정밀 호환 검출/WebGL 보정 사용');
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
    els.ocrPreviewBtn.disabled = count === 0 || !els.ocrToggle?.checked;
    els.createOutputBtn.disabled = count === 0;

    els.pageList.innerHTML = state.pages.map((page, idx) => `
      <article class="page-card" data-page-id="${escapeHtml(page.id)}">
        <button class="page-preview-wrap page-preview-button" data-action="preview" aria-label="${idx + 1}페이지 크게 미리보기">
          <img class="page-preview" src="${escapeHtml(page.previewUrl || '')}" alt="${idx + 1}페이지" />
          <span class="preview-hint">미리보기</span>
        </button>
        <div class="page-content">
          <div class="page-head">
            <button class="drag-handle" data-sort-handle aria-label="페이지 순서 이동" title="누른 채 끌어서 순서 이동">≡</button>
            <label class="page-number-inline" aria-label="페이지 순서 번호">
              <span>[</span><input data-page-order-inline type="number" min="1" max="${count}" value="${idx + 1}" inputmode="numeric" aria-label="${idx + 1}페이지 순서" /><span>] 페이지</span>
            </label>
            <span class="page-source">${escapeHtml(page.sourceName || '')}</span>
          </div>
          ${page.ocr ? `<span class="ocr-chip">OCR ${page.ocr.words.length.toLocaleString()}단어${page.ocr.editedText != null ? ' · 수정됨' : ''}</span>` : ''}
          <div class="filter-tabs">
            ${filterButton(page, 'color', '컬러')}${filterButton(page, 'bw', '흑백')}${filterButton(page, 'document', '문서')}
          </div>
          <div class="page-actions">
            <div class="page-action-main"><button data-action="crop">영역 조정</button><button data-action="rotate">↻ 회전</button></div>
            <button data-action="delete" class="page-delete-button">삭제</button>
          </div>
        </div>
      </article>`).join('');
    updateEstimatedSize();
    if (state.scanPreviewIndex >= count) closeScanPreview();
  }

  function filterButton(page, value, label) {
    return `<button data-action="filter" data-filter="${value}" class="filter-btn ${page.filter === value ? 'active' : ''}">${label}</button>`;
  }

  function bindPageDrag() {
    els.pageList.addEventListener('change', e => {
      const input = e.target.closest('[data-page-order-inline]');
      if (!input || state.busy || state.drag) return;
      const card = input.closest('[data-page-id]');
      moveScannerPage(card?.dataset.pageId, input.value);
    });
    els.pageList.addEventListener('pointerdown', e => {
      const handle = e.target.closest('[data-sort-handle]');
      if (!handle || state.busy) return;
      const card = handle.closest('.page-card');
      if (!card) return;
      e.preventDefault();
      state.drag = { card, pointerId: e.pointerId, mode: 'card' };
      card.classList.add('dragging');
      try { handle.setPointerCapture(e.pointerId); } catch {}
    });
    window.addEventListener('pointermove', e => {
      if (!state.drag || state.drag.mode !== 'card' || e.pointerId !== state.drag.pointerId) return;
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
    if (!state.drag || state.drag.mode !== 'card' || (e.pointerId != null && e.pointerId !== state.drag.pointerId)) return;
    const { card } = state.drag;
    card.classList.remove('dragging'); card.style.transform = '';
    const ids = [...els.pageList.querySelectorAll('.page-card')].map(el => el.dataset.pageId);
    const byId = new Map(state.pages.map(p => [p.id, p]));
    state.pages = ids.map(id => byId.get(id)).filter(Boolean);
    state.drag = null; renderPages();
  }

  function moveScannerPage(pageId, oneBasedTarget) {
    const from = state.pages.findIndex(p => p.id === pageId);
    if (from < 0) return;
    const target = clamp(Math.round(Number(oneBasedTarget) || 1), 1, state.pages.length) - 1;
    if (from === target) return;
    const [page] = state.pages.splice(from, 1);
    state.pages.splice(target, 0, page);
    renderPages();
  }

  function bindScanPreview() {
    if (!els.scanPreviewSheet) return;
    $$('[data-close-scan-preview]').forEach(el => el.addEventListener('click', closeScanPreview));
    els.scanPreviewPrev?.addEventListener('click', () => stepScanPreview(-1));
    els.scanPreviewNext?.addEventListener('click', () => stepScanPreview(1));
    let startX = null;
    els.scanPreviewStage?.addEventListener('pointerdown', e => { startX = e.clientX; });
    els.scanPreviewStage?.addEventListener('pointerup', e => {
      if (startX == null) return;
      const dx = e.clientX - startX; startX = null;
      if (Math.abs(dx) > 55) stepScanPreview(dx < 0 ? 1 : -1);
    });
    els.scanPreviewStage?.addEventListener('pointercancel', () => { startX = null; });
  }

  function openScanPreview(index) {
    if (!state.pages.length || !els.scanPreviewSheet) return;
    state.scanPreviewIndex = clamp(index, 0, state.pages.length - 1);
    updateScanPreview();
    openSheet(els.scanPreviewSheet);
  }

  function updateScanPreview() {
    if (!state.pages.length || state.scanPreviewIndex < 0) return closeScanPreview();
    state.scanPreviewIndex = clamp(state.scanPreviewIndex, 0, state.pages.length - 1);
    const page = state.pages[state.scanPreviewIndex];
    if (els.scanPreviewImage) els.scanPreviewImage.src = page.previewUrl || '';
    if (els.scanPreviewCounter) els.scanPreviewCounter.textContent = `${state.scanPreviewIndex + 1} / ${state.pages.length} 페이지`;
    if (els.scanPreviewPrev) els.scanPreviewPrev.disabled = state.scanPreviewIndex <= 0;
    if (els.scanPreviewNext) els.scanPreviewNext.disabled = state.scanPreviewIndex >= state.pages.length - 1;
  }

  function stepScanPreview(delta) {
    if (!state.pages.length) return;
    const next = clamp(state.scanPreviewIndex + delta, 0, state.pages.length - 1);
    if (next === state.scanPreviewIndex) return;
    state.scanPreviewIndex = next;
    updateScanPreview();
  }

  function closeScanPreview() {
    state.scanPreviewIndex = -1;
    if (els.scanPreviewImage) els.scanPreviewImage.removeAttribute('src');
    if (els.scanPreviewSheet) closeSheet(els.scanPreviewSheet);
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
    // 직접 영역 재감지로 들어온 경우에도 OpenCV가 준비 중이라면 완료까지 기다립니다.
    if (!state.cvReady) await prepareOpenCvForCorrection();
    let found = null;
    if (state.cvReady && window.cv?.Mat) {
      try { found = await detectDocumentCornersOpenCv(blob); }
      catch (err) { console.warn('OpenCV 자동 감지 실패 · 내장 감지로 전환', err); }
    }
    if (!found) found = await detectDocumentCornersJs(blob);
    if (!found) return null;
    try { found = await refineDocumentCorners(blob, found); }
    catch (err) { console.warn('모서리 정밀 보정 생략:', err); }
    return insetQuad(found, 0.004);
  }

  // v1.1.5: OpenCV가 없는 iPhone에서도 문서 내부 표선이 아니라 "종이 안/밖의 색 변화"를
  // 직접 추적합니다. 각 스캔 라인에서 경계 후보를 찾고, 수백 개 후보를 robust line fit으로
  // 묶어 네 변을 만든 뒤 교차점으로 4점을 계산합니다. 단일 극점 픽셀을 쓰지 않아 배경의
  // 반사광/나뭇결 같은 이상치가 모서리를 문서 밖으로 끌고 가는 현상을 줄입니다.
  async function detectDocumentCornersJs(blob) {
    let primary = null;
    try { primary = await detectDocumentCornersEdgeBandJs(blob); }
    catch (err) { console.warn('고정밀 경계 검출 실패 · 기존 호환 검출로 전환:', err); }
    if (primary) return primary;
    return detectDocumentCornersJsLegacy(blob);
  }

  async function detectDocumentCornersEdgeBandJs(blob) {
    const img = await loadImage(blob);
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    const scale = Math.min(1, 720 / Math.max(w0, h0));
    const w = Math.max(100, Math.round(w0 * scale)), h = Math.max(100, Math.round(h0 * scale));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha:false, willReadFrequently:true });
    ctx.drawImage(img, 0, 0, w, h); cleanupLoadedImage(img);
    const rgba = ctx.getImageData(0,0,w,h).data;
    releaseCanvas(canvas);
    return detectEdgeBandQuadFromRgba(rgba,w,h);
  }

  function detectEdgeBandQuadFromRgba(rgba,w,h) {
    if (!rgba || w < 100 || h < 100) return null;
    const stride=w+1, n=(w+1)*(h+1), ir=new Float64Array(n), ig=new Float64Array(n), ib=new Float64Array(n);
    for(let y=0;y<h;y++){
      let rr=0,gg=0,bb=0;
      for(let x=0;x<w;x++){
        const p=(y*w+x)*4, k=(y+1)*stride+x+1;
        rr+=rgba[p]; gg+=rgba[p+1]; bb+=rgba[p+2];
        ir[k]=ir[k-stride]+rr; ig[k]=ig[k-stride]+gg; ib[k]=ib[k-stride]+bb;
      }
    }
    const meanRect=(x0,y0,x1,y1)=>{
      x0=clamp(Math.round(x0),0,w);x1=clamp(Math.round(x1),0,w);y0=clamp(Math.round(y0),0,h);y1=clamp(Math.round(y1),0,h);
      if(x1<=x0||y1<=y0)return null;const a=y0*stride+x0,b=y0*stride+x1,c=y1*stride+x0,d=y1*stride+x1,den=(x1-x0)*(y1-y0);
      return[(ir[d]-ir[b]-ir[c]+ir[a])/den,(ig[d]-ig[b]-ig[c]+ig[a])/den,(ib[d]-ib[b]-ib[c]+ib[a])/den];
    };
    const sat=c=>{const mx=Math.max(c[0],c[1],c[2]),mn=Math.min(c[0],c[1],c[2]);return mx>1?(mx-mn)*255/mx:0;};
    const fd=(a,b)=>{if(!a||!b)return 1e9;const dr=a[0]-b[0],dg=a[1]-b[1],db=a[2]-b[2],ds=(sat(a)-sat(b))*.9;return Math.hypot(dr,dg,db,ds);};
    const medianRgb=samples=>{
      if(!samples.length)return[127,127,127];const rs=samples.map(v=>v[0]).sort((a,b)=>a-b),gs=samples.map(v=>v[1]).sort((a,b)=>a-b),bs=samples.map(v=>v[2]).sort((a,b)=>a-b),mid=(samples.length-1)/2;
      const med=a=>{const lo=Math.floor(mid),hi=Math.ceil(mid);return(a[lo]+a[hi])/2;};return[med(rs),med(gs),med(bs)];
    };
    const step=Math.max(2,Math.round(Math.min(w,h)/180)), edgeBand=Math.max(3,Math.round(Math.min(w,h)*.03)), border=[], center=[];
    const add=(arr,x,y)=>{const i=(y*w+x)*4;arr.push([rgba[i],rgba[i+1],rgba[i+2]]);};
    for(let x=0;x<w;x+=step){for(let y=0;y<edgeBand;y+=step)add(border,x,y);for(let y=Math.max(0,h-edgeBand);y<h;y+=step)add(border,x,y);}
    for(let y=edgeBand;y<h-edgeBand;y+=step){for(let x=0;x<edgeBand;x+=step)add(border,x,y);for(let x=Math.max(0,w-edgeBand);x<w;x+=step)add(border,x,y);}
    for(let y=Math.round(h*.42);y<Math.round(h*.58);y+=step)for(let x=Math.round(w*.42);x<Math.round(w*.58);x+=step)add(center,x,y);
    if(border.length<20||center.length<10)return null;
    const bg=medianRgb(border), doc=medianRgb(center), cx=w/2, cy=h/2, r=clamp(Math.round(Math.min(w,h)*.011),4,8), yPad=Math.max(2,Math.round(h*.003)), xPad=Math.max(2,Math.round(w*.003));
    // 중앙과 바깥 테두리의 색 모델이 사실상 같으면 이 검출법의 신뢰도가 낮습니다.
    if(fd(bg,doc)<32)return null;
    const pairScore=(inside,outside)=>{
      const diff=fd(inside,outside),inMargin=fd(inside,bg)-fd(inside,doc),outMargin=fd(outside,doc)-fd(outside,bg);
      return diff + .55*inMargin + .55*outMargin + (inMargin < -28 ? inMargin*.8 : 0) + (outMargin < -42 ? outMargin*.55 : 0);
    };
    const L=[],R=[],T=[],B=[];
    for(let y=Math.round(h*.08);y<Math.round(h*.95);y+=3){
      const c=meanRect(cx-20,y-yPad,cx+20,y+yPad+1); if(!c||fd(c,doc)>fd(c,bg)+18)continue;
      let bestS=-1e9,bestX=null;
      for(let x=Math.round(w*.025)+3*r;x<cx-w*.12;x+=2){const ins=meanRect(x+r,y-yPad,x+3*r,y+yPad+1),out=meanRect(x-3*r,y-yPad,x-r,y+yPad+1),sc=pairScore(ins,out);if(sc>bestS){bestS=sc;bestX=x;}}
      if(bestX!=null&&bestS>24)L.push({u:y,v:bestX,s:bestS});
      bestS=-1e9;bestX=null;
      for(let x=Math.round(cx+w*.12);x<Math.round(w*.975)-3*r;x+=2){const ins=meanRect(x-3*r,y-yPad,x-r,y+yPad+1),out=meanRect(x+r,y-yPad,x+3*r,y+yPad+1),sc=pairScore(ins,out);if(sc>bestS){bestS=sc;bestX=x;}}
      if(bestX!=null&&bestS>24)R.push({u:y,v:bestX,s:bestS});
    }
    for(let x=Math.round(w*.08);x<Math.round(w*.94);x+=3){
      const c=meanRect(x-xPad,cy-20,x+xPad+1,cy+20); if(!c||fd(c,doc)>fd(c,bg)+18)continue;
      let bestS=-1e9,bestY=null;
      for(let y=Math.round(h*.025)+3*r;y<cy-h*.12;y+=2){const ins=meanRect(x-xPad,y+r,x+xPad+1,y+3*r),out=meanRect(x-xPad,y-3*r,x+xPad+1,y-r),sc=pairScore(ins,out);if(sc>bestS){bestS=sc;bestY=y;}}
      if(bestY!=null&&bestS>24)T.push({u:x,v:bestY,s:bestS});
      bestS=-1e9;bestY=null;
      for(let y=Math.round(cy+h*.12);y<Math.round(h*.975)-3*r;y+=2){const ins=meanRect(x-xPad,y-3*r,x+xPad+1,y-r),out=meanRect(x-xPad,y+r,x+xPad+1,y+3*r),sc=pairScore(ins,out);if(sc>bestS){bestS=sc;bestY=y;}}
      if(bestY!=null&&bestS>24)B.push({u:x,v:bestY,s:bestS});
    }
    const robustFit=(points,minU=-Infinity,maxU=Infinity)=>{
      let p=points.filter(q=>q.u>=minU&&q.u<=maxU);if(p.length<12)return null;
      let keep=p.map(()=>true),a=0,b=0,res=[];
      for(let iter=0;iter<6;iter++){
        let sw=0,sx=0,sy=0,sxx=0,sxy=0;
        for(let i=0;i<p.length;i++)if(keep[i]){const wt=Math.sqrt(clamp(p[i].s,1,300));sw+=wt;sx+=wt*p[i].u;sy+=wt*p[i].v;sxx+=wt*p[i].u*p[i].u;sxy+=wt*p[i].u*p[i].v;}
        const den=sw*sxx-sx*sx;if(sw<=0||Math.abs(den)<1e-8)return null;a=(sw*sxy-sx*sy)/den;b=(sy-a*sx)/sw;
        res=p.map(q=>q.v-(a*q.u+b));const active=res.filter((_,i)=>keep[i]);const med=medianNumber(active),mad=medianNumber(active.map(v=>Math.abs(v-med)))+.5,thr=Math.max(2.5,2.8*1.4826*mad);const next=res.map(v=>Math.abs(v-med)<thr);
        if(next.filter(Boolean).length<12)break;let same=true;for(let i=0;i<next.length;i++)if(next[i]!==keep[i]){same=false;break;}keep=next;if(same)break;
      }
      const activeAbs=res.filter((_,i)=>keep[i]).map(Math.abs);return{a,b,count:keep.filter(Boolean).length,residual:medianNumber(activeAbs)};
    };
    const lf=robustFit(L),rf=robustFit(R),tf=robustFit(T,w*.18,w*.90),bf=robustFit(B,w*.15,w*.90);
    if(!lf||!rf||!tf||!bf)return null;
    const minSideSamples=Math.max(24,Math.round(h*.08)),minHorizontalSamples=Math.max(18,Math.round(w*.05));
    if(lf.count<minSideSamples||rf.count<minSideSamples||tf.count<minHorizontalSamples||bf.count<minHorizontalSamples)return null;
    const residualLimit=Math.min(w,h)*.038;if(Math.max(lf.residual,rf.residual,tf.residual,bf.residual)>residualLimit)return null;
    const intersect=(xLine,yLine)=>{const den=1-yLine.a*xLine.a;if(Math.abs(den)<1e-7)return null;const y=(yLine.a*xLine.b+yLine.b)/den;return{x:xLine.a*y+xLine.b,y};};
    const px=[intersect(lf,tf),intersect(rf,tf),intersect(rf,bf),intersect(lf,bf)];if(px.some(q=>!q||q.x<-w*.04||q.x>w*1.04||q.y<-h*.04||q.y>h*1.04))return null;
    const norm=orderQuad(px).map(q=>({x:clamp(q.x/w,0,1),y:clamp(q.y/h,0,1)}));
    if(!isReasonableQuad(norm)||!isConvexQuad(norm))return null;
    const contrast=scoreQuadBoundaryContrast(norm,rgba,w,h);if(contrast<.045)return null;
    return norm;
  }

  async function detectDocumentCornersJsLegacy(blob) {
    const img = await loadImage(blob);
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    const scale = Math.min(1, 720 / Math.max(w0, h0));
    const w = Math.max(80, Math.round(w0 * scale)), h = Math.max(80, Math.round(h0 * scale));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha:false, willReadFrequently:true });
    ctx.drawImage(img, 0, 0, w, h); cleanupLoadedImage(img);
    const data = ctx.getImageData(0,0,w,h).data;
    const colorCandidate = detectBackgroundRegionQuadJs(data, w, h);
    const gray = new Uint8Array(w*h);
    for (let i=0,p=0;i<data.length;i+=4,p++) gray[p] = (77*data[i] + 150*data[i+1] + 29*data[i+2]) >> 8;

    const mag = new Uint8Array(w*h); let sum=0,sum2=0,count=0;
    for (let y=1;y<h-1;y++) for (let x=1;x<w-1;x++) {
      const i=y*w+x;
      const gx = -gray[i-w-1]-2*gray[i-1]-gray[i+w-1] + gray[i-w+1]+2*gray[i+1]+gray[i+w+1];
      const gy = -gray[i-w-1]-2*gray[i-w]-gray[i-w+1] + gray[i+w-1]+2*gray[i+w]+gray[i+w+1];
      const m = Math.min(255, (Math.abs(gx)+Math.abs(gy))>>2); mag[i]=m; sum+=m; sum2+=m*m; count++;
    }
    const mean=sum/Math.max(1,count), variance=Math.max(0,sum2/Math.max(1,count)-mean*mean);
    const threshold=clamp(mean + Math.sqrt(variance)*1.15, 42, 145);
    let mask = new Uint8Array(w*h); const bx=Math.max(3,Math.round(w*.018)), by=Math.max(3,Math.round(h*.018));
    for(let y=by;y<h-by;y++) for(let x=bx;x<w-bx;x++){const i=y*w+x;if(mag[i]>=threshold)mask[i]=1;}
    // 끊긴 문서 외곽선을 연결하기 위한 가벼운 팽창
    for(let pass=0;pass<2;pass++){
      const next=mask.slice();
      for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){const i=y*w+x;if(mask[i])continue;let hit=0;for(let yy=-1;yy<=1&&!hit;yy++)for(let xx=-1;xx<=1;xx++)if(mask[i+yy*w+xx]){hit=1;break;}if(hit)next[i]=1;}
      mask=next;
    }
    const visited=new Uint8Array(w*h), queue=new Int32Array(w*h); let best=null,bestScore=0;
    const dirs=[-1,1,-w,w,-w-1,-w+1,w-1,w+1];
    for(let sy=by;sy<h-by;sy+=2) for(let sx=bx;sx<w-bx;sx+=2){
      const start=sy*w+sx;if(!mask[start]||visited[start])continue;
      let qh=0,qt=0;queue[qt++]=start;visited[start]=1;let n=0,minX=w,maxX=0,minY=h,maxY=0;
      let tl=null,tr=null,br=null,bl=null,minSum=1e9,maxSum=-1e9,minDiff=1e9,maxDiff=-1e9;
      while(qh<qt){const idx=queue[qh++],y=(idx/w)|0,x=idx-y*w;n++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);const su=x+y,di=x-y;if(su<minSum){minSum=su;tl={x,y}}if(su>maxSum){maxSum=su;br={x,y}}if(di>maxDiff){maxDiff=di;tr={x,y}}if(di<minDiff){minDiff=di;bl={x,y}}for(const d of dirs){const ni=idx+d;if(ni<0||ni>=mask.length||visited[ni]||!mask[ni])continue;const ny=(ni/w)|0,nx=ni-ny*w;if(Math.abs(nx-x)>1||Math.abs(ny-y)>1)continue;visited[ni]=1;queue[qt++]=ni;}}
      const bw=maxX-minX+1,bh=maxY-minY+1,bboxArea=bw*bh;if(n<80||bboxArea<w*h*.10)continue;
      const pts=orderQuad([tl,tr,br,bl]);const area=Math.abs(polygonArea(pts));if(area<w*h*.12)continue;
      const score=area*(1+Math.min(2,n/Math.max(1,2*(bw+bh))));if(score>bestScore){bestScore=score;best=pts;}
    }
    releaseCanvas(canvas);
    let normalized=best?best.map(p=>({x:clamp(p.x/w,0,1),y:clamp(p.y/h,0,1)})):null;
    if(normalized&&!isReasonableQuad(normalized)) normalized=null;
    if(colorCandidate&&isReasonableQuad(colorCandidate)){
      const colorScore=scoreDocumentQuad(colorCandidate,data,w,h),edgeScore=normalized?scoreDocumentQuad(normalized,data,w,h):-Infinity;
      if(colorScore>edgeScore) normalized=colorCandidate;
    }
    return normalized;
  }

  function detectBackgroundRegionQuadJs(rgba,w,h){
    try{
      const step=Math.max(2,Math.round(Math.min(w,h)/180)),band=Math.max(3,Math.round(Math.min(w,h)*.025)),rs=[],gs=[],bs=[];
      const add=(x,y)=>{const i=(y*w+x)*4;rs.push(rgba[i]);gs.push(rgba[i+1]);bs.push(rgba[i+2]);};
      for(let x=0;x<w;x+=step){for(let y=0;y<band;y+=step)add(x,y);for(let y=Math.max(0,h-band);y<h;y+=step)add(x,y);}
      for(let y=band;y<h-band;y+=step){for(let x=0;x<band;x+=step)add(x,y);for(let x=Math.max(0,w-band);x<w;x+=step)add(x,y);}
      if(rs.length<20)return null;const br=medianNumber(rs),bg=medianNumber(gs),bb=medianNumber(bs),bd=[];
      for(let i=0;i<rs.length;i++)bd.push(Math.abs(rs[i]-br)+Math.abs(gs[i]-bg)+Math.abs(bs[i]-bb));
      const med=medianNumber(bd),mad=medianNumber(bd.map(v=>Math.abs(v-med))),thr=clamp(med+Math.max(24,mad*3.4),30,155),mask=new Uint8Array(w*h);
      for(let p=0,i=0;p<mask.length;p++,i+=4){const d=Math.abs(rgba[i]-br)+Math.abs(rgba[i+1]-bg)+Math.abs(rgba[i+2]-bb);if(d>=thr)mask[p]=1;}
      const visited=new Uint8Array(mask.length),queue=new Int32Array(mask.length),dirs=[-1,1,-w,w,-w-1,-w+1,w-1,w+1];let best=null,bestArea=0;
      for(let sy=1;sy<h-1;sy+=2)for(let sx=1;sx<w-1;sx+=2){const st=sy*w+sx;if(!mask[st]||visited[st])continue;let qh=0,qt=0,n=0;queue[qt++]=st;visited[st]=1;let tl=null,tr=null,brp=null,bl=null,minSum=1e9,maxSum=-1e9,minDiff=1e9,maxDiff=-1e9;
        while(qh<qt){const idx=queue[qh++],y=(idx/w)|0,x=idx-y*w;n++;const su=x+y,di=x-y;if(su<minSum){minSum=su;tl={x,y}}if(su>maxSum){maxSum=su;brp={x,y}}if(di>maxDiff){maxDiff=di;tr={x,y}}if(di<minDiff){minDiff=di;bl={x,y}}for(const d of dirs){const ni=idx+d;if(ni<0||ni>=mask.length||visited[ni]||!mask[ni])continue;const ny=(ni/w)|0,nx=ni-ny*w;if(Math.abs(nx-x)>1||Math.abs(ny-y)>1)continue;visited[ni]=1;queue[qt++]=ni;}}
        if(n>bestArea&&n>w*h*.12){bestArea=n;best=[tl,tr,brp,bl];}
      }
      if(!best)return null;return orderQuad(best).map(q=>({x:clamp(q.x/w,0,1),y:clamp(q.y/h,0,1)}));
    }catch(err){console.warn('내장 배경 대비 감지 실패:',err);return null;}
  }

  function polygonArea(points){let a=0;for(let i=0;i<points.length;i++){const p=points[i],q=points[(i+1)%points.length];a+=p.x*q.y-q.x*p.y;}return a/2;}
  function isReasonableQuad(points){if(!points||points.length!==4)return false;const a=Math.abs(polygonArea(points));if(a<.12)return false;const [tl,tr,br,bl]=orderQuad(points);return [distance(tl,tr),distance(tr,br),distance(br,bl),distance(bl,tl)].every(v=>v>.12);}

  async function warpDocument(blob, normalizedCorners) {
    if (state.cvReady && window.cv?.Mat) {
      try { return await warpDocumentOpenCv(blob, normalizedCorners); }
      catch (err) { console.warn('OpenCV 원근 보정 실패 · seamless WebGL 보정으로 전환', err); }
    }
    try { return await warpDocumentWebGl(blob, normalizedCorners); }
    catch (err) {
      console.warn('WebGL 원근 보정 실패 · CPU 호환 보정으로 전환', err);
      return warpDocumentCpu(blob, normalizedCorners);
    }
  }

  function squareToQuadCoefficients(tl,tr,br,bl) {
    const x0=tl.x,y0=tl.y,x1=tr.x,y1=tr.y,x2=br.x,y2=br.y,x3=bl.x,y3=bl.y;
    const dx1=x1-x2,dx2=x3-x2,dx3=x0-x1+x2-x3,dy1=y1-y2,dy2=y3-y2,dy3=y0-y1+y2-y3;
    let g=0,h=0;
    if(Math.abs(dx3)>1e-9||Math.abs(dy3)>1e-9){
      const det=dx1*dy2-dx2*dy1;
      if(Math.abs(det)>1e-12){g=(dx3*dy2-dx2*dy3)/det;h=(dx1*dy3-dx3*dy1)/det;}
    }
    return {a:x1-x0+g*x1,b:x3-x0+h*x3,c:x0,d:y1-y0+g*y1,e:y3-y0+h*y3,f:y0,g,h};
  }

  async function warpDocumentWebGl(blob, normalizedCorners) {
    const img=await loadImage(blob);
    const sourceW=img.naturalWidth||img.width, sourceH=img.naturalHeight||img.height;
    const pts=orderQuad(normalizedCorners); const [tl,tr,br,bl]=pts;
    let outW=Math.round(Math.max(distance({x:br.x*sourceW,y:br.y*sourceH},{x:bl.x*sourceW,y:bl.y*sourceH}),distance({x:tr.x*sourceW,y:tr.y*sourceH},{x:tl.x*sourceW,y:tl.y*sourceH})));
    let outH=Math.round(Math.max(distance({x:tr.x*sourceW,y:tr.y*sourceH},{x:br.x*sourceW,y:br.y*sourceH}),distance({x:tl.x*sourceW,y:tl.y*sourceH},{x:bl.x*sourceW,y:bl.y*sourceH})));
    if(outW<120||outH<120){cleanupLoadedImage(img);throw new Error('선택한 문서 영역이 너무 작습니다.');}

    const out=document.createElement('canvas'); out.width=1; out.height=1;
    const gl=out.getContext('webgl',{alpha:false,antialias:false,preserveDrawingBuffer:true,premultipliedAlpha:false}) || out.getContext('experimental-webgl',{alpha:false,antialias:false,preserveDrawingBuffer:true,premultipliedAlpha:false});
    if(!gl){cleanupLoadedImage(img);releaseCanvas(out);throw new Error('이 환경에서는 WebGL 원근 보정을 사용할 수 없습니다.');}
    const maxTexture=Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)||4096);
    const vp=gl.getParameter(gl.MAX_VIEWPORT_DIMS); const maxViewport=Math.min(Number(vp?.[0]||maxTexture),Number(vp?.[1]||maxTexture));
    const maxOut=Math.max(1024,Math.min(IMPORT_MAX,maxTexture,maxViewport));
    const fitted=fitDimensions(outW,outH,maxOut); outW=fitted.width;outH=fitted.height; out.width=outW;out.height=outH;

    let texSource=img, texCanvas=null;
    if(sourceW>maxTexture||sourceH>maxTexture){
      const sf=fitDimensions(sourceW,sourceH,maxTexture);
      texCanvas=document.createElement('canvas');texCanvas.width=sf.width;texCanvas.height=sf.height;
      const tctx=texCanvas.getContext('2d',{alpha:false});tctx.fillStyle='#fff';tctx.fillRect(0,0,texCanvas.width,texCanvas.height);tctx.drawImage(img,0,0,texCanvas.width,texCanvas.height);texSource=texCanvas;
    }

    const compile=(type,source)=>{const sh=gl.createShader(type);gl.shaderSource(sh,source);gl.compileShader(sh);if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)){const msg=gl.getShaderInfoLog(sh)||'shader compile error';gl.deleteShader(sh);throw new Error(msg);}return sh;};
    let program=null,vs=null,fs=null,buffer=null,texture=null;
    try{
      vs=compile(gl.VERTEX_SHADER,`attribute vec2 a_pos;attribute vec2 a_dest;varying vec2 v_dest;void main(){gl_Position=vec4(a_pos,0.0,1.0);v_dest=a_dest;}`);
      fs=compile(gl.FRAGMENT_SHADER,`precision highp float;varying vec2 v_dest;uniform sampler2D u_image;uniform mat3 u_h;void main(){vec3 q=u_h*vec3(v_dest,1.0);if(abs(q.z)<0.000001){gl_FragColor=vec4(1.0);return;}vec2 s=q.xy/q.z;if(s.x<0.0||s.x>1.0||s.y<0.0||s.y>1.0){gl_FragColor=vec4(1.0);return;}gl_FragColor=texture2D(u_image,vec2(s.x,1.0-s.y));}`);
      program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)||'WebGL program link error');
      gl.useProgram(program);gl.viewport(0,0,outW,outH);gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT);

      const vertices=new Float32Array([
        -1,-1, 0,1,   1,-1, 1,1,  -1,1, 0,0,
        -1,1, 0,0,    1,-1, 1,1,   1,1, 1,0
      ]);
      buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);
      const stride=4*4, posLoc=gl.getAttribLocation(program,'a_pos'), destLoc=gl.getAttribLocation(program,'a_dest');
      gl.enableVertexAttribArray(posLoc);gl.vertexAttribPointer(posLoc,2,gl.FLOAT,false,stride,0);
      gl.enableVertexAttribArray(destLoc);gl.vertexAttribPointer(destLoc,2,gl.FLOAT,false,stride,8);

      texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,texSource);
      gl.uniform1i(gl.getUniformLocation(program,'u_image'),0);

      const H=squareToQuadCoefficients(tl,tr,br,bl);
      // GLSL mat3는 column-major입니다: [a d g | b e h | c f 1]
      gl.uniformMatrix3fv(gl.getUniformLocation(program,'u_h'),false,new Float32Array([H.a,H.d,H.g,H.b,H.e,H.h,H.c,H.f,1]));
      gl.drawArrays(gl.TRIANGLES,0,6);gl.finish();
      const result=await canvasToBlob(out,'image/jpeg',.96);
      return result;
    } finally {
      try{if(texture)gl.deleteTexture(texture);}catch{}try{if(buffer)gl.deleteBuffer(buffer);}catch{}try{if(program)gl.deleteProgram(program);}catch{}try{if(vs)gl.deleteShader(vs);}catch{}try{if(fs)gl.deleteShader(fs);}catch{}
      if(texCanvas)releaseCanvas(texCanvas);cleanupLoadedImage(img);releaseCanvas(out);
    }
  }

  async function warpDocumentCpu(blob, normalizedCorners) {
    const img=await loadImage(blob);const w0=img.naturalWidth||img.width,h0=img.naturalHeight||img.height;
    const srcFit=fitDimensions(w0,h0,3000),src=document.createElement('canvas');src.width=srcFit.width;src.height=srcFit.height;
    const sctx=src.getContext('2d',{alpha:false,willReadFrequently:true});sctx.fillStyle='#fff';sctx.fillRect(0,0,src.width,src.height);sctx.drawImage(img,0,0,src.width,src.height);cleanupLoadedImage(img);
    const pts=orderQuad(normalizedCorners),[tl,tr,br,bl]=pts;
    let outW=Math.round(Math.max(distance({x:br.x*w0,y:br.y*h0},{x:bl.x*w0,y:bl.y*h0}),distance({x:tr.x*w0,y:tr.y*h0},{x:tl.x*w0,y:tl.y*h0}))),outH=Math.round(Math.max(distance({x:tr.x*w0,y:tr.y*h0},{x:br.x*w0,y:br.y*h0}),distance({x:tl.x*w0,y:tl.y*h0},{x:bl.x*w0,y:bl.y*h0})));
    const fit=fitDimensions(outW,outH,2600);outW=fit.width;outH=fit.height;if(outW<120||outH<120){releaseCanvas(src);throw new Error('선택한 문서 영역이 너무 작습니다.');}
    const out=document.createElement('canvas');out.width=outW;out.height=outH;const octx=out.getContext('2d',{alpha:false});
    const source=sctx.getImageData(0,0,src.width,src.height),dst=octx.createImageData(outW,outH),H=squareToQuadCoefficients(tl,tr,br,bl),sd=source.data,dd=dst.data;
    for(let y=0;y<outH;y++){
      const v=(y+.5)/outH;
      for(let x=0;x<outW;x++){
        const u=(x+.5)/outW,z=H.g*u+H.h*v+1,sx=((H.a*u+H.b*v+H.c)/z)*src.width,sy=((H.d*u+H.e*v+H.f)/z)*src.height;
        const ix=clamp(Math.round(sx),0,src.width-1),iy=clamp(Math.round(sy),0,src.height-1),si=(iy*src.width+ix)*4,di=(y*outW+x)*4;
        dd[di]=sd[si];dd[di+1]=sd[si+1];dd[di+2]=sd[si+2];dd[di+3]=255;
      }
    }
    octx.putImageData(dst,0,0);releaseCanvas(src);const result=await canvasToBlob(out,'image/jpeg',.95);releaseCanvas(out);return result;
  }

  async function detectDocumentCornersOpenCv(blob) {
    if (!state.cvReady || !window.cv?.Mat) return null;
    const img = await loadImage(blob);
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    const scale = Math.min(1, DETECT_MAX / Math.max(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(120, Math.round(w0 * scale));
    canvas.height = Math.max(120, Math.round(h0 * scale));
    const ctx = canvas.getContext('2d', { alpha:false, willReadFrequently:true });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    cleanupLoadedImage(img);
    const rgba = ctx.getImageData(0,0,canvas.width,canvas.height).data;

    const cv = window.cv;
    let src, gray, blur;
    const variants = [];
    let primaryEdges = null;
    try {
      src = cv.imread(canvas);
      gray = new cv.Mat();
      blur = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
      cv.GaussianBlur(gray, blur, new cv.Size(5,5), 0, 0, cv.BORDER_DEFAULT);

      const makeCanny = (low, high, dilatePasses = 1) => {
        const edge = new cv.Mat();
        cv.Canny(blur, edge, low, high, 3, false);
        const kernel = cv.Mat.ones(3,3,cv.CV_8U);
        cv.morphologyEx(edge, edge, cv.MORPH_CLOSE, kernel, new cv.Point(-1,-1), 1);
        if (dilatePasses) cv.dilate(edge, edge, kernel, new cv.Point(-1,-1), dilatePasses);
        kernel.delete();
        return edge;
      };

      primaryEdges = makeCanny(28, 105, 1);
      variants.push(primaryEdges);
      variants.push(makeCanny(52, 165, 1));

      const adaptive = new cv.Mat();
      cv.adaptiveThreshold(blur, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 41, 9);
      variants.push(adaptive);
      const adaptiveInv = new cv.Mat();
      cv.bitwise_not(adaptive, adaptiveInv);
      variants.push(adaptiveInv);

      const otsu = new cv.Mat();
      cv.threshold(blur, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      variants.push(otsu);
      const otsuInv = new cv.Mat();
      cv.bitwise_not(otsu, otsuInv);
      variants.push(otsuInv);

      // 배경과 종이 색이 충분히 다른 촬영에서는 '검은 선'보다 종이 덩어리 자체를 찾는 편이 안정적입니다.
      // 화면 테두리 색의 중앙값을 배경으로 보고 색 차이가 큰 영역을 별도 후보 마스크로 추가합니다.
      const colorMask = buildBackgroundContrastMask(rgba, canvas.width, canvas.height, cv);
      if (colorMask) variants.unshift(colorMask);

      let best = null, bestScore = -Infinity;
      const imageArea = canvas.width * canvas.height;
      const epsilons = [0.010, 0.015, 0.021, 0.029, 0.040, 0.052];

      for (const binary of variants) {
        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        const work = binary.clone();
        try {
          cv.findContours(work, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
          for (let i = 0; i < contours.size(); i++) {
            const cnt = contours.get(i);
            try {
              const area = Math.abs(cv.contourArea(cnt));
              if (area < imageArea * 0.065 || area > imageArea * 0.997) continue;
              const peri = cv.arcLength(cnt, true);
              for (const eps of epsilons) {
                const approx = new cv.Mat();
                try {
                  cv.approxPolyDP(cnt, approx, eps * peri, true);
                  if (approx.rows !== 4) continue;
                  if (cv.isContourConvex && !cv.isContourConvex(approx)) continue;
                  const pts = [];
                  for (let r = 0; r < 4; r++) pts.push({ x: approx.intPtr(r,0)[0], y: approx.intPtr(r,0)[1] });
                  const normalized = orderQuad(pts).map(p => ({ x:p.x/canvas.width, y:p.y/canvas.height }));
                  const score = scoreDocumentQuad(normalized, rgba, canvas.width, canvas.height);
                  if (score > bestScore) { bestScore = score; best = normalized; }
                } finally { approx.delete(); }
              }
            } finally { cnt.delete(); }
          }
        } finally { work.delete(); contours.delete(); hierarchy.delete(); }
      }

      if ((!best || bestScore < 1.85) && primaryEdges) {
        const hough = detectQuadFromHough(primaryEdges, canvas.width, canvas.height, cv);
        if (hough) {
          const score = scoreDocumentQuad(hough, rgba, canvas.width, canvas.height);
          if (score > bestScore) { bestScore = score; best = hough; }
        }
      }
      return best && isReasonableQuad(best) ? orderQuad(best) : null;
    } finally {
      for (const m of variants) { try { m?.delete?.(); } catch {} }
      [src, gray, blur].forEach(m => { try { m?.delete?.(); } catch {} });
      releaseCanvas(canvas);
    }
  }

  function medianNumber(values) {
    if (!values?.length) return 0;
    const a=[...values].sort((x,y)=>x-y),m=(a.length-1)/2,lo=Math.floor(m),hi=Math.ceil(m);
    return (a[lo]+a[hi])/2;
  }

  function buildBackgroundContrastMask(rgba, w, h, cv) {
    try {
      const step=Math.max(2,Math.round(Math.min(w,h)/240)), band=Math.max(3,Math.round(Math.min(w,h)*.022));
      const rs=[],gs=[],bs=[];
      const add=(x,y)=>{const i=(y*w+x)*4;rs.push(rgba[i]);gs.push(rgba[i+1]);bs.push(rgba[i+2]);};
      for(let x=0;x<w;x+=step){for(let y=0;y<band;y+=step)add(x,y);for(let y=Math.max(0,h-band);y<h;y+=step)add(x,y);}
      for(let y=band;y<h-band;y+=step){for(let x=0;x<band;x+=step)add(x,y);for(let x=Math.max(0,w-band);x<w;x+=step)add(x,y);}
      if(rs.length<24)return null;
      const br=medianNumber(rs),bg=medianNumber(gs),bb=medianNumber(bs),borderDist=[];
      for(let i=0;i<rs.length;i++)borderDist.push(Math.abs(rs[i]-br)+Math.abs(gs[i]-bg)+Math.abs(bs[i]-bb));
      const med=medianNumber(borderDist),mad=medianNumber(borderDist.map(v=>Math.abs(v-med)));
      const threshold=clamp(med+Math.max(24,mad*3.4),30,155);
      const mask=new cv.Mat(h,w,cv.CV_8UC1),out=mask.data;
      for(let p=0,i=0;p<w*h;p++,i+=4){const d=Math.abs(rgba[i]-br)+Math.abs(rgba[i+1]-bg)+Math.abs(rgba[i+2]-bb);out[p]=d>=threshold?255:0;}
      const k=Math.max(3,Math.min(11,(Math.round(Math.min(w,h)*.006)|1))),kernel=cv.Mat.ones(k,k,cv.CV_8U);
      cv.morphologyEx(mask,mask,cv.MORPH_CLOSE,kernel,new cv.Point(-1,-1),2);
      cv.morphologyEx(mask,mask,cv.MORPH_OPEN,kernel,new cv.Point(-1,-1),1);
      kernel.delete();
      return mask;
    } catch(err){console.warn('배경 색 대비 마스크 생성 실패:',err);return null;}
  }

  function scoreQuadBoundaryContrast(points, rgba, w, h) {
    if(!rgba||!w||!h||!points||points.length!==4)return 0;
    const p=orderQuad(points).map(q=>({x:q.x*w,y:q.y*h})),edgeScores=[],gap=clamp(Math.min(w,h)*.006,3,10);
    const rgb=(x,y)=>{const ix=Math.round(x),iy=Math.round(y);if(ix<0||iy<0||ix>=w||iy>=h)return null;const i=(iy*w+ix)*4;return[rgba[i],rgba[i+1],rgba[i+2]];};
    for(let e=0;e<4;e++){
      const a=p[e],b=p[(e+1)%4],dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1,nx=-dy/len,ny=dx/len;
      let total=0,n=0;
      const samples=Math.max(24,Math.min(64,Math.round(len/18)));
      for(let k=0;k<samples;k++){
        const t=.08+.84*(k/(samples-1)),x=a.x+dx*t,y=a.y+dy*t;
        const inside1=rgb(x+nx*gap,y+ny*gap),inside2=rgb(x+nx*gap*1.7,y+ny*gap*1.7),outside1=rgb(x-nx*gap,y-ny*gap),outside2=rgb(x-nx*gap*1.7,y-ny*gap*1.7);
        if(!inside1||!outside1)continue;
        const ii=inside2?inside1.map((v,j)=>(v+inside2[j])*.5):inside1,oo=outside2?outside1.map((v,j)=>(v+outside2[j])*.5):outside1;
        total+=(Math.abs(ii[0]-oo[0])+Math.abs(ii[1]-oo[1])+Math.abs(ii[2]-oo[2]))/765;n++;
      }
      edgeScores.push(n?total/n:0);
    }
    const sorted=[...edgeScores].sort((a,b)=>a-b),avg=edgeScores.reduce((a,b)=>a+b,0)/Math.max(1,edgeScores.length),robust=sorted.length>=3?sorted[1]:sorted[0]||0;
    return clamp(avg*.72+robust*.28,0,1);
  }

  function scoreDocumentQuad(points, rgba=null, w=0, h=0) {
    if (!points || points.length !== 4) return -Infinity;
    const p = orderQuad(points);
    if (!isConvexQuad(p)) return -Infinity;
    const area = Math.abs(polygonArea(p));
    if (area < 0.065 || area > 0.997) return -Infinity;
    const lengths = [distance(p[0],p[1]), distance(p[1],p[2]), distance(p[2],p[3]), distance(p[3],p[0])];
    if (Math.min(...lengths) < 0.075) return -Infinity;
    const angleCos = p.map((cur, i) => {
      const prev = p[(i + 3) % 4], next = p[(i + 1) % 4];
      const ax = prev.x-cur.x, ay = prev.y-cur.y, bx = next.x-cur.x, by = next.y-cur.y;
      return Math.abs((ax*bx+ay*by) / Math.max(1e-9, Math.hypot(ax,ay)*Math.hypot(bx,by)));
    });
    const rectangularity = clamp(1 - angleCos.reduce((a,b)=>a+b,0)/4, 0, 1);
    const cx = p.reduce((a,q)=>a+q.x,0)/4, cy = p.reduce((a,q)=>a+q.y,0)/4;
    const centerScore = clamp(1 - Math.hypot(cx-.5,cy-.5)/.72, 0, 1);
    const boundaryContrast = scoreQuadBoundaryContrast(p, rgba, w, h);
    const frameHits = p.filter(q => q.x < .010 || q.x > .990 || q.y < .010 || q.y > .990).length;
    const framePenalty = frameHits === 4 ? 1.00 : (frameHits >= 3 && area > .90 ? .85 : (frameHits >= 2 && area > .95 ? .35 : 0));
    return area * 2.85 + rectangularity * .72 + centerScore * .16 + boundaryContrast * 1.85 - framePenalty;
  }

  function isConvexQuad(points) {
    if (!points || points.length !== 4) return false;
    let sign = 0;
    for (let i=0;i<4;i++) {
      const a=points[i], b=points[(i+1)%4], c=points[(i+2)%4];
      const cross=(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
      if (Math.abs(cross)<1e-7) return false;
      const s=Math.sign(cross); if (!sign) sign=s; else if (s!==sign) return false;
    }
    return true;
  }

  function angleDistancePi(a,b) {
    let d=Math.abs(a-b)%Math.PI; if (d>Math.PI/2) d=Math.PI-d; return d;
  }

  function detectQuadFromHough(edge, w, h, cv) {
    const lines = new cv.Mat();
    try {
      cv.HoughLinesP(edge, lines, 1, Math.PI/180, Math.max(55, Math.round(Math.min(w,h)*.06)), Math.max(80, Math.round(Math.min(w,h)*.22)), Math.max(18, Math.round(Math.min(w,h)*.035)));
      const raw = [];
      const d = lines.data32S || [];
      for (let i=0; i+3<d.length; i+=4) {
        const x1=d[i], y1=d[i+1], x2=d[i+2], y2=d[i+3];
        const len=Math.hypot(x2-x1,y2-y1); if (len < Math.min(w,h)*.20) continue;
        let theta=Math.atan2(y2-y1,x2-x1); while(theta<0)theta+=Math.PI; while(theta>=Math.PI)theta-=Math.PI;
        raw.push({x1,y1,x2,y2,len,theta});
      }
      if (raw.length < 4) return null;
      raw.sort((a,b)=>b.len-a.len); raw.splice(48);
      const bins=18, hist=new Array(bins).fill(0);
      for(const l of raw) hist[Math.floor(l.theta/Math.PI*bins)%bins]+=l.len;
      let bestBin=0; for(let i=1;i<bins;i++) if(hist[i]>hist[bestBin])bestBin=i;
      const base=(bestBin+.5)*Math.PI/bins, ortho=(base+Math.PI/2)%Math.PI, tol=22*Math.PI/180;
      const famA=raw.filter(l=>angleDistancePi(l.theta,base)<tol);
      const famB=raw.filter(l=>angleDistancePi(l.theta,ortho)<tol);
      if(famA.length<2||famB.length<2)return null;

      const extremes=(fam, refTheta)=>{
        const nx=-Math.sin(refTheta), ny=Math.cos(refTheta);
        const items=fam.map(l=>{
          let A=l.y1-l.y2, B=l.x2-l.x1, C=l.x1*l.y2-l.x2*l.y1;
          const z=Math.hypot(A,B)||1; A/=z;B/=z;C/=z;
          if(A*nx+B*ny<0){A=-A;B=-B;C=-C;}
          return {A,B,C,rho:-C,len:l.len};
        }).sort((a,b)=>a.rho-b.rho);
        return [items[0],items[items.length-1]];
      };
      const [a0,a1]=extremes(famA,base), [b0,b1]=extremes(famB,ortho);
      const intersect=(l1,l2)=>{const det=l1.A*l2.B-l2.A*l1.B;if(Math.abs(det)<1e-7)return null;return{x:(l1.B*l2.C-l2.B*l1.C)/det,y:(l2.A*l1.C-l1.A*l2.C)/det};};
      const pts=[intersect(a0,b0),intersect(a0,b1),intersect(a1,b1),intersect(a1,b0)];
      if(pts.some(q=>!q||q.x<-w*.15||q.x>w*1.15||q.y<-h*.15||q.y>h*1.15))return null;
      return orderQuad(pts).map(q=>({x:clamp(q.x/w,0,1),y:clamp(q.y/h,0,1)}));
    } catch(err) {
      console.warn('Hough fallback 실패:', err);
      return null;
    } finally { try { lines.delete(); } catch {} }
  }

  async function refineDocumentCorners(blob, normalizedCorners) {
    const img=await loadImage(blob);
    const w0=img.naturalWidth||img.width, h0=img.naturalHeight||img.height;
    const scale=Math.min(1,1400/Math.max(w0,h0));
    const w=Math.max(120,Math.round(w0*scale)), h=Math.max(120,Math.round(h0*scale));
    const canvas=document.createElement('canvas'); canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true}); ctx.drawImage(img,0,0,w,h); cleanupLoadedImage(img);
    const rgba=ctx.getImageData(0,0,w,h).data, gray=new Uint8Array(w*h);
    for(let i=0,p=0;i<rgba.length;i+=4,p++)gray[p]=(77*rgba[i]+150*rgba[i+1]+29*rgba[i+2])>>8;
    releaseCanvas(canvas);
    const pts=orderQuad(normalizedCorners).map(p=>({x:p.x*w,y:p.y*h}));
    const sample=(x,y)=>{const ix=clamp(Math.round(x),0,w-1),iy=clamp(Math.round(y),0,h-1);return gray[iy*w+ix];};
    const lines=[]; const search=Math.max(5,Math.round(Math.min(w,h)*.030));
    for(let i=0;i<4;i++){
      const a=pts[i],b=pts[(i+1)%4],dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1,tx=dx/len,ty=dy/len,nx=-ty,ny=tx;
      let bestOff=0,bestScore=-1;
      const step=search>18?2:1;
      for(let off=-search;off<=search;off+=step){
        let total=0,n=0;
        const samples=Math.min(96,Math.max(44,Math.round(len/12)));
        for(let k=0;k<samples;k++){
          const t=.07+.86*(k/(samples-1)); const x=a.x+dx*t+nx*off,y=a.y+dy*t+ny*off;
          if(x<3||x>w-4||y<3||y>h-4)continue;
          total+=Math.abs(sample(x+nx*2,y+ny*2)-sample(x-nx*2,y-ny*2)); n++;
        }
        if(!n)continue;
        const score=(total/n)*(1-.12*Math.abs(off)/search);
        if(score>bestScore){bestScore=score;bestOff=off;}
      }
      lines.push({a:{x:a.x+nx*bestOff,y:a.y+ny*bestOff},b:{x:b.x+nx*bestOff,y:b.y+ny*bestOff}});
    }
    const intersectSegLines=(l1,l2)=>{const x1=l1.a.x,y1=l1.a.y,x2=l1.b.x,y2=l1.b.y,x3=l2.a.x,y3=l2.a.y,x4=l2.b.x,y4=l2.b.y;const den=(x1-x2)*(y3-y4)-(y1-y2)*(x3-x4);if(Math.abs(den)<1e-7)return null;return{x:((x1*y2-y1*x2)*(x3-x4)-(x1-x2)*(x3*y4-y3*x4))/den,y:((x1*y2-y1*x2)*(y3-y4)-(y1-y2)*(x3*y4-y3*x4))/den};};
    const refined=[intersectSegLines(lines[3],lines[0]),intersectSegLines(lines[0],lines[1]),intersectSegLines(lines[1],lines[2]),intersectSegLines(lines[2],lines[3])];
    if(refined.some(q=>!q||q.x<-w*.04||q.x>w*1.04||q.y<-h*.04||q.y>h*1.04))return normalizedCorners;
    const norm=orderQuad(refined).map(q=>({x:clamp(q.x/w,0,1),y:clamp(q.y/h,0,1)}));
    const oldArea=Math.abs(polygonArea(orderQuad(normalizedCorners))),newArea=Math.abs(polygonArea(norm));
    if(!isReasonableQuad(norm)||newArea<oldArea*.68||newArea>oldArea*1.22)return normalizedCorners;
    return norm;
  }

  function insetQuad(points, factor=.004) {
    const p=orderQuad(points),cx=p.reduce((a,q)=>a+q.x,0)/4,cy=p.reduce((a,q)=>a+q.y,0)/4;
    return p.map(q=>({x:clamp(q.x+(cx-q.x)*factor,0,1),y:clamp(q.y+(cy-q.y)*factor,0,1)}));
  }

  async function warpDocumentOpenCv(blob, normalizedCorners) {
    if (!state.cvReady || !window.cv?.Mat) throw new Error('OpenCV 가속 엔진이 준비되지 않았습니다.');
    const img = await loadImage(blob); const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const source = document.createElement('canvas'); source.width=w; source.height=h; source.getContext('2d',{alpha:false}).drawImage(img,0,0); cleanupLoadedImage(img);
    const pts = orderQuad(normalizedCorners.map(p => ({x:p.x*w,y:p.y*h})));
    const [tl,tr,br,bl] = pts; let outW = Math.round(Math.max(distance(br,bl), distance(tr,tl))); let outH = Math.round(Math.max(distance(tr,br), distance(tl,bl)));
    if (outW < 120 || outH < 120) { releaseCanvas(source); throw new Error('선택한 문서 영역이 너무 작습니다.'); }
    const fitted = fitDimensions(outW, outH, IMPORT_MAX); outW = fitted.width; outH = fitted.height;
    const cv=window.cv; let src, srcPts, dstPts, matrix, dst;
    try {
      src=cv.imread(source); srcPts=cv.matFromArray(4,1,cv.CV_32FC2,[tl.x,tl.y,tr.x,tr.y,br.x,br.y,bl.x,bl.y]); dstPts=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,outW-1,0,outW-1,outH-1,0,outH-1]); matrix=cv.getPerspectiveTransform(srcPts,dstPts); dst=new cv.Mat();
      cv.warpPerspective(src,dst,matrix,new cv.Size(outW,outH),cv.INTER_LINEAR,cv.BORDER_CONSTANT,new cv.Scalar(255,255,255,255));
      const out=document.createElement('canvas'); cv.imshow(out,dst); const result=await canvasToBlob(out,'image/jpeg',0.96); releaseCanvas(out); return result;
    } finally { [src,srcPts,dstPts,matrix,dst].forEach(x=>{try{x?.delete?.();}catch{}}); releaseCanvas(source); }
  }

  function orderQuad(points) {
    const list=(points||[]).map(p=>({x:Number(p.x),y:Number(p.y)}));
    if(list.length!==4)return list;
    const sum=p=>p.x+p.y, diff=p=>p.x-p.y;
    const tl=list.reduce((a,b)=>sum(a)<sum(b)?a:b), br=list.reduce((a,b)=>sum(a)>sum(b)?a:b), tr=list.reduce((a,b)=>diff(a)>diff(b)?a:b), bl=list.reduce((a,b)=>diff(a)<diff(b)?a:b);
    const direct=[tl,tr,br,bl];
    if(new Set(direct).size===4)return direct;
    // 거의 마름모꼴인 강한 원근에서 sum/diff 극점이 겹치면 중심각 기반으로 복구합니다.
    const cx=list.reduce((a,p)=>a+p.x,0)/4,cy=list.reduce((a,p)=>a+p.y,0)/4;
    let ordered=[...list].sort((a,b)=>Math.atan2(a.y-cy,a.x-cx)-Math.atan2(b.y-cy,b.x-cx));
    let start=0;for(let i=1;i<4;i++)if(sum(ordered[i])<sum(ordered[start]))start=i;
    ordered=[...ordered.slice(start),...ordered.slice(0,start)];
    if(polygonArea(ordered)<0)ordered=[ordered[0],ordered[3],ordered[2],ordered[1]];
    return ordered;
  }
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));

  function bindCropEditor() {
    els.cropCanvas.addEventListener('pointerdown', e => {
      const c = state.cropEditor; if (!c) return;
      const p = canvasPoint(e, els.cropCanvas); let best=-1, dist=Infinity;
      c.points.forEach((q,i)=>{const d=Math.hypot(q.x-p.x,q.y-p.y); if(d<dist){dist=d;best=i;}});
      if (dist < Math.max(36, els.cropCanvas.width * .055)) { c.dragIndex=best; showCropMagnifier(c.points[best]); try{els.cropCanvas.setPointerCapture(e.pointerId);}catch{} e.preventDefault(); }
    });
    els.cropCanvas.addEventListener('pointermove', e => {
      const c=state.cropEditor; if(!c || c.dragIndex==null) return; e.preventDefault(); const p=canvasPoint(e,els.cropCanvas); c.points[c.dragIndex]={x:clamp(p.x,0,els.cropCanvas.width),y:clamp(p.y,0,els.cropCanvas.height)}; drawCropEditor(); showCropMagnifier(c.points[c.dragIndex]);
    }, {passive:false});
    const stop=()=>{if(state.cropEditor) state.cropEditor.dragIndex=null; els.cropMagnifier?.classList.add('hidden');}; els.cropCanvas.addEventListener('pointerup',stop); els.cropCanvas.addEventListener('pointercancel',stop);
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
    const img=await loadImage(page.sourceBlob); const w=img.naturalWidth||img.width,h=img.naturalHeight||img.height; const scale=Math.min(1,1000/Math.max(w,h));
    els.cropCanvas.width=Math.max(1,Math.round(w*scale));els.cropCanvas.height=Math.max(1,Math.round(h*scale));
    const ctx=els.cropCanvas.getContext('2d',{alpha:false});ctx.fillStyle='#111';ctx.fillRect(0,0,els.cropCanvas.width,els.cropCanvas.height);ctx.drawImage(img,0,0,els.cropCanvas.width,els.cropCanvas.height);cleanupLoadedImage(img);
    const baseCanvas=document.createElement('canvas');baseCanvas.width=els.cropCanvas.width;baseCanvas.height=els.cropCanvas.height;baseCanvas.getContext('2d',{alpha:false}).drawImage(els.cropCanvas,0,0);
    state.cropEditor={page,base:ctx.getImageData(0,0,els.cropCanvas.width,els.cropCanvas.height),baseCanvas,points:[],dragIndex:null};
    let corners=page.cropCorners; if(!corners){try{corners=await detectDocumentCorners(page.sourceBlob);}catch{}}
    setCropPoints(corners||defaultCorners());drawCropEditor();openSheet(els.cropSheet);
  }
  function defaultCorners(){return[{x:.025,y:.025},{x:.975,y:.025},{x:.975,y:.975},{x:.025,y:.975}];}
  function setCropPoints(norm){state.cropEditor.points=orderQuad(norm).map(p=>({x:p.x*els.cropCanvas.width,y:p.y*els.cropCanvas.height}));}
  function drawCropEditor(){const c=state.cropEditor;if(!c)return;const ctx=els.cropCanvas.getContext('2d');ctx.putImageData(c.base,0,0);ctx.save();ctx.fillStyle='rgba(0,0,0,.45)';ctx.beginPath();ctx.rect(0,0,els.cropCanvas.width,els.cropCanvas.height);ctx.moveTo(c.points[0].x,c.points[0].y);for(let i=1;i<c.points.length;i++)ctx.lineTo(c.points[i].x,c.points[i].y);ctx.closePath();ctx.fill('evenodd');ctx.strokeStyle='#4c9aff';ctx.lineWidth=Math.max(3,els.cropCanvas.width*.004);ctx.beginPath();c.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.stroke();c.points.forEach(p=>{ctx.fillStyle='#fff';ctx.strokeStyle='#3182f6';ctx.lineWidth=4;ctx.beginPath();ctx.arc(p.x,p.y,Math.max(9,els.cropCanvas.width*.012),0,Math.PI*2);ctx.fill();ctx.stroke();});ctx.restore();}
  function showCropMagnifier(point){
    const c=state.cropEditor,mag=els.cropMagnifier;if(!c?.baseCanvas||!mag||!point)return;
    const mctx=mag.getContext('2d',{alpha:false}),src=44;
    const sx=clamp(point.x-src/2,0,Math.max(0,c.baseCanvas.width-src)),sy=clamp(point.y-src/2,0,Math.max(0,c.baseCanvas.height-src));
    mctx.setTransform(1,0,0,1,0,0);mctx.fillStyle='#fff';mctx.fillRect(0,0,mag.width,mag.height);mctx.imageSmoothingEnabled=false;
    mctx.drawImage(c.baseCanvas,sx,sy,src,src,0,0,mag.width,mag.height);
    mctx.strokeStyle='#3182f6';mctx.lineWidth=2;mctx.beginPath();mctx.moveTo(mag.width/2-13,mag.height/2);mctx.lineTo(mag.width/2+13,mag.height/2);mctx.moveTo(mag.width/2,mag.height/2-13);mctx.lineTo(mag.width/2,mag.height/2+13);mctx.stroke();
    mag.classList.remove('hidden');
    const stage=mag.parentElement,rect=stage?.getBoundingClientRect(),canvasRect=els.cropCanvas.getBoundingClientRect();
    if(rect&&canvasRect){
      const px=(point.x/els.cropCanvas.width)*canvasRect.width+(canvasRect.left-rect.left),py=(point.y/els.cropCanvas.height)*canvasRect.height+(canvasRect.top-rect.top),gap=28;
      // 꼭짓점과 확대경이 겹치지 않도록 포인트의 반대 사분면에 배치합니다.
      // 특히 좌상단은 확대경을 우하단에 띄워 손가락/포인트/확대경이 한곳에 겹치지 않습니다.
      let left=px<rect.width/2?px+gap:px-mag.width-gap,top=py<rect.height/2?py+gap:py-mag.height-gap;
      left=clamp(left,8,Math.max(8,rect.width-mag.width-8));top=clamp(top,8,Math.max(8,rect.height-mag.height-8));mag.style.left=`${left}px`;mag.style.top=`${top}px`;
    }
  }
  function canvasPoint(e,canvas){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height};}
  function closeCropEditor(){if(state.cropEditor){state.cropEditor.base=null;if(state.cropEditor.baseCanvas)releaseCanvas(state.cropEditor.baseCanvas);state.cropEditor=null;}els.cropMagnifier?.classList.add('hidden');closeSheet(els.cropSheet);}

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
    if (filter==='document' && state.cvReady && window.cv) {
      const cv=window.cv;let src,gray,out,rgba;try{src=cv.imread(canvas);gray=new cv.Mat();out=new cv.Mat();rgba=new cv.Mat();cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY,0);cv.GaussianBlur(gray,gray,new cv.Size(3,3),0);cv.adaptiveThreshold(gray,out,255,cv.ADAPTIVE_THRESH_GAUSSIAN_C,cv.THRESH_BINARY,31,13);cv.cvtColor(out,rgba,cv.COLOR_GRAY2RGBA,0);cv.imshow(canvas,rgba);return;}catch(err){console.warn('OpenCV 문서 필터 실패, JS 필터로 전환',err);}finally{[src,gray,out,rgba].forEach(x=>{try{x?.delete?.();}catch{}});}
    }
    const ctx=canvas.getContext('2d',{willReadFrequently:true});const image=ctx.getImageData(0,0,canvas.width,canvas.height);const d=image.data;
    let mean=0,count=0;for(let i=0;i<d.length;i+=Math.max(4,Math.floor(d.length/600000/4)*4||4)){mean+=.299*d[i]+.587*d[i+1]+.114*d[i+2];count++;}mean/=Math.max(1,count);
    for(let i=0;i<d.length;i+=4){const y=.299*d[i]+.587*d[i+1]+.114*d[i+2];if(filter==='bw'){const v=clamp(y,0,255);d[i]=d[i+1]=d[i+2]=v;}else if(filter==='document'){const threshold=clamp(mean*.88,125,205);const v=y>threshold?255:0;d[i]=d[i+1]=d[i+2]=v;}}
    ctx.putImageData(image,0,0);
  }

  async function ensureOcrData(pages, startPct=0, endPct=65, title='OCR PDF 만들기') {
    showProgress(title,`${ocrLanguageLabel()} OCR 엔진을 준비하고 있습니다.`,startPct);
    const worker=await getOcrWorker(m=>{if(m.status==='recognizing text'){const base=state._ocrBase??startPct,span=state._ocrSpan??1;updateProgress(base+m.progress*span,'문서의 글자를 인식하고 있습니다.');}});
    const q=getQuality();
    for(let i=0;i<pages.length;i++){
      const a=startPct+(i/pages.length)*(endPct-startPct),b=startPct+((i+1)/pages.length)*(endPct-startPct);
      if(pages[i].ocr)continue;
      state._ocrBase=a;state._ocrSpan=b-a;updateProgress(a,`${i+1} / ${pages.length} 페이지 OCR 전처리`);
      const canvas=await buildOcrCanvas(pages[i],q.ocr);
      try {
        let result=await worker.recognize(canvas,{}, {text:true,tsv:true});
        const firstScore=ocrResultScore(result);
        // 레이아웃 자동 인식이 거의 읽지 못한 경우에만 단일 블록 모드로 한 번 더 시도합니다.
        if(firstScore<52){
          try{
            await worker.setParameters?.({tessedit_pageseg_mode:'6'});
            const retry=await worker.recognize(canvas,{}, {text:true,tsv:true});
            if(ocrResultScore(retry)>firstScore+3)result=retry;
          }finally{try{await worker.setParameters?.({tessedit_pageseg_mode:'3'});}catch{}}
        }
        const text=(result?.data?.text||'').trim();
        const words=parseTsv(result?.data?.tsv||'');
        pages[i].ocr={text,words,width:canvas.width,height:canvas.height,confidence:Number(result?.data?.confidence)||0};
      } finally { releaseCanvas(canvas); }
    }
    delete state._ocrBase;delete state._ocrSpan;renderPages();scheduleOcrWorkerRelease();
  }

  async function buildOcrCanvas(page,maxDimension){
    const canvas=await renderPageToCanvas(page,maxDimension);
    // 저장 이미지와 OCR 입력 이미지를 분리합니다. OCR용 사본만 회색조/대비 정규화를 적용합니다.
    if(page.filter==='document')return canvas;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const image=ctx.getImageData(0,0,canvas.width,canvas.height),d=image.data,hist=new Uint32Array(256);
    let pixels=0;
    for(let i=0;i<d.length;i+=4){const y=(77*d[i]+150*d[i+1]+29*d[i+2])>>8;hist[y]++;pixels++;}
    const percentile=(ratio)=>{let acc=0,target=pixels*ratio;for(let i=0;i<256;i++){acc+=hist[i];if(acc>=target)return i;}return ratio<.5?0:255;};
    let lo=percentile(.015),hi=percentile(.985);if(hi-lo<70){lo=Math.max(0,lo-20);hi=Math.min(255,hi+20);}const span=Math.max(48,hi-lo);
    for(let i=0;i<d.length;i+=4){const y=(77*d[i]+150*d[i+1]+29*d[i+2])>>8;let v=clamp((y-lo)*255/span,0,255);v=clamp((v-128)*1.06+132,0,255);d[i]=d[i+1]=d[i+2]=v;d[i+3]=255;}
    ctx.putImageData(image,0,0);return canvas;
  }

  function ocrResultScore(result){
    const text=String(result?.data?.text||'').replace(/\s/g,'');
    const conf=Number(result?.data?.confidence)||0;
    return conf*.72+Math.min(28,Math.log2(text.length+1)*4.2);
  }

  function scheduleOcrWorkerRelease(){
    if(state.ocrWorkerTimer)clearTimeout(state.ocrWorkerTimer);
    state.ocrWorkerTimer=setTimeout(async()=>{const worker=state.ocrWorker;state.ocrWorker=null;state.ocrWorkerTimer=null;if(worker){try{await worker.terminate();console.info('OCR worker released');}catch{}}},90000);
  }

  async function ensureOcrRuntimeAssets(onProgress) {
    const langs = getSelectedOcrLanguages();
    if (!langs.length) throw new Error('OCR 언어를 하나 이상 선택해 주세요.');
    const key = langs.join('+');
    if (state.ocrAssetsPromise && state.ocrAssetsKey === key) return state.ocrAssetsPromise;
    state.ocrAssetsKey = key;
    state.ocrAssetsPromise = (async () => {
      const rt = window.ScanBoxRuntime;
      if (!rt) throw new Error('보안 런타임을 불러오지 못했습니다.');
      const assets = [SOURCES.tesseractMain, SOURCES.tesseractWorker, ...TESS_CORE_ASSETS, ...getSelectedOcrLanguageAssets()];
      await rt.warmAssets(assets, (p, item) => onProgress?.(p, item));
      await rt.loadScript({ ...SOURCES.tesseractMain, globalCheck: () => !!window.Tesseract });
      if (!window.Tesseract?.createWorker) throw new Error('OCR 라이브러리 초기화에 실패했습니다.');
      return true;
    })().catch(err => { state.ocrAssetsPromise = null; state.ocrAssetsKey = ''; throw err; });
    return state.ocrAssetsPromise;
  }

  async function getOcrWorker(logger) {
    state.ocrLogger = logger;
    if (state.ocrWorkerTimer) { clearTimeout(state.ocrWorkerTimer); state.ocrWorkerTimer = null; }
    const langs = getSelectedOcrLanguages();
    if (!langs.length) throw new Error('OCR 언어를 하나 이상 선택해 주세요.');
    const langKey = langs.join('+');
    if (state.ocrWorker && state.ocrWorkerLangKey === langKey) return state.ocrWorker;
    if (state.ocrWorker) await resetOcrWorker();
    await ensureOcrRuntimeAssets((p, item) => {
      if (state.busy) updateProgress(Math.min(35, 4 + p * 28), `${item?.name || 'OCR 엔진'} 보안 캐시 준비 중`);
    });
    const rt = window.ScanBoxRuntime;
    const workerPath = rt.virtualUrl('tesseract/worker.min.js');
    const corePath = rt.virtualUrl('tesseract/core').replace(/\/$/, '');
    const langPath = rt.virtualUrl('tesseract/lang').replace(/\/$/, '');
    state.ocrWorker = await window.Tesseract.createWorker(langs, 1, {
      workerPath, corePath, langPath, gzip: true,
      logger: m => state.ocrLogger?.(m),
      errorHandler: err => console.error('Tesseract worker:', err)
    });
    state.ocrWorkerLangKey = langKey;
    try { await state.ocrWorker.setParameters({ tessedit_pageseg_mode:'3', preserve_interword_spaces:'1', user_defined_dpi:'300' }); } catch (err) { console.warn('OCR 파라미터 일부 적용 실패:', err); }
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
          pdfPages.push({ jpegBytes: bytes, width: canvas.width, height: canvas.height, ocrWords, ocrTextOverride: searchable && pages[i].ocr?.editedText != null ? pages[i].ocr.editedText : null });
        } finally { releaseCanvas(canvas); }
      }
      updateProgress(96, 'PDF 구조와 검색 레이어를 저장하고 있습니다.');
      const pdfBytes = window.ScanBoxPDF.build({ pages: pdfPages, title: baseName, searchable, pageSize: els.pdfPageSize?.value || 'fit' });
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


  function getQuality(){return QUALITY[els.qualityPreset?.value]||QUALITY.standard;}
  function updateEstimatedSize(){if(!els.estimatedSize)return;if(!state.pages.length){els.estimatedSize.textContent='페이지를 추가하면 예상 용량을 표시합니다.';return;}const sum=state.pages.reduce((s,p)=>s+(p.blob?.size||0),0),q=getQuality(),fmt=els.exportFormat.value;let factor=(q.jpg/.9)*(q.max/3000)**.45;if(fmt==='png')factor*=2.1;if(fmt==='pdf'||fmt==='searchable-pdf')factor*=1.05;if(fmt==='searchable-pdf')factor*=1.04;els.estimatedSize.textContent=`예상 약 ${formatBytes(Math.round(sum*factor))} · ${q.label}`;}

  function setLatestOutput(output){if(!output?.blob||!output?.name)return;state.latestOutput=output;els.outputInfo.textContent=`${output.name} · ${formatBytes(output.blob.size)}`;const f=new File([output.blob],output.name,{type:output.blob.type||'application/octet-stream'});const can=!!(navigator.share&&(!navigator.canShare||navigator.canShare({files:[f]})));els.shareOutputBtn.disabled=!navigator.share;els.shareOutputBtn.textContent=can?'공유 / 파일에 저장':'공유';openSheet(els.outputSheet);}
  async function shareBlob(blob,name){if(!navigator.share){downloadBlob(blob,name);return showToast('공유 기능이 없어 다운로드로 저장했습니다.');}const file=new File([blob],name,{type:blob.type||'application/octet-stream'});try{if(!navigator.canShare||navigator.canShare({files:[file]}))await navigator.share({files:[file],title:name});else await navigator.share({title:name,text:'ScanBox에서 만든 파일입니다.'});}catch(err){if(err?.name!=='AbortError'){downloadBlob(blob,name);showToast('공유 대신 다운로드로 저장했습니다.');}}}
  function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.rel='noopener';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}

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
    if(!st.persistentPins){els.securityBadge.textContent='세션 잠금';els.securityDetail.textContent='SHA-256 잠금이 현재 세션에만 유지됩니다.';}
    else if(!st.pinCount){els.securityBadge.textContent='보안 대기';els.securityDetail.textContent='엔진은 최초 사용 시 고정 버전 + SHA-256 지문으로 잠급니다.';}
    else{els.securityBadge.textContent='보안 강화';els.securityDetail.textContent=`검증된 실행 자산 ${st.pinCount}개를 앱 전용 캐시에서 사용합니다.`;}
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
