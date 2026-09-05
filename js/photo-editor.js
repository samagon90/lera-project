/* =====================================================================
   ФОТОРЕДАКТОР АДМИН-ПАНЕЛИ «ДарЛес»
   - Замена белого фона (умное удаление прямо в браузере, без сервисов):
     фон «вырезается» заливкой от краёв, растение остаётся нетронутым
     (даже белые цветки внутри кроны не пострадают).
   - Выравнивание: перетаскивание растения мышкой, масштаб, поворот.
   - Результат — фото 1200x1600 (3:4) под формат карточки каталога.

   Вызов: PhotoEditor.open({ source, state, onSave })
   ===================================================================== */

(function () {
  "use strict";

  const OUT_W = 1200, OUT_H = 1600;            // формат карточки 3:4
  const FIT_W = OUT_W - 92, FIT_H = OUT_H - 92; // базовые поля 46px
  const MAX_SRC = 1600;                         // предел исходника

  /* Чувствительность удаления фона: t1 — «точно фон», t2 — мягкий край */
  const SENS = [
    { label: "Аккуратно (сохранить тени)", t1: 12, t2: 30 },
    { label: "Обычно", t1: 24, t2: 55 },
    { label: "Агрессивно (убрать всё светлое)", t1: 40, t2: 82 },
  ];

  const BGS = [
    { id: "mint",  label: "Мята",     css: "linear-gradient(135deg,#e9f4ee,#cfe4d7)" },
    { id: "gray",  label: "Серый",    css: "#f1f3f1" },
    { id: "cream", label: "Кремовый", css: "#f8f3e6" },
    { id: "sky",   label: "Небо",     css: "linear-gradient(135deg,#ecf3f9,#d5e5f2)" },
    { id: "dark",  label: "Тёмный",   css: "#22432f" },
    { id: "custom", label: "Свой цвет", css: "#ffffff" },
  ];

  function paintBg(ctx, state) {
    const bg = BGS.find(b => b.id === state.bg) || BGS[0];
    if (state.bg === "custom") {
      ctx.fillStyle = state.custom || "#f1f3f1";
      ctx.fillRect(0, 0, OUT_W, OUT_H);
      return;
    }
    if (bg.css.startsWith("linear-gradient")) {
      const g = ctx.createLinearGradient(0, 0, OUT_W, OUT_H);
      g.addColorStop(0, bg.css.match(/#\w+/g)[0]);
      g.addColorStop(1, bg.css.match(/#\w+/g)[1]);
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = bg.css;
    }
    ctx.fillRect(0, 0, OUT_W, OUT_H);
  }

  /* ------------------------------------------------------------------ */
  /* Удаление фона: заливка от краёв по «белизне» пикселей               */
  /* ------------------------------------------------------------------ */
  function computeAlphaData(imgData, t1, t2) {
    const data = imgData.data, w = imgData.width, h = imgData.height, n = w * h;

    /* «отклонение от белого» каждого пикселя: 0 = чистый белый */
    const dev = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      const d = Math.max(255 - data[j], 255 - data[j + 1], 255 - data[j + 2]);
      dev[i] = d;
    }

    const alpha = new Uint8ClampedArray(n).fill(255);
    const visited = new Uint8Array(n);
    const qx = new Int32Array(n);
    let head = 0, tail = 0;
    const push = i => { qx[tail++] = i; visited[i] = 1; };

    /* стартуем со всех краевых пикселей, близких к белому */
    for (let x = 0; x < w; x++) {
      if (dev[x] <= t1) push(x);
      const b = (h - 1) * w + x;
      if (dev[b] <= t1) push(b);
    }
    for (let y = 0; y < h; y++) {
      const l = y * w, r = l + w - 1;
      if (dev[l] <= t1) push(l);
      if (dev[r] <= t1) push(r);
    }

    const visit = k => {
      if (visited[k]) return;
      const d = dev[k];
      if (d <= t1) push(k);                      /* фон — продолжаем заливку */
      else if (d <= t2) {                        /* мягкий край — полупрозрачно */
        visited[k] = 1;
        alpha[k] = Math.round(255 * (d - t1) / (t2 - t1));
      }
    };

    while (head < tail) {
      const i = qx[head++];
      alpha[i] = 0;
      const x = i % w, y = (i - x) / w;
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    return alpha;
  }

  /* ------------------------------------------------------------------ */
  /* DOM (только в браузере)                                             */
  /* ------------------------------------------------------------------ */
  if (typeof document === "undefined") {
    /* тестовый доступ для Node */
    globalThis.__PhotoEditorTest = { computeAlphaData, SENS, BGS };
    return;
  }

  const DEFAULT_STATE = {
    replace: false,     // заменять ли фон
    bg: "mint",
    custom: "#f1f3f1",
    sens: 1,
    scale: 1,           // 0.5–2
    rot: 0,             // -15..15
    dx: 0, dy: 0,
  };

  let overlay, canvas, ctx, srcCanvas, cutoutCache = null, cutoutKey = "";
  let state = { ...DEFAULT_STATE };
  let onSaveCb = null;
  let raf = 0;

  function buildModal() {
    overlay = document.createElement("div");
    overlay.className = "pe-overlay";
    overlay.innerHTML = `
      <div class="pe-dialog" role="dialog" aria-label="Редактор фото">
        <div class="pe-dialog__head">
          <h3>Редактор фото</h3>
          <button class="pe-x" type="button" aria-label="Закрыть">✕</button>
        </div>
        <div class="pe-body">
          <div class="pe-stage">
            <canvas class="pe-canvas" width="${OUT_W}" height="${OUT_H}"></canvas>
            <p class="pe-note">Перетаскивайте растение мышкой или пальцем прямо в рамке.<br>
            Колесо мыши — масштаб. Рамка соответствует карточке каталога (3:4).</p>
          </div>
          <div class="pe-controls">
            <div class="pe-sec">
              <h4>Фон</h4>
              <label class="pe-toggle">
                <input type="checkbox" id="peReplace">
                Заменить белый фон
              </label>
              <div class="pe-swatches" id="peSwatches">
                ${BGS.map(b => `
                  <button type="button" class="pe-sw" data-bg="${b.id}" style="background:${b.css}">
                    <span>${b.label}</span>
                  </button>`).join("")}
                <label class="pe-sw pe-sw--custom" id="peCustomSw" title="Свой цвет">
                  <input type="color" id="peCustom" value="#f1f3f1">
                  <span>Свой цвет</span>
                </label>
              </div>
              <label class="pe-lab">Чувствительность к фону
                <select id="peSens" class="pe-select">
                  ${SENS.map((s, i) => `<option value="${i}">${s.label}</option>`).join("")}
                </select>
              </label>
            </div>
            <div class="pe-sec">
              <h4>Выравнивание</h4>
              <div class="pe-row">
                <label for="peScale">Масштаб</label>
                <input type="range" id="peScale" min="50" max="200" value="100">
                <output id="peScaleOut">100%</output>
              </div>
              <div class="pe-row">
                <label for="peRot">Поворот</label>
                <input type="range" id="peRot" min="-15" max="15" value="0">
                <output id="peRotOut">0°</output>
              </div>
              <div class="pe-btns">
                <button type="button" class="prow__btn" id="peCenter">Центрировать</button>
                <button type="button" class="prow__btn" id="peReset">Сбросить всё</button>
              </div>
            </div>
          </div>
        </div>
        <div class="pe-dialog__foot">
          <button type="button" class="btn btn--ghost btn--sm" id="peCancel">Отмена</button>
          <button type="button" class="btn btn--sm" id="peSave">Сохранить фото</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    canvas = overlay.querySelector(".pe-canvas");
    ctx = canvas.getContext("2d");

    overlay.querySelector(".pe-x").addEventListener("click", close);
    overlay.querySelector("#peCancel").addEventListener("click", close);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && overlay.classList.contains("open")) close(); });

    overlay.querySelector("#peReplace").addEventListener("change", e => {
      state.replace = e.target.checked;
      scheduleRender();
      syncBgUI();
    });
    overlay.querySelectorAll(".pe-sw[data-bg]").forEach(b => b.addEventListener("click", () => {
      state.bg = b.dataset.bg;
      if (!state.replace) { state.replace = true; overlay.querySelector("#peReplace").checked = true; }
      scheduleRender(); syncBgUI();
    }));
    overlay.querySelector("#peCustom").addEventListener("input", e => {
      state.custom = e.target.value;
      state.bg = "custom";
      if (!state.replace) { state.replace = true; overlay.querySelector("#peReplace").checked = true; }
      overlay.querySelector("#peCustomSw").style.background = state.custom;
      scheduleRender(); syncBgUI();
    });
    overlay.querySelector("#peSens").addEventListener("change", e => {
      state.sens = +e.target.value;
      scheduleRender();
    });
    overlay.querySelector("#peScale").addEventListener("input", e => {
      state.scale = +e.target.value / 100;
      overlay.querySelector("#peScaleOut").value = e.target.value + "%";
      scheduleRender();
    });
    overlay.querySelector("#peRot").addEventListener("input", e => {
      state.rot = +e.target.value;
      overlay.querySelector("#peRotOut").value = e.target.value + "°";
      scheduleRender();
    });
    overlay.querySelector("#peCenter").addEventListener("click", () => {
      state.dx = state.dy = 0; state.scale = 1; state.rot = 0;
      syncSliders(); scheduleRender();
    });
    overlay.querySelector("#peReset").addEventListener("click", () => {
      state = { ...DEFAULT_STATE };
      syncAll(); scheduleRender();
    });
    overlay.querySelector("#peSave").addEventListener("click", () => {
      render();
      const dataURL = canvas.toDataURL("image/jpeg", 0.9);
      if (onSaveCb) onSaveCb({ dataURL, state: { ...state } });
      close();
    });

    /* перетаскивание растения по рамке */
    let drag = null;
    canvas.addEventListener("pointerdown", e => {
      canvas.setPointerCapture(e.pointerId);
      const r = canvas.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, k: canvas.width / r.width };
      canvas.classList.add("dragging");
    });
    canvas.addEventListener("pointermove", e => {
      if (!drag) return;
      state.dx += (e.clientX - drag.x) * drag.k;
      state.dy += (e.clientY - drag.y) * drag.k;
      drag.x = e.clientX; drag.y = e.clientY;
      scheduleRender();
    });
    ["pointerup", "pointercancel"].forEach(ev => canvas.addEventListener(ev, () => {
      drag = null; canvas.classList.remove("dragging");
    }));
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      state.scale = Math.min(2, Math.max(0.5, state.scale * (e.deltaY < 0 ? 1.05 : 0.95)));
      syncSliders(); scheduleRender();
    }, { passive: false });
  }

  function syncSliders() {
    overlay.querySelector("#peScale").value = Math.round(state.scale * 100);
    overlay.querySelector("#peScaleOut").value = Math.round(state.scale * 100) + "%";
    overlay.querySelector("#peRot").value = state.rot;
    overlay.querySelector("#peRotOut").value = state.rot + "°";
  }
  function syncBgUI() {
    overlay.querySelectorAll(".pe-sw").forEach(b =>
      b.classList.toggle("active", state.replace && (b.dataset.bg === state.bg ||
        (b.id === "peCustomSw" && state.bg === "custom"))));
    overlay.querySelector("#peSwatches").style.opacity = state.replace ? "" : ".45";
    overlay.querySelector("#peCustomSw").style.background = state.custom;
  }
  function syncAll() {
    overlay.querySelector("#peReplace").checked = state.replace;
    overlay.querySelector("#peSens").value = state.sens;
    overlay.querySelector("#peCustom").value = state.custom;
    syncSliders(); syncBgUI();
  }

  /* ------------------------------------------------------------------ */
  /* Отрисовка                                                           */
  /* ------------------------------------------------------------------ */
  function ensureSrc(sourceURL, cb) {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, MAX_SRC / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      cb(c);
    };
    img.src = sourceURL;
  }

  function cutout() {
    const key = state.sens + "@" + srcCanvas.width + "x" + srcCanvas.height;
    if (cutoutKey === key && cutoutCache) return cutoutCache;
    const { t1, t2 } = SENS[state.sens];
    const ictx = srcCanvas.getContext("2d");
    const img = ictx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    const alpha = computeAlphaData(img, t1, t2);
    const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
    for (let i = 0; i < alpha.length; i++) out.data[i * 4 + 3] = alpha[i];
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    c.getContext("2d").putImageData(out, 0, 0);
    cutoutCache = c; cutoutKey = key;
    return c;
  }

  function render() {
    if (!srcCanvas) return;
    ctx.clearRect(0, 0, OUT_W, OUT_H);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, OUT_W, OUT_H);
    if (state.replace) paintBg(ctx, state);

    const src = state.replace ? cutout() : srcCanvas;
    const base = Math.min(FIT_W / src.width, FIT_H / src.height, 1.05);
    const s = base * state.scale;
    ctx.save();
    ctx.translate(OUT_W / 2 + state.dx, OUT_H / 2 + state.dy);
    ctx.rotate(state.rot * Math.PI / 180);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, -src.width * s / 2, -src.height * s / 2, src.width * s, src.height * s);
    ctx.restore();
  }
  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; render(); });
  }

  function close() {
    overlay.classList.remove("open");
  }

  /* ------------------------------------------------------------------ */
  /* Публичный API                                                       */
  /* ------------------------------------------------------------------ */
  function open({ source, state: saved, onSave }) {
    if (!overlay) buildModal();
    state = { ...DEFAULT_STATE, ...(saved || {}) };
    onSaveCb = onSave;
    cutoutCache = null; cutoutKey = "";
    syncAll();
    overlay.classList.add("open");
    ensureSrc(source, c => { srcCanvas = c; cutoutCache = null; cutoutKey = ""; render(); });
    render();
  }

  globalThis.PhotoEditor = { open };
  globalThis.__PhotoEditorTest = { computeAlphaData, SENS, BGS };
})();
