/* ==========================================================================
   Portal del Conductor - Combuses
   Cascarón que une los dos módulos existentes (asistencia biométrica y
   despachos aeropuerto) bajo un solo login, un solo manifest y un solo
   service worker.

   Cómo se comparte la sesión con los módulos
   ------------------------------------------
   Los tres documentos (portal + los dos iframes) viven en el mismo origen y
   apuntan al mismo proyecto Supabase, así que supabase-js ya comparte la
   sesión por localStorage bajo la clave sb-<ref>-auth-token. Aun así
   empujamos la sesión por postMessage al módulo de asistencia, porque:
     - iOS/Safari puede particionar el almacenamiento dentro de un iframe;
     - el módulo ya trae implementado ese protocolo (setupEmbeddedAutoLogin),
       así que no hay que tocarle el código.

   Protocolo, tal como lo espera el módulo de asistencia:
     iframe -> portal : { type: "BIOMETRICO_READY" }
     portal -> iframe : { type: "BIOMETRICO_SESSION", payload: {...} }
     iframe -> portal : { type: "BIOMETRICO_SESSION_OK" | "..._FAIL" }
   ========================================================================== */

(function () {
  "use strict";

  var cfg = window.PORTAL_CONFIG;

  if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    document.getElementById("bootOverlay").innerHTML =
      '<p style="padding:24px;text-align:center">Falta configuración en <code>js/portal-config.js</code></p>';
    return;
  }

  var client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  // Clave de localStorage con la elección del día: vehículo, turno y cédula.
  var LS_SELECCION = "portal_seleccion";

  var state = {
    user: null,          // usuario de Supabase Auth
    dni: null,           // cédula del conductor que usa el portal
    conductor: null,     // fila del CSV de nómina (nombre, base, celular...)
    colaboradorId: null, // id en la tabla colaboradores, para leer sus marcas
    turno: null,         // turno elegido (fila de programacion_turnos)
    vehiculo: null,      // número interno que maneja hoy
    turnosVehiculo: [],  // turnos del vehículo, para mostrar el relevo
    seleccion: null,     // elección guardada del día (ver leerSeleccion)
    estadoTurno: null,   // marcas reales del turno (estado_turno_actual)
    vista: "inicio",
    iframes: {},         // id de módulo -> elemento iframe
    noticia: null,       // id de la noticia abierta dentro del portal
    booted: false,
    deferredInstall: null,
  };

  // ------------------------------------------------------------------ utils
  var $ = function (id) { return document.getElementById(id); };

  function escapeHtml(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function show(el, visible) { if (el) el.hidden = !visible; }

  // Solo dígitos: las cédulas llegan con puntos, espacios o guiones según de
  // dónde vengan (CSV, teclado del conductor, programación).
  function normalizarDni(v) { return String(v == null ? "" : v).replace(/\D/g, ""); }

  // Fechas y horas en Colombia (UTC-5, sin horario de verano). No se usa la
  // zona del dispositivo: un móvil mal configurado mostraría el turno de otro
  // día.
  var HORA_MS = 3600000;
  var DIA_MS = 24 * HORA_MS;

  function dos(n) { return String(n).padStart(2, "0"); }

  function fechaColombiaDe(ms) {
    var d = new Date(ms - 5 * HORA_MS);
    return d.getUTCFullYear() + "-" + dos(d.getUTCMonth() + 1) + "-" + dos(d.getUTCDate());
  }

  function hoyColombia() { return fechaColombiaDe(Date.now()); }
  function ayerColombia() { return fechaColombiaDe(Date.now() - DIA_MS); }

  // "2026-09-13" + "05:30:00" -> milisegundos de ese instante en Colombia.
  function msColombia(fecha, hora) {
    var m = String(hora || "").match(/(\d{1,2}):(\d{2})/);
    if (!fecha || !m) return null;
    var ms = Date.parse(String(fecha).slice(0, 10) + "T" + dos(m[1]) + ":" + m[2] + ":00-05:00");
    return isNaN(ms) ? null : ms;
  }

  // Inicio y fin reales de un turno. Si la hora fin es menor que la de inicio,
  // la jornada termina al día siguiente (el turno 2 suele cerrar de
  // madrugada): mismo criterio que usa la base de datos para salida_ts.
  function rangoTurno(t) {
    var inicio = msColombia(t.fecha, t.hora_entrada);
    var fin = msColombia(t.fecha, t.hora_salida);
    if (inicio != null && fin != null && fin < inicio) fin += DIA_MS;
    return { inicio: inicio, fin: fin };
  }

  function estadoTurno(t) {
    var r = rangoTurno(t);
    var ahora = Date.now();
    if (r.fin != null && ahora > r.fin) return "terminado";
    if (r.inicio != null && ahora >= r.inicio) return "en-curso";
    return "proximo";
  }

  // "iniciado" y "cumplido" no salen del reloj sino de las marcas reales (ver
  // estadoConMarcas): cuando existen, mandan sobre la hora programada.
  var ETIQUETA_ESTADO = {
    "proximo": "Próximo", "en-curso": "En curso", "terminado": "Terminado",
    "iniciado": "Iniciado", "cumplido": "Cumplido",
  };

  // Número interno comparable: "0742", " 742" y "742" son el mismo vehículo.
  function normalizarInterno(v) {
    return String(v == null ? "" : v)
      .replace(/[^0-9A-Za-z]/g, "")
      .toUpperCase()
      .replace(/^0+(?=.)/, "");
  }

  function fechaLarga() {
    try {
      var t = new Date().toLocaleDateString("es-CO", {
        weekday: "long", day: "numeric", month: "long",
      });
      // Solo la primera letra en mayúscula. Con text-transform:capitalize el
      // navegador escribía "Jueves, 10 De Septiembre".
      return t.charAt(0).toUpperCase() + t.slice(1);
    } catch (_) { return ""; }
  }

  // "07:30:00" -> "07:30". Acepta también timestamps completos.
  function horaCorta(v) {
    if (!v) return "—";
    var s = String(v);
    var m = s.match(/(\d{1,2}):(\d{2})/);
    return m ? String(m[1]).padStart(2, "0") + ":" + m[2] : s;
  }

  function haceCuanto(iso) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    var min = Math.floor((Date.now() - t) / 60000);
    if (min < 1) return "hace un momento";
    if (min < 60) return "hace " + min + " min";
    var h = Math.floor(min / 60);
    return "hace " + h + " h " + (min % 60) + " min";
  }

  function primerNombre(nombre) {
    if (!nombre) return "";
    var partes = String(nombre).trim().split(/\s+/);
    var p = partes[0] || "";
    return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
  }

  // ------------------------------------------------------- caché de lectura
  // Un conductor consulta su turno en la calle, con datos móviles que a veces
  // no dan. Guardamos la última respuesta buena de cada tarjeta para poder
  // enseñar algo útil sin red, siempre avisando de que es un dato guardado.
  function guardarCache(clave, datos) {
    try {
      localStorage.setItem("portal_cache_" + clave, JSON.stringify({
        fecha: hoyColombia(),
        guardadoEn: Date.now(),
        datos: datos,
      }));
    } catch (_) { /* almacenamiento lleno o bloqueado: seguimos sin caché */ }
  }

  function leerCache(clave) {
    try {
      var crudo = localStorage.getItem("portal_cache_" + clave);
      if (!crudo) return null;
      var obj = JSON.parse(crudo);
      // Lo guardado ayer no sirve: el turno y las marcas son de un día concreto.
      if (!obj || obj.fecha !== hoyColombia()) return null;
      return obj;
    } catch (_) { return null; }
  }

  // Aviso de "esto es lo último que pudimos traer". Lo piden las tarjetas
  // cuando tiran de caché; se limpia en cuanto una carga con red va bien.
  var avisoCache = null;

  function marcarDatosGuardados(guardadoEn) {
    avisoCache = guardadoEn;
    pintarAvisoOffline();
  }

  function limpiarAvisoGuardados() {
    avisoCache = null;
    pintarAvisoOffline();
  }

  function pintarAvisoOffline() {
    var nota = $("offlineNote");
    if (!nota) return;

    if (!navigator.onLine || !internet.ok) {
      $("offlineNoteText").textContent =
        "Sin conexión. Ves la última información guardada" +
        (avisoCache ? " (" + haceCuanto(avisoCache) + ")" : "") + ".";
      show(nota, true);
      return;
    }
    if (avisoCache) {
      $("offlineNoteText").textContent =
        "No se pudo actualizar. Ves lo guardado " + haceCuanto(avisoCache) + ".";
      show(nota, true);
      return;
    }
    show(nota, false);
  }

  // ------------------------------------------------------------------- CSV
  // Parser tolerante a comillas y comas dentro de campos. La nómina viene de
  // una hoja de Google publicada como CSV.
  function parseCsv(texto) {
    var filas = [];
    var campo = "";
    var fila = [];
    var enComillas = false;

    for (var i = 0; i < texto.length; i++) {
      var c = texto[i];
      if (enComillas) {
        if (c === '"') {
          if (texto[i + 1] === '"') { campo += '"'; i++; }
          else enComillas = false;
        } else campo += c;
      } else if (c === '"') {
        enComillas = true;
      } else if (c === ",") {
        fila.push(campo); campo = "";
      } else if (c === "\n") {
        fila.push(campo); filas.push(fila); fila = []; campo = "";
      } else if (c !== "\r") {
        campo += c;
      }
    }
    if (campo.length || fila.length) { fila.push(campo); filas.push(fila); }

    if (!filas.length) return [];
    var cabecera = filas[0].map(function (h) { return String(h).trim().toLowerCase(); });
    return filas.slice(1)
      .filter(function (f) { return f.some(function (c) { return String(c).trim(); }); })
      .map(function (f) {
        var obj = {};
        cabecera.forEach(function (h, idx) { obj[h] = (f[idx] || "").trim(); });
        return obj;
      });
  }

  var conductoresCache = null;

  async function cargarConductores() {
    if (conductoresCache) return conductoresCache;
    if (!cfg.CONDUCTORES_CSV_URL) return [];
    try {
      var res = await fetch(cfg.CONDUCTORES_CSV_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      conductoresCache = parseCsv(await res.text());
      return conductoresCache;
    } catch (err) {
      console.warn("[portal] no se pudo leer la nómina:", err);
      return [];
    }
  }

  // Los datos del conductor se guardan aparte y sin caducidad: el nombre y la
  // base no cambian de un día para otro, y así el saludo y el perfil siguen
  // funcionando aunque la nómina no se pueda descargar por falta de señal.
  async function buscarConductor(dni) {
    var objetivo = normalizarDni(dni);
    var lista = await cargarConductores();
    var encontrado = lista.find(function (c) { return normalizarDni(c.cedula) === objetivo; }) || null;

    if (encontrado) {
      try {
        localStorage.setItem("portal_conductor_" + objetivo, JSON.stringify(encontrado));
      } catch (_) {}
      return encontrado;
    }

    // Sin red la lista llega vacía; no es que la cédula no exista.
    if (!lista.length) {
      try {
        var crudo = localStorage.getItem("portal_conductor_" + objetivo);
        if (crudo) return JSON.parse(crudo);
      } catch (_) {}
    }
    return null;
  }

  // ------------------------------------------------------------------ AUTH
  function initAuth() {
    $("loginForm").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var btn = $("loginSubmit");
      var errorBox = $("loginError");
      show(errorBox, false);
      btn.disabled = true;
      btn.textContent = "Entrando…";

      try {
        var email = $("loginEmail").value.trim();
        var password = $("loginPassword").value;
        var res = await client.auth.signInWithPassword({ email: email, password: password });
        if (res.error) throw res.error;
        if (!res.data || !res.data.user) throw new Error("Respuesta sin usuario");
        // No esperamos a onAuthStateChange: entramos ya.
        state.user = res.data.user;
        await entrar();
      } catch (err) {
        errorBox.textContent = traducirErrorLogin(err);
        show(errorBox, true);
      } finally {
        btn.disabled = false;
        btn.textContent = "Entrar";
      }
    });

    client.auth.onAuthStateChange(function (evento, session) {
      var nuevoId = session && session.user ? session.user.id : null;
      var actualId = state.user ? state.user.id : null;

      if (!nuevoId) {
        if (actualId) mostrarLogin();
        return;
      }
      // Reenviamos la sesión a los iframes en cada refresco de token para que
      // no se les venza por dentro.
      state.user = session.user;
      empujarSesionATodos();

      if (nuevoId !== actualId) entrar();
    });
  }

  function traducirErrorLogin(err) {
    var msg = (err && err.message ? err.message : String(err)).toLowerCase();
    if (msg.indexOf("invalid login") >= 0 || msg.indexOf("credentials") >= 0) {
      return "Usuario o contraseña incorrectos.";
    }
    if (msg.indexOf("failed to fetch") >= 0 || msg.indexOf("network") >= 0) {
      return "Sin conexión. Revisa tus datos móviles o el wifi.";
    }
    return err && err.message ? err.message : "No se pudo iniciar sesión.";
  }

  async function logout() {
    // Quien entre después debe elegir su propio vehículo y turno.
    borrarSeleccion();
    aplicarSeleccion(null);
    try { await client.auth.signOut(); } catch (_) {}
    mostrarLogin();
  }

  function mostrarLogin() {
    state.user = null;
    state.booted = false;
    // Quien entre después empieza por Inicio, no en la pestaña donde se quedó
    // el usuario anterior.
    state.vista = "inicio";
    show($("noticiasSheet"), false);
    show($("noticiaVentana"), false);
    notif.docs = [];
    notif.cerrados = {};
    // Los iframes se destruyen: no queremos dejar cargada la app de otro
    // usuario detrás de la pantalla de login.
    Object.keys(state.iframes).forEach(function (id) {
      var panel = document.querySelector('[data-panel="' + id + '"]');
      if (panel) panel.innerHTML = "";
    });
    state.iframes = {};

    show($("bootOverlay"), false);
    show($("appView"), false);
    show($("identifyView"), false);
    show($("loginView"), true);
    $("loginPassword").value = "";
  }

  // ------------------------------------------------ identificación por cédula
  /* El conductor escribe su cédula y el portal le trae quién es y qué vehículo
     tiene programado hoy, directo de la programación. Él solo confirma.

     La programación trae dos turnos por vehículo al día (conductor 1 y
     conductor 2); un conductor normalmente tiene uno, y si tuviera más de uno
     vigente toca el que va a hacer. Sin programación para hoy puede indicar el
     vehículo a mano y seguir.

     La elección vale por el día. Si el turno cruza la medianoche se mantiene
     hasta unas horas después de la hora fin, para no volver a preguntar a
     mitad de la jornada. */

  var CAMPOS_PROGRAMACION =
    "fecha,turno,dni,hora_entrada,hora_salida,vehiculo,base,puesto,nombre_programacion";

  // Tras la hora fin programada la elección sigue valiendo este rato: el
  // biométrico midió que cerrar la jornada hasta 4 h tarde es habitual.
  var MARGEN_CIERRE_MS = 4 * HORA_MS;

  // Paso de confirmación en pantalla: cédula consultada y lo que se encontró.
  var identificacion = null;

  function leerSeleccion() {
    try {
      var sel = JSON.parse(localStorage.getItem(LS_SELECCION) || "null");
      if (!sel) return null;
      // Los gestores tienen su propia app (gestores/) desde la v1.11.0: una elección
      // de gestor que guardó la v1.10.0 ya no vale y se vuelve a pedir la cédula.
      if (sel.rol === "gestor") { borrarSeleccion(); return null; }
      var vigente = sel.fecha === hoyColombia() ||
        (sel.finMs != null && Date.now() < sel.finMs + MARGEN_CIERRE_MS);
      return vigente ? sel : null;
    } catch (_) { return null; }
  }

  function guardarSeleccion(sel) {
    try { localStorage.setItem(LS_SELECCION, JSON.stringify(sel)); } catch (_) {}
  }

  function borrarSeleccion() {
    try { localStorage.removeItem(LS_SELECCION); } catch (_) {}
  }

  function aplicarSeleccion(sel) {
    var dni = sel && sel.dni ? normalizarDni(sel.dni) : null;
    if (dni !== state.dni) {
      state.colaboradorId = null;
      state.conductor = null;
    }
    state.seleccion = sel || null;
    state.dni = dni;
    state.vehiculo = sel && sel.vehiculo ? String(sel.vehiculo).trim() : null;
    state.turno = sel ? sel.turnoData || null : null;
    state.turnosVehiculo = sel && sel.turnosVehiculo ? sel.turnosVehiculo : [];
    state.estadoTurno = sel ? sel.estadoTurno || null : null;
  }

  // Turnos que importan ahora: los de hoy y, de ayer, solo el que todavía no
  // termina. Ordenados por hora de inicio y sin repetidos.
  //
  // Repetidos: programacion_turnos no tiene restricción de unicidad y se
  // reconstruye fila a fila desde programacion_filas, así que si la
  // programación trae dos veces el mismo renglón (cargada dos veces, o la fila
  // duplicada en la hoja) salen dos turnos idénticos. El biométrico no lo nota
  // porque de varios turnos elige uno solo; aquí se le mostraban los dos al
  // conductor. Se descartan los que coinciden en todo lo que él ve: si difieren
  // en algo (otro vehículo, otro puesto) son turnos distintos y se quedan.
  function turnosVigentes(filas) {
    var hoy = hoyColombia();
    var ayer = ayerColombia();
    var ahora = Date.now();
    var vistos = {};
    return (filas || [])
      .filter(function (t) {
        var clave = [
          t.fecha, t.turno, normalizarInterno(t.vehiculo),
          horaCorta(t.hora_entrada), horaCorta(t.hora_salida),
          normalizarDni(t.dni), t.base, t.puesto,
        ].join("|");
        if (vistos[clave]) return false;
        vistos[clave] = true;
        return true;
      })
      .filter(function (t) {
        if (t.fecha === hoy) return true;
        if (t.fecha !== ayer) return false;
        var r = rangoTurno(t);
        return r.fin != null && ahora < r.fin;
      })
      .sort(function (a, b) {
        return (rangoTurno(a).inicio || 0) - (rangoTurno(b).inicio || 0);
      });
  }

  // Los nombres que no son personas ("SIN CONDUCTOR PROGRAMADO") no cuentan.
  function esNombreDePersona(nombre) {
    var n = String(nombre || "").toUpperCase();
    return n.trim().split(/\s+/).length >= 2 &&
      n.indexOf("SIN CONDUCTOR") < 0 && n.indexOf("SIN PROGRAMAR") < 0;
  }

  // El turno que importa ahora: el que está en curso o el próximo; si todos
  // terminaron, el último.
  function turnoActual(turnos) {
    if (!turnos.length) return null;
    return turnos.find(function (t) { return estadoTurno(t) !== "terminado"; }) ||
      turnos[turnos.length - 1];
  }

  async function consultarTurnosPorDni(dni) {
    var res = await conTiempoLimite(
      client.from(cfg.TABLA_PROGRAMACION_TURNOS)
        .select(CAMPOS_PROGRAMACION)
        .in("fecha", [ayerColombia(), hoyColombia()])
        .eq("dni", dni)
    );
    if (res.error) throw res.error;
    return turnosVigentes(res.data);
  }

  // Programación completa de un vehículo: sirve para saber con quién releva
  // el conductor. Incluye los nombres que aún no tienen cédula cruzada, que no
  // llegan a la tabla de turnos pero sí son el relevo real.
  async function consultarProgramacionVehiculo(interno) {
    var exacto = String(interno).trim();

    var res = await conTiempoLimite(
      client.from(cfg.TABLA_PROGRAMACION_TURNOS)
        .select(CAMPOS_PROGRAMACION)
        .in("fecha", [ayerColombia(), hoyColombia()])
        .eq("vehiculo", exacto)
    );
    if (res.error) throw res.error;
    var turnos = turnosVigentes(res.data);

    var sinCedula = [];
    try {
      var vista = await conTiempoLimite(
        client.from(cfg.VISTA_PROGRAMACION_TURNOS)
          .select("fecha,turno,nombre_programacion,hora_entrada,hora_salida,vehiculo,base,puesto")
          .eq("fecha", hoyColombia())
          .eq("vehiculo", exacto),
        8000
      );
      if (!vista.error) {
        sinCedula = (vista.data || []).filter(function (v) {
          if (!esNombreDePersona(v.nombre_programacion)) return false;
          return !turnos.some(function (t) {
            return t.fecha === v.fecha && Number(t.turno) === Number(v.turno);
          });
        });
      }
    } catch (_) { /* información adicional: si falla, seguimos */ }

    return { turnos: turnos, sinCedula: sinCedula };
  }

  // ------------------------------------------------ marcas reales del turno
  /* Si el conductor ya marcó su entrada con el biométrico, su turno no es
     "Próximo": ya lo inició. Eso lo resuelve la base con estado_turno_actual(),
     la misma función con la que el biométrico decide si deja marcar: empareja
     las marcas con el turno programado (±6 h) y cubre medianoche y cambios de
     turno. El portal solo la consume, para que los dos digan lo mismo. */

  var ICONO_CHECK = '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  // Nunca falla: sin respuesta, el portal sigue con el estado por la hora.
  async function consultarEstadoTurno(dni) {
    try {
      var res = await conTiempoLimite(client.rpc("estado_turno_actual", { p_dni: dni }), 8000);
      var estado = res.data;
      if (res.error || !estado || !estado.ok || !estado.existe) return null;
      if (estado.entrada_real) {
        estado.entrada_origen = await origenDeMarca(dni, estado.entrada_fecha, estado.entrada_real, "entrada");
      }
      return estado;
    } catch (_) { return null; }
  }

  // Quién registró la marca: el conductor con su foto ("movil" o "web", la
  // validación facial del biométrico) o administración ("admin_form", "manual").
  async function origenDeMarca(dni, fecha, hora, sentido) {
    try {
      var colaboradorId = state.dni === dni && state.colaboradorId ? state.colaboradorId : null;
      if (!colaboradorId) {
        var col = await conTiempoLimite(
          client.from("colaboradores").select("id").eq("dni", dni).maybeSingle(), 6000);
        if (col.error || !col.data) return null;
        colaboradorId = col.data.id;
      }
      var res = await conTiempoLimite(
        client.from(cfg.TABLA_ASISTENCIAS)
          .select("hora,origen")
          .eq("colaborador_id", colaboradorId)
          .eq("fecha", fecha)
          .eq("sentido", sentido),
        6000
      );
      if (res.error) return null;
      var marca = (res.data || []).find(function (m) { return horaCorta(m.hora) === horaCorta(hora); });
      return marca ? marca.origen : null;
    } catch (_) { return null; }
  }

  // El estado puede referirse a otro turno (el de ayer en un cambio de turno):
  // solo cuenta para la tarjeta de la misma fecha y el mismo número de turno.
  function esDeEsteTurno(turno, estado) {
    return !!(estado && turno && estado.fecha === turno.fecha &&
      Number(estado.turno) === Number(turno.turno));
  }

  function estadoConMarcas(turno, estado) {
    if (esDeEsteTurno(turno, estado)) {
      if (estado.completa) return "cumplido";
      if (estado.entrada_real) return "iniciado";
    }
    return estadoTurno(turno);
  }

  function marcaDeEntrada(turno, estado) {
    if (!esDeEsteTurno(turno, estado) || !estado.entrada_real) return null;
    var origen = estado.entrada_origen;
    return {
      hora: estado.entrada_real,
      fecha: estado.entrada_fecha,
      salida: estado.completa ? estado.salida_real : null,
      facial: origen === "movil" || origen === "web",
      admin: origen === "admin_form" || origen === "manual",
    };
  }

  function textoMarca(m) {
    var dia = "";
    if (m.fecha && m.fecha !== hoyColombia()) {
      dia = m.fecha === ayerColombia()
        ? " de ayer"
        : " del " + m.fecha.slice(8, 10) + "/" + m.fecha.slice(5, 7);
    }
    var texto = "Entrada registrada a las " + m.hora + dia;
    if (m.facial) texto += " con reconocimiento facial";
    else if (m.admin) texto += " por administración";
    if (m.salida) texto += " · salida " + m.salida;
    return texto;
  }

  // Nómina y programación a la vez, para no sumar esperas con mala señal. Sin
  // red se usa la programación guardada de esa cédula, si la hay.
  async function buscarIdentidad(dni) {
    var resultados = await Promise.all([
      buscarConductor(dni),
      consultarTurnosPorDni(dni)
        .then(function (turnos) {
          guardarCache("turnos_" + dni, turnos);
          return { turnos: turnos, guardadoEn: null, error: null };
        })
        .catch(function (err) {
          var cache = leerCache("turnos_" + dni);
          if (cache) return { turnos: turnosVigentes(cache.datos), guardadoEn: cache.guardadoEn, error: null };
          return { turnos: [], guardadoEn: null, error: err };
        }),
      consultarEstadoTurno(dni),
      consultarColaborador(dni),
    ]);
    return {
      conductor: resultados[0],
      turnos: resultados[1].turnos,
      guardadoEn: resultados[1].guardadoEn,
      error: resultados[1].error,
      estado: resultados[2],
      colaborador: resultados[3],
    };
  }

  // ¿Es un gestor? Sale de colaboradores (la tabla de la asistencia): ahí está
  // el cargo, en "especialidad". La nómina de Google Sheets es solo de conductores.
  async function consultarColaborador(dni) {
    try {
      var res = await conTiempoLimite(client.from(cfg.TABLA_COLABORADORES || "colaboradores")
        .select("dni,nombre,especialidad,estado").eq("dni", dni).limit(1), 10000);
      if (res.error) throw res.error;
      var fila = (res.data || [])[0] || null;
      if (fila) guardarCache("colaborador_" + dni, fila);
      return fila;
    } catch (err) {
      var cache = leerCache("colaborador_" + dni);
      return cache ? cache.datos : null;
    }
  }

  function esGestor(colaborador) {
    return !!colaborador && /gestor/i.test(colaborador.especialidad || "") &&
      String(colaborador.estado || "").toUpperCase() === "VINCULADO";
  }

  function initIdentify() {
    // --- Paso 1: cédula ---
    $("identifyForm").addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var btn = $("identifySubmit");
      var errorBox = $("identifyError");
      var dni = normalizarDni($("identifyDni").value);
      show(errorBox, false);

      if (dni.length < 5) {
        errorBox.textContent = "Escribe una cédula válida.";
        show(errorBox, true);
        return;
      }

      btn.disabled = true;
      btn.textContent = "Buscando tu programación…";
      try {
        var ident = await buscarIdentidad(dni);

        // Un gestor no maneja: tiene su propia app (gestores/), sin el usuario Combuses.
        if (esGestor(ident.colaborador) && !ident.turnos.length) {
          mostrarConfirmacionGestor(dni, ident);
          return;
        }

        if (!ident.conductor && !ident.turnos.length) {
          if (ident.error) {
            errorBox.textContent = navigator.onLine
              ? "No se pudo consultar la programación. Intenta de nuevo."
              : "Sin conexión. Conéctate para buscar tu programación.";
            show(errorBox, true);
            return;
          }
          // Si la nómina cargó y la cédula no está ni ahí ni en la
          // programación, es un error de digitación casi seguro.
          if (conductoresCache && conductoresCache.length) {
            errorBox.textContent = "No encontramos esa cédula en la nómina ni en la programación.";
            show(errorBox, true);
            return;
          }
        }

        mostrarConfirmacion(dni, ident);
      } finally {
        btn.disabled = false;
        btn.textContent = "Buscar mi programación";
      }
    });

    // Si ya había una elección vigente (vino de "Cambiar conductor"), se puede
    // volver sin cambiar nada.
    $("btnCancelarCambio").addEventListener("click", function () {
      var sel = leerSeleccion();
      if (!sel) return;
      aplicarSeleccion(sel);
      mostrarApp();
    });

    // --- Paso 2: confirmar conductor y vehículo ---
    $("btnVolverDeConfirmar").addEventListener("click", function () { mostrarPaso("cedula"); });

    $("turnosLista").addEventListener("click", function (ev) {
      var opcion = ev.target.closest("[data-turno-idx]");
      if (!opcion || !identificacion) return;
      var turno = identificacion.turnos[Number(opcion.dataset.turnoIdx)];
      if (turno) confirmarConductor(turno, null);
    });

    // Sin programación: sigue con el vehículo que escriba, o sin vehículo.
    $("sinProgramacionForm").addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!identificacion) return;
      var interno = String($("vehiculoManualInput").value || "").trim();
      confirmarConductor(null, normalizarInterno(interno) ? interno : null);
    });
  }

  function mostrarPaso(paso) {
    show($("pasoCedula"), paso === "cedula");
    show($("pasoConfirmar"), paso === "confirmar");
    show($("btnCancelarCambio"), paso === "cedula" && !!leerSeleccion());
    if (paso === "cedula") setTimeout(function () { $("identifyDni").focus(); }, 120);
    window.scrollTo(0, 0);
  }

  function mostrarConfirmacionGestor(dni, ident) {
    var g = ident.colaborador;
    identificacion = { dni: dni, gestor: g, conductor: null, turnos: [], estado: null };
    $("confirmarNombre").textContent = g.nombre || "Gestor";
    $("confirmarDni").textContent = "Cédula " + dni + " · " + capitalizarPalabras(g.especialidad || "Gestor");
    $("confirmarPregunta").textContent = "";
    $("turnosLista").innerHTML = "";
    show($("sinProgramacionForm"), false);
    show($("confirmarGestor"), true);
    mostrarPaso("confirmar");
  }

  function mostrarConfirmacion(dni, ident) {
    identificacion = { dni: dni, conductor: ident.conductor, turnos: ident.turnos, estado: ident.estado };
    show($("confirmarGestor"), false);

    var nombre = (ident.conductor && ident.conductor.nombre) ||
      (ident.turnos[0] && ident.turnos[0].nombre_programacion) || "";
    $("confirmarNombre").textContent = nombre || "Conductor sin nombre en la nómina";
    $("confirmarDni").textContent = "Cédula " + dni;

    var aviso = ident.guardadoEn
      ? '<p class="form-hint turnos-aviso">Sin conexión: es la programación guardada ' +
        escapeHtml(haceCuanto(ident.guardadoEn)) + ".</p>"
      : "";
    var hayTurnos = ident.turnos.length > 0;

    if (hayTurnos) {
      var yaEntro = ident.turnos.some(function (t) { return marcaDeEntrada(t, ident.estado); });
      $("confirmarPregunta").textContent = ident.turnos.length === 1
        ? (yaEntro
            ? "Ya registraste la entrada de este turno. Confirma para continuar."
            : "Este es tu vehículo programado. Confirma para continuar.")
        : "Tienes " + ident.turnos.length + " turnos programados. Toca el que vas a hacer.";
      $("turnosLista").innerHTML = aviso + ident.turnos.map(function (t, idx) {
        return opcionTurno(t, idx, ident.estado);
      }).join("");
    } else {
      $("confirmarPregunta").textContent = ident.error
        ? "No se pudo consultar tu programación. Puedes seguir indicando el vehículo."
        : "No tienes vehículo programado para hoy.";
      $("turnosLista").innerHTML = aviso;
    }

    show($("sinProgramacionForm"), !hayTurnos);
    $("vehiculoManualInput").value = "";
    mostrarPaso("confirmar");
  }

  function opcionTurno(t, idx, estadoReal) {
    var estado = estadoConMarcas(t, estadoReal);
    var marca = marcaDeEntrada(t, estadoReal);
    var meta = [t.base, t.puesto].filter(Boolean).join(" · ");
    return '<button type="button" class="turno-opcion" data-turno-idx="' + idx + '" data-estado="' + estado + '">' +
      '<span class="turno-opcion-top">' +
        '<span class="turno-opcion-num">Turno ' + escapeHtml(t.turno) +
          (t.fecha !== hoyColombia() ? " · de ayer" : "") + "</span>" +
        '<span class="estado-chip" data-estado="' + estado + '">' + ETIQUETA_ESTADO[estado] + "</span>" +
      "</span>" +
      '<span class="turno-opcion-vehiculo"><span>Vehículo</span><strong>' +
        escapeHtml(t.vehiculo || "—") + "</strong></span>" +
      '<span class="turno-opcion-horas">' + escapeHtml(horaCorta(t.hora_entrada)) +
        " – " + escapeHtml(horaCorta(t.hora_salida)) + "</span>" +
      (meta ? '<span class="turno-opcion-meta">' + escapeHtml(meta) + "</span>" : "") +
      (marca
        ? '<span class="turno-opcion-marca">' + ICONO_CHECK +
          "<span>" + escapeHtml(textoMarca(marca)) + "</span></span>"
        : "") +
      '<span class="turno-opcion-cta">Confirmar y continuar ›</span>' +
    "</button>";
  }

  function confirmarConductor(turno, vehiculoManual) {
    var id = identificacion;
    var vehiculo = turno && turno.vehiculo ? String(turno.vehiculo).trim() : vehiculoManual;

    cambiarConductor({
      dni: id.dni,
      vehiculo: vehiculo || null,
      vehiculoManual: !turno && !!vehiculoManual,
      fecha: turno ? turno.fecha : hoyColombia(),
      turno: turno ? turno.turno : null,
      turnoData: turno,
      turnosVehiculo: [],   // el relevo se completa al cargar el inicio
      estadoTurno: id.estado || null,
      finMs: turno ? rangoTurno(turno).fin : null,
      guardadoEn: Date.now(),
    });

    // El nombre de la nómina ya llegó en la búsqueda: se usa sin esperar.
    if (id.conductor) {
      state.conductor = id.conductor;
      pintarSaludo();
      pintarPerfil();
    }
  }

  // Aplica una elección nueva. Si cambia la persona se descartan los módulos
  // abiertos: el de asistencia podría tener a medias los datos del anterior.
  function cambiarConductor(sel) {
    var cambiaPersona = normalizarDni(sel.dni) !== state.dni;
    guardarSeleccion(sel);
    aplicarSeleccion(sel);
    if (cambiaPersona) descartarModulos();
    mostrarApp();
    completarConductorEnFondo();
  }

  function cambiarSeleccion() {
    show($("perfilSheet"), false);
    mostrarIdentify();
  }

  function descartarModulos() {
    Object.keys(state.iframes).forEach(function (id) {
      var panel = document.querySelector('[data-panel="' + id + '"]');
      if (panel) panel.innerHTML = "";
    });
    state.iframes = {};
  }

  // La nómina viene de Google Sheets y con mala señal tarda: la app se muestra
  // ya con lo que da la programación y el nombre se completa después.
  async function completarConductorEnFondo() {
    var dni = state.dni;
    if (!dni) return;
    var conductor = await buscarConductor(dni);
    if (state.dni !== dni || !conductor) return; // cambió el conductor mientras tanto
    state.conductor = conductor;
    pintarSaludo();
    pintarPerfil();
  }

  function mostrarIdentify() {
    show($("bootOverlay"), false);
    show($("loginView"), false);
    show($("appView"), false);
    show($("identifyView"), true);
    $("identifyDni").value = "";
    show($("identifyError"), false);
    identificacion = null;
    mostrarPaso("cedula");
  }

  // -------------------------------------------------------------- arranque
  async function entrar() {
    var sel = leerSeleccion();
    if (!sel) { mostrarIdentify(); return; }

    // Lo guardado basta para abrir, incluso sin señal. Se refresca después.
    aplicarSeleccion(sel);
    mostrarApp();
    completarConductorEnFondo();
  }

  function mostrarApp() {
    show($("bootOverlay"), false);
    show($("loginView"), false);
    show($("identifyView"), false);
    show($("appView"), true);

    if (!state.booted) {
      state.booted = true;
      cfg.MODULOS.forEach(function (m) {
        if (m.precarga) crearIframe(m.id);
      });
    }
    empujarSesionATodos();
    MODULOS_CON_CONDUCTOR.forEach(empujarConductor);
    pintarPerfil();
    enviarConfirmacionesPendientes(); // lo confirmado sin señal en la sesión anterior

    // Deja panel, pestaña activa e iframe alineados con la vista guardada
    // (puede venir del hash de un acceso directo del instalador PWA). Si es
    // "inicio", irA() ya se encarga de refrescar sus tarjetas.
    irA(state.vista);
    setTimeout(pedirInstalacion, 2000);
  }

  // ------------------------------------------------------- router de vistas
  function initNav() {
    document.querySelectorAll("[data-nav]").forEach(function (btn) {
      btn.addEventListener("click", function () { irA(btn.dataset.nav); });
    });
    document.querySelectorAll("[data-goto]").forEach(function (btn) {
      btn.addEventListener("click", function () { irA(btn.dataset.goto); });
    });

    window.addEventListener("hashchange", aplicarHash);
  }

  // Navegar por el hash solo tiene sentido con la app abierta. Si llega
  // #/asistencia estando en el login, guardamos el destino y lo aplicamos al
  // entrar, en vez de cargar el módulo detrás de la pantalla de login.
  function aplicarHash() {
    var destino = (location.hash || "").replace(/^#\/?/, "");
    if (!destino || destino === state.vista) return;

    if (!state.user) {
      if (TITULOS[destino]) state.vista = destino;
      return;
    }
    irA(destino, true);
  }

  var TITULOS = {
    inicio: { titulo: "Inicio", sub: "" },
    asistencia: { titulo: "Asistencia", sub: "Registra tu entrada y salida" },
    alistamiento: { titulo: "Alistamiento", sub: "Revisión diaria del bus" },
    aeropuerto: { titulo: "Aeropuerto", sub: "Enturnamiento y mapa en vivo" },
    tiquetes: { titulo: "Tiquetes", sub: "Validación en Distribusion" },
    tarjeta: { titulo: "Mi tarjeta", sub: "Cívica, pasajeros y tiquetes de cada despacho" },
    noticia: { titulo: "Noticia", sub: "" },
  };

  // Vistas del propio portal (sin iframe): Inicio y Mi tarjeta.
  var VISTAS_NATIVAS = { inicio: true, tarjeta: true };

  function irA(vista, desdeHash, confirmado) {
    // El perfil es una hoja, no una vista: no cambia el panel de fondo.
    if (vista === "perfil") { abrirPerfil(); return; }
    if (!TITULOS[vista]) vista = "inicio";
    // Una noticia que ya cerró o que el conductor quitó (o un #/noticia viejo) vuelve al Inicio.
    if (vista === "noticia" && !noticiaParaAbrir()) vista = "inicio";

    // Cada vez que entra a Tiquetes, el conductor confirma primero el vehículo
    // que debe seleccionar en Distribusion (ver pedirConfirmacionTiquetes).
    var panelTiquetes = document.querySelector('[data-panel="tiquetes"]');
    if (vista === "tiquetes" && !confirmado && panelTiquetes && panelTiquetes.hidden) {
      pedirConfirmacionTiquetes(desdeHash);
      return;
    }

    state.vista = vista;

    document.querySelectorAll(".module-panel").forEach(function (p) {
      p.hidden = p.dataset.panel !== vista;
    });
    document.querySelectorAll("[data-nav]").forEach(function (b) {
      // La noticia se abre desde el Inicio: Inicio queda marcado abajo.
      b.classList.toggle("active", b.dataset.nav === (vista === "noticia" ? "inicio" : vista));
    });

    $("topbarTitle").textContent = TITULOS[vista].titulo;
    $("topbarSubtitle").textContent = VISTAS_NATIVAS[vista] && state.vehiculo
      ? "Vehículo " + state.vehiculo
      : TITULOS[vista].sub;
    show($("btnReloadModule"), !VISTAS_NATIVAS[vista]);

    if (!VISTAS_NATIVAS[vista]) {
      crearIframe(vista);
      pintarBusEnBarras();
    }
    if (vista === "inicio") cargarInicio();
    if (vista === "tarjeta") cargarTarjeta();
    // La campana en todas las vistas; el aviso flotante solo en el Inicio.
    pintarNotificaciones();

    if (!desdeHash) {
      try { history.replaceState(null, "", "#/" + vista); } catch (_) {}
    }
  }

  // ------------------------------------------ confirmación antes de tiquetes
  // El portal no puede fijar el bus dentro de Distribusion (es otro dominio).
  // Lo que sí hace: recordarle al conductor qué vehículo debe seleccionar y
  // dejar constancia de que lo confirmó. Sin señal, la constancia espera en el
  // teléfono y sube cuando vuelve la conexión.
  var LS_CONFIRMACIONES = "portal_confirmaciones_tiquetes_pendientes";
  var MAX_CONFIRMACIONES_PENDIENTES = 200;
  var tiquetesDesdeHash = false;
  var enviandoConfirmaciones = false;

  function pedirConfirmacionTiquetes(desdeHash) {
    tiquetesDesdeHash = !!desdeHash;
    var vehiculo = state.vehiculo ? String(state.vehiculo).trim() : "";

    show($("tiquetesConVehiculo"), !!vehiculo);
    show($("tiquetesSinVehiculo"), !vehiculo);

    if (vehiculo) {
      $("tiquetesVehiculo").textContent = vehiculo;
      $("tiquetesVehiculoRecordatorio").textContent = vehiculo;
      $("tiquetesVehiculoBoton").textContent = vehiculo;

      var nombre = (state.conductor && state.conductor.nombre) ||
        (state.turno && state.turno.nombre_programacion) || "";
      var turno = state.turno
        ? "Turno " + state.turno.turno + " · " + horaCorta(state.turno.hora_entrada) +
          " – " + horaCorta(state.turno.hora_salida)
        : "";
      $("tiquetesConductor").textContent = [nombre, turno].filter(Boolean).join(" · ");
    }

    show($("tiquetesSheet"), true);
    try { (vehiculo ? $("btnConfirmarTiquetes") : $("btnTiquetesCambiarConductor")).focus(); } catch (_) {}
  }

  function cerrarConfirmacionTiquetes() {
    show($("tiquetesSheet"), false);
  }

  // Cancelar deja al conductor donde estaba, o en el inicio si llegó directo a
  // Tiquetes por un acceso directo.
  function cancelarTiquetes() {
    cerrarConfirmacionTiquetes();
    var visible = document.querySelector(".module-panel:not([hidden])");
    irA(visible ? visible.dataset.panel : "inicio");
  }

  function confirmarTiquetes() {
    cerrarConfirmacionTiquetes();
    registrarConfirmacionTiquetes();
    irA("tiquetes", tiquetesDesdeHash, true);
  }

  function idLocal() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    } catch (_) { /* navegador sin randomUUID */ }
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  }

  function leerConfirmacionesPendientes() {
    try {
      var lista = JSON.parse(localStorage.getItem(LS_CONFIRMACIONES) || "[]");
      return Array.isArray(lista) ? lista : [];
    } catch (_) { return []; }
  }

  function guardarConfirmacionesPendientes(lista) {
    try {
      localStorage.setItem(LS_CONFIRMACIONES, JSON.stringify(lista.slice(-MAX_CONFIRMACIONES_PENDIENTES)));
    } catch (_) { /* almacenamiento lleno o bloqueado */ }
  }

  function registrarConfirmacionTiquetes() {
    if (!state.vehiculo) return;
    var pendientes = leerConfirmacionesPendientes();
    pendientes.push({
      id_local: idLocal(),
      confirmado_en: new Date().toISOString(),
      dni: state.dni || "",
      conductor: (state.conductor && state.conductor.nombre) ||
        (state.turno && state.turno.nombre_programacion) || null,
      vehiculo: String(state.vehiculo).trim(),
      fecha_turno: state.turno ? state.turno.fecha : null,
      turno: state.turno && state.turno.turno != null ? Number(state.turno.turno) : null,
      user_email: (state.user && state.user.email) || null,
    });
    guardarConfirmacionesPendientes(pendientes);
    enviarConfirmacionesPendientes();
  }

  // Sube en orden lo guardado. Un duplicado (23505) cuenta como enviado: pasa
  // cuando la fila llegó pero la respuesta se perdió por la señal. Cualquier
  // otro error (sin red, tabla aún no creada) deja la cola para después.
  async function enviarConfirmacionesPendientes() {
    if (enviandoConfirmaciones || !navigator.onLine || !state.user) return;
    if (!leerConfirmacionesPendientes().length) return;

    enviandoConfirmaciones = true;
    try {
      while (true) {
        var pendientes = leerConfirmacionesPendientes();
        if (!pendientes.length) break;

        var registro = pendientes[0];
        var res = await conTiempoLimite(
          client.from(cfg.TABLA_CONFIRMACIONES_TIQUETES).insert(registro), 10000
        );
        if (res.error && res.error.code !== "23505") {
          console.warn("[portal] confirmación de tiquetes en espera:", res.error.message || res.error);
          break;
        }
        guardarConfirmacionesPendientes(leerConfirmacionesPendientes().filter(function (r) {
          return r.id_local !== registro.id_local;
        }));
      }
    } catch (err) {
      console.warn("[portal] confirmación de tiquetes en espera:", err && err.message ? err.message : err);
    } finally {
      enviandoConfirmaciones = false;
    }
  }

  function initConfirmacionTiquetes() {
    $("btnConfirmarTiquetes").addEventListener("click", confirmarTiquetes);
    $("btnCancelarTiquetes").addEventListener("click", cancelarTiquetes);
    $("tiquetesSheetClose").addEventListener("click", cancelarTiquetes);
    $("btnTiquetesVolver").addEventListener("click", cancelarTiquetes);
    $("btnTiquetesCambiarConductor").addEventListener("click", function () {
      cerrarConfirmacionTiquetes();
      cambiarSeleccion();
    });

    // Tocar fuera o Escape nunca confirma: se toma como cancelar.
    $("tiquetesSheet").addEventListener("click", function (ev) {
      if (ev.target === $("tiquetesSheet")) cancelarTiquetes();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !$("tiquetesSheet").hidden) cancelarTiquetes();
    });

    window.addEventListener("online", enviarConfirmacionesPendientes);
  }

  // ------------------------------------------------------- módulos (iframes)
  function crearIframe(idModulo) {
    if (idModulo === "noticia") return crearNoticia();
    if (state.iframes[idModulo]) return state.iframes[idModulo];

    var modulo = cfg.MODULOS.find(function (m) { return m.id === idModulo; });
    if (!modulo) return null;

    var panel = document.querySelector('[data-panel="' + idModulo + '"]');
    if (!panel) return null;

    // Distribusion no deja mostrar su página dentro de otra: su frame-ancestors solo admite su sitio y unos socios
    // (Chrome dice "portal.distribusion.com rechazó la conexión"). Desde el 19-oct-2026 se abre aparte, en el
    // navegador, con el bus del turno a la vista y los pasos.
    if (modulo.abrirAparte) {
      panel.appendChild(barraExterna(modulo));
      var caja = document.createElement("div");
      caja.className = "externo-aparte";
      caja.innerHTML =
        '<div class="externo-aparte-tarjeta">' +
          "<h2>" + escapeHtml(modulo.nombreExterno || modulo.nombre) + " se abre aparte</h2>" +
          "<p>" + escapeHtml(modulo.nombreExterno || modulo.nombre) + " no deja abrir su página dentro del portal. " +
            "Toque el botón: se abre en el navegador y, cuando termine, vuelva al portal.</p>" +
          '<a class="btn btn-primary btn-block" href="' + escapeHtml(modulo.src) + '" target="_blank" rel="noopener">Abrir ' +
            escapeHtml(modulo.nombreExterno || modulo.nombre) + "</a>" +
          '<ol class="externo-aparte-pasos">' +
            "<li>Entre con su usuario de Distribusion.</li>" +
            "<li>Seleccione el vehículo <b data-bus-turno>" + escapeHtml(state.vehiculo || "—") + "</b>.</li>" +
            "<li>Escanee los tiquetes.</li>" +
            "<li>Vuelva al portal y anote cuántos escaneó en <b>Mi tarjeta</b>.</li>" +
          "</ol>" +
        "</div>";
      panel.appendChild(caja);
      state.iframes[idModulo] = caja;
      return caja;
    }

    var cargando = document.createElement("div");
    cargando.className = "module-loading";
    cargando.innerHTML = '<div class="boot-spinner"></div><p>Abriendo ' +
      escapeHtml(modulo.nombre.toLowerCase()) + "…</p>";
    panel.appendChild(cargando);

    var frame = document.createElement("iframe");
    frame.id = "frame-" + idModulo;
    frame.title = modulo.nombre;
    frame.setAttribute("allow", modulo.permisos || "");
    frame.setAttribute("referrerpolicy",
      modulo.externo ? "strict-origin-when-cross-origin" : "no-referrer-when-downgrade");
    frame.src = modulo.src;

    frame.addEventListener("load", function () {
      cargando.remove();
      // Un sistema externo nunca recibe la sesión ni la cédula del portal.
      if (modulo.externo) return;
      empujarSesion(idModulo);
      empujarConductor(idModulo);
    });

    if (modulo.externo) panel.appendChild(barraExterna(modulo));
    panel.appendChild(frame);
    state.iframes[idModulo] = frame;
    return frame;
  }

  // La noticia abierta va en su propio panel, como un módulo más: arriba "Volver al inicio" y su nombre, abajo su
  // página (el formulario de Halloween). Es otra aplicación: no está en MODULOS, así que nunca recibe la sesión del
  // portal (empujarSesion la salta). Lo único que recibe es la cédula del conductor (llenarCedulaEnNoticia).
  function crearNoticia() {
    var x = noticiaParaAbrir();
    var panel = document.querySelector('[data-panel="noticia"]');
    if (!x || !panel) return null;
    var hay = state.iframes.noticia;
    if (hay && hay.getAttribute("data-noticia") === x.id) return hay;

    panel.innerHTML = "";
    var nombre = x.corto || x.titulo;
    var barra = document.createElement("div");
    barra.className = "externo-barra noticia-barra";
    barra.innerHTML =
      '<button class="btn btn-ghost btn-sm" type="button">' +
        '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>Volver al inicio</button>' +
      '<span class="noticia-barra-nombre">' + escapeHtml(nombre) + "</span>";
    barra.querySelector("button").addEventListener("click", function () { irA("inicio"); });

    var cargando = document.createElement("div");
    cargando.className = "module-loading";
    cargando.innerHTML = '<div class="boot-spinner"></div><p>Abriendo ' + escapeHtml(nombre.toLowerCase()) + "…</p>";

    var frame = document.createElement("iframe");
    frame.id = "frame-noticia";
    frame.title = nombre;
    frame.setAttribute("data-noticia", x.id);
    frame.setAttribute("allow", x.permisos || "fullscreen");
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    frame.src = x.enlace;
    frame.addEventListener("load", function () {
      cargando.remove();
      llenarCedulaEnNoticia(frame, x);
    });

    panel.appendChild(barra);
    panel.appendChild(cargando);
    panel.appendChild(frame);
    state.iframes.noticia = frame;
    return frame;
  }

  // Pedido del usuario (20-oct-2026): el conductor ya entró con su cédula, que el formulario de la noticia la traiga
  // escrita. Con llenarCedula (el selector del campo) se escribe ahí SOLO la cédula, como si la tecleara: el evento
  // input hace que el formulario de Halloween busque el nombre y el cargo. Funciona porque la página es del mismo
  // sitio (desarrollocombuses.github.io); si no lo es, el campo no está o ya tiene algo, no hace nada y el conductor
  // la escribe como siempre.
  function llenarCedulaEnNoticia(frame, x) {
    if (!x.llenarCedula || !state.dni) return;
    try {
      var doc = frame.contentDocument;
      var campo = doc && doc.querySelector(x.llenarCedula);
      if (!campo || campo.value) return;
      campo.value = String(state.dni);
      campo.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
      // Que se vea de una vez: baja hasta el formulario (sin enfocar, para no abrir el teclado).
      (campo.form || campo).scrollIntoView({ block: "start" });
    } catch (_) { /* otro sitio: el navegador no deja entrar; el conductor la escribe */ }
  }

  function recargarModulo() {
    var frame = state.iframes[state.vista];
    if (!frame) return;
    var panel = document.querySelector('[data-panel="' + state.vista + '"]');
    if (panel) panel.innerHTML = "";
    delete state.iframes[state.vista];
    crearIframe(state.vista);
  }

  // Barra sobre un módulo externo: el bus del turno a la vista, porque el
  // sistema externo no lo recibe y el conductor tiene que escribirlo.
  //
  // Antes esta barra llevaba también un "Abrir aparte" que sacaba el módulo a
  // otra pestaña. Se quitó porque estorbaba en una pantalla que ya es de otro
  // sistema. Si algún día hace falta -- el login de Distribusion CON GOOGLE no
  // funciona dentro de un marco, Google no lo permite; con usuario y contraseña
  // sí -- se devuelve agregando aquí el enlace a modulo.src con target="_blank".
  function barraExterna(modulo) {
    var barra = document.createElement("div");
    barra.className = "externo-barra";
    barra.innerHTML =
      '<div class="externo-dato"><span>Seleccione el vehículo</span>' +
        "<strong data-bus-turno>" + escapeHtml(state.vehiculo || "—") + "</strong></div>";
    return barra;
  }

  function pintarBusEnBarras() {
    document.querySelectorAll("[data-bus-turno]").forEach(function (el) {
      el.textContent = state.vehiculo || "—";
    });
  }

  // --------------------------------------------- propagación de la sesión
  async function obtenerPayloadSesion() {
    try {
      var res = await client.auth.getSession();
      var s = res.data && res.data.session;
      if (!s || !s.access_token || !s.refresh_token) return null;
      return {
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: s.expires_at || null,
        token_type: s.token_type || "bearer",
        user_email: (s.user && s.user.email) || "",
      };
    } catch (_) { return null; }
  }

  async function empujarSesion(idModulo) {
    var frame = state.iframes[idModulo];
    if (!frame || !frame.contentWindow) return;

    // Los tokens de Supabase jamás salen hacia otro dominio. El targetOrigin ya
    // lo impediría; esto evita siquiera intentarlo.
    var modulo = cfg.MODULOS.find(function (m) { return m.id === idModulo; });
    if (!modulo || modulo.externo) return;

    var payload = await obtenerPayloadSesion();
    if (!payload) return;

    try {
      // Mismo origen: basta con location.origin como targetOrigin.
      frame.contentWindow.postMessage(
        { type: "BIOMETRICO_SESSION", payload: payload },
        window.location.origin
      );
    } catch (err) {
      console.warn("[portal] no se pudo enviar la sesión a " + idModulo + ":", err);
    }
  }

  function empujarSesionATodos() {
    Object.keys(state.iframes).forEach(empujarSesion);
  }

  // Cédula del conductor elegido, para que el módulo de asistencia no se la
  // vuelva a pedir (ver modo-portal.js dentro del módulo). El de alistamiento
  // (v1.23.0) la recibe igual, con el bus del turno.
  var MODULOS_CON_CONDUCTOR = ["asistencia", "alistamiento"];

  function empujarConductor(idModulo) {
    if (MODULOS_CON_CONDUCTOR.indexOf(idModulo) < 0 || !state.dni) return;
    var frame = state.iframes[idModulo];
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage({
        type: "PORTAL_CONDUCTOR",
        payload: {
          dni: state.dni,
          vehiculo: state.vehiculo,
          turno: state.turno ? state.turno.turno : null,
        },
      }, window.location.origin);
    } catch (_) { /* el módulo aún no carga: lo pedirá al arrancar */ }
  }

  function initMensajesModulos() {
    window.addEventListener("message", function (event) {
      if (event.origin !== window.location.origin) return;
      var data = event.data;
      if (!data || typeof data !== "object") return;

      switch (data.type) {
        case "BIOMETRICO_READY":
          // El módulo arrancó y pide la sesión. No sabemos cuál iframe la
          // pidió por el evento, así que se la mandamos a todos: el que ya
          // esté logueado simplemente la reaplica.
          empujarSesionATodos();
          empujarConductor("asistencia");
          break;

        case "PORTAL_PEDIR_CONDUCTOR":
          // El módulo de asistencia (o el de alistamiento) arrancó y pide la cédula elegida.
          MODULOS_CON_CONDUCTOR.forEach(empujarConductor);
          break;

        case "PORTAL_ALISTAMIENTO_REGISTRADO":
          // El módulo de alistamiento registró el de hoy (o encontró que ya estaba): el Inicio pasa a verde.
          cargarAlistamiento(true);
          break;

        case "BIOMETRICO_SESSION_FAIL":
          console.warn("[portal] un módulo rechazó la sesión:", data.error || "");
          break;

        case "PORTAL_MARCA_REGISTRADA":
          // El módulo de asistencia avisa que se registró una marca: quedan
          // desactualizados el resumen de jornada y el estado del turno.
          cargarJornada();
          cargarTurno();
          break;
      }
    });
  }

  // ---------------------------------------------------------------- INICIO
  // cargarTurno() es quien dispara cargarFila(), cargarTarjeta(),
  // cargarViajes() y cargarDocumentos(), porque se ubican por el vehículo que
  // da el turno: no tiene sentido pedirlos antes.
  function cargarInicio() {
    pintarSaludo();
    pintarNotificaciones();
    presentarNoticia();
    cargarTurno();
    cargarJornada();
    enviarNovedadesPendientes();
  }

  // ------------------------------------------------------------- noticias
  // Las noticias de la empresa (cfg.NOTICIAS) salen solo entre su desde y su hasta: en la campana de arriba, con el
  // número, que abre la hoja Noticias con cada una completa; y en el Inicio, como un aviso flotante pequeño abajo.
  // Al abrirla se ve dentro del portal (vista "noticia"); con abrirAparte, en el navegador. "Ya los inscribí…" la
  // quita de este celular; la X del aviso lo cierra solo por hoy (queda guardado en el teléfono).
  var NOTICIAS_OCULTAS = "portal_noticias_ocultas";
  var NOTICIAS_AVISADAS = "portal_noticias_avisadas";

  // v1.19.0: los documentos vencidos o por vencer del bus del turno y la licencia (los pone pintarDocumentos). El
  // aviso de uno vencido, cerrado, vuelve al abrir otra vez la app (cerrados vive solo en memoria); el de uno por
  // vencer, una vez al día (como las noticias).
  var notif = { docs: [], cerrados: {} };

  function noticiasOcultas() {
    try { return JSON.parse(localStorage.getItem(NOTICIAS_OCULTAS) || "[]") || []; } catch (_) { return []; }
  }

  function noticiasAvisadas() {
    try { return JSON.parse(localStorage.getItem(NOTICIAS_AVISADAS) || "{}") || {}; } catch (_) { return {}; }
  }

  // El aviso flotante de esa noticia ya se vio (Ver) o se cerró (X) hoy: vuelve mañana mientras siga vigente.
  function marcarAvisada(id) {
    var avisadas = noticiasAvisadas();
    avisadas[id] = hoyColombia();
    try { localStorage.setItem(NOTICIAS_AVISADAS, JSON.stringify(avisadas)); } catch (_) { /* sin espacio: solo por ahora */ }
  }

  function noticiasVigentes() {
    var ahora = Date.now();
    var ocultas = noticiasOcultas();
    return (cfg.NOTICIAS || []).filter(function (x) {
      return x && x.id && x.enlace && ocultas.indexOf(x.id) < 0 &&
        (!x.desde || Date.parse(x.desde) <= ahora) && (!x.hasta || ahora <= Date.parse(x.hasta));
    });
  }

  // La noticia que se abre dentro del portal: la que tocó el conductor o, si no (un #/noticia al recargar), la
  // primera vigente.
  function noticiaParaAbrir() {
    var lista = noticiasVigentes().filter(function (x) { return !x.abrirAparte; });
    var x = lista.find(function (n) { return n.id === state.noticia; }) || lista[0] || null;
    if (x) state.noticia = x.id;
    return x;
  }

  function quedaDeNoticia(x) {
    if (!x.hasta) return "";
    var dias = Math.ceil((Date.parse(x.hasta) - Date.now()) / 86400000);
    return dias <= 1 ? "último día" : "quedan " + dias + " días";
  }

  // La tarjeta de una noticia: imagen, etiqueta, título, texto, plazo, el botón y "Ya los inscribí…". La usan la
  // hoja de la campana y la ventana que sale al abrir el Inicio (enVentana: con la X y "Ahora no").
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
            '<img src="' + escapeHtml(x.imagen) + '" alt="" width="640" height="394" decoding="async"></div>'
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

  function pintarNotificaciones() {
    var box = $("noticias");
    if (!box) return;
    var lista = noticiasVigentes();
    box.innerHTML = lista.map(function (x) { return tarjetaNoticia(x, false); }).join("");

    // Los documentos vencidos o por vencer, arriba de las noticias, como en la tarjeta "Documentos del bus".
    var docsBox = $("notifDocs");
    docsBox.innerHTML = notif.docs.length
      ? '<h4 class="notif-titulo">Documentos</h4>' +
        '<ul class="docs-lista">' + notif.docs.map(function (d) {
          return '<li class="doc">' +
            '<div class="doc-info">' +
              '<span class="doc-nombre">' + escapeHtml(d.titulo) + "</span>" +
              '<span class="doc-detalle">' + escapeHtml(d.detalle + ". " + d.consejo) + "</span>" +
            "</div>" +
            '<span class="doc-estado" data-nivel="' + d.nivel + '">' + (d.nivel === "vencido" ? "Vencido" : "Por vencer") + "</span>" +
          "</li>";
        }).join("") + "</ul>" +
        '<button class="btn btn-ghost btn-block btn-sm" type="button" data-ver-documentos>Ver los documentos</button>' +
        (lista.length ? '<h4 class="notif-titulo">Noticias de la empresa</h4>' : "")
      : "";
    show(docsBox, notif.docs.length > 0);

    // La campana de arriba: sale solo si hay algo, con cuántas.
    var total = notif.docs.length + lista.length;
    var campana = $("btnNoticias");
    show(campana, total > 0);
    $("noticiasCuenta").textContent = total ? String(total) : "";
    campana.setAttribute("aria-label", total === 1 ? "Notificaciones: hay 1" : "Notificaciones: hay " + total);
    if (!total) show($("noticiasSheet"), false);
    pintarAvisoNoticia();
  }

  // Los documentos vencidos o por vencer (v1.19.0): los del bus del turno (los mismos de la tarjeta "Documentos del
  // bus") y la licencia del conductor. El más urgente primero: los vencidos, después el que vence antes.
  function alertasDeDocumentos(datos) {
    var lista = [];
    var interno = state.vehiculo ? String(state.vehiculo).trim() : "";
    if (datos.vehiculo) {
      DOC_TIPOS.forEach(function (t) {
        var fila = datos.porTipo[t.tipo];
        var est = estadoDocumento(t, fila);
        if (est.nivel !== "vencido" && est.nivel !== "pronto") return;
        lista.push({
          id: "doc-" + datos.vehiculo.placa + "-" + t.tipo + "-" + fila.fecha_vencimiento,
          nivel: est.nivel, dias: diasHasta(fila.fecha_vencimiento),
          titulo: t.nombre + " del bus " + (interno || datos.vehiculo.interno || datos.vehiculo.placa),
          detalle: est.detalle,
          consejo: est.nivel === "vencido" ? "Avísale a tu coordinador antes de salir" : "Avísale a tu coordinador",
        });
      });
    }
    if (datos.licencia) {
      var lic = estadoDocumento({ nombre: "Licencia" }, datos.licencia);
      if (lic.nivel === "vencido" || lic.nivel === "pronto") {
        lista.push({
          id: "doc-licencia-" + datos.licencia.fecha_vencimiento,
          nivel: lic.nivel, dias: diasHasta(datos.licencia.fecha_vencimiento),
          titulo: "Tu licencia de conducción",
          detalle: lic.detalle,
          consejo: lic.nivel === "vencido" ? "Renuévala y lleva la nueva a tu coordinador" : "Renuévala a tiempo y lleva la nueva a tu coordinador",
        });
      }
    }
    return lista.sort(function (a, b) { return a.dias - b.dias; });
  }

  // El aviso flotante de un documento: rojo si venció, amarillo si vence pronto. Dice cuántos más hay.
  function pintarAvisoDocumento(aviso, d) {
    var otros = notif.docs.length - 1;
    var id = escapeHtml(d.id);
    aviso.setAttribute("data-noticia", d.id);
    aviso.setAttribute("data-tema", d.nivel);
    aviso.innerHTML =
      '<span class="aviso-noticia-alerta">' + ICONO_ALERTA + "</span>" +
      '<div class="aviso-noticia-texto"><strong>' + escapeHtml(d.titulo) + "</strong>" +
        "<span>" + escapeHtml(d.detalle + (otros > 0 ? " · y " + (otros === 1 ? "1 documento más" : otros + " documentos más") : "")) +
        "</span></div>" +
      '<button class="btn btn-sm" type="button" data-aviso-doc="' + id + '">Ver</button>' +
      '<button class="icon-btn aviso-noticia-cerrar" type="button" data-aviso-doc-cerrar="' + id + '" ' +
        'aria-label="Cerrar el aviso" title="Cerrar el aviso">' + '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>' + "</button>";
    show(aviso, true);
  }

  // Ver o cerrar el aviso de documentos lo deja quieto para todos los de ahora: los vencidos hasta que se vuelva a
  // abrir la app; los por vencer, hasta mañana.
  function cerrarAvisosDeDocumentos() {
    notif.docs.forEach(function (d) {
      if (d.nivel === "vencido") notif.cerrados[d.id] = true;
      else marcarAvisada(d.id);
    });
  }

  // Lleva al Inicio, a la tarjeta "Documentos del bus", y la resalta un momento.
  function verDocumentos() {
    show($("noticiasSheet"), false);
    if (state.vista !== "inicio") irA("inicio");
    pintarAvisoNoticia();
    var card = $("cardDocumentos");
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "start" });
    card.classList.add("resaltar");
    setTimeout(function () { card.classList.remove("resaltar"); }, 2500);
  }

  // El aviso flotante pequeño, solo mirando el Inicio: los documentos vencidos o por vencer (el más urgente). Las
  // noticias ya no van aquí: salen completas en la ventana (presentarNoticia, v1.20.0).
  function pintarAvisoNoticia() {
    var aviso = $("avisoNoticia");
    if (!aviso) return;
    var hoy = hoyColombia();
    var avisadas = noticiasAvisadas();
    var enInicio = state.vista === "inicio" && !$("appView").hidden;
    var doc = enInicio ? notif.docs.find(function (d) { return !notif.cerrados[d.id] && avisadas[d.id] !== hoy; }) : null;
    if (doc) pintarAvisoDocumento(aviso, doc);
    else show(aviso, false);
  }

  // La ventana de la noticia (v1.20.0, pedido del usuario: el aviso pequeño "no es informativo"; que salga encima para
  // que la abran). Al abrir el Inicio, la primera noticia vigente que hoy no se haya presentado sale completa encima de
  // todo: imagen, texto, plazo y el botón. Una vez al día: "Ahora no" o la X la dejan para mañana, el botón la abre y
  // "Ya los inscribí…" la quita. No sale si hay otra hoja abierta (instalar, perfil, tiquetes...).
  var NOTICIAS_PRESENTADAS = "portal_noticias_presentadas";
  var presentarTimer = null;

  function noticiasPresentadas() {
    try { return JSON.parse(localStorage.getItem(NOTICIAS_PRESENTADAS) || "{}") || {}; } catch (_) { return {}; }
  }

  function presentarNoticia() {
    clearTimeout(presentarTimer);
    presentarTimer = setTimeout(function () {
      var ventana = $("noticiaVentana");
      if (!ventana || !ventana.hidden || state.vista !== "inicio" || $("appView").hidden) return;
      var ocupado = ["bootOverlay", "perfilSheet", "tiquetesSheet", "instalarSheet", "noticiasSheet", "danoSheet",
        "corrSheet", "sinInternet", "sinUbicacion"].some(function (id) { return $(id) && !$(id).hidden; });
      if (ocupado) return;
      var hoy = hoyColombia();
      var vistas = noticiasPresentadas();
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
      var vistas = noticiasPresentadas();
      vistas[id] = hoyColombia();
      try { localStorage.setItem(NOTICIAS_PRESENTADAS, JSON.stringify(vistas)); } catch (_) { /* sin espacio: solo por ahora */ }
    }
    show($("noticiaVentana"), false);
    return id;
  }

  // "Ya los inscribí o no tengo hijos de esa edad": no vuelve a salir en este celular (ni ventana ni campana).
  function ocultarNoticia(id) {
    var ocultas = noticiasOcultas();
    if (ocultas.indexOf(id) < 0) ocultas.push(id);
    try { localStorage.setItem(NOTICIAS_OCULTAS, JSON.stringify(ocultas)); } catch (_) { /* sin espacio: solo por ahora */ }
    pintarNotificaciones();
  }

  function abrirNoticia(id) {
    state.noticia = id;
    show($("noticiasSheet"), false);
    irA("noticia");
  }

  function initNoticias() {
    function cerca(ev, sel) { return ev.target.closest ? ev.target.closest(sel) : null; }

    $("btnNoticias").addEventListener("click", function () {
      pintarNotificaciones();
      show($("noticiasSheet"), true);
    });
    $("noticiasSheetClose").addEventListener("click", function () { show($("noticiasSheet"), false); });
    $("noticiasSheet").addEventListener("click", function (ev) {
      if (ev.target === $("noticiasSheet")) { show($("noticiasSheet"), false); return; }
      if (cerca(ev, "[data-ver-documentos]")) { verDocumentos(); return; }
      var abrir = cerca(ev, "[data-abrir-noticia]");
      if (abrir) { abrirNoticia(abrir.getAttribute("data-abrir-noticia")); return; }
      var b = cerca(ev, "[data-ocultar-noticia]");
      if (b) ocultarNoticia(b.getAttribute("data-ocultar-noticia"));
    });

    // La ventana: el botón la abre (dentro del portal), "Ahora no", la X o tocar afuera la dejan para mañana.
    $("noticiaVentana").addEventListener("click", function (ev) {
      var abrir = cerca(ev, "[data-abrir-noticia]");
      var ocultar = cerca(ev, "[data-ocultar-noticia]");
      var aparte = cerca(ev, "a[target=_blank]");
      if (ev.target !== $("noticiaVentana") && !abrir && !ocultar && !aparte && !cerca(ev, "[data-noticia-luego]")) return;
      var id = cerrarVentanaNoticia();
      if (abrir) abrirNoticia(abrir.getAttribute("data-abrir-noticia"));
      else if (ocultar) ocultarNoticia(id);
    });

    $("avisoNoticia").addEventListener("click", function (ev) {
      var verDoc = cerca(ev, "[data-aviso-doc]");
      if (verDoc || cerca(ev, "[data-aviso-doc-cerrar]")) {
        cerrarAvisosDeDocumentos();
        if (verDoc) verDocumentos(); else pintarAvisoNoticia();
        return;
      }
    });

    // Que se quiten solas al terminar el plazo, aunque la app quede abierta.
    setInterval(function () { if (!$("appView").hidden) pintarNotificaciones(); }, 10 * 60 * 1000);
  }

  function pintarSaludo() {
    var completo = (state.conductor && state.conductor.nombre) ||
      (state.turno && state.turno.nombre_programacion) || "";
    var nombre = primerNombre(completo);
    $("homeGreeting").textContent = nombre ? "Hola, " + nombre : "Hola";
    $("homeDate").textContent = fechaLarga();
  }

  // Esqueletos mientras llegan los datos: con una conexión lenta, un bloque
  // que late dice "viene en camino" mejor que la palabra "Cargando".
  function esqueleto(box, forma) {
    if (forma === "turno") {
      box.innerHTML =
        '<div class="skeleton skeleton-titulo"></div>' +
        '<div class="skeleton skeleton-bloque"></div>';
    } else if (forma === "lineas") {
      box.innerHTML =
        '<div class="skeleton skeleton-linea"></div>' +
        '<div class="skeleton skeleton-linea" style="width:70%"></div>';
    } else {
      box.innerHTML = '<div class="skeleton skeleton-bloque"></div>';
    }
  }

  // Una consulta a Supabase que no puede quedarse colgada: con señal débil,
  // fetch puede tardar minutos en rendirse y la tarjeta se queda en blanco.
  function conTiempoLimite(promesa, ms) {
    return Promise.race([
      promesa,
      new Promise(function (_, rechazar) {
        setTimeout(function () { rechazar(new Error("La conexión tardó demasiado")); }, ms || 12000);
      }),
    ]);
  }

  // ------------------------------------------------------------- mi turno
  // El turno ya llegó con la confirmación: se pinta al instante y luego se
  // refresca contra el servidor para recoger cambios de última hora en la
  // programación y completar el relevo.
  async function cargarTurno() {
    var box = $("turnoBody");
    var sel = state.seleccion;

    if (!sel || !sel.dni) {
      box.innerHTML = '<p class="placeholder">Ingresa tu cédula para ver tu turno.</p>';
      cargarFila();
      cargarTarjeta();
      cargarViajes();
      cargarDocumentos();
      cargarAlistamiento();
      return;
    }

    if (state.turno) pintarTurno(state.turno); else esqueleto(box, "turno");
    cargarFila();
    cargarTarjeta();
    cargarViajes();
    cargarDocumentos();
    cargarAlistamiento();

    var vehiculoAntes = state.vehiculo;
    try {
      // Programación y marcas reales a la vez. El estado nunca falla (devuelve
      // null), así que solo la programación puede tumbar la carga.
      var consultas = await Promise.all([
        consultarTurnosPorDni(sel.dni),
        consultarEstadoTurno(sel.dni),
      ]);
      var turnos = consultas[0];
      if (state.seleccion !== sel) return; // cambió de conductor mientras tanto
      if (consultas[1]) sel.estadoTurno = consultas[1];
      guardarCache("turnos_" + sel.dni, turnos);

      // El mismo turno que confirmó; si ya no está (cambió la programación),
      // el que le corresponda ahora.
      var turno = turnos.find(function (t) {
        return sel.turno != null && t.fecha === sel.fecha && Number(t.turno) === Number(sel.turno);
      }) || turnoActual(turnos);

      sel.turnoData = turno;
      if (turno) {
        sel.fecha = turno.fecha;
        sel.turno = turno.turno;
        sel.vehiculo = turno.vehiculo ? String(turno.vehiculo).trim() : sel.vehiculo;
        sel.vehiculoManual = false;
        sel.finMs = rangoTurno(turno).fin;
      } else if (!sel.vehiculoManual) {
        sel.vehiculo = null;
      }

      // Con quién releva: es un extra; si falla, lo demás queda igual.
      sel.turnosVehiculo = [];
      if (turno && turno.vehiculo) {
        try {
          var prog = await consultarProgramacionVehiculo(turno.vehiculo);
          if (state.seleccion !== sel) return;
          sel.turnosVehiculo = prog.turnos.concat(prog.sinCedula);
        } catch (_) { /* sin relevo esta vez */ }
      }

      sel.guardadoEn = Date.now();
      guardarSeleccion(sel);
      aplicarSeleccion(sel);
      limpiarAvisoGuardados();
      pintarTurno(state.turno);
      pintarPerfil();
      // Si cambió el vehículo del turno, su fila y sus viajes son otros.
      if (state.vehiculo !== vehiculoAntes) {
        cargarFila();
        cargarTarjeta();
        cargarViajes();
        cargarDocumentos();
        cargarAlistamiento();
        pintarBusEnBarras();
      }
    } catch (err) {
      // Sin red se queda lo ya pintado, avisando de cuándo es el dato.
      if (state.turno || sel.vehiculoManual) {
        marcarDatosGuardados(sel.guardadoEn);
        if (!state.turno) pintarTurno(null);
        return;
      }
      pintarErrorTarjeta(box, "No se pudo cargar tu turno.", err, cargarTurno);
    }
  }

  // Lo más importante del portal: que el conductor registre su ingreso y su
  // salida. El botón dice cuál le toca según las marcas del turno y lo lleva a
  // Asistencia, que es donde se registra. Con la jornada cumplida desaparece.
  var ICONO_INGRESO = '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5M15 12H3"/></svg>';
  var ICONO_SALIDA = '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/></svg>';

  function botonMarcar(turno) {
    var marca = turno ? marcaDeEntrada(turno, state.estadoTurno) : null;
    if (marca && marca.salida) return "";
    var salida = !!marca;
    var texto = !turno ? "Marcar ingreso o salida" : salida ? "Marcar salida" : "Marcar ingreso";
    return '<button class="btn btn-block btn-marcar" type="button" data-marcar>' +
      (salida ? ICONO_SALIDA : ICONO_INGRESO) + escapeHtml(texto) + "</button>";
  }

  function enlazarBotonMarcar(box) {
    var btn = box.querySelector("[data-marcar]");
    if (btn) btn.addEventListener("click", function () { irA("asistencia"); });
  }

  function pintarTurno(turno) {
    var box = $("turnoBody");

    if (!turno) {
      box.innerHTML = '<p class="placeholder">No tienes turno programado para hoy.' +
        (state.vehiculo
          ? " Vehículo indicado: <strong>" + escapeHtml(state.vehiculo) + "</strong>."
          : "") +
        "</p>" +
        botonMarcar(null);
      enlazarBotonMarcar(box);
      return;
    }

    var estado = estadoConMarcas(turno, state.estadoTurno);
    var marca = marcaDeEntrada(turno, state.estadoTurno);
    var relevo = relevoDe(turno, state.turnosVehiculo);

    box.innerHTML =
      '<div class="turno-hero">' +
        '<span class="turno-horas">' + escapeHtml(horaCorta(turno.hora_entrada)) +
          " – " + escapeHtml(horaCorta(turno.hora_salida)) + "</span>" +
        '<span class="turno-etiqueta">Turno ' + escapeHtml(turno.turno) +
          " · " + ETIQUETA_ESTADO[estado] + "</span>" +
      "</div>" +
      (marca
        ? '<div class="turno-marca">' + ICONO_CHECK +
          "<span>" + escapeHtml(textoMarca(marca)) + "</span></div>"
        : "") +
      '<dl class="datos-grid">' +
        '<div class="dato"><dt>Vehículo</dt><dd>' + escapeHtml(turno.vehiculo || state.vehiculo || "—") + "</dd></div>" +
        '<div class="dato"><dt>Base</dt><dd>' + escapeHtml(turno.base || "—") + "</dd></div>" +
        '<div class="dato"><dt>Puesto</dt><dd>' + escapeHtml(turno.puesto || "—") + "</dd></div>" +
      "</dl>" +
      (relevo
        ? '<div class="turno-relevo">' +
            '<span class="turno-relevo-verbo">' + relevo.verbo + "</span>" +
            "<strong>" + escapeHtml(relevo.nombre) + "</strong>" +
            '<span class="turno-relevo-hora">Relevo programado a las ' + escapeHtml(relevo.hora) + "</span>" +
          "</div>"
        : "") +
      botonMarcar(turno);
    enlazarBotonMarcar(box);
  }

  // Con quién se cruza el conductor en el vehículo. La hora de INICIA 2 es un
  // límite, no la hora exacta del relevo, así que se presenta como programada.
  function relevoDe(turno, turnos) {
    if (!turno || !turnos || !turnos.length) return null;
    var esPrimero = Number(turno.turno) === 1;
    var otro = turnos.find(function (t) {
      return t.fecha === turno.fecha && Number(t.turno) === (esPrimero ? 2 : 1);
    });
    if (!otro || !otro.nombre_programacion) return null;
    return esPrimero
      ? { verbo: "Entregas el vehículo a", nombre: otro.nombre_programacion, hora: horaCorta(turno.hora_salida) }
      : { verbo: "Recibes el vehículo de", nombre: otro.nombre_programacion, hora: horaCorta(turno.hora_entrada) };
  }

  // Error con botón de reintentar: en la calle, la señal vuelve sola y el
  // conductor necesita poder insistir sin recargar toda la aplicación.
  function pintarErrorTarjeta(box, mensaje, err, reintentar) {
    var detalle = err && err.message ? err.message : String(err || "");
    box.innerHTML =
      '<p class="placeholder">' + escapeHtml(mensaje) +
      (detalle ? '<br><span style="font-size:12.5px;opacity:.75">' + escapeHtml(detalle) + "</span>" : "") +
      "</p>" +
      '<button class="btn btn-ghost btn-sm" type="button" data-reintentar style="margin-top:11px">' +
      "Reintentar</button>";

    var btn = box.querySelector("[data-reintentar]");
    if (btn && reintentar) btn.addEventListener("click", reintentar);
  }

  // ---------------------------------------------------------- viajes de hoy
  // Los viajes que lleva hoy el bus del turno: los despachos ACTIVOS de
  // despachos_realizados (la tabla de la pestaña Realizados del aeropuerto)
  // con ese número interno desde las 00:00.
  var PALABRAS_RUTA = { tunel: "Túnel", ccsandiego: "CC San Diego", terminalnorte: "Terminal Norte" };

  var viajes = { clave: null, vehiculo: null, lista: null, guardadoEn: null, error: null, cargandoClave: null };

  function horaDeMs(ms) {
    var d = new Date(ms - 5 * HORA_MS);
    return dos(d.getUTCHours()) + ":" + dos(d.getUTCMinutes());
  }

  function capitalizarPalabras(s) {
    return String(s || "").toLowerCase().replace(/(^|\s)(\S)/g, function (_, esp, letra) {
      return esp + letra.toUpperCase();
    });
  }

  // "Almacentro-Tunel-Aeropuerto" -> "Almacentro → Túnel → Aeropuerto"
  function rutaLegible(s) {
    var tramos = String(s || "").split(/\s*-\s*/).filter(Boolean);
    if (!tramos.length) return "Sin itinerario";
    return tramos.map(function (t) {
      return PALABRAS_RUTA[t.toLowerCase().replace(/\s+/g, "")] || capitalizarPalabras(t);
    }).join(" → ");
  }

  // La programación y la tabla pueden escribir el interno distinto ("737",
  // " 737 "): se pregunta por las dos formas.
  function variantesInterno(vehiculo) {
    var crudo = String(vehiculo).trim();
    var limpio = normalizarInterno(crudo);
    return crudo === limpio ? [crudo] : [crudo, limpio];
  }

  async function consultarViajesHoy(vehiculo) {
    var res = await conTiempoLimite(
      client
        .from(cfg.TABLA_DESPACHOS_REALIZADOS)
        .select("id,created_at,itinerario")
        .in("interno", variantesInterno(vehiculo))
        .eq("estado", "ACTIVO")
        .gte("created_at", new Date(msColombia(hoyColombia(), "00:00")).toISOString())
        .order("created_at", { ascending: false })
        .limit(100)
    );
    if (res.error) throw res.error;

    return (res.data || [])
      .map(function (r) { return { ms: Date.parse(r.created_at), ruta: r.itinerario || "" }; })
      .filter(function (v) { return !isNaN(v.ms); });
  }

  function cargarViajes() {
    var box = $("viajesBody");
    var btn = $("btnRefrescarViajes");
    var vehiculo = state.vehiculo ? String(state.vehiculo).trim() : "";

    if (!vehiculo) {
      viajes.clave = null;
      show(btn, false);
      box.innerHTML = '<p class="placeholder">Cuando tengas vehículo asignado verás aquí sus viajes de hoy.</p>';
      return;
    }
    show(btn, true);

    var clave = normalizarInterno(vehiculo) + "_" + hoyColombia();
    if (viajes.clave !== clave) {
      var cache = leerCache("viajes_" + clave);
      viajes.clave = clave;
      viajes.vehiculo = vehiculo;
      viajes.lista = cache && Array.isArray(cache.datos) ? cache.datos : null;
      viajes.guardadoEn = viajes.lista ? cache.guardadoEn : null;
      viajes.error = null;
    }

    if (viajes.lista) {
      pintarViajes();
    } else if (!navigator.onLine) {
      box.innerHTML = '<p class="placeholder">Necesitas conexión para ver los viajes de hoy.</p>';
    } else {
      esqueleto(box, "bloque");
    }

    if (!navigator.onLine || viajes.cargandoClave === clave) return;
    viajes.cargandoClave = clave;
    btn.disabled = true;

    consultarViajesHoy(vehiculo)
      .then(function (lista) {
        if (viajes.clave !== clave) return; // cambió el vehículo mientras tanto
        viajes.lista = lista;
        viajes.guardadoEn = Date.now();
        viajes.error = null;
        guardarCache("viajes_" + clave, lista);
        pintarViajes();
      })
      .catch(function (err) {
        if (viajes.clave !== clave) return;
        viajes.error = err;
        if (viajes.lista) pintarViajes();
        else pintarErrorTarjeta(box, "No se pudieron consultar los viajes.", err, cargarViajes);
      })
      .then(function () {
        if (viajes.cargandoClave === clave) viajes.cargandoClave = null;
        btn.disabled = false;
      });
  }

  // Un mismo despacho a veces queda registrado dos veces (doble clic, o dos
  // despachadores a la vez): misma ruta con uno o dos minutos de diferencia.
  // Un bus no repite la misma ruta en tan poco tiempo, así que dentro de
  // VIAJES_REPETIDOS_VENTANA_MS cuenta uno solo, el primero que se registró.
  // La lista entra y sale del más reciente al más antiguo.
  function unificarViajesRepetidos(lista) {
    var ventana = cfg.VIAJES_REPETIDOS_VENTANA_MS || 15 * 60 * 1000;
    var anteriorPorRuta = {};
    var quedan = [];
    lista.slice().sort(function (a, b) { return a.ms - b.ms; }).forEach(function (v) {
      var ruta = String(v.ruta || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      var anterior = anteriorPorRuta[ruta];
      anteriorPorRuta[ruta] = v.ms;
      if (anterior != null && v.ms - anterior < ventana) return;
      quedan.push(v);
    });
    return quedan.reverse();
  }

  function pintarViajes() {
    var box = $("viajesBody");
    var lista = unificarViajesRepetidos(viajes.lista || []);
    var n = lista.length;

    var html =
      '<div class="viajes-hero">' +
        '<div class="viajes-total"><strong>' + n + "</strong><span>" + (n === 1 ? "viaje" : "viajes") + "</span></div>" +
        '<div class="viajes-info">' +
          "<strong>Bus " + escapeHtml(viajes.vehiculo) + "</strong>" +
          "<span>" +
            (n
              ? "Último a las " + escapeHtml(horaDeMs(lista[0].ms)) + " · " + escapeHtml(haceCuanto(lista[0].ms))
              : "Todavía no tiene viajes hoy") +
          "</span>" +
        "</div>" +
      "</div>";

    if (viajes.guardadoEn && (viajes.error || !navigator.onLine)) {
      html += '<p class="viajes-aviso">' + (navigator.onLine ? "No se pudo actualizar" : "Sin conexión") +
        ": son los viajes guardados a las " + escapeHtml(horaDeMs(viajes.guardadoEn)) + ".</p>";
    }

    if (n) {
      html += '<ol class="viajes-lista">' +
        lista.map(function (v, i) {
          return '<li class="viaje">' +
            '<span class="viaje-num">' + (n - i) + "</span>" +
            '<span class="viaje-hora">' + escapeHtml(horaDeMs(v.ms)) + "</span>" +
            '<span class="viaje-ruta">' + escapeHtml(rutaLegible(v.ruta)) + "</span>" +
          "</li>";
        }).join("") +
        "</ol>";
    }

    if (viajes.guardadoEn) {
      html += '<p class="viajes-nota">Actualizado a las ' + escapeHtml(horaDeMs(viajes.guardadoEn)) + "</p>";
    }

    box.innerHTML = html;
  }

  function initViajes() {
    $("btnRefrescarViajes").addEventListener("click", function () { cargarViajes(); });

    // Con el inicio a la vista se vuelve a consultar cada 3 min; con la app
    // en segundo plano, nada.
    setInterval(function () {
      if (!state.user || state.vista !== "inicio" || document.hidden || $("appView").hidden) return;
      cargarViajes();
    }, cfg.DESPACHOS_REFRESCO_MS || 180000);
  }

  // ------------------------------------------------------------- mi tarjeta
  // La tarjeta de despacho del bus del turno, como la de papel: un renglón por
  // viaje (también los que salieron sin despacho) con su hora, su ruta y los
  // pasajeros que contó el sensor (tope 19). En cada despacho el conductor
  // escribe el número que marca el validador de la cívica, cuántos pasajeros
  // llevó (por su cuenta: control lo audita contra el sensor) y cuántos
  // tiquetes escaneó en Distribusion; las cívicas de un viaje salen solas: su
  // lectura menos la del despacho anterior (v1.18.0: la escribe ya hecho el
  // viaje; si el número se repite, son 0).
  //
  // Para que la auditoría sirva, el número del sensor de un viaje no se le
  // muestra al conductor hasta que guarda el suyo (si lo viera, lo copiaría).
  // La plata que ve es la de sus pasajeros (pasajeros x el pasaje del día), repartida en lo que pagaron con
  // tiquete, con la cívica y en efectivo: los tres van dentro de los pasajeros y valen lo mismo. El cupo del
  // bus es 19: más pasajeros, o más tiquetes y cívicas que pasajeros, no se deja guardar. La cuenta se ve
  // mientras escribe.
  //
  // Los viajes los publica el programa de enturnes en tarjeta_viajes, y la
  // vista v_tarjeta_viajes los junta con las lecturas, los pasajeros del
  // conductor, los tiquetes, los daños del validador y el pasaje. Lo guardado
  // no se borra: si quedó mal, desde la v1.21.0 el conductor lo corrige una vez,
  // el mismo día (sql v14 conductor_corrige_tarjeta.sql); después, el
  // despachador. Queda quién y por qué (almacentro/enturnes/sql/tarjeta_despacho.sql).
  var CAMPOS_TARJETA = "clave,dia,interno,viaje,sin_despacho,hora_salida,pasajeros,subidas,itinerario,ruta," +
    "civica_lectura,civicas,estado_civica,lectura_corregida,tiquetes_escaneados,tiquetes_corregidos,estado_calculo," +
    "pasajeros_conductor,pasajeros_conductor_corregidos,tarifa";
  // v10: el personal de la empresa que se registró en el viaje (suma en pasajeros, no se cobra).
  // Si la base todavía no las tiene, la tarjeta se pide sin ellas.
  var CAMPOS_PERSONAL = ",personal,personal_detalle";
  var tarjetaConPersonal = true;

  var tarj = {
    clave: null, vehiculo: null, dia: null, filas: null, danos: [], guardadoEn: null, error: null,
    cargandoClave: null,
    borrador: {},      // { clave: { civica, pasajeros, tiquetes } } lo que va escribiendo: sobrevive a un refresco
    confirmando: null, // { clave, civica, pasajeros, tiquetes, avisos }: el "¿Guardar?" a la vista
    guardando: null,   // clave del viaje que se está guardando
    mensaje: null,     // { clave, tipo: ok|error, texto } debajo de un renglón
    novedades: [],     // v11.1: las novedades que reportó en los viajes de hoy (con su número)
    novPendientes: [], // las que siguen en el celular, por enviar o subiendo el video
    // v1.21.0: { civica: [...], pasajeros: [...], tiquetes: [...] } los renglones de lo escrito (original y
    // correcciones) con id, clave_viaje, corrige_a, origen y mio (si es de su cédula; la cédula no se guarda).
    registros: null,
    corr: null,          // la corrección abierta: { clave, campos, valores, motivo, otra, avisos, confirmando, guardando }
    conCorreccion: null, // la base ya deja corregir al conductor (sql v14); null: no se sabe todavía
    // v1.22.0: { clave: { mio, turno, nombre, entrada, segun } } de quién es cada viaje (sql v15); null: sin la función
    duenos: null,
    otroAbierto: false,  // la lista de los viajes del otro conductor quedó abierta
  };

  // Corregir lo guardado (v1.21.0, pedido del usuario: "poner corrección en la app del conductor en la tarjeta").
  // El conductor corrige un número que ya guardó: el mismo día, una sola vez y si nadie lo ha corregido. Lo decide la
  // base (sql v14 conductor_corrige_tarjeta.sql); aquí solo se esconde el botón cuando no se puede. La corrección es
  // otro renglón con corrige_a y el motivo: no se borra nada, y en Control sale "desde el celular".
  // Ej. el conductor del 722 guardó 15 pasajeros y eran 16: "Corregir", escribe 16 y por qué.
  var CORREGIBLES = ["civica", "pasajeros", "tiquetes"];
  var CORREGIR = {
    civica: { tabla: cfg.TABLA_CIVICA_LECTURAS, columna: "civica_lectura", valor: "lectura",
              corregido: "lectura_corregida", etiqueta: "Cívica", largo: 9 },
    pasajeros: { tabla: cfg.TABLA_TARJETA_PASAJEROS, columna: "pasajeros_conductor", valor: "cantidad",
                 corregido: "pasajeros_conductor_corregidos", etiqueta: "Pasajeros", largo: 2 },
    tiquetes: { tabla: cfg.TABLA_TARJETA_TIQUETES, columna: "tiquetes_escaneados", valor: "cantidad",
                corregido: "tiquetes_corregidos", etiqueta: "Tiquetes", largo: 3 },
  };
  var MOTIVOS_CORRECCION = ["Lo escribí mal", "Conté mal"];

  // Lo que dice cada estado de la cívica (estado_civica de la vista), en las
  // palabras del conductor.
  var ESTADO_CIVICA = {
    ok: { nivel: "ok", texto: "Cuadra" },
    sin_lectura_anterior: { nivel: "espera", texto: "Sin lectura anterior del bus" },
    falta_lectura_anterior: { nivel: "espera", texto: "Falta la cívica del viaje anterior" },
    // los de antes de la v12 (cívicas = lectura siguiente - la suya), por si la base todavía no cambió
    pendiente_cierre: { nivel: "espera", texto: "Se completa en el próximo despacho" },
    falta_lectura_siguiente: { nivel: "espera", texto: "Falta la cívica del viaje siguiente" },
    dano_por_revisar: { nivel: "revisa", texto: "Daño del validador en revisión" },
    bajo: { nivel: "mal", texto: "El número bajó: lo revisa el despachador" },
    salto: { nivel: "revisa", texto: "Subió mucho: lo revisa el despachador" },
  };

  var ICONO_ALERTA = '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M12 9v4m0 4h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>';

  // El día de la tarjeta es el de la empresa: de 2:30 a. m. a 2:30 a. m. del día
  // siguiente. El viaje de la 1 de la mañana todavía es del día anterior, y el de
  // las 2:43 ya es el primero del día nuevo.
  function diaDeTarjeta() { return fechaColombiaDe(Date.now() - 2.5 * HORA_MS); }

  function nombreConductor() {
    return (state.conductor && state.conductor.nombre) ||
      (state.turno && state.turno.nombre_programacion) || null;
  }

  function nombreViaje(f) { return f.sin_despacho ? "viaje sin despacho" : "viaje " + (f.viaje || "—"); }

  function horaViaje(f) { return horaDeMs(Date.parse(f.hora_salida)); }

  // ¿La base ya deja corregir al conductor (sql v14)? Se pregunta una vez: si la función no está, no sale "Corregir".
  function baseDejaCorregir() {
    if (tarj.conCorreccion !== null) return Promise.resolve(tarj.conCorreccion);
    return conTiempoLimite(client.rpc("tarjeta_conductor_puede_corregir", { p_tabla: "", p_corrige_a: 0, p_cedula: "" }))
      .then(function (r) { tarj.conCorreccion = !r.error; return tarj.conCorreccion; })
      .catch(function () { return false; });           // sin red: se pregunta otra vez en la próxima carga
  }

  // Lo escrito en estos viajes, de las tres hojas. La cédula solo sirve para saber si es suya.
  function registrosDeTarjeta(res) {
    if (res.some(function (r) { return !r || r.error; })) return null;
    var yo = String(state.dni || "").replace(/\D/g, "");
    var regs = {};
    CORREGIBLES.forEach(function (campo, j) {
      regs[campo] = (res[j].data || []).map(function (x) {
        return { id: x.id, clave_viaje: x.clave_viaje, corrige_a: x.corrige_a, origen: x.origen,
                 mio: !!yo && String(x.cedula || "").replace(/\D/g, "") === yo };
      });
    });
    return regs;
  }

  // De quién es cada viaje (sql v15 tarjeta_viajes_conductor): el último conductor del bus que marcó entrada en el
  // biométrico antes de que el bus saliera; si nadie había marcado, el del turno programado. En el celular no se
  // guarda la cédula: solo si el viaje es suyo.
  function duenosDeTarjeta(r) {
    if (!r || r.error || !Array.isArray(r.data)) return null;
    var yo = String(state.dni || "").replace(/\D/g, "");
    var d = {};
    r.data.forEach(function (x) {
      if (!x.dni) return;
      d[x.clave] = { mio: !!yo && String(x.dni).replace(/\D/g, "") === yo, turno: x.turno, nombre: x.nombre || null,
                     entrada: x.entrada || null, segun: x.segun };
    });
    return d;
  }

  async function consultarTarjeta(vehiculo, dia) {
    var internos = variantesInterno(vehiculo);
    var escritos = Promise.all(CORREGIBLES.map(function (campo) {
      return conTiempoLimite(
        client.from(CORREGIR[campo].tabla).select("id,clave_viaje,corrige_a,origen,cedula").in("interno", internos).eq("dia", dia)
      ).catch(function () { return { error: true }; });
    }));
    var res = await Promise.all([
      conTiempoLimite(
        client.from(cfg.VISTA_TARJETA_VIAJES)
          .select(CAMPOS_TARJETA + (tarjetaConPersonal ? CAMPOS_PERSONAL : ""))
          .in("interno", internos)
          .eq("dia", dia)
          .order("hora_salida", { ascending: false })
      ),
      conTiempoLimite(
        client.from(cfg.TABLA_CIVICA_DANOS)
          .select("id,clave_viaje,estado,lectura_final_viejo,lectura_inicial_nuevo,reportado_en,nota_revision")
          .in("interno", internos)
          .eq("dia", dia)
          .order("reportado_en", { ascending: true })
      ),
      // Las novedades que reportó en cada viaje (sql v11.1). Son un extra: sin ellas la tarjeta sirve igual.
      conTiempoLimite(
        client.from(cfg.TABLA_NOVEDADES)
          .select("numero,id_local,tipo,interno_origen,cantidad,nota,ocurrio_en,video_ruta,anulado_en,anulado_motivo,clave_viaje,viaje")
          .in("interno", internos)
          .eq("dia", dia)
          .order("numero", { ascending: true })
      ).catch(function () { return { data: [] }; }),
      // v1.21.0: quién escribió cada número (para "Corregir"). También son un extra.
      escritos,
      baseDejaCorregir(),
      // v1.22.0: de quién es cada viaje (sql v15). Sin la función, la tarjeta sale entera, como antes.
      conTiempoLimite(client.rpc("tarjeta_viajes_conductor", { p_dia: dia, p_interno: String(vehiculo).trim() }))
        .catch(function () { return { error: true }; }),
    ]);
    if (res[0].error && tarjetaConPersonal && /personal/.test(res[0].error.message || "")) {
      tarjetaConPersonal = false;            // la base todavía no tiene la v10
      return consultarTarjeta(vehiculo, dia);
    }
    if (res[0].error) throw res[0].error;
    // Los daños son un extra: si esa consulta falla, la tarjeta sirve igual.
    return { filas: res[0].data || [], danos: res[1].error ? [] : (res[1].data || []),
      novedades: res[2] && !res[2].error ? (res[2].data || []) : [], registros: registrosDeTarjeta(res[3]),
      duenos: duenosDeTarjeta(res[5]) };
  }

  function cargarTarjeta() {
    var box = $("tarjetaBody");
    var btn = $("btnRefrescarTarjeta");
    var vehiculo = state.vehiculo ? String(state.vehiculo).trim() : "";
    var dia = diaDeTarjeta();

    if (!vehiculo) {
      tarj.clave = null;
      show(btn, false);
      $("tarjetaTitulo").textContent = "Mi tarjeta de hoy";
      box.innerHTML = '<p class="placeholder">Cuando tengas vehículo asignado verás aquí su tarjeta: ' +
        "los viajes, los pasajeros y la cívica de cada despacho.</p>";
      pintarResumenTarjeta();
      return;
    }
    show(btn, true);
    $("tarjetaTitulo").textContent = "Mi tarjeta · bus " + vehiculo;

    var clave = normalizarInterno(vehiculo) + "_" + dia;
    if (tarj.clave !== clave) {
      var cache = leerCache("tarjeta_" + clave);
      tarj.clave = clave;
      tarj.vehiculo = vehiculo;
      tarj.dia = dia;
      tarj.filas = cache && cache.datos ? cache.datos.filas : null;
      tarj.danos = cache && cache.datos ? cache.datos.danos || [] : [];
      tarj.novedades = cache && cache.datos ? cache.datos.novedades || [] : [];
      tarj.registros = cache && cache.datos ? cache.datos.registros || null : null;
      tarj.duenos = cache && cache.datos ? cache.datos.duenos || null : null;
      tarj.otroAbierto = false;
      tarj.guardadoEn = tarj.filas ? cache.guardadoEn : null;
      tarj.error = null;
      tarj.borrador = {};
      tarj.confirmando = null;
      tarj.corr = null;
      tarj.mensaje = null;
    }

    pintarNovedadesMias();             // las que siguen en el celular (se pintan cuando las lee)
    if (tarj.filas) {
      pintarTarjeta();
    } else if (!navigator.onLine) {
      box.innerHTML = '<p class="placeholder">Necesitas conexión para ver tu tarjeta.</p>';
      pintarResumenTarjeta();
    } else {
      esqueleto(box, "bloque");
      pintarResumenTarjeta();
    }

    if (!navigator.onLine || tarj.cargandoClave === clave) return;
    tarj.cargandoClave = clave;
    btn.disabled = true;

    consultarTarjeta(vehiculo, dia)
      .then(function (datos) {
        if (tarj.clave !== clave) return; // cambió el bus o el día mientras tanto
        tarj.filas = datos.filas;
        tarj.danos = datos.danos;
        tarj.novedades = datos.novedades;
        tarj.registros = datos.registros;
        tarj.duenos = datos.duenos;
        tarj.guardadoEn = Date.now();
        tarj.error = null;
        guardarCache("tarjeta_" + clave, datos);
        pintarTarjeta();
      })
      .catch(function (err) {
        if (tarj.clave !== clave) return;
        tarj.error = err;
        if (tarj.filas) pintarTarjeta();
        else {
          pintarErrorTarjeta(box, "No se pudo consultar tu tarjeta.", err, cargarTarjeta);
          pintarResumenTarjeta();
        }
      })
      .then(function () {
        if (tarj.cargandoClave === clave) tarj.cargandoClave = null;
        btn.disabled = false;
      });
  }

  // La lectura anterior a un viaje en el mismo bus (la lista va del más
  // reciente al más viejo) y cuánta gente subió desde ese despacho: con eso se
  // avisa de un número que parece mal escrito, antes de guardarlo.
  function lecturaAnterior(filas, i) {
    var subidas = 0;
    for (var j = i + 1; j < filas.length; j++) {
      subidas += Number(filas[j].subidas != null ? filas[j].subidas : filas[j].pasajeros || 0);
      if (filas[j].civica_lectura != null) {
        return { fila: filas[j], lectura: Number(filas[j].civica_lectura), subidas: subidas };
      }
    }
    return null;
  }

  // Los mismos límites con que la vista marca "bajo" y "salto". El aviso no
  // dice cuánta gente contó el sensor: eso no lo ve el conductor antes de
  // escribir sus pasajeros.
  function avisosDeLectura(filas, i, valor) {
    var ant = lecturaAnterior(filas, i);
    if (!ant) return [];
    var dif = valor - ant.lectura;
    if (dif < 0) {
      return [{
        tipo: "bajo", clave: filas[i].clave,
        texto: "La cívica es menor que la del " + nombreViaje(ant.fila) + " (" + ant.lectura + "). " +
          "Si cambiaron el validador, repórtalo como daño.",
      }];
    }
    if (dif > Math.max(ant.subidas, 19) + 5) {
      return [{
        tipo: "salto",
        texto: "La cívica tiene " + dif + " más que la del " + nombreViaje(ant.fila) + " (" + ant.lectura + "): " +
          "son más de las personas que caben en esos viajes. Revisa el número.",
      }];
    }
    return [];
  }

  // El cupo del bus: 19 (el tope de la tarjeta de papel). Los 19 se reparten
  // entre los que pagan con tiquete, con la cívica o en efectivo, y el personal
  // de la empresa (no paga). Si no cuadra es un número mal escrito, y no se deja
  // guardar. No se compara con el sensor: lo del conductor es su cuenta, y
  // control es el que compara.
  var CUPO = 19;

  // Las cívicas de un viaje: su lectura menos la del despacho anterior del bus
  // (la vista las trae en civicas, ya con el daño del validador). El conductor
  // escribe la lectura ya hecho el viaje, así que si el número se repite no hubo
  // cívicas; solo cuentan cuando sube. Ej. (bus 710, 20-oct): viaje 1 en 2773,
  // viaje 2 en 2773 y viaje 3 en 2774: el 2 tuvo 0 y el 3 tuvo 1. null sin
  // lectura, sin la del anterior, o si bajó (eso lo revisa el despachador).
  function civicasDe(f) {
    return f.civicas == null || Number(f.civicas) < 0 ? null : Number(f.civicas);
  }

  function enCivicas(n) { return n === 1 ? "1 cívica" : n + " cívicas"; }

  function enViajes(n) { return n === 1 ? "1 viaje" : n + " viajes"; }

  // 380000 -> "$380.000"
  function pesos(n) { return "$" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "."); }

  // Lo que dice el conductor en el día: sus pasajeros y la plata (pasajeros x
  // el pasaje). Los viajes en que no ha escrito no cuentan. El personal de la
  // empresa va en sus pasajeros pero no se cobra.
  function pasajerosQueSeCobran(f) {
    var n = Number(f.pasajeros_conductor);
    return n - Math.min(Number(f.personal) || 0, n);
  }

  // Cómo se reparten los pasajeros de un viaje y su plata. Los que se cobran (sin
  // el personal de la empresa) pagan con tiquete, con la cívica o en efectivo, y
  // los tres valen el pasaje. Ej.: 19 pasajeros, 4 tiquetes y 1 cívica a $20.000
  // = $380.000: $80.000 en tiquetes, $20.000 en cívica y $280.000 en efectivo
  // (14). Mientras no se saben las cívicas (falta la lectura de este viaje o la
  // del anterior), lo que no es tiquete va junto: "cívica o efectivo". Las partes
  // nunca pasan de los que se cobran, para que sumen el total; sobran dice
  // cuántos tiquetes y cívicas hay de más (no cuadra). null sin pasajeros.
  function repartir(pasajeros, personal, tiquetes, civicas, tarifa) {
    if (pasajeros == null) return null;
    var pas = Number(pasajeros);
    var per = Math.min(Number(personal) || 0, pas);
    var r = {
      pasajeros: pas, personal: per, cobran: pas - per, tarifa: tarifa == null ? null : Number(tarifa),
      tiquetes: null, civicas: null, efectivo: null, sinTiquete: null, sobran: 0,
      tiquetesEscritos: null, civicasLeidas: civicas == null ? null : Number(civicas),
    };
    r.total = r.tarifa == null ? null : r.cobran * r.tarifa;
    if (tiquetes == null) return r;
    r.tiquetesEscritos = Number(tiquetes);
    r.tiquetes = Math.min(r.tiquetesEscritos, r.cobran);
    r.sobran = Math.max(0, r.tiquetesEscritos + (r.civicasLeidas || 0) - r.cobran);
    if (r.civicasLeidas == null) {
      r.sinTiquete = r.cobran - r.tiquetes;
    } else {
      r.civicas = Math.min(r.civicasLeidas, r.cobran - r.tiquetes);
      r.efectivo = r.cobran - r.tiquetes - r.civicas;
    }
    return r;
  }

  // La plata de n pasajeros de ese viaje (null si no hay pasaje).
  function plataDe(r, n) { return r.tarifa == null || n == null ? null : n * r.tarifa; }

  function plataDelViaje(f) {
    return repartir(f.pasajeros_conductor, f.personal, f.tiquetes_escaneados, civicasDe(f), f.tarifa);
  }

  function totalesDelConductor(filas) {
    return filas.reduce(function (t, f) {
      var r = plataDelViaje(f);
      if (!r) return t;
      t.pasajeros += r.pasajeros;
      if (r.tarifa == null) return t;
      t.plata += r.total;
      t.conPlata = true;
      if (r.tiquetes == null) { t.sinRepartir += r.total; return t; }
      t.conReparto = true;
      t.enTiquetes += plataDe(r, r.tiquetes);
      if (r.civicas == null) {
        t.porSeparar += plataDe(r, r.sinTiquete);
      } else {
        t.enCivica += plataDe(r, r.civicas);
        t.enEfectivo += plataDe(r, r.efectivo);
      }
      return t;
    }, { pasajeros: 0, plata: 0, conPlata: false, conReparto: false,
         enTiquetes: 0, enCivica: 0, enEfectivo: 0, porSeparar: 0, sinRepartir: 0 });
  }

  // El reparto del día, arriba de la tarjeta: "Tiquetes $340.000 · cívica
  // $20.000 · efectivo $260.000", y debajo lo que todavía no se sabe.
  function repartoDelDia(t) {
    if (!t.conReparto) return "";
    var nota = [];
    if (t.porSeparar) nota.push(pesos(t.porSeparar) + " entre cívica y efectivo: faltan lecturas de la cívica");
    if (t.sinRepartir) nota.push(pesos(t.sinRepartir) + " sin repartir: faltan los tiquetes");
    return '<span class="viajes-reparto">Tiquetes ' + pesos(t.enTiquetes) + " · cívica " + pesos(t.enCivica) +
      " · efectivo " + pesos(t.enEfectivo) + "</span>" +
      (nota.length ? '<span class="viajes-reparto-nota">' + escapeHtml(nota.join(" · ")) + "</span>" : "");
  }

  // "4 tiquetes y 18 cívicas son más que los 19 pasajeros"
  function textoSobran(r) {
    var partes = [r.tiquetesEscritos + (r.tiquetesEscritos === 1 ? " tiquete" : " tiquetes")];
    if (r.civicasLeidas != null) partes.push(enCivicas(r.civicasLeidas));
    if (r.personal) partes.push(r.personal + " del personal");
    return listaY(partes) + " son más que los " + r.pasajeros + " pasajeros";
  }

  // "19 pasajeros = 4 con tiquete ($80.000) + 1 con cívica ($20.000) + 14 en
  // efectivo ($280.000)."
  function textoCuenta(r) {
    function con(n, que) { return n + " " + que + (r.tarifa != null ? " (" + pesos(n * r.tarifa) + ")" : ""); }
    if (r.tiquetes == null) {
      return r.pasajeros + " pasajeros" + (r.total != null ? " = " + pesos(r.total) : "") +
        ". Con los tiquetes se reparten en tiquete, cívica y efectivo.";
    }
    var partes = [con(r.tiquetes, "con tiquete")];
    if (r.civicas == null) {
      partes.push(con(r.sinTiquete, "en cívica o efectivo"));
    } else {
      partes.push(con(r.civicas, "con cívica"));
      partes.push(con(r.efectivo, "en efectivo"));
    }
    if (r.personal) partes.push(r.personal + " del personal (no se cobra)");
    return r.pasajeros + " pasajeros = " + partes.join(" + ") +
      (r.civicas == null ? ". Cívica y efectivo se separan con la lectura del validador de este viaje y la del anterior." : ".");
  }

  // "a", "a y b", "a, b y c"
  function listaY(partes) {
    return partes.length < 2 ? partes.join("") : partes.slice(0, -1).join(", ") + " y " + partes[partes.length - 1];
  }

  function faltaAlgo(f) {
    return f.civica_lectura == null || f.pasajeros_conductor == null || f.tiquetes_escaneados == null;
  }

  // v1.22.0 (pedido del usuario: "separar por conductor la liquidación del carro"): arriba los viajes del conductor
  // y su liquidación; los del otro conductor del bus, aparte. Ej. bus 722: el del turno 2 entró a las 12:40 y ve sus
  // 5 viajes desde esa hora; los 6 del turno 1 quedan en "Viajes del otro conductor". Sin la función de la base, o si
  // él no es de este bus hoy (no está programado en él ni tiene viajes), la tarjeta es la del bus entera, como antes.
  function partirTarjeta(filas) {
    var d = tarj.duenos;
    var esDelBus = !!(state.turno && tarj.vehiculo &&
      normalizarInterno(state.turno.vehiculo) === normalizarInterno(tarj.vehiculo));
    if (!d || !(esDelBus || filas.some(function (f) { return d[f.clave] && d[f.clave].mio; }))) {
      return { mias: filas, otras: [], partida: false };
    }
    return {
      // Un viaje sin dueño (no había nadie programado a esa hora) se queda con él, para que lo pueda llenar.
      mias: filas.filter(function (f) { return !d[f.clave] || d[f.clave].mio; }),
      otras: filas.filter(function (f) { return d[f.clave] && !d[f.clave].mio; }),
      partida: true,
    };
  }

  // "turno 2 · entraste a las 12:40"
  function textoDeMiTurno(mias) {
    var d = tarj.duenos || {};
    var mio = mias.map(function (f) { return d[f.clave]; }).find(function (x) { return x && x.mio; });
    var turno = mio ? mio.turno : state.turno ? state.turno.turno : null;
    var entrada = mio && mio.entrada ? horaCorta(String(mio.entrada).slice(11, 16)) : null;
    return (turno != null ? "turno " + turno : "tu turno") + (entrada ? " · entraste a las " + entrada : "");
  }

  // "Viajes del otro conductor · turno 1 · [su nombre programado]" (uno o dos, si el bus tuvo más)
  function textoDelOtro(otras) {
    var d = tarj.duenos || {};
    var vistos = {};
    var quienes = [];
    otras.forEach(function (f) {
      var x = d[f.clave];
      var k = x ? x.turno + "|" + x.nombre : "?";
      if (vistos[k] || !x) return;
      vistos[k] = true;
      quienes.push("turno " + x.turno + (x.nombre ? " · " + x.nombre : ""));
    });
    return (quienes.length > 1 ? "Viajes de los otros conductores" : "Viajes del otro conductor") +
      (quienes.length ? " · " + quienes.join(" y ") : "");
  }

  // Lo que le falta a la tarjeta, en palabras: "la cívica en 2 viajes, los
  // pasajeros en 2 viajes y los tiquetes en 1 viaje".
  function faltanEnTarjeta(filas) {
    function cuantos(campo) { return filas.filter(function (f) { return f[campo] == null; }).length; }
    var civica = cuantos("civica_lectura");
    var pasajeros = cuantos("pasajeros_conductor");
    var tiquetes = cuantos("tiquetes_escaneados");
    var partes = [];
    if (civica) partes.push("la cívica en " + enViajes(civica));
    if (pasajeros) partes.push("los pasajeros en " + enViajes(pasajeros));
    if (tiquetes) partes.push("los tiquetes en " + enViajes(tiquetes));
    return listaY(partes);
  }

  // El aviso corto del inicio: qué falta y el botón para abrir la tarjeta, que
  // está en el menú. Es lo primero que ve el conductor al abrir la aplicación
  // después de un despacho.
  function pintarResumenTarjeta() {
    var box = $("tarjetaResumenBody");
    if (!box) return;
    if (!tarj.clave) {
      box.innerHTML = '<p class="placeholder">Cuando tengas vehículo asignado verás aquí lo que falta en tu tarjeta.</p>';
      return;
    }
    var filas = tarj.filas;
    if (!filas) {
      box.innerHTML = tarj.error
        ? '<p class="placeholder">No se pudo consultar tu tarjeta.</p>' + botonAbrirTarjeta(false)
        : '<div class="skeleton skeleton-linea"></div>';
      return;
    }
    var partes = partirTarjeta(filas);
    var mias = partes.mias;
    var faltan = faltanEnTarjeta(mias);
    var suyo = totalesDelConductor(mias);
    var texto, nivel;
    if (!mias.length) {
      nivel = "falta";
      texto = partes.partida
        ? "Todavía no tienes viajes hoy en el bus " + tarj.vehiculo + "."
        : "Todavía no hay viajes hoy en el bus " + tarj.vehiculo + ".";
    } else if (faltan) {
      nivel = "pronto";
      texto = "Falta " + faltan + ".";
    } else {
      nivel = "ok";
      texto = "Tarjeta al día: " + enViajes(mias.length) + ", " + suyo.pasajeros + " pasajeros" +
        (suyo.conPlata ? ", " + pesos(suyo.plata) +
          (suyo.conReparto ? " (tiquetes " + pesos(suyo.enTiquetes) + ", cívica " + pesos(suyo.enCivica) + ", efectivo " +
            pesos(suyo.enEfectivo) + (suyo.porSeparar ? "; " + pesos(suyo.porSeparar) + " entre cívica y efectivo, sin separar" : "") +
            ")" : "")
          : "") + ".";
    }
    box.innerHTML = '<p class="docs-resumen" data-nivel="' + nivel + '">' + escapeHtml(texto) + "</p>" +
      botonAbrirTarjeta(!!faltan);
  }

  function botonAbrirTarjeta(urgente) {
    return '<button class="btn ' + (urgente ? "btn-primary" : "btn-ghost") + ' btn-block" type="button" data-abrir-tarjeta>' +
      (urgente ? "Completar mi tarjeta" : "Abrir mi tarjeta") + "</button>";
  }

  function pintarTarjeta() {
    var box = $("tarjetaBody");
    var filas = tarj.filas || [];

    // Si estaba escribiendo un número (o una corrección), el campo vuelve a quedar listo.
    var activo = document.activeElement;
    var enfocado = activo && box.contains(activo) &&
      (activo.getAttribute("data-lectura") || activo.getAttribute("data-corr") || activo.hasAttribute("data-corr-otra"))
      ? { lectura: activo.getAttribute("data-lectura"), corr: activo.getAttribute("data-corr"),
          otra: activo.hasAttribute("data-corr-otra"), campo: activo.getAttribute("data-campo") }
      : null;

    // v1.22.0: arriba lo suyo y su liquidación; lo del otro conductor del bus, aparte (partirTarjeta). Cada viaje se
    // pinta con su posición en la lista entera del bus: con ella se busca la cívica del viaje anterior.
    var partes = partirTarjeta(filas);
    var mias = partes.mias;
    var n = mias.length;
    // Los totales son los del conductor: el del sensor dejaría sacar, por resta,
    // el número de un viaje que todavía no ha escrito.
    var suyo = totalesDelConductor(mias);
    var tiquetes = mias.reduce(function (s, f) { return s + Number(f.tiquetes_escaneados || 0); }, 0);
    var primera = mias.find(faltaAlgo);
    var primeraFalta = primera ? filas.indexOf(primera) : -1;
    var faltan = faltanEnTarjeta(mias);

    var html =
      (partes.partida
        ? '<p class="tarj-dueno">Tus viajes · ' + escapeHtml(textoDeMiTurno(mias)) + "</p>"
        : "") +
      '<div class="viajes-hero">' +
        '<div class="viajes-total"><strong>' + n + "</strong><span>" + (n === 1 ? "viaje" : "viajes") + "</span></div>" +
        '<div class="viajes-info">' +
          "<strong>" + suyo.pasajeros + (suyo.pasajeros === 1 ? " pasajero" : " pasajeros") +
            (suyo.conPlata ? " · " + pesos(suyo.plata) : "") +
            (n ? " · " + tiquetes + (tiquetes === 1 ? " tiquete" : " tiquetes") : "") + "</strong>" +
          repartoDelDia(suyo) +
          "<span>" +
            (!n ? (partes.partida ? "Todavía no tienes viajes hoy" : "Todavía no hay viajes hoy")
              : faltan ? "Falta " + faltan : "Tarjeta completa") +
          "</span>" +
        "</div>" +
      "</div>" +
      // La liquidación: lo que entrega en efectivo de sus viajes (lo de tiquete y cívica no pasa por su mano).
      (partes.partida && suyo.conReparto
        ? '<p class="tarj-entrega">Efectivo que entregas <strong>' + pesos(suyo.enEfectivo) + "</strong>" +
          (suyo.porSeparar || suyo.sinRepartir ? '<span>Puede cambiar: falta separar ' +
            pesos(suyo.porSeparar + suyo.sinRepartir) + "</span>" : "") + "</p>"
        : "");

    if (tarj.guardadoEn && (tarj.error || !navigator.onLine)) {
      html += '<p class="viajes-aviso">' + (navigator.onLine ? "No se pudo actualizar" : "Sin conexión") +
        ": es la tarjeta guardada a las " + escapeHtml(horaDeMs(tarj.guardadoEn)) + ".</p>";
    }

    if (n) {
      html += '<ol class="tarj-lista">' +
        mias.map(function (f) { var i = filas.indexOf(f); return renglonTarjeta(f, i, i === primeraFalta); }).join("") +
        "</ol>";
    } else {
      html += '<p class="viajes-nota">Cada viaje aparece aquí un par de minutos después del despacho.</p>';
    }

    if (partes.otras.length) {
      var delOtro = totalesDelConductor(partes.otras);
      html += '<details class="tarj-otro"' + (tarj.otroAbierto ? " open" : "") + ">" +
        "<summary><span>" + escapeHtml(textoDelOtro(partes.otras)) + "</span>" +
          "<small>" + enViajes(partes.otras.length) + " · " + delOtro.pasajeros + " pasajeros" +
            (delOtro.conPlata ? " · " + pesos(delOtro.plata) : "") + " · no van en tu liquidación</small>" +
        "</summary>" +
        '<ol class="tarj-lista">' +
          partes.otras.map(function (f) { return renglonTarjeta(f, filas.indexOf(f), false); }).join("") +
        "</ol>" +
      "</details>";
    }

    var sueltas = novedadesSinViaje(filas);
    if (sueltas.length) {
      html += '<h4 class="personal-titulo">Novedades sin viaje</h4><ul class="nov-lista">' + sueltas.map(filaNovedad).join("") + "</ul>";
    }

    if (tarj.danos.length) {
      html += '<ul class="tarj-danos">' + tarj.danos.map(function (d) {
        var f = filas.find(function (x) { return x.clave === d.clave_viaje; });
        var est = d.estado === "aprobado" ? { nivel: "ok", texto: "Aprobado" }
          : d.estado === "rechazado" ? { nivel: "vencido", texto: "Rechazado" }
          : { nivel: "pronto", texto: "En revisión" };
        var detalle = (d.lectura_final_viejo != null ? "Quedó en " + d.lectura_final_viejo + " · " : "") +
          "el nuevo arrancó en " + d.lectura_inicial_nuevo +
          (d.estado === "rechazado" && d.nota_revision ? " · " + d.nota_revision : "");
        return '<li class="doc">' +
          '<div class="doc-info">' +
            '<span class="doc-nombre">Daño del validador · ' + escapeHtml(f ? nombreViaje(f) : "viaje") + "</span>" +
            '<span class="doc-detalle">' + escapeHtml(detalle) + "</span>" +
          "</div>" +
          '<span class="doc-estado" data-nivel="' + est.nivel + '">' + est.texto + "</span>" +
        "</li>";
      }).join("") + "</ul>";
    }

    if (n) {
      html += '<button class="btn btn-ghost btn-block btn-dano" type="button" data-dano="">' +
        ICONO_ALERTA + "Reportar daño del validador</button>";
    }

    if (tarj.guardadoEn) {
      html += '<p class="viajes-nota">Actualizada a las ' + escapeHtml(horaDeMs(tarj.guardadoEn)) + "</p>";
    }

    box.innerHTML = html;
    actualizarCuentas();
    pintarResumenTarjeta();

    if (enfocado) {
      Array.prototype.some.call(box.querySelectorAll("[data-lectura], [data-corr], [data-corr-otra]"), function (campo) {
        if (campo.getAttribute("data-lectura") !== enfocado.lectura || campo.getAttribute("data-corr") !== enfocado.corr ||
            campo.hasAttribute("data-corr-otra") !== enfocado.otra ||
            campo.getAttribute("data-campo") !== enfocado.campo) return false;
        campo.focus();
        try { campo.setSelectionRange(campo.value.length, campo.value.length); } catch (_) {}
        return true;
      });
    }
  }

  function campoTarjeta(f, i, campo, etiqueta, ejemplo, largo) {
    var id = "tarj" + campo + i;
    return '<label class="tv-campo tv-campo-' + campo + '" for="' + id + '"><span>' + etiqueta + "</span>" +
      '<input id="' + id + '" data-lectura="' + escapeHtml(f.clave) + '" data-campo="' + campo + '" type="text" ' +
        'inputmode="numeric" pattern="[0-9]*" maxlength="' + largo + '" autocomplete="off" placeholder="' + ejemplo + '" ' +
        'value="' + escapeHtml((tarj.borrador[f.clave] || {})[campo] || "") + '">' +
    "</label>";
  }

  function renglonTarjeta(f, i, esLaQueSigue) {
    var faltaCivica = f.civica_lectura == null;
    var faltaPasajeros = f.pasajeros_conductor == null;
    var faltaTiquetes = f.tiquetes_escaneados == null;
    var falta = faltaCivica || faltaPasajeros || faltaTiquetes;
    var ruta = f.itinerario ? rutaLegible(f.itinerario) : f.ruta ? "Ruta " + f.ruta : "Sin itinerario";

    // El viaje sin despacho no tiene número ni ruta: el letrero va en su lugar.
    var html =
      '<div class="tv-fila">' +
        '<span class="viaje-num">' + (f.sin_despacho ? "–" : escapeHtml(f.viaje)) + "</span>" +
        '<span class="viaje-hora">' + escapeHtml(horaViaje(f)) + "</span>" +
        '<span class="tv-ruta">' +
          (f.sin_despacho ? '<span class="tv-sd">SIN DESPACHO</span>' : escapeHtml(ruta)) +
        "</span>" +
        // Lo del sensor, solo cuando ya guardó sus pasajeros (si no, lo copiaría).
        // Mientras va en camino el número puede subir: el sensor a veces cuenta tarde
        // (el 709 el 14-oct: 5 en el aeropuerto con el sensor tapado y 18 más en Bello).
        (faltaPasajeros ? "" :
          '<span class="tv-pas"><strong>' + escapeHtml(f.pasajeros) + "</strong>sensor" +
            (f.estado_calculo === "en_curso" ? "<br>hasta ahora" : "") + "</span>") +
      "</div>";

    // Lo que ya está guardado
    if (!faltaCivica) {
      var est = ESTADO_CIVICA[f.estado_civica];
      html += '<div class="tv-civica">' +
        "<span>Cívica <b>" + escapeHtml(f.civica_lectura) + "</b></span>" +
        (f.civicas != null
          ? "<span>" + escapeHtml(f.civicas) + (Number(f.civicas) === 1 ? " cívica" : " cívicas") + "</span>"
          : "") +
        (est ? '<span class="tv-chip" data-nivel="' + est.nivel + '">' + escapeHtml(est.texto) + "</span>" : "") +
        chipCorregido(f, "civica", "Corregida") +
      "</div>";
    }
    var r = plataDelViaje(f);
    if (!faltaPasajeros) {
      html += '<div class="tv-civica">' +
        "<span>Pasajeros que llevaste <b>" + escapeHtml(f.pasajeros_conductor) + "</b></span>" +
        (r && r.total != null ? '<span class="tv-plata">' + pesos(r.total) + "</span>" : "") +
        chipCorregido(f, "pasajeros", "Corregidos") +
      "</div>";
    }
    // v10: el personal de la empresa que se registró en este viaje
    if (Number(f.personal) > 0) {
      html += '<div class="tv-civica tv-personal">' +
        "<span>Personal de la empresa <b>" + escapeHtml(f.personal) + "</b></span>" +
        '<span class="tv-chip" data-nivel="ok">Va en tus pasajeros, no se cobra</span>' +
        (f.personal_detalle ? '<span class="tv-personal-quien">' + escapeHtml(f.personal_detalle) + "</span>" : "") +
      "</div>";
    }
    if (!faltaTiquetes) {
      // Lo que vale en tiquetes; si todavía no escribió los pasajeros, tiquetes x el pasaje.
      var enTiquetes = r && r.tiquetes != null ? plataDe(r, r.tiquetes)
        : f.tarifa != null ? Number(f.tiquetes_escaneados) * Number(f.tarifa) : null;
      html += '<div class="tv-civica">' +
        "<span>Tiquetes escaneados <b>" + escapeHtml(f.tiquetes_escaneados) + "</b></span>" +
        (enTiquetes != null ? '<span class="tv-plata">' + pesos(enTiquetes) + "</span>" : "") +
        chipCorregido(f, "tiquetes", "Corregidos") +
      "</div>";
    }
    // El resto de los que se cobran: con la cívica y en efectivo (juntos mientras no se saben las cívicas).
    if (r && r.tiquetes != null) html += lineasDelReparto(r, f);

    // v1.21.0: la corrección abierta en este viaje (mientras tanto no sale el formulario de lo que falta)
    var corr = tarj.corr && tarj.corr.clave === f.clave ? tarj.corr : null;
    if (corr) html += bloqueCorreccion(f, i, corr);

    // Lo que falta: el "¿Guardar?" o el formulario
    var c = tarj.confirmando;
    if (!corr && falta && c && c.clave === f.clave) {
      var guardando = tarj.guardando === f.clave;
      var valores = [];
      if (c.civica != null) valores.push(["Cívica", c.civica]);
      if (c.pasajeros != null) valores.push(["Pasajeros", c.pasajeros]);
      if (c.tiquetes != null) valores.push(["Tiquetes", c.tiquetes]);
      html += '<div class="tv-confirma">' +
        c.avisos.map(function (a) {
          return '<p class="tv-aviso" data-tipo="' + a.tipo + '">' + escapeHtml(a.texto) +
            (a.tipo === "bajo"
              ? '<button class="btn-link" type="button" data-dano="' + escapeHtml(a.clave) + '">Reportar daño del validador</button>'
              : "") +
            "</p>";
        }).join("") +
        "<p>¿Guardar esto en el " + escapeHtml(nombreViaje(f)) + "?</p>" +
        '<div class="tv-valores">' + valores.map(function (v) {
          return "<div><span>" + v[0] + '</span><strong class="tv-numero">' + v[1] + "</strong></div>";
        }).join("") + "</div>" +
        '<div class="tv-cuenta">' + cuentaDelFormulario(f, i).lineas + "</div>" +
        "<p>Si te equivocas, lo puedes corregir hoy una sola vez, con el botón Corregir de este viaje.</p>" +
        '<div class="tv-acciones">' +
          '<button class="btn btn-primary btn-sm" type="button" data-confirmar="' + escapeHtml(f.clave) + '"' +
            (tarj.guardando ? " disabled" : "") + ">" + (guardando ? "Guardando…" : "Sí, guardar") + "</button>" +
          '<button class="btn btn-ghost btn-sm" type="button" data-cambiar="' + escapeHtml(f.clave) + '"' +
            (guardando ? " disabled" : "") + ">Cambiar</button>" +
        "</div>" +
      "</div>";
    } else if (!corr && falta) {
      var faltan = [];
      if (faltaCivica) faltan.push("la cívica");
      if (faltaPasajeros) faltan.push("los pasajeros");
      if (faltaTiquetes) faltan.push("los tiquetes");
      var titulo = esLaQueSigue
        ? "Escribe " + listaY(faltan) + " de este despacho"
        : (faltan.length === 1 && faltaCivica ? "Falta " : "Faltan ") + listaY(faltan);
      html += '<form class="tv-form" data-clave="' + escapeHtml(f.clave) + '" novalidate>' +
        '<p class="tv-etiqueta">' + titulo + "</p>" +
        (faltaCivica ? campoTarjeta(f, i, "civica", "Número del validador", "Ej. 1250", 9) : "") +
        (faltaPasajeros ? campoTarjeta(f, i, "pasajeros", "Pasajeros", "Ej. 15", 2) : "") +
        (faltaTiquetes ? campoTarjeta(f, i, "tiquetes", "Tiquetes", "Ej. 12", 3) : "") +
        '<div class="tv-cuenta" data-cuenta="' + escapeHtml(f.clave) + '" aria-live="polite"></div>' +
        '<button class="btn btn-primary btn-sm tv-guardar" type="submit">Guardar</button>' +
        (esLaQueSigue && faltaCivica
          ? '<p class="tv-ayuda">Cívica: el número que marca el validador ahora, ya hecho el viaje. Las cívicas del ' +
            'viaje son lo que subió desde la lectura anterior; si el número se repite, no hubo.</p>'
          : "") +
        (esLaQueSigue && faltaPasajeros
          ? '<p class="tv-ayuda">Pasajeros: cuántas personas llevaste en este viaje, contadas por ti; máximo 19, ' +
            'el cupo del bus. Cuenta a todos: los que pagaron con tiquete, con la cívica o en efectivo, y al ' +
            'personal de la empresa que se registró (a ese no se le cobra).</p>'
          : "") +
        (esLaQueSigue && faltaTiquetes
          ? '<p class="tv-ayuda">Tiquetes: los que escaneaste en Distribusion para este viaje; van dentro de tus ' +
            'pasajeros. Si no hubo, pon 0.</p>'
          : "") +
      "</form>";
    }

    var m = tarj.mensaje;
    if (m && m.clave === f.clave) {
      html += '<p class="tv-msg" data-tipo="' + m.tipo + '" role="status">' + escapeHtml(m.texto) + "</p>";
    }

    // Las novedades de este viaje y los botones: el código del personal va en el último viaje (el que está
    // haciendo); la novedad, en cualquiera de hoy.
    var novs = novedadesDeViaje(f.clave);
    if (novs.length) html += '<ul class="nov-lista tv-novedades">' + novs.map(filaNovedad).join("") + "</ul>";
    html += '<div class="tv-extra">' +
      (i === 0 ? '<button class="btn btn-ghost btn-sm" type="button" data-personal-qr>' + ICONO_QR + "Personal de la empresa</button>" : "") +
      '<button class="btn btn-ghost btn-sm" type="button" data-novedad="' + escapeHtml(f.clave) + '">' + ICONO_NOVEDAD + "Reportar novedad</button>" +
      (!corr && camposCorregibles(f).length
        ? '<button class="btn btn-ghost btn-sm" type="button" data-corregir="' + escapeHtml(f.clave) + '">' + ICONO_LAPIZ + "Corregir</button>"
        : "") +
    "</div>";
    return '<li class="tv"' + (falta ? " data-falta" : "") + ">" + html + "</li>";
  }

  // ------------------------------------------- corregir lo guardado (v1.21.0)
  var ICONO_LAPIZ = '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

  // El original y sus correcciones de un número de un viaje, en orden.
  function cadenaEscrita(f, campo) {
    var lista = ((tarj.registros && tarj.registros[campo]) || []).filter(function (x) { return x.clave_viaje === f.clave; });
    var actual = lista.filter(function (x) { return x.corrige_a == null; })[0];
    var cadena = [];
    while (actual && cadena.length < 20) {
      cadena.push(actual);
      var id = actual.id;
      actual = lista.filter(function (x) { return x.corrige_a != null && x.corrige_a === id; })[0];
    }
    return cadena;
  }

  // El renglón que este conductor puede corregir (su id), o null: el original del celular, suyo, de hoy y sin corregir.
  function corregible(f, campo) {
    if (!tarj.conCorreccion || !tarj.registros || tarj.dia !== diaDeTarjeta() || f[CORREGIR[campo].columna] == null) return null;
    var cadena = cadenaEscrita(f, campo);
    var o = cadena[0];
    return o && cadena.length === 1 && o.origen === "celular" && o.mio ? o.id : null;
  }

  function camposCorregibles(f) {
    return CORREGIBLES.filter(function (campo) { return corregible(f, campo) != null; });
  }

  // "Corregidos por ti" o "por el despachador" (si no se sabe quién, el despachador, como antes).
  function chipCorregido(f, campo, palabra) {
    if (!f[CORREGIR[campo].corregido]) return "";
    var cadena = cadenaEscrita(f, campo);
    var ultimo = cadena.length > 1 ? cadena[cadena.length - 1] : null;
    return '<span class="tv-chip" data-nivel="espera">' + palabra +
      (ultimo && ultimo.origen === "celular" ? " por ti" : " por el despachador") + "</span>";
  }

  function motivoDe(corr) {
    return corr.motivo === "otra" ? String(corr.otra || "").trim() : corr.motivo;
  }

  // Lo que va a cambiar: [{ campo, antes, ahora }], solo lo que escribió.
  function cambiosDeCorreccion(f, corr) {
    return corr.campos.filter(function (campo) { return String(corr.valores[campo] || "") !== ""; })
      .map(function (campo) { return { campo: campo, antes: f[CORREGIR[campo].columna], ahora: String(corr.valores[campo]) }; });
  }

  // La cuenta del viaje con los números nuevos (la misma de cuando lo llenó, también la del viaje siguiente).
  function cuentaDeCorreccion(f, i) {
    var g = Object.assign({}, f);
    cambiosDeCorreccion(f, tarj.corr).forEach(function (c) {
      g[CORREGIR[c.campo].columna] = Number(c.ahora);
      if (c.campo === "civica") { g.civicas = null; g.civicaNueva = true; }
    });
    return cuentaDelFormulario(g, i);
  }

  function campoCorreccion(f, i, campo, corr) {
    var d = CORREGIR[campo];
    var id = "corr" + campo + i;
    return '<label class="tv-campo tv-campo-' + campo + '" for="' + id + '"><span>' + d.etiqueta + " · ahora dice " +
        escapeHtml(f[d.columna]) + "</span>" +
      '<input id="' + id + '" data-corr="' + escapeHtml(f.clave) + '" data-campo="' + campo + '" type="text" ' +
        'inputmode="numeric" pattern="[0-9]*" maxlength="' + d.largo + '" autocomplete="off" placeholder="El bueno" ' +
        'value="' + escapeHtml(corr.valores[campo] || "") + '">' +
    "</label>";
  }

  function bloqueCorreccion(f, i, corr) {
    if (corr.confirmando) {
      return '<div class="tv-confirma tv-corr-confirma">' +
        corr.avisos.map(function (a) {
          return '<p class="tv-aviso" data-tipo="' + a.tipo + '">' + escapeHtml(a.texto) +
            (a.tipo === "bajo"
              ? '<button class="btn-link" type="button" data-dano="' + escapeHtml(a.clave) + '">Reportar daño del validador</button>'
              : "") +
            "</p>";
        }).join("") +
        "<p>¿Corregir el " + escapeHtml(nombreViaje(f)) + "?</p>" +
        '<div class="tv-valores">' + cambiosDeCorreccion(f, corr).map(function (c) {
          return "<div><span>" + CORREGIR[c.campo].etiqueta + '</span><strong class="tv-numero"><s>' + escapeHtml(c.antes) +
            "</s> → " + escapeHtml(c.ahora) + "</strong></div>";
        }).join("") + "</div>" +
        '<div class="tv-cuenta">' + cuentaDeCorreccion(f, i).lineas + "</div>" +
        "<p>Por qué: “" + escapeHtml(motivoDe(corr)) + "”. Se corrige una sola vez: después, solo el despachador.</p>" +
        '<div class="tv-acciones">' +
          '<button class="btn btn-primary btn-sm" type="button" data-corr-confirmar' + (corr.guardando ? " disabled" : "") + ">" +
            (corr.guardando ? "Corrigiendo…" : "Sí, corregir") + "</button>" +
          '<button class="btn btn-ghost btn-sm" type="button" data-corr-cambiar' + (corr.guardando ? " disabled" : "") + ">Cambiar</button>" +
        "</div>" +
      "</div>";
    }
    return '<form class="tv-form tv-corr" data-corr-form="' + escapeHtml(f.clave) + '" novalidate>' +
      '<p class="tv-etiqueta">Corregir el ' + escapeHtml(nombreViaje(f)) + "</p>" +
      '<p class="tv-ayuda">Escribe solo el número que quedó mal. Se corrige una sola vez, hoy; después, solo el despachador.</p>' +
      corr.campos.map(function (campo) { return campoCorreccion(f, i, campo, corr); }).join("") +
      '<div class="tv-cuenta" data-corr-cuenta="' + escapeHtml(f.clave) + '" aria-live="polite"></div>' +
      '<fieldset class="tv-motivos"><legend>¿Por qué lo corriges?</legend>' +
        MOTIVOS_CORRECCION.concat(["Otra razón"]).map(function (m, j) {
          var valor = j < MOTIVOS_CORRECCION.length ? m : "otra";
          return '<label class="tv-motivo"><input type="radio" name="corrMotivo" value="' + escapeHtml(valor) + '"' +
            (corr.motivo === valor ? " checked" : "") + "><span>" + escapeHtml(m) + "</span></label>";
        }).join("") +
      "</fieldset>" +
      (corr.motivo === "otra"
        ? '<label class="tv-campo tv-corr-otra"><span>Cuenta qué pasó</span><input type="text" data-corr-otra maxlength="120" ' +
          'autocomplete="off" placeholder="Ej. conté dos veces a un pasajero" value="' + escapeHtml(corr.otra || "") + '"></label>'
        : "") +
      '<div class="tv-acciones tv-corr-acciones">' +
        '<button class="btn btn-primary btn-sm tv-corr-revisar" type="submit">Revisar la corrección</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-corr-cancelar>Cancelar</button>' +
      "</div>" +
    "</form>";
  }

  // Antes de corregir, una ventana con lo que se puede corregir de ese viaje, cómo se hace (tres pasos con un ejemplo)
  // y que es una sola vez y solo hoy. "Sí, quiero corregir" abre la corrección en el viaje.
  var avisoCorr = { clave: null };

  function abrirAvisoCorreccion(clave) {
    var f = (tarj.filas || []).find(function (x) { return x.clave === clave; });
    var campos = f ? camposCorregibles(f) : [];
    if (!campos.length) return;
    avisoCorr.clave = clave;
    $("corrViajeNum").textContent = f.sin_despacho ? "–" : String(f.viaje || "–");
    var nombre = nombreViaje(f);
    $("corrViajeTitulo").textContent = nombre.charAt(0).toUpperCase() + nombre.slice(1) + " · salió " + horaViaje(f);
    $("corrViajeRuta").textContent = f.sin_despacho ? "Sin despacho"
      : f.itinerario ? rutaLegible(f.itinerario) : f.ruta ? "Ruta " + f.ruta : "Sin itinerario";
    $("corrSheetValores").innerHTML = campos.map(function (campo) {
      return "<span>" + CORREGIR[campo].etiqueta + " <b>" + escapeHtml(f[CORREGIR[campo].columna]) + "</b></span>";
    }).join("");
    show($("corrSheet"), true);
    $("corrSheet").querySelector(".sheet").scrollTop = 0;     // que se lea desde arriba: el viaje y lo que puede corregir
    try { $("corrSeguir").focus({ preventScroll: true }); } catch (_) { /* navegador viejo: sin foco */ }
  }

  function cerrarAvisoCorreccion() {
    show($("corrSheet"), false);
    avisoCorr.clave = null;
  }

  function abrirCorreccion(clave) {
    var f = (tarj.filas || []).find(function (x) { return x.clave === clave; });
    var campos = f ? camposCorregibles(f) : [];
    if (!campos.length) return;
    if (tarj.confirmando && tarj.confirmando.clave === clave) tarj.confirmando = null;
    tarj.corr = { clave: clave, campos: campos, valores: {}, motivo: MOTIVOS_CORRECCION[0], otra: "", avisos: [],
                  confirmando: false, guardando: false };
    tarj.mensaje = null;
    pintarTarjeta();
    enfocarCorreccion();
  }

  function enfocarCorreccion() {
    var campo = $("tarjetaBody").querySelector("[data-corr]");
    if (campo) campo.focus();
  }

  function prepararCorreccion(clave) {
    var corr = tarj.corr;
    var filas = tarj.filas || [];
    var i = filas.findIndex(function (x) { return x.clave === clave; });
    if (!corr || corr.clave !== clave || i < 0) return;
    var f = filas[i];
    var cambios = cambiosDeCorreccion(f, corr);
    var falla = !cambios.length ? "Escribe el número bueno en lo que quedó mal."
      : cambios.some(function (c) { return Number(c.ahora) === Number(c.antes); }) ? "Ese ya es el número que tiene: escribe el bueno."
      : cuentaDeCorreccion(f, i).mal
      || (corr.motivo === "otra" && motivoDe(corr).length < 3 ? "Cuenta por qué lo corriges." : "")
      || (!navigator.onLine ? "Necesitas conexión para corregir." : "");
    if (falla) {
      tarj.mensaje = { clave: clave, tipo: "error", texto: falla };
      pintarTarjeta();
      return;
    }
    var civica = cambios.filter(function (c) { return c.campo === "civica"; })[0];
    corr.avisos = (civica ? avisosDeLectura(filas, i, Number(civica.ahora)) : [])
      .concat(cuentaDeCorreccion(f, i).avisos.map(function (t) { return { tipo: "salto", texto: t }; }));
    corr.confirmando = true;
    tarj.mensaje = null;
    pintarTarjeta();
  }

  function errorAlCorregir(err, campo) {
    var codigo = err && err.code;
    if (codigo === "23505") return "Eso ya estaba corregido (por ti o por el despachador): mira el número que quedó.";
    if (codigo === "42501") {
      return "No se pudo corregir " + NOMBRE_CAMPO[campo] + ": ya no se puede desde aquí (pasó el día o no lo escribiste tú). " +
        "Pídeselo al despachador.";
    }
    if (codigo === "23514") return "Escribe por qué lo corriges.";
    return "No se pudo corregir " + NOMBRE_CAMPO[campo] + (err && err.message ? " (" + err.message + ")" : "") + ". Intenta otra vez.";
  }

  async function guardarCorreccion() {
    var corr = tarj.corr;
    if (!corr || !corr.confirmando || corr.guardando) return;
    var f = (tarj.filas || []).find(function (x) { return x.clave === corr.clave; });
    if (!f) return;
    corr.guardando = true;
    pintarTarjeta();
    var motivo = motivoDe(corr);
    var hecho = [];
    var errores = [];
    var cambios = cambiosDeCorreccion(f, corr);
    for (var k = 0; k < cambios.length; k++) {
      var c = cambios[k];
      var d = CORREGIR[c.campo];
      var id = corregible(f, c.campo);
      if (id == null) {
        errores.push("No se pudo corregir " + NOMBRE_CAMPO[c.campo] + ": ya no se puede desde aquí. Pídeselo al despachador.");
        continue;
      }
      var fila = { clave_viaje: f.clave, dia: f.dia, interno: f.interno, corrige_a: id, motivo: motivo,
                   cedula: state.dni || null, nombre: nombreConductor(), origen: "celular" };
      fila[d.valor] = Number(c.ahora);
      try {
        var r = await conTiempoLimite(client.from(d.tabla).insert(fila));
        if (r.error) throw r.error;
        // Se ve al instante; la recarga trae lo que dice la base.
        if (c.campo === "civica") ponerLecturaEnFila(f, Number(c.ahora));
        else f[d.columna] = Number(c.ahora);
        f[d.corregido] = true;
        tarj.registros[c.campo].push({ id: "celular-" + c.campo + "-" + Date.now(), clave_viaje: f.clave, corrige_a: id,
                                       origen: "celular", mio: true });
        hecho.push(NOMBRE_CAMPO[c.campo]);
      } catch (err) {
        errores.push(errorAlCorregir(err, c.campo));
      }
    }
    tarj.corr = null;
    tarj.mensaje = errores.length
      ? { clave: f.clave, tipo: "error", texto: (hecho.length ? "Se corrigió " + listaY(hecho) + ". " : "") + errores.join(" ") }
      : { clave: f.clave, tipo: "ok", texto: "Corregido a las " + horaDeMs(Date.now()) + ". El despachador ve el número de antes y el nuevo." };
    pintarTarjeta();
    cargarTarjeta();
  }

  function lineaPlata(etiqueta, n, plata, extra) {
    return '<div class="tv-civica tv-reparto-linea"><span>' + etiqueta + " <b>" + n + "</b></span>" +
      (plata != null ? '<span class="tv-plata">' + pesos(plata) + "</span>" : "") + (extra || "") + "</div>";
  }

  // Debajo de los tiquetes de un viaje: con cívica y en efectivo, o los dos
  // juntos mientras no se saben las cívicas (y por qué); y si no cuadra, por qué.
  function lineasDelReparto(r, f) {
    var html = r.civicas == null
      ? lineaPlata("Cívica o efectivo", r.sinTiquete, plataDe(r, r.sinTiquete),
          '<span class="tv-chip" data-nivel="espera">' +
            (f && f.civica_lectura == null ? "Falta la cívica de este viaje" : "Falta la cívica del viaje anterior") +
          "</span>")
      : lineaPlata("Con cívica", r.civicas, plataDe(r, r.civicas)) +
        lineaPlata("En efectivo", r.efectivo, plataDe(r, r.efectivo));
    if (r.sobran) {
      html += '<div class="tv-civica"><span class="tv-chip" data-nivel="mal">No cuadra: ' +
        escapeHtml(textoSobran(r)) + "</span></div>";
    }
    return html;
  }

  // La cuenta del viaje mientras escribe, con lo que lleva escrito y lo ya
  // guardado. mal: lo que no deja guardar (más de 19, o más tiquetes que
  // pasajeros). Las cívicas de este viaje salen de la lectura que escribe menos
  // la del anterior: si con ellas no cuadra, solo avisa (puede estar mal escrita
  // la del viaje anterior). Si el viaje siguiente ya tiene su lectura, también
  // dice cómo le queda (avisos, si no cuadra; eso no tranca). Sirve igual para
  // corregir (v1.21.0): f trae los números nuevos y civicaNueva si cambió la cívica.
  function cuentaDelFormulario(f, i) {
    var filas = tarj.filas || [];
    function escrito(x, campo, guardado) {
      if (x[guardado] != null) return Number(x[guardado]);
      var v = (tarj.borrador[x.clave] || {})[campo];
      return v == null || v === "" ? null : Number(v);
    }
    var pas = escrito(f, "pasajeros", "pasajeros_conductor");
    var tiq = escrito(f, "tiquetes", "tiquetes_escaneados");
    var lectura = escrito(f, "civica", "civica_lectura");
    var civ = civicasDe(f);
    var ant = filas[i + 1];                      // la lista va del más reciente al más viejo
    var sig = i > 0 ? filas[i - 1] : null;
    if (civ == null && lectura != null) {
      // El primer viaje del día: la lectura anterior es la del último despacho del bus (otro día u otro conductor).
      var lecAnt = ant ? escrito(ant, "civica", "civica_lectura")
        : f.lectura_anterior != null ? Number(f.lectura_anterior) : null;
      if (lecAnt != null && lectura >= lecAnt) civ = lectura - lecAnt;
    }
    var lineas = [], avisos = [], mal = "";
    if (pas != null && pas > CUPO) {
      mal = "Máximo " + CUPO + " pasajeros: es el cupo del bus.";
    } else if (pas == null && tiq != null && tiq > CUPO) {
      mal = "Máximo " + CUPO + " tiquetes: es el cupo del bus.";
    } else if (pas != null) {
      var propios = repartir(pas, f.personal, tiq, null, f.tarifa);   // solo lo que escribe él
      var r = repartir(pas, f.personal, tiq, civ, f.tarifa);
      if (propios.sobran) {
        mal = "No cuadra: " + textoSobran(propios) + ". Revisa los números.";
      } else if (r.sobran) {
        avisos.push("Con esta lectura salen " + enCivicas(civ) + " y no cuadra: " + textoSobran(r) +
          ". Revisa el número del validador; si está bien, el despachador revisa el viaje.");
      } else {
        lineas.push(textoCuenta(r));
      }
    }
    if ((f.civica_lectura == null || f.civicaNueva) && lectura != null && sig && sig.civica_lectura != null &&
        sig.pasajeros_conductor != null && Number(sig.civica_lectura) >= lectura) {
      var civSig = Number(sig.civica_lectura) - lectura;
      var rSig = repartir(sig.pasajeros_conductor, sig.personal, sig.tiquetes_escaneados, civSig, sig.tarifa);
      var dice = "Con esta lectura, el " + nombreViaje(sig) + " tuvo " + enCivicas(civSig);
      if (rSig.sobran) {
        avisos.push(dice + " y no cuadra: " + textoSobran(rSig) + ". Revisa el número; si está bien, el despachador corrige ese viaje.");
      } else if (rSig.tiquetes != null) {
        lineas.push(dice + ": " + textoCuenta(rSig));
      }
    }
    var parrafos = function (lista, clase) {
      return lista.map(function (t) { return '<p class="' + clase + '">' + escapeHtml(t) + "</p>"; }).join("");
    };
    var lineasHtml = parrafos(lineas, "tv-cuenta-linea");
    return {
      mal: mal, avisos: avisos, lineas: lineasHtml,
      html: (mal ? parrafos([mal], "tv-cuenta-mal") : "") + lineasHtml + parrafos(avisos, "tv-cuenta-aviso"),
    };
  }

  // Pone al día la cuenta de cada formulario abierto y no deja guardar si no cuadra.
  function actualizarCuentas() {
    var box = $("tarjetaBody");
    var filas = tarj.filas || [];
    Array.prototype.forEach.call(box.querySelectorAll("[data-cuenta]"), function (el) {
      var i = filas.findIndex(function (x) { return x.clave === el.getAttribute("data-cuenta"); });
      if (i < 0) return;
      var c = cuentaDelFormulario(filas[i], i);
      if (el.innerHTML !== c.html) el.innerHTML = c.html;
      var form = el.closest(".tv-form");
      if (!form) return;
      if (c.mal) form.setAttribute("data-mal", ""); else form.removeAttribute("data-mal");
      var btn = form.querySelector(".tv-guardar");
      if (btn) btn.disabled = !!c.mal;
    });
    // v1.21.0: la cuenta de la corrección abierta
    Array.prototype.forEach.call(box.querySelectorAll("[data-corr-cuenta]"), function (el) {
      var i = filas.findIndex(function (x) { return x.clave === el.getAttribute("data-corr-cuenta"); });
      if (i < 0 || !tarj.corr) return;
      var c = cuentaDeCorreccion(filas[i], i);
      if (el.innerHTML !== c.html) el.innerHTML = c.html;
      var form = el.closest(".tv-form");
      if (!form) return;
      if (c.mal) form.setAttribute("data-mal", ""); else form.removeAttribute("data-mal");
      var btn = form.querySelector(".tv-corr-revisar");
      if (btn) btn.disabled = !!c.mal;
    });
  }

  function prepararLectura(clave) {
    var filas = tarj.filas || [];
    var i = filas.findIndex(function (f) { return f.clave === clave; });
    if (i < 0) return;
    var f = filas[i];
    var b = tarj.borrador[clave] || {};
    var civica = f.civica_lectura == null ? String(b.civica || "").trim() : "";
    var pasajeros = f.pasajeros_conductor == null ? String(b.pasajeros || "").trim() : "";
    var tiquetes = f.tiquetes_escaneados == null ? String(b.tiquetes || "").trim() : "";

    var falla = !civica && !pasajeros && !tiquetes
      ? (f.civica_lectura == null ? "Escribe el número que marca el validador."
        : f.pasajeros_conductor == null ? "Escribe cuántos pasajeros llevaste."
        : "Escribe cuántos tiquetes escaneaste.")
      : civica && !/^\d{1,9}$/.test(civica) ? "La cívica va solo con números."
      : pasajeros && !/^\d{1,2}$/.test(pasajeros) ? "Los pasajeros van solo con números."
      : tiquetes && !/^\d{1,3}$/.test(tiquetes) ? "Los tiquetes van solo con números."
      : cuentaDelFormulario(f, i).mal;
    if (falla) {
      tarj.mensaje = { clave: clave, tipo: "error", texto: falla };
      pintarTarjeta();
      return;
    }

    var avisos = (civica ? avisosDeLectura(filas, i, Number(civica)) : [])
      .concat(cuentaDelFormulario(f, i).avisos.map(function (t) { return { tipo: "salto", texto: t }; }));
    // Dejó alguno en blanco: se puede, pero que lo sepa.
    var blancos = [];
    if (f.civica_lectura == null && !civica) blancos.push("la cívica");
    if (f.pasajeros_conductor == null && !pasajeros) blancos.push("los pasajeros");
    if (f.tiquetes_escaneados == null && !tiquetes) blancos.push("los tiquetes");
    if (blancos.length) {
      avisos.push({
        tipo: "nota",
        texto: "No escribiste " + listaY(blancos) + ": " +
          (blancos.length === 1 && blancos[0] === "la cívica" ? "la" : "los") + " puedes poner después.",
      });
    }
    tarj.mensaje = null;
    tarj.confirmando = {
      clave: clave,
      civica: civica ? Number(civica) : null,
      pasajeros: pasajeros ? Number(pasajeros) : null,
      tiquetes: tiquetes ? Number(tiquetes) : null,
      avisos: avisos,
    };
    pintarTarjeta();
  }

  var NOMBRE_CAMPO = { civica: "la cívica", pasajeros: "los pasajeros", tiquetes: "los tiquetes" };

  function errorAlGuardar(err, cual) {
    var codigo = err && err.code;
    if (codigo === "23505") {
      return cual === "civica"
        ? "La cívica de ese viaje ya estaba guardada: mira el número que quedó."
        : (cual === "pasajeros" ? "Los pasajeros" : "Los tiquetes") +
          " de ese viaje ya estaban guardados: mira el número que quedó.";
    }
    if (codigo === "42501") return "Esta cuenta no puede guardar en la tarjeta. Avísale a tu coordinador.";
    if (codigo === "23514") return "Ese número no es válido.";
    return "No se pudo guardar " + NOMBRE_CAMPO[cual] +
      (err && err.message ? " (" + err.message + ")" : "") + ". Intenta otra vez.";
  }

  // La lectura recién guardada (o corregida) se ve al instante, con las cívicas de este viaje (su lectura - la del
  // anterior); la recarga trae lo que dice la base (salto, daño, corregida).
  function ponerLecturaEnFila(f, lectura) {
    f.civica_lectura = lectura;
    var antes = tarj.filas[tarj.filas.indexOf(f) + 1];
    var lecAntes = antes ? antes.civica_lectura : f.lectura_anterior;
    f.civicas = lecAntes != null && lectura >= Number(lecAntes) ? lectura - Number(lecAntes) : null;
    f.estado_civica = lecAntes == null ? "falta_lectura_anterior" : f.civicas == null ? "bajo" : "ok";
  }

  async function guardarLectura(clave) {
    var c = tarj.confirmando;
    if (!c || c.clave !== clave || tarj.guardando) return;
    var f = (tarj.filas || []).find(function (x) { return x.clave === clave; });
    if (!f) return;

    tarj.guardando = clave;
    pintarTarjeta();
    var quien = { cedula: state.dni || null, nombre: nombreConductor(), origen: "celular" };
    var borrador = tarj.borrador[clave] || {};
    var hecho = [];
    var errores = [];

    if (c.civica != null) {
      try {
        var r1 = await conTiempoLimite(client.from(cfg.TABLA_CIVICA_LECTURAS).insert(Object.assign({
          clave_viaje: f.clave, dia: f.dia, interno: f.interno, lectura: c.civica,
        }, quien)));
        if (r1.error) throw r1.error;
        ponerLecturaEnFila(f, c.civica);
        delete borrador.civica;
        hecho.push("la cívica");
      } catch (err) {
        // Ya estaba guardada (por ejemplo, la señal se cayó justo después de
        // enviarla): la recarga muestra el número que quedó.
        if (err && err.code === "23505") delete borrador.civica;
        errores.push(errorAlGuardar(err, "civica"));
      }
    }
    // Los pasajeros y los tiquetes: cada uno en su hoja, y se guardan igual.
    var cantidades = [
      { campo: "pasajeros", tabla: cfg.TABLA_TARJETA_PASAJEROS, columna: "pasajeros_conductor" },
      { campo: "tiquetes", tabla: cfg.TABLA_TARJETA_TIQUETES, columna: "tiquetes_escaneados" },
    ];
    for (var k = 0; k < cantidades.length; k++) {
      var q = cantidades[k];
      if (c[q.campo] == null) continue;
      try {
        var r2 = await conTiempoLimite(client.from(q.tabla).insert(Object.assign({
          clave_viaje: f.clave, dia: f.dia, interno: f.interno, cantidad: c[q.campo],
        }, quien)));
        if (r2.error) throw r2.error;
        f[q.columna] = c[q.campo];
        delete borrador[q.campo];
        hecho.push(NOMBRE_CAMPO[q.campo]);
      } catch (err) {
        if (err && err.code === "23505") delete borrador[q.campo];
        errores.push(errorAlGuardar(err, q.campo));
      }
    }

    tarj.confirmando = null;
    tarj.mensaje = errores.length
      ? { clave: clave, tipo: "error", texto: (hecho.length ? "Se guardó " + listaY(hecho) + ". " : "") + errores.join(" ") }
      : { clave: clave, tipo: "ok", texto: "Guardado a las " + horaDeMs(Date.now()) + "." };
    tarj.guardando = null;
    pintarTarjeta();
    cargarTarjeta();
  }

  // ------------------------------------------- daño del validador de la cívica
  // Lo reporta el conductor con foto (obligatoria), en qué número quedó el
  // validador dañado y con cuál arrancó el nuevo. Queda "En revisión" hasta
  // que un despachador lo aprueba o lo rechaza; la base no deja que se apruebe
  // desde aquí.
  var dano = { foto: null, vista: null, enviando: false };

  function ponerFotoDano(archivo) {
    if (dano.vista) URL.revokeObjectURL(dano.vista);
    dano.foto = archivo || null;
    dano.vista = archivo ? URL.createObjectURL(archivo) : null;
    var img = $("danoFotoVista");
    if (dano.vista) img.src = dano.vista; else img.removeAttribute("src");
    show(img, !!dano.vista);
    $("danoFotoTexto").textContent = archivo ? "Cambiar la foto" : "Tomar la foto del validador";
    if (!archivo) $("danoFoto").value = "";
  }

  function errorDano(texto) {
    var box = $("danoError");
    box.textContent = texto || "";
    show(box, !!texto);
  }

  function abrirDano(claveSugerida) {
    var filas = tarj.filas || [];
    if (!filas.length) return;
    var conLectura = filas.find(function (f) { return f.civica_lectura != null; });
    var elegida = claveSugerida || (conLectura || filas[0]).clave;

    $("danoViaje").innerHTML = filas.map(function (f) {
      var texto = nombreViaje(f).replace(/^v/, "V") + " · salió " + horaViaje(f) +
        (f.civica_lectura != null ? " · cívica " + f.civica_lectura : "");
      return '<option value="' + escapeHtml(f.clave) + '">' + escapeHtml(texto) + "</option>";
    }).join("");
    $("danoViaje").value = elegida;
    $("danoViejo").value = "";
    $("danoNuevo").value = "";
    $("danoDescripcion").value = "";
    ponerFotoDano(null);
    errorDano("");
    show($("danoSheet"), true);
  }

  function cerrarDano() {
    if (dano.enviando) return;
    show($("danoSheet"), false);
    ponerFotoDano(null);
  }

  // La foto se achica antes de subirla (lado máximo CIVICA_FOTO_LADO_MAX): de
  // 4 MB a unos 300 KB. Si el teléfono no puede, sube la original.
  function achicarFoto(archivo) {
    var lado = cfg.CIVICA_FOTO_LADO_MAX || 1600;
    return new Promise(function (resolver) {
      var url = URL.createObjectURL(archivo);
      var img = new Image();
      img.onload = function () {
        var escala = Math.min(1, lado / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        var lienzo = document.createElement("canvas");
        lienzo.width = Math.max(1, Math.round(img.naturalWidth * escala));
        lienzo.height = Math.max(1, Math.round(img.naturalHeight * escala));
        try {
          lienzo.getContext("2d").drawImage(img, 0, 0, lienzo.width, lienzo.height);
        } catch (_) {
          URL.revokeObjectURL(url);
          resolver(archivo);
          return;
        }
        URL.revokeObjectURL(url);
        lienzo.toBlob(function (blob) {
          resolver(blob && blob.size < archivo.size ? blob : archivo);
        }, "image/jpeg", 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolver(archivo); };
      img.src = url;
    });
  }

  async function enviarDano(ev) {
    ev.preventDefault();
    if (dano.enviando) return;
    var f = (tarj.filas || []).find(function (x) { return x.clave === $("danoViaje").value; });
    var viejo = $("danoViejo").value.replace(/\D/g, "");
    var nuevo = $("danoNuevo").value.replace(/\D/g, "");
    var que = $("danoDescripcion").value.trim();

    var falla = !f ? "Escoge el viaje en que se dañó."
      : !nuevo ? "Escribe con qué número arrancó el validador nuevo."
      : que.length < 5 ? "Cuenta en pocas palabras qué pasó."
      : !dano.foto ? "Falta la foto del validador."
      : "";
    if (falla) { errorDano(falla); return; }
    errorDano("");

    var boton = $("danoEnviar");
    dano.enviando = true;
    boton.disabled = true;
    boton.textContent = "Enviando…";
    try {
      var foto = await achicarFoto(dano.foto);
      var tipo = foto.type || "image/jpeg";
      var ext = (tipo.split("/")[1] || "jpg").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
      var ruta = normalizarInterno(f.interno) + "/" + f.dia + "/" + f.clave + "-" + Date.now() + "." + ext;
      var subida = await conTiempoLimite(
        client.storage.from(cfg.BUCKET_CIVICA).upload(ruta, foto, { contentType: tipo, upsert: false }),
        60000
      );
      if (subida.error) throw subida.error;

      var res = await conTiempoLimite(
        client.from(cfg.TABLA_CIVICA_DANOS).insert({
          clave_viaje: f.clave, dia: f.dia, interno: f.interno,
          lectura_final_viejo: viejo ? Number(viejo) : null,
          lectura_inicial_nuevo: Number(nuevo),
          descripcion: que, foto: ruta,
          cedula: state.dni || null, nombre: nombreConductor(), origen: "celular",
        })
      );
      if (res.error) throw res.error;

      dano.enviando = false;
      cerrarDano();
      tarj.mensaje = { clave: f.clave, tipo: "ok", texto: "Reporte de daño enviado. El despachador lo revisa." };
      pintarTarjeta();
      cargarTarjeta();
    } catch (err) {
      errorDano("No se pudo enviar el reporte" + (err && err.message ? " (" + err.message + ")" : "") +
        ". Intenta otra vez.");
    } finally {
      dano.enviando = false;
      boton.disabled = false;
      boton.textContent = "Enviar reporte";
    }
  }

  function initTarjeta() {
    $("btnRefrescarTarjeta").addEventListener("click", function () { cargarTarjeta(); });
    $("tarjetaResumenBody").addEventListener("click", function (ev) {
      if (ev.target.closest && ev.target.closest("[data-abrir-tarjeta]")) irA("tarjeta");
    });

    var box = $("tarjetaBody");
    // v1.22.0: la lista del otro conductor sigue abierta (o cerrada) cuando la tarjeta se vuelve a pintar.
    // "toggle" no sube por el árbol: se escucha en la captura.
    box.addEventListener("toggle", function (ev) {
      if (ev.target.classList && ev.target.classList.contains("tarj-otro")) tarj.otroAbierto = ev.target.open;
    }, true);
    box.addEventListener("input", function (ev) {
      // v1.21.0: lo que escribe en la corrección
      var corr = tarj.corr;
      if (corr && ev.target.hasAttribute && ev.target.hasAttribute("data-corr-otra")) {
        corr.otra = ev.target.value;
        return;
      }
      if (corr && ev.target.getAttribute && ev.target.getAttribute("data-corr")) {
        var solo = ev.target.value.replace(/\D/g, "");
        if (solo !== ev.target.value) ev.target.value = solo;
        corr.valores[ev.target.getAttribute("data-campo")] = solo;
        actualizarCuentas();
        if (tarj.mensaje && tarj.mensaje.clave === corr.clave && tarj.mensaje.tipo === "error") {
          tarj.mensaje = null;
          var aviso = ev.target.closest(".tv") && ev.target.closest(".tv").querySelector(".tv-msg");
          if (aviso) aviso.remove();
        }
        return;
      }
      var clave = ev.target.getAttribute && ev.target.getAttribute("data-lectura");
      if (!clave) return;
      var limpio = ev.target.value.replace(/\D/g, "");
      if (limpio !== ev.target.value) ev.target.value = limpio;
      tarj.borrador[clave] = tarj.borrador[clave] || {};
      tarj.borrador[clave][ev.target.getAttribute("data-campo")] = limpio;
      actualizarCuentas();
      if (tarj.mensaje && tarj.mensaje.clave === clave && tarj.mensaje.tipo === "error") {
        tarj.mensaje = null;
        var msg = ev.target.closest(".tv") && ev.target.closest(".tv").querySelector(".tv-msg");
        if (msg) msg.remove();
      }
    });
    box.addEventListener("change", function (ev) {
      if (!tarj.corr || !ev.target || ev.target.name !== "corrMotivo") return;
      tarj.corr.motivo = ev.target.value;
      pintarTarjeta();
      var otra = box.querySelector("[data-corr-otra]");
      if (otra && tarj.corr.motivo === "otra") otra.focus();
    });
    box.addEventListener("submit", function (ev) {
      var form = ev.target.closest ? ev.target.closest(".tv-form") : null;
      if (!form) return;
      ev.preventDefault();
      if (form.hasAttribute("data-corr-form")) prepararCorreccion(form.getAttribute("data-corr-form"));
      else prepararLectura(form.getAttribute("data-clave"));
    });
    box.addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("button") : null;
      if (!b || !box.contains(b)) return;
      if (b.hasAttribute("data-confirmar")) {
        guardarLectura(b.getAttribute("data-confirmar"));
      } else if (b.hasAttribute("data-cambiar")) {
        var clave = b.getAttribute("data-cambiar");
        tarj.confirmando = null;
        pintarTarjeta();
        Array.prototype.some.call(box.querySelectorAll("[data-lectura]"), function (campo) {
          if (campo.getAttribute("data-lectura") !== clave) return false;
          campo.focus();
          return true;
        });
      } else if (b.hasAttribute("data-dano")) {
        abrirDano(b.getAttribute("data-dano") || null);
      } else if (b.hasAttribute("data-novedad")) {
        abrirNovedad(b.getAttribute("data-novedad"));
      } else if (b.hasAttribute("data-personal-qr")) {
        abrirPersonal();
      } else if (b.hasAttribute("data-nov-quitar")) {
        novBorrar(b.getAttribute("data-nov-quitar")).catch(noHacerNada).then(pintarNovedadesMias);
      } else if (b.hasAttribute("data-corregir")) {
        abrirAvisoCorreccion(b.getAttribute("data-corregir"));
      } else if (b.hasAttribute("data-corr-cancelar")) {
        tarj.corr = null;
        tarj.mensaje = null;
        pintarTarjeta();
      } else if (b.hasAttribute("data-corr-cambiar")) {
        if (tarj.corr) tarj.corr.confirmando = false;
        pintarTarjeta();
        enfocarCorreccion();
      } else if (b.hasAttribute("data-corr-confirmar")) {
        guardarCorreccion();
      }
    });

    // v1.21.0: la ventana de antes de corregir
    $("corrSheetClose").addEventListener("click", cerrarAvisoCorreccion);
    $("corrCancelar").addEventListener("click", cerrarAvisoCorreccion);
    $("corrSheet").addEventListener("click", function (ev) {
      if (ev.target === $("corrSheet")) cerrarAvisoCorreccion();
    });
    $("corrSeguir").addEventListener("click", function () {
      var clave = avisoCorr.clave;
      cerrarAvisoCorreccion();
      if (clave) abrirCorreccion(clave);
    });

    $("danoSheetClose").addEventListener("click", cerrarDano);
    $("danoSheet").addEventListener("click", function (ev) {
      if (ev.target === $("danoSheet")) cerrarDano();
    });
    $("danoForm").addEventListener("submit", enviarDano);
    $("danoFoto").addEventListener("change", function () {
      ponerFotoDano(this.files && this.files[0] ? this.files[0] : null);
    });
    ["danoViejo", "danoNuevo"].forEach(function (id) {
      $(id).addEventListener("input", function () {
        var limpio = this.value.replace(/\D/g, "");
        if (limpio !== this.value) this.value = limpio;
      });
    });

    // Con el inicio o la tarjeta a la vista se vuelve a consultar cada 2 min;
    // mientras confirma, guarda o corrige un número, no se le mueve la pantalla.
    setInterval(function () {
      if (!state.user || !VISTAS_NATIVAS[state.vista] || document.hidden || $("appView").hidden) return;
      if (tarj.confirmando || tarj.guardando || tarj.corr) return;
      cargarTarjeta();
    }, cfg.TARJETA_REFRESCO_MS || 120000);
  }

  // ---------------------------------------------------------- mi jornada
  // Resuelve (y memoriza) el id del conductor en la tabla colaboradores, que
  // es por donde se referencian las marcas de asistencia.
  async function obtenerColaboradorId() {
    if (state.colaboradorId) return state.colaboradorId;
    if (!state.dni) return null;

    var res = await conTiempoLimite(
      client.from("colaboradores").select("id").eq("dni", state.dni).maybeSingle()
    );
    if (res.error) throw res.error;

    state.colaboradorId = res.data ? res.data.id : null;
    return state.colaboradorId;
  }

  async function cargarJornada() {
    var box = $("jornadaBody");

    if (!state.dni) {
      box.innerHTML = '<p class="placeholder">Identifícate para ver tus marcas de hoy.</p>';
      return;
    }

    esqueleto(box, "lineas");

    try {
      var colaboradorId = await obtenerColaboradorId();
      if (!colaboradorId) {
        pintarJornada([]);
        return;
      }

      var res = await conTiempoLimite(
        client
          .from(cfg.TABLA_ASISTENCIAS)
          .select("id,fecha,hora,sentido,origen,vehiculo_reporte")
          .eq("colaborador_id", colaboradorId)
          .eq("fecha", hoyColombia())
          .order("hora", { ascending: true })
      );
      if (res.error) throw res.error;

      var marcas = res.data || [];
      guardarCache("jornada_" + state.dni, marcas);
      pintarJornada(marcas);
    } catch (err) {
      var cache = leerCache("jornada_" + state.dni);
      if (cache) {
        marcarDatosGuardados(cache.guardadoEn);
        pintarJornada(cache.datos || []);
        return;
      }
      pintarErrorTarjeta(box, "No se pudieron cargar tus marcas.", err, cargarJornada);
    }
  }

  function pintarJornada(marcas) {
    var box = $("jornadaBody");

    if (!marcas || !marcas.length) {
      box.innerHTML =
        '<p class="placeholder">Todavía no has marcado hoy.</p>' +
        '<button class="btn btn-primary btn-sm" type="button" data-ir-asistencia ' +
        'style="margin-top:11px">Marcar ahora</button>';
      var btn = box.querySelector("[data-ir-asistencia]");
      if (btn) btn.addEventListener("click", function () { irA("asistencia"); });
      return;
    }

    box.innerHTML =
      '<ul class="marcas">' +
      marcas.map(function (m) {
        var tipo = String(m.sentido || "").toLowerCase();
        return '<li class="marca">' +
          '<span class="marca-tipo" data-tipo="' + escapeHtml(tipo) + '">' +
            escapeHtml(m.sentido || "—") + "</span>" +
          '<span class="marca-hora">' + escapeHtml(horaCorta(m.hora)) + "</span>" +
          '<span class="marca-meta">' +
            escapeHtml(m.vehiculo_reporte || m.origen || "") + "</span>" +
        "</li>";
      }).join("") +
      "</ul>";
  }

  // -------------------------------------------------------------- mi fila
  async function cargarFila() {
    var box = $("filaBody");
    var interno = state.vehiculo ? String(state.vehiculo).trim() : null;

    if (!interno) {
      box.innerHTML =
        '<p class="placeholder">Cuando tengas vehículo asignado verás aquí tu posición en la fila.</p>';
      return;
    }

    // La posición en la fila cambia minuto a minuto: no se guarda en caché,
    // un dato viejo aquí engañaría al conductor.
    if (!navigator.onLine) {
      box.innerHTML = '<p class="placeholder">Necesitas conexión para ver la fila en vivo.</p>';
      return;
    }

    esqueleto(box, "bloque");

    try {
      var consultaFila = client.from(cfg.TABLA_ENTURNAMIENTO).select("*");
      if (cfg.SOLO_PUNTO_ENTURNAMIENTO) {
        consultaFila = consultaFila.eq("punto", cfg.SOLO_PUNTO_ENTURNAMIENTO);
      }
      var resFila = await conTiempoLimite(consultaFila);
      if (resFila.error) throw resFila.error;

      // Se descuentan los buses que un despachador ocultó a mano, para que la
      // posición coincida con la que se ve en el módulo de aeropuerto.
      var ocultos = new Set();
      try {
        var resOcultos = await conTiempoLimite(
          client.from(cfg.TABLA_ENTURNAMIENTO_OCULTOS).select("id"), 6000
        );
        if (!resOcultos.error) {
          (resOcultos.data || []).forEach(function (r) { ocultos.add(r.id); });
        }
      } catch (_) { /* sin la lista de ocultos seguimos con la fila completa */ }

      var todas = (resFila.data || []).filter(function (r) {
        return !ocultos.has(String(r.vehicle_id || "") + "|" + String(r.llegada_aeropuerto || ""));
      });

      // Primero se busca el bus del conductor: él no tiene por qué saber en qué
      // punto lo tiene anotado el programa. Puede estar esperando en el
      // aeropuerto, en Almacentro, en Nutibara...
      var mio = todas.find(function (r) {
        return normalizarInterno(r.interno) === normalizarInterno(interno);
      });

      if (!mio) {
        box.innerHTML =
          '<p class="placeholder">Tu vehículo (' + escapeHtml(interno) +
          ") no está esperando turno en ningún punto en este momento.</p>";
        return;
      }

      // El puesto se cuenta SOLO entre los del mismo punto: en el aeropuerto se
      // hace una fila y en Almacentro otra, no se mezclan.
      var fila = todas
        .filter(function (r) { return r.punto === mio.punto; })
        // Por orden de llegada. El turno ya viene numerado por el programa
        // (1, 2, 3...); si faltara, se ordena por hora.
        .sort(function (a, b) {
          if (a.turno && b.turno) return a.turno - b.turno;
          return String(a.llegada_aeropuerto || "").localeCompare(String(b.llegada_aeropuerto || ""));
        });

      var idx = fila.findIndex(function (r) {
        return normalizarInterno(r.interno) === normalizarInterno(interno);
      });

      box.innerHTML =
        '<div class="fila-hero">' +
          '<div class="fila-puesto"><strong>' + (idx + 1) + "</strong><span>de " + fila.length + "</span></div>" +
          '<div class="fila-info">' +
            "<strong>Bus " + escapeHtml(mio.interno || interno) + "</strong>" +
            (mio.punto ? '<span class="fila-punto">' + escapeHtml(mio.punto) + "</span>" : "") +
            "<span>Llegó " + escapeHtml(haceCuanto(mio.llegada_aeropuerto) || horaCorta(mio.llegada_aeropuerto)) +
              (mio.itinerario ? " · " + escapeHtml(mio.itinerario) : "") + "</span>" +
          "</div>" +
        "</div>";
    } catch (err) {
      pintarErrorTarjeta(box, "No se pudo cargar la fila.", err, cargarFila);
    }
  }

  // ------------------------------------------------------ documentos del bus
  // Los papeles que el conductor debe llevar en el bus del turno (los que
  // pide un retén), con su vencimiento, y el estado de su licencia. Salen de
  // las mismas tablas del Portal de Documentos por ruta.
  //
  // Del bus se puede abrir el archivo; de la licencia solo se muestra el
  // estado: la cédula se escribe a mano y no se verifica, así que no se
  // entrega el documento de una persona a quien escriba su número.
  var DOC_TIPOS = [
    { tipo: "SOAT", nombre: "SOAT" },
    { tipo: "TECNOMECANICA", nombre: "Revisión técnico-mecánica" },
    { tipo: "TARJETA_OPERACION", nombre: "Tarjeta de operación" },
    // En la base se llama LICENCIA_TRANSITO, pero es la Tarjeta de Propiedad:
    // no vence (migración 20261005140000_tarjeta_propiedad_sin_vencimiento).
    { tipo: "LICENCIA_TRANSITO", nombre: "Tarjeta de propiedad", sinVencimiento: true },
    { tipo: "CERTIFICACION_AMPARO", nombre: "Certificación de amparo" },
    // El mantenimiento preventivo no va: no es un documento del bus y no
    // debe contar como vencido.
  ];

  var docs = { clave: null, cargadoEn: 0, cargandoClave: null };

  function diasHasta(fecha) {
    if (!fecha) return null;
    var ms = Date.parse(String(fecha).slice(0, 10) + "T00:00:00Z") - Date.parse(hoyColombia() + "T00:00:00Z");
    return isNaN(ms) ? null : Math.round(ms / DIA_MS);
  }

  function fechaCorta(fecha) {
    var p = String(fecha || "").slice(0, 10).split("-");
    return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : "";
  }

  // nivel: ok | pronto | vencido | falta. El texto dice lo que el conductor
  // necesita saber sin hacer cuentas: "Vence en 5 días", "Venció hace 2 días".
  function estadoDocumento(cfgTipo, fila) {
    if (!fila) return { nivel: "falta", etiqueta: "Sin cargar", detalle: "No está en el sistema" };
    if (cfgTipo.sinVencimiento) {
      return fila.storage_path
        ? { nivel: "ok", etiqueta: "Cargada", detalle: "No vence" }
        : { nivel: "falta", etiqueta: "Sin archivo", detalle: "Registrada sin archivo" };
    }
    var dias = diasHasta(fila.fecha_vencimiento);
    if (dias == null) return { nivel: "falta", etiqueta: "Sin fecha", detalle: "Falta la fecha de vencimiento" };

    var umbral = cfg.DOCUMENTOS_POR_VENCER_DIAS || 30;
    var detalle;
    if (dias < 0) {
      detalle = "Venció hace " + (-dias) + (dias === -1 ? " día" : " días");
      return { nivel: "vencido", etiqueta: "Vencido", detalle: detalle };
    }
    if (dias === 0) detalle = "Vence hoy";
    else if (dias === 1) detalle = "Vence mañana";
    else if (dias <= umbral) detalle = "Vence en " + dias + " días";
    else detalle = "Vence el " + fechaCorta(fila.fecha_vencimiento);
    return { nivel: dias <= umbral ? "pronto" : "ok", etiqueta: dias <= umbral ? "Por vencer" : "Vigente", detalle: detalle };
  }

  // El interno no es único en flota_vehiculos (192, 708, 709 y 757 se
  // repiten entre vehículos retirados y activos): manda el que sigue
  // vinculado y operando.
  async function consultarVehiculoFlota(interno) {
    var res = await conTiempoLimite(
      client
        .from(cfg.TABLA_FLOTA_VEHICULOS)
        .select("placa,interno,nombre_ruta,vinculado,operante")
        .in("interno", variantesInterno(interno))
    );
    if (res.error) throw res.error;
    var puntaje = function (v) { return (v.vinculado === false ? 0 : 2) + (v.operante === false ? 0 : 1); };
    var filas = (res.data || []).slice().sort(function (a, b) { return puntaje(b) - puntaje(a); });
    return filas[0] || null;
  }

  async function consultarDocumentos(interno, dni) {
    var vehiculo = interno ? await consultarVehiculoFlota(interno) : null;
    var consultas = [
      vehiculo
        ? conTiempoLimite(
            client
              .from(cfg.VISTA_FLOTA_DOCUMENTOS)
              .select("tipo,fecha_vencimiento,storage_path")
              .eq("placa", vehiculo.placa)
          )
        : Promise.resolve({ data: [] }),
      dni
        ? conTiempoLimite(client.from(cfg.VISTA_CONDUCTOR_DOCUMENTOS).select("*").eq("cedula", dni))
        : Promise.resolve({ data: [] }),
    ];
    var res = await Promise.all(consultas);
    if (res[0].error) throw res[0].error;

    var porTipo = {};
    (res[0].data || []).forEach(function (f) { porTipo[f.tipo] = f; });

    // Enlaces para abrir cada archivo, todos en una sola llamada. Se piden de
    // una vez para poder ponerlos como enlaces normales: abrir una pestaña
    // después de esperar al servidor lo bloquea Safari en el iPhone.
    var rutas = Object.keys(porTipo)
      .map(function (t) { return porTipo[t].storage_path; })
      .filter(Boolean);
    var enlaces = {};
    if (rutas.length) {
      try {
        var firmas = await conTiempoLimite(
          client.storage.from(cfg.BUCKET_FLOTA_DOCUMENTOS).createSignedUrls(rutas, cfg.DOCUMENTOS_ENLACE_S || 3600)
        );
        (firmas.data || []).forEach(function (f) {
          if (f && f.signedUrl && !f.error) enlaces[f.path] = f.signedUrl;
        });
      } catch (_) { /* sin enlaces se ven igual el estado y la fecha */ }
    }

    // Licencia: si la consulta falla, la tarjeta del bus sigue sirviendo.
    var licencia = null;
    if (!res[1].error) {
      licencia = (res[1].data || []).find(function (f) { return f.tipo === "LICENCIA_CONDUCCION"; }) || null;
    }

    return { vehiculo: vehiculo, porTipo: porTipo, enlaces: enlaces, licencia: licencia, licenciaConsultada: !!dni && !res[1].error };
  }

  function cargarDocumentos(forzar) {
    var box = $("documentosBody");
    var interno = state.vehiculo ? String(state.vehiculo).trim() : "";
    var dni = state.dni || "";
    $("documentosTitulo").textContent = interno ? "Documentos del bus " + interno : "Documentos del bus";

    if (!interno && !dni) {
      docs.clave = null;
      notif.docs = [];
      pintarNotificaciones();
      box.innerHTML = '<p class="placeholder">Cuando tengas vehículo asignado verás aquí si sus papeles están al día.</p>';
      return;
    }

    var clave = normalizarInterno(interno) + "_" + dni;
    var reciente = docs.clave === clave && Date.now() - docs.cargadoEn < (cfg.DOCUMENTOS_REFRESCO_MS || 900000);
    if (reciente && !forzar) return;
    if (docs.cargandoClave === clave) return;

    var cache = leerCache("documentos_" + clave);
    if (docs.clave !== clave) {
      if (cache && cache.datos) pintarDocumentos(cache.datos, cache.guardadoEn);
      else {
        esqueleto(box, "lineas");
        notif.docs = [];   // otro bus u otro conductor: las de antes ya no son suyas
        pintarNotificaciones();
      }
    }
    docs.clave = clave;

    if (!navigator.onLine) {
      if (!cache) box.innerHTML = '<p class="placeholder">Necesitas conexión para ver los documentos del bus.</p>';
      return;
    }

    docs.cargandoClave = clave;
    consultarDocumentos(interno, dni)
      .then(function (datos) {
        if (docs.clave !== clave) return; // cambió el bus o el conductor mientras tanto
        docs.cargadoEn = Date.now();
        // Al teléfono va solo el estado: los enlaces vencen en una hora.
        guardarCache("documentos_" + clave, Object.assign({}, datos, { enlaces: {} }));
        pintarDocumentos(datos, null);
      })
      .catch(function (err) {
        if (docs.clave !== clave) return;
        if (cache && cache.datos) pintarDocumentos(cache.datos, cache.guardadoEn);
        else pintarErrorTarjeta(box, "No se pudieron consultar los documentos.", err, function () { cargarDocumentos(true); });
      })
      .then(function () {
        if (docs.cargandoClave === clave) docs.cargandoClave = null;
      });
  }

  function pintarDocumentos(datos, guardadoEn) {
    var box = $("documentosBody");
    var interno = state.vehiculo ? String(state.vehiculo).trim() : "";
    var html = "";

    if (interno && !datos.vehiculo) {
      html += '<p class="placeholder">El bus ' + escapeHtml(interno) +
        " no aparece en el registro de documentos. Avísale a tu coordinador.</p>";
    } else if (datos.vehiculo) {
      var filas = DOC_TIPOS.map(function (t) {
        return { cfg: t, fila: datos.porTipo[t.tipo] || null, estado: estadoDocumento(t, datos.porTipo[t.tipo]) };
      });
      var vencidos = filas.filter(function (f) { return f.estado.nivel === "vencido"; }).length;
      var pronto = filas.filter(function (f) { return f.estado.nivel === "pronto"; }).length;
      var faltan = filas.filter(function (f) { return f.estado.nivel === "falta"; }).length;

      var resumen, nivelResumen;
      if (vencidos) {
        nivelResumen = "vencido";
        resumen = (vencidos === 1 ? "1 documento vencido" : vencidos + " documentos vencidos") +
          ". Avísale a tu coordinador antes de salir.";
      } else if (pronto) {
        nivelResumen = "pronto";
        resumen = (pronto === 1 ? "1 documento vence" : pronto + " documentos vencen") + " pronto.";
      } else if (faltan) {
        nivelResumen = "falta";
        resumen = "Al día, pero " + (faltan === 1 ? "falta cargar 1 documento" : "faltan cargar " + faltan + " documentos") + ".";
      } else {
        nivelResumen = "ok";
        resumen = "Todos los documentos al día.";
      }

      html += '<p class="docs-resumen" data-nivel="' + nivelResumen + '">' + escapeHtml(resumen) +
        ' <span class="docs-placa">Placa ' + escapeHtml(datos.vehiculo.placa) + "</span></p>";

      html += '<ul class="docs-lista">' + filas.map(function (f) {
        var url = f.fila && f.fila.storage_path ? (datos.enlaces || {})[f.fila.storage_path] : null;
        return '<li class="doc">' +
          '<div class="doc-info">' +
            '<span class="doc-nombre">' + escapeHtml(f.cfg.nombre) + "</span>" +
            '<span class="doc-detalle">' + escapeHtml(f.estado.detalle) + "</span>" +
          "</div>" +
          '<span class="doc-estado" data-nivel="' + f.estado.nivel + '">' + escapeHtml(f.estado.etiqueta) + "</span>" +
          (url
            ? '<a class="btn btn-ghost btn-sm doc-ver" href="' + escapeHtml(url) + '" target="_blank" rel="noopener">Ver</a>'
            : "") +
        "</li>";
      }).join("") + "</ul>";
    }

    if (datos.licenciaConsultada || datos.licencia) {
      var est = estadoDocumento({ nombre: "Licencia" }, datos.licencia);
      var detalleLic = datos.licencia
        ? est.detalle + (datos.licencia.categoria_licencia ? " · Categoría " + datos.licencia.categoria_licencia : "")
        : "No está en el sistema. Llévala a tu coordinador.";
      html += '<div class="doc doc-licencia">' +
        '<div class="doc-info">' +
          '<span class="doc-nombre">Mi licencia de conducción</span>' +
          '<span class="doc-detalle">' + escapeHtml(detalleLic) + "</span>" +
        "</div>" +
        '<span class="doc-estado" data-nivel="' + est.nivel + '">' + escapeHtml(est.etiqueta) + "</span>" +
      "</div>";
    }

    if (guardadoEn) {
      html += '<p class="viajes-aviso">Sin conexión: es la consulta guardada a las ' +
        escapeHtml(horaDeMs(guardadoEn)) + ".</p>";
    }

    box.innerHTML = html || '<p class="placeholder">Sin documentos para mostrar.</p>';

    // v1.19.0: los vencidos o por vencer también van como notificación (campana y aviso del Inicio).
    notif.docs = alertasDeDocumentos(datos);
    pintarNotificaciones();
  }

  // ---------------------------------------------------------- ALISTAMIENTO
  // v1.23.0: la revisión diaria del bus que va a la Supertransporte (la app de alistamiento del SICOV, ahora también
  // en la pestaña Alistamiento). Es una por bus y por día calendario: la hace el primero que lo maneja y el del turno 2
  // solo ve que ya está. Si falta, el Inicio lo dice en rojo y la pestaña lleva un punto rojo; no bloquea nada (lo
  // decidió el usuario el 22-oct-2026). Se pregunta a la misma función pública del formulario: /formulario (las
  // placas de cada bus, una vez por sesión) y /hoy?placa= (si ya está). Hecho no se vuelve a preguntar ese día;
  // pendiente, cada 5 minutos como mucho, al volver al Inicio.
  var alist = { placas: null, promesa: null, bus: null, dia: null, estado: null, consultadoEn: 0, pidiendo: null };
  var ALISTAMIENTO_REPETIR_MS = 5 * 60 * 1000;

  function urlSicov(ruta) { return cfg.SUPABASE_URL + "/functions/v1/sicov-alistar/" + ruta; }

  function pedirSicov(ruta) {
    return conTiempoLimite(fetch(urlSicov(ruta), { cache: "no-store" }), 15000).then(function (r) {
      if (!r.ok) throw new Error("El alistamiento respondió " + r.status);
      return r.json();
    });
  }

  function placasSicov() {
    if (alist.placas) return Promise.resolve(alist.placas);
    if (!alist.promesa) {
      alist.promesa = pedirSicov("formulario").then(function (d) {
        alist.placas = (d && d.vehiculos) || [];
        return alist.placas;
      }).finally(function () { alist.promesa = null; });
    }
    return alist.promesa;
  }

  function busSinCeros(v) { return String(v == null ? "" : v).trim().replace(/^0+/, ""); }

  async function cargarAlistamiento(forzar) {
    var bus = busSinCeros(state.vehiculo);
    var dia = hoyColombia();
    if (!bus) {
      alist.bus = null;
      alist.estado = null;
      pintarAlistamiento();
      return;
    }
    var mismo = alist.bus === bus && alist.dia === dia && alist.estado && !alist.estado.error;
    if (mismo && !forzar && (alist.estado.hecho || alist.estado.fuera ||
        Date.now() - alist.consultadoEn < ALISTAMIENTO_REPETIR_MS)) {
      pintarAlistamiento();
      return;
    }
    if (alist.pidiendo === bus + dia && !forzar) return;
    if (!mismo) { alist.estado = null; pintarAlistamiento(); }
    var pedido = alist.pidiendo = bus + dia;
    try {
      var suyas = (await placasSicov()).filter(function (v) { return busSinCeros(v.interno) === bus; });
      var estado;
      if (!suyas.length) {
        estado = { fuera: true };       // su bus no es de la ruta del SICOV: no se muestra nada
      } else {
        var resp = await Promise.all(suyas.map(function (v) {
          return pedirSicov("hoy?placa=" + encodeURIComponent(v.placa)).then(function (d) {
            return d && d.yaRegistrado ? Object.assign({ placa: v.placa }, d.registro || {}) : false;
          }).catch(function () { return null; });
        }));
        var ya = resp.find(Boolean);
        if (!ya && resp.indexOf(null) >= 0) throw new Error("No se pudo consultar el alistamiento");
        estado = ya ? { hecho: true, placa: ya.placa, hora: ya.registrado_en, quien: ya.conductor }
          : { hecho: false, placas: suyas.map(function (v) { return v.placa; }) };
      }
      if (alist.pidiendo !== pedido) return;
      alist.bus = bus;
      alist.dia = dia;
      alist.estado = estado;
      alist.consultadoEn = Date.now();
    } catch (err) {
      if (alist.pidiendo !== pedido) return;
      alist.bus = bus;
      alist.dia = dia;
      alist.estado = { error: err };
    } finally {
      if (alist.pidiendo === pedido) alist.pidiendo = null;
    }
    if (busSinCeros(state.vehiculo) === bus) pintarAlistamiento();
  }

  function pintarAlistamiento() {
    var card = $("cardAlistamiento");
    var box = $("alistamientoBody");
    var e = alist.bus && alist.bus === busSinCeros(state.vehiculo) ? alist.estado : null;
    var pendiente = !!(e && e.hecho === false);
    show($("navPuntoAlistamiento"), pendiente);
    if (!card || !box) return;
    card.removeAttribute("data-tono");
    if (!busSinCeros(state.vehiculo) || (e && e.fuera)) { card.hidden = true; return; }
    card.hidden = false;
    if (!e) {
      box.innerHTML = '<div class="skeleton skeleton-linea"></div>';
      return;
    }
    if (e.error) {
      box.innerHTML = '<p class="placeholder">No se pudo saber si el bus ' + escapeHtml(alist.bus) +
        ' ya tiene el alistamiento de hoy.</p><button class="btn btn-ghost btn-sm alist-btn" type="button" data-alist-reintentar>Reintentar</button>';
      box.querySelector("[data-alist-reintentar]").addEventListener("click", function () { cargarAlistamiento(true); });
      return;
    }
    if (e.hecho) {
      card.setAttribute("data-tono", "bien");
      box.innerHTML = '<p class="alist-estado"><span class="alist-icono" aria-hidden="true">✓</span>Hecho hoy' +
        (e.hora ? " a las " + escapeHtml(horaDeMs(Date.parse(e.hora))) : "") + "</p>" +
        '<p class="alist-detalle">Bus ' + escapeHtml(alist.bus) + " · placa " + escapeHtml(e.placa) +
        (e.quien ? " · lo registró " + escapeHtml(capitalizarPalabras(e.quien)) : "") + "</p>";
      return;
    }
    card.setAttribute("data-tono", "falta");
    box.innerHTML = '<p class="alist-estado"><span class="alist-icono" aria-hidden="true">!</span>Falta el alistamiento del bus ' +
      escapeHtml(alist.bus) + "</p>" +
      '<p class="alist-detalle">Hágalo antes de salir: dos preguntas y la revisión del bus. Es uno por bus y por día.</p>' +
      '<button class="btn btn-primary btn-block alist-btn" type="button" data-alist-ir>Hacer el alistamiento</button>';
    box.querySelector("[data-alist-ir]").addEventListener("click", function () { irA("alistamiento"); });
  }

  // ---------------------------------------------------------------- PERFIL
  function pintarPerfil() {
    $("perfilNombre").textContent =
      (state.conductor && state.conductor.nombre) ||
      (state.turno && state.turno.nombre_programacion) || "Sin identificar";
    $("perfilDni").textContent = state.dni || "—";
    $("perfilVehiculo").textContent = state.vehiculo || "—";
    $("perfilTurno").textContent = state.turno
      ? "Turno " + state.turno.turno + " · " + horaCorta(state.turno.hora_entrada) +
        " – " + horaCorta(state.turno.hora_salida)
      : "—";
    $("perfilBase").textContent =
      (state.turno && state.turno.base) ||
      (state.conductor && (state.conductor.fleet || state.conductor.base)) || "—";
    $("perfilEmail").textContent = (state.user && state.user.email) || "—";
    $("perfilUbicacion").textContent = textoUbicacionPerfil();
  }

  function abrirPerfil() {
    pintarPerfil();
    // El resultado de una búsqueda anterior ya no vale, salvo si sigue descargando.
    if (!actualizacion.pedidaPorConductor) decirEnPerfil("");
    show($("perfilSheet"), true);
  }

  function initPerfil() {
    $("perfilSheetClose").addEventListener("click", function () {
      show($("perfilSheet"), false);
    });
    $("perfilSheet").addEventListener("click", function (ev) {
      if (ev.target === $("perfilSheet")) show($("perfilSheet"), false);
    });

    $("btnCambiarSeleccion").addEventListener("click", cambiarSeleccion);

    $("btnLogoutSheet").addEventListener("click", function () {
      show($("perfilSheet"), false);
      logout();
    });
  }

  // ============================================================ PERSONAL DE LA EMPRESA
  // Cuando se sube alguien de la empresa (gestora, auxiliar, mecánico, un
  // conductor que va de pasajero...), el conductor toca "Registrar personal de
  // la empresa" y su celular muestra un código QR que cambia cada 15 segundos:
  //     CBP1.<bus>.<cédula del conductor>.<hora ms>.<al azar>
  // La persona lo lee con la app del personal (gestores/), se toma una selfie y
  // queda en el viaje: suma en los pasajeros (el sensor la contó) pero su pasaje
  // no se cobra (sql/personal_empresa.sql, la v10). El código sale también sin
  // internet: el registro lo manda el celular de la persona.
  var PERSONAL_CODIGO_MS = 15 * 1000;      // cada código dura esto en pantalla
  var PERSONAL_LISTA_MS = 5 * 1000;        // con el código a la vista, la lista se pide así de seguido
  var personalQr = { reloj: null, lista: null, fin: 0 };
  var scriptsCargados = {};

  // La librería del QR se carga solo cuando hace falta. El service worker la
  // tiene guardada, así que también sirve sin internet.
  function cargarScript(src) {
    if (!scriptsCargados[src]) {
      scriptsCargados[src] = new Promise(function (resolver, rechazar) {
        var s = document.createElement("script");
        s.src = src;
        s.onload = resolver;
        s.onerror = function () {
          delete scriptsCargados[src];
          rechazar(new Error("No se pudo cargar " + src));
        };
        document.head.appendChild(s);
      });
    }
    return scriptsCargados[src];
  }

  function alAzar(n) {
    var b = crypto.getRandomValues(new Uint8Array(n));
    var s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function busDelCodigo() {
    return String(state.vehiculo || "").trim().replace(/[^A-Za-z0-9-]/g, "").slice(0, 20);
  }

  function codigoDelBus() {
    return ["CBP1", busDelCodigo(), String(state.dni || "").replace(/\D/g, "").slice(0, 15),
            String(Date.now()), alAzar(9)].join(".");
  }

  async function abrirPersonal() {
    show($("personalSheet"), true);
    $("personalLista").innerHTML = "";
    var bus = busDelCodigo();
    if (!bus) {
      $("personalQr").innerHTML = '<p class="qr-vencido">Primero confirme su bus en el inicio: el código va con el número del bus.</p>';
      $("personalBus").textContent = "";
      $("personalQueda").textContent = "";
      return;
    }
    $("personalBus").textContent = "Bus " + bus;
    try {
      await cargarScript("./js/vendor/qrcode.min.js");
    } catch (_) {
      $("personalQr").innerHTML = '<p class="qr-vencido">No se pudo preparar el código. Revise la conexión y vuelva a abrirlo.</p>';
      return;
    }
    if ($("personalSheet").hidden) return;
    pintarCodigoPersonal();
    clearInterval(personalQr.reloj);
    personalQr.reloj = setInterval(contarCodigoPersonal, 1000);
    cargarListaPersonal();
    clearInterval(personalQr.lista);
    personalQr.lista = setInterval(cargarListaPersonal, PERSONAL_LISTA_MS);
  }

  function pintarCodigoPersonal() {
    var q = window.qrcode(0, "M");
    q.addData(codigoDelBus());
    q.make();
    $("personalQr").innerHTML = q.createImgTag(6, 12, "Código del bus para el personal de la empresa");
    personalQr.fin = Date.now() + PERSONAL_CODIGO_MS;
    contarCodigoPersonal();
  }

  function contarCodigoPersonal() {
    var queda = personalQr.fin - Date.now();
    if (queda <= 0) { pintarCodigoPersonal(); return; }
    $("personalBarra").style.width = (100 * queda / PERSONAL_CODIGO_MS) + "%";
    $("personalQueda").textContent = "El código cambia solo en " + Math.ceil(queda / 1000) + " s.";
  }

  function cerrarPersonal() {
    clearInterval(personalQr.reloj);
    clearInterval(personalQr.lista);
    personalQr.reloj = personalQr.lista = null;
    $("personalQr").innerHTML = "";
    show($("personalSheet"), false);
  }

  // Quiénes se registraron en este bus en las últimas horas (lo mandó el
  // celular de cada persona): sin cédula ni selfie.
  async function consultarPersonalDelBus() {
    var bus = busDelCodigo();
    if (!bus || !state.user || !navigator.onLine) return null;
    var res = await conTiempoLimite(client.rpc(cfg.RPC_PERSONAL_DEL_BUS, { p_interno: bus, p_horas: 4 }), 10000);
    if (res.error) throw res.error;
    return res.data || [];
  }

  async function cargarListaPersonal() {
    var ul = $("personalLista");
    var lista;
    try {
      lista = await consultarPersonalDelBus();
    } catch (_) {
      lista = null;
    }
    if ($("personalSheet").hidden) return;
    if (lista == null) {
      ul.innerHTML = '<li class="personal-nadie">Sin internet: el código sí sirve. La lista se ve cuando vuelva la señal.</li>';
      return;
    }
    ul.innerHTML = lista.length
      ? lista.map(function (p) {
          return '<li><span class="personal-check" aria-hidden="true">✓</span><span><b>' + escapeHtml(p.nombre) +
            "</b> · " + escapeHtml(capitalizarPalabras(p.cargo || "")) + "</span><span>" +
            escapeHtml(horaDeMs(Date.parse(p.leido_en))) + "</span></li>";
        }).join("")
      : '<li class="personal-nadie">Todavía nadie en las últimas 4 horas.</li>';
  }

  // En la pantalla de "Sin conexión": el código del bus sí sale sin internet.
  function pintarBotonesSinInternet() {
    var enApp = !!state.user && !!state.dni && !$("appView").hidden;
    show($("btnSinInternetPersonal"), enApp);
    show($("btnSinInternetNovedad"), enApp);
  }

  function initPersonal() {
    $("btnSinInternetPersonal").addEventListener("click", abrirPersonal);
    $("personalCerrar").addEventListener("click", cerrarPersonal);
    $("personalListo").addEventListener("click", cerrarPersonal);
  }

  // ============================================================ NOVEDADES
  // El conductor reporta una novedad: trasbordo, bus varado o daño, accidente
  // o incidente, u otra. Cada una recibe su número (N° 1001...) y puede llevar
  // un video corto: máximo 1 minuto en calidad media (unos 4 a 5 MB), que se
  // guarda 90 días (sql/novedades.sql, la v11).
  //   - Trasbordo: lo reporta el bus que RECIBE ("recibí 15 del 722"). En la
  //     movilidad de su bus esos pasajeros van a Ajustes. Cuenta de una vez; un
  //     despachador lo puede anular en Control.
  //   - Varado, accidente y otra solo quedan registrados, con su video.
  // Sirve también sin señal: la novedad y el video quedan en el celular
  // (IndexedDB) y se mandan solos cuando vuelve internet. El número lo pone el
  // servidor: mientras tanto sale "Por enviar".
  var NOV_TIPOS = {
    trasbordo: "Trasbordo",
    varado: "Bus varado o daño",
    accidente: "Accidente o incidente",
    otra: "Otra novedad",
  };
  var NOV_MAX_S = cfg.NOVEDAD_VIDEO_MAX_S || 60;
  var NOV_MAX_BYTES = cfg.NOVEDAD_VIDEO_MAX_BYTES || 20 * 1024 * 1024;
  // Un video elegido de la galería más pesado que esto se vuelve a grabar en calidad media.
  var NOV_DIRECTO_BYTES = cfg.NOVEDAD_VIDEO_DIRECTO_BYTES || 8 * 1024 * 1024;
  // Los dos botones de cada viaje de la tarjeta
  var ICONO_QR = '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>';
  var ICONO_NOVEDAD = '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M15 10l4.55-2.28A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.9L15 14"/><rect x="3" y="6" width="12" height="12" rx="2"/></svg>';
  // enviando: el botón está mandando; ocupada: la novedad que la hoja está subiendo (la cola no la toca);
  // clave: el viaje de la tarjeta desde donde se abrió (sin él, la base la pega al viaje de esa hora)
  var nov = { video: null, sinVideo: false, enviando: false, ocupada: null, preparando: false, cola: null, grab: null, clave: null };
  var novDb = null;

  function noHacerNada() {}

  // ---- la cola en el celular (IndexedDB: guarda también el video)
  function abrirNovDb() {
    if (!novDb) {
      novDb = new Promise(function (resolver, rechazar) {
        if (!window.indexedDB) { rechazar(new Error("Este navegador no guarda novedades sin señal")); return; }
        var pedido = indexedDB.open("portal_novedades", 1);
        pedido.onupgradeneeded = function () { pedido.result.createObjectStore("cola", { keyPath: "id_local" }); };
        pedido.onsuccess = function () { resolver(pedido.result); };
        pedido.onerror = function () { rechazar(pedido.error || new Error("No se pudo abrir la cola")); };
      });
      novDb.catch(function () { novDb = null; });
    }
    return novDb;
  }

  function novTx(modo, hacer) {
    return abrirNovDb().then(function (db) {
      return new Promise(function (resolver, rechazar) {
        var tx = db.transaction("cola", modo);
        var pedido = hacer(tx.objectStore("cola"));
        tx.oncomplete = function () { resolver(pedido ? pedido.result : undefined); };
        tx.onerror = tx.onabort = function () { rechazar(tx.error || new Error("No se pudo guardar en el celular")); };
      });
    });
  }

  function novGuardar(it) { return novTx("readwrite", function (s) { return s.put(it); }); }
  function novBorrar(id) { return novTx("readwrite", function (s) { return s.delete(id); }); }
  function novTodas() {
    return novTx("readonly", function (s) { return s.getAll(); }).then(function (l) {
      return (l || []).sort(function (a, b) { return a.creado_ms - b.creado_ms; });
    });
  }

  // ---- mandarlas
  // Un "no" del servidor (la regla no la deja pasar) no se arregla
  // reintentando; una falla de red sí.
  function esRechazo(err) {
    return !!(err && /^(P0001|23514|22P02|22003)$/.test(String(err.code || "")));
  }

  function mensajeDeError(err) {
    return String((err && err.message) || err || "Error").replace(/^Error:\s*/, "").slice(0, 200);
  }

  function rutaDelVideo(it) {
    return fechaColombiaDe(it.creado_ms).slice(0, 7) + "/" + it.numero + "-" + it.id_local + "." + it.video_ext;
  }

  async function pedirNumero(it) {
    if (it.numero) return;
    var r = await conTiempoLimite(client.rpc(cfg.RPC_NOVEDAD_REPORTAR,
      Object.assign({ p_id_local: it.id_local }, it.datos)), 15000);
    if (r.error) throw r.error;
    if (!r.data || !r.data.numero) throw new Error("El servidor no devolvió el número");
    it.numero = r.data.numero;
    // la mandada sin viaje ("Sin conexión"): la base dice a cuál la pegó y ahí sale de una vez
    if (r.data.clave_viaje) it.clave_viaje = r.data.clave_viaje;
    await novGuardar(it).catch(noHacerNada);
  }

  // Sube el video (si tiene) y la da por terminada: sale de la cola.
  async function subirVideoYTerminar(it) {
    if (it.video && !it.video_ruta && !it.video_fallo) {
      var blob = it.video instanceof Blob ? it.video : new Blob([it.video], { type: it.video_tipo });
      var ruta = rutaDelVideo(it);
      var sub = await conTiempoLimite(client.storage.from(cfg.BUCKET_NOVEDADES).upload(ruta, blob, {
        contentType: it.video_tipo, upsert: false, cacheControl: "3600",
      }), 180000);
      var e = sub.error;
      var codigo = e ? String(e.statusCode || e.status || "") : "";
      var yaEstaba = e && (codigo === "409" || /already exists|duplicate/i.test(e.message || ""));
      if (e && !yaEstaba) {
        // Muy pesado, de un tipo que no sirve o de una novedad vieja: la novedad queda, sin video.
        if (/^(400|403|413|415)$/.test(codigo) || /too large|maximum|mime|row-level security/i.test(e.message || "")) {
          it.video_fallo = mensajeDeError(e);
        } else {
          throw e;
        }
      } else {
        var l = await conTiempoLimite(client.rpc(cfg.RPC_NOVEDAD_VIDEO_LISTO, {
          p_numero: it.numero, p_id_local: it.id_local, p_ruta: ruta, p_bytes: blob.size,
          p_segundos: it.video_segundos,
        }), 15000);
        if (l.error) {
          if (!esRechazo(l.error)) throw l.error;
          it.video_fallo = mensajeDeError(l.error);
        } else {
          it.video_ruta = ruta;
        }
      }
    }
    await novBorrar(it.id_local).catch(noHacerNada);
  }

  function enviarNovedadesPendientes() {
    if (nov.cola) return nov.cola;
    nov.cola = (async function () {
      var lista;
      try { lista = await novTodas(); } catch (_) { return; }
      for (var i = 0; i < lista.length; i++) {
        var it = lista[i];
        if (it.error || it.id_local === nov.ocupada) continue;
        if (!state.user || !internet.ok) break;
        try {
          await pedirNumero(it);
          pintarNovedadesMias();
          await subirVideoYTerminar(it);
        } catch (err) {
          if (!esRechazo(err)) break;          // sin señal o el servidor no responde: después
          it.error = mensajeDeError(err);
          await novGuardar(it).catch(noHacerNada);
        }
      }
    })().then(function () {
      nov.cola = null;
      actualizarNovedadesMias();
    }, function () {
      nov.cola = null;
    });
    return nov.cola;
  }

  // ---- las novedades en la tarjeta: cada una en su viaje
  // Después de mandar: la tarjeta vuelve a traer sus novedades (con el número y si tienen video).
  function actualizarNovedadesMias() {
    pintarNovedadesMias();
    if (state.user && !$("appView").hidden && state.vista === "tarjeta") cargarTarjeta();
  }

  // Las que siguen en el celular (por enviar o subiendo el video), de este conductor.
  async function pintarNovedadesMias() {
    var dni = normalizarDni(state.dni);
    var lista = [];
    try { lista = await novTodas(); } catch (_) { lista = []; }
    tarj.novPendientes = lista.filter(function (it) { return normalizarDni(it.datos.p_dni) === dni; });
    if (tarj.filas && state.vista === "tarjeta" && !$("appView").hidden) pintarTarjeta();
  }

  // Todas las de la tarjeta en el mismo formato: las del servidor y, encima, las que siguen en el celular.
  function novedadesDeTarjeta() {
    var porId = {};
    var lista = [];
    (tarj.novPendientes || []).forEach(function (it) {
      porId[it.id_local] = true;
      lista.push({ id: it.id_local, numero: it.numero, tipo: it.datos.p_tipo, origen: it.datos.p_interno_origen,
        cantidad: it.datos.p_cantidad, ms: it.creado_ms, video: !!it.video, error: it.error, clave: it.clave_viaje || it.datos.p_clave_viaje || null,
        estado: it.error ? "error" : !it.numero ? "pendiente" : "subiendo" });
    });
    (tarj.novedades || []).forEach(function (s) {
      if (porId[s.id_local]) return;
      lista.push({ numero: s.numero, tipo: s.tipo, origen: s.interno_origen, cantidad: s.cantidad, ms: Date.parse(s.ocurrio_en),
        video: !!s.video_ruta, motivo: s.anulado_motivo, clave: s.clave_viaje, estado: s.anulado_en ? "anulada" : "ok" });
    });
    return lista.sort(function (a, b) { return a.ms - b.ms; });
  }

  function novedadesDeViaje(clave) {
    return novedadesDeTarjeta().filter(function (x) { return x.clave === clave; });
  }

  // Las que no tienen viaje: las reportó desde "Sin conexión" (todavía no se sabe a cuál va) o a una hora sin viaje.
  function novedadesSinViaje(filas) {
    var claves = {};
    filas.forEach(function (f) { claves[f.clave] = true; });
    return novedadesDeTarjeta().filter(function (x) { return !x.clave || !claves[x.clave]; });
  }

  function filaNovedad(f) {
    var detalle = f.tipo === "trasbordo" ? " · " + f.cantidad + " del " + f.origen : "";
    var estado = f.estado === "pendiente" ? "Por enviar: se manda sola cuando haya señal"
      : f.estado === "subiendo" ? (f.video ? "Subiendo el video…" : "Enviando…")
      : f.estado === "error" ? "No se pudo: " + f.error
      : f.estado === "anulada" ? "Anulada por control" + (f.motivo ? ": " + f.motivo : "")
      : f.video ? "Con video" : "Sin video";
    return '<li data-estado="' + f.estado + '"><span class="nov-num">' + (f.numero ? "N° " + f.numero : "—") +
      '</span><span class="nov-que"><b>' + escapeHtml(NOV_TIPOS[f.tipo] || f.tipo) + "</b>" + escapeHtml(detalle) +
      " · " + escapeHtml(horaDeMs(f.ms)) + "<small>" + escapeHtml(estado) + "</small></span>" +
      (f.estado === "error" ? '<button class="btn btn-ghost btn-sm" type="button" data-nov-quitar="' +
        escapeHtml(f.id) + '">Quitar</button>' : "") + "</li>";
  }

  // ---- la hoja
  function errorNovedad(texto) {
    $("novedadError").textContent = texto || "";
    show($("novedadError"), !!texto);
  }

  function tipoNovedad() {
    var r = document.querySelector('input[name="novedadTipo"]:checked');
    return r ? r.value : "";
  }

  function pintarTipoNovedad() {
    var t = tipoNovedad();
    show($("novedadTrasbordo"), t === "trasbordo");
    $("novedadBusRecibe").textContent = busDelCodigo() || "suyo";
    $("novedadNotaTitulo").textContent = t === "otra" ? "Cuente qué pasó" : "Cuente qué pasó (si quiere)";
  }

  function abrirNovedad(clave) {
    var bus = busDelCodigo();
    nov.clave = typeof clave === "string" && clave ? clave : null;
    var viaje = nov.clave ? (tarj.filas || []).find(function (x) { return x.clave === nov.clave; }) : null;
    $("novedadForm").reset();
    ponerVideoNovedad(null);
    nov.sinVideo = false;
    show($("novedadForm"), true);
    show($("novedadResultado"), false);
    pintarTipoNovedad();
    var nombre = nombreConductor();
    $("novedadBus").textContent = bus ? "Bus " + bus + (viaje ? " · " + nombreViaje(viaje).replace(/^v/, "V") + ", salió " + horaViaje(viaje)
      : " · va al viaje de esta hora") : "";
    $("novedadConductor").textContent = nombre ? capitalizarPalabras(nombre) : "";
    errorNovedad(bus ? "" : "Primero confirme su bus en el inicio: la novedad va con el número del bus.");
    $("novedadEnviar").disabled = !bus;
    show($("novedadSheet"), true);
  }

  function cerrarNovedad() {
    if (nov.enviando || nov.preparando) return;
    cerrarGrabador();
    show($("novedadSheet"), false);
    ponerVideoNovedad(null);
    pintarNovedadesMias();
  }

  function megas(b) { return (b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0).replace(".", ",") + " MB"; }
  function segundosTexto(s) { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ":" + dos(s % 60); }

  function ponerVideoNovedad(v) {
    if (nov.video && nov.video.url) URL.revokeObjectURL(nov.video.url);
    nov.video = v || null;
    var el = $("novedadVideoVista");
    if (v) {
      v.url = URL.createObjectURL(v.blob);
      el.src = v.url;
      nov.sinVideo = false;
    } else {
      el.removeAttribute("src");
      try { el.load(); } catch (_) {}
    }
    show(el, !!v);
    $("novedadVideoTexto").textContent = v
      ? "Video de " + (v.segundos ? segundosTexto(v.segundos) : "menos de 1 minuto") + " · " + megas(v.blob.size)
      : "Todavía sin video";
    show($("novedadQuitarVideo"), !!v);
    $("novedadGrabarTexto").textContent = v ? "Grabar otro" : "Grabar video";
  }

  function pintarPreparando(t, total) {
    var activo = t != null;
    $("novedadEnviar").disabled = activo;
    $("novedadGrabar").disabled = activo;
    $("novedadArchivo").disabled = activo;
    if (activo) {
      $("novedadVideoTexto").textContent = "Preparando el video en calidad media… " + Math.round(t) +
        (total && isFinite(total) ? " de " + Math.round(total) : "") + " s";
    }
  }

  // ---- grabar desde la app: cámara trasera, 640×480, unos 600 kbps (≈ 4,5 MB el minuto)
  function tipoDeGrabacion() {
    if (!window.MediaRecorder) return null;
    if (typeof MediaRecorder.isTypeSupported !== "function") return "";
    var opciones = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4"];
    for (var i = 0; i < opciones.length; i++) {
      if (MediaRecorder.isTypeSupported(opciones[i])) return opciones[i];
    }
    return "";
  }

  function tipoBase(mime) {
    var t = String(mime || "").split(";")[0].trim().toLowerCase();
    return t === "video/webm" || t === "video/mp4" || t === "video/quicktime" ? t : "";
  }

  function extensionDe(tipo) { return tipo === "video/mp4" ? "mp4" : tipo === "video/quicktime" ? "mov" : "webm"; }

  function opcionesGrabacion() {
    var o = { videoBitsPerSecond: cfg.NOVEDAD_VIDEO_BPS || 600000, audioBitsPerSecond: 48000 };
    var mime = tipoDeGrabacion();
    if (mime) o.mimeType = mime;
    return o;
  }

  function pararStream(s) {
    if (s) s.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
  }

  function textoCamara(err) {
    var n = err && err.name;
    return n === "NotAllowedError" || n === "SecurityError"
      ? "El celular no dejó usar la cámara. Permítala para el portal en los ajustes del navegador, o use \"Elegir del celular\"."
      : n === "NotFoundError" ? "No se encontró la cámara. Use \"Elegir del celular\"."
      : "No se pudo abrir la cámara. Use \"Elegir del celular\".";
  }

  function pintarGrabador(estado) {
    var b = $("grabadorBoton");
    b.dataset.estado = estado;
    b.disabled = estado === "preparando" || estado === "guardando";
    b.setAttribute("aria-label", estado === "grabando" ? "Parar" : "Grabar");
    $("grabadorAyuda").textContent = estado === "preparando" ? "Abriendo la cámara…"
      : estado === "grabando" ? "Grabando. Toque el botón para parar."
      : estado === "guardando" ? "Guardando el video…"
      : "Toque el botón rojo para grabar. Máximo 1 minuto.";
    if (estado !== "grabando") {
      $("grabadorTiempo").textContent = "0:00 de " + segundosTexto(NOV_MAX_S);
      $("grabadorBarra").style.width = "0%";
    }
  }

  async function abrirGrabador() {
    errorNovedad("");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || tipoDeGrabacion() == null) {
      errorNovedad("Este celular no deja grabar desde aquí. Use \"Elegir del celular\".");
      return;
    }
    cerrarGrabador();
    var g = nov.grab = { stream: null, rec: null, partes: [], inicio: 0, reloj: null };
    show($("grabador"), true);
    pintarGrabador("preparando");
    var video = { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 },
      frameRate: { ideal: 24, max: 30 } };
    try {
      g.stream = await navigator.mediaDevices.getUserMedia({ video: video, audio: true });
    } catch (_) {
      try {
        g.stream = await navigator.mediaDevices.getUserMedia({ video: video, audio: false });   // sin micrófono: al menos la imagen
      } catch (err) {
        if (nov.grab === g) { cerrarGrabador(); errorNovedad(textoCamara(err)); }
        return;
      }
    }
    if (nov.grab !== g) { pararStream(g.stream); return; }   // cerró mientras pedía la cámara
    var vista = $("grabadorVista");
    vista.srcObject = g.stream;
    try { await vista.play(); } catch (_) {}
    pintarGrabador("listo");
  }

  function empezarGrabacion() {
    var g = nov.grab;
    if (!g || !g.stream || g.rec) return;
    try {
      g.rec = new MediaRecorder(g.stream, opcionesGrabacion());
    } catch (_) {
      try { g.rec = new MediaRecorder(g.stream); } catch (err) {
        cerrarGrabador();
        errorNovedad("No se pudo grabar en este celular. Use \"Elegir del celular\".");
        return;
      }
    }
    g.rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) g.partes.push(ev.data); };
    g.rec.onstop = function () { terminarGrabacion(g); };
    g.rec.start(1000);
    g.inicio = Date.now();
    g.reloj = setInterval(function () { contarGrabacion(g); }, 250);
    pintarGrabador("grabando");
  }

  function contarGrabacion(g) {
    var s = (Date.now() - g.inicio) / 1000;
    $("grabadorTiempo").textContent = segundosTexto(Math.min(s, NOV_MAX_S)) + " de " + segundosTexto(NOV_MAX_S);
    $("grabadorBarra").style.width = Math.min(100, 100 * s / NOV_MAX_S) + "%";
    if (s >= NOV_MAX_S) pararGrabacion();
  }

  function pararGrabacion() {
    var g = nov.grab;
    if (!g || !g.rec || g.rec.state === "inactive") return;
    clearInterval(g.reloj);
    g.segundos = Math.min(NOV_MAX_S, (Date.now() - g.inicio) / 1000);
    pintarGrabador("guardando");
    try { g.rec.stop(); } catch (_) { terminarGrabacion(g); }
  }

  function terminarGrabacion(g) {
    if (g.cancelado || g.listo) return;
    g.listo = true;
    var tipo = tipoBase(g.rec && g.rec.mimeType) || tipoBase(tipoDeGrabacion()) || "video/webm";
    var blob = new Blob(g.partes, { type: tipo });
    cerrarGrabador();
    if (!blob.size) { errorNovedad("El video salió vacío. Intente otra vez."); return; }
    if (blob.size > NOV_MAX_BYTES) { errorNovedad("El video pesa mucho (" + megas(blob.size) + "). Grábelo más corto."); return; }
    ponerVideoNovedad({ blob: blob, tipo: tipo, ext: extensionDe(tipo), segundos: g.segundos });
  }

  function cerrarGrabador() {
    var g = nov.grab;
    nov.grab = null;
    if (g) {
      clearInterval(g.reloj);
      if (g.rec && g.rec.state !== "inactive" && !g.listo) {
        g.cancelado = true;
        try { g.rec.stop(); } catch (_) {}
      }
      pararStream(g.stream);
    }
    $("grabadorVista").srcObject = null;
    show($("grabador"), false);
  }

  // ---- o elegirlo de la galería
  function duracionDe(blob) {
    return new Promise(function (resolver) {
      var v = document.createElement("video");
      var url = URL.createObjectURL(blob);
      var listo = false;
      function fin(d) {
        if (listo) return;
        listo = true;
        URL.revokeObjectURL(url);
        resolver(d != null && isFinite(d) ? d : null);
      }
      v.preload = "metadata";
      v.muted = true;
      v.onloadedmetadata = function () {
        if (isFinite(v.duration)) { fin(v.duration); return; }
        // Un webm grabado en un navegador dice "Infinity" hasta que se busca el final.
        v.ontimeupdate = function () { v.ontimeupdate = null; fin(v.duration); };
        try { v.currentTime = 1e9; } catch (_) { fin(null); }
      };
      v.onerror = function () { fin(null); };
      setTimeout(function () { fin(null); }, 8000);
      v.src = url;
    });
  }

  // El video de la cámara del celular sale pesado (60 MB el minuto en alta
  // calidad): se reproduce sin sonido por el parlante y se vuelve a grabar en
  // 640 px y calidad media. Tarda lo que dura el video.
  function achicarVideo(archivo, duracion) {
    return new Promise(function (resolver, rechazar) {
      var lienzo = document.createElement("canvas");
      if (tipoDeGrabacion() == null || typeof lienzo.captureStream !== "function") {
        rechazar(new Error("Este celular no puede achicar videos"));
        return;
      }
      var url = URL.createObjectURL(archivo);
      var v = document.createElement("video");
      var partes = [], rec = null, cuadro = 0, audio = null, terminado = false, corte = null;
      nov.preparando = true;
      pintarPreparando(0, duracion);

      function fin(res, err) {
        if (terminado) return;
        terminado = true;
        nov.preparando = false;
        clearTimeout(corte);
        cancelAnimationFrame(cuadro);
        try { v.pause(); } catch (_) {}
        URL.revokeObjectURL(url);
        if (audio) { try { audio.close(); } catch (_) {} }
        pintarPreparando(null);
        if (res) resolver(res); else rechazar(err || new Error("No se pudo achicar el video"));
      }

      v.playsInline = true;
      v.preload = "auto";
      v.onerror = function () { fin(null); };
      v.onloadedmetadata = async function () {
        var ancho = v.videoWidth || 640, alto = v.videoHeight || 480;
        var escala = Math.min(1, 640 / Math.max(ancho, alto));
        lienzo.width = Math.max(2, Math.round(ancho * escala / 2) * 2);
        lienzo.height = Math.max(2, Math.round(alto * escala / 2) * 2);
        var ctx = lienzo.getContext("2d");
        var stream = lienzo.captureStream(24);
        try {
          var Contexto = window.AudioContext || window.webkitAudioContext;
          audio = new Contexto();
          var destino = audio.createMediaStreamDestination();
          audio.createMediaElementSource(v).connect(destino);   // al grabador, no al parlante
          destino.stream.getAudioTracks().forEach(function (t) { stream.addTrack(t); });
        } catch (_) {
          audio = null;
          v.muted = true;
        }
        try { rec = new MediaRecorder(stream, opcionesGrabacion()); } catch (err) { fin(null, err); return; }
        rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) partes.push(ev.data); };
        rec.onstop = function () {
          var tipo = tipoBase(rec.mimeType) || tipoBase(tipoDeGrabacion()) || "video/webm";
          fin({ blob: new Blob(partes, { type: tipo }), tipo: tipo, ext: extensionDe(tipo),
            segundos: duracion || v.currentTime });
        };
        function dibujar() {
          if (terminado) return;
          ctx.drawImage(v, 0, 0, lienzo.width, lienzo.height);
          pintarPreparando(v.currentTime, duracion || v.duration);
          if (!v.ended) cuadro = requestAnimationFrame(dibujar);
        }
        v.onended = function () { if (rec && rec.state !== "inactive") rec.stop(); };
        try {
          if (audio && audio.state === "suspended") await audio.resume();
          await v.play();
        } catch (_) {
          v.muted = true;                     // el navegador no lo deja sonar: va sin sonido
          try { await v.play(); } catch (err) { fin(null, err); return; }
        }
        rec.start(1000);
        dibujar();
        corte = setTimeout(function () { if (rec.state !== "inactive") rec.stop(); }, ((duracion || NOV_MAX_S) + 10) * 1000);
      };
      v.src = url;
    });
  }

  async function elegirVideoNovedad(archivo) {
    $("novedadArchivo").value = "";
    if (!archivo || nov.preparando) return;
    errorNovedad("");
    var ext = String(archivo.name || "").split(".").pop().toLowerCase();
    var tipo = tipoBase(archivo.type) ||
      ({ mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" })[ext] || "";
    // Otro formato de video (3gp de algunos Android...): se vuelve a grabar en uno que sirva.
    if (!tipo && !/^video\//i.test(archivo.type || "")) {
      errorNovedad("Ese archivo no es un video que se pueda subir. Grábelo desde aquí.");
      return;
    }
    var dur = await duracionDe(archivo);
    if (dur != null && dur > NOV_MAX_S + 1.5) {
      errorNovedad("El video dura " + segundosTexto(dur) + " y el máximo es 1 minuto. Recórtelo o grábelo desde aquí.");
      return;
    }
    if (tipo && archivo.size <= NOV_DIRECTO_BYTES) {
      ponerVideoNovedad({ blob: archivo, tipo: tipo, ext: extensionDe(tipo), segundos: dur });
      return;
    }
    var chico = null;
    try { chico = await achicarVideo(archivo, dur); } catch (_) { chico = null; }
    if ($("novedadSheet").hidden) return;
    if (chico && chico.blob.size && (chico.blob.size < archivo.size || !tipo)) { ponerVideoNovedad(chico); return; }
    if (tipo && archivo.size <= NOV_MAX_BYTES) {
      ponerVideoNovedad({ blob: archivo, tipo: tipo, ext: extensionDe(tipo), segundos: dur });
      return;
    }
    ponerVideoNovedad(null);
    errorNovedad(tipo ? "El video pesa " + megas(archivo.size) + " y este celular no lo puede achicar. Grábelo desde aquí: sale más liviano."
      : "Este celular no puede pasar ese video a un formato que sirva. Grábelo desde aquí.");
  }

  // ---- enviar
  function mostrarResultadoNovedad(it, textoVideo) {
    var tipo = it.datos.p_tipo;
    $("novedadResNumero").textContent = it.numero ? "Novedad N° " + it.numero : "Novedad guardada en el celular";
    $("novedadResTexto").textContent = !it.numero
      ? "Todavía no hay señal. Se envía sola cuando vuelva; el número le sale en \"Mis novedades\"."
      : tipo === "trasbordo"
        ? "Quedó registrada. " + (it.datos.p_cantidad === 1 ? "El pasajero del " + it.datos.p_interno_origen + " se descuenta"
          : "Los " + it.datos.p_cantidad + " pasajeros del " + it.datos.p_interno_origen + " se descuentan") +
          " de la movilidad del bus " + it.datos.p_interno + "."
        : "Quedó registrada: " + (NOV_TIPOS[tipo] || tipo).toLowerCase() + ".";
    $("novedadResVideo").textContent = textoVideo || "";
    $("novedadResultadoCaja").dataset.ok = it.numero ? "true" : "espera";
    show($("novedadForm"), false);
    show($("novedadResultado"), true);
  }

  async function enviarNovedad(ev) {
    ev.preventDefault();
    if (nov.enviando || nov.preparando) return;
    var tipo = tipoNovedad();
    var bus = busDelCodigo();
    var origen = normalizarInterno($("novedadOrigen").value);
    var cantidad = parseInt($("novedadCantidad").value.replace(/\D/g, ""), 10);
    var nota = $("novedadNota").value.trim();
    var falla = !bus ? "Primero confirme su bus en el inicio."
      : !tipo ? "Escoja qué pasó."
      : tipo === "trasbordo" && !origen ? "Escriba de qué bus venían los pasajeros."
      : tipo === "trasbordo" && origen === normalizarInterno(bus) ? "El bus de donde venían no puede ser el suyo (" + bus + ")."
      : tipo === "trasbordo" && !(cantidad >= 1 && cantidad <= 99) ? "Escriba cuántos pasajeros recibió (de 1 a 99)."
      : tipo === "otra" && nota.length < 5 ? "Cuente en pocas palabras qué pasó."
      : "";
    if (falla) { errorNovedad(falla); return; }
    if (!nov.video && !nov.sinVideo) {
      nov.sinVideo = true;
      errorNovedad("No tiene video. Si puede, grábelo: le sirve de prueba. Para enviarla sin video, toque otra vez \"Enviar novedad\".");
      return;
    }
    errorNovedad("");

    var pos = ubicacion.posicion;
    var ahora = Date.now();
    var it = {
      id_local: alAzar(12),
      creado_ms: ahora,
      datos: {
        p_tipo: tipo,
        p_interno: bus,
        p_interno_origen: tipo === "trasbordo" ? origen : null,
        p_cantidad: tipo === "trasbordo" ? cantidad : null,
        p_nota: nota || null,
        p_dni: normalizarDni(state.dni),
        p_ocurrio_en: new Date(ahora).toISOString(),
        p_lat: pos ? pos.lat : null,
        p_lon: pos ? pos.lng : null,
        p_precision: pos ? pos.precision : null,
        p_clave_viaje: nov.clave || null,
      },
      video: nov.video ? nov.video.blob : null,
      video_tipo: nov.video ? nov.video.tipo : null,
      video_ext: nov.video ? nov.video.ext : null,
      video_segundos: nov.video && nov.video.segundos ? Math.round(nov.video.segundos * 10) / 10 : null,
      numero: null, video_ruta: null, video_fallo: null, error: null,
    };

    var boton = $("novedadEnviar");
    nov.enviando = true;
    nov.ocupada = it.id_local;
    boton.disabled = true;
    boton.textContent = "Enviando…";
    var enCola = true;
    try {
      await novGuardar(it);
    } catch (_) {
      // Algunos Safari no guardan el video tal cual: se guarda como bytes.
      try {
        if (it.video) it.video = await it.video.arrayBuffer();
        await novGuardar(it);
      } catch (_2) {
        enCola = false;
      }
    }
    try {
      if (state.user && internet.ok) await pedirNumero(it);
    } catch (err) {
      if (esRechazo(err)) {
        await novBorrar(it.id_local).catch(noHacerNada);
        nov.enviando = false;
        nov.ocupada = null;
        boton.disabled = false;
        boton.textContent = "Enviar novedad";
        errorNovedad("No se pudo: " + mensajeDeError(err));
        return;
      }
    }
    nov.enviando = false;
    boton.disabled = false;
    boton.textContent = "Enviar novedad";
    if (!it.numero) nov.ocupada = null;
    if (!it.numero && !enCola) {
      errorNovedad("No hay señal y este celular no la puede guardar. Inténtelo cuando tenga internet.");
      return;
    }
    ponerVideoNovedad(null);
    mostrarResultadoNovedad(it, it.numero && it.video ? "Subiendo el video… puede cerrar esta ventana; no cierre el portal." : "");
    pintarNovedadesMias();
    if (!it.numero) return;
    // El video sube por detrás: con señal débil tarda.
    subirVideoYTerminar(it).then(function () {
      if (!$("novedadResultado").hidden && it.video) {
        $("novedadResVideo").textContent = it.video_ruta ? "✓ El video quedó subido." : "La novedad quedó, pero el video no se pudo subir: " + (it.video_fallo || "");
      }
    }, function () {
      if (!$("novedadResultado").hidden && it.video) {
        $("novedadResVideo").textContent = "El video se sube solo cuando haya buena señal.";
      }
    }).then(function () {
      nov.ocupada = null;
      actualizarNovedadesMias();
    });
  }

  function initNovedades() {
    $("btnSinInternetNovedad").addEventListener("click", function () { abrirNovedad(null); });
    $("novedadCerrar").addEventListener("click", cerrarNovedad);
    $("novedadListo").addEventListener("click", cerrarNovedad);
    $("novedadForm").addEventListener("submit", enviarNovedad);
    $("novedadForm").addEventListener("change", function (ev) {
      if (ev.target && ev.target.name === "novedadTipo") { pintarTipoNovedad(); errorNovedad(""); }
    });
    ["novedadOrigen", "novedadCantidad"].forEach(function (id) {
      $(id).addEventListener("input", function () {
        var limpio = id === "novedadCantidad" ? this.value.replace(/\D/g, "") : this.value.replace(/[^0-9A-Za-z]/g, "");
        if (limpio !== this.value) this.value = limpio;
      });
    });
    $("novedadGrabar").addEventListener("click", abrirGrabador);
    $("novedadArchivo").addEventListener("change", function () { elegirVideoNovedad(this.files && this.files[0]); });
    $("novedadQuitarVideo").addEventListener("click", function () { ponerVideoNovedad(null); });
    $("grabadorBoton").addEventListener("click", function () {
      if (this.dataset.estado === "listo") empezarGrabacion();
      else if (this.dataset.estado === "grabando") pararGrabacion();
    });
    $("grabadorCancelar").addEventListener("click", cerrarGrabador);
    // Lo que quedó sin enviar se reintenta cada minuto mientras el portal está abierto.
    setInterval(function () {
      if (state.user && internet.ok && !document.hidden) enviarNovedadesPendientes();
    }, 60 * 1000);
  }

  // ------------------------------------------------- internet obligatorio
  // El portal no se usa sin conexión: asistencia, viajes, fila y tiquetes
  // dependen del servidor. navigator.onLine no basta (dice "conectado" con un
  // Wi-Fi sin salida), así que se pregunta de verdad al endpoint de salud de
  // Supabase (~100 bytes). Si no responde, una pantalla bloquea el portal
  // hasta que vuelva la conexión.
  var internet = { ok: true, fallos: 0, verificando: false, timer: null };

  async function hayInternet() {
    if (!navigator.onLine) return false;

    var control = typeof AbortController === "function" ? new AbortController() : null;
    var limite = cfg.INTERNET_TIEMPO_LIMITE_MS || 10000;
    var corte = setTimeout(function () { if (control) control.abort(); }, limite);
    try {
      var resp = await conTiempoLimite(fetch(cfg.SUPABASE_URL + "/auth/v1/health", {
        method: "GET",
        headers: { apikey: cfg.SUPABASE_ANON_KEY },
        cache: "no-store",
        signal: control ? control.signal : undefined,
      }), limite);
      // Una respuesta real del servidor prueba la salida a internet. Un 5xx
      // (o el 503 que fabrica un service worker sin red) no cuenta.
      return resp.status >= 200 && resp.status < 500;
    } catch (_) {
      return false;
    } finally {
      clearTimeout(corte);
    }
  }

  async function verificarInternet() {
    if (internet.verificando) return internet.ok;
    internet.verificando = true;
    pintarVerificando(true);

    var ok = await hayInternet();

    internet.verificando = false;
    pintarVerificando(false);

    if (ok) {
      internet.fallos = 0;
      if (!internet.ok) {
        internet.ok = true;
        alRecuperarInternet();
      }
    } else {
      internet.fallos++;
      // Un fallo suelto puede ser un bache de la señal: se confirma con un
      // segundo intento a los 3 s. Si el teléfono ya dice que no hay red, no
      // hay nada que confirmar.
      if (internet.ok && (internet.fallos >= 2 || !navigator.onLine)) {
        internet.ok = false;
        alPerderInternet();
      }
    }

    pintarEstadoRed();
    programarVerificacion();
    return internet.ok;
  }

  function programarVerificacion() {
    clearTimeout(internet.timer);
    var espera = !internet.ok
      ? (cfg.INTERNET_REINTENTO_MS || 5000)
      : internet.fallos > 0 ? 3000 : (cfg.INTERNET_VERIFICAR_MS || 30000);

    internet.timer = setTimeout(function () {
      // Con la app en segundo plano no se gastan datos: al volver a primer
      // plano se verifica en el acto (ver initRed).
      if (document.hidden) { programarVerificacion(); return; }
      verificarInternet();
    }, espera);
  }

  function alPerderInternet() {
    pintarBotonesSinInternet();
    show($("sinInternet"), true);
    try { $("btnReintentarInternet").focus(); } catch (_) {}
  }

  // Al volver: se quita el bloqueo y se pone al día lo que quedó quieto. Los
  // módulos abiertos no se recargan: si estaba a mitad de una marca, sigue
  // donde iba.
  function alRecuperarInternet() {
    show($("sinInternet"), false);
    if (state.user && !$("appView").hidden && state.vista === "inicio") cargarInicio();
    if (state.user && !$("appView").hidden && state.vista === "tarjeta") cargarTarjeta();
    enviarConfirmacionesPendientes();
    enviarNovedadesPendientes();
  }

  function pintarVerificando(activo) {
    var btn = $("btnReintentarInternet");
    btn.disabled = activo;
    btn.textContent = activo ? "Verificando…" : "Reintentar";
  }

  function pintarEstadoRed() {
    var conectado = internet.ok && navigator.onLine;
    var el = $("netStatus");
    el.dataset.online = String(conectado);
    el.querySelector(".net-label").textContent = conectado ? "En línea" : "Sin conexión";
    pintarAvisoOffline();
  }

  function initRed() {
    $("btnReintentarInternet").addEventListener("click", verificarInternet);

    // El teléfono avisa cambios de red: se verifica al instante en vez de
    // esperar a la siguiente vuelta.
    window.addEventListener("offline", verificarInternet);
    window.addEventListener("online", verificarInternet);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) verificarInternet();
    });

    pintarEstadoRed();
    verificarInternet();
  }

  // --------------------------------------------------- ubicación obligatoria
  // El portal no se usa sin la ubicación del teléfono, igual que sin internet:
  // una pantalla bloquea todo (login incluido) hasta que el conductor la
  // permita y llegue una posición.
  //  - Nunca se le pidió: se explica, y "Permitir ubicación" lanza la pregunta
  //    del sistema con un toque del conductor (así Chrome y Safari la muestran
  //    en vez de esconderla).
  //  - La negó: pasos para activarla en su teléfono.
  //  - Ubicación del teléfono apagada: bloquea si pasa UBICACION_SIN_POSICION_MS
  //    sin ninguna posición y los intentos fallan. Un túnel o un sótano no
  //    bloquean porque hace poco hubo posición.
  // Con permiso, la posición se sigue mientras el portal está abierto. Una
  // aplicación web no puede seguirla con el portal cerrado ni pedir "Permitir
  // siempre": eso solo lo hace una app nativa.
  var ubicacion = {
    motivo: null,       // null = activa | "pedir" | "bloqueada" | "apagada" | "sin-soporte"
    watchId: null,
    inicioWatchMs: 0,
    ultimaMs: 0,        // cuándo llegó la última posición
    posicion: null,     // { lat, lng, precision }
    fallos: 0,
    pidiendo: false,
    timer: null,
  };

  var TEXTOS_UBICACION = {
    pedir: {
      titulo: "Comparta su ubicación",
      texto: "Para usar el portal es obligatorio compartir la ubicación del teléfono.",
      boton: "Permitir ubicación",
      nota: "Cuando el teléfono pregunte, elija Permitir.",
    },
    bloqueada: {
      titulo: "La ubicación está bloqueada",
      texto: "El portal no funciona sin la ubicación. Actívela así:",
      boton: "Reintentar",
      nota: "Al activarla, el portal se desbloquea.",
    },
    apagada: {
      titulo: "No encontramos su ubicación",
      texto: "La ubicación del teléfono parece apagada.",
      boton: "Reintentar",
      nota: "Se vuelve a intentar sola cada pocos segundos.",
    },
    "sin-soporte": {
      titulo: "Este navegador no sirve",
      texto: "No permite compartir la ubicación. Abra el portal en Chrome (Android) o Safari (iPhone).",
      boton: "",
      nota: "",
    },
  };

  function geolocalizacionDisponible() {
    return !!(navigator.geolocation && typeof navigator.geolocation.watchPosition === "function");
  }

  // Estado del permiso sin preguntarle al conductor. null si el navegador no
  // lo dice: entonces deciden los errores de la propia ubicación.
  function obtenerPermisoUbicacion() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve(null);
      return navigator.permissions.query({ name: "geolocation" }).catch(function () { return null; });
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function alRecibirPosicion(pos) {
    ubicacion.ultimaMs = Date.now();
    ubicacion.fallos = 0;
    ubicacion.posicion = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      precision: Math.round(pos.coords.accuracy || 0),
    };
    if (ubicacion.motivo) desbloquearUbicacion();
  }

  function alFallarPosicion(err) {
    var codigo = err && err.code;
    if (codigo === 1) { // permiso negado
      detenerSeguimiento();
      bloquearUbicacion("bloqueada");
      return;
    }
    ubicacion.fallos += 1;
    // Sin señal de GPS: se intenta con la ubicación por red (Wi-Fi y
    // antenas), que sí llega bajo techo.
    if (codigo === 3 && ubicacion.fallos === 1) {
      navigator.geolocation.getCurrentPosition(alRecibirPosicion, alFallarPosicion,
        { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 20 * 1000 });
      return;
    }
    var sinPosicion = Date.now() - ubicacion.ultimaMs > (cfg.UBICACION_SIN_POSICION_MS || 120000);
    if (ubicacion.fallos >= 2 && sinPosicion) bloquearUbicacion("apagada");
  }

  function iniciarSeguimiento() {
    if (ubicacion.watchId != null || !geolocalizacionDisponible()) return;
    ubicacion.inicioWatchMs = Date.now();
    try {
      ubicacion.watchId = navigator.geolocation.watchPosition(alRecibirPosicion, alFallarPosicion,
        { enableHighAccuracy: true, maximumAge: 30 * 1000, timeout: 30 * 1000 });
    } catch (_) {
      bloquearUbicacion("sin-soporte");
    }
  }

  function detenerSeguimiento() {
    if (ubicacion.watchId == null) return;
    try { navigator.geolocation.clearWatch(ubicacion.watchId); } catch (_) {}
    ubicacion.watchId = null;
  }

  function reiniciarSeguimiento() {
    detenerSeguimiento();
    iniciarSeguimiento();
  }

  // La pregunta del sistema, lanzada por el toque del conductor.
  function solicitarUbicacion() {
    if (!geolocalizacionDisponible()) { bloquearUbicacion("sin-soporte"); return; }
    if (ubicacion.pidiendo) return;
    ubicacion.pidiendo = true;
    pintarUbicacion();
    navigator.geolocation.getCurrentPosition(function (pos) {
      ubicacion.pidiendo = false;
      alRecibirPosicion(pos);
      reiniciarSeguimiento();
    }, function (err) {
      ubicacion.pidiendo = false;
      if (err && err.code === 1) {
        detenerSeguimiento();
        bloquearUbicacion("bloqueada");
        return;
      }
      if (Date.now() - ubicacion.ultimaMs > (cfg.UBICACION_SIN_POSICION_MS || 120000)) {
        bloquearUbicacion("apagada");
      } else {
        pintarUbicacion();
      }
      reiniciarSeguimiento();
    }, { enableHighAccuracy: true, maximumAge: 60 * 1000, timeout: 20 * 1000 });
  }

  function bloquearUbicacion(motivo) {
    var yaBloqueado = !!ubicacion.motivo;
    ubicacion.motivo = motivo;
    pintarUbicacion();
    show($("sinUbicacion"), true);
    if (!yaBloqueado) {
      try { $("btnPermitirUbicacion").focus(); } catch (_) {}
    }
    programarReintentoUbicacion();
  }

  function desbloquearUbicacion() {
    ubicacion.motivo = null;
    clearTimeout(ubicacion.timer);
    ubicacion.timer = null;
    show($("sinUbicacion"), false);
    setTimeout(pedirInstalacion, 1500); // la hoja de instalación esperaba a este bloqueo
  }

  // Bloqueado por permiso negado o ubicación apagada: se reintenta solo, sin
  // volver a lanzar la pregunta del sistema (eso solo con un toque).
  function programarReintentoUbicacion() {
    clearTimeout(ubicacion.timer);
    if (ubicacion.motivo !== "bloqueada" && ubicacion.motivo !== "apagada") return;
    ubicacion.timer = setTimeout(function () {
      ubicacion.timer = null;
      if (!document.hidden) reintentarUbicacionSola();
      programarReintentoUbicacion();
    }, cfg.UBICACION_REINTENTO_MS || 10000);
  }

  function reintentarUbicacionSola() {
    if (ubicacion.pidiendo) return;
    if (ubicacion.motivo === "apagada") {
      // Un GPS en frío tarda: no se reinicia antes de darle su tiempo.
      if (Date.now() - ubicacion.inicioWatchMs > 35 * 1000) reiniciarSeguimiento();
      return;
    }
    if (ubicacion.motivo === "bloqueada") {
      obtenerPermisoUbicacion().then(function (permiso) {
        if (!permiso || ubicacion.motivo !== "bloqueada") return;
        if (permiso.state === "granted") reiniciarSeguimiento();
        else if (permiso.state === "prompt") bloquearUbicacion("pedir");
      });
    }
  }

  function alCambiarPermisoUbicacion(estado) {
    if (estado === "granted") {
      reiniciarSeguimiento(); // desbloquea en cuanto llega la posición
    } else {
      detenerSeguimiento();
      bloquearUbicacion(estado === "denied" ? "bloqueada" : "pedir");
    }
  }

  function pasosUbicacion(motivo) {
    var sitio = "<strong>" + escapeHtml(location.host) + "</strong>";
    if (esNavegadorDeApp()) {
      return [
        "Este navegador (dentro de WhatsApp, Facebook…) no comparte la ubicación.",
        "Abra el enlace en <strong>Safari</strong> (iPhone) o <strong>Chrome</strong> (Android).",
      ];
    }
    if (esIos()) {
      return motivo === "apagada" ? [
        "Abra <strong>Ajustes</strong> → <strong>Privacidad y seguridad</strong> → <strong>Localización</strong> y actívela.",
        "Si está bajo techo, acérquese a una ventana o salga a cielo abierto.",
      ] : [
        "Abra <strong>Ajustes</strong> → <strong>Privacidad y seguridad</strong> → <strong>Localización</strong> y actívela.",
        "En esa misma lista, toque <strong>Sitios web de Safari</strong> y elija <strong>Mientras se usa la app</strong>.",
        "En <strong>Ajustes</strong> → <strong>Safari</strong> → <strong>Ubicación</strong>, elija <strong>Permitir</strong> (en iOS 18, Safari está dentro de <strong>Apps</strong>).",
        "Vuelva al portal y toque <strong>Reintentar</strong>.",
      ];
    }
    if (/android/i.test(navigator.userAgent || "")) {
      return motivo === "apagada" ? [
        "Baje la barra de notificaciones y encienda <strong>Ubicación</strong>.",
        "Si está bajo techo, acérquese a una ventana.",
      ] : [
        "Abra <strong>Chrome</strong> → menú <strong>⋮</strong> → <strong>Configuración</strong> → <strong>Configuración de sitios</strong> → <strong>Ubicación</strong>.",
        "Busque " + sitio + " y elija <strong>Permitir</strong>.",
        "Si sigue bloqueada: <strong>Ajustes</strong> del teléfono → <strong>Aplicaciones</strong> → <strong>Chrome</strong> → <strong>Permisos</strong> → <strong>Ubicación</strong> → <strong>Permitir</strong>.",
        "Encienda la <strong>Ubicación</strong> en la barra de notificaciones y vuelva al portal.",
      ];
    }
    return motivo === "apagada" ? [
      "Encienda la ubicación del equipo. En Windows: <strong>Configuración</strong> → <strong>Privacidad y seguridad</strong> → <strong>Ubicación</strong>.",
      "Toque <strong>Reintentar</strong>.",
    ] : [
      "Haga clic en el icono que está a la izquierda de la dirección " + sitio + ".",
      "En <strong>Ubicación</strong>, elija <strong>Permitir</strong>.",
      "Toque <strong>Reintentar</strong> o recargue la página.",
    ];
  }

  function pintarUbicacion() {
    var motivo = ubicacion.motivo || "pedir";
    var t = TEXTOS_UBICACION[motivo];
    $("sinUbicacionTitulo").textContent = t.titulo;
    $("sinUbicacionTexto").textContent = t.texto;

    var pasos = motivo === "bloqueada" || motivo === "apagada" ? pasosUbicacion(motivo) : [];
    $("ubicacionPasos").innerHTML = pasos.map(function (paso, i) {
      return '<li><span class="instalar-num">' + (i + 1) + "</span><span>" + paso + "</span></li>";
    }).join("");
    show($("ubicacionPasos"), pasos.length > 0);

    var btn = $("btnPermitirUbicacion");
    show(btn, !!t.boton);
    btn.disabled = ubicacion.pidiendo;
    btn.textContent = !ubicacion.pidiendo ? t.boton
      : motivo === "pedir" ? "Esperando permiso…" : "Buscando…";

    $("sinUbicacionNota").textContent = t.nota;
    show($("sinUbicacionNota"), !!t.nota);
  }

  function textoUbicacionPerfil() {
    if (ubicacion.motivo) return "Desactivada";
    if (!ubicacion.posicion) return "Buscando…";
    return "Activa · ±" + ubicacion.posicion.precision + " m";
  }

  function initUbicacion() {
    $("btnPermitirUbicacion").addEventListener("click", solicitarUbicacion);

    if (!geolocalizacionDisponible() || window.isSecureContext === false) {
      bloquearUbicacion("sin-soporte");
      return;
    }

    obtenerPermisoUbicacion().then(function (permiso) {
      if (permiso) {
        var alCambiar = function () { alCambiarPermisoUbicacion(permiso.state); };
        try {
          if (permiso.addEventListener) permiso.addEventListener("change", alCambiar);
          else permiso.onchange = alCambiar;
        } catch (_) {}
      }
      var estado = permiso ? permiso.state : null;
      if (estado === "prompt") bloquearUbicacion("pedir");
      else if (estado === "denied") bloquearUbicacion("bloqueada");
      else iniciarSeguimiento(); // concedido, o el navegador no lo dice
    });

    // De fondo el teléfono puede quitar el permiso o apagar la ubicación, e
    // iOS suele cortar el seguimiento: al volver se comprueba de nuevo.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden || ubicacion.pidiendo) return;
      if (ubicacion.motivo === "bloqueada" || ubicacion.motivo === "apagada") reintentarUbicacionSola();
      else if (!ubicacion.motivo) reiniciarSeguimiento();
    });

    // Seguimiento que se quedó mudo (ni posición ni error): se reinicia.
    setInterval(function () {
      if (document.hidden || ubicacion.motivo || ubicacion.pidiendo) return;
      var limite = cfg.UBICACION_SIN_POSICION_MS || 120000;
      if (Date.now() - ubicacion.ultimaMs > limite && Date.now() - ubicacion.inicioWatchMs > 35 * 1000) {
        reiniciarSeguimiento();
      }
    }, 30 * 1000);
  }

  // ---------------------------------------------------------- PWA / etc.

  // ------------------------------------------------------------ instalación
  // El portal pide instalarse: desde la pantalla de inicio abre a pantalla
  // completa, sin barra del navegador, y el conductor lo encuentra como a
  // cualquier aplicación.
  //  - Android y computador: el navegador avisa (beforeinstallprompt) y se
  //    instala con un toque.
  //  - iPhone y iPad: Safari no avisa ni instala solo; se muestran los pasos.
  //  - Navegadores dentro de otra app (WhatsApp, Facebook): no pueden
  //    instalar; se pide abrir el enlace en Safari o Chrome.
  // Se pide desde la primera visita, antes del login: en iPhone la app
  // instalada no comparte sesión con Safari. "Ahora no" lo calla 3 días.
  var LS_INSTALAR_POSPUESTO = "portal_instalar_pospuesto";
  var INSTALAR_POSPONER_MS = 3 * DIA_MS;
  var instalarYaPedido = false;

  function esInstalada() {
    try {
      if (window.matchMedia("(display-mode: standalone)").matches) return true;
      if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
    } catch (_) { /* navegador sin matchMedia */ }
    return window.navigator.standalone === true; // Safari de iOS
  }

  function esIos() {
    var ua = navigator.userAgent || "";
    // iPadOS se presenta como Mac, pero con pantalla táctil.
    return /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }

  function esNavegadorDeApp() {
    return /FBAN|FBAV|Instagram|Line\/|WhatsApp|GSA\/|; wv\)/i.test(navigator.userAgent || "");
  }

  function modoInstalacion() {
    if (esInstalada()) return null;
    if (state.deferredInstall) return "directo";
    if (esNavegadorDeApp()) return "otra-app";
    if (esIos()) return "ios";
    return null; // navegador que aún no avisa o que no instala
  }

  function instalacionPospuesta() {
    try {
      return Date.now() - Number(localStorage.getItem(LS_INSTALAR_POSPUESTO) || 0) < INSTALAR_POSPONER_MS;
    } catch (_) { return false; }
  }

  function pintarBotonInstalar() {
    var disponible = !!modoInstalacion();
    show($("btnInstall"), disponible);
    show($("btnInstalarPerfil"), disponible);
  }

  function abrirInstalar() {
    var modo = modoInstalacion();
    if (!modo) return false;
    show($("instalarDirecto"), modo === "directo");
    show($("instalarIos"), modo === "ios");
    show($("instalarOtraApp"), modo === "otra-app");
    show($("instalarSheet"), true);
    return true;
  }

  function cerrarInstalar(posponer) {
    show($("instalarSheet"), false);
    if (!posponer) return;
    try { localStorage.setItem(LS_INSTALAR_POSPUESTO, String(Date.now())); } catch (_) {}
  }

  // Aviso automático, una vez por apertura y solo con la pantalla despejada:
  // nada encima y, dentro de la app, mirando el inicio (no a mitad de marcar
  // asistencia o validar tiquetes).
  function pedirInstalacion() {
    if (instalarYaPedido || instalacionPospuesta() || !modoInstalacion()) return;
    var ocupado = ["bootOverlay", "perfilSheet", "tiquetesSheet", "sinInternet", "sinUbicacion", "instalarSheet", "noticiasSheet", "noticiaVentana"]
      .some(function (id) { return $(id) && !$(id).hidden; });
    if (ocupado) return;
    if (!$("appView").hidden && state.vista !== "inicio") return;

    if (abrirInstalar()) instalarYaPedido = true;
  }

  function initPwa() {
    window.addEventListener("beforeinstallprompt", function (ev) {
      ev.preventDefault();
      state.deferredInstall = ev;
      pintarBotonInstalar();
      setTimeout(pedirInstalacion, 1500);
    });

    $("btnInstall").addEventListener("click", function () { abrirInstalar(); });
    $("btnInstalarPerfil").addEventListener("click", function () {
      show($("perfilSheet"), false);
      abrirInstalar();
    });

    $("btnInstalarAhora").addEventListener("click", async function () {
      var aviso = state.deferredInstall;
      if (!aviso) { cerrarInstalar(false); return; }
      aviso.prompt();
      var eleccion = null;
      try { eleccion = await aviso.userChoice; } catch (_) {}
      state.deferredInstall = null; // el aviso del navegador sirve una sola vez
      cerrarInstalar(!(eleccion && eleccion.outcome === "accepted"));
      pintarBotonInstalar();
    });

    $("btnInstalarLuego").addEventListener("click", function () { cerrarInstalar(true); });
    $("instalarCerrar").addEventListener("click", function () { cerrarInstalar(true); });
    $("instalarSheet").addEventListener("click", function (ev) {
      if (ev.target === $("instalarSheet")) cerrarInstalar(true);
    });

    window.addEventListener("appinstalled", function () {
      state.deferredInstall = null;
      cerrarInstalar(false);
      pintarBotonInstalar();
    });

    pintarBotonInstalar();
  }

  // --------------------------------------------------------- actualizaciones
  // Cada versión publicada llega sola a los teléfonos, sin reinstalar nada:
  //  1. Se pregunta al servidor por un sw.js nuevo al abrir el portal, al
  //     volver a él y cada ACTUALIZACION_VERIFICAR_MS con la pantalla a la vista.
  //  2. El service worker nuevo descarga la versión completa y queda en espera.
  //  3. El portal lo activa y recarga en un momento seguro: con el inicio, la
  //     fila del aeropuerto, el login o la cédula a la vista, sin hojas
  //     abiertas ni un campo a medio escribir, tras 5 s de aviso.
  //  4. Marcando asistencia o validando tiquetes solo se avisa. Se instala al
  //     volver al inicio, con "Actualizar", o si el conductor regresa a la app
  //     tras 10 minutos fuera (lo que tuviera a medias ya no sirve).
  // Si la página ya llegó en la versión nueva y no hay módulos abiertos, se
  // activa sin recargar: no hay nada viejo en pantalla.
  var ACTUALIZAR_AVISO_S = 5;
  var ACTUALIZAR_TRAS_AUSENCIA_MS = 10 * 60 * 1000;
  var ACTUALIZAR_VENTANA_REGRESO_MS = 30 * 1000;
  var VISTAS_SIN_TRABAJO_EN_CURSO = { inicio: true, aeropuerto: true };
  var actualizacion = {
    reg: null,
    nuevo: null,              // service worker instalado, en espera
    version: "",              // versión que trae, si respondió
    recargar: false,          // otra pestaña ya activó la nueva: basta recargar
    silenciosa: false,        // activación sin recarga en curso
    aplicando: false,
    pedidaPorConductor: false, // tocó "Buscar actualización" en Perfil
    cuenta: ACTUALIZAR_AVISO_S,
    timer: null,
    ocultoDesde: 0,
    volvioEn: 0,              // regresó a la app tras una ausencia larga
  };

  function pintarVersion() {
    document.querySelectorAll("[data-version]").forEach(function (el) {
      el.textContent = cfg.APP_VERSION || "";
    });
  }

  function hayActualizacion() {
    return !!(actualizacion.nuevo || actualizacion.recargar);
  }

  function versionNueva() {
    var v = actualizacion.version;
    return v && v !== cfg.APP_VERSION ? v : "";
  }

  // Pregunta al service worker qué versión trae. Uno anterior a este
  // mecanismo no sabe responder: a los 2 s se sigue sin el dato.
  function versionDe(worker) {
    return new Promise(function (resolve) {
      if (!worker || typeof MessageChannel === "undefined") { resolve(""); return; }
      var canal = new MessageChannel();
      var listo = false;
      function fin(v) {
        if (listo) return;
        listo = true;
        resolve(typeof v === "string" ? v : "");
      }
      canal.port1.onmessage = function (ev) { fin(ev.data); };
      setTimeout(fin, 2000);
      try { worker.postMessage({ type: "VERSION" }, [canal.port2]); } catch (_) { fin(""); }
    });
  }

  async function nuevaVersionLista(worker) {
    if (actualizacion.aplicando || actualizacion.nuevo === worker) return;
    actualizacion.nuevo = worker;
    actualizacion.version = await versionDe(worker);
    if (actualizacion.nuevo !== worker || actualizacion.aplicando) return;

    // La pidió desde Perfil y sigue ahí esperando: se instala ya.
    if (actualizacion.pedidaPorConductor && !$("perfilSheet").hidden) {
      aplicarActualizacion();
      return;
    }

    if (actualizacion.version === cfg.APP_VERSION && !Object.keys(state.iframes).length) {
      actualizacion.nuevo = null;
      actualizacion.recargar = false;
      detenerAvisoActualizacion(); // pudo quedar el de una versión intermedia
      actualizacion.silenciosa = true;
      try { worker.postMessage({ type: "SKIP_WAITING" }); } catch (_) { actualizacion.silenciosa = false; }
      return;
    }
    vigilarActualizacion();
  }

  function seguirInstalacion(worker) {
    if (!worker) return;
    function revisar() {
      // Sin controlador es la primera instalación: no hay versión vieja que cambiar.
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        nuevaVersionLista(worker);
      } else if (worker.state === "redundant" && actualizacion.pedidaPorConductor &&
                 actualizacion.nuevo !== worker) {
        actualizacion.pedidaPorConductor = false;
        decirEnPerfil("No se pudo descargar la versión nueva. Intente de nuevo.");
      }
    }
    worker.addEventListener("statechange", revisar);
    revisar();
  }

  function buscarActualizacion() {
    var reg = actualizacion.reg;
    if (!reg || actualizacion.aplicando || !navigator.onLine) return Promise.resolve();
    return reg.update().catch(function () { /* sin red o servidor caído: se reintenta luego */ });
  }

  function volvioTrasAusencia() {
    return !!actualizacion.volvioEn && Date.now() - actualizacion.volvioEn < ACTUALIZAR_VENTANA_REGRESO_MS;
  }

  function momentoSeguroParaActualizar() {
    // Recargar sin red dejaría el portal a medio cargar.
    if (!internet.ok || !navigator.onLine) return false;
    var hojaAbierta = ["perfilSheet", "tiquetesSheet", "instalarSheet", "noticiasSheet", "noticiaVentana"].some(function (id) {
      return $(id) && !$(id).hidden;
    });
    if (hojaAbierta) return false;
    var activo = document.activeElement;
    if (activo && /^(INPUT|TEXTAREA|SELECT)$/.test(activo.tagName) && activo.value) return false;
    if ($("appView").hidden) return true; // login, cédula o cargando
    return !!VISTAS_SIN_TRABAJO_EN_CURSO[state.vista] || volvioTrasAusencia();
  }

  function vigilarActualizacion() {
    if (!hayActualizacion() || actualizacion.aplicando || actualizacion.timer) return;
    actualizacion.cuenta = ACTUALIZAR_AVISO_S;
    actualizacion.timer = setInterval(tickActualizacion, 1000);
    tickActualizacion();
  }

  function detenerAvisoActualizacion() {
    clearInterval(actualizacion.timer);
    actualizacion.timer = null;
    show($("avisoActualizacion"), false);
  }

  function tickActualizacion() {
    if (actualizacion.aplicando || document.hidden) return;
    if (!hayActualizacion()) { detenerAvisoActualizacion(); return; }
    if (!momentoSeguroParaActualizar()) {
      actualizacion.cuenta = ACTUALIZAR_AVISO_S;
      pintarAvisoActualizacion(false);
      return;
    }
    // Tras una ausencia larga no hay cuenta atrás: en 5 s podría empezar
    // algo nuevo que la recarga cortaría.
    if (actualizacion.cuenta <= 0 || volvioTrasAusencia()) {
      aplicarActualizacion();
      return;
    }
    pintarAvisoActualizacion(true);
    actualizacion.cuenta -= 1;
  }

  function pintarAvisoActualizacion(enCuenta) {
    var nueva = versionNueva();
    var titulo = "Versión nueva" + (nueva ? " " + nueva : "");
    var texto;
    if (enCuenta) {
      texto = titulo + " · se instala en " + actualizacion.cuenta + " s";
    } else if ($("appView").hidden) {
      texto = titulo + " lista. Se instala en un momento.";
    } else {
      texto = titulo + " lista. Se instala al volver al inicio.";
    }
    $("avisoActualizacionTexto").textContent = texto;
    $("btnActualizarAhora").textContent = enCuenta ? "Ahora" : "Actualizar";
    show($("avisoActualizacion"), true);
  }

  function aplicarActualizacion() {
    if (actualizacion.aplicando || !hayActualizacion()) return;
    actualizacion.aplicando = true;
    clearInterval(actualizacion.timer);
    actualizacion.timer = null;

    var nueva = versionNueva();
    show($("avisoActualizacion"), false);
    show($("perfilSheet"), false);
    $("bootTexto").textContent = nueva ? "Instalando la versión " + nueva + "…" : "Instalando la versión nueva…";
    show($("bootOverlay"), true);

    var worker = actualizacion.nuevo;
    if (worker && worker.state === "installed") {
      try { worker.postMessage({ type: "SKIP_WAITING" }); } catch (_) { recargarPagina(); return; }
      // Lo normal es que controllerchange recargue; esto cubre al navegador
      // que no lo avise.
      setTimeout(recargarPagina, 6000);
    } else {
      recargarPagina(); // ya activa (otra pestaña) o reemplazada por una más nueva
    }
  }

  var recargandoPagina = false;
  function recargarPagina() {
    if (recargandoPagina) return;
    recargandoPagina = true;
    location.reload();
  }

  function decirEnPerfil(texto) {
    $("actualizacionEstado").textContent = texto;
    show($("actualizacionEstado"), !!texto);
  }

  async function buscarActualizacionDesdePerfil() {
    if (hayActualizacion()) { aplicarActualizacion(); return; }
    if (!actualizacion.reg) {
      decirEnPerfil("Este navegador no se actualiza solo. Cierre el portal y vuelva a abrirlo.");
      return;
    }
    if (!navigator.onLine || !internet.ok) {
      decirEnPerfil("Sin conexión: no se puede buscar ahora.");
      return;
    }

    var boton = $("btnBuscarActualizacion");
    var reg = actualizacion.reg;
    boton.disabled = true;
    decirEnPerfil("Buscando…");
    actualizacion.pedidaPorConductor = true;
    await buscarActualizacion();

    if (reg.installing) {
      // Al terminar de descargar, nuevaVersionLista la instala.
      decirEnPerfil("Descargando la versión nueva…");
    } else if (reg.waiting && navigator.serviceWorker.controller) {
      nuevaVersionLista(reg.waiting);
    } else if (!actualizacion.aplicando) {
      actualizacion.pedidaPorConductor = false;
      decirEnPerfil("Tiene la última versión (" + (cfg.APP_VERSION || "") + ").");
    }
    boton.disabled = false;
  }

  function initActualizaciones() {
    pintarVersion();
    $("btnActualizarAhora").addEventListener("click", aplicarActualizacion);
    $("btnBuscarActualizacion").addEventListener("click", buscarActualizacionDesdePerfil);

    if (!("serviceWorker" in navigator)) return;
    var sw = navigator.serviceWorker;
    var teniaControlador = !!sw.controller;

    sw.addEventListener("controllerchange", function () {
      if (actualizacion.aplicando) { recargarPagina(); return; }
      if (actualizacion.silenciosa || !teniaControlador) {
        // Activación sin recarga o primera instalación: la página ya está al día.
        actualizacion.silenciosa = false;
        teniaControlador = true;
        return;
      }
      // Otra pestaña del portal activó la versión nueva; esta sigue con la
      // vieja hasta recargar.
      actualizacion.recargar = true;
      vigilarActualizacion();
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        actualizacion.ocultoDesde = Date.now();
        return;
      }
      if (actualizacion.ocultoDesde && Date.now() - actualizacion.ocultoDesde >= ACTUALIZAR_TRAS_AUSENCIA_MS) {
        actualizacion.volvioEn = Date.now();
      }
      actualizacion.ocultoDesde = 0;
      buscarActualizacion();
    });

    function registrar() {
      sw.register("./sw.js", { scope: "./", updateViaCache: "none" })
        .then(function (reg) {
          actualizacion.reg = reg;
          if (reg.waiting && sw.controller) nuevaVersionLista(reg.waiting);
          seguirInstalacion(reg.installing); // revisión que el navegador ya había empezado
          reg.addEventListener("updatefound", function () { seguirInstalacion(reg.installing); });
          setInterval(function () {
            if (!document.hidden) buscarActualizacion();
          }, cfg.ACTUALIZACION_VERIFICAR_MS || 10 * 60 * 1000);
        })
        .catch(function (err) { console.warn("[portal] SW no registrado:", err); });
    }
    if (document.readyState === "complete") registrar();
    else window.addEventListener("load", registrar, { once: true });
  }

  // ------------------------------------------------------------------ boot
  function init() {
    initAuth();
    initIdentify();
    initNav();
    initPerfil();
    initRed();
    initUbicacion();
    initPwa();
    initActualizaciones();
    initMensajesModulos();
    initViajes();
    initTarjeta();
    initConfirmacionTiquetes();
    initPersonal();
    initNovedades();
    initNoticias();

    $("btnLogout").addEventListener("click", logout);
    $("btnReloadModule").addEventListener("click", recargarModulo);

    // Se lee el hash antes de resolver la sesión: como todavía no hay usuario,
    // aplicarHash() solo anota el destino en state.vista, y mostrarApp() lo
    // aplica al entrar. Así un acceso directo (#/asistencia) abre donde debe
    // sin depender de en qué orden terminen las promesas.
    aplicarHash();

    // Sesión existente: entramos directo sin pasar por el login.
    client.auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (session && session.user) {
        state.user = session.user;
        entrar();
      } else {
        mostrarLogin();
      }
    }).catch(function () {
      mostrarLogin();
    });

    // Primera visita: pedir la instalación desde ya, antes del login.
    setTimeout(pedirInstalacion, 2500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
