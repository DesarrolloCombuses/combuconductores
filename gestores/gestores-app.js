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

  var VERSION = "g2.7.0";
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
    pintarCuenta();
    mostrarVista("inicio");
    irA("inicio");
    pintarNoticias();
    presentarNoticia();
    pintarRegistros();
    pintarRed();
    enviarPendientes();
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
