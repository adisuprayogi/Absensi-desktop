/* Utilitas bersama untuk seluruh halaman. Tidak memakai modul ES agar bisa
   dimuat langsung dari file:// tanpa proses build. */
'use strict';

window.App = (function () {
  const pages = {};
  let currentPage = null;
  let currentParams = {};

  // ------------------------------------------------------------- dasar

  const esc = (v) =>
    String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Panggil proses utama. Melempar Error bila gagal supaya bisa di-try/catch. */
  async function call(name, payload) {
    const res = await window.api.call(name, payload);
    if (!res || !res.ok) throw new Error((res && res.error) || 'Terjadi kesalahan');
    return res.data;
  }

  /** Versi yang tidak melempar: menampilkan toast lalu mengembalikan null. */
  async function callSafe(name, payload, fallback = null) {
    try {
      return await call(name, payload);
    } catch (err) {
      toast(err.message, 'err');
      return fallback;
    }
  }

  function toast(message, type = 'ok', ms = 3800) {
    const wrap = $('#toasts');
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    wrap.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity .2s';
      setTimeout(() => node.remove(), 220);
    }, ms);
  }

  // ------------------------------------------------------------ format

  const pad = (n) => String(n).padStart(2, '0');

  const fmt = {
    duration(min) {
      const v = Math.max(0, Math.round(Number(min) || 0));
      if (!v) return '-';
      const h = Math.floor(v / 60);
      const m = v % 60;
      if (!h) return `${m}m`;
      return m ? `${h}j ${m}m` : `${h}j`;
    },
    minutes(min) {
      const v = Math.round(Number(min) || 0);
      return v > 0 ? `${v} m` : '-';
    },
    date(str) {
      if (!str) return '-';
      const [y, m, d] = String(str).slice(0, 10).split('-');
      return `${d}/${m}/${y}`;
    },
    dateLong(str) {
      if (!str) return '-';
      const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
        'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
      const [y, m, d] = String(str).slice(0, 10).split('-').map(Number);
      return `${pad(d)} ${months[m - 1]} ${y}`;
    },
    dateTime(str) {
      if (!str) return '-';
      return `${fmt.date(str)} ${String(str).slice(11, 19)}`;
    },
    time(str) {
      return str ? String(str).slice(11, 19) || str : '-';
    },
    monthLabel(month) {
      const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
        'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
      const [y, m] = String(month).split('-').map(Number);
      return `${months[m - 1]} ${y}`;
    },
    dayName(dateStr) {
      const names = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
      const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
      return names[new Date(y, m - 1, d).getDay()];
    },
    today() {
      const d = new Date();
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },
    currentMonth() {
      const d = new Date();
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    },
  };

  function badge(label, color) {
    return `<span class="badge" style="background:${esc(color || '#94a3b8')}">${esc(label)}</span>`;
  }

  // --------------------------------------------------------- kemajuan

  let progressHideTimer = null;

  /**
   * Tampilkan kemajuan pekerjaan panjang ke mesin absensi.
   * Dipanggil dari kejadian "progress" yang dipancarkan proses utama.
   */
  function showProgress({ judul, fase, current, total, label, done }) {
    const panel = $('#progressPanel');
    const fill = $('#progressFill');
    clearTimeout(progressHideTimer);

    panel.hidden = false;
    $('#progressTitle').textContent = judul || 'Memproses...';
    $('#progressPhase').textContent = fase || '';
    $('#progressLabel').textContent = label || '';

    const tahu = Number.isFinite(current) && Number.isFinite(total) && total > 0;
    $('#progressCount').textContent = tahu ? `${current} / ${total}` : '';

    fill.classList.toggle('indeterminate', !tahu && !done);
    fill.classList.toggle('error', /gagal/i.test(fase || ''));
    fill.classList.toggle('done', !!done && !/gagal/i.test(fase || ''));

    if (done) {
      fill.style.width = '100%';
      // Dibiarkan sejenak supaya hasil akhirnya sempat terbaca.
      progressHideTimer = setTimeout(() => {
        panel.hidden = true;
        fill.style.width = '0';
        fill.className = 'progress-fill';
      }, 1800);
    } else if (tahu) {
      fill.style.width = `${Math.min(100, Math.round((current / total) * 100))}%`;
    } else {
      fill.style.width = '';
    }
  }

  function hideProgress() {
    clearTimeout(progressHideTimer);
    $('#progressPanel').hidden = true;
  }

  // ------------------------------------------------------------- modal

  let modalResolve = null;

  function modal({ title, body, footer, wide = false, onOpen = null }) {
    // Hanya ada satu kotak modal; bila ada yang masih terbuka, tutup dulu
    // supaya promise-nya tidak menggantung selamanya.
    if (modalResolve) {
      const prev = modalResolve;
      modalResolve = null;
      prev(null);
    }
    const backdrop = $('#modalBackdrop');
    const box = $('#modal');
    box.className = `modal${wide ? ' wide' : ''}`;
    box.innerHTML = `
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button class="btn-ghost btn-icon" data-close aria-label="Tutup">✕</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    `;
    backdrop.hidden = false;
    $$('[data-close]', box).forEach((b) => b.addEventListener('click', () => closeModal(null)));
    if (onOpen) onOpen(box);
    const firstInput = box.querySelector('input:not([type=checkbox]), select, textarea');
    if (firstInput) setTimeout(() => firstInput.focus(), 40);
    return new Promise((resolve) => {
      modalResolve = resolve;
    });
  }

  function closeModal(value) {
    $('#modalBackdrop').hidden = true;
    $('#modal').innerHTML = '';
    if (modalResolve) {
      const r = modalResolve;
      modalResolve = null;
      r(value);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modalBackdrop').hidden) closeModal(null);
  });

  $('#modalBackdrop').addEventListener('mousedown', (e) => {
    if (e.target.id === 'modalBackdrop') closeModal(null);
  });

  function confirmBox(message, { title = 'Konfirmasi', okLabel = 'Ya, Lanjutkan', danger = true, detail = '' } = {}) {
    return modal({
      title,
      body: `<p style="margin:0 0 4px">${esc(message)}</p>${detail ? `<p class="muted small" style="margin:8px 0 0;white-space:pre-line;line-height:1.65">${esc(detail)}</p>` : ''}`,
      footer: `
        <button data-close>Batal</button>
        <button class="${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okLabel)}</button>
      `,
      onOpen: (box) => {
        $('[data-ok]', box).addEventListener('click', () => closeModal(true));
      },
    });
  }

  // -------------------------------------------------------------- form

  /**
   * Bangun HTML form dari spesifikasi field.
   * @param {Array<object>} fields {name,label,type,options,value,required,hint,attrs,span}
   */
  function formHtml(fields) {
    const one = (f) => {
      const id = `f_${f.name}`;
      const req = f.required ? ' required' : '';
      const attrs = f.attrs || '';
      const val = f.value === null || f.value === undefined ? '' : f.value;
      let control;

      switch (f.type) {
        case 'select':
          control = `<select id="${id}" name="${esc(f.name)}"${req} ${attrs}>${(f.options || [])
            .map(
              (o) =>
                `<option value="${esc(o.value)}"${String(o.value) === String(val) ? ' selected' : ''}>${esc(o.label)}</option>`
            )
            .join('')}</select>`;
          break;
        case 'textarea':
          control = `<textarea id="${id}" name="${esc(f.name)}"${req} ${attrs}>${esc(val)}</textarea>`;
          break;
        case 'checkbox':
          return `<div class="field"><label class="check"><input type="checkbox" id="${id}" name="${esc(f.name)}"${val ? ' checked' : ''} ${attrs}> ${esc(f.label)}</label>${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
        default:
          control = `<input type="${f.type || 'text'}" id="${id}" name="${esc(f.name)}" value="${esc(val)}"${req} ${attrs}>`;
      }
      return `<div class="field"><label for="${id}">${esc(f.label)}${f.required ? ' *' : ''}</label>${control}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
    };

    // Field bertanda `row` digabung berdampingan.
    let html = '';
    let i = 0;
    while (i < fields.length) {
      const f = fields[i];
      if (f.row) {
        const group = [];
        while (i < fields.length && fields[i].row === f.row) {
          group.push(fields[i]);
          i += 1;
        }
        html += `<div class="field-row${group.length === 3 ? ' cols-3' : ''}">${group.map(one).join('')}</div>`;
      } else {
        html += one(f);
        i += 1;
      }
    }
    return `<form id="modalForm" autocomplete="off">${html}</form>`;
  }

  /** Baca nilai form menjadi objek biasa. */
  function readForm(root) {
    const form = root.querySelector('#modalForm') || root;
    const out = {};
    $$('input, select, textarea', form).forEach((el) => {
      if (!el.name) return;
      if (el.type === 'checkbox') out[el.name] = el.checked ? 1 : 0;
      else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
      else out[el.name] = el.value === '' ? null : el.value;
    });
    return out;
  }

  /**
   * Dialog form standar: kembalikan objek nilai, atau null bila dibatalkan.
   */
  function formDialog({ title, fields, okLabel = 'Simpan', wide = false, validate = null }) {
    return modal({
      title,
      wide,
      body: formHtml(fields),
      footer: `<button data-close>Batal</button><button class="btn-primary" data-ok>${esc(okLabel)}</button>`,
      onOpen: (box) => {
        const submit = () => {
          const form = $('#modalForm', box);
          if (!form.reportValidity()) return;
          const values = readForm(box);
          if (validate) {
            const err = validate(values);
            if (err) {
              toast(err, 'err');
              return;
            }
          }
          closeModal(values);
        };
        $('[data-ok]', box).addEventListener('click', submit);
        $('#modalForm', box).addEventListener('submit', (e) => {
          e.preventDefault();
          submit();
        });
      },
    });
  }

  // -------------------------------------------------------------- tabel

  /**
   * Render tabel data.
   * `label` selalu di-escape; pakai `labelHtml` bila header memang perlu
   * berisi elemen (mis. kotak centang "pilih semua").
   * @param {Array<{key,label,labelHtml,className,render}>} columns
   */
  function table(columns, rows, { empty = 'Belum ada data', className = '' } = {}) {
    const head = columns
      .map((c) => `<th class="${c.className || ''}">${c.labelHtml || esc(c.label || '')}</th>`)
      .join('');
    const body = rows.length
      ? rows
          .map((row, i) => {
            const tds = columns
              .map((c) => {
                const content = c.render ? c.render(row, i) : esc(row[c.key]);
                return `<td class="${c.className || ''}">${content === null || content === undefined ? '' : content}</td>`;
              })
              .join('');
            return `<tr data-id="${esc(row.id != null ? row.id : '')}">${tds}</tr>`;
          })
          .join('')
      : `<tr><td class="empty" colspan="${columns.length}">${esc(empty)}</td></tr>`;
    return `<div class="table-wrap"><table class="data ${className}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function loading(text = 'Memuat data...') {
    return `<div class="loading"><div class="spinner"></div>${esc(text)}</div>`;
  }

  function emptyState(title, hint, icon = '◌') {
    return `<div class="empty-state"><div class="big">${icon}</div><h4>${esc(title)}</h4><p class="small">${esc(hint || '')}</p></div>`;
  }

  // ---------------------------------------------------------- navigasi

  function registerPage(name, def) {
    pages[name] = def;
  }

  /**
   * Catat kolom isian yang sedang diketik sebelum halaman dibangun ulang.
   *
   * Halaman dirender ulang dengan mengganti seluruh isi #content, sehingga
   * elemen yang sedang difokus ikut terbuang. Tanpa pemulihan ini, kotak
   * pencarian berhenti menerima ketikan setelah huruf pertama: begitu hasil
   * penyaringan dimuat ulang, fokus melompat dan huruf berikutnya hilang.
   */
  function captureFocus() {
    const el = document.activeElement;
    const content = $('#content');
    if (!el || !el.id || !content || !content.contains(el)) return null;
    const bisaCaret = typeof el.selectionStart === 'number';
    return {
      id: el.id,
      start: bisaCaret ? el.selectionStart : null,
      end: bisaCaret ? el.selectionEnd : null,
    };
  }

  function restoreFocus(snapshot) {
    if (!snapshot) return;
    const el = $('#content').querySelector(`#${CSS.escape(snapshot.id)}`);
    if (!el) return;
    el.focus();
    if (snapshot.start !== null && typeof el.setSelectionRange === 'function') {
      try {
        el.setSelectionRange(snapshot.start, snapshot.end);
      } catch {
        /* jenis input yang tidak mendukung caret */
      }
    }
  }

  async function go(name, params = {}) {
    const page = pages[name];
    if (!page) return;
    const fokus = name === currentPage ? captureFocus() : null;
    currentPage = name;
    currentParams = params;

    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
    $('#pageTitle').textContent = page.title || name;
    $('#pageSubtitle').textContent = page.subtitle || '';
    $('#topbarActions').innerHTML = '';
    $('#content').innerHTML = loading();

    try {
      await page.render($('#content'), params);
      restoreFocus(fokus);
    } catch (err) {
      $('#content').innerHTML = `<div class="card"><div class="card-body">
        <h4 style="margin:0 0 6px">Halaman gagal dimuat</h4>
        <p class="muted small" style="margin:0">${esc(err.message)}</p>
      </div></div>`;
    }
  }

  /** Muat ulang halaman aktif (dipakai setelah simpan / hapus). */
  function refresh() {
    if (currentPage) return go(currentPage, currentParams);
    return Promise.resolve();
  }

  function setSubtitle(text) {
    $('#pageSubtitle').textContent = text || '';
  }

  /** Isi tombol aksi di kanan atas. */
  function setActions(html, handlers = {}) {
    const bar = $('#topbarActions');
    bar.innerHTML = html;
    Object.entries(handlers).forEach(([sel, fn]) => {
      const el = bar.querySelector(sel);
      if (el) el.addEventListener('click', fn);
    });
  }

  // Pendengar klik terakhir per elemen, supaya bisa dicabut sebelum dipasang lagi.
  const actionHandlers = new WeakMap();

  /**
   * Pasang handler klik untuk tombol bertanda data-act di dalam container.
   *
   * Pendengar lama pada elemen yang sama WAJIB dicabut lebih dulu. Elemen
   * #content tidak pernah diganti saat pindah halaman — hanya isinya — sehingga
   * pendengar dari halaman sebelumnya akan ikut menangani klik di halaman baru.
   * Karena banyak halaman memakai nama aksi yang sama ("edit", "del"), satu klik
   * bisa menjalankan perintah milik halaman yang salah.
   */
  function bindActions(root, map) {
    const previous = actionHandlers.get(root);
    if (previous) root.removeEventListener('click', previous);

    const handler = (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || !root.contains(btn)) return;
      const fn = map[btn.dataset.act];
      if (fn) {
        e.preventDefault();
        fn(btn.dataset, btn);
      }
    };
    actionHandlers.set(root, handler);
    root.addEventListener('click', handler);
  }

  /** Tombol dengan status "sedang berjalan" agar tidak diklik dua kali. */
  async function busy(btn, fn, label = 'Memproses...') {
    if (!btn) return fn();
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = esc(label);
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  return {
    esc, $, $$, call, callSafe, toast, fmt, badge,
    showProgress, hideProgress,
    modal, closeModal, confirm: confirmBox,
    formHtml, readForm, formDialog,
    table, loading, emptyState,
    registerPage, go, refresh, setSubtitle, setActions, bindActions, busy,
    get params() { return currentParams; },
    get page() { return currentPage; },
  };
})();
