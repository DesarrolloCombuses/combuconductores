/* ==========================================================================
   App del PERSONAL DE LA EMPRESA - Combuses
   --------------------------------------------------------------------------
   Gestoras, auxiliares, mecánicos... cualquier persona vinculada que se sube a
   un bus. Aparte del Portal del Conductor y SIN correo ni clave (el portal pide
   el usuario Combuses, con el que se puede abrir Control):
     1. La cédula, una vez en este celular ("¿Usted es María?").
     2. Al subir, el conductor toca "Registrar personal de la empresa" y su
        celular muestra un código QR que cambia cada 20 segundos:
            CBP1.<bus>.<cédula del conductor>.<hora ms>.<al azar>
     3. Aquí: "Leer código del bus" -> la cámara lo lee -> una selfie ->
        "Registrarme". Queda en el viaje de ese bus: suma en los pasajeros
        pero no se cobra, y en las observaciones queda quién fue.
   Sin señal, el registro queda guardado aquí y se manda solo cuando vuelva.

   Sin sesión, la app solo usa dos funciones de Supabase
   (almacentro/enturnes/sql/personal_empresa.sql, la v10):
     personal_quien_soy          la cédula es de alguien vinculado: primer nombre y cargo
     personal_registrar_subida   el registro, con la selfie y dónde estaba
   No lee ninguna hoja.
   ========================================================================== */
(function () {
  "use strict";

  var VERSION = "g2.0.0";
  var cfg = window.PORTAL_CONFIG || {};
  var RPC_QUIEN_SOY = "personal_quien_soy";
  var RPC_REGISTRAR = "personal_registrar_subida";

  var LS_YO = "personal_app_yo";                 // { dni, nombre, cargo }: quién usa este celular
  var LS_PENDIENTES = "personal_app_pendientes"; // registros sin enviar (sin señal)
  var LS_REGISTROS = "personal_app_registros";   // lo que se ve en "Mis registros de hoy"
  var MAX_PENDIENTES = 30;
  var CODIGO_VENCE_MS = 4 * 60 * 1000;           // el servidor acepta hasta 5 min entre el código y la lectura

  // sinRed: la última consulta no llegó al servidor. navigator.onLine no basta:
  // dice "conectado" con un Wi-Fi sin salida.
  var estado = { yo: null, quien: null, sinRed: false, enviando: false };

  // --------------------------------------------------------------- ayudas
  function $(id) { return document.getElementById(id); }
  function show(el, si) { if (el) el.hidden = !si; }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function capitalizar(texto) {
    return String(texto || "").toLowerCase().replace(/(^|\s)\S/g, function (l) { return l.toUpperCase(); });
  }

  function normalizarDni(texto) { return String(texto || "").replace(/\D/g, ""); }

  function leerJson(clave, porDefecto) {
    try {
      var v = JSON.parse(localStorage.getItem(clave) || "null");
      return v == null ? porDefecto : v;
    } catch (_) { return porDefecto; }
  }

  function guardarJson(clave, valor) {
    try { localStorage.setItem(clave, JSON.stringify(valor)); return true; } catch (_) { return false; }
  }

  // La hora y el día de Colombia (el día de la empresa va de 2:30 a. m. a 2:30 a. m.)
  function horaDe(ms) {
    return new Date(ms).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Bogota" });
  }
  function diaDe(ms) {
    return new Date(ms - 2.5 * 3600 * 1000).toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
  }

  function alAzar(n) {
    var b = crypto.getRandomValues(new Uint8Array(n));
    var s = "";
    for (var i = 0; i < b.length; i++) s += ("0" + b[i].toString(16)).slice(-2);
    return s;
  }

  // ------------------------------------------- Supabase, sin iniciar sesión
  // Solo la llave pública (la misma del portal): Supabase la trata como anónima.
  async function rpc(nombre, args, limiteMs) {
    var control = typeof AbortController === "function" ? new AbortController() : null;
    var corte = setTimeout(function () { if (control) control.abort(); }, limiteMs || 15000);
    try {
      var res = await fetch(cfg.SUPABASE_URL + "/rest/v1/rpc/" + nombre, {
        method: "POST",
        headers: { apikey: cfg.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(args || {}),
        cache: "no-store",
        signal: control ? control.signal : undefined,
      });
      marcarRed(true);
      var datos = null;
      try { datos = await res.json(); } catch (_) { datos = null; }
      if (!res.ok) {
        var e = new Error((datos && (datos.message || datos.hint)) || "El servidor contestó " + res.status);
        e.status = res.status;
        e.code = datos && datos.code;
        throw e;
      }
      return datos;
    } catch (err) {
      if (err && (err.name === "AbortError" || err instanceof TypeError)) {
        marcarRed(false);
        var sinRed = new Error("Sin conexión con el servidor. Revise los datos o el Wi-Fi e intente otra vez.");
        sinRed.sinRed = true;
        throw sinRed;
      }
      throw err;
    } finally {
      clearTimeout(corte);
    }
  }

  function textoError(err) {
    if (!err) return "Algo falló. Intente otra vez.";
    if (err.code === "42501" || err.code === "PGRST202" || err.status === 401 || err.status === 404) {
      return "La app del personal todavía no está habilitada en el servidor. Avísele a control.";
    }
    return err.message || String(err);
  }

  // Si vale la pena intentar: con el teléfono sin red ni se intenta.
  function conRed() { return navigator.onLine !== false; }

  function marcarRed(llego) {
    if (estado.sinRed === !llego) return;
    estado.sinRed = !llego;
    pintarRed();
  }

  function pintarRed() {
    var aviso = $("sinRed");
    if (!aviso) return;
    var pendientes = leerJson(LS_PENDIENTES, []).length;
    if (conRed() && !estado.sinRed) {
      show(aviso, false);
      return;
    }
    aviso.textContent = "Sin internet. Igual puede leer el código del bus: el registro se guarda y se envía cuando vuelva la señal" +
      (pendientes ? " (" + pendientes + " por enviar)." : ".");
    show(aviso, true);
  }

  // -------------------------------------------------------------- vistas
  function mostrarVista(cual) {
    show($("vistaCedula"), cual === "cedula");
    show($("vistaInicio"), cual === "inicio");
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------- 1. ¿quién es? (la cédula)
  function errorCedula(texto) {
    $("cedulaError").textContent = texto || "";
    show($("cedulaError"), !!texto);
  }

  function irACedula() {
    estado.quien = null;
    $("cedulaInput").value = "";
    errorCedula("");
    show($("pasoCedula"), true);
    show($("pasoConfirmar"), false);
    mostrarVista("cedula");
    setTimeout(function () { $("cedulaInput").focus(); }, 120);
  }

  async function alEnviarCedula(ev) {
    ev.preventDefault();
    var dni = normalizarDni($("cedulaInput").value);
    if (dni.length < 5) { errorCedula("Escriba su número de cédula, solo los números."); return; }
    if (!conRed()) { errorCedula("Para empezar hace falta internet. Revise los datos o el Wi-Fi."); return; }
    var btn = $("cedulaBoton");
    btn.disabled = true;
    btn.textContent = "Buscando…";
    errorCedula("");
    try {
      var r = await rpc(RPC_QUIEN_SOY, { p_dni: dni });
      if (!r || r.no_es) {
        errorCedula("Esa cédula no aparece como personal vinculado a la empresa. Revísela; si está bien, avísele a control.");
        return;
      }
      estado.quien = { dni: dni, nombre: r.nombre || "", cargo: r.cargo || "" };
      $("confirmarNombre").textContent = r.nombre || "personal de la empresa";
      $("confirmarCargo").textContent = "Cédula " + dni + " · " + capitalizar(r.cargo || "");
      show($("pasoCedula"), false);
      show($("pasoConfirmar"), true);
    } catch (err) {
      errorCedula(textoError(err));
    } finally {
      btn.disabled = false;
      btn.textContent = "Continuar";
    }
  }

  function confirmarCedula() {
    if (!estado.quien) return;
    estado.yo = estado.quien;
    estado.quien = null;
    guardarJson(LS_YO, estado.yo);
    entrar();
  }

  function cambiarCedula() {
    var pendientes = leerJson(LS_PENDIENTES, []).length;
    var pregunta = pendientes
      ? "Hay " + pendientes + " registro(s) sin enviar de esta cédula: se enviarán igual cuando haya señal. ¿Cambiar la cédula de este celular?"
      : "¿Cambiar la cédula de este celular?";
    if (!window.confirm(pregunta)) return;
    try { localStorage.removeItem(LS_YO); } catch (_) {}
    estado.yo = null;
    irACedula();
  }

  // ------------------------------------------------------------ 2. inicio
  function entrar() {
    var yo = estado.yo;
    $("inicioSaludo").textContent = yo.nombre ? "Hola, " + yo.nombre : "Hola";
    $("inicioCargo").textContent = capitalizar(yo.cargo || "");
    mostrarVista("inicio");
    pintarRegistros();
    pintarRed();
    enviarPendientes();
  }

  function pintarRegistros() {
    var hoy = diaDe(Date.now());
    var lista = leerJson(LS_REGISTROS, []).filter(function (r) { return r.dia === hoy; });
    var ul = $("registrosHoy");
    if (!lista.length) {
      ul.innerHTML = '<li class="registro-nada">Todavía no se ha registrado en ningún bus hoy.</li>';
      return;
    }
    ul.innerHTML = lista.slice().reverse().map(function (r) {
      var chip = r.estado === "ok" ? '<span class="registro-chip" data-estado="ok">Registrado</span>'
        : r.estado === "pendiente" ? '<span class="registro-chip" data-estado="pendiente">Por enviar</span>'
        : '<span class="registro-chip" data-estado="error">No quedó</span>';
      return "<li><span><b>Bus " + escapeHtml(r.bus) + "</b> · " + escapeHtml(horaDe(r.leido)) + "</span>" + chip +
        (r.estado === "error" && r.texto ? '<span class="registro-motivo">' + escapeHtml(r.texto) + "</span>" : "") + "</li>";
    }).join("");
  }

  function anotarRegistro(reg, estadoReg, texto) {
    var lista = leerJson(LS_REGISTROS, []).filter(function (r) { return r.id !== reg.id_local; });
    lista.push({ id: reg.id_local, dia: diaDe(reg.leido_ms), bus: reg.bus, leido: reg.leido_ms, estado: estadoReg, texto: texto || "" });
    guardarJson(LS_REGISTROS, lista.slice(-60));
    pintarRegistros();
  }

  // --------------------------------------- enviar (también lo que quedó sin señal)
  function datosParaEnviar(reg) {
    return {
      p_id_local: reg.id_local, p_dni: reg.dni, p_codigo: reg.codigo, p_leido_en: new Date(reg.leido_ms).toISOString(),
      p_lat: reg.lat, p_lon: reg.lon, p_precision: reg.precision, p_selfie: reg.selfie, p_dispositivo: reg.dispositivo,
    };
  }

  // Devuelve "ok", "pendiente" (sin señal: queda en la cola) o "error" (el servidor no lo aceptó).
  async function enviarUno(reg) {
    try {
      await rpc(RPC_REGISTRAR, datosParaEnviar(reg), 20000);
      anotarRegistro(reg, "ok");
      return { estado: "ok" };
    } catch (err) {
      if (err && err.sinRed) {
        anotarRegistro(reg, "pendiente");
        return { estado: "pendiente" };
      }
      anotarRegistro(reg, "error", textoError(err));
      return { estado: "error", texto: textoError(err) };
    }
  }

  function quitarDeLaCola(id) {
    guardarJson(LS_PENDIENTES, leerJson(LS_PENDIENTES, []).filter(function (r) { return r.id_local !== id; }));
  }

  async function enviarPendientes() {
    if (estado.enviando || !conRed()) return;
    estado.enviando = true;
    try {
      var cola = leerJson(LS_PENDIENTES, []);
      for (var i = 0; i < cola.length; i++) {
        var r = await enviarUno(cola[i]);
        if (r.estado === "pendiente") break;          // sigue sin señal: se intenta después
        quitarDeLaCola(cola[i].id_local);
      }
    } finally {
      estado.enviando = false;
      pintarRed();
    }
  }

  // ------------------------------------------- 3. leer el código del bus
  var lector = { stream: null, timer: null, canvas: null, codigo: null, bus: null, leido: 0, gps: null };
  var selfie = { stream: null, foto: null };

  function apagar(stream) {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
  }

  function errorRegistro(texto) {
    $("registroError").textContent = texto || "";
    show($("registroError"), !!texto);
  }

  function paso(cual) {
    show($("pasoLeer"), cual === "leer");
    show($("pasoSelfie"), cual === "selfie");
    show($("registroResultado"), cual === "resultado");
    $("registroTitulo").textContent = cual === "selfie" ? "Su foto" : cual === "resultado" ? "Registro" : "Leer código del bus";
  }

  // Dónde está (si el celular lo permite): ayuda a control a ver que iba en el bus.
  function pedirUbicacion() {
    lector.gps = null;
    if (!navigator.geolocation) return;
    try {
      navigator.geolocation.getCurrentPosition(function (p) {
        lector.gps = { lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy };
      }, function () {}, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    } catch (_) { /* sin ubicación: se registra igual */ }
  }

  async function abrirLector() {
    lector.codigo = null;
    errorRegistro("");
    paso("leer");
    $("lectorAyuda").textContent = "Apunte la cámara al código del celular del conductor.";
    show($("registroSheet"), true);
    pedirUbicacion();
    if (typeof window.jsQR !== "function") { errorRegistro("No se pudo preparar el lector. Cierre y vuelva a abrir la app."); return; }
    try {
      lector.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
    } catch (_) {
      errorRegistro("No se pudo abrir la cámara. Dele permiso de cámara a esta app y vuelva a intentar.");
      return;
    }
    if ($("registroSheet").hidden) { apagar(lector.stream); lector.stream = null; return; }
    var v = $("lectorVideo");
    v.srcObject = lector.stream;
    try { await v.play(); } catch (_) {}
    lector.canvas = lector.canvas || document.createElement("canvas");
    clearInterval(lector.timer);
    lector.timer = setInterval(mirarFotograma, 250);
  }

  function pararLector() {
    clearInterval(lector.timer);
    lector.timer = null;
    apagar(lector.stream);
    lector.stream = null;
  }

  function mirarFotograma() {
    var v = $("lectorVideo");
    if (!v.videoWidth) return;
    var ancho = Math.min(v.videoWidth, 800);
    var alto = Math.round(v.videoHeight * ancho / v.videoWidth);
    var c = lector.canvas;
    c.width = ancho;
    c.height = alto;
    var ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, ancho, alto);
    var r = window.jsQR(ctx.getImageData(0, 0, ancho, alto).data, ancho, alto, { inversionAttempts: "dontInvert" });
    if (r && r.data) revisarCodigo(r.data.trim());
  }

  // CBP1.<bus>.<cédula del conductor>.<hora ms>.<al azar>
  function revisarCodigo(texto) {
    var p = texto.split(".");
    if (p.length !== 5 || p[0] !== "CBP1" || !/^[A-Za-z0-9-]{1,20}$/.test(p[1]) || !/^\d{12,14}$/.test(p[3])) {
      $("lectorAyuda").textContent = "Ese no es el código del bus. Pídale al conductor que toque «Registrar personal de la empresa».";
      return;
    }
    var ahora = Date.now();
    if (Math.abs(ahora - Number(p[3])) > CODIGO_VENCE_MS) {
      $("lectorAyuda").textContent = "Ese código ya venció (o la hora de un celular está mal). Pídale que lo muestre otra vez.";
      return;
    }
    lector.codigo = texto;
    lector.bus = p[1];
    lector.leido = ahora;
    pararLector();
    if (navigator.vibrate) { try { navigator.vibrate(80); } catch (_) {} }
    abrirSelfie();
  }

  // ---------------------------------------------------------- la selfie
  function pasoFoto(tomada) {
    show($("selfieVideo"), !tomada);
    show($("selfieFoto"), tomada);
    show($("selfieTomar"), !tomada);
    show($("selfieRegistrar"), tomada);
    show($("selfieRepetir"), tomada);
  }

  async function abrirSelfie() {
    paso("selfie");
    selfie.foto = null;
    pasoFoto(false);
    $("selfieBus").innerHTML = "✓ Bus <b>" + escapeHtml(lector.bus) + "</b>. Ahora tómese una foto de frente.";
    try {
      selfie.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 640 } }, audio: false,
      });
      if ($("registroSheet").hidden) { apagar(selfie.stream); selfie.stream = null; return; }
      var v = $("selfieVideo");
      v.srcObject = selfie.stream;
      await v.play();
    } catch (_) {
      errorRegistro("No se pudo abrir la cámara de adelante. Dele permiso de cámara a esta app.");
    }
  }

  function tomarSelfie() {
    var v = $("selfieVideo");
    if (!v.videoWidth) { errorRegistro("La cámara todavía no arranca: espere un segundo."); return; }
    var lado = Math.min(v.videoWidth, v.videoHeight);
    var c = document.createElement("canvas");
    c.width = c.height = 240;   // chica: va en la base, control la ve en la tarjeta del viaje
    c.getContext("2d").drawImage(v, (v.videoWidth - lado) / 2, (v.videoHeight - lado) / 2, lado, lado, 0, 0, 240, 240);
    selfie.foto = c.toDataURL("image/jpeg", 0.72);
    $("selfieFoto").src = selfie.foto;
    errorRegistro("");
    pasoFoto(true);
  }

  async function registrarme() {
    if (!selfie.foto || !lector.codigo || !estado.yo) return;
    var btn = $("selfieRegistrar");
    btn.disabled = true;
    btn.textContent = "Registrando…";
    apagar(selfie.stream);
    selfie.stream = null;
    var reg = {
      id_local: alAzar(16), dni: estado.yo.dni, codigo: lector.codigo, bus: lector.bus, leido_ms: lector.leido,
      lat: lector.gps ? lector.gps.lat : null, lon: lector.gps ? lector.gps.lon : null,
      precision: lector.gps ? Math.round(lector.gps.precision) : null,
      selfie: selfie.foto, dispositivo: String(navigator.userAgent || "").slice(0, 300),
    };
    // Primero a la cola: si se cae la señal a mitad de camino, no se pierde.
    var cola = leerJson(LS_PENDIENTES, []);
    cola.push(reg);
    if (!guardarJson(LS_PENDIENTES, cola.slice(-MAX_PENDIENTES))) {
      guardarJson(LS_PENDIENTES, cola.slice(-5));   // sin espacio: las 5 últimas
    }
    var r = conRed() ? await enviarUno(reg) : (anotarRegistro(reg, "pendiente"), { estado: "pendiente" });
    if (r.estado !== "pendiente") quitarDeLaCola(reg.id_local);
    btn.disabled = false;
    btn.textContent = "Registrarme";
    mostrarResultado(reg, r);
    pintarRed();
  }

  function mostrarResultado(reg, r) {
    paso("resultado");
    var el = $("registroResultado");
    var hora = horaDe(reg.leido_ms);
    if (r.estado === "ok") {
      el.setAttribute("data-ok", "true");
      el.innerHTML = '<p class="resultado-titulo">✓ Quedó registrado</p>' +
        '<p class="resultado-texto">Bus <b>' + escapeHtml(reg.bus) + "</b> · " + escapeHtml(hora) + "</p>" +
        '<p class="resultado-nota">Va en el viaje de ese bus: cuenta como pasajero, pero no se cobra.</p>';
    } else if (r.estado === "pendiente") {
      el.setAttribute("data-ok", "true");
      el.innerHTML = '<p class="resultado-titulo">✓ Quedó guardado</p>' +
        '<p class="resultado-texto">Bus <b>' + escapeHtml(reg.bus) + "</b> · " + escapeHtml(hora) + "</p>" +
        '<p class="resultado-nota">No hay señal: se envía solo cuando vuelva. No tiene que hacer nada más.</p>';
    } else {
      el.setAttribute("data-ok", "false");
      el.innerHTML = '<p class="resultado-titulo">No quedó registrado</p>' +
        '<p class="resultado-texto">' + escapeHtml(r.texto || "") + "</p>";
    }
  }

  function cerrarRegistro() {
    pararLector();
    apagar(selfie.stream);
    selfie.stream = null;
    errorRegistro("");
    show($("registroSheet"), false);
  }

  // ------------------------------------------------------------- arranque
  function iniciar() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-version]"), function (el) {
      el.textContent = VERSION;
    });
    $("cedulaForm").addEventListener("submit", alEnviarCedula);
    $("confirmarSi").addEventListener("click", confirmarCedula);
    $("confirmarNo").addEventListener("click", irACedula);
    $("btnCambiarCedula").addEventListener("click", cambiarCedula);
    $("btnLeerBus").addEventListener("click", abrirLector);
    $("registroCerrar").addEventListener("click", cerrarRegistro);
    $("registroListo").addEventListener("click", cerrarRegistro);
    $("selfieTomar").addEventListener("click", tomarSelfie);
    $("selfieRepetir").addEventListener("click", function () { selfie.foto = null; pasoFoto(false); });
    $("selfieRegistrar").addEventListener("click", registrarme);

    window.addEventListener("online", function () { pintarRed(); enviarPendientes(); });
    window.addEventListener("offline", pintarRed);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        if (!$("registroSheet").hidden) cerrarRegistro();   // no dejar la cámara prendida
        return;
      }
      if (estado.yo) enviarPendientes();
    });
    // Lo que quedó sin señal se reintenta solo cada minuto.
    setInterval(function () {
      if (!document.hidden && leerJson(LS_PENDIENTES, []).length) enviarPendientes();
    }, 60 * 1000);

    var yo = leerJson(LS_YO, null);
    if (yo && yo.dni) {
      estado.yo = yo;
      entrar();
    } else {
      irACedula();
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(function () {});
    }
  }

  iniciar();
})();
