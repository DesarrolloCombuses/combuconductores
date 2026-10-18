/* ==========================================================================
   App del PERSONAL DE LA EMPRESA - Combuses
   --------------------------------------------------------------------------
   Gestoras, auxiliares, mecánicos... cualquier persona vinculada que se sube a
   un bus. Aparte del Portal del Conductor y SIN correo ni clave (el portal pide
   el usuario Combuses, con el que se puede abrir Control):
     1. La cédula, una vez en este celular ("¿Usted es María?").
     2. Al subir, el conductor toca "Registrar personal de la empresa" y su
        celular muestra un código QR que cambia cada 15 segundos:
            CBP1.<bus>.<cédula del conductor>.<hora ms>.<al azar>
     3. Aquí: "Leer código del bus" -> la cámara lo lee -> una selfie ->
        "Registrarme". Queda en el viaje de ese bus: suma en los pasajeros
        pero no se cobra, y en las observaciones queda quién fue.
   Sin señal, el registro queda guardado aquí y se manda solo cuando vuelva.
     4. Mi asistencia (g2.1.0): ENTRADA y SALIDA con una selfie y la ubicación,
        como en el biométrico: queda en la asistencia y va a Buk. Necesita señal
        (la hora es la del servidor). Solo para cédulas ACTIVAS en la base de
        empleados del biométrico: así se habilita a alguien.
        Si quedó una entrada de otro día sin salida: "Se me olvidó marcar la
        salida" (g2.2.0), el cierre declarado del biométrico: dice a qué hora
        salió y por qué; gestión humana lo revisa y lo pasa a Buk.
     5. ¿Cómo se hace?: la guía con dibujos (sale sola la primera vez).

   Sin sesión, la app solo usa dos funciones de Supabase
   (almacentro/enturnes/sql/personal_empresa.sql, la v10):
     personal_quien_soy          la cédula es de alguien vinculado: primer nombre y cargo
     personal_registrar_subida   el registro, con la selfie y dónde estaba
   y la edge function personal-marcar-asistencia (backend-supabase), que hace
   lo del biométrico en el servidor: { accion: "estado" | "marcar" }.
   No lee ninguna hoja.
   ========================================================================== */
(function () {
  "use strict";

  var VERSION = "g2.2.1";
  var cfg = window.PORTAL_CONFIG || {};
  var RPC_QUIEN_SOY = "personal_quien_soy";
  var RPC_REGISTRAR = "personal_registrar_subida";
  var FN_ASISTENCIA = "personal-marcar-asistencia";

  var LS_YO = "personal_app_yo";                 // { dni, nombre, cargo }: quién usa este celular
  var LS_PENDIENTES = "personal_app_pendientes"; // registros sin enviar (sin señal)
  var LS_REGISTROS = "personal_app_registros";   // lo que se ve en "Mis registros de hoy"
  var LS_GUIA = "personal_app_guia_vista";       // ya vio la guía con dibujos
  var LS_MARCA = "personal_app_marca_en_curso";  // { id_local, sentido, dni }: si se cae la señal, se reenvía la misma
  var LS_CIERRE = "personal_app_cierre_en_curso"; // { id_local, dni, entrada }: lo mismo con "se me olvidó la salida"
  var MAX_PENDIENTES = 30;
  var CODIGO_VENCE_MS = 4 * 60 * 1000;           // el servidor acepta hasta 5 min entre el código y la lectura

  // sinRed: la última consulta no llegó al servidor. navigator.onLine no basta:
  // dice "conectado" con un Wi-Fi sin salida.
  var estado = { yo: null, quien: null, sinRed: false, enviando: false };
  // Mi asistencia: lo que dijo el servidor (qué le toca) y la marca que se está haciendo
  var asis = { toca: null, error: null, sinFuncion: false, cargando: false, consultadoEn: 0,
    sentido: null, foto: null, stream: null, gps: null, gpsError: null, idLocal: null, enviando: false, reloj: null,
    idCierre: null, cerrando: false };

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
    consultarAsistencia();
    if (!leerJson(LS_GUIA, false)) abrirGuia();   // la primera vez, la guía sale sola
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

  // ------------------------------------------------- 4. Mi asistencia
  // Como el biométrico, pero el que decide es el servidor (personal-marcar-asistencia):
  // si le toca entrada o salida, la hora, la foto, la asistencia y Buk.
  function hoyCol() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" }); }

  function hora12(hhmm) {
    var p = String(hhmm || "").split(":");
    var h = Number(p[0]), m = Number(p[1]);
    if (!isFinite(h) || !isFinite(m)) return String(hhmm || "");
    return ((h + 11) % 12 + 1) + ":" + ("0" + m).slice(-2) + (h < 12 ? "\u00a0a.\u00a0m." : "\u00a0p.\u00a0m.");   // sin partirse en dos renglones
  }

  var MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  function cuandoFue(fecha, hhmm) {
    var hoy = hoyCol();
    var p = String(fecha || "").split("-");
    var dia = fecha === hoy ? "hoy" : "el " + Number(p[2]) + "-" + MESES[Number(p[1]) - 1];
    return dia + " a las " + hora12(hhmm);
  }

  async function llamarAsistencia(cuerpo, limiteMs) {
    var control = typeof AbortController === "function" ? new AbortController() : null;
    var corte = setTimeout(function () { if (control) control.abort(); }, limiteMs || 20000);
    try {
      var res = await fetch(cfg.SUPABASE_URL + "/functions/v1/" + FN_ASISTENCIA, {
        method: "POST",
        headers: { apikey: cfg.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo),
        cache: "no-store",
        signal: control ? control.signal : undefined,
      });
      marcarRed(true);
      var datos = null;
      try { datos = await res.json(); } catch (_) { datos = null; }
      // Sin la función en el servidor (o con la revisión de sesión prendida) contesta 404 o 401.
      if (res.status === 404 || res.status === 401 || res.status === 403) {
        var e = new Error("La marca de asistencia todavía no está habilitada en el servidor. Avísele a control.");
        e.sinFuncion = true;
        throw e;
      }
      if (!datos || typeof datos !== "object") throw new Error("El servidor contestó " + res.status + ". Intente otra vez.");
      return datos;
    } catch (err) {
      if (err && (err.name === "AbortError" || err instanceof TypeError)) {
        marcarRed(false);
        var sinRed = new Error("Sin conexión con el servidor. Para marcar hace falta internet: revise los datos o el Wi-Fi.");
        sinRed.sinRed = true;
        throw sinRed;
      }
      throw err;
    } finally {
      clearTimeout(corte);
    }
  }

  async function consultarAsistencia() {
    if (!estado.yo || asis.cargando) return;
    asis.cargando = true;
    if (!asis.toca) pintarAsistencia();
    try {
      var r = await llamarAsistencia({ accion: "estado", dni: estado.yo.dni }, 20000);
      asis.sinFuncion = false;
      asis.toca = r.ok ? r : null;
      asis.error = r.ok ? null : { texto: r.mensaje || "No se pudo consultar.", codigo: r.codigo };
    } catch (err) {
      asis.toca = null;
      asis.sinFuncion = !!err.sinFuncion;
      asis.error = { texto: err.message || String(err), sinRed: !!err.sinRed };
    } finally {
      asis.cargando = false;
      asis.consultadoEn = Date.now();
      pintarAsistencia();
    }
  }

  function pintarAsistencia() {
    var t = asis.toca;
    var btn = $("btnMarcar");
    var aviso = $("asisAviso");
    var chip = $("asisBuk");
    var olvido = $("btnOlvido");
    show($("btnAsisOtraVez"), false);
    show(chip, false);
    show(aviso, false);
    show(btn, false);
    show(olvido, false);
    $("cardAsistencia").setAttribute("data-estado", t ? t.siguiente : "nada");
    if (!t) {
      $("asisEstado").textContent = asis.cargando ? "Consultando su asistencia…" : (asis.error ? asis.error.texto : "");
      // Sin señal o el servidor no respondió: se puede volver a consultar. Si la cédula no está activa, no.
      show($("btnAsisOtraVez"), !asis.cargando && !!asis.error && !asis.sinFuncion &&
        (asis.error.sinRed || !asis.error.codigo || asis.error.codigo === "servidor"));
      return;
    }
    var u = t.ultima;
    if (t.siguiente === "salida" && t.abierta) {
      $("asisEstado").innerHTML = "Está adentro: entró <b>" + escapeHtml(cuandoFue(t.abierta.fecha, t.abierta.hora)) + "</b>";   // termina en "m."
    } else if (u && u.sentido === "salida" && u.fecha === hoyCol()) {
      $("asisEstado").innerHTML = "Salió <b>" + escapeHtml(cuandoFue(u.fecha, u.hora)) + "</b>";
    } else {
      $("asisEstado").textContent = "Hoy no ha marcado.";
    }
    if (u) {
      chip.textContent = u.enviado_buk ? "En Buk ✓" : "Buk pendiente";
      chip.setAttribute("data-ok", u.enviado_buk ? "true" : "false");
      show(chip, true);
    }
    // Una entrada de otro día sin salida: "Se me olvidó marcar la salida" (el botón grande si está bloqueado).
    olvido.classList.toggle("btn-marcar", !!t.bloqueo);
    olvido.classList.toggle("btn-ghost", !t.bloqueo);
    show(olvido, !!t.puede_cerrar);
    if (t.bloqueo) {
      aviso.textContent = t.bloqueo.mensaje;
      show(aviso, true);
      return;
    }
    $("btnMarcarTexto").textContent = t.siguiente === "salida" ? "Marcar SALIDA" : "Marcar ENTRADA";
    btn.disabled = !!t.salida_desde;
    show(btn, true);
    if (t.salida_desde) {
      aviso.textContent = "La salida se puede marcar desde las " + hora12(t.salida_desde);   // termina en "m."
      show(aviso, true);
      // A esa hora se vuelve a preguntar solo y el botón se prende.
      var ahora = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Bogota", hour12: false }).split(":");
      var p = String(t.salida_desde).split(":");
      var faltan = ((Number(p[0]) * 60 + Number(p[1])) - (Number(ahora[0]) * 60 + Number(ahora[1])) + 1440) % 1440;
      clearTimeout(asis.reloj);
      asis.reloj = setTimeout(consultarAsistencia, (faltan + 0.5) * 60 * 1000);
    }
  }

  function errorMarca(texto) {
    $("asisError").textContent = texto || "";
    show($("asisError"), !!texto);
  }

  function pasoMarca(cual) {
    show($("asisPasoFoto"), cual === "foto");
    show($("asisResultado"), cual === "resultado");
    show($("asisListo"), cual === "resultado");
  }

  function fotoMarca(tomada) {
    show($("asisVideo"), !tomada);
    show($("asisFoto"), tomada);
    show($("asisTomar"), !tomada);
    show($("asisEnviar"), tomada);
    show($("asisRepetir"), tomada);
  }

  // La ubicación es obligatoria (como en el biométrico).
  function pedirUbicacionMarca() {
    asis.gps = null;
    asis.gpsError = null;
    var el = $("asisUbicacion");
    el.setAttribute("data-estado", "buscando");
    el.textContent = "Buscando su ubicación…";
    if (!navigator.geolocation) {
      asis.gpsError = "Este celular no da la ubicación.";
      el.setAttribute("data-estado", "error");
      el.textContent = asis.gpsError;
      return;
    }
    navigator.geolocation.getCurrentPosition(function (p) {
      asis.gps = { lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy };
      el.setAttribute("data-estado", "ok");
      el.textContent = "✓ Ubicación lista" + (isFinite(p.coords.accuracy) ? " (± " + Math.round(p.coords.accuracy) + " m)" : "");
    }, function () {
      asis.gpsError = "No se pudo saber dónde está: active la ubicación del celular y dele permiso a esta app.";
      el.setAttribute("data-estado", "error");
      el.textContent = asis.gpsError;
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  }

  async function abrirMarca() {
    var t = asis.toca;
    if (!t || t.bloqueo || t.salida_desde) return;
    asis.sentido = t.siguiente;
    asis.foto = null;
    // Si la anterior no alcanzó a llegar (sin señal), se reenvía la misma: el servidor no la repite.
    var enCurso = leerJson(LS_MARCA, null);
    asis.idLocal = enCurso && enCurso.sentido === asis.sentido && enCurso.dni === estado.yo.dni ? enCurso.id_local : alAzar(12);
    var palabra = asis.sentido === "salida" ? "SALIDA" : "ENTRADA";
    $("asisTitulo").textContent = "Marcar " + palabra;
    $("asisEnviar").textContent = "Marcar " + palabra;
    errorMarca("");
    pasoMarca("foto");
    fotoMarca(false);
    show($("asistenciaSheet"), true);
    pedirUbicacionMarca();
    try {
      asis.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 640 } }, audio: false,
      });
      if ($("asistenciaSheet").hidden) { apagar(asis.stream); asis.stream = null; return; }
      var v = $("asisVideo");
      v.srcObject = asis.stream;
      await v.play();
    } catch (_) {
      errorMarca("No se pudo abrir la cámara de adelante. Dele permiso de cámara a esta app.");
    }
  }

  // Liviana, como la del biométrico en el celular: 480 px, WebP (o JPEG si el celular no sabe).
  function tomarFotoMarca() {
    var v = $("asisVideo");
    if (!v.videoWidth) { errorMarca("La cámara todavía no arranca: espere un segundo."); return; }
    var lado = Math.min(v.videoWidth, v.videoHeight);
    var c = document.createElement("canvas");
    c.width = c.height = 480;
    c.getContext("2d").drawImage(v, (v.videoWidth - lado) / 2, (v.videoHeight - lado) / 2, lado, lado, 0, 0, 480, 480);
    var foto = c.toDataURL("image/webp", 0.6);
    if (foto.indexOf("data:image/webp") !== 0) foto = c.toDataURL("image/jpeg", 0.72);
    asis.foto = foto;
    $("asisFoto").src = foto;
    errorMarca("");
    fotoMarca(true);
  }

  async function enviarMarca() {
    if (!asis.foto || !estado.yo || asis.enviando) return;
    if (!asis.gps) {
      errorMarca(asis.gpsError || "Todavía no está la ubicación: espere unos segundos y toque otra vez.");
      if (asis.gpsError) pedirUbicacionMarca();
      return;
    }
    if (!conRed()) { errorMarca("Para marcar hace falta internet. Revise los datos o el Wi-Fi."); return; }
    var btn = $("asisEnviar");
    var texto = btn.textContent;
    asis.enviando = true;
    btn.disabled = true;
    btn.textContent = "Marcando…";
    errorMarca("");
    guardarJson(LS_MARCA, { id_local: asis.idLocal, sentido: asis.sentido, dni: estado.yo.dni });
    try {
      var r = await llamarAsistencia({
        accion: "marcar", dni: estado.yo.dni, sentido: asis.sentido, foto: asis.foto, id_local: asis.idLocal,
        lat: asis.gps.lat, lon: asis.gps.lon, precision: Math.round(asis.gps.precision || 0),
      }, 60000);
      if (r.ok) {
        try { localStorage.removeItem(LS_MARCA); } catch (_) {}
        apagar(asis.stream);
        asis.stream = null;
        mostrarMarca(r);
        consultarAsistencia();
      } else {
        // Ya no le toca eso (marcó en otro lado), o la base no la aceptó: no se reenvía esa.
        if (r.codigo !== "servidor") { try { localStorage.removeItem(LS_MARCA); } catch (_) {} }
        errorMarca(r.mensaje || "No quedó la marca.");
        if (["cambio", "turno_abierto", "muy_pronto", "doble", "tope", "inactivo"].indexOf(r.codigo) >= 0) consultarAsistencia();
      }
    } catch (err) {
      errorMarca(err.sinRed
        ? "No se pudo enviar: sin señal. Toque otra vez cuando haya internet; no queda marcada dos veces."
        : (err.message || String(err)));
    } finally {
      asis.enviando = false;
      btn.disabled = false;
      btn.textContent = texto;
    }
  }

  function mostrarMarca(r) {
    pasoMarca("resultado");
    var el = $("asisResultado");
    var palabra = r.sentido === "salida" ? "SALIDA" : "ENTRADA";
    el.setAttribute("data-ok", r.enviado_buk ? "true" : "espera");
    el.innerHTML = '<img src="' + escapeHtml(asis.foto || "") + '" alt="">' +
      '<p class="resultado-titulo">✓ ' + palabra + " marcada</p>" +
      '<p class="resultado-texto">' + escapeHtml(cuandoFue(r.fecha, r.hora)) + "</p>" +
      '<p class="resultado-nota">' + (r.enviado_buk
        ? "Ya está en la asistencia y en Buk."
        : "Quedó en la asistencia, pero Buk no la recibió: gestión humana la reenvía desde el biométrico. No tiene que marcar otra vez.") +
      "</p>";
  }

  function cerrarMarca() {
    apagar(asis.stream);
    asis.stream = null;
    errorMarca("");
    show($("asistenciaSheet"), false);
  }

  // ------------------------------------- 4b. Se me olvidó marcar la salida
  // El cierre declarado del biométrico: la persona dice a qué hora salió y por qué no marcó.
  // Queda como salida declarada (no va a Buk: gestión humana la revisa en Cierres declarados).
  var MOTIVOS_CIERRE = [
    "Se me olvidó marcar la salida",
    "Terminé fuera de la oficina o de la base",
    "No tenía señal o falló el celular",
    "Apoyo a otro turno por falta de personal",
    "Error en la hora de la entrada",
  ];
  var LIMITE_HORAS = 16, CIERRE_HORAS_MAX = 20;

  function errorCierre(texto) {
    $("cierreError").textContent = texto || "";
    show($("cierreError"), !!texto);
  }

  // Horas del turno si sale a esa hora; si la hora es igual o anterior a la de la entrada, salió al día siguiente.
  function turnoHasta(hhmm) {
    var a = asis.toca && asis.toca.abierta;
    if (!a || !/^\d{2}:\d{2}$/.test(hhmm || "")) return null;
    var e = String(a.hora).split(":").map(Number), s = hhmm.split(":").map(Number);
    var me = e[0] * 60 + e[1], ms = s[0] * 60 + s[1];
    var otroDia = ms <= me;
    var fecha = a.fecha;
    if (otroDia) {
      var d = new Date(a.fecha + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + 1);
      fecha = d.toISOString().slice(0, 10);
    }
    return { fecha: fecha, horas: Math.round(((otroDia ? ms + 1440 : ms) - me) / 6) / 10 };
  }

  function pintarResumenCierre() {
    var hora = $("cierreHora").value;
    var motivo = $("cierreMotivo").value.trim();
    var t = turnoHasta(hora);
    var el = $("cierreResumen");
    if (!t) { el.innerHTML = "<em>Escriba la hora para ver cómo queda.</em>"; return; }
    var p = t.fecha.split("-");
    el.innerHTML = "<strong>Va a quedar así:</strong><ul>" +
      "<li>SALIDA del <b>" + Number(p[2]) + "-" + MESES[Number(p[1]) - 1] + "</b> a las <b>" + escapeHtml(hora12(hora)) + "</b></li>" +
      '<li>Turno de <b' + (t.horas > LIMITE_HORAS ? ' class="cierre-alerta"' : "") + ">" + String(t.horas).replace(".", ",") + " horas</b></li>" +
      (t.horas > LIMITE_HORAS ? '<li class="cierre-alerta">Pasa del máximo de ' + LIMITE_HORAS + " horas de Buk: no entra a nómina y queda como novedad de jornada larga.</li>" : "") +
      "<li>Motivo: " + (motivo ? "<b>" + escapeHtml(motivo) + "</b>" : "<em>falta</em>") + "</li>" +
      "<li>Queda como <b>salida declarada</b> (no biométrica): gestión humana la revisa y la pasa a Buk.</li></ul>";
  }

  function abrirCierre() {
    var t = asis.toca;
    if (!t || !t.puede_cerrar || !t.abierta) return;
    var en = leerJson(LS_CIERRE, null);
    asis.idCierre = en && en.dni === estado.yo.dni && en.entrada === t.abierta.fecha + " " + t.abierta.hora ? en.id_local : alAzar(12);
    var p = t.abierta.fecha.split("-");
    $("cierreTitulo").textContent = "Cerrar el turno del " + Number(p[2]) + "-" + MESES[Number(p[1]) - 1];
    $("cierreLead").innerHTML = "Marcó ENTRADA <b>" + escapeHtml(cuandoFue(t.abierta.fecha, t.abierta.hora)) + "</b> y no marcó la salida.";
    var s = t.sugerencia;
    $("cierreHora").value = s ? s.hora : "";
    if (s) {
      var r = s.fecha_ref.split("-");
      $("cierreAyuda").textContent = "Se propone las " + hora12(s.hora) + " porque es la hora a la que salió el " + Number(r[2]) + "-" +
        MESES[Number(r[1]) - 1] + ", la última vez que entró a una hora parecida (turno de " + String(s.horas).replace(".", ",") +
        " horas). Confírmela o corríjala.";
    } else {
      $("cierreAyuda").textContent = "Escriba la hora a la que terminó de verdad ese día.";
    }
    $("cierreMotivo").value = "";
    $("cierreMotivos").innerHTML = MOTIVOS_CIERRE.map(function (m) {
      return '<button type="button" class="motivo-chip">' + escapeHtml(m) + "</button>";
    }).join("");
    errorCierre("");
    show($("cierrePaso"), true);
    show($("cierreResultado"), false);
    show($("cierreListo"), false);
    pintarResumenCierre();
    show($("cierreSheet"), true);
  }

  async function enviarCierre() {
    if (!estado.yo || asis.cerrando) return;
    var hora = $("cierreHora").value;
    var motivo = $("cierreMotivo").value.trim();
    var t = turnoHasta(hora);
    if (!t) { errorCierre("Escriba la hora a la que salió ese día."); return; }
    if (t.horas > CIERRE_HORAS_MAX) {
      errorCierre("Con esa hora el turno daría " + String(t.horas).replace(".", ",") + " horas. Revise la hora.");
      return;
    }
    if (motivo.length < 4) { errorCierre("Diga por qué no quedó marcada la salida, o elija un motivo."); return; }
    if (!conRed()) { errorCierre("Para cerrar el turno hace falta internet. Revise los datos o el Wi-Fi."); return; }
    var btn = $("cierreEnviar");
    asis.cerrando = true;
    btn.disabled = true;
    btn.textContent = "Cerrando…";
    errorCierre("");
    var a = asis.toca.abierta;
    guardarJson(LS_CIERRE, { id_local: asis.idCierre, dni: estado.yo.dni, entrada: a.fecha + " " + a.hora });
    try {
      var r = await llamarAsistencia({ accion: "cerrar", dni: estado.yo.dni, hora: hora, motivo: motivo, id_local: asis.idCierre }, 30000);
      if (r.ok) {
        try { localStorage.removeItem(LS_CIERRE); } catch (_) {}
        var p = r.fecha.split("-");
        show($("cierrePaso"), false);
        var el = $("cierreResultado");
        el.setAttribute("data-ok", "true");
        el.innerHTML = '<p class="resultado-titulo">✓ Turno cerrado</p>' +
          '<p class="resultado-texto">Salida del ' + Number(p[2]) + "-" + MESES[Number(p[1]) - 1] + " a las " + escapeHtml(hora12(r.hora)) + "</p>" +
          '<p class="resultado-nota">Quedó como salida declarada: gestión humana la revisa y la pasa a Buk. ' +
          "Ahora ya puede marcar la ENTRADA de hoy.</p>";
        show(el, true);
        show($("cierreListo"), true);
        consultarAsistencia();
      } else {
        if (r.codigo !== "servidor") { try { localStorage.removeItem(LS_CIERRE); } catch (_) {} }
        errorCierre(r.mensaje || "No se pudo cerrar el turno.");
        if (r.codigo === "sin_turno" || r.codigo === "cambio") consultarAsistencia();
      }
    } catch (err) {
      errorCierre(err.sinRed
        ? "No se pudo enviar: sin señal. Toque otra vez cuando haya internet; no queda doble."
        : (err.message || String(err)));
    } finally {
      asis.cerrando = false;
      btn.disabled = false;
      btn.textContent = "Cerrar el turno";
    }
  }

  function cerrarHojaCierre() {
    errorCierre("");
    show($("cierreSheet"), false);
  }

  // ------------------------------------------------- 5. ¿Cómo se hace?
  function abrirGuia() {
    show($("guiaSheet"), true);
    var cuerpo = $("guiaSheet").querySelector(".sheet-body");
    if (cuerpo) cuerpo.scrollTop = 0;
  }

  function cerrarGuia() {
    guardarJson(LS_GUIA, true);
    show($("guiaSheet"), false);
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
    $("btnMarcar").addEventListener("click", abrirMarca);
    $("btnAsisOtraVez").addEventListener("click", consultarAsistencia);
    $("asisCerrar").addEventListener("click", cerrarMarca);
    $("asisListo").addEventListener("click", cerrarMarca);
    $("asisTomar").addEventListener("click", tomarFotoMarca);
    $("asisRepetir").addEventListener("click", function () { asis.foto = null; errorMarca(""); fotoMarca(false); });
    $("asisEnviar").addEventListener("click", enviarMarca);
    $("btnOlvido").addEventListener("click", abrirCierre);
    $("cierreCerrar").addEventListener("click", cerrarHojaCierre);
    $("cierreListo").addEventListener("click", cerrarHojaCierre);
    $("cierreEnviar").addEventListener("click", enviarCierre);
    $("cierreHora").addEventListener("input", function () { errorCierre(""); pintarResumenCierre(); });
    $("cierreMotivo").addEventListener("input", function () { errorCierre(""); pintarResumenCierre(); });
    $("cierreMotivos").addEventListener("click", function (ev) {
      var chip = ev.target.closest(".motivo-chip");
      if (!chip) return;
      $("cierreMotivo").value = chip.textContent;   // se puede corregir después
      errorCierre("");
      pintarResumenCierre();
    });
    $("btnGuia").addEventListener("click", abrirGuia);
    $("guiaCerrar").addEventListener("click", cerrarGuia);
    $("guiaListo").addEventListener("click", cerrarGuia);

    window.addEventListener("online", function () {
      pintarRed();
      enviarPendientes();
      if (estado.yo && (!asis.toca || asis.error)) consultarAsistencia();
    });
    window.addEventListener("offline", pintarRed);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        if (!$("registroSheet").hidden) cerrarRegistro();   // no dejar la cámara prendida
        if (!$("asistenciaSheet").hidden && !asis.enviando) cerrarMarca();
        return;
      }
      if (estado.yo) {
        enviarPendientes();
        if (Date.now() - asis.consultadoEn > 60 * 1000) consultarAsistencia();   // marcó en otro lado, o pasó la hora
      }
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
