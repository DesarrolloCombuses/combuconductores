/* ==========================================================================
   App de los GESTORES - Combuses
   --------------------------------------------------------------------------
   Aparte del Portal del Conductor a propósito: el portal pide el usuario
   Combuses (correo y clave), y con ese mismo usuario se puede abrir el Portal
   de Control. Los gestores NO lo necesitan: aquí entran con su cédula y la
   huella (o la cara) de su propio celular, sin correo ni clave.

   Sin sesión, la app solo puede usar tres funciones de Supabase
   (almacentro/enturnes/sql/gestores_sin_clave.sql):
     gestor_quien_soy       la cédula es de un gestor vinculado: primer nombre y cargo
     gestor_pedir_celular   pedir que control apruebe ESTE celular (selfie + llave)
     gestor_estado_celular  cómo va ese pedido
   No lee ninguna hoja. La firma y el QR los hace js/gestores.js (el mismo del
   portal); el conductor los lee y revisa en su app, como antes.
   ========================================================================== */
(function () {
  "use strict";

  var VERSION = "g1.0.0";
  var cfg = window.PORTAL_CONFIG || {};
  var RPC_QUIEN_SOY = "gestor_quien_soy";
  var RPC_PEDIR_CELULAR = "gestor_pedir_celular";
  var RPC_ESTADO_CELULAR = "gestor_estado_celular";

  var LS_YO = "gestores_app_yo";              // { dni, nombre, cargo }: quién usa este celular
  var LS_CELULAR = "gestores_app_celular_";   // + cédula: la llave de ESTE celular { credencial, estado, nota }
  var REVISAR_PENDIENTE_MS = 60 * 1000;       // esperando aprobación: se pregunta cada minuto

  // sinRed: la última consulta no llegó al servidor. navigator.onLine no basta: dice
  // "conectado" con un Wi-Fi sin salida.
  var estado = { yo: null, quien: null, revisando: false, sinRed: false };

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
    // Sin permiso o sin la función: falta correr gestores_sin_clave.sql en Supabase.
    if (err.code === "42501" || err.code === "PGRST202" || err.status === 401 || err.status === 404) {
      return "La app de gestores todavía no está habilitada en el servidor. Avísele a control.";
    }
    return err.message || String(err);
  }

  function textoErrorHuella(err, inicio) {
    var nombre = err && err.name;
    if (nombre === "NotAllowedError") return inicio + ": no se puso la huella o se canceló. Intente otra vez.";
    if (nombre === "NotSupportedError" || nombre === "SecurityError") {
      return inicio + ": este celular o navegador no lo permite. Use Chrome (Android) o Safari (iPhone).";
    }
    if (nombre === "InvalidStateError") {
      return inicio + ": este celular ya tiene una llave de gestor. Si cambió de cédula, avísele a control.";
    }
    return inicio + ": " + textoError(err);
  }

  // Si vale la pena intentar: con el teléfono sin red ni se intenta.
  function conRed() { return navigator.onLine !== false; }

  function marcarRed(llego) {
    if (estado.sinRed === !llego) return;
    estado.sinRed = !llego;
    if (estado.yo) pintarRed();
  }

  // -------------------------------------------------------------- vistas
  function mostrarVista(cual) {
    show($("vistaCedula"), cual === "cedula");
    show($("vistaCodigo"), cual === "codigo");
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
        errorCedula("Esa cédula no aparece como gestor vinculado. Revísela; si está bien, avísele a control.");
        return;
      }
      estado.quien = { dni: dni, nombre: r.nombre || "", cargo: r.cargo || "" };
      $("confirmarNombre").textContent = r.nombre || "gestor";
      $("confirmarCargo").textContent = "Cédula " + dni + " · " + capitalizar(r.cargo || "Gestor");
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
    if (!window.confirm("¿Cambiar la cédula de este celular?")) return;
    try { localStorage.removeItem(LS_YO); } catch (_) {}
    estado.yo = null;
    irACedula();
  }

  // ---------------------------------------------------------- 2. Mi código
  function leerCelular() { return estado.yo ? leerJson(LS_CELULAR + estado.yo.dni, null) : null; }
  function guardarCelular(cel) { if (estado.yo) guardarJson(LS_CELULAR + estado.yo.dni, cel); }

  var TEXTO_ESTADO = {
    aprobado: "Celular aprobado",
    pendiente: "Esperando aprobación",
    rechazado: "No lo aprobaron",
    retirado: "Este celular ya no sirve",
  };

  function entrar() {
    var yo = estado.yo;
    $("codigoSaludo").textContent = yo.nombre ? "Hola, " + yo.nombre : "Hola";
    $("codigoCargo").textContent = capitalizar(yo.cargo || "Gestor");
    mostrarVista("codigo");
    cargarCodigo();
  }

  async function cargarCodigo() {
    if (!estado.yo) return;
    if (!(await GestoresQR.sirveEsteCelular())) { pintarCodigo("no_sirve"); return; }
    var cel = leerCelular();
    pintarCodigo(cel ? cel.estado : "sin_activar", cel);
    if (!cel || !conRed() || estado.revisando) return;

    // Cómo va la aprobación (o si control le quitó el celular)
    estado.revisando = true;
    try {
      var r = await rpc(RPC_ESTADO_CELULAR, { p_credencial: cel.credencial }, 10000);
      if (!r) return;
      if (r.estado === "no_esta") {
        try { localStorage.removeItem(LS_CELULAR + estado.yo.dni); } catch (_) {}
        pintarCodigo("sin_activar");
        return;
      }
      cel.estado = r.estado;
      cel.nota = r.nota || "";
      guardarCelular(cel);
      pintarCodigo(cel.estado, cel);
    } catch (_) {
      /* sin señal: queda lo guardado */
    } finally {
      estado.revisando = false;
    }
  }

  function pintarCodigo(cual, cel) {
    var chip = TEXTO_ESTADO[cual]
      ? '<span class="codigo-chip" data-estado="' + cual + '">' + TEXTO_ESTADO[cual] + "</span>"
      : "";
    var html;
    if (cual === "no_sirve") {
      html = '<span class="codigo-chip" data-estado="no_sirve">Este celular no sirve</span>' +
        "<p>Para el código hace falta un celular con huella o reconocimiento de cara, con bloqueo de " +
        "pantalla, y esta app abierta en Chrome (Android) o Safari (iPhone) actualizados.</p>";
    } else if (cual === "aprobado") {
      html = chip +
        '<button id="btnMostrarCodigo" class="btn btn-primary btn-block btn-mostrar" type="button">Mostrar mi código</button>' +
        "<p>Cuando el teléfono lo pida, ponga la huella. Cada código sirve un minuto y una sola vez. " +
        "Funciona sin internet.</p>";
    } else if (cual === "pendiente") {
      html = chip +
        "<p>Control tiene que aprobar este celular. Avísele a un despachador: lo aprueba en el Portal de Control, con su foto.</p>" +
        '<button id="btnRevisarCelular" class="btn btn-ghost btn-block" type="button">Revisar otra vez</button>';
    } else if (cual === "rechazado" || cual === "retirado") {
      html = chip +
        (cel && cel.nota ? "<p>" + escapeHtml(cel.nota) + "</p>" : "") +
        "<p>Si cambió de celular o no le aprobaron la foto, actívelo otra vez.</p>" +
        '<button id="btnActivarCelular" class="btn btn-primary btn-block" type="button">Activar este celular</button>';
    } else {
      html = "<p>Para que los conductores lo reconozcan al subir, active este celular una sola vez: " +
        "se toma una foto y pone la huella. Después control lo aprueba.</p>" +
        '<button id="btnActivarCelular" class="btn btn-primary btn-block" type="button">Activar este celular</button>' +
        '<p class="confirma-nota">Solo para activarlo hace falta internet.</p>';
    }
    $("codigoBody").innerHTML = '<div class="codigo-estado" data-estado="' + cual + '">' + html + "</div>";

    var b;
    if ((b = $("btnMostrarCodigo"))) b.addEventListener("click", mostrarMiCodigo);
    if ((b = $("btnRevisarCelular"))) b.addEventListener("click", cargarCodigo);
    if ((b = $("btnActivarCelular"))) b.addEventListener("click", abrirSelfie);
    pintarRed();
  }

  function pintarRed() {
    var aviso = $("sinRed");
    if (conRed() && !estado.sinRed) { show(aviso, false); return; }
    var cel = leerCelular();
    aviso.textContent = cel && cel.estado === "aprobado"
      ? "Sin internet. Su código sí funciona sin internet."
      : "Sin internet. Para activar el celular hace falta conexión.";
    show(aviso, true);
  }

  // Activar: la selfie (para control y para el conductor) y la huella (la llave).
  var selfie = { stream: null, foto: null };

  function apagarCamara(stream) {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
  }

  function errorSelfie(texto) {
    $("selfieError").textContent = texto || "";
    show($("selfieError"), !!texto);
  }

  function pasoSelfie(tomada) {
    show($("selfieVideo"), !tomada);
    show($("selfieFoto"), tomada);
    show($("selfieTomar"), !tomada);
    show($("selfieUsar"), tomada);
    show($("selfieRepetir"), tomada);
  }

  async function abrirSelfie() {
    selfie.foto = null;
    pasoSelfie(false);
    errorSelfie("");
    show($("selfieSheet"), true);
    $("selfieTomar").disabled = !conRed();
    if (!conRed()) { errorSelfie("Para activar el celular hace falta internet."); return; }
    try {
      selfie.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 640 } }, audio: false,
      });
      if ($("selfieSheet").hidden) { apagarCamara(selfie.stream); selfie.stream = null; return; }
      var v = $("selfieVideo");
      v.srcObject = selfie.stream;
      await v.play();
    } catch (_) {
      errorSelfie("No se pudo abrir la cámara. Dele permiso de cámara a esta app y vuelva a intentar.");
    }
  }

  function cerrarSelfie() {
    apagarCamara(selfie.stream);
    selfie.stream = null;
    show($("selfieSheet"), false);
  }

  function tomarSelfie() {
    var v = $("selfieVideo");
    if (!v.videoWidth) { errorSelfie("La cámara todavía no arranca: espere un segundo."); return; }
    var lado = Math.min(v.videoWidth, v.videoHeight);
    var c = document.createElement("canvas");
    c.width = c.height = 240;   // chica: va en la base y en el celular de cada conductor
    c.getContext("2d").drawImage(v, (v.videoWidth - lado) / 2, (v.videoHeight - lado) / 2, lado, lado, 0, 0, 240, 240);
    selfie.foto = c.toDataURL("image/jpeg", 0.75);
    $("selfieFoto").src = selfie.foto;
    errorSelfie("");
    pasoSelfie(true);
  }

  async function usarSelfie() {
    if (!selfie.foto || !estado.yo) return;
    var btn = $("selfieUsar");
    btn.disabled = true;
    btn.textContent = "Ponga la huella…";
    errorSelfie("");
    try {
      var llave = await GestoresQR.crearLlave(estado.yo.dni, estado.yo.nombre);
      btn.textContent = "Enviando a control…";
      await rpc(RPC_PEDIR_CELULAR, {
        p_dni: estado.yo.dni,
        p_credencial: llave.credencial,
        p_llave: llave.llave,
        p_algoritmo: llave.algoritmo,
        p_selfie: selfie.foto,
        p_dispositivo: String(navigator.userAgent || "").slice(0, 300),
      }, 20000);
      guardarCelular({ credencial: llave.credencial, estado: "pendiente", pedido_en: Date.now(), nota: "" });
      cerrarSelfie();
      pintarCodigo("pendiente", leerCelular());
    } catch (err) {
      errorSelfie(textoErrorHuella(err, "No se pudo activar"));
    } finally {
      btn.disabled = false;
      btn.textContent = "Usar esta foto y poner la huella";
    }
  }

  // Mostrar: huella -> QR de un minuto, con la barra del tiempo que le queda.
  var qr = { timer: null, fin: 0 };

  async function mostrarMiCodigo() {
    var cel = leerCelular();
    if (!cel || cel.estado !== "aprobado") { cargarCodigo(); return; }
    clearInterval(qr.timer);
    $("qrCaja").innerHTML = '<p class="qr-vencido">Ponga la huella para hacer el código…</p>';
    $("qrNombre").textContent = estado.yo.nombre + " · " + capitalizar(estado.yo.cargo || "Gestor");
    $("qrBarra").style.width = "100%";
    $("qrQueda").textContent = "";
    show($("qrOtro"), false);
    show($("qrSheet"), true);

    var firmado;
    try {
      firmado = await GestoresQR.firmar(estado.yo.dni, cel.credencial);
    } catch (err) {
      $("qrCaja").innerHTML = '<p class="qr-vencido">' + escapeHtml(textoErrorHuella(err, "No se hizo el código")) + "</p>";
      show($("qrOtro"), true);
      return;
    }
    if ($("qrSheet").hidden) return;   // lo cerró mientras ponía la huella
    var q = window.qrcode(0, "L");
    q.addData(firmado.texto);
    q.make();
    $("qrCaja").innerHTML = q.createImgTag(6, 12, "Código del gestor");
    qr.fin = firmado.t + GestoresQR.MUESTRA_MS;
    contarQr();
    qr.timer = setInterval(contarQr, 1000);
  }

  function contarQr() {
    var queda = Math.max(0, qr.fin - Date.now());
    $("qrBarra").style.width = (100 * queda / GestoresQR.MUESTRA_MS) + "%";
    if (queda <= 0) {
      clearInterval(qr.timer);
      $("qrCaja").innerHTML = '<p class="qr-vencido">Este código ya venció.</p>';
      $("qrQueda").textContent = "";
      show($("qrOtro"), true);
      return;
    }
    $("qrQueda").textContent = "Sirve " + Math.ceil(queda / 1000) + " segundos más, una sola vez.";
  }

  function cerrarQr() {
    clearInterval(qr.timer);
    $("qrCaja").innerHTML = "";
    show($("qrSheet"), false);
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
    $("qrCerrar").addEventListener("click", cerrarQr);
    $("qrListo").addEventListener("click", cerrarQr);
    $("qrOtro").addEventListener("click", mostrarMiCodigo);
    $("selfieCerrar").addEventListener("click", cerrarSelfie);
    $("selfieTomar").addEventListener("click", tomarSelfie);
    $("selfieRepetir").addEventListener("click", function () { selfie.foto = null; pasoSelfie(false); });
    $("selfieUsar").addEventListener("click", usarSelfie);

    window.addEventListener("online", function () { pintarRed(); if (estado.yo) cargarCodigo(); });
    window.addEventListener("offline", pintarRed);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        if (!$("selfieSheet").hidden) cerrarSelfie();
        return;
      }
      if (estado.yo && $("qrSheet").hidden) cargarCodigo();
    });
    // Esperando aprobación: se pregunta solo cada minuto, con la app a la vista.
    setInterval(function () {
      var cel = leerCelular();
      if (!document.hidden && cel && cel.estado === "pendiente" && $("selfieSheet").hidden) cargarCodigo();
    }, REVISAR_PENDIENTE_MS);

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
