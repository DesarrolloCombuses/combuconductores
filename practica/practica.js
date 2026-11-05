/* ==========================================================================
   Práctica del Portal del Conductor - Combuses (v1.25.0)

   El día de trabajo del conductor, paso a paso, con un celular de mentira para
   practicar con los mismos botones del portal. TODO es de mentira: no hay
   Supabase, no hay cámara ni GPS de verdad, no se marca, no se guarda y no se
   manda nada. Lo único que se guarda es en ESTE celular (localStorage) qué
   pasos ya practicó, para mostrarle su avance.

   Los datos de práctica no son de nadie: el conductor 20020002 ("Conductor de
   práctica"), el bus 799 y la persona del personal 10000001. Si cambian los
   textos o las reglas del portal (js/portal.js), cambiarlos también aquí.
   ========================================================================== */
(function () {
  "use strict";

  const app = document.getElementById("app");
  const CLAVE = "portal_practica_v1";
  const BUS = "799";
  const CEDULA = "20020002";
  const NOMBRE = "Conductor de práctica";
  const PERSONA_CED = "10000001";
  const PERSONA = "Persona de práctica";
  const CUPO = 19;

  // ---------------------------------------------------------------- avance (solo en este celular)
  function leerAvance() {
    try { return JSON.parse(localStorage.getItem(CLAVE)) || {}; } catch (_) { return {}; }
  }
  const avance = leerAvance();
  avance.hechos = Array.isArray(avance.hechos) ? avance.hechos : [];
  function guardarAvance() {
    try { localStorage.setItem(CLAVE, JSON.stringify(avance)); } catch (_) { /* sin almacenamiento: no pasa nada */ }
  }
  function marcarHecho(id) {
    if (avance.hechos.indexOf(id) < 0) { avance.hechos.push(id); guardarAvance(); }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function digitos(v) { return String(v || "").replace(/\D/g, ""); }
  function num(v) { const d = digitos(v); return d === "" ? null : Number(d); }

  // ---------------------------------------------------------------- iconos
  const I = {
    flecha: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    abajo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    mano: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11V5a2 2 0 1 1 4 0v6"/><path d="M13 10.5V9a2 2 0 1 1 4 0v3"/><path d="M17 11a2 2 0 1 1 4 0v3a7 7 0 0 1-7 7h-1.5a7 7 0 0 1-5.6-2.8L4 15.5a2 2 0 0 1 3-2.6L9 15"/></svg>',
    bien: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>',
    mal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 17h.01"/></svg>',
    lista: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    cel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>',
    ojo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
    escudo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>',
    qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v.01M14 21h3M21 17v4"/></svg>',
    alerta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
    lapiz: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4Z"/></svg>',
  };

  // La barra de abajo del portal (mismos dibujos de index.html)
  const NAV = [
    ["inicio", "Inicio", '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22V12h6v10"/>'],
    ["tarjeta", "Mi tarjeta", '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'],
    ["asistencia", "Asistencia", '<path d="M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
    ["alistar", "Alistar", '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="m9 13 2 2 4-4"/>'],
    ["aeropuerto", "Aeropuerto", '<path d="M17.8 19.8 16 14l-4 1-4-1-1.8 5.8"/><path d="M22 12c0-1.1-.9-2-2-2h-3l-4-7h-2l1.5 7H8L6 8H4l1 4-1 4h2l2-2h4.5L11 21h2l4-7h3c1.1 0 2-.9 2-2Z"/>'],
    ["tiquetes", "Tiquetes", '<path d="M3 9a3 3 0 0 0 0 6v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3a3 3 0 0 0 0-6V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2-2Z"/><path d="M13 5v2M13 11v2M13 17v2"/>'],
    ["perfil", "Perfil", '<path d="M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
  ];

  // ---------------------------------------------------------------- dibujos dentro del celular
  function caraSvg() {
    return '<svg viewBox="0 0 200 260" aria-hidden="true">' +
      '<ellipse cx="100" cy="110" rx="62" ry="80" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="8 7"/>' +
      '<circle cx="100" cy="100" r="42" fill="#8a9a8f"/><path d="M30 260c4-50 34-74 70-74s66 24 70 74Z" fill="#8a9a8f"/>' +
      '<circle cx="86" cy="96" r="4" fill="#3d4a3f"/><circle cx="114" cy="96" r="4" fill="#3d4a3f"/>' +
      '<path d="M88 118q12 9 24 0" stroke="#3d4a3f" stroke-width="3" fill="none" stroke-linecap="round"/></svg>';
  }
  function personaSvg() {
    return '<svg viewBox="0 0 200 260" aria-hidden="true">' +
      '<rect x="0" y="170" width="200" height="90" fill="#33423a"/>' +
      '<rect x="20" y="150" width="60" height="70" rx="8" fill="#4b5d52"/><rect x="120" y="150" width="60" height="70" rx="8" fill="#4b5d52"/>' +
      '<circle cx="100" cy="92" r="30" fill="#9fb0a5"/><path d="M50 230c3-50 24-92 50-92s47 42 50 92Z" fill="#9fb0a5"/></svg>';
  }
  // Un código de mentira que se ve como un QR (no se puede leer: no lleva datos)
  function qrSvg(semilla) {
    const n = 25, t = 8;
    let x = (semilla * 9301 + 49297) % 233280;
    const rnd = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
    const enEsquina = (i, j) => (i < 8 && j < 8) || (i < 8 && j >= n - 8) || (i >= n - 8 && j < 8);
    let r = "";
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (!enEsquina(i, j) && rnd() > 0.52) r += '<rect x="' + j * t + '" y="' + i * t + '" width="' + t + '" height="' + t + '"/>';
      }
    }
    const ojo = (cx, cy) => '<rect x="' + cx + '" y="' + cy + '" width="56" height="56" fill="none" stroke="#12190f" stroke-width="8"/>' +
      '<rect x="' + (cx + 16) + '" y="' + (cy + 16) + '" width="24" height="24"/>';
    return '<svg viewBox="-8 -8 216 216" aria-label="Código del bus (de práctica)"><rect x="-8" y="-8" width="216" height="216" fill="#fff"/>' +
      '<g fill="#12190f">' + r + ojo(4, 4) + ojo(4 + (n - 8) * t, 4) + ojo(4, 4 + (n - 8) * t) + "</g></svg>";
  }

  // ---------------------------------------------------------------- el celular de práctica
  // def = { inicio, datos(), hora, estados: { nombre: { tab, titulo, html(s), hoja(s), pista(s), on: {accion(s, valor)}, vivo, alPintar, fin } } }
  // Un botón con data-a="accion" (y data-v="valor") llama on[accion]; si devuelve el nombre de otro estado, pasa a ese.
  let simActual = null;

  function crearSim(cont, def, alTerminar) {
    const s = { estado: def.inicio, d: def.datos ? def.datos() : {}, error: "", terminado: false, timers: [] };

    function parar() { s.timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); s.timers = []; }

    function ir(nombre) { s.estado = nombre; pintar(); }

    function nav(activa, toca) {
      return '<nav class="cel-nav" aria-label="Pestañas del portal (de práctica)">' + NAV.map((n) =>
        '<div role="button" tabindex="0" data-a="tab:' + n[0] + '" class="' + (n[0] === activa ? "activa" : "") + (n[0] === toca ? " toca" : "") + '">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true">' + n[2] + "</svg><span>" + n[1] + "</span></div>").join("") + "</nav>";
    }

    function pintar() {
      parar();
      const e = def.estados[s.estado];
      const fin = typeof e.fin === "function" ? e.fin(s) : !!e.fin;
      const pista = s.error || (typeof e.pista === "function" ? e.pista(s) : e.pista) || "";
      const clasePista = s.error ? "mal" : fin ? "bien" : "";
      cont.innerHTML =
        '<div class="cel">' +
          '<div class="cel-pantalla">' +
            '<div class="cel-estado"><span>' + (e.hora || def.hora || "5:00") + '</span><span class="marca">PRÁCTICA</span><span>●●● 4G</span></div>' +
            (e.tab === null ? "" :
              '<div class="cel-top"><img src="../assets/logo-combuses.webp" alt=""><span class="titulo">' + esc(e.titulo || "Portal del Conductor") +
              '</span><span class="linea">● En línea</span></div>') +
            '<div class="cel-cuerpo">' + e.html(s) + "</div>" +
            (e.tab === null ? "" : nav(e.tab, e.tocaTab)) +
            (e.hoja ? '<div class="c-hoja-fondo"><div class="c-hoja" role="dialog">' + e.hoja(s) + "</div></div>" : "") +
          "</div>" +
        "</div>" +
        '<div class="pista ' + clasePista + '" role="status">' + (s.error ? I.mal : fin ? I.bien : I.mano) + "<div>" + pista + "</div></div>";
      if (e.vivo) e.vivo(s, cont);
      if (e.alPintar) e.alPintar(s, cont, ir);
      if (fin && !s.terminado) { s.terminado = true; if (alTerminar) alTerminar(); }
    }

    function accion(b) {
      const e = def.estados[s.estado];
      const f = e.on && e.on[b.dataset.a];
      if (!f || b.disabled) return;
      s.error = "";
      const sig = f(s, b.dataset.v);
      if (typeof sig === "string") s.estado = sig;
      pintar();
      const zona = cont.querySelector(".cel");
      if (zona && zona.getBoundingClientRect().top < 0) zona.scrollIntoView({ block: "start", behavior: "smooth" });
    }

    cont.onclick = (ev) => {
      const b = ev.target.closest("[data-a]");
      if (b && cont.contains(b)) accion(b);
    };
    cont.onkeydown = (ev) => {
      const b = ev.target.closest('[role="button"][data-a]');
      if (b && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); accion(b); }
    };
    cont.oninput = (ev) => {
      const c = ev.target.closest("[data-campo]");
      if (!c) return;
      s.d[c.dataset.campo] = c.value;
      const e = def.estados[s.estado];
      if (e.vivo) e.vivo(s, cont);
    };
    cont.onsubmit = (ev) => ev.preventDefault();

    s.reiniciar = () => { s.estado = def.inicio; s.d = def.datos ? def.datos() : {}; s.error = ""; s.terminado = false; pintar(); };
    s.parar = parar;
    pintar();
    return s;
  }

  // ---------------------------------------------------------------- piezas que se repiten
  function btn(accion, texto, o) {
    o = o || {};
    return '<button type="button" class="c-btn' + (o.prim ? " prim" : "") + (o.peligro ? " peligro" : "") + (o.toca ? " toca" : "") + '"' +
      ' data-a="' + accion + '"' + (o.v != null ? ' data-v="' + esc(o.v) + '"' : "") + (o.off ? " disabled" : "") + ">" +
      (o.icono || "") + texto + "</button>";
  }
  function practicaCaja(titulo, contenido) {
    return '<div class="c-card" style="border:2px dashed #b9c8b2;background:#fbfcfa"><span class="c-etq">Para practicar · ' + titulo + "</span>" +
      '<div class="c-botones" style="margin-top:8px">' + contenido + "</div></div>";
  }

  // Inicio del portal: Mi turno de hoy y las tarjetas que se pidan
  function inicioHtml(o) {
    o = o || {};
    const estado = o.estado || "Próximo";
    const chip = estado === "Cumplido" || estado === "Iniciado" ? "" : " gris";
    let h = '<div class="c-card"><div class="c-fila"><span class="c-etq">Mi turno de hoy</span><span class="c-chip' + chip + '">' + estado + "</span></div>" +
      '<div class="c-grande">Bus ' + BUS + " · Turno 1</div>" +
      '<div class="sub">5:00 a. m. a 1:00 p. m. · Base Almacentro · Entregas el bus al turno 2</div>' +
      (o.boton ? '<div style="margin-top:10px">' + btn(o.boton.a, o.boton.t, { prim: true, toca: o.boton.toca }) + "</div>" : "") +
      "</div>";
    if (o.alistamiento === "falta") {
      h += '<div class="c-aviso mal"><b>Alistamiento: falta hoy</b>Bus ' + BUS + ". Hazlo en la pestaña Alistar antes de salir.</div>";
    } else if (o.alistamiento === "hecho") {
      h += '<div class="c-aviso bien"><b>Alistamiento hecho ✓</b>Bus ' + BUS + " · 5:10 a. m.</div>";
    }
    if (o.fila) {
      h += '<div class="c-card"><span class="c-etq">Mi fila en el aeropuerto</span><div class="c-grande">' + o.fila + '</div><div class="sub">Llegaste a las 9:41 a. m.</div></div>';
    }
    if (o.jornada) {
      h += '<div class="c-card"><span class="c-etq">Mi jornada de hoy</span>' + o.jornada.map((j) =>
        '<div class="c-dato"><span>' + j[0] + "</span><b>" + j[1] + "</b></div>").join("") + "</div>";
    }
    return h;
  }

  // Marcar ENTRADA o SALIDA: lo mismo en el paso 2 y en el 8.
  function estadosDeMarca(o) {
    const S = o.sentido;                // "ENTRADA" o "SALIDA"
    const sl = S === "ENTRADA" ? "entrada" : "salida";
    const lugarDe = (s) => s.d.lugar === "almacentro" ? "Almacentro" : s.d.lugar === "norte" ? "Terminal Norte" : "Nutibara";
    const esUsted = (s, toca) =>
      '<div class="c-aviso bien"><b>Estás en ' + lugarDe(s) + "</b>Puedes marcar aquí.</div>" +
      '<div class="c-card"><span class="c-etq">¿Eres tú?</span><div class="c-grande">' + NOMBRE + "</div>" +
      '<div class="sub">Cédula ' + CEDULA + ' · Vas a marcar <span class="c-chip">' + S + "</span></div>" +
      '<div class="c-botones" style="margin-top:10px">' + btn("sisoy", "Sí, soy yo · registrar mi " + S, { prim: true, toca: toca }) +
      '<button type="button" class="c-link" data-a="nosoy">No soy yo</button></div></div>';
    const est = {};
    est[o.pre + "ubic"] = {
      tab: "asistencia", titulo: "Asistencia", hora: o.hora,
      html: (s) => {
        if (s.d.lugar === "aeropuerto") {
          return '<div class="c-aviso mal"><b>Aquí no se puede marcar</b>Estás lejos de los lugares autorizados: Almacentro, Nutibara y Terminal Norte.</div>' +
            (s.d.mapa ? '<div class="c-card"><span class="c-etq">Lugares para marcar</span><div class="c-dato"><span>Almacentro</span><b>con la bahía del CC San Diego</b></div>' +
              '<div class="c-dato"><span>Nutibara</span><b>la bahía</b></div><div class="c-dato"><span>Terminal Norte</span><b>su bahía</b></div></div>' : "") +
            '<div class="c-botones">' + btn("mapa", "Ver en el mapa") + btn("revisar", "Ya llegué: revisar otra vez", { toca: true }) +
            btn("x", "Acércate a un lugar autorizado para seguir", { prim: true, off: true }) + "</div>";
        }
        if (s.d.lugar === "gps") {
          return '<div class="c-aviso ambar"><b>Prende el GPS del celular</b>Te estamos ubicando por wifi o antena. Prende la ubicación en modo preciso y sal a cielo abierto.</div>' +
            '<div class="c-botones">' + btn("revisar", "Ya llegué: revisar otra vez", { toca: true }) +
            btn("x", "Prende el GPS para seguir", { prim: true, off: true }) + "</div>";
        }
        return esUsted(s, true);
      },
      pista: (s) => s.d.lugar === "aeropuerto"
        ? "En el aeropuerto <b>no deja marcar</b>. Toca <b>Ya llegué: revisar otra vez</b> y escoge un lugar autorizado."
        : s.d.lugar === "gps"
          ? "Sin GPS no deja marcar. Toca <b>Ya llegué: revisar otra vez</b> y escoge otra vez dónde estás."
          : "Estás en un lugar autorizado. Revisa que sea <b>tu nombre</b> y toca <b>Sí, soy yo · registrar mi " + S + "</b>.",
      on: {
        mapa: (s) => { s.d.mapa = true; },
        revisar: () => o.pre + "donde",
        sisoy: () => o.pre + "tipo",
        nosoy: (s) => { s.error = "Si el nombre no es el tuyo, <b>no sigas</b>. En Perfil toca <b>Cambiar de conductor</b> y escribe bien tu cédula. Aquí sí eres tú: toca <b>Sí, soy yo</b>."; },
      },
    };
    est[o.pre + "tipo"] = {
      tab: "asistencia", titulo: "Asistencia", hora: o.hora,
      html: (s) => esUsted(s, false),
      hoja: () => "<h3>Vas a registrar tu " + S + ". ¿Es correcto?</h3>" +
        '<div class="c-botones">' + btn("si", "Sí, es mi " + S, { prim: true, toca: true }) + btn("no", "No, revisar") + "</div>",
      pista: "El portal pregunta qué vas a marcar. Es tu " + sl + ": toca <b>Sí, es mi " + S + "</b>.",
      on: {
        si: () => o.pre + "foto",
        no: (s) => { s.error = "Si el portal propone el tipo equivocado, tocas <b>No, revisar</b>, escoges Entrada o Salida y sigues: la marca queda con una nota para que la revisen. Aquí sí es " + sl + "."; },
      },
    };
    est[o.pre + "foto"] = {
      tab: "asistencia", titulo: "Asistencia", hora: o.hora,
      html: (s) => '<div class="c-camara' + (s.d.disparo ? " disparo" : "") + '">' + caraSvg() + '<div class="flash"></div></div>' +
        '<p class="c-ayuda" style="text-align:center;margin:0">Pon la cara dentro del óvalo, de frente y con buena luz.</p>' +
        btn("capturar", "Capturar rostro", { prim: true, toca: true }),
      pista: "Se abre la cámara del frente. En la práctica no se toma ninguna foto de verdad. Toca <b>Capturar rostro</b>.",
      on: { capturar: () => o.pre + "registrar" },
    };
    est[o.pre + "registrar"] = {
      tab: "asistencia", titulo: "Asistencia", hora: o.hora,
      html: (s) => '<div class="c-aviso bien"><b>Foto lista ✓</b>Queda como prueba de tu marca.</div>' +
        '<label class="c-campo">Celular para comprobante <span class="c-ayuda">10 números, empieza por 3. Es opcional.</span>' +
        '<input data-campo="cel" inputmode="numeric" maxlength="10" placeholder="Ej. 3001234567" value="' + esc(s.d.cel || "") + '"></label>' +
        btn("registrar", "Registrar asistencia", { prim: true, toca: true }),
      pista: "Si quieres el comprobante por WhatsApp, escribe tu celular. Luego toca <b>Registrar asistencia</b>.",
      on: {
        registrar: (s) => {
          const c = digitos(s.d.cel);
          if (c && (c.length !== 10 || c[0] !== "3")) { s.error = "El celular debe tener 10 números y empezar por 3. Corrígelo o bórralo."; return; }
          return c ? o.pre + "listo" : o.pre + "sincel";
        },
      },
    };
    est[o.pre + "sincel"] = {
      tab: "asistencia", titulo: "Asistencia", hora: o.hora,
      html: () => '<div class="c-aviso bien"><b>Foto lista ✓</b>Queda como prueba de tu marca.</div>',
      hoja: () => "<h3>¿Registrar sin comprobante?</h3><p class=\"c-ayuda\" style=\"margin:0\">Si escribes tu celular, te llega el comprobante por WhatsApp.</p>" +
        '<div class="c-botones">' + btn("sin", "Registrar sin comprobante", { prim: true, toca: true }) + btn("agregar", "Agregar número") + "</div>",
      pista: "No escribiste celular. Puedes seguir sin comprobante: toca <b>Registrar sin comprobante</b>.",
      on: { sin: () => o.pre + "listo", agregar: () => o.pre + "registrar" },
    };
    est[o.pre + "listo"] = {
      tab: "asistencia", titulo: "Asistencia", hora: o.hora,
      html: (s) => '<div class="c-aviso bien" style="padding:16px"><b style="font-size:18px">Asistencia registrada</b>' + S + " · " + o.hora + " · " + lugarDe(s) +
        '<br>Ya quedó y se mandó a Buk. <b style="display:inline;font-size:inherit">No la repitas.</b></div>' + btn("entendido", "Entendido", { prim: true, toca: true }),
      pista: "¡Quedó! Cuando sale <b>Asistencia registrada</b>, ya está: no hay que marcar otra vez. Toca <b>Entendido</b>.",
      on: { entendido: () => o.final },
    };
    return est;
  }

  // ---------------------------------------------------------------- la cuenta del viaje (igual que js/portal.js)
  function repartir(pas, personal, tiq, civ) {
    const per = Math.min(personal || 0, pas);
    const r = { pasajeros: pas, personal: per, cobran: pas - per, tiquetes: null, civicas: null, efectivo: null, sobran: 0, tiqEscritos: tiq, civLeidas: civ };
    if (tiq == null) return r;
    r.tiquetes = Math.min(tiq, r.cobran);
    r.sobran = Math.max(0, tiq + (civ || 0) - r.cobran);
    if (civ != null) { r.civicas = Math.min(civ, r.cobran - r.tiquetes); r.efectivo = r.cobran - r.tiquetes - r.civicas; }
    return r;
  }
  function enCivicas(n) { return n === 1 ? "1 cívica" : n + " cívicas"; }
  function textoSobran(r) {
    const partes = [r.tiqEscritos + (r.tiqEscritos === 1 ? " tiquete" : " tiquetes")];
    if (r.civLeidas != null) partes.push(enCivicas(r.civLeidas));
    if (r.personal) partes.push(r.personal + " del personal");
    const lista = partes.length < 2 ? partes[0] : partes.slice(0, -1).join(", ") + " y " + partes[partes.length - 1];
    return lista + " son más que los " + r.pasajeros + " pasajeros";
  }
  function textoCuenta(r) {
    const p = [r.tiquetes + " con tiquete", r.civicas + " con cívica", r.efectivo + " en efectivo"];
    if (r.personal) p.push(r.personal + " del personal (no se cobra)");
    return r.pasajeros + " pasajeros = " + p.join(" + ") + ".";
  }
  // { mal: no deja guardar, aviso: solo avisa, linea: la cuenta }
  function cuentaViaje(lectura, pas, tiq, personal, lecturaAnterior) {
    let civ = null;
    if (lectura != null && lectura >= lecturaAnterior) civ = lectura - lecturaAnterior;
    const out = { mal: "", avisos: [], linea: "", civ: civ };
    if (lectura != null && lectura < lecturaAnterior) {
      out.avisos.push("La cívica es menor que la del viaje anterior (" + lecturaAnterior + "). Si cambiaron el validador, repórtalo como daño.");
    }
    if (pas != null && pas > CUPO) { out.mal = "Máximo " + CUPO + " pasajeros: es el cupo del bus."; return out; }
    if (pas == null && tiq != null && tiq > CUPO) { out.mal = "Máximo " + CUPO + " tiquetes: es el cupo del bus."; return out; }
    if (pas == null || tiq == null) return out;
    const propios = repartir(pas, personal, tiq, null);
    const r = repartir(pas, personal, tiq, civ);
    if (propios.sobran) out.mal = "No cuadra: " + textoSobran(propios) + ". Revisa los números.";
    else if (r.sobran) out.avisos.push("Con esta lectura salen " + enCivicas(civ) + " y no cuadra: " + textoSobran(r) + ". Revisa el número del validador.");
    else if (civ != null) { out.linea = textoCuenta(r); out.r = r; }
    return out;
  }
  function cuentaHtml(c) {
    return (c.mal ? '<div class="c-cuenta mal">' + esc(c.mal) + "</div>" : "") +
      c.avisos.map((a) => '<div class="c-cuenta aviso">' + esc(a) + "</div>").join("") +
      (c.linea ? '<div class="c-cuenta">' + esc(c.linea) + "</div>" : "");
  }

  // Viaje 1 ya lleno, para que el viaje 2 tenga su "lectura anterior"
  const LECTURA_ANT = 2773;
  function viaje1Html() {
    return '<div class="c-viaje" style="opacity:.75"><div class="cab"><b>Viaje 1 · 5:20 a. m.</b><span class="c-chip">Completo ✓</span></div>' +
      '<div class="ruta">Almacentro → Aeropuerto · Cívica ' + LECTURA_ANT + "</div></div>";
  }
  function cabViaje2(extra) {
    return '<div class="cab"><b>Viaje 2 · 6:40 a. m.</b>' + (extra || "") + '</div><div class="ruta">Almacentro → Aeropuerto</div>';
  }
  function guardadoHtml(g, o) {
    o = o || {};
    const c = cuentaViaje(g.lectura, g.pas, g.tiq, 1, LECTURA_ANT);
    const r = c.r || repartir(g.pas, 1, g.tiq, c.civ);
    return '<div class="c-viaje">' + cabViaje2() +
      '<div class="c-dato"><span>Cívica <b>' + g.lectura + "</b></span><span>" + (c.civ != null ? enCivicas(c.civ) : "—") + "</span></div>" +
      '<div class="c-dato"><span>Pasajeros que llevaste <b>' + (o.pasViejo != null ? '<span class="tachado">' + o.pasViejo + "</span> " : "") + g.pas + "</b></span>" +
        (o.corregido ? '<span class="c-chip">Corregidos por ti</span>' : "") + "</div>" +
      '<div class="c-dato"><span>Personal de la empresa <b>1</b></span><span class="c-chip">No se cobra</span></div>' +
      '<div class="c-dato"><span>Tiquetes escaneados <b>' + g.tiq + "</b></span></div>" +
      (r.civicas != null ? '<div class="c-dato"><span>Con cívica <b>' + r.civicas + '</b></span></div><div class="c-dato"><span>En efectivo <b>' + r.efectivo + "</b></span></div>" : "") +
      (o.novedad ? '<div class="c-dato"><span>Novedad N° 1001 · Trasbordo</span><span class="c-chip">Enviada</span></div>' : "") +
      '<div class="c-botones dos">' + (o.botones || "") + "</div></div>";
  }

  // ==================================================================== LOS PASOS DEL DÍA
  const PASOS = [
    // ------------------------------------------------------------ 1
    {
      id: "entrar", cuando: "Antes de salir", titulo: "Alista el celular y entra al portal",
      corto: "Internet, GPS y cámara listos. Entras, escribes tu cédula y confirmas tu turno.",
      intro: "Esto se hace una vez al empezar el día, antes de llegar a la base.",
      pasos: [
        "Prende los <b>datos o el wifi</b> y la <b>ubicación en modo preciso (GPS)</b>. Cuando el portal pida la <b>cámara</b>, toca <b>Permitir</b>.",
        "Abre el portal en <b>Chrome</b> (Android) o <b>Safari</b> (iPhone). Desde WhatsApp o Facebook no sirve.",
        "Escribe el <b>Usuario</b> y la <b>Contraseña</b> que te dio Combuses y toca <b>Entrar</b>. La próxima vez entra solo.",
        "Escribe <b>tu cédula</b> (solo números) y toca <b>Buscar mi programación</b>.",
        "Revisa que el <b>nombre sea el tuyo</b> y toca tu turno: <b>Confirmar y continuar</b>.",
      ],
      ojo: [
        "Si no tienes turno programado hoy, el portal te pide el <b>número del bus</b> que vas a manejar.",
        "Si el nombre no es el tuyo, toca <b>No soy yo</b>.",
        "El ícono de la <b>puerta con flecha</b>, arriba a la derecha, cierra la sesión sin preguntar. No lo toques.",
        "Para cambiar de bus o si otro conductor usa tu celular: <b>Perfil → Cambiar de conductor</b>.",
      ],
      sims: [{
        nombre: "Entrar", escena: "Vas a entrar con los datos de práctica: la cédula <b>" + CEDULA + "</b> y el bus <b>" + BUS + "</b>.",
        def: () => ({
          inicio: "celular", hora: "4:30", datos: () => ({}),
          estados: {
            celular: {
              tab: null,
              html: (s) => {
                const items = [["internet", "Internet", "Datos móviles o wifi"], ["gps", "Ubicación precisa", "GPS prendido, en modo preciso"],
                  ["camara", "Cámara", "Permitir cuando el portal la pida"], ["navegador", "Chrome o Safari", "No dentro de WhatsApp o Facebook"]];
                const primero = items.find((x) => !s.d[x[0]]);
                return '<div class="c-card"><h3>Tu celular, antes de abrir el portal</h3><div class="sub">Toca cada cosa cuando la tengas lista.</div></div>' +
                  items.map((x) => '<button type="button" class="c-check' + (primero && primero[0] === x[0] ? " toca" : "") + '" data-a="chk" data-v="' + x[0] + '" aria-pressed="' + !!s.d[x[0]] + '">' +
                    '<span class="caja-check">' + (s.d[x[0]] ? "✓" : "") + "</span><span>" + x[1] + '<br><span class="c-ayuda">' + x[2] + "</span></span></button>").join("") +
                  btn("abrir", "Abrir el portal", { prim: true, off: !!primero, toca: !primero });
              },
              pista: (s) => ["internet", "gps", "camara", "navegador"].every((k) => s.d[k])
                ? "Todo listo. Toca <b>Abrir el portal</b>." : "Toca cada cosa para revisarla en tu celular.",
              on: { chk: (s, v) => { s.d[v] = !s.d[v]; }, abrir: () => "login" },
            },
            login: {
              tab: null,
              html: () => '<div class="c-login"><img src="../assets/logo-combuses.webp" alt="Combuses"><h3>Portal del Conductor</h3>' +
                '<div class="sub">Ingresa con tu usuario Combuses</div>' +
                '<label class="c-campo">Usuario<input value="practica@combuses.com.co" readonly></label>' +
                '<label class="c-campo">Contraseña<input type="password" value="practica" readonly></label>' +
                btn("entrar", "Entrar", { prim: true, toca: true }) + "</div>",
              pista: "En la práctica el usuario y la contraseña ya están puestos. Toca <b>Entrar</b>.",
              on: { entrar: () => "cedula" },
            },
            cedula: {
              tab: null,
              html: (s) => '<div class="c-card"><h3>¿Quién maneja hoy?</h3><label class="c-campo">Tu cédula, solo números' +
                '<input data-campo="ced" inputmode="numeric" maxlength="12" placeholder="Escribe tu cédula" value="' + esc(s.d.ced || "") + '"></label></div>' +
                (s.d.errCed ? '<div class="c-aviso mal">No encontramos esa cédula en la nómina ni en la programación.</div>' : "") +
                btn("buscar", "Buscar mi programación", { prim: true, toca: true }),
              pista: "Escribe la cédula de práctica <b>" + CEDULA + "</b> y toca <b>Buscar mi programación</b>.",
              on: {
                buscar: (s) => {
                  if (digitos(s.d.ced) !== CEDULA) {
                    s.d.errCed = true;
                    s.error = "Con otra cédula sale ese mensaje. En el portal de verdad escribes la tuya; aquí, para practicar, usa <b>" + CEDULA + "</b>.";
                    return;
                  }
                  s.d.errCed = false;
                  return "turno";
                },
              },
            },
            turno: {
              tab: null,
              html: () => '<div class="c-card"><span class="c-etq">Hola</span><div class="c-grande">' + NOMBRE + '</div><div class="sub">Cédula ' + CEDULA + "</div>" +
                '<button type="button" class="c-link" data-a="nosoy">‹ No soy yo</button></div>' +
                '<div class="c-card"><span class="c-etq">Tu programación de hoy</span><div class="c-grande">Turno 1 · Bus ' + BUS + "</div>" +
                '<div class="sub">5:00 a. m. a 1:00 p. m. · Base Almacentro<br>Entregas el bus al turno 2</div>' +
                '<div style="margin-top:10px">' + btn("confirmar", "Confirmar y continuar ›", { prim: true, toca: true }) + "</div></div>",
              pista: "Revisa que el nombre sea el tuyo y toca tu turno: <b>Confirmar y continuar</b>.",
              on: {
                nosoy: (s) => { s.error = "Si el nombre no es el tuyo, tocas <b>No soy yo</b> y escribes bien tu cédula. Aquí sí es: toca <b>Confirmar y continuar</b>."; },
                confirmar: () => "inicio",
              },
            },
            inicio: {
              tab: "inicio", titulo: "Inicio",
              html: () => inicioHtml({ estado: "Próximo", boton: { a: "x", t: "Marcar ingreso" } }),
              pista: "¡Listo, ya entraste! Abajo están las pestañas del portal. Mañana el portal entra solo y te pide la cédula otra vez.",
              fin: true,
            },
          },
        }),
      }],
    },
    // ------------------------------------------------------------ 2
    {
      id: "entrada", cuando: "Llegas al punto", titulo: "Marca tu ENTRADA",
      corto: "Solo en Almacentro, Nutibara o Terminal Norte, con el GPS prendido y una foto.",
      intro: "Desde el 26 de octubre la entrada y la salida se marcan <b>solo en el portal</b>. Ya no se marca en el biométrico.",
      extra: '<div class="lugares"><div class="lugar"><b>Almacentro</b><span>con la bahía del CC San Diego</span></div>' +
        '<div class="lugar"><b>Nutibara</b><span>la bahía</span></div><div class="lugar"><b>Terminal Norte</b><span>su bahía</span></div></div>' +
        '<p class="no-lugar">En el aeropuerto, Exposiciones o la oficina no deja marcar.</p>',
      pasos: [
        "Llega a uno de los tres lugares. En <b>Inicio</b> toca <b>Marcar ingreso</b> (o la pestaña <b>Asistencia</b>).",
        "Mira el aviso: <b>Estás en … · Puedes marcar aquí</b>.",
        "Revisa tu nombre y toca <b>Sí, soy yo · registrar mi ENTRADA</b>. Luego <b>Sí, es mi ENTRADA</b>.",
        "Pon la cara dentro del óvalo, con buena luz, y toca <b>Capturar rostro</b>.",
        "Toca <b>Registrar asistencia</b>. Cuando sale <b>Asistencia registrada</b>, ya quedó: <b>no la repitas</b>.",
      ],
      ojo: [
        "Si te pregunta <b>¿Por qué no coincide con el horario?</b>, escoge el motivo (por ejemplo <b>Relevo llegó tarde</b>) y escribe el detalle.",
        "Si dice <b>Falta cerrar un turno</b>, es que otro día no marcaste la salida: escribe a qué hora terminaste.",
        "Si sale <b>Marca guardada (pendiente de Buk)</b>, también quedó. No la repitas.",
      ],
      sims: [{
        nombre: "Entrada", escena: "Son las 5:00 a. m. y llegaste a la base para tu turno en el bus " + BUS + ". Prueba también qué pasa si estás en el aeropuerto o sin GPS.",
        def: () => ({
          inicio: "inicio", hora: "5:00", datos: () => ({}),
          estados: {
            inicio: {
              tab: "inicio", titulo: "Inicio", tocaTab: "",
              html: () => inicioHtml({ estado: "En curso", boton: { a: "marcar", t: "Marcar ingreso", toca: true } }),
              pista: "Ya es la hora de tu turno. Toca <b>Marcar ingreso</b>.",
              on: { marcar: () => "donde", "tab:asistencia": () => "donde" },
            },
            donde: {
              tab: "asistencia", titulo: "Asistencia",
              html: () => '<div class="c-card"><span class="c-etq">Asistencia</span><div class="sub">Cédula ' + CEDULA + " validada. Revisando dónde estás…</div></div>" +
                practicaCaja("¿dónde estás?",
                  btn("lugar", "En la bahía de Nutibara", { v: "nutibara" }) + btn("lugar", "En Almacentro", { v: "almacentro" }) +
                  btn("lugar", "En el aeropuerto", { v: "aeropuerto" }) + btn("lugar", "Con el GPS apagado", { v: "gps" })),
              pista: "Escoge dónde estás. Prueba primero con el <b>aeropuerto</b> para ver qué pasa.",
              on: { lugar: (s, v) => { s.d.lugar = v; s.d.mapa = false; return "ubic"; } },
            },
            fin: {
              tab: "inicio", titulo: "Inicio",
              html: () => inicioHtml({ estado: "Iniciado", boton: { a: "x", t: "Marcar salida" }, jornada: [["ENTRADA", "5:02 a. m."]] }),
              pista: "¡Muy bien! Tu turno dice <b>Iniciado</b> y en <b>Mi jornada de hoy</b> está tu ENTRADA.",
              fin: true,
            },
          },
        }),
        armar: (def) => { Object.assign(def.estados, estadosDeMarca({ sentido: "ENTRADA", hora: "5:02", pre: "", final: "fin" })); return def; },
      }],
    },
    // ------------------------------------------------------------ 3
    {
      id: "alistar", cuando: "Antes del primer despacho", titulo: "Alista el bus",
      corto: "Respondes cómo estás y revisas el bus punto por punto. En Inicio pasa de rojo a verde.",
      intro: "El alistamiento se hace <b>antes de salir en el primer despacho</b>, no después. Es uno por bus y por día.",
      pasos: [
        "Toca la pestaña <b>Alistar</b>. Tu cédula y el bus ya vienen puestos.",
        "Responde con la verdad: si estás <b>descansado</b> y si <b>no has consumido</b> alcohol, sustancias ni medicamentos que afecten.",
        "Revisa el bus bloque por bloque: <b>✓</b> si el punto está bien o <b>!</b> si encontraste una novedad. <b>Todo bien</b> marca lo que falta del bloque.",
        "Toca <b>Registrar alistamiento</b>. En Inicio, el aviso pasa de <b>rojo</b> a <b>verde</b>.",
      ],
      ojo: [
        "En el portal son <b>40 puntos</b>. Aquí practicas con unos pocos.",
        "Si encontraste algo (<b>!</b>), escríbelo en <b>Observaciones</b> y avísale a tu coordinador.",
        "Si eres del <b>turno 2</b> y el bus ya se alistó hoy, el portal te lo muestra hecho.",
      ],
      sims: [{
        nombre: "Alistar", escena: "Ya marcaste la entrada. Antes del primer despacho, alista el bus " + BUS + ".",
        def: () => {
          const BLOQUES = [
            ["Luces", ["Altas y bajas", "Direccionales", "Luces de freno"]],
            ["Llantas", ["Presión", "Estado de las llantas", "Llanta de repuesto"]],
            ["Seguridad", ["Frenos", "Cinturones", "Extintor", "Botiquín"]],
          ];
          const total = BLOQUES.reduce((t, b) => t + b[1].length, 0);
          const marcados = (s) => Object.keys(s.d.m).length;
          const completo = (s) => s.d.descanso && s.d.sustancias && marcados(s) === total;
          return {
            inicio: "inicio", hora: "5:08", datos: () => ({ m: {} }),
            estados: {
              inicio: {
                tab: "inicio", titulo: "Inicio", tocaTab: "alistar",
                html: () => inicioHtml({ estado: "Iniciado", alistamiento: "falta" }),
                pista: "En Inicio el alistamiento sale en <b>rojo</b>. Toca la pestaña <b>Alistar</b> abajo.",
                on: { "tab:alistar": () => "form" },
              },
              form: {
                tab: "alistar", titulo: "Alistamiento",
                html: (s) => {
                  const preg = (k, t) => '<div class="c-card"><div style="font-weight:600;margin-bottom:8px">' + t + '</div><div class="c-botones dos">' +
                    ["si", "no"].map((v) => '<button type="button" class="c-check' + (!s.d[k] && v === "si" && (k === "descanso" || s.d.descanso) ? " toca" : "") +
                      '" data-a="resp" data-v="' + k + ":" + v + '" aria-pressed="' + (s.d[k] === v) + '"><span class="caja-check">' + (s.d[k] === v ? "✓" : "") + "</span>" + (v === "si" ? "Sí" : "No") + "</button>").join("") + "</div></div>";
                  let tocaHecho = !(s.d.descanso && s.d.sustancias);
                  let h = '<div class="c-card"><div class="c-fila"><b>Revisión del vehículo</b><span class="c-chip' + (marcados(s) === total ? "" : " gris") + '">' + marcados(s) + "/" + total + "</span></div>" +
                    '<div class="sub">Bus ' + BUS + " · Cédula " + CEDULA + "</div></div>" +
                    '<span class="c-etq">Antes de empezar</span>' +
                    preg("descanso", "¿Estás descansado, sin fatiga ni sueño, para manejar seguro?") +
                    preg("sustancias", "¿Declaras no haber consumido alcohol, sustancias psicoactivas ni medicamentos que afecten la conducción?");
                  if (s.d.descanso === "no" || s.d.sustancias === "no") {
                    h += '<div class="c-aviso ambar"><b>Avísale a tu coordinador</b>Si no estás en condiciones de manejar, no salgas a operar.</div>';
                  }
                  h += '<span class="c-etq">Verificación</span>';
                  BLOQUES.forEach((b, gi) => {
                    const hechos = b[1].filter((_, ii) => s.d.m[gi + ":" + ii]).length;
                    const pendiente = hechos < b[1].length;
                    const tocaTodo = !tocaHecho && pendiente;
                    if (tocaTodo) tocaHecho = true;
                    h += '<div class="c-card"><div class="c-fila"><b>' + b[0] + '</b><span class="c-chip' + (pendiente ? " gris" : "") + '">' + hechos + "/" + b[1].length + "</span></div>" +
                      b[1].map((it, ii) => {
                        const k = gi + ":" + ii, m = s.d.m[k];
                        return '<div class="c-dato"><span>' + it + "</span><span style=\"display:flex;gap:6px\">" +
                          '<button type="button" class="c-btn' + (m === "ok" ? " prim" : "") + '" style="min-height:36px;padding:4px 12px" data-a="item" data-v="' + k + ':ok" aria-label="' + it + ' bien">✓</button>' +
                          '<button type="button" class="c-btn' + (m === "nov" ? " peligro" : "") + '" style="min-height:36px;padding:4px 12px" data-a="item" data-v="' + k + ':nov" aria-label="' + it + ' con novedad">!</button></span></div>';
                      }).join("") +
                      (pendiente ? '<div style="margin-top:8px">' + btn("todo", "Todo bien en " + b[0].toLowerCase(), { v: gi, toca: tocaTodo }) + "</div>" : "") + "</div>";
                  });
                  const hayNov = Object.keys(s.d.m).some((k) => s.d.m[k] === "nov");
                  h += '<label class="c-campo">Observaciones <span class="c-ayuda">' + (hayNov ? "Cuenta qué encontraste." : "Opcional.") + "</span>" +
                    '<textarea data-campo="obs" placeholder="' + (hayNov ? "Ej. la direccional derecha no prende" : "") + '">' + esc(s.d.obs || "") + "</textarea></label>" +
                    btn("registrar", "Registrar alistamiento", { prim: true, off: !completo(s), toca: completo(s) });
                  return h;
                },
                pista: (s) => !(s.d.descanso && s.d.sustancias) ? "Primero responde las dos preguntas, con la verdad."
                  : !completo(s) ? "Revisa cada punto: <b>✓</b> si está bien, <b>!</b> si encontraste algo. <b>Todo bien</b> marca lo que falta del bloque."
                    : "Todo revisado. Toca <b>Registrar alistamiento</b>.",
                on: {
                  resp: (s, v) => { const p = v.split(":"); s.d[p[0]] = p[1]; },
                  item: (s, v) => { const p = v.split(":"); s.d.m[p[0] + ":" + p[1]] = p[2]; },
                  todo: (s, v) => { BLOQUES[v][1].forEach((_, ii) => { const k = v + ":" + ii; if (!s.d.m[k]) s.d.m[k] = "ok"; }); },
                  registrar: (s) => completo(s) ? "listo" : undefined,
                },
              },
              listo: {
                tab: "alistar", titulo: "Alistamiento",
                html: (s) => {
                  const nov = Object.keys(s.d.m).filter((k) => s.d.m[k] === "nov").length;
                  return '<div class="c-aviso bien" style="padding:16px"><b style="font-size:18px">Alistamiento registrado</b>Bus ' + BUS + " · 5:10 a. m.</div>" +
                    (nov ? '<div class="c-aviso ambar"><b>' + nov + (nov === 1 ? " novedad" : " novedades") + "</b>Avísale a tu coordinador antes de salir.</div>" : "") +
                    btn("ir", "Ir a Inicio", { prim: true, toca: true });
                },
                pista: "¡Quedó! Toca <b>Ir a Inicio</b> para ver el aviso en verde.",
                on: { ir: () => "fin", "tab:inicio": () => "fin" },
              },
              fin: {
                tab: "inicio", titulo: "Inicio",
                html: () => inicioHtml({ estado: "Iniciado", alistamiento: "hecho" }),
                pista: "¡Muy bien! El alistamiento ya está en <b>verde</b>. Ahora sí puedes salir en tu primer despacho.",
                fin: true,
              },
            },
          };
        },
      }],
    },
    // ------------------------------------------------------------ 4
    {
      id: "viaje", cuando: "Durante el viaje", titulo: "Personal de la empresa y tiquetes",
      corto: "Registras al gestor que sube al bus y confirmas tu bus antes de escanear tiquetes.",
      intro: "Dos cosas que pasan en el viaje. Practica las dos con los botones de arriba del celular.",
      pasos: [
        "<b>Personal de la empresa:</b> en <b>Mi tarjeta</b>, en el viaje de ahora (el primero de la lista), toca <b>Personal de la empresa</b> y muéstrale el código a la persona. Ella lo lee con su app.",
        "Si la persona <b>no tiene internet</b>: toca <b>¿La persona no tiene internet?</b>, lee su código o escribe su cédula, tómale la <b>foto</b> y toca <b>Registrar</b>.",
        "El personal va en tus pasajeros, pero <b>no se cobra</b>.",
        "<b>Tiquetes:</b> en la pestaña <b>Tiquetes</b> toca <b>Confirmo, es el vehículo</b> y luego <b>Abrir Distribusion</b>. Escoge <b>el mismo bus</b> y escanea.",
      ],
      ojo: [
        "La foto del personal es <b>obligatoria</b>: es la prueba de que la persona iba en el bus.",
        "El código del bus cambia solo cada 15 segundos y <b>sirve sin internet</b>.",
        "Si en Distribusion escoges otro bus, los tiquetes quedan en el bus equivocado.",
      ],
      sims: [
        {
          nombre: "Personal de la empresa", escena: "En el viaje 2 subió un gestor de la empresa y <b>no tiene internet</b>. Su cédula de práctica es <b>" + PERSONA_CED + "</b>.",
          def: () => ({
            inicio: "tarjeta", hora: "6:42", datos: () => ({}),
            estados: {
              tarjeta: {
                tab: "tarjeta", titulo: "Mi tarjeta",
                html: () => '<div class="c-viaje">' + cabViaje2('<span class="c-chip gris">En curso</span>') +
                  '<div class="c-botones dos">' + btn("personal", "Personal de la empresa", { icono: I.qr, toca: true }) + btn("x", "Reportar novedad") + "</div></div>" + viaje1Html(),
                pista: "Subió un gestor. En el viaje de ahora (el primero), toca <b>Personal de la empresa</b>.",
                on: { personal: () => "qr" },
              },
              qr: {
                tab: "tarjeta", titulo: "Personal de la empresa",
                html: (s) => '<div class="sub" style="text-align:center">Muéstrale este código a la persona. Ella lo lee con la app del personal, se toma una selfie y toca <b>Registrarme</b>.</div>' +
                  '<div class="c-qr" data-qr>' + qrSvg(s.d.semilla || 7) + '<span class="c-ayuda">Cambia solo en <b data-seg>15</b> s · sirve sin internet</span></div>' +
                  '<button type="button" class="c-link toca" data-a="sinInternet">¿La persona no tiene internet?</button>' + btn("x", "Listo"),
                pista: "Si la persona tiene internet, ella lee este código. Aquí no tiene: toca <b>¿La persona no tiene internet?</b>",
                alPintar: (s, cont) => {
                  let seg = 15;
                  s.timers.push(setInterval(() => {
                    seg -= 1;
                    if (seg <= 0) {
                      seg = 15; s.d.semilla = (s.d.semilla || 7) + 13;
                      const q = cont.querySelector("[data-qr] svg");
                      if (q) q.outerHTML = qrSvg(s.d.semilla);
                    }
                    const b = cont.querySelector("[data-seg]");
                    if (b) b.textContent = seg;
                  }, 1000));
                },
                on: { sinInternet: () => "opciones" },
              },
              opciones: {
                tab: "tarjeta", titulo: "Personal de la empresa",
                html: () => '<div class="c-qr">' + qrSvg(7) + "</div>",
                hoja: () => "<h3>¿La persona no tiene internet?</h3><p class=\"c-ayuda\" style=\"margin:0\">Regístrala tú. En su app ella puede tocar <b>Mostrar mi código</b>, que sale sin internet.</p>" +
                  '<div class="c-botones">' + btn("leer", "Leer su código", { icono: I.qr }) + btn("escribir", "Escribir la cédula", { toca: true }) + "</div>",
                pista: "Puedes leer el código que ella muestra en su app o escribir su cédula. Toca <b>Escribir la cédula</b>.",
                on: { leer: () => "leer", escribir: () => "ced" },
              },
              leer: {
                tab: "tarjeta", titulo: "Leer su código",
                html: () => '<div class="c-camara"><div class="rec" style="color:#fff">Cámara de atrás</div>' + qrSvg(21).replace("<svg", '<svg style="width:55%;height:auto;opacity:.85"') + "</div>" +
                  '<p class="c-ayuda" style="text-align:center;margin:0">Apunta al código que la persona muestra en su app…</p>' + btn("cancelar", "Cancelar"),
                pista: "Apunta la cámara al código de la persona. En la práctica se lee solo en unos segundos.",
                alPintar: (s, cont, ir) => { s.timers.push(setTimeout(() => ir("confirmar"), 2200)); },
                on: { cancelar: () => "opciones" },
              },
              ced: {
                tab: "tarjeta", titulo: "Registrar a la persona",
                html: (s) => '<label class="c-campo">Cédula de la persona<input data-campo="pced" inputmode="numeric" maxlength="12" placeholder="Solo números" value="' + esc(s.d.pced || "") + '"></label>' +
                  btn("buscar", "Buscar", { prim: true, toca: true }),
                pista: "Escribe la cédula de práctica <b>" + PERSONA_CED + "</b> y toca <b>Buscar</b>.",
                on: {
                  buscar: (s) => {
                    if (digitos(s.d.pced) !== PERSONA_CED) { s.error = "Con otra cédula no sale nadie. Para practicar usa <b>" + PERSONA_CED + "</b>."; return; }
                    return "confirmar";
                  },
                },
              },
              confirmar: {
                tab: "tarjeta", titulo: "Registrar a la persona",
                html: () => '<div class="c-card"><span class="c-etq">¿Es esta persona?</span><div class="c-grande">' + PERSONA + '</div><div class="sub">Gestor de servicio · Cédula ' + PERSONA_CED + "</div></div>" +
                  '<div class="c-botones">' + btn("si", "Sí, es esta persona", { prim: true, toca: true }) + btn("no", "No es") + "</div>",
                pista: "Revisa que el nombre sea el de la persona que subió y toca <b>Sí, es esta persona</b>.",
                on: { si: () => "foto", no: () => "opciones" },
              },
              foto: {
                tab: "tarjeta", titulo: "Foto de la persona",
                html: () => '<div class="c-camara">' + personaSvg() + '<div class="flash"></div></div>' +
                  '<p class="c-ayuda" style="text-align:center;margin:0">Tómale una foto a la persona dentro del bus. Es obligatoria.</p>' +
                  btn("foto", "Tomar foto", { prim: true, toca: true }),
                pista: "Se abre la cámara de atrás. Toca <b>Tomar foto</b> (en la práctica no se toma ninguna).",
                on: { foto: () => "registrar" },
              },
              registrar: {
                tab: "tarjeta", titulo: "Registrar a la persona",
                html: () => '<div class="c-aviso bien"><b>Foto lista ✓</b>' + PERSONA + " · Gestor de servicio</div>" + btn("registrar", "Registrar", { prim: true, toca: true }),
                pista: "Toca <b>Registrar</b>.",
                on: { registrar: () => "fin" },
              },
              fin: {
                tab: "tarjeta", titulo: "Mi tarjeta",
                html: () => '<div class="c-viaje">' + cabViaje2('<span class="c-chip gris">En curso</span>') +
                  '<div class="c-dato"><span>Personal de la empresa <b>1</b></span><span class="c-chip">Va en tus pasajeros, no se cobra</span></div></div>' + viaje1Html(),
                pista: "¡Listo! La persona quedó en tu viaje. Cuéntala en tus pasajeros, pero <b>no se le cobra</b>.",
                fin: true,
              },
            },
          }),
        },
        {
          nombre: "Tiquetes", escena: "Van a subir pasajeros con tiquete. Antes de escanear, confirma tu bus.",
          def: () => ({
            inicio: "inicio", hora: "6:30",
            estados: {
              inicio: {
                tab: "inicio", titulo: "Inicio", tocaTab: "tiquetes",
                html: () => inicioHtml({ estado: "Iniciado", alistamiento: "hecho" }),
                pista: "Toca la pestaña <b>Tiquetes</b> abajo.",
                on: { "tab:tiquetes": () => "confirmar" },
              },
              confirmar: {
                tab: "tiquetes", titulo: "Tiquetes",
                html: () => '<div class="c-card"><span class="c-etq">Usted está validando tiquetes del vehículo</span><div class="c-grande">' + BUS + "</div></div>" +
                  '<div class="c-botones">' + btn("si", "Confirmo, es el vehículo " + BUS, { prim: true, toca: true }) + btn("no", "No es mi vehículo") + "</div>",
                pista: "Revisa que sea tu bus y toca <b>Confirmo, es el vehículo " + BUS + "</b>.",
                on: {
                  si: () => "abrir",
                  no: (s) => { s.error = "Si no es tu bus, tocas <b>No es mi vehículo</b> y escribes el correcto. Aquí sí es el " + BUS + "."; },
                },
              },
              abrir: {
                tab: "tiquetes", titulo: "Tiquetes",
                html: () => '<div class="c-aviso bien"><b>Confirmado ✓</b>Vehículo ' + BUS + " · 6:31 a. m.</div>" + btn("abrir", "Abrir Distribusion", { prim: true, toca: true }),
                pista: "Toca <b>Abrir Distribusion</b>.",
                on: { abrir: () => "fin" },
              },
              fin: {
                tab: "tiquetes", titulo: "Tiquetes",
                html: () => '<div class="c-card" style="border:2px dashed #b9c8b2"><span class="c-etq">En la práctica no se abre Distribusion</span>' +
                  '<ol style="margin:8px 0 0;padding-left:20px"><li>Se abre aparte del portal. Entra con tu usuario de Distribusion.</li>' +
                  "<li>Escoge el <b>mismo bus: " + BUS + "</b>.</li><li>Escanea los tiquetes.</li><li>Al terminar el viaje, anota cuántos escaneaste en <b>Mi tarjeta</b>.</li></ol></div>",
                pista: "¡Bien! Escoge siempre <b>el mismo bus</b> en Distribusion.",
                fin: true,
              },
            },
          }),
        },
      ],
    },
    // ------------------------------------------------------------ 5
    {
      id: "tarjeta", cuando: "Al terminar cada viaje", titulo: "Llena tu tarjeta",
      corto: "El número del validador, los pasajeros y los tiquetes. El portal saca la cuenta.",
      intro: "Cada viaje sale en <b>Mi tarjeta</b> unos minutos después del despacho. Llénalo <b>apenas terminas el viaje</b>, no al final del día.",
      pasos: [
        "<b>Número del validador:</b> el número que marca ahora el validador de la cívica, ya hecho el viaje.",
        "<b>Pasajeros:</b> cuántas personas llevaste, contadas por ti. Cuenta a todos: tiquete, cívica, efectivo y personal de la empresa. Máximo <b>19</b>.",
        "<b>Tiquetes:</b> los que escaneaste en Distribusion para ese viaje. Si no hubo, pon <b>0</b>.",
        "Toca <b>Guardar</b>, revisa los números y toca <b>Sí, guardar</b>.",
      ],
      extra: '<div class="cuenta-ejemplo"><p><b>Así saca el portal la cuenta:</b></p>' +
        "<p>Cívicas del viaje = número de ahora − número del viaje anterior. Si el número se repite, no hubo cívicas.</p>" +
        "<p>Efectivo = pasajeros − tiquetes − cívicas − personal.</p>" +
        '<p class="igual">Ej.: 15 pasajeros = 3 con tiquete + 2 con cívica + 9 en efectivo + 1 del personal.</p></div>',
      ojo: [
        "Revisa antes de <b>Sí, guardar</b>. Si te equivocas, lo puedes <b>corregir una sola vez, hoy</b> (paso 6).",
        "Si salen más de 19 pasajeros o más tiquetes que pasajeros, el portal <b>no deja guardar</b>: revisa los números.",
        "Si el validador se dañó y lo cambiaron, toca <b>Reportar daño del validador</b> al final de la lista.",
      ],
      sims: [{
        nombre: "Tarjeta",
        escena: "Terminaste el <b>viaje 2</b>. Al terminar el viaje 1 el validador quedó en <b>2773</b> y ahora dice <b>2775</b>. " +
          "Llevaste <b>15 personas</b>: <b>3 con tiquete</b>, <b>1 gestor</b> que se registró y los demás pagaron con cívica o en efectivo.",
        def: () => {
          const leidos = (s) => ({ lectura: num(s.d.lectura), pas: num(s.d.pas), tiq: num(s.d.tiq) });
          const campo = (k, t, ph, ayuda, max) => '<label class="c-campo">' + t + (ayuda ? ' <span class="c-ayuda">' + ayuda + "</span>" : "") +
            '<input data-campo="' + k + '" inputmode="numeric" maxlength="' + max + '" placeholder="' + ph + '"></label>';
          return {
            inicio: "form", hora: "7:35", datos: () => ({}),
            estados: {
              form: {
                tab: "tarjeta", titulo: "Mi tarjeta",
                html: () => '<div class="c-viaje">' + cabViaje2('<span class="c-chip ambar">Falta llenar</span>') +
                  '<div class="c-dato"><span>Personal de la empresa <b>1</b></span><span class="c-chip">No se cobra</span></div>' +
                  '<span class="c-etq">Escribe la cívica, los pasajeros y los tiquetes de este despacho</span>' +
                  campo("lectura", "Número del validador", "Ej. 1250", "el de ahora, ya hecho el viaje", 9) +
                  campo("pas", "Pasajeros", "Ej. 15", "todos, máximo 19", 2) +
                  campo("tiq", "Tiquetes", "Ej. 12", "si no hubo, 0", 3) +
                  '<div data-vivo aria-live="polite"></div>' + btn("guardar", "Guardar", { prim: true }) + "</div>" + viaje1Html(),
                vivo: (s, cont) => {
                  const v = leidos(s);
                  const c = cuentaViaje(v.lectura, v.pas, v.tiq, 1, LECTURA_ANT);
                  const caja = cont.querySelector("[data-vivo]");
                  if (caja) caja.innerHTML = cuentaHtml(c);
                  const g = cont.querySelector('[data-a="guardar"]');
                  const listo = v.lectura != null && v.pas != null && v.tiq != null && !c.mal;
                  if (g) { g.disabled = !listo; g.classList.toggle("toca", listo); }
                },
                pista: "Escribe los tres números del viaje 2 y mira cómo el portal saca la cuenta mientras escribes. Luego toca <b>Guardar</b>.",
                on: { guardar: () => "confirma" },
              },
              confirma: {
                tab: "tarjeta", titulo: "Mi tarjeta",
                html: (s) => {
                  const v = leidos(s);
                  const c = cuentaViaje(v.lectura, v.pas, v.tiq, 1, LECTURA_ANT);
                  return '<div class="c-viaje">' + cabViaje2() +
                    c.avisos.map((a) => '<div class="c-cuenta aviso">' + esc(a) + (v.lectura < LECTURA_ANT ? '<br><button type="button" class="c-link" data-a="dano">Reportar daño del validador</button>' : "") + "</div>").join("") +
                    "<b>¿Guardar esto en el viaje 2?</b>" +
                    '<div class="c-valores"><div>Cívica<strong>' + v.lectura + "</strong></div><div>Pasajeros<strong>" + v.pas + "</strong></div><div>Tiquetes<strong>" + v.tiq + "</strong></div></div>" +
                    (c.linea ? '<div class="c-cuenta">' + esc(c.linea) + "</div>" : "") +
                    '<div class="c-ayuda">Si te equivocas, lo puedes corregir hoy una sola vez, con el botón Corregir de este viaje.</div>' +
                    '<div class="c-botones dos">' + btn("si", "Sí, guardar", { prim: true, toca: true }) + btn("cambiar", "Cambiar") + "</div></div>";
                },
                pista: "Revisa los tres números. Si están bien, toca <b>Sí, guardar</b>. Si no, <b>Cambiar</b>.",
                on: {
                  si: () => "guardado",
                  cambiar: (s) => { s.d = {}; return "form"; },
                  dano: (s) => { s.error = "Con <b>Reportar daño del validador</b> cuentas en qué número quedó el viejo, con cuál arrancó el nuevo, qué pasó y mandas una foto. Necesita señal."; },
                },
              },
              guardado: {
                tab: "tarjeta", titulo: "Mi tarjeta",
                html: (s) => guardadoHtml(leidos(s), { botones: btn("x", "Reportar novedad") + btn("x", "Corregir", { icono: I.lapiz }) }) + viaje1Html(),
                fin: (s) => { const v = leidos(s); return v.lectura === 2775 && v.pas === 15 && v.tiq === 3; },
                pista: (s) => {
                  const v = leidos(s);
                  if (v.lectura === 2775 && v.pas === 15 && v.tiq === 3) {
                    return "¡Perfecto! 15 pasajeros = 3 con tiquete + 2 con cívica + 9 en efectivo + 1 del personal. Entregas <b>9 pasajes en efectivo</b>.";
                  }
                  return "Quedó guardado, pero en este ejemplo eran <b>2775</b>, <b>15</b> y <b>3</b>. Toca <b>Empezar de nuevo</b> y prueba otra vez.";
                },
              },
            },
          };
        },
      }],
    },
    // ------------------------------------------------------------ 6
    {
      id: "novedad", cuando: "Si pasa algo", titulo: "Reporta una novedad o corrige un número",
      corto: "Trasbordo, bus varado, accidente u otra cosa. Y si guardaste un número mal, lo corriges.",
      intro: "Las dos cosas se hacen desde el viaje, en <b>Mi tarjeta</b>. Practica las dos con los botones de arriba del celular.",
      pasos: [
        "<b>Novedad:</b> en el viaje donde pasó, toca <b>Reportar novedad</b> y escoge qué pasó: <b>Trasbordo</b>, <b>Bus varado o daño</b>, <b>Accidente o incidente</b> u <b>Otra novedad</b>.",
        "Cuenta qué pasó y, si puedes, <b>graba un video</b> (máximo 1 minuto). Toca <b>Enviar novedad</b>.",
        "El <b>trasbordo lo reporta el bus que recibe</b> los pasajeros: de qué bus venían y cuántos recibiste.",
        "<b>Corregir:</b> en el viaje, toca <b>Corregir</b>, escribe el número bueno y escoge el motivo. Solo <b>hoy</b> y <b>una sola vez</b> por número.",
      ],
      ojo: [
        "Sin señal, la novedad queda guardada en el celular y se envía sola cuando vuelva. No cierres el portal mientras sube el video.",
        "Después de corregir, si hay otro error, <b>solo el despachador</b> lo puede arreglar.",
      ],
      sims: [
        {
          nombre: "Reportar novedad", escena: "En el viaje 2 se varó el <b>bus 798</b> y te pasaron <b>5 pasajeros</b> a tu bus.",
          def: () => {
            const TIPOS = [["trasbordo", "Trasbordo"], ["varado", "Bus varado o daño"], ["accidente", "Accidente o incidente"], ["otra", "Otra novedad"]];
            return {
              inicio: "tarjeta", hora: "7:05", datos: () => ({}),
              estados: {
                tarjeta: {
                  tab: "tarjeta", titulo: "Mi tarjeta",
                  html: () => '<div class="c-viaje">' + cabViaje2('<span class="c-chip gris">En curso</span>') +
                    '<div class="c-botones dos">' + btn("x", "Personal de la empresa", { icono: I.qr }) + btn("novedad", "Reportar novedad", { toca: true }) + "</div></div>" + viaje1Html(),
                  pista: "Pasó algo en el viaje 2. Toca <b>Reportar novedad</b> en ese viaje.",
                  on: { novedad: () => "form" },
                },
                form: {
                  tab: "tarjeta", titulo: "Reportar novedad",
                  html: (s) => {
                    let h = '<span class="c-etq">Viaje 2 · 6:40 a. m.</span><b>¿Qué pasó?</b>' +
                      TIPOS.map((t) => '<button type="button" class="c-check' + (!s.d.tipo && t[0] === "trasbordo" ? " toca" : "") + '" data-a="tipo" data-v="' + t[0] + '" aria-pressed="' + (s.d.tipo === t[0]) + '">' +
                        '<span class="caja-check">' + (s.d.tipo === t[0] ? "✓" : "") + "</span>" + t[1] + "</button>").join("");
                    if (!s.d.tipo) return h;
                    if (s.d.tipo === "trasbordo") {
                      h += '<div class="c-ayuda">El trasbordo lo reporta el bus que <b>recibe</b> los pasajeros.</div>' +
                        '<label class="c-campo">¿De qué bus venían?<input data-campo="origen" inputmode="numeric" maxlength="4" placeholder="Ej. 715" value="' + esc(s.d.origen || "") + '"></label>' +
                        '<label class="c-campo">¿Cuántos pasajeros recibiste?<input data-campo="cant" inputmode="numeric" maxlength="2" placeholder="Ej. 5" value="' + esc(s.d.cant || "") + '"></label>';
                    }
                    h += '<label class="c-campo">Cuenta qué pasó <span class="c-ayuda">' + (s.d.tipo === "otra" ? "obligatorio" : "opcional") + "</span>" +
                      '<textarea data-campo="nota" maxlength="300">' + esc(s.d.nota || "") + "</textarea></label>" +
                      (s.d.video ? '<div class="c-aviso bien"><b>Video listo ✓</b>0:05 · se sube al enviar</div>'
                        : '<div class="c-botones dos">' + btn("grabar", "Grabar video", { icono: I.video, toca: true }) + btn("grabar", "Elegir del celular") + "</div>") +
                      btn("enviar", "Enviar novedad", { prim: true, toca: !!s.d.video });
                    return h;
                  },
                  pista: (s) => !s.d.tipo ? "Escoge qué pasó. En el ejemplo es un <b>Trasbordo</b>."
                    : s.d.tipo === "trasbordo" && !s.d.video ? "Escribe de qué bus venían (798) y cuántos recibiste (5). Si puedes, graba un video corto."
                      : "Toca <b>Enviar novedad</b>.",
                  on: {
                    tipo: (s, v) => { s.d.tipo = v; },
                    grabar: () => "video",
                    enviar: (s) => {
                      if (s.d.tipo === "trasbordo" && (!num(s.d.origen) || !num(s.d.cant))) { s.error = "En un trasbordo escribe <b>de qué bus venían</b> y <b>cuántos recibiste</b>."; return; }
                      if (s.d.tipo === "otra" && !String(s.d.nota || "").trim()) { s.error = "En <b>Otra novedad</b> hay que contar qué pasó."; return; }
                      return "enviada";
                    },
                  },
                },
                video: {
                  tab: "tarjeta", titulo: "Grabando",
                  html: (s) => '<div class="c-camara"><div class="rec"><i></i>REC 0:0<span data-seg>' + (s.d.seg || 0) + "</span></div>" + personaSvg() + "</div>" +
                    '<p class="c-ayuda" style="text-align:center;margin:0">Máximo 1 minuto. En la práctica se graban 5 segundos de mentira.</p>' + btn("parar", "Parar"),
                  pista: "Grabando… muestra lo que pasó. Se detiene solo.",
                  alPintar: (s, cont, ir) => {
                    s.d.seg = 0;
                    s.timers.push(setInterval(() => {
                      s.d.seg += 1;
                      const b = cont.querySelector("[data-seg]");
                      if (b) b.textContent = s.d.seg;
                      if (s.d.seg >= 5) { s.d.video = true; ir("form"); }
                    }, 1000));
                  },
                  on: { parar: (s) => { s.d.video = true; return "form"; } },
                },
                enviada: {
                  tab: "tarjeta", titulo: "Reportar novedad",
                  html: (s) => '<div class="c-aviso bien" style="padding:16px"><b style="font-size:18px">Novedad N° 1001</b>' +
                    (TIPOS.find((t) => t[0] === s.d.tipo) || TIPOS[0])[1] + (s.d.tipo === "trasbordo" ? ": " + num(s.d.cant) + " pasajeros del bus " + num(s.d.origen) : "") +
                    "<br>De práctica: no se mandó a nadie.</div>" + btn("listo", "Listo", { prim: true, toca: true }),
                  pista: "En el portal de verdad sale el número de la novedad. Toca <b>Listo</b>.",
                  on: { listo: () => "fin" },
                },
                fin: {
                  tab: "tarjeta", titulo: "Mi tarjeta",
                  html: (s) => '<div class="c-viaje">' + cabViaje2('<span class="c-chip gris">En curso</span>') +
                    '<div class="c-dato"><span>N° 1001 · ' + (TIPOS.find((t) => t[0] === s.d.tipo) || TIPOS[0])[1] + '</span><span class="c-chip">Enviada</span></div></div>' + viaje1Html(),
                  pista: "¡Bien! La novedad queda debajo del viaje, con su estado, y el despachador la ve.",
                  fin: true,
                },
              },
            };
          },
        },
        {
          nombre: "Corregir un número", escena: "En el viaje 2 guardaste <b>15 pasajeros</b>, pero contaste otra vez y eran <b>16</b>.",
          def: () => {
            const G = { lectura: 2775, pas: 15, tiq: 3 };
            const CAMPOS = [["civica", "Cívica", "lectura"], ["pasajeros", "Pasajeros", "pas"], ["tiquetes", "Tiquetes", "tiq"]];
            const MOTIVOS = ["Lo escribí mal", "Conté mal", "Otra razón"];
            const nuevo = (s) => { const g = Object.assign({}, G); const c = CAMPOS.find((x) => x[0] === s.d.campo); if (c && num(s.d.valor) != null) g[c[2]] = num(s.d.valor); return g; };
            return {
              inicio: "guardado", hora: "7:50", datos: () => ({}),
              estados: {
                guardado: {
                  tab: "tarjeta", titulo: "Mi tarjeta",
                  html: () => guardadoHtml(G, { botones: btn("x", "Reportar novedad") + btn("corregir", "Corregir", { icono: I.lapiz, toca: true }) }) + viaje1Html(),
                  pista: "Toca <b>Corregir</b> en el viaje 2.",
                  on: { corregir: () => "ventana" },
                },
                ventana: {
                  tab: "tarjeta", titulo: "Mi tarjeta",
                  html: () => guardadoHtml(G),
                  hoja: () => "<h3>Corregir un número</h3>" +
                    '<ol style="margin:0;padding-left:20px;font-size:14px"><li>Escoge qué número: la cívica, los pasajeros o los tiquetes.</li><li>Escribe el número bueno.</li><li>Escoge por qué.</li></ol>' +
                    '<div class="c-aviso ambar">Ej.: guardaste 15 pasajeros y eran 16. <b style="display:inline;font-size:inherit">Una sola vez por número, y solo hoy.</b></div>' +
                    '<div class="c-botones">' + btn("si", "Sí, quiero corregir", { prim: true, toca: true }) + btn("no", "Cancelar") + "</div>",
                  pista: "El portal explica cómo se corrige. Toca <b>Sí, quiero corregir</b>.",
                  on: { si: () => "form", no: () => "guardado" },
                },
                form: {
                  tab: "tarjeta", titulo: "Corregir",
                  html: (s) => {
                    const c = CAMPOS.find((x) => x[0] === s.d.campo);
                    let h = '<span class="c-etq">Corregir el viaje 2</span><b>¿Qué número?</b><div class="c-botones" style="grid-template-columns:repeat(3,1fr)">' +
                      CAMPOS.map((x) => '<button type="button" class="c-check' + (!s.d.campo && x[0] === "pasajeros" ? " toca" : "") + '" style="justify-content:center" data-a="campo" data-v="' + x[0] + '" aria-pressed="' + (s.d.campo === x[0]) + '">' + x[1] + "</button>").join("") + "</div>";
                    if (!c) return h;
                    h += '<label class="c-campo">' + c[1] + ' <span class="c-ayuda">ahora dice ' + G[c[2]] + "</span>" +
                      '<input data-campo="valor" inputmode="numeric" maxlength="9" placeholder="El número bueno" value="' + esc(s.d.valor || "") + '"></label>' +
                      "<b>¿Por qué?</b>" + MOTIVOS.map((m) => '<button type="button" class="c-check" data-a="motivo" data-v="' + m + '" aria-pressed="' + (s.d.motivo === m) + '"><span class="caja-check">' + (s.d.motivo === m ? "✓" : "") + "</span>" + m + "</button>").join("") +
                      '<div data-vivo></div>' + btn("revisar", "Revisar", { prim: true, toca: !!s.d.motivo });
                    return h;
                  },
                  vivo: (s, cont) => {
                    const caja = cont.querySelector("[data-vivo]");
                    if (!caja || !s.d.campo || num(s.d.valor) == null) { if (caja) caja.innerHTML = ""; return; }
                    const g = nuevo(s);
                    caja.innerHTML = cuentaHtml(cuentaViaje(g.lectura, g.pas, g.tiq, 1, LECTURA_ANT));
                  },
                  pista: (s) => !s.d.campo ? "Escoge el número que vas a corregir: <b>Pasajeros</b>."
                    : "Escribe el número bueno (16), escoge el motivo (<b>Conté mal</b>) y toca <b>Revisar</b>.",
                  on: {
                    campo: (s, v) => { s.d.campo = v; s.d.valor = ""; },
                    motivo: (s, v) => { s.d.motivo = v; },
                    revisar: (s) => {
                      const c = CAMPOS.find((x) => x[0] === s.d.campo);
                      const v = num(s.d.valor);
                      if (v == null) { s.error = "Escribe el número bueno."; return; }
                      if (v === G[c[2]]) { s.error = "Es el mismo número que ya estaba. Escribe el bueno."; return; }
                      if (!s.d.motivo) { s.error = "Escoge por qué corriges."; return; }
                      const g = nuevo(s);
                      const cu = cuentaViaje(g.lectura, g.pas, g.tiq, 1, LECTURA_ANT);
                      if (cu.mal) { s.error = esc(cu.mal); return; }
                      return "confirma";
                    },
                  },
                },
                confirma: {
                  tab: "tarjeta", titulo: "Corregir",
                  html: (s) => {
                    const c = CAMPOS.find((x) => x[0] === s.d.campo);
                    const g = nuevo(s);
                    const cu = cuentaViaje(g.lectura, g.pas, g.tiq, 1, LECTURA_ANT);
                    return '<div class="c-card"><b>¿Corregir el viaje 2?</b><div class="c-dato" style="margin-top:8px"><span>' + c[1] + '</span><b><span class="tachado">' + G[c[2]] + "</span> → " + num(s.d.valor) + "</b></div>" +
                      '<div class="c-dato"><span>Motivo</span><b>' + esc(s.d.motivo) + "</b></div></div>" +
                      (cu.linea ? '<div class="c-cuenta">' + esc(cu.linea) + "</div>" : "") +
                      '<div class="c-botones dos">' + btn("si", "Sí, corregir", { prim: true, toca: true }) + btn("cambiar", "Cambiar") + "</div>";
                  },
                  pista: "El número viejo sale tachado. Si está bien, toca <b>Sí, corregir</b>.",
                  on: { si: () => "fin", cambiar: () => "form" },
                },
                fin: {
                  tab: "tarjeta", titulo: "Mi tarjeta",
                  html: (s) => {
                    const g = nuevo(s);
                    return s.d.campo === "pasajeros"
                      ? guardadoHtml(g, { pasViejo: G.pas, corregido: true }) + viaje1Html()
                      : guardadoHtml(g) + '<div class="c-aviso bien">Corregido por ti ✓</div>' + viaje1Html();
                  },
                  fin: (s) => s.d.campo === "pasajeros" && num(s.d.valor) === 16,
                  pista: (s) => s.d.campo === "pasajeros" && num(s.d.valor) === 16
                    ? "¡Listo! Dice <b>Corregidos por ti</b>. Ese número ya no se puede corregir otra vez: si hay otro error, lo arregla el despachador."
                    : "Quedó corregido, pero en el ejemplo eran los <b>pasajeros</b>, de 15 a <b>16</b>. Toca <b>Empezar de nuevo</b> y prueba otra vez.",
                },
              },
            };
          },
        },
      ],
    },
    // ------------------------------------------------------------ 7
    {
      id: "aeropuerto", cuando: "Esperando turno", titulo: "Mira tu puesto en la fila del aeropuerto",
      corto: "Tu puesto se cuenta en el itinerario con que te despacharon, por ejemplo 3 de 6.",
      intro: "En el aeropuerto el turno va <b>por itinerario</b>: solo cuentan los buses que llegaron por el mismo " +
        "itinerario que tú (por ejemplo Almacentro-Tunel-Aeropuerto), en orden de llegada. Es <b>solo para mirar</b>.",
      pasos: [
        "En <b>Inicio</b>, la tarjeta <b>Mi fila en el aeropuerto</b> dice tu puesto en tu itinerario, por ejemplo <b>3 de 6</b>.",
        "En la pestaña <b>Aeropuerto</b>, arriba sale tu puesto y cuántos buses van antes que tú. Debajo, la fila de tu " +
          "itinerario con tu bus marcado.",
        "Con <b>Ver los otros itinerarios</b> miras los demás. La lista se pone al día cada minuto.",
      ],
      ojo: [
        "Si la pantalla se queda pegada, toca arriba el botón de las <b>dos flechas</b> (Recargar el módulo).",
        "Espera siempre la orden del despachador para salir.",
      ],
      sims: [{
        nombre: "Aeropuerto", escena: "Te despacharon por Almacentro-Tunel-Aeropuerto y llegaste a las 9:41 a. m.: " +
          "quedaste de tercero entre los de ese itinerario.",
        def: () => {
          const ITIN = "Almacentro-Tunel-Aeropuerto";
          const FILA = ["731", "718", BUS, "744", "705", "726"];   // solo los de su itinerario
          return {
            inicio: "inicio", hora: "9:42", datos: () => ({ salen: 0 }),
            estados: {
              inicio: {
                tab: "inicio", titulo: "Inicio", tocaTab: "aeropuerto",
                html: () => inicioHtml({ estado: "Iniciado", alistamiento: "hecho", fila: "3 de 6" }),
                pista: "En Inicio ya ves tu puesto en tu itinerario: <b>3 de 6</b>. Toca la pestaña <b>Aeropuerto</b> para ver la fila.",
                on: { "tab:aeropuerto": () => "lista" },
              },
              lista: {
                tab: "aeropuerto", titulo: "Aeropuerto",
                html: (s) => {
                  const quedan = FILA.slice(s.d.salen);
                  const pos = quedan.indexOf(BUS) + 1;
                  return '<div class="c-fila"><b>Lista de enturnamiento aeropuerto</b><span class="c-chip">Al día</span></div>' +
                    '<div class="c-aviso ' + (pos === 1 ? "bien" : "ambar") + '"><b>' + (pos === 1 ? "¡Sigues tú!" : "Vas " + pos + " de " + quedan.length) + "</b>" +
                    "Despachado por " + ITIN + ". " +
                    (pos === 1 ? "Espera la orden del despachador." : "Cada minuto se pone al día.") + "</div>" +
                    '<ol class="c-fila-lista">' + FILA.map((b, i) => {
                      if (i < s.d.salen) return "";
                      const m = 29 + i * 6;           // llegadas cada 6 minutos desde las 9:29; el 799 (3o) a las 9:41
                      return '<li class="' + (b === BUS ? "yo" : "") + '"><span class="pos">' + (i - s.d.salen + 1) + "</span><span>Bus " + b + (b === BUS ? " · tú" : "") +
                        '</span><span class="c-ayuda">' + (9 + Math.floor(m / 60)) + ":" + String(m % 60).padStart(2, "0") + "</span></li>";
                    }).join("") + "</ol>" +
                    (pos > 1 ? practicaCaja("el tiempo pasa", btn("pasa", "Pasa un minuto ›", { toca: true })) : "");
                },
                fin: (s) => s.d.salen >= 2,
                pista: (s) => s.d.salen >= 2 ? "¡Sigues tú! Así sabes cuándo te toca sin preguntar." : "Toca <b>Pasa un minuto</b> para ver cómo avanzas cuando despachan los de adelante.",
                on: { pasa: (s) => { s.d.salen += 1; } },
              },
            },
          };
        },
      }],
    },
    // ------------------------------------------------------------ 8
    {
      id: "salida", cuando: "Entregas el bus", titulo: "Marca tu SALIDA",
      corto: "Al terminar el turno, en un lugar autorizado. Tu turno queda Cumplido.",
      intro: "La salida se marca igual que la entrada, <b>al terminar el turno</b> y en un lugar autorizado.",
      pasos: [
        "Al entregar el bus, en <b>Almacentro, Nutibara o Terminal Norte</b>, toca <b>Marcar salida</b> en Inicio.",
        "Revisa tu nombre, toca <b>Sí, soy yo · registrar mi SALIDA</b> y <b>Sí, es mi SALIDA</b>.",
        "Toma la foto y toca <b>Registrar asistencia</b>.",
        "En <b>Inicio → Mi jornada de hoy</b> deben estar tu ENTRADA y tu SALIDA. El turno queda <b>Cumplido</b>.",
      ],
      ojo: [
        "La salida se marca <b>mínimo 60 minutos</b> después de la entrada.",
        "Antes de irte, revisa que <b>Mi tarjeta</b> no tenga viajes sin llenar.",
        "Si se te olvida la salida, en tu próxima entrada el portal te pide <b>cerrar el turno</b>: escribe a qué hora terminaste.",
      ],
      sims: [{
        nombre: "Salida", escena: "Entraste a las 5:02 a. m. Prueba marcar la salida a diferentes horas y lugares.",
        def: () => ({
          inicio: "inicio", hora: "1:05", datos: () => ({}),
          estados: {
            inicio: {
              tab: "inicio", titulo: "Inicio",
              html: () => inicioHtml({ estado: "Iniciado", boton: { a: "marcar", t: "Marcar salida", toca: true }, jornada: [["ENTRADA", "5:02 a. m."]] }),
              pista: "Toca <b>Marcar salida</b>.",
              on: { marcar: () => "cuando", "tab:asistencia": () => "cuando" },
            },
            cuando: {
              tab: "asistencia", titulo: "Asistencia",
              html: () => '<div class="c-card"><span class="c-etq">Asistencia</span><div class="sub">Cédula ' + CEDULA + " validada.</div></div>" +
                practicaCaja("¿cuándo y dónde marcas?",
                  btn("op", "5:30 a. m. en Almacentro (media hora después de entrar)", { v: "temprano" }) +
                  btn("op", "1:05 p. m. en el aeropuerto", { v: "lejos" }) +
                  btn("op", "1:05 p. m. en Almacentro, al entregar el bus", { v: "bien" })),
              pista: "Escoge cuándo y dónde vas a marcar la salida. Prueba las tres.",
              on: {
                op: (s, v) => {
                  if (v === "temprano") return "temprano";
                  if (v === "lejos") { s.d.lugar = "aeropuerto"; return "s_ubic"; }
                  s.d.lugar = "almacentro";
                  return "s_ubic";
                },
              },
            },
            temprano: {
              tab: "asistencia", titulo: "Asistencia", hora: "5:30",
              html: () => '<div class="c-aviso mal"><b>Debes esperar al menos 60 minutos antes de registrar la SALIDA</b>Marcaste la entrada a las 5:02 a. m.</div>' + btn("volver", "Volver", { toca: true }),
              pista: "La salida solo se marca <b>una hora o más</b> después de la entrada. Toca <b>Volver</b>.",
              on: { volver: () => "cuando" },
            },
            fin: {
              tab: "inicio", titulo: "Inicio",
              html: () => inicioHtml({ estado: "Cumplido", jornada: [["ENTRADA", "5:02 a. m."], ["SALIDA", "1:05 p. m."]] }),
              pista: "¡Terminaste tu día! El turno dice <b>Cumplido</b> y en Mi jornada están tu ENTRADA y tu SALIDA.",
              fin: true,
            },
          },
        }),
        armar: (def) => {
          const m = estadosDeMarca({ sentido: "SALIDA", hora: "1:05", pre: "s_", final: "fin" });
          // En el aeropuerto, "revisar otra vez" vuelve a escoger cuándo y dónde
          m.s_ubic.on.revisar = () => "cuando";
          Object.assign(def.estados, m);
          return def;
        },
      }],
    },
  ];

  // Los pasos 2 y 8 agregan con armar() los estados de la marca (estadosDeMarca)
  function armarDef(sim) {
    const d = sim.def();
    return sim.armar ? sim.armar(d) : d;
  }

  // ==================================================================== SI ALGO SALE MAL
  const PROBLEMAS = [
    ["Entrar", "Usuario o contraseña incorrectos", "Revisa el usuario (es un correo) y la contraseña, sin espacios. Si sigue, pídelos a tu coordinador."],
    ["Entrar", "No encontramos esa cédula en la nómina ni en la programación", "Revisa que escribiste solo números. Si está bien, avísale a tu coordinador."],
    ["Entrar", "El portal es solo para conductores", "Tu cargo no figura como conductor. Pide en Gestión Humana que revisen tu cargo."],
    ["Entrar", "Este navegador no sirve, o se abrió dentro de WhatsApp o Facebook", "Abre el enlace en Chrome (Android) o Safari (iPhone)."],
    ["Ubicación", "Comparte tu ubicación / La ubicación está bloqueada", "Toca Permitir ubicación. Si la bloqueaste, sigue los pasos que muestra la pantalla para activarla y toca Reintentar."],
    ["Ubicación", "No encontramos tu ubicación", "La ubicación del celular está apagada: préndela. El portal vuelve a intentar solo."],
    ["Ubicación", "Prende el GPS del celular", "Prende la ubicación en modo preciso, sal a cielo abierto y toca Ya llegué: revisar otra vez."],
    ["Asistencia", "Aquí no se puede marcar", "Ve a Almacentro, Nutibara o Terminal Norte (toca Ver en el mapa) y toca Ya llegué: revisar otra vez."],
    ["Asistencia", "Debes esperar al menos 60 minutos antes de registrar la SALIDA", "La salida se marca mínimo una hora después de la entrada."],
    ["Asistencia", "¿Por qué no coincide con el horario?", "Estás marcando lejos de tu hora programada. Escoge el motivo (por ejemplo Relevo llegó tarde o Vehículo varado en ruta), escribe el detalle y toca Registrar con este motivo."],
    ["Asistencia", "Estás entrando en un turno que no es el tuyo", "Escoge el motivo: cambio de turno con un compañero, cubriendo a otro conductor…"],
    ["Asistencia", "Falta cerrar un turno", "Tienes una entrada de otro día sin salida. Escribe a qué hora terminaste ese turno y por qué no marcaste la salida, y toca Cerrar turno y registrar ENTRADA."],
    ["Asistencia", "Jornada de … h: pasa del máximo", "La jornada pasa de 16 horas. Escoge el motivo: la marca se guarda, pero Buk no la recibe y Gestión Humana la revisa."],
    ["Asistencia", "Posible marca duplicada", "Ya marcaste eso hace menos de 30 minutos. No la repitas."],
    ["Asistencia", "Marca guardada (pendiente de Buk)", "También quedó: Gestión Humana la reenvía. No la repitas."],
    ["Asistencia", "Cédula no autorizada para registrar asistencia", "Tu cédula no está activa. Avísale a Gestión Humana."],
    ["Asistencia", "La cámara no abre", "Revisa que el portal tenga permiso de cámara y toca Abrir cámara."],
    ["Alistar", "El alistamiento sale en rojo en Inicio", "Todavía no se ha alistado el bus hoy. Ve a la pestaña Alistar antes de salir."],
    ["Mi tarjeta", "Máximo 19 pasajeros: es el cupo del bus", "Revisa el número: en un viaje caben 19 pasajeros."],
    ["Mi tarjeta", "No cuadra: … son más que los … pasajeros", "Los tiquetes y el personal de la empresa van dentro de los pasajeros. Revisa los números."],
    ["Mi tarjeta", "La cívica es menor que la del viaje anterior", "Revisa el número del validador. Si cambiaron el validador, toca Reportar daño del validador."],
    ["Mi tarjeta", "Mi viaje no aparece en Mi tarjeta", "Cada viaje sale unos minutos después del despacho. Espera un poco y toca Reintentar."],
    ["Mi tarjeta", "Guardé un número mal", "Toca Corregir en ese viaje: una sola vez por número y solo hoy. Después, solo el despachador lo corrige."],
    ["Novedades", "Novedad guardada en el celular", "No había señal: se envía sola cuando vuelva. No cierres el portal mientras sube el video."],
    ["General", "Sin conexión a internet", "Revisa los datos o el wifi. Se quita solo cuando vuelve la señal. Mientras tanto puedes mostrar el código del personal y reportar novedades."],
    ["General", "La pantalla se queda pegada en Asistencia, Aeropuerto o Tiquetes", "Toca arriba el botón de las dos flechas (Recargar el módulo)."],
    ["General", "Versión nueva … lista", "Toca Actualizar. No hay que reinstalar nada."],
    ["General", "Un documento sale Vencido en Inicio", "Avísale a tu coordinador antes de salir."],
  ];

  // ==================================================================== PRUEBA
  const PREGUNTAS = [
    { q: "¿Dónde puedes marcar tu entrada?", o: ["En el aeropuerto, apenas llego", "En Almacentro, Nutibara o Terminal Norte", "En cualquier parte donde tenga internet"], b: 1,
      e: "Solo en esos tres lugares, dentro del cuadro y con el GPS prendido.", paso: "entrada" },
    { q: "Ya te salió «Asistencia registrada». ¿Qué haces?", o: ["Marco otra vez para estar seguro", "Nada: ya quedó", "Marco también en el biométrico"], b: 1,
      e: "Cuando sale «Asistencia registrada», la marca ya quedó y se mandó a Buk. No se repite.", paso: "entrada" },
    { q: "¿Cuándo se alista el bus?", o: ["Antes del primer despacho", "Al final del día", "Solo si el bus está dañado"], b: 0,
      e: "El alistamiento se hace antes de salir en el primer despacho.", paso: "alistar" },
    { q: "En el viaje anterior el validador quedó en 2773 y ahora dice 2775. ¿Cuántas cívicas hubo en tu viaje?", o: ["2775", "2", "0"], b: 1,
      e: "Cívicas = número de ahora − número del viaje anterior: 2775 − 2773 = 2.", paso: "tarjeta" },
    { q: "Llevaste 3 con tiquete, 2 con cívica, 9 en efectivo y 1 gestor registrado. ¿Cuántos pasajeros escribes?", o: ["14", "15", "9"], b: 1,
      e: "En pasajeros van todos, también el personal de la empresa: 3 + 2 + 9 + 1 = 15.", paso: "tarjeta" },
    { q: "¿Cuántos pasajeros puedes escribir como máximo en un viaje?", o: ["19", "25", "No hay tope"], b: 0,
      e: "19 es el cupo del bus. Con más, el portal no deja guardar.", paso: "tarjeta" },
    { q: "Se varó el bus 798 y te pasaron 5 pasajeros. ¿Quién reporta el trasbordo?", o: ["El bus que recibe: yo", "El bus varado", "Nadie"], b: 0,
      e: "El trasbordo lo reporta el bus que recibe los pasajeros: de qué bus venían y cuántos.", paso: "novedad" },
    { q: "Guardaste 15 pasajeros y eran 16. ¿Qué haces?", o: ["Lo dejo así", "Toco Corregir en ese viaje, hoy mismo", "Le sumo uno al viaje siguiente"], b: 1,
      e: "Con Corregir lo arreglas tú, el mismo día y una sola vez por número.", paso: "novedad" },
    { q: "Subió un gestor sin internet. ¿Qué haces?", o: ["No lo registro", "Lo registro yo: leo su código o escribo su cédula y le tomo la foto", "Le cobro el pasaje"], b: 1,
      e: "Lo registras desde Personal de la empresa, con foto. Va en tus pasajeros y no se cobra.", paso: "viaje" },
    { q: "¿Cuándo marcas la salida?", o: ["Apenas marco la entrada", "Al terminar el turno, en un lugar autorizado", "Desde la casa, cuando me acuerde"], b: 1,
      e: "Al entregar el bus, en Almacentro, Nutibara o Terminal Norte, y mínimo 60 minutos después de la entrada.", paso: "salida" },
  ];

  // ==================================================================== PANTALLAS
  function pintarPortada() {
    const n = PASOS.filter((p) => avance.hechos.indexOf(p.id) >= 0).length;
    app.innerHTML =
      '<section class="hero"><span class="kicker">Portal del Conductor</span><h1>Practica tu día de trabajo</h1>' +
      "<p>Aquí aprendes, paso a paso, lo que haces en el portal durante tu turno: desde que llegas a la base hasta que entregas el bus. " +
      "Practicas en un celular de mentira, tocando los mismos botones del portal.</p>" +
      '<div class="nada-real">' + I.escudo + "<div><b>Es una práctica.</b> Aquí no se marca la asistencia, no se guarda la tarjeta y no se manda nada. Puedes equivocarte tranquilo.</div></div>" +
      '<div class="avance"><div class="avance-txt"><span>Tu avance</span><span>' + n + " de " + PASOS.length + ' pasos</span></div><div class="avance-barra"><span style="width:' + (100 * n / PASOS.length) + '%"></span></div></div>' +
      "</section>" +
      '<h2 class="titulo-seccion">Tu día, paso a paso</h2>' +
      '<ol class="dia">' + PASOS.map((p, i) =>
        '<li class="momento' + (avance.hechos.indexOf(p.id) >= 0 ? " hecho" : "") + '"><a href="#/paso/' + p.id + '">' +
          '<span class="num">' + (avance.hechos.indexOf(p.id) >= 0 ? "✓" : i + 1) + "</span>" +
          '<span><span class="cuando">' + p.cuando + '</span><span class="que" style="display:block">' + p.titulo + '</span><span class="detalle" style="display:block">' + p.corto + "</span></span>" +
          '<span class="flecha">' + I.flecha + "</span></a></li>").join("") + "</ol>" +
      '<h2 class="titulo-seccion">Y además</h2>' +
      '<div class="extras"><a class="extra" href="#/problemas"><b>Si algo sale mal</b><span>Los mensajes del portal y qué hacer.</span></a>' +
      '<a class="extra prueba" href="#/prueba"><b>Pon a prueba lo que sabes</b><span>10 preguntas' + (avance.prueba != null ? " · tu mejor nota: " + avance.prueba + " de 10" : "") + "</span></a></div>" +
      '<p style="text-align:center;margin-top:22px"><a class="btn btn-ghost" href="../">Ir al portal de verdad ›</a></p>';
  }

  function pintarPaso(id, simIdx) {
    const i = PASOS.findIndex((p) => p.id === id);
    if (i < 0) { location.hash = "#/"; return; }
    const p = PASOS[i];
    const k = Math.min(simIdx || 0, p.sims.length - 1);
    const sim = p.sims[k];
    const sig = PASOS[i + 1];
    app.innerHTML =
      '<a class="atras" href="#/">‹ Tu día</a>' +
      '<div class="leccion-cabeza"><div class="cuando">Paso ' + (i + 1) + " de " + PASOS.length + " · " + p.cuando + "</div><h1>" + p.titulo + "</h1><p>" + p.intro + "</p></div>" +
      '<section class="caja"><h2>' + I.lista + "Qué haces</h2><ol class=\"pasos\">" + p.pasos.map((x) => "<li>" + x + "</li>").join("") + "</ol>" + (p.extra || "") + "</section>" +
      '<section class="caja"><div class="practica-titulo"><h2>' + I.cel + 'Practícalo</h2><button type="button" class="reiniciar" data-reiniciar>Empezar de nuevo</button></div>' +
      (p.sims.length > 1 ? '<div class="segmento" role="group" aria-label="Qué practicar">' + p.sims.map((x, j) =>
        '<button type="button" data-sim="' + j + '" aria-pressed="' + (j === k) + '">' + x.nombre + "</button>").join("") + "</div>" : "") +
      '<div class="escena">' + sim.escena + "</div>" +
      '<div class="cel-zona" id="sim"></div></section>' +
      '<section class="caja ojo"><h2>' + I.ojo + "Ojo</h2><ul>" + p.ojo.map((x) => "<li>" + x + "</li>").join("") + "</ul></section>" +
      '<div class="pie-leccion">' +
        (i > 0 ? '<a class="btn btn-ghost" href="#/paso/' + PASOS[i - 1].id + '">‹ Anterior</a>' : '<a class="btn btn-ghost" href="#/">‹ Tu día</a>') +
        '<a class="btn btn-primary" data-listo href="' + (sig ? "#/paso/" + sig.id : "#/prueba") + '">' + (sig ? "Listo, sigue ›" : "Listo, a la prueba ›") + "</a>" +
      "</div>";

    if (simActual) simActual.parar();
    simActual = crearSim(document.getElementById("sim"), armarDef(sim), () => marcarHecho(p.id));

    app.querySelector("[data-reiniciar]").onclick = () => simActual.reiniciar();
    app.querySelectorAll("[data-sim]").forEach((b) => { b.onclick = () => pintarPaso(id, Number(b.dataset.sim)); });
    app.querySelector("[data-listo]").onclick = () => marcarHecho(p.id);
  }

  function pintarProblemas() {
    app.innerHTML = '<a class="atras" href="#/">‹ Tu día</a>' +
      '<div class="leccion-cabeza"><div class="cuando">Ayuda</div><h1>Si algo sale mal</h1><p>Escribe una palabra del mensaje que te salió, por ejemplo <b>GPS</b>, <b>cédula</b> o <b>19</b>.</p></div>' +
      '<input class="buscar" type="search" placeholder="Buscar un mensaje…" aria-label="Buscar un mensaje" data-buscar>' +
      '<ul class="problemas" data-lista></ul><p class="sin-resultados" data-nada hidden>No encontramos ese mensaje. Pregúntale a tu coordinador.</p>';
    const lista = app.querySelector("[data-lista]");
    const norm = (t) => String(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    function mostrar(filtro) {
      const f = norm(filtro || "");
      const ver = PROBLEMAS.filter((x) => !f || norm(x.join(" ")).indexOf(f) >= 0);
      lista.innerHTML = ver.map((x) => '<li class="problema"><details><summary><span><span class="donde">' + esc(x[0]) + '</span><span class="msg">' + esc(x[1]) + "</span></span>" + I.abajo + '</summary><div class="resp">' + esc(x[2]) + "</div></details></li>").join("");
      app.querySelector("[data-nada]").hidden = ver.length > 0;
    }
    app.querySelector("[data-buscar]").oninput = (e) => mostrar(e.target.value);
    mostrar("");
  }

  function pintarPrueba() {
    let i = 0, bien = 0;
    const falladas = [];
    function pregunta() {
      if (i >= PREGUNTAS.length) return resultado();
      const P = PREGUNTAS[i];
      app.innerHTML = '<a class="atras" href="#/">‹ Tu día</a>' +
        '<div class="pregunta"><div class="cual">Pregunta ' + (i + 1) + " de " + PREGUNTAS.length + "</div><h2>" + esc(P.q) + '</h2><div class="opciones">' +
        P.o.map((t, j) => '<button type="button" class="opcion" data-o="' + j + '"><span class="letra">' + "ABC"[j] + "</span><span>" + esc(t) + "</span></button>").join("") +
        '</div><div data-explica></div></div>';
      app.querySelectorAll("[data-o]").forEach((b) => {
        b.onclick = () => {
          const j = Number(b.dataset.o);
          const ok = j === P.b;
          if (ok) bien += 1; else falladas.push(P);
          app.querySelectorAll("[data-o]").forEach((x) => {
            x.disabled = true;
            if (Number(x.dataset.o) === P.b) x.classList.add("bien");
            else if (x === b) x.classList.add("mal");
          });
          const pasoN = PASOS.findIndex((p) => p.id === P.paso) + 1;
          app.querySelector("[data-explica]").innerHTML = '<div class="explica ' + (ok ? "bien" : "mal") + '"><b>' + (ok ? "¡Bien!" : "No es esa.") + "</b> " + esc(P.e) +
            (ok ? "" : ' <a href="#/paso/' + P.paso + '">Repasar el paso ' + pasoN + "</a>") + "</div>" +
            '<div style="margin-top:12px"><button type="button" class="btn btn-primary btn-block" data-sig>' + (i + 1 < PREGUNTAS.length ? "Siguiente pregunta ›" : "Ver mi resultado ›") + "</button></div>";
          app.querySelector("[data-sig]").onclick = () => { i += 1; pregunta(); window.scrollTo(0, 0); };
        };
      });
    }
    function resultado() {
      if (avance.prueba == null || bien > avance.prueba) { avance.prueba = bien; guardarAvance(); }
      const pasos = [];
      falladas.forEach((P) => { if (pasos.indexOf(P.paso) < 0) pasos.push(P.paso); });
      app.innerHTML = '<a class="atras" href="#/">‹ Tu día</a>' +
        '<div class="pregunta resultado"><div class="cual">Tu resultado</div><div class="nota">' + bien + " de " + PREGUNTAS.length + "</div>" +
        "<p>" + (bien === PREGUNTAS.length ? "¡Excelente! Ya sabes todo tu día en el portal." : bien >= 7 ? "¡Muy bien! Repasa lo que fallaste y quedas listo." : "Vale la pena repasar. Mira los pasos de abajo y vuelve a intentarlo.") + "</p>" +
        (pasos.length ? "<p><b>Repasa:</b></p><ul>" + pasos.map((id) => { const p = PASOS.find((x) => x.id === id); return '<li><a href="#/paso/' + id + '">' + p.titulo + "</a></li>"; }).join("") + "</ul>" : "") +
        '<div class="pie-leccion"><button type="button" class="btn btn-ghost" data-otra>Otra vez</button><a class="btn btn-primary" href="../">Ir al portal ›</a></div></div>';
      app.querySelector("[data-otra]").onclick = () => pintarPrueba();
    }
    pregunta();
  }

  // ---------------------------------------------------------------- rutas (#/, #/paso/<id>, #/problemas, #/prueba)
  function rutear() {
    if (simActual) { simActual.parar(); simActual = null; }
    const h = location.hash.replace(/^#\/?/, "");
    const partes = h.split("/");
    if (partes[0] === "paso" && partes[1]) pintarPaso(partes[1], 0);
    else if (partes[0] === "problemas") pintarProblemas();
    else if (partes[0] === "prueba") pintarPrueba();
    else pintarPortada();
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", rutear);
  rutear();
})();
