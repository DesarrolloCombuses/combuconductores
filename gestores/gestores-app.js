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
     Desde la g2.6.0 todo va con un menú abajo: Inicio, Dónde marcar (el mapa
     con los 3 puntos y a cuánto queda cada uno), Cómo se hace (la guía y
     "Si algo falla") y Mi cuenta. Dice que es para los gestores de servicio
     y los gestores de movilidad (la puede usar cualquier persona vinculada).
     Desde la g2.6.1 se llama "Personal" (como el ícono) y dice que es para los
     gestores y los colaboradores administrativos; sigue abierta a cualquier
     persona vinculada.
     6. Noticias de la empresa (g2.4.0): las mismas del Portal del Conductor;
        desde la g2.5.0 salen completas encima al abrir la app (una vez al día),
        con la campana y la página dentro de la app.
     7. Mi código (g2.7.0): si la persona no tiene internet, muestra su código
        (sale sin internet) y el conductor la registra desde su portal con una
        foto (sql v17, personal_por_conductor.sql).
     8. Vuelos (g2.8.0, SOLO GESTORES): los vuelos que llegan hoy y, de cada
        uno, en qué bus se fueron los pasajeros y cuántos (sql v22,
        vuelos_gestores.sql: vuelos_gestor_tablero / _anotar / _quitar, sin
        sesión). Sin señal, lo anotado queda en el celular y se manda después.

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

  var VERSION = "g2.8.0";
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
    if (cual !== "inicio") {   // sin cédula no hay noticia abierta ni ventana
      show($("noticiaPantalla"), false);
      $("noticiaPantalla").innerHTML = "";
      show($("noticiasSheet"), false);
      show($("noticiaVentana"), false);
    }
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
    // g2.8.0: Vuelos (el menú y el botón del inicio) solo para los gestores
    var gestor = esGestor(yo);
    show($("menuVuelos"), gestor);
    show($("btnIrVuelos"), gestor);
    document.querySelector(".menu-gestores").classList.toggle("con-vuelos", gestor);
    vu.datos = null;
    vu.recien = [];
    pintarCuenta();
    mostrarVista("inicio");
    irA("inicio");
    pintarNoticias();
    presentarNoticia();
    pintarRegistros();
    pintarRed();
    enviarPendientes();
    if (gestor) enviarColaVuelos();
    consultarAsistencia();
    if (!leerJson(LS_GUIA, false)) abrirGuia();   // la primera vez, la guía sale sola
  }

  // ------------------------------------------- el menú de abajo (g2.6.0)
  // Pedido del usuario (21-oct-2026): "se ve muy vacía; que tenga un menú que explique, que se vea que es para los
  // gestores de servicio y gestores de movilidad, que explique los puntos donde hacer la marcación". Cuatro partes:
  // Inicio, Dónde marcar, Cómo se hace y Mi cuenta. La noticia del día solo sale en el Inicio.
  var pestana = "inicio";

  function irA(cual) {
    if (!document.querySelector('.pestana[data-pestana="' + cual + '"]')) cual = "inicio";
    if (cual === "vuelos" && !esGestor()) cual = "inicio";   // g2.8.0: Vuelos es solo para los gestores
    pestana = cual;
    Array.prototype.forEach.call(document.querySelectorAll(".pestana"), function (p) {
      p.hidden = p.getAttribute("data-pestana") !== cual;
    });
    Array.prototype.forEach.call(document.querySelectorAll(".menu-item"), function (b) {
      var esta = b.getAttribute("data-ir") === cual;
      b.classList.toggle("activo", esta);
      if (esta) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    if (cual !== "guia") show($("guiaBienvenida"), false);
    window.scrollTo(0, 0);
    if (cual === "puntos") abrirPuntos();
    if (cual === "inicio") presentarNoticia();
    if (cual === "vuelos") { pintarVuelos(); cargarVuelos(); }
  }

  // Mi cuenta: quién usa este celular (la cédula, solo los 4 últimos números).
  function pintarCuenta() {
    var yo = estado.yo || {};
    var nombre = yo.nombre || "";
    $("cuentaInicial").textContent = nombre ? nombre.charAt(0).toUpperCase() : "?";
    $("cuentaNombre").textContent = nombre || "Sin nombre";
    $("cuentaCargo").textContent = capitalizar(yo.cargo || "");
    $("cuentaCedula").textContent = yo.dni ? "Cédula terminada en " + String(yo.dni).slice(-4) : "";
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

  // ------------------------------------------- 3b. Mi código (g2.7.0)
  // Pedido del usuario (22-oct-2026): los gestores dicen que no tienen datos. Si la persona no puede leer el código
  // del bus, muestra éste y el CONDUCTOR lo lee con su portal ("Leer su código") y le toma una foto: el registro lo
  // manda el celular del conductor (personal_registrar_por_conductor, sql v17). Sale sin internet:
  //     CBPP1.<cédula>.<hora ms>.<al azar>.<"Nombre|Cargo" en base64url>
  // El nombre y el cargo solo son para que el conductor los vea sin internet; la base los saca de colaboradores.
  // Cambia cada 30 s y la base acepta cada código una sola vez: una foto del código no sirve para otro registro.
  var MI_CODIGO_MS = 30 * 1000;
  var miCodigo = { reloj: null, fin: 0 };

  function base64url(texto) {
    var b = unescape(encodeURIComponent(texto));
    return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function textoMiCodigo() {
    var yo = estado.yo || {};
    var quien = base64url((String(yo.nombre || "").slice(0, 30) + "|" + String(yo.cargo || "").slice(0, 40)));
    if (quien.length > 120) quien = base64url(String(yo.nombre || "").slice(0, 30));
    return ["CBPP1", normalizarDni(yo.dni), String(Date.now()), alAzar(8), quien].join(".");
  }

  function abrirMiCodigo() {
    if (!estado.yo || !estado.yo.dni) return;
    show($("miCodigoSheet"), true);
    if (typeof window.qrcode !== "function") {
      $("miCodigoQr").innerHTML = '<p class="qr-vencido">No se pudo preparar el código. Cierre y vuelva a abrir la app.</p>';
      return;
    }
    $("miCodigoQuien").textContent = (estado.yo.nombre || "Personal") + " · cédula terminada en " + String(estado.yo.dni).slice(-4);
    pintarMiCodigo();
    clearInterval(miCodigo.reloj);
    miCodigo.reloj = setInterval(contarMiCodigo, 1000);
  }

  function pintarMiCodigo() {
    var q = window.qrcode(0, "M");
    q.addData(textoMiCodigo());
    q.make();
    $("miCodigoQr").innerHTML = q.createImgTag(6, 12, "Mi código para el conductor");
    miCodigo.fin = Date.now() + MI_CODIGO_MS;
    contarMiCodigo();
  }

  function contarMiCodigo() {
    var queda = miCodigo.fin - Date.now();
    if (queda <= 0) { pintarMiCodigo(); return; }
    $("miCodigoBarra").style.width = (100 * queda / MI_CODIGO_MS) + "%";
    $("miCodigoQueda").textContent = "El código cambia solo en " + Math.ceil(queda / 1000) + " s.";
  }

  function cerrarMiCodigo() {
    clearInterval(miCodigo.reloj);
    miCodigo.reloj = null;
    $("miCodigoQr").innerHTML = "";
    show($("miCodigoSheet"), false);
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

  // Solo se marca en estos puntos (19-oct-2026; el Aeropuerto, Exposiciones y la oficina de la Av. Oriental no).
  // Los CUADROS de las geocercas del mapa del enturne (enturnes/zonas.json), no un circulo: pedido del usuario el 19-oct-2026. Iguales a PUNTOS_MARCA de la
  // función personal-marcar-asistencia, que es la que decide; aquí es para avisar antes de la selfie.
  var PUNTOS_MARCA = [
    { nombre: "Almacentro", zona: "Almacentro", poligono: [[6.2355, -75.5719], [6.2373, -75.5719], [6.2373, -75.57], [6.2355, -75.57]] },
    { nombre: "Almacentro", zona: "CC San Diego (bahía de despacho)", poligono: [[6.2364, -75.5709], [6.2369, -75.5709], [6.2369, -75.5702], [6.23745, -75.5702], [6.23745, -75.5689], [6.2364, -75.5689]] },
    { nombre: "Nutibara", zona: "Nutibara", poligono: [[6.2535359, -75.5669743], [6.2531093, -75.5661964], [6.2522721, -75.5667749], [6.2526933, -75.5673874]] },
    { nombre: "Terminal Norte", zona: "Terminal Norte", poligono: [[6.280523, -75.5715718], [6.2803417, -75.5710459], [6.2791579, -75.5714294], [6.2792059, -75.5716682]] },
  ];
  var TOLERANCIA_GPS_M = 20;   // en el borde del cuadro, por el error del GPS
  // Con el GPS apagado el celular igual da una ubicación, pero por wifi o antena: ± 100 m o más. Esa no sirve
  // (pedido del usuario el 19-oct-2026: "el GPS debe estar encendido, si no nos hacen trampa"). Se espera un rato a
  // que el GPS enganche, porque la primera que da el celular suele ser la de wifi.
  var PRECISION_GPS_MAX_M = 100;
  var ESPERA_GPS_MS = 15000;
  var vigiaGps = null;

  function conGps(precision) {
    return isFinite(precision) && Math.round(precision) > 0 && Math.round(precision) < PRECISION_GPS_MAX_M;   // la función la recibe redondeada
  }

  var turnoGps = 0;           // cada búsqueda nueva (o cerrar la hoja) deja sin efecto la anterior

  function soltarGps() {
    turnoGps++;
    if (vigiaGps != null && navigator.geolocation) navigator.geolocation.clearWatch(vigiaGps);
    vigiaGps = null;
  }

  // La mejor ubicación en ESPERA_GPS_MS: apenas haya una con GPS, esa; si no, la mejor que hubo (o el error).
  function ubicacionConGps(mientras, listo, falla) {
    soltarGps();
    var mio = turnoGps, mejor = null, termino = false, reloj;
    function fin(p, err) {
      if (termino) return;
      termino = true;
      clearTimeout(reloj);
      if (mio !== turnoGps) return;       // ya hay otra búsqueda, o se cerró la hoja: esta no pinta nada
      soltarGps();
      if (p) listo(p); else falla(err);
    }
    reloj = setTimeout(function () { fin(mejor, null); }, ESPERA_GPS_MS);
    vigiaGps = navigator.geolocation.watchPosition(function (p) {
      if (mio !== turnoGps) return;
      if (!mejor || !(p.coords.accuracy >= mejor.coords.accuracy)) mejor = p;
      if (conGps(p.coords.accuracy)) fin(p);
      else if (!termino) mientras(p);
    }, function (err) {
      // Sin permiso, o con la ubicación apagada (y nada todavía): no hay nada que esperar.
      if (err && (err.code === 1 || (err.code === 2 && !mejor))) fin(mejor, err);
    }, { enableHighAccuracy: true, timeout: ESPERA_GPS_MS, maximumAge: 0 });
  }

  function dentroDelPoligono(lat, lon, pol) {
    var dentro = false;
    for (var i = 0, j = pol.length - 1; i < pol.length; j = i++) {
      var yi = pol[i][0], xi = pol[i][1], yj = pol[j][0], xj = pol[j][1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) dentro = !dentro;
    }
    return dentro;
  }

  function metrosAlBorde(lat, lon, pol) {
    var kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540, mejor = Infinity;
    for (var i = 0, j = pol.length - 1; i < pol.length; j = i++) {
      var ax = (pol[i][1] - lon) * kx, ay = (pol[i][0] - lat) * ky, bx = (pol[j][1] - lon) * kx, by = (pol[j][0] - lat) * ky;
      var dx = bx - ax, dy = by - ay;
      var u = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      mejor = Math.min(mejor, Math.sqrt(Math.pow(ax + u * dx, 2) + Math.pow(ay + u * dy, 2)));
    }
    return mejor;
  }

  function metrosA(lat, lon, p) {
    return dentroDelPoligono(lat, lon, p.poligono) ? 0 : metrosAlBorde(lat, lon, p.poligono);
  }

  function puntoDeMarca(lat, lon, precision) {
    var holgura = Math.min(isFinite(precision) ? precision : 0, TOLERANCIA_GPS_M);
    var cerca = PUNTOS_MARCA.map(function (p) {
      return { nombre: p.nombre, distancia: metrosA(lat, lon, p) };
    }).sort(function (a, b) { return a.distancia - b.distancia; })[0];
    cerca.dentro = cerca.distancia <= holgura;
    return cerca;
  }

  function distanciaTexto(m) {
    return m >= 1000 ? (m / 1000).toFixed(1).replace(".", ",") + " km" : Math.round(m) + " m";
  }

  // Lejos (o sin GPS): los lugares autorizados, a cuánto queda cada uno, y "revisar otra vez".
  function pintarLugaresMarca(desde) {
    var vistos = {};
    var lugares = PUNTOS_MARCA.filter(function (p) { if (vistos[p.nombre]) return false; vistos[p.nombre] = true; return true; })
      .map(function (p) {
        var lat = 0, lon = 0;
        p.poligono.forEach(function (v) { lat += v[0] / p.poligono.length; lon += v[1] / p.poligono.length; });
        var mismos = PUNTOS_MARCA.filter(function (q) { return q.nombre === p.nombre; });
        return { nombre: p.nombre, lat: lat, lon: lon, mismos: mismos };
      });
    var caja = $("asisLugares");
    caja.innerHTML = '<p class="asis-lugares-titulo">Lugares autorizados para marcar:</p><ul>' +
      lugares.map(function (l) {
        return "<li><b>" + escapeHtml(l.nombre) + "</b>" +
          (desde ? "<span>a " + escapeHtml(distanciaTexto(Math.min.apply(null, l.mismos.map(function (q) {
            return metrosA(desde.lat, desde.lon, q); })))) + "</span>" : "") +
          '<a href="https://www.google.com/maps/search/?api=1&query=' + l.lat + "," + l.lon + '" target="_blank" rel="noopener">Ver en el mapa</a></li>';
      }).join("") + "</ul>" +
      '<button id="asisReintentarGps" class="btn btn-ghost btn-block" type="button">Ya llegué: revisar otra vez</button>';
    show(caja, true);
    $("asisPasoFoto").setAttribute("data-lejos", "true");     // sin la cámara grande: primero el aviso y los lugares
    $("asisReintentarGps").addEventListener("click", pedirUbicacionMarca);
  }

  // La ubicación es obligatoria (como en el biométrico) y tiene que ser en uno de los puntos.
  // La foto no se deja tomar hasta saber que está en uno: así no hace todo para enterarse al final.
  function pedirUbicacionMarca() {
    asis.gps = null;
    asis.gpsError = null;
    $("asisTomar").disabled = true;
    show($("asisLugares"), false);
    $("asisPasoFoto").removeAttribute("data-lejos");
    var el = $("asisUbicacion");
    el.setAttribute("data-estado", "buscando");
    el.textContent = "Buscando su ubicación…";
    if (!navigator.geolocation) {
      asis.gpsError = "Este celular no da la ubicación.";
      el.setAttribute("data-estado", "error");
      el.textContent = asis.gpsError;
      pintarLugaresMarca(null);
      return;
    }
    ubicacionConGps(function (p) {
      el.textContent = "Esperando la señal del GPS (± " + Math.round(p.coords.accuracy) + " m)…";
    }, function (p) {
      if (!conGps(p.coords.accuracy)) {
        asis.gpsError = "Su celular no está usando el GPS: lo ubica con ± " + Math.round(p.coords.accuracy) + " m. " +
          "Prenda la ubicación precisa (GPS) del celular, salga a cielo abierto y toque 'Ya llegué: revisar otra vez'. " +
          "La asistencia solo se marca en Almacentro, Nutibara o Terminal Norte, con el GPS prendido.";
        el.setAttribute("data-estado", "error");
        el.textContent = asis.gpsError;
        pintarLugaresMarca(null);
        return;
      }
      var punto = puntoDeMarca(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
      if (!punto.dentro) {
        asis.gpsError = "Está a " + distanciaTexto(punto.distancia) + " de " + punto.nombre +
          ". La asistencia solo se marca en Almacentro, Nutibara o Terminal Norte.";
        el.setAttribute("data-estado", "error");
        el.textContent = asis.gpsError;
        pintarLugaresMarca({ lat: p.coords.latitude, lon: p.coords.longitude });
        return;
      }
      asis.gps = { lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy };
      $("asisTomar").disabled = false;
      el.setAttribute("data-estado", "ok");
      el.textContent = "✓ Está en " + punto.nombre + (isFinite(p.coords.accuracy) ? " (± " + Math.round(p.coords.accuracy) + " m)" : "");
    }, function () {
      asis.gpsError = "No se pudo saber dónde está: active la ubicación del celular y dele permiso a esta app.";
      el.setAttribute("data-estado", "error");
      el.textContent = asis.gpsError;
      pintarLugaresMarca(null);
    });
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
    soltarGps();
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

  // ------------------------------------------------- 5. Cómo se hace
  // Desde la g2.6.0 es una parte del menú (antes, una hoja). La primera vez sale sola, con la bienvenida; "Entendido"
  // vuelve al inicio, y ahí sale la noticia (la guía va antes que la noticia).
  function abrirGuia() {
    var primeraVez = !leerJson(LS_GUIA, false);
    irA("guia");
    show($("guiaBienvenida"), primeraVez);
  }

  function cerrarGuia() {
    guardarJson(LS_GUIA, true);
    irA("inicio");
  }

  // ------------------------------------------------ 5b. Dónde marcar (g2.6.0)
  // Los mismos cuadros de PUNTOS_MARCA que deciden la marca, en un mapa (Leaflet, el mismo del enturne del portal; se
  // carga la primera vez que se abre esta parte), qué es cada punto, a cuánto queda y "Cómo llegar" (Google Maps).
  // La ubicación se pide solo al tocar "¿A cuánto estoy?".
  var LEAFLET = "https://unpkg.com/leaflet@1.9.4/dist/";
  var PUNTOS_INFO = [
    { nombre: "Almacentro", detalle: "La sede de Almacentro y la bahía de despacho del CC San Diego." },
    { nombre: "Nutibara", detalle: "La bahía de Nutibara. La oficina de la Av. Oriental no cuenta." },
    { nombre: "Terminal Norte", detalle: "La Terminal del Norte." },
  ];
  var ICONO_PUNTO = '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
  var mapa = { carga: null, mapa: null, capas: {}, todos: null, yo: null, marcaYo: null, circuloYo: null };

  function cuadrosDe(nombre) { return PUNTOS_MARCA.filter(function (p) { return p.nombre === nombre; }); }

  function centroDe(nombre) {
    var lat = 0, lon = 0, n = 0;
    cuadrosDe(nombre).forEach(function (p) {
      p.poligono.forEach(function (v) { lat += v[0]; lon += v[1]; n++; });
    });
    return { lat: (lat / n).toFixed(6), lon: (lon / n).toFixed(6) };
  }

  function pintarListaPuntos() {
    var yo = mapa.yo;
    $("listaPuntos").innerHTML = PUNTOS_INFO.map(function (p) {
      var c = centroDe(p.nombre);
      var chip = "";
      if (yo && conGps(yo.precision)) {
        var dist = Math.min.apply(null, cuadrosDe(p.nombre).map(function (q) { return metrosA(yo.lat, yo.lon, q); }));
        var dentro = dist <= Math.min(yo.precision, TOLERANCIA_GPS_M);
        chip = '<span class="punto-distancia" data-dentro="' + dentro + '">' +
          (dentro ? "Usted está aquí" : "a " + escapeHtml(distanciaTexto(dist))) + "</span>";
      }
      return '<li class="punto" data-punto="' + escapeHtml(p.nombre) + '">' +
        '<span class="punto-icono">' + ICONO_PUNTO + "</span>" +
        '<div class="punto-texto"><b>' + escapeHtml(p.nombre) + "</b><small>" + escapeHtml(p.detalle) + "</small></div>" +
        chip +
        '<div class="punto-acciones">' +
          '<button class="btn btn-ghost btn-sm" type="button" data-ver-punto="' + escapeHtml(p.nombre) + '">Ver en el mapa</button>' +
          '<a class="btn btn-ghost btn-sm" href="https://www.google.com/maps/dir/?api=1&destination=' + c.lat + "," + c.lon +
            '" target="_blank" rel="noopener">Cómo llegar</a>' +
        "</div>" +
      "</li>";
    }).join("");
  }

  function cargarLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (!mapa.carga) {
      mapa.carga = new Promise(function (ok, mal) {
        var css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = LEAFLET + "leaflet.css";
        document.head.appendChild(css);
        var s = document.createElement("script");
        s.src = LEAFLET + "leaflet.js";
        s.onload = function () { ok(window.L); };
        s.onerror = function () { mapa.carga = null; s.remove(); mal(new Error("No se pudo cargar el mapa")); };
        document.head.appendChild(s);
      });
    }
    return mapa.carga;
  }

  function abrirPuntos() {
    $("btnDondeEstoy").disabled = false;
    pintarListaPuntos();
    if (mapa.mapa) {
      setTimeout(function () { mapa.mapa.invalidateSize(); }, 60);
      return;
    }
    var caja = $("mapaPuntos");
    cargarLeaflet().then(function (L) {
      if (mapa.mapa) return;
      caja.innerHTML = "";
      var m = L.map(caja, { scrollWheelZoom: false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
      var vertices = [];
      PUNTOS_MARCA.forEach(function (p) {
        var capa = L.polygon(p.poligono, { color: "#0b6b3a", weight: 2, fillColor: "#1fae5b", fillOpacity: 0.35 }).addTo(m);
        if (!mapa.capas[p.nombre]) {
          mapa.capas[p.nombre] = [];
          capa.bindTooltip(p.nombre, { permanent: true, direction: "top", className: "mapa-rotulo" });
        }
        mapa.capas[p.nombre].push(capa);
        vertices = vertices.concat(p.poligono);
      });
      mapa.todos = L.latLngBounds(vertices);
      m.fitBounds(mapa.todos, { padding: [28, 28] });
      mapa.mapa = m;
      ponerYoEnMapa();
    }, function () {
      caja.innerHTML = '<p class="mapa-aviso">Sin internet no se ve el mapa. Los tres puntos están aquí abajo.</p>';
    });
  }

  function verPunto(nombre) {
    var capas = mapa.capas[nombre];
    if (!mapa.mapa || !capas) return;
    var caja = window.L.latLngBounds([]);
    capas.forEach(function (c) { caja.extend(c.getBounds()); });
    mapa.mapa.fitBounds(caja, { padding: [30, 30], maxZoom: 17 });
    $("mapaPuntos").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function ponerYoEnMapa() {
    if (!mapa.mapa || !mapa.yo) return;
    var L = window.L, aqui = [mapa.yo.lat, mapa.yo.lon];
    if (mapa.marcaYo) {
      mapa.marcaYo.setLatLng(aqui);
      mapa.circuloYo.setLatLng(aqui).setRadius(mapa.yo.precision);
    } else {
      mapa.circuloYo = L.circle(aqui, { radius: mapa.yo.precision, color: "#2563eb", weight: 1, fillOpacity: 0.12 }).addTo(mapa.mapa);
      mapa.marcaYo = L.circleMarker(aqui, { radius: 8, color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1 })
        .addTo(mapa.mapa).bindTooltip("Usted", { permanent: true, direction: "right", className: "mapa-rotulo-yo" });
    }
    var vista = L.latLngBounds(mapa.todos.getSouthWest(), mapa.todos.getNorthEast()).extend(aqui);
    mapa.mapa.fitBounds(vista, { padding: [28, 28], maxZoom: 16 });
  }

  function estadoPuntos(estadoTxt, texto) {
    var el = $("puntosEstado");
    el.setAttribute("data-estado", estadoTxt);
    el.textContent = texto;
    show(el, true);
  }

  function dondeEstoy() {
    if (!navigator.geolocation) { estadoPuntos("error", "Este celular no da la ubicación."); return; }
    var btn = $("btnDondeEstoy");
    btn.disabled = true;
    estadoPuntos("buscando", "Buscando su ubicación…");
    ubicacionConGps(function (p) {
      estadoPuntos("buscando", "Esperando el GPS (± " + Math.round(p.coords.accuracy) + " m)…");
    }, function (p) {
      btn.disabled = false;
      var lat = p.coords.latitude, lon = p.coords.longitude, precision = p.coords.accuracy;
      mapa.yo = { lat: lat, lon: lon, precision: precision };
      var cerca = puntoDeMarca(lat, lon, precision);
      if (!conGps(precision)) {
        estadoPuntos("error", "El GPS no está dando bien su ubicación (± " + Math.round(precision) + " m). Encienda la " +
          "ubicación del celular o salga a cielo abierto, y toque otra vez.");
      } else if (cerca.dentro) {
        estadoPuntos("ok", "Usted está en " + cerca.nombre + ": aquí sí puede marcar.");
      } else {
        estadoPuntos("lejos", "Usted está a " + distanciaTexto(cerca.distancia) + " de " + cerca.nombre +
          ", el punto más cercano. Aquí no puede marcar.");
      }
      pintarListaPuntos();
      ponerYoEnMapa();
    }, function (err) {
      btn.disabled = false;
      estadoPuntos("error", err && err.code === 1
        ? "La app no tiene permiso de ubicación. Actívelo en el celular y toque otra vez."
        : "No se pudo saber dónde está. Encienda la ubicación (GPS) y toque otra vez.");
    });
  }

  // ------------------------------------------- 6. noticias de la empresa (g2.4.0)
  // Las mismas del Portal del Conductor (cfg.NOTICIAS, de ../js/portal-config.js) y con sus mismos estilos. Desde la
  // g2.5.0, al abrir la app la noticia sale ENCIMA, completa (imagen, texto, plazo y botón), una vez al día: "Ahora
  // no" o la X la dejan para mañana, el botón la abre aquí dentro y "Ya los inscribí…" la quita. La campana junto al
  // saludo la muestra cuando quieran. Al abrirla, su página sale a pantalla completa con "Volver" y la cédula de este
  // celular ya escrita (llenarCedula; solo en el mismo sitio). Lo quitado o presentado hoy queda en el teléfono con
  // las mismas llaves del portal.
  var NOTICIAS_OCULTAS = "portal_noticias_ocultas";
  var NOTICIAS_PRESENTADAS = "portal_noticias_presentadas";
  var presentarTimer = null;

  function noticiasVigentes() {
    var ahora = Date.now();
    var ocultas = leerJson(NOTICIAS_OCULTAS, []) || [];
    return (cfg.NOTICIAS || []).filter(function (x) {
      return x && x.id && x.enlace && ocultas.indexOf(x.id) < 0 &&
        (!x.desde || Date.parse(x.desde) <= ahora) && (!x.hasta || ahora <= Date.parse(x.hasta));
    });
  }

  function quedaDeNoticia(x) {
    if (!x.hasta) return "";
    var dias = Math.ceil((Date.parse(x.hasta) - Date.now()) / 86400000);
    return dias <= 1 ? "último día" : "quedan " + dias + " días";
  }

  // Las rutas de la configuración son las del portal (./assets/...): aquí, una carpeta más adentro.
  function rutaDelPortal(ruta) { return /^\.\//.test(ruta || "") ? "../" + ruta.slice(2) : ruta; }

  // La tarjeta de una noticia (la misma del portal). enVentana: con la X y "Ahora no".
  function tarjetaNoticia(x, enVentana) {
    var id = escapeHtml(x.id);
    var plazo = [x.plazo, quedaDeNoticia(x)].filter(Boolean).join(" · ");
    var abrir = x.abrirAparte
      ? '<a class="btn btn-primary btn-block" href="' + escapeHtml(x.enlace) + '" target="_blank" rel="noopener">' +
          escapeHtml(x.boton || "Ver la noticia") + "</a>"
      : '<button class="btn btn-primary btn-block" type="button" data-abrir-noticia="' + id + '">' +
          escapeHtml(x.boton || "Ver la noticia") + "</button>";
    return '<article class="card noticia" data-tema="' + escapeHtml(x.tema || "") + '" data-noticia="' + id + '">' +
      (enVentana
        ? '<button class="noticia-cerrar" type="button" data-noticia-luego aria-label="Cerrar: ahora no"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>'
        : "") +
      (x.imagen
        ? '<div class="noticia-foto"' + (x.abrirAparte ? "" : ' data-abrir-noticia="' + id + '"') + ' aria-hidden="true">' +
            '<img src="' + escapeHtml(rutaDelPortal(x.imagen)) + '" alt="" width="640" height="394" decoding="async"></div>'
        : "") +
      '<div class="card-body">' +
        '<p class="noticia-etiqueta">' + escapeHtml(x.etiqueta || "Noticia") + "</p>" +
        '<h3 class="noticia-titulo">' + escapeHtml(x.titulo) + "</h3>" +
        '<p class="noticia-texto">' + escapeHtml(x.texto) + "</p>" +
        (plazo
          ? '<p class="noticia-plazo"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><circle cx="12" cy="12" r="9"/>' +
              '<path d="M12 7v5l3 2"/></svg><span>' + escapeHtml(plazo) + "</span></p>"
          : "") +
        abrir +
        (enVentana ? '<button class="btn btn-ghost btn-block noticia-luego" type="button" data-noticia-luego>Ahora no</button>' : "") +
        (x.ocultar
          ? '<button class="btn-link btn-link-muted noticia-ocultar" type="button" data-ocultar-noticia="' + id + '">' +
              escapeHtml(x.ocultar) + "</button>"
          : "") +
      "</div>" +
    "</article>";
  }

  // La campana y su hoja.
  function pintarNoticias() {
    var lista = noticiasVigentes();
    $("noticias").innerHTML = lista.map(function (x) { return tarjetaNoticia(x, false); }).join("");
    var campana = $("btnNoticias");
    show(campana, lista.length > 0);
    $("noticiasCuenta").textContent = lista.length ? String(lista.length) : "";
    campana.setAttribute("aria-label", lista.length === 1 ? "Noticias: hay 1" : "Noticias: hay " + lista.length);
    if (!lista.length) show($("noticiasSheet"), false);
  }

  // La ventana: la primera noticia vigente que hoy no se haya presentado, en el inicio y sin otra hoja abierta.
  function presentarNoticia() {
    clearTimeout(presentarTimer);
    presentarTimer = setTimeout(function () {
      var ventana = $("noticiaVentana");
      if (!ventana.hidden || $("vistaInicio").hidden || pestana !== "inicio" || !$("noticiaPantalla").hidden) return;
      var ocupado = ["registroSheet", "asistenciaSheet", "cierreSheet", "noticiasSheet"]
        .some(function (id) { return !$(id).hidden; });
      if (ocupado) return;
      var hoy = hoyCol();
      var vistas = leerJson(NOTICIAS_PRESENTADAS, {}) || {};
      var x = noticiasVigentes().find(function (n) { return vistas[n.id] !== hoy; });
      if (!x) return;
      $("noticiaVentanaCuerpo").innerHTML = tarjetaNoticia(x, true);
      show(ventana, true);
    }, 900);
  }

  // Cierra la ventana y la deja quieta por hoy.
  function cerrarVentanaNoticia() {
    var art = $("noticiaVentanaCuerpo").querySelector(".noticia");
    var id = art && art.getAttribute("data-noticia");
    if (id) {
      var vistas = leerJson(NOTICIAS_PRESENTADAS, {}) || {};
      vistas[id] = hoyCol();
      guardarJson(NOTICIAS_PRESENTADAS, vistas);
    }
    show($("noticiaVentana"), false);
    return id;
  }

  function ocultarNoticia(id) {
    var ocultas = leerJson(NOTICIAS_OCULTAS, []) || [];
    if (ocultas.indexOf(id) < 0) ocultas.push(id);
    guardarJson(NOTICIAS_OCULTAS, ocultas);
    pintarNoticias();
  }

  // La noticia a pantalla completa. Si ya estaba abierta la misma, sigue como la dejó.
  function abrirNoticia(idNoticia) {
    var x = noticiasVigentes().find(function (n) { return n.id === idNoticia && !n.abrirAparte; });
    if (!x) return;
    show($("noticiasSheet"), false);
    var pantalla = $("noticiaPantalla");
    var frame = pantalla.querySelector("iframe");
    if (!frame || frame.getAttribute("data-noticia") !== x.id) {
      var nombre = x.corto || x.titulo;
      pantalla.innerHTML =
        '<div class="externo-barra noticia-barra">' +
          '<button class="btn btn-ghost btn-sm" type="button" data-cerrar-noticia>' +
            '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>Volver</button>' +
          '<span class="noticia-barra-nombre">' + escapeHtml(nombre) + "</span>" +
        "</div>" +
        '<div class="module-loading"><div class="boot-spinner"></div><p>Abriendo ' + escapeHtml(nombre.toLowerCase()) + "…</p></div>";
      frame = document.createElement("iframe");
      frame.id = "frame-noticia";
      frame.title = nombre;
      frame.setAttribute("data-noticia", x.id);
      frame.setAttribute("allow", x.permisos || "fullscreen");
      frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      frame.src = x.enlace;
      frame.addEventListener("load", function () {
        var cargando = pantalla.querySelector(".module-loading");
        if (cargando) cargando.remove();
        llenarCedulaEnNoticia(frame, x);
      });
      pantalla.appendChild(frame);
    }
    show(pantalla, true);
  }

  function cerrarNoticia() {
    show($("noticiaPantalla"), false);
  }

  // Como en el portal: SOLO la cédula de este celular, en el campo que diga la noticia, como si la tecleara (el
  // formulario de Halloween trae el nombre y el cargo). Si la página es de otro sitio, el navegador no deja y no
  // pasa nada: la escribe la persona.
  function llenarCedulaEnNoticia(frame, x) {
    var dni = estado.yo && estado.yo.dni;
    if (!x.llenarCedula || !dni) return;
    try {
      var doc = frame.contentDocument;
      var campo = doc && doc.querySelector(x.llenarCedula);
      if (!campo || campo.value) return;
      campo.value = String(dni);
      campo.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
      (campo.form || campo).scrollIntoView({ block: "start" });
    } catch (_) { /* otro sitio: la escribe la persona */ }
  }

  function initNoticias() {
    function cerca(ev, sel) { return ev.target.closest ? ev.target.closest(sel) : null; }
    $("btnNoticias").addEventListener("click", function () {
      pintarNoticias();
      show($("noticiasSheet"), true);
    });
    $("noticiasCerrar").addEventListener("click", function () { show($("noticiasSheet"), false); });
    $("noticiasSheet").addEventListener("click", function (ev) {
      if (ev.target === $("noticiasSheet")) { show($("noticiasSheet"), false); return; }
      var abrir = cerca(ev, "[data-abrir-noticia]");
      if (abrir) { abrirNoticia(abrir.getAttribute("data-abrir-noticia")); return; }
      var b = cerca(ev, "[data-ocultar-noticia]");
      if (b) ocultarNoticia(b.getAttribute("data-ocultar-noticia"));
    });
    // La ventana: el botón la abre, "Ahora no", la X o tocar afuera la dejan para mañana.
    $("noticiaVentana").addEventListener("click", function (ev) {
      var abrir = cerca(ev, "[data-abrir-noticia]");
      var ocultar = cerca(ev, "[data-ocultar-noticia]");
      var aparte = cerca(ev, "a[target=_blank]");
      if (ev.target !== $("noticiaVentana") && !abrir && !ocultar && !aparte && !cerca(ev, "[data-noticia-luego]")) return;
      var id = cerrarVentanaNoticia();
      if (abrir) abrirNoticia(abrir.getAttribute("data-abrir-noticia"));
      else if (ocultar) ocultarNoticia(id);
    });
    $("noticiaPantalla").addEventListener("click", function (ev) {
      if (cerca(ev, "[data-cerrar-noticia]")) cerrarNoticia();
    });
    // Que se quiten solas al terminar el plazo, aunque la app quede abierta.
    setInterval(function () { if (estado.yo) pintarNoticias(); }, 10 * 60 * 1000);
  }

  // ------------------------------------------- 8. VUELOS (g2.8.0, solo gestores)
  // Pedido del usuario (11-nov-2026): "que los vuelos queden en una tabla y que los gestores les pongan los pasajeros
  // y los vehículos en los cuales son despachados". De cada vuelo que llega: en qué bus se fueron y cuántos (1 a 19
  // por bus; si se fueron en dos buses, son dos anotaciones). Sin sesión, con 3 funciones (sql v22):
  //   vuelos_gestor_tablero  los vuelos de hoy, lo anotado y los buses del aeropuerto (la fila y los que bajaron)
  //   vuelos_gestor_anotar   vuelo + bus + pasajeros (el cupo de 19 por bus lo revisa también el servidor)
  //   vuelos_gestor_quitar   lo que la misma persona anotó, en las 12 horas siguientes
  // Sin señal, lo anotado queda en el celular (LS_VUELOS_COLA) y se manda solo cuando vuelva.
  var RPC_VUELOS = "vuelos_gestor_tablero";
  var RPC_ANOTAR = "vuelos_gestor_anotar";
  var RPC_QUITAR_VUELO = "vuelos_gestor_quitar";
  var LS_VUELOS_COLA = "personal_app_vuelos_cola";     // anotaciones sin enviar (de cualquier cédula)
  var LS_VUELOS_ULTIMO = "personal_app_vuelos_ultimo"; // la última lista que llegó, para verla sin señal
  var LS_VUELOS_FALLAS = "personal_app_vuelos_fallas"; // lo que el servidor no aceptó al mandarlo después
  var CUPO_BUS = 19;
  var VENTANA_CUPO_MS = 90 * 60 * 1000;                // cuenta lo anotado en el bus hora y media antes o después
  var AHORA_ANTES_MS = 90 * 60 * 1000;                 // "Ahora": los que llegaron hace hora y media...
  var AHORA_DESPUES_MS = 60 * 60 * 1000;               // ...y los que llegan en la próxima hora
  var SALIERON_MS = 60 * 60 * 1000;                    // en la hoja: los buses que bajaron en la última hora...
  var MAX_SALIERON = 6, MAX_FILA = 8;                  // ...y los primeros de la fila (los demás, escritos)
  var DESTINOS = { "4501": "Terminal Norte", "4503": "Nutibara", "4507": "Almacentro" };
  var ESTADOS_VUELO = {
    LD: { tipo: "ok", texto: "Aterrizó" }, OT: { tipo: "", texto: "A tiempo" }, ER: { tipo: "info", texto: "En camino" },
    DL: { tipo: "espera", texto: "Demorado" }, CN: { tipo: "mal", texto: "Cancelado" }, PR: { tipo: "", texto: "Programado" },
  };
  // Cada anotación se junta con la salida (el despacho del aeropuerto) de ese bus más cercana: de una hora antes de
  // anotar (lo anotó después de que salió) a hora y media después (lo anotó mientras se llenaba en la fila).
  var SALIO_ANTES_MS = 60 * 60 * 1000;
  var SALE_DESPUES_MS = 90 * 60 * 1000;
  var MOSTRAR_SALIDAS = 15;                            // "Buses que salen": las últimas 15 (las demás, con un botón)
  var ICONO_BUS = '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><rect x="4" y="3" width="16" height="15" rx="2.5"/>' +
    '<path d="M4 11h16M7.5 21v-3M16.5 21v-3"/><circle cx="8" cy="14.5" r=".6"/><circle cx="16" cy="14.5" r=".6"/></svg>';
  var vu = { datos: null, cargadoEn: 0, cargando: false, error: null, vista: "ahora", buscar: "", abierto: null,
    bus: "", busT: null, recien: [], guardando: false, enviando: false, todasSalidas: false, busAbierto: null };

  function esGestor(yo) { return /GESTOR/i.test(String(((yo || estado.yo) || {}).cargo || "")); }
  function claveVuelo(v) { return String(v.fecha) + "|" + String(v.vuelo || "").toUpperCase(); }
  function msDe(iso) { var t = Date.parse(iso || ""); return isNaN(t) ? null : t; }
  function sinTildes(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
  function normalizarBus(s) { return String(s || "").toUpperCase().replace(/\s+/g, ""); }
  function unicos(lista) { return lista.filter(function (x, i) { return lista.indexOf(x) === i; }); }

  // "en 40 min", "hace 1 h 10 min"
  function cuandoLlega(t) {
    var min = Math.round((t - Date.now()) / 60000);
    var a = Math.abs(min);
    var txt = a < 60 ? a + " min" : Math.floor(a / 60) + " h" + (a % 60 ? " " + (a % 60) + " min" : "");
    if (a <= 1) return "ahora";
    return min > 0 ? "en " + txt : "hace " + txt;
  }

  function estadoVuelo(v) {
    var e = ESTADOS_VUELO[String(v.estado_code || "").toUpperCase()];
    return { tipo: e ? e.tipo : "", texto: v.estado || (e ? e.texto : "") };
  }

  function textoErrorVuelos(err) {
    if (err && (err.code === "PGRST202" || err.status === 404)) {
      return "Vuelos todavía no está habilitado en el servidor. Avísele a control.";
    }
    return textoError(err);
  }

  // Lo anotado: lo que dijo el servidor + lo recién guardado + lo que está en el celular sin enviar.
  function anotaciones() {
    var yo = estado.yo || {};
    var lista = ((vu.datos && vu.datos.registros) || []).map(function (r) {
      return { id_local: r.id_local || null, fecha: String(r.fecha), vuelo: String(r.vuelo || ""), interno: String(r.interno),
        pasajeros: Number(r.pasajeros) || 0, nombre: r.nombre || "", mio: !!r.mio, en: msDe(r.anotado_en),
        quitar: !!r.se_puede_quitar, pendiente: false };
    });
    var ya = {};
    lista.forEach(function (r) { if (r.id_local) ya[r.id_local] = true; });
    function sumar(c, pendiente) {
      if (ya[c.id_local] || c.dni !== yo.dni) return;
      ya[c.id_local] = true;
      lista.push({ id_local: c.id_local, fecha: c.fecha, vuelo: c.vuelo, interno: c.interno, pasajeros: c.pasajeros,
        nombre: yo.nombre || "", mio: true, en: c.anotado_ms, quitar: true, pendiente: pendiente });
    }
    vu.recien.forEach(function (c) { sumar(c, false); });
    leerJson(LS_VUELOS_COLA, []).forEach(function (c) { sumar(c, true); });
    return lista;
  }

  function anotadoDelVuelo(v, lista) {
    var k = claveVuelo(v);
    return (lista || anotaciones()).filter(function (r) { return r.fecha + "|" + r.vuelo.toUpperCase() === k; })
      .sort(function (a, b) { return (a.en || 0) - (b.en || 0); });
  }

  // Lo anotado en ese bus una hora y media antes o después de la hora del viaje (la de su salida, o ahora): cupo 19
  function anotadoEnBus(interno, lista, tViaje) {
    var ref = tViaje != null ? tViaje : Date.now();
    return (lista || anotaciones()).reduce(function (s, r) {
      return s + (r.interno === interno && r.en != null && Math.abs(r.en - ref) <= VENTANA_CUPO_MS ? r.pasajeros : 0);
    }, 0);
  }

  // Las salidas del aeropuerto de hoy (la última primero), cada una con lo anotado en ella, y el turno de la fila.
  function contexto(lista) {
    var d = vu.datos || {};
    var ss = (d.bajaron || []).map(function (b) {
      return { interno: String(b.interno), t: msDe(b.despacho_en), destino: DESTINOS[String(b.itinerario_id)] || "", regs: [] };
    }).filter(function (s) { return s.t != null; }).sort(function (a, b) { return b.t - a.t; });
    var turno = {};
    (d.fila || []).forEach(function (f, i) { var k = String(f.interno); if (!turno[k]) turno[k] = i + 1; });
    var vuelos = {};
    (d.vuelos || []).forEach(function (v) { vuelos[claveVuelo(v)] = v; });
    lista.forEach(function (r) {
      r.salida = null;
      if (r.en == null) return;
      var mejor = null, dif = Infinity;
      ss.forEach(function (s) {
        if (s.interno !== r.interno) return;
        var dd = s.t - r.en;
        if (dd < -SALIO_ANTES_MS || dd > SALE_DESPUES_MS || Math.abs(dd) >= dif) return;
        mejor = s;
        dif = Math.abs(dd);
      });
      if (mejor) { r.salida = mejor; mejor.regs.push(r); }
    });
    return { ss: ss, turno: turno, vuelos: vuelos, lista: lista };
  }

  // Dónde va el bus de una anotación: salió (a qué hora y para dónde), en la fila, o todavía sin despacho.
  function estadoBus(r, cx) {
    if (r.salida) return { tipo: "salio", texto: "Salió " + horaDe(r.salida.t) + (r.salida.destino ? " a " + r.salida.destino : "") };
    if (cx.turno[r.interno]) return { tipo: "fila", texto: "En la fila · turno " + cx.turno[r.interno] };
    return { tipo: "espera", texto: "Todavía sin despacho" };
  }

  // Cuántos lleva ese bus en ese viaje (de todos los vuelos)
  function totalViaje(r, cx) {
    return cx.lista.reduce(function (s, x) {
      if (x.interno !== r.interno) return s;
      var mismo = r.salida ? x.salida === r.salida
        : !x.salida && x.en != null && r.en != null && Math.abs(x.en - r.en) <= VENTANA_CUPO_MS;
      return s + (mismo ? x.pasajeros : 0);
    }, 0);
  }

  function barra(n) {
    var pct = Math.max(0, Math.min(100, Math.round(n / CUPO_BUS * 100)));
    return '<span class="barra-bus' + (n >= CUPO_BUS ? " llena" : "") + '" aria-hidden="true"><i style="width:' + pct + '%"></i></span>';
  }

  async function cargarVuelos(callado) {
    if (!estado.yo || !esGestor() || vu.cargando) return;
    if (!vu.datos) {   // sin señal se ve la última lista que llegó a este celular
      var guardado = leerJson(LS_VUELOS_ULTIMO, null);
      if (guardado && guardado.dni === estado.yo.dni && guardado.datos) { vu.datos = guardado.datos; vu.cargadoEn = guardado.en || 0; }
    }
    vu.cargando = true;
    if (!callado) pintarVuelos();
    try {
      var r = await rpc(RPC_VUELOS, { p_dni: estado.yo.dni }, 20000);
      if (r && r.no_gestor) {
        vu.error = { texto: "Vuelos es solo para los gestores." };
      } else if (!r || r.no_es) {
        vu.error = { texto: "Su cédula no aparece como personal vinculado. Avísele a control." };
      } else {
        vu.datos = r;
        vu.cargadoEn = Date.now();
        vu.error = null;
        // lo recién guardado ya viene del servidor: se deja de pintar aparte
        var del = {};
        (r.registros || []).forEach(function (x) { if (x.id_local) del[x.id_local] = true; });
        vu.recien = vu.recien.filter(function (c) { return !del[c.id_local] && Date.now() - (c.enviado_ms || c.anotado_ms) < 10 * 60 * 1000; });
        guardarJson(LS_VUELOS_ULTIMO, { dni: estado.yo.dni, en: vu.cargadoEn, datos: r });
      }
    } catch (err) {
      vu.error = { texto: err && err.sinRed ? "Sin internet." : textoErrorVuelos(err), sinRed: !!(err && err.sinRed) };
    } finally {
      vu.cargando = false;
      pintarVuelos();
      if (vu.abierto) pintarHojaVuelo();
      if (vu.busAbierto) pintarHojaBus();
    }
  }

  function pintarFallasVuelos() {
    var fallas = leerJson(LS_VUELOS_FALLAS, []);
    var caja = $("vuelosFallas");
    if (!fallas.length) { show(caja, false); caja.innerHTML = ""; return; }
    caja.innerHTML = '<p class="vuelos-fallas-titulo">' + (fallas.length === 1 ? "Esto no quedó anotado" : "Esto no quedó anotado (" + fallas.length + ")") +
      ":</p><ul>" + fallas.map(function (f) {
        return "<li><b>" + escapeHtml(f.vuelo) + " · bus " + escapeHtml(f.interno) + " · " + escapeHtml(String(f.pasajeros)) +
          "</b><span>" + escapeHtml(f.texto) + "</span></li>";
      }).join("") + '</ul><button type="button" class="btn btn-ghost btn-sm" data-fallas-ok>Entendido</button>';
    show(caja, true);
  }

  function pintarVuelos() {
    if (!$("vuelosLista")) return;
    pintarFallasVuelos();
    var est = $("vuelosEstado");
    var d = vu.datos;
    show($("vuelosOtraVez"), false);
    if (!d) {
      $("vuelosLista").innerHTML = "";
      $("vuelosResumen").innerHTML = "";
      est.textContent = vu.cargando ? "Cargando los vuelos…" : (vu.error ? vu.error.texto : "");
      est.setAttribute("data-estado", vu.error && !vu.cargando ? "error" : "");
      show(est, !!est.textContent);
      show($("vuelosOtraVez"), !vu.cargando && !!vu.error);
      return;
    }
    var lista = anotaciones();
    var deHoy = {};
    (d.vuelos || []).forEach(function (v) { deHoy[claveVuelo(v)] = true; });
    var hoy = lista.filter(function (r) { return deHoy[r.fecha + "|" + r.vuelo.toUpperCase()]; });
    var pas = hoy.reduce(function (s, r) { return s + r.pasajeros; }, 0);
    var mios = hoy.filter(function (r) { return r.mio; }).reduce(function (s, r) { return s + r.pasajeros; }, 0);
    var porEnviar = hoy.filter(function (r) { return r.pendiente; }).length;
    var vuelosAnotados = unicos(hoy.map(function (r) { return r.fecha + "|" + r.vuelo.toUpperCase(); })).length;
    var buses = unicos(hoy.map(function (r) { return r.interno; })).length;
    var fechaTxt = "";
    try {
      fechaTxt = new Date(d.dia + "T12:00:00-05:00").toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Bogota" });
    } catch (_) { fechaTxt = d.dia || ""; }
    $("vuelosResumen").innerHTML =
      '<p class="vr-dia">Hoy, ' + escapeHtml(fechaTxt) + "</p>" +
      '<div class="vr-cifras">' +
        "<div><b>" + pas + "</b><span>pasajeros</span></div>" +
        "<div><b>" + buses + "</b><span>" + (buses === 1 ? "bus" : "buses") + "</span></div>" +
        "<div><b>" + vuelosAnotados + "</b><span>de " + (d.vuelos || []).length + " vuelos</span></div>" +
      "</div>" +
      '<p class="vr-mio">Usted anotó <b>' + mios + "</b> " + (mios === 1 ? "pasajero" : "pasajeros") +
        (porEnviar ? ' · <span class="vr-pend">' + porEnviar + " por enviar</span>" : "") + "</p>";

    var aviso = "";
    if (vu.cargando && !vu.cargadoEn) aviso = "Cargando los vuelos…";
    else if (vu.error) {
      aviso = (vu.error.sinRed ? "Sin internet" : vu.error.texto) + (vu.cargadoEn ? ": la lista es la de las " + horaDe(vu.cargadoEn) + "." : "") +
        " Lo que anote se guarda en el celular y se envía cuando vuelva la señal.";
    }
    est.textContent = aviso;
    est.setAttribute("data-estado", vu.error ? "aviso" : "");
    show(est, !!aviso);

    var ahora = Date.now();
    var q = sinTildes(vu.buscar.trim());
    var cx = contexto(lista);
    if (vu.vista === "buses") {
      $("vuelosLista").innerHTML = htmlSalidas(cx, q);
      return;
    }
    var busesDe = {};
    lista.forEach(function (r) { var k = r.fecha + "|" + r.vuelo.toUpperCase(); busesDe[k] = (busesDe[k] || "") + " " + r.interno; });
    var visibles = (d.vuelos || []).filter(function (v) {
      if (q) {   // al buscar, todo el día; también por el bus que se los llevó
        return sinTildes(v.vuelo + " " + (v.aerolinea || "") + " " + (v.ciudad || "") + (busesDe[claveVuelo(v)] || "")).indexOf(q) >= 0;
      }
      if (vu.vista === "dia") return true;
      var t = msDe(v.llega);
      return t != null && t >= ahora - AHORA_ANTES_MS && t <= ahora + AHORA_DESPUES_MS;
    });
    if (!visibles.length) {
      var desde = horaDe(ahora - AHORA_ANTES_MS), hasta = horaDe(ahora + AHORA_DESPUES_MS);
      $("vuelosLista").innerHTML = '<li class="vuelos-nada">' + (q ? "Ningún vuelo de hoy con «" + escapeHtml(vu.buscar.trim()) + "»."
        : vu.vista === "dia" ? "Hoy no hay vuelos de llegada en la lista del aeropuerto."
        : "No hay vuelos entre las " + escapeHtml(desde) + " y las " + escapeHtml(hasta) + '. Toque <b>Todo el día</b> para verlos todos.') + "</li>";
      return;
    }
    $("vuelosLista").innerHTML = visibles.map(function (v) { return itemVuelo(v, cx); }).join("");
  }

  // Un vuelo: la hora, el vuelo y, debajo, cada bus que se llevó pasajeros (cuántos, si ya salió y para dónde)
  function itemVuelo(v, cx) {
    var t = msDe(v.llega);
    var a = anotadoDelVuelo(v, cx.lista);
    var pas = a.reduce(function (s, r) { return s + r.pasajeros; }, 0);
    var nb = unicos(a.map(function (r) { return r.interno; })).length;
    var e = estadoVuelo(v);
    var clave = escapeHtml(claveVuelo(v));
    return '<li class="vcard"' + (a.length ? ' data-anotado="true"' : "") + ">" +
      '<button type="button" class="vuelo-item" data-vuelo="' + clave + '"' +
        (a.length ? ' data-anotado="true"' : "") + (t && t < Date.now() ? ' data-paso="true"' : "") + ">" +
        '<span class="vuelo-hora"><b>' + escapeHtml(t ? horaDe(t) : (v.hora || "")) + "</b><small>" + escapeHtml(t ? cuandoLlega(t) : "") + "</small></span>" +
        '<span class="vuelo-datos"><span class="vuelo-linea"><b class="vuelo-cod">' + escapeHtml(v.vuelo) + "</b>" +
          (e.texto ? '<span class="vuelo-estado" data-tipo="' + e.tipo + '">' + escapeHtml(e.texto) + "</span>" : "") + "</span>" +
          "<small>" + escapeHtml(v.aerolinea || "") + "</small><small>Desde " + escapeHtml(v.ciudad || "—") + "</small></span>" +
        '<span class="vuelo-cuenta">' + (a.length
          ? "<b>" + pas + "</b><small>" + (pas === 1 ? "pasajero" : "pasajeros") + "</small><small>en " + nb + (nb === 1 ? " bus" : " buses") + "</small>"
          : '<small class="vuelo-sin">Sin anotar</small>') + "</span>" +
      "</button>" +
      (a.length ? '<ul class="vb-lista">' + a.map(function (r) { return lineaBus(r, cx); }).join("") + "</ul>" : "") +
      '<button type="button" class="vcard-anotar" data-vuelo="' + clave + '"><span aria-hidden="true">+</span> ' +
        (a.length ? "Anotar otro bus" : "Anotar en qué bus se fueron") + "</button>" +
      "</li>";
  }

  function lineaBus(r, cx) {
    var eb = estadoBus(r, cx);
    var tot = totalViaje(r, cx);
    return '<li class="vb" data-estado="' + eb.tipo + '">' +
      '<span class="vb-bus">' + ICONO_BUS + "<b>" + escapeHtml(r.interno) + "</b></span>" +
      '<span class="vb-pas"><b>' + r.pasajeros + "</b><small>pas.</small></span>" +
      '<span class="vb-info"><span class="vb-estado">' + escapeHtml(eb.texto) + "</span>" + barra(tot) +
        '<small class="vb-quien">El bus lleva ' + tot + " de 19 · anotó " + escapeHtml(r.mio ? "usted" : (r.nombre || "otro gestor")) + "</small>" +
        (r.pendiente ? '<small class="vuelo-pend">Por enviar</small>' : "") +
      "</span></li>";
  }

  // ---- Buses que salen: los carros que va lanzando el aeropuerto, con lo que lleva cada uno
  function htmlSalidas(cx, q) {
    var ss = cx.ss;
    var con = ss.filter(function (s) { return s.regs.length; }).length;
    var html = '<li class="salidas-resumen">Hoy salieron <b>' + ss.length + "</b> " + (ss.length === 1 ? "bus" : "buses") +
      " del aeropuerto: <b>" + con + "</b> con pasajeros anotados y <b>" + (ss.length - con) + "</b> sin anotar.</li>";
    var ahora = Date.now();
    var fila = ((vu.datos && vu.datos.fila) || []).slice(0, MAX_FILA);
    if (fila.length && !q) {
      html += '<li class="salidas-fila"><p class="buses-titulo">En la fila: los próximos en salir</p><div class="bus-chips">' +
        fila.map(function (f, i) {
          var interno = String(f.interno);
          var ya = cx.lista.reduce(function (s, x) {
            return s + (x.interno === interno && !x.salida && x.en != null && Math.abs(x.en - ahora) <= VENTANA_CUPO_MS ? x.pasajeros : 0);
          }, 0);
          return '<button type="button" class="bus-chip" data-bus-abrir="' + escapeHtml(interno) + '"' + (ya ? ' data-con="true"' : "") +
            "><b>" + escapeHtml(interno) + "</b><small>" + (ya ? ya + " de 19" : "turno " + (i + 1)) + "</small></button>";
        }).join("") + "</div></li>";
    }
    var visibles = ss.filter(function (s) {
      if (!q) return true;
      return sinTildes(s.interno + " " + s.destino + " " + s.regs.map(function (r) { return r.vuelo; }).join(" ")).indexOf(q) >= 0;
    });
    html += '<li class="buses-titulo salidas-titulo">Salieron del aeropuerto (el último arriba)</li>';
    if (!visibles.length) {
      return html + '<li class="vuelos-nada">' + (q ? "Ninguna salida de hoy con «" + escapeHtml(vu.buscar.trim()) + "»."
        : "Hoy todavía no ha salido ningún bus del aeropuerto.") + "</li>";
    }
    var mostrar = q || vu.todasSalidas ? visibles : visibles.slice(0, MOSTRAR_SALIDAS);
    html += mostrar.map(function (s) { return itemSalida(s, cx); }).join("");
    if (mostrar.length < visibles.length) {
      html += '<li><button type="button" class="btn btn-ghost btn-block" data-salidas-todas>Ver las ' + (visibles.length - mostrar.length) +
        " salidas anteriores</button></li>";
    }
    return html;
  }

  function itemSalida(s, cx) {
    var tot = s.regs.reduce(function (n, r) { return n + r.pasajeros; }, 0);
    var grupos = [];
    s.regs.forEach(function (r) {
      var k = r.fecha + "|" + r.vuelo.toUpperCase();
      var g = grupos.find(function (x) { return x.k === k; });
      if (!g) { g = { k: k, vuelo: r.vuelo, v: cx.vuelos[k] || {}, pas: 0, pend: false }; grupos.push(g); }
      g.pas += r.pasajeros;
      g.pend = g.pend || r.pendiente;
    });
    return '<li class="scard" data-anotado="' + (s.regs.length ? "true" : "false") + '">' +
      '<button type="button" class="scard-btn" data-bus-abrir="' + escapeHtml(s.interno) + '" data-bus-t="' + s.t + '">' +
        '<span class="sc-hora"><b>' + escapeHtml(horaDe(s.t)) + "</b><small>" + escapeHtml(cuandoLlega(s.t)) + "</small></span>" +
        '<span class="sc-bus">' + ICONO_BUS + "<span><b>Bus " + escapeHtml(s.interno) + "</b><small>" +
          escapeHtml(s.destino ? "a " + s.destino : "bajada") + "</small></span></span>" +
        '<span class="sc-cupo">' + (s.regs.length ? "<b>" + tot + "</b><small>de 19</small>" : '<small class="vuelo-sin">Sin anotar</small>') + "</span>" +
        (s.regs.length
          ? barra(tot) + '<span class="sc-vuelos">' + grupos.map(function (g) {
              return '<span class="sc-vuelo"><b>' + escapeHtml(g.vuelo) + "</b><small>" + escapeHtml([g.v.aerolinea, g.v.ciudad].filter(Boolean).join(" · ")) +
                "</small><em>" + g.pas + "</em>" + (g.pend ? '<small class="vuelo-pend">Por enviar</small>' : "") + "</span>";
            }).join("") + "</span>"
          : '<span class="sc-sin">¿De qué vuelo eran? Toque para anotar.</span>') +
      "</button></li>";
  }

  // ---- la hoja de un bus: lo que lleva y escoger el vuelo (después se abre la hoja del vuelo con ese bus)
  function abrirBus(interno, t) {
    vu.busAbierto = { interno: normalizarBus(interno), t: t != null && !isNaN(t) ? Number(t) : null };
    pintarHojaBus();
    show($("busSheet"), true);
  }

  function cerrarBus() {
    vu.busAbierto = null;
    show($("busSheet"), false);
  }

  function pintarHojaBus() {
    var b = vu.busAbierto;
    if (!b) return;
    var cx = contexto(anotaciones());
    var s = b.t != null ? cx.ss.find(function (x) { return x.interno === b.interno && x.t === b.t; }) : null;
    $("busTitulo").textContent = "Bus " + b.interno;
    $("busSub").textContent = s ? "Salió " + horaDe(s.t) + " (" + cuandoLlega(s.t) + ")" + (s.destino ? " a " + s.destino : "")
      : cx.turno[b.interno] ? "En la fila del aeropuerto · turno " + cx.turno[b.interno] : "";
    var ahora = Date.now();
    var lleva = s ? s.regs : cx.lista.filter(function (x) {
      return x.interno === b.interno && !x.salida && x.en != null && Math.abs(x.en - ahora) <= VENTANA_CUPO_MS;
    });
    var tot = lleva.reduce(function (n, r) { return n + r.pasajeros; }, 0);
    $("busLleva").innerHTML = lleva.length
      ? '<p class="va-titulo">Lleva <b>' + tot + " de 19</b></p>" + barra(tot) + '<ul class="va-lista">' + lleva.map(function (r) {
          return '<li><span class="va-bus"><b>' + escapeHtml(r.vuelo) + '</b></span><span class="va-pas"><b>' + r.pasajeros + "</b> pas.</span>" +
            '<span class="va-quien">' + escapeHtml(r.mio ? "Usted" : (r.nombre || "Otro gestor")) + (r.pendiente ? " · <em>por enviar</em>" : "") + "</span><span></span></li>";
        }).join("") + "</ul>"
      : '<p class="va-nada">Este bus todavía no tiene pasajeros anotados.</p>';
    // los vuelos que llegaron hasta 2 horas y media antes de la salida (o de ahora), el último primero
    var ref = s ? s.t : ahora;
    var cand = ((vu.datos && vu.datos.vuelos) || []).filter(function (v) {
      var t = msDe(v.llega);
      return t != null && t >= ref - 150 * 60 * 1000 && t <= ref + 10 * 60 * 1000;
    }).sort(function (x, y) { return msDe(y.llega) - msDe(x.llega); }).slice(0, 12);
    $("busVuelos").innerHTML = cand.length ? cand.map(function (v) {
      var t = msDe(v.llega);
      var a = anotadoDelVuelo(v, cx.lista);
      var pas = a.reduce(function (n, r) { return n + r.pasajeros; }, 0);
      var e = estadoVuelo(v);
      return '<li><button type="button" class="bv-item" data-elegir-vuelo="' + escapeHtml(claveVuelo(v)) + '">' +
        '<span class="vuelo-hora"><b>' + escapeHtml(horaDe(t)) + "</b><small>" + escapeHtml(cuandoLlega(t)) + "</small></span>" +
        '<span class="vuelo-datos"><span class="vuelo-linea"><b class="vuelo-cod">' + escapeHtml(v.vuelo) + "</b>" +
          (e.texto ? '<span class="vuelo-estado" data-tipo="' + e.tipo + '">' + escapeHtml(e.texto) + "</span>" : "") + "</span>" +
          "<small>" + escapeHtml([v.aerolinea, v.ciudad].filter(Boolean).join(" · ")) + "</small></span>" +
        '<span class="vuelo-cuenta">' + (pas ? "<b>" + pas + "</b><small>anotados</small>" : "") + "</span>" +
        "</button></li>";
    }).join("") : '<li class="vuelos-nada">No hay vuelos que hayan llegado en las 2 horas y media antes.</li>';
  }

  // ---- la hoja de un vuelo: lo anotado y anotar otro bus
  function vueloAbierto() {
    return ((vu.datos && vu.datos.vuelos) || []).find(function (v) { return claveVuelo(v) === vu.abierto; }) || null;
  }

  function errorVuelo(texto) {
    $("vueloError").textContent = texto || "";
    show($("vueloError"), !!texto);
  }

  // bus y tViaje: cuando se llega desde "Buses que salen" (ese bus, en esa salida)
  function abrirVuelo(clave, bus, tViaje) {
    vu.abierto = clave;
    vu.bus = bus ? normalizarBus(bus) : "";
    vu.busT = bus && tViaje != null ? tViaje : null;
    $("vueloBus").value = "";
    $("vueloPasajeros").value = "";
    errorVuelo("");
    show($("vueloListo"), false);
    pintarHojaVuelo();
    show($("vueloSheet"), true);
  }

  function cerrarVuelo() {
    vu.abierto = null;
    show($("vueloSheet"), false);
  }

  function pintarHojaVuelo() {
    var v = vueloAbierto();
    if (!v) { cerrarVuelo(); return; }
    var t = msDe(v.llega);
    var e = estadoVuelo(v);
    $("vueloTitulo").textContent = v.vuelo + (v.aerolinea ? " · " + v.aerolinea : "");
    $("vueloSub").textContent = "Desde " + (v.ciudad || "—") + (t ? " · llega " + horaDe(t) + " (" + cuandoLlega(t) + ")" : "") +
      (e.texto ? " · " + e.texto : "");
    var lista = anotaciones();
    var a = anotadoDelVuelo(v, lista);
    var total = a.reduce(function (s, r) { return s + r.pasajeros; }, 0);
    var nb = unicos(a.map(function (r) { return r.interno; })).length;
    $("vueloAnotado").innerHTML = a.length
      ? '<p class="va-titulo">Ya anotado: <b>' + total + (total === 1 ? " pasajero" : " pasajeros") + "</b> en " + nb + (nb === 1 ? " bus" : " buses") + "</p>" +
        '<ul class="va-lista">' + a.map(function (r) {
          return '<li><span class="va-bus">Bus <b>' + escapeHtml(r.interno) + '</b></span><span class="va-pas"><b>' + r.pasajeros + "</b> pas.</span>" +
            '<span class="va-quien">' + escapeHtml(r.mio ? "Usted" : (r.nombre || "Otro gestor")) + (r.en ? " · " + escapeHtml(horaDe(r.en)) : "") +
            (r.pendiente ? ' · <em>por enviar</em>' : "") + "</span>" +
            (r.mio && r.quitar && r.id_local ? '<button type="button" class="btn btn-ghost btn-sm va-quitar" data-quitar="' + escapeHtml(r.id_local) + '">Quitar</button>' : "") +
            "</li>";
        }).join("") + "</ul>"
      : '<p class="va-nada">Todavía no hay nada anotado en este vuelo.</p>';
    pintarBusesVuelo(lista);
    pintarCupo(lista);
  }

  function chipBus(interno, nota, lista, tViaje) {
    var ya = anotadoEnBus(interno, lista, tViaje);
    var esc = vu.bus === interno && (vu.busT == null ? tViaje == null : vu.busT === tViaje);
    return '<button type="button" class="bus-chip" data-bus="' + escapeHtml(interno) + '"' + (tViaje != null ? ' data-bus-t="' + tViaje + '"' : "") +
      ' aria-pressed="' + (esc ? "true" : "false") + '"' +
      (ya >= CUPO_BUS ? ' data-lleno="true"' : "") + "><b>" + escapeHtml(interno) + "</b><small>" +
      escapeHtml(ya >= CUPO_BUS ? "lleno" : ya ? ya + " de 19" : nota) + "</small></button>";
  }

  function notaSalida(t, destino) {
    return (t ? horaDe(t).replace(/\s*[ap]\.\s*m\.$/i, "") : "") + (destino ? " a " + destino : "");
  }

  function pintarBusesVuelo(lista) {
    var d = vu.datos || {};
    var ya = {};
    var desde = Date.now() - SALIERON_MS;
    var bajaron = (d.bajaron || []).filter(function (b) {
      var i = String(b.interno), t = msDe(b.despacho_en);
      if (ya[i] || (t != null && t < desde)) return false;
      ya[i] = true;
      return true;
    }).slice(0, MAX_SALIERON);
    var fila = (d.fila || []).map(function (b) { return String(b.interno); }).filter(function (i) { return !ya[i]; }).slice(0, MAX_FILA);
    var html = "";
    // el bus que viene de "Buses que salen" (una salida de antes): arriba, ya escogido
    var vieneDeSalida = vu.bus && vu.busT != null && !bajaron.some(function (b) { return String(b.interno) === vu.bus && msDe(b.despacho_en) === vu.busT; });
    if (vieneDeSalida) {
      var s = (d.bajaron || []).find(function (b) { return String(b.interno) === vu.bus && msDe(b.despacho_en) === vu.busT; });
      html += '<p class="buses-titulo">El bus que escogió</p><div class="bus-chips">' +
        chipBus(vu.bus, notaSalida(vu.busT, s ? DESTINOS[String(s.itinerario_id)] : ""), lista, vu.busT) + "</div>";
    }
    // el bus escogido de la fila siempre se ve, aunque no esté entre los primeros
    if (vu.bus && vu.busT == null && !ya[vu.bus] && fila.indexOf(vu.bus) < 0 && (d.fila || []).some(function (b) { return String(b.interno) === vu.bus; })) fila.push(vu.bus);
    if (bajaron.length) {
      html += '<p class="buses-titulo">Salieron hace poco</p><div class="bus-chips">' + bajaron.map(function (b) {
        var t = msDe(b.despacho_en);
        return chipBus(String(b.interno), notaSalida(t, DESTINOS[String(b.itinerario_id)]), lista, t);
      }).join("") + "</div>";
    }
    if (fila.length) {
      html += '<p class="buses-titulo">En la fila del aeropuerto</p><div class="bus-chips">' + fila.map(function (i, k) {
        return chipBus(i, "turno " + (k + 1), lista);
      }).join("") + "</div>";
    }
    if (!html) html = '<p class="buses-titulo">No hay buses en la lista: escriba el número abajo.</p>';
    $("vueloBuses").innerHTML = html;
  }

  function maxPasajeros(lista) {
    return vu.bus ? Math.max(0, CUPO_BUS - anotadoEnBus(vu.bus, lista, vu.busT)) : CUPO_BUS;
  }

  function pintarCupo(lista) {
    var p = $("vueloCupo");
    if (!vu.bus) { show(p, false); $("vueloGuardar").disabled = vu.guardando; return; }
    var ya = anotadoEnBus(vu.bus, lista || anotaciones(), vu.busT);
    var queda = CUPO_BUS - ya;
    p.setAttribute("data-lleno", queda <= 0 ? "true" : "false");
    p.innerHTML = ya
      ? (queda <= 0 ? "Al bus <b>" + escapeHtml(vu.bus) + "</b> ya le anotaron 19: está lleno."
        : "Al bus <b>" + escapeHtml(vu.bus) + "</b> ya le anotaron " + ya + ": le " + (queda === 1 ? "cabe 1 más" : "caben " + queda + " más") + ".")
      : "Bus <b>" + escapeHtml(vu.bus) + "</b>: le caben 19.";
    show(p, true);
    $("vueloGuardar").disabled = vu.guardando || queda <= 0;
    var n = parseInt($("vueloPasajeros").value, 10);
    if (n > queda && queda > 0) $("vueloPasajeros").value = String(queda);
  }

  // tViaje: la hora de la salida, cuando el bus ya salió (lo anotado cuenta para ese viaje)
  function escogerBus(interno, tViaje) {
    vu.bus = normalizarBus(interno);
    vu.busT = tViaje != null && !isNaN(tViaje) ? Number(tViaje) : null;
    errorVuelo("");
    show($("vueloListo"), false);
    var lista = anotaciones();
    pintarBusesVuelo(lista);
    pintarCupo(lista);
  }

  function cambiarPasajeros(delta) {
    var max = maxPasajeros();
    var n = parseInt($("vueloPasajeros").value, 10) || 0;
    n = Math.min(Math.max(n + delta, 1), Math.max(max, 1));
    $("vueloPasajeros").value = String(n);
    errorVuelo("");
    show($("vueloListo"), false);
  }

  function quitarDeColaVuelos(id) {
    guardarJson(LS_VUELOS_COLA, leerJson(LS_VUELOS_COLA, []).filter(function (r) { return r.id_local !== id; }));
  }

  // Devuelve "ok", "pendiente" (sin señal: queda en el celular) o "error" (el servidor no lo aceptó: sale de la cola).
  async function enviarAnotacion(reg) {
    try {
      await rpc(RPC_ANOTAR, {
        p_id_local: reg.id_local, p_dni: reg.dni, p_fecha: reg.fecha, p_vuelo: reg.vuelo, p_interno: reg.interno,
        p_pasajeros: reg.pasajeros, p_anotado_en: new Date(reg.anotado_ms).toISOString(), p_dispositivo: reg.dispositivo,
      }, 20000);
      quitarDeColaVuelos(reg.id_local);
      reg.enviado_ms = Date.now();
      vu.recien.push(reg);
      return { estado: "ok" };
    } catch (err) {
      if (err && err.sinRed) return { estado: "pendiente" };
      quitarDeColaVuelos(reg.id_local);
      return { estado: "error", texto: textoErrorVuelos(err) };
    }
  }

  async function guardarVuelo(ev) {
    if (ev) ev.preventDefault();
    if (vu.guardando || !estado.yo) return;
    var v = vueloAbierto();
    if (!v) return;
    var bus = normalizarBus(vu.bus || $("vueloBus").value);
    var pas = parseInt($("vueloPasajeros").value, 10);
    show($("vueloListo"), false);
    if (!bus) { errorVuelo("Toque el bus en que se fueron o escriba su número."); return; }
    if (!/^[0-9A-Z-]{1,10}$/.test(bus)) { errorVuelo("El número del bus solo lleva números."); return; }
    if (!(pas >= 1 && pas <= CUPO_BUS)) { errorVuelo("Diga cuántos pasajeros de este vuelo se fueron en el bus " + bus + ": de 1 a 19."); return; }
    // Si el bus ya salió (se escogió su salida), lo anotado va con la hora de esa salida: así cuenta para ese viaje.
    var tViaje = vu.bus === bus && vu.busT != null ? vu.busT : null;
    var ya = anotadoEnBus(bus, undefined, tViaje);
    if (ya + pas > CUPO_BUS) {
      errorVuelo("Al bus " + bus + " ya le anotaron " + ya + ": con estos " + pas + " serían " + (ya + pas) + " y el cupo es 19.");
      return;
    }
    var reg = { id_local: "v" + Date.now().toString(36) + "-" + alAzar(5), dni: estado.yo.dni, fecha: v.fecha, vuelo: v.vuelo,
      interno: bus, pasajeros: pas, anotado_ms: tViaje != null ? Math.min(tViaje, Date.now()) : Date.now(),
      dispositivo: String(navigator.userAgent || "").slice(0, 200) };
    var cola = leerJson(LS_VUELOS_COLA, []);
    cola.push(reg);
    guardarJson(LS_VUELOS_COLA, cola.slice(-200));
    vu.guardando = true;
    $("vueloGuardar").disabled = true;
    $("vueloGuardar").textContent = "Guardando…";
    var r = await enviarAnotacion(reg);
    vu.guardando = false;
    $("vueloGuardar").textContent = "Guardar";
    if (r.estado === "error") {
      errorVuelo(r.texto);
      pintarHojaVuelo();
      pintarVuelos();
      return;
    }
    vu.bus = "";
    vu.busT = null;
    $("vueloBus").value = "";
    $("vueloPasajeros").value = "";
    errorVuelo("");
    var listo = $("vueloListo");
    listo.setAttribute("data-estado", r.estado);
    listo.textContent = r.estado === "ok"
      ? "Listo: " + pas + (pas === 1 ? " pasajero" : " pasajeros") + " del " + v.vuelo + " en el bus " + bus + "."
      : "Sin internet: quedó guardado en el celular (" + pas + " en el bus " + bus + ") y se envía solo cuando vuelva la señal.";
    show(listo, true);
    pintarHojaVuelo();
    pintarVuelos();
    if (r.estado === "ok") cargarVuelos(true);
  }

  async function quitarAnotacion(idLocal) {
    var r = anotaciones().find(function (x) { return x.id_local === idLocal; });
    if (!r) return;
    if (!window.confirm("¿Quitar el bus " + r.interno + " con " + r.pasajeros + (r.pasajeros === 1 ? " pasajero" : " pasajeros") + " del " + r.vuelo + "?")) return;
    errorVuelo("");
    show($("vueloListo"), false);
    if (r.pendiente) {   // todavía no había salido del celular
      quitarDeColaVuelos(idLocal);
      pintarHojaVuelo();
      pintarVuelos();
      return;
    }
    try {
      await rpc(RPC_QUITAR_VUELO, { p_dni: estado.yo.dni, p_id_local: idLocal }, 15000);
      vu.recien = vu.recien.filter(function (c) { return c.id_local !== idLocal; });
      if (vu.datos && vu.datos.registros) vu.datos.registros = vu.datos.registros.filter(function (x) { return x.id_local !== idLocal; });
      var listo = $("vueloListo");
      listo.setAttribute("data-estado", "ok");
      listo.textContent = "Quitado: el bus " + r.interno + " ya no está en el " + r.vuelo + ".";
      show(listo, true);
      pintarHojaVuelo();
      pintarVuelos();
      cargarVuelos(true);
    } catch (err) {
      errorVuelo(err && err.sinRed ? "Sin internet: para quitar hace falta señal." : textoErrorVuelos(err));
    }
  }

  // Lo que quedó sin señal (de esta o de otra cédula de este celular) se manda solo.
  async function enviarColaVuelos() {
    if (vu.enviando || !conRed()) return;
    var cola = leerJson(LS_VUELOS_COLA, []);
    if (!cola.length) return;
    vu.enviando = true;
    var mandados = 0;
    try {
      for (var i = 0; i < cola.length; i++) {
        var r = await enviarAnotacion(cola[i]);
        if (r.estado === "pendiente") break;
        mandados++;
        if (r.estado === "error") {
          var fallas = leerJson(LS_VUELOS_FALLAS, []);
          fallas.push({ vuelo: cola[i].vuelo, interno: cola[i].interno, pasajeros: cola[i].pasajeros, texto: r.texto });
          guardarJson(LS_VUELOS_FALLAS, fallas.slice(-20));
        }
      }
    } finally {
      vu.enviando = false;
      if (mandados) { pintarVuelos(); if (vu.abierto) pintarHojaVuelo(); if (pestana === "vuelos") cargarVuelos(true); }
    }
  }

  function initVuelos() {
    $("vuelosLista").addEventListener("click", function (ev) {
      if (!ev.target.closest) return;
      var b = ev.target.closest("[data-vuelo]");
      if (b) { abrirVuelo(b.getAttribute("data-vuelo")); return; }
      var s = ev.target.closest("[data-bus-abrir]");
      if (s) { abrirBus(s.getAttribute("data-bus-abrir"), s.hasAttribute("data-bus-t") ? Number(s.getAttribute("data-bus-t")) : null); return; }
      if (ev.target.closest("[data-salidas-todas]")) { vu.todasSalidas = true; pintarVuelos(); }
    });
    $("busCerrar").addEventListener("click", cerrarBus);
    $("busSheet").addEventListener("click", function (ev) { if (ev.target === $("busSheet")) cerrarBus(); });
    $("busVuelos").addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("[data-elegir-vuelo]") : null;
      if (!b || !vu.busAbierto) return;
      var bus = vu.busAbierto;
      cerrarBus();
      abrirVuelo(b.getAttribute("data-elegir-vuelo"), bus.interno, bus.t);
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-vista-vuelos]"), function (b) {
      b.addEventListener("click", function () {
        vu.vista = b.getAttribute("data-vista-vuelos");
        Array.prototype.forEach.call(document.querySelectorAll("[data-vista-vuelos]"), function (o) {
          var si = o === b;
          o.classList.toggle("activo", si);
          o.setAttribute("aria-pressed", si ? "true" : "false");
        });
        pintarVuelos();
      });
    });
    $("vuelosBuscar").addEventListener("input", function () { vu.buscar = this.value || ""; pintarVuelos(); });
    $("vuelosOtraVez").addEventListener("click", function () { cargarVuelos(); });
    $("vuelosFallas").addEventListener("click", function (ev) {
      if (ev.target.closest && ev.target.closest("[data-fallas-ok]")) { guardarJson(LS_VUELOS_FALLAS, []); pintarFallasVuelos(); }
    });
    $("vueloCerrar").addEventListener("click", cerrarVuelo);
    $("vueloSheet").addEventListener("click", function (ev) { if (ev.target === $("vueloSheet")) cerrarVuelo(); });
    $("vueloBuses").addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("[data-bus]") : null;
      if (!b) return;
      $("vueloBus").value = "";
      escogerBus(b.getAttribute("data-bus"), b.hasAttribute("data-bus-t") ? Number(b.getAttribute("data-bus-t")) : null);
    });
    $("vueloBus").addEventListener("input", function () {
      var limpio = this.value.replace(/[^0-9A-Za-z-]/g, "").slice(0, 6);
      if (limpio !== this.value) this.value = limpio;
      escogerBus(limpio);
    });
    $("vueloPasajeros").addEventListener("input", function () {
      var n = this.value.replace(/\D/g, "").slice(0, 2);
      if (n && Number(n) > CUPO_BUS) n = String(CUPO_BUS);
      if (n !== this.value) this.value = n;
      errorVuelo("");
      show($("vueloListo"), false);
    });
    $("pasMenos").addEventListener("click", function () { cambiarPasajeros(-1); });
    $("pasMas").addEventListener("click", function () { cambiarPasajeros(1); });
    $("vueloForm").addEventListener("submit", guardarVuelo);
    $("vueloAnotado").addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("[data-quitar]") : null;
      if (b) quitarAnotacion(b.getAttribute("data-quitar"));
    });
    // Cada minuto: lo de "hace 25 min" se mueve, y en la pestaña Vuelos se trae lo nuevo (lo que anotan los demás).
    setInterval(function () {
      if (document.hidden || !estado.yo || !esGestor()) return;
      if (leerJson(LS_VUELOS_COLA, []).length) enviarColaVuelos();
      if (pestana === "vuelos") cargarVuelos(true);
    }, 60 * 1000);
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
    $("btnMiCodigo").addEventListener("click", abrirMiCodigo);
    $("miCodigoCerrar").addEventListener("click", cerrarMiCodigo);
    $("miCodigoListo").addEventListener("click", cerrarMiCodigo);
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
    $("guiaListo").addEventListener("click", cerrarGuia);
    initNoticias();
    initVuelos();
    // El menú de abajo, los atajos del inicio y los enlaces de la guía (data-ir)
    document.addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("[data-ir]") : null;
      if (!b) return;
      ev.preventDefault();
      if (b.getAttribute("data-ir") === "guia") abrirGuia(); else irA(b.getAttribute("data-ir"));
    });
    $("btnDondeEstoy").addEventListener("click", dondeEstoy);
    $("listaPuntos").addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("[data-ver-punto]") : null;
      if (b) verPunto(b.getAttribute("data-ver-punto"));
    });

    window.addEventListener("online", function () {
      pintarRed();
      enviarPendientes();
      if (estado.yo && esGestor()) { enviarColaVuelos(); if (pestana === "vuelos") cargarVuelos(true); }
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
        pintarNoticias();
        presentarNoticia();
        enviarPendientes();
        if (esGestor()) { enviarColaVuelos(); if (pestana === "vuelos") cargarVuelos(true); }
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
