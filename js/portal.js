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
    empujarConductor("asistencia");
    pintarPerfil();
    enviarConfirmacionesPendientes(); // lo confirmado sin señal en la sesión anterior
    enviarSubidasPendientes();        // los códigos de gestor leídos sin señal
    refrescarGestores(false);         // para leer códigos de gestor sin internet

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
    aeropuerto: { titulo: "Aeropuerto", sub: "Enturnamiento y mapa en vivo" },
    tiquetes: { titulo: "Tiquetes", sub: "Validación en Distribusion" },
    tarjeta: { titulo: "Mi tarjeta", sub: "Cívica, pasajeros y tiquetes de cada despacho" },
  };

  // Vistas del propio portal (sin iframe): Inicio y Mi tarjeta.
  var VISTAS_NATIVAS = { inicio: true, tarjeta: true };

  function irA(vista, desdeHash, confirmado) {
    // El perfil es una hoja, no una vista: no cambia el panel de fondo.
    if (vista === "perfil") { abrirPerfil(); return; }
    if (!TITULOS[vista]) vista = "inicio";

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
      b.classList.toggle("active", b.dataset.nav === vista);
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
    if (state.iframes[idModulo]) return state.iframes[idModulo];

    var modulo = cfg.MODULOS.find(function (m) { return m.id === idModulo; });
    if (!modulo) return null;

    var panel = document.querySelector('[data-panel="' + idModulo + '"]');
    if (!panel) return null;

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
  // vuelva a pedir (ver modo-portal.js dentro del módulo).
  function empujarConductor(idModulo) {
    if (idModulo !== "asistencia" || !state.dni) return;
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
          // El módulo de asistencia arrancó y pide la cédula elegida.
          empujarConductor("asistencia");
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
    cargarTurno();
    cargarJornada();
    pintarResumenGestores();
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
      return;
    }

    if (state.turno) pintarTurno(state.turno); else esqueleto(box, "turno");
    cargarFila();
    cargarTarjeta();
    cargarViajes();
    cargarDocumentos();

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
  // tiquetes escaneó en Distribusion; las cívicas de un viaje salen solas: la
  // lectura del despacho siguiente menos la suya.
  //
  // Para que la auditoría sirva, el número del sensor de un viaje no se le
  // muestra al conductor hasta que guarda el suyo (si lo viera, lo copiaría).
  // La plata que ve es la de sus pasajeros: pasajeros x el pasaje del día.
  //
  // Los viajes los publica el programa de enturnes en tarjeta_viajes, y la
  // vista v_tarjeta_viajes los junta con las lecturas, los pasajeros del
  // conductor, los tiquetes, los daños del validador y el pasaje. Lo guardado
  // no se cambia desde aquí: si quedó mal lo corrige un despachador, y queda
  // quién y por qué (almacentro/enturnes/sql/tarjeta_despacho.sql).
  var CAMPOS_TARJETA = "clave,dia,interno,viaje,sin_despacho,hora_salida,pasajeros,subidas,itinerario,ruta," +
    "civica_lectura,civicas,estado_civica,lectura_corregida,tiquetes_escaneados,tiquetes_corregidos,estado_calculo," +
    "pasajeros_conductor,pasajeros_conductor_corregidos,tarifa";

  var tarj = {
    clave: null, vehiculo: null, dia: null, filas: null, danos: [], guardadoEn: null, error: null,
    cargandoClave: null,
    borrador: {},      // { clave: { civica, pasajeros, tiquetes } } lo que va escribiendo: sobrevive a un refresco
    confirmando: null, // { clave, civica, pasajeros, tiquetes, avisos }: el "¿Guardar?" a la vista
    guardando: null,   // clave del viaje que se está guardando
    mensaje: null,     // { clave, tipo: ok|error, texto } debajo de un renglón
  };

  // Lo que dice cada estado de la cívica (estado_civica de la vista), en las
  // palabras del conductor.
  var ESTADO_CIVICA = {
    ok: { nivel: "ok", texto: "Cuadra" },
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

  async function consultarTarjeta(vehiculo, dia) {
    var internos = variantesInterno(vehiculo);
    var res = await Promise.all([
      conTiempoLimite(
        client.from(cfg.VISTA_TARJETA_VIAJES)
          .select(CAMPOS_TARJETA)
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
    ]);
    if (res[0].error) throw res[0].error;
    // Los daños son un extra: si esa consulta falla, la tarjeta sirve igual.
    return { filas: res[0].data || [], danos: res[1].error ? [] : (res[1].data || []) };
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
      tarj.guardadoEn = tarj.filas ? cache.guardadoEn : null;
      tarj.error = null;
      tarj.borrador = {};
      tarj.confirmando = null;
      tarj.mensaje = null;
    }

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
        tipo: "bajo", clave: ant.fila.clave,
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

  // Más de 19 (el tope de la tarjeta de papel) es casi seguro un número mal
  // escrito. No se compara con el sensor: lo del conductor es su cuenta, y
  // control es el que compara.
  function avisosDePasajeros(n) {
    if (n > 19) {
      return [{
        tipo: "salto",
        texto: "Son " + n + " pasajeros y el tope de la tarjeta es 19. Revisa el número.",
      }];
    }
    return [];
  }

  // Más tiquetes que pasajeros es casi seguro un número mal escrito. Se compara
  // con los pasajeros que escribió el conductor (no con el sensor, que no ve).
  function avisosDeTiquetes(n, pasajeros) {
    if (pasajeros != null && n > pasajeros) {
      return [{
        tipo: "salto",
        texto: "Son más tiquetes (" + n + ") que los pasajeros que escribiste (" + pasajeros + "). " +
          "Revisa los números.",
      }];
    }
    return [];
  }

  function enViajes(n) { return n === 1 ? "1 viaje" : n + " viajes"; }

  // 380000 -> "$380.000"
  function pesos(n) { return "$" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "."); }

  // Lo que dice el conductor en el día: sus pasajeros y la plata (pasajeros x
  // el pasaje). Los viajes en que no ha escrito no cuentan.
  function totalesDelConductor(filas) {
    return filas.reduce(function (t, f) {
      if (f.pasajeros_conductor == null) return t;
      t.pasajeros += Number(f.pasajeros_conductor);
      if (f.tarifa != null) { t.plata += Number(f.pasajeros_conductor) * Number(f.tarifa); t.conPlata = true; }
      return t;
    }, { pasajeros: 0, plata: 0, conPlata: false });
  }

  // "a", "a y b", "a, b y c"
  function listaY(partes) {
    return partes.length < 2 ? partes.join("") : partes.slice(0, -1).join(", ") + " y " + partes[partes.length - 1];
  }

  function faltaAlgo(f) {
    return f.civica_lectura == null || f.pasajeros_conductor == null || f.tiquetes_escaneados == null;
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
    var faltan = faltanEnTarjeta(filas);
    var suyo = totalesDelConductor(filas);
    var texto, nivel;
    if (!filas.length) {
      nivel = "falta";
      texto = "Todavía no hay viajes hoy en el bus " + tarj.vehiculo + ".";
    } else if (faltan) {
      nivel = "pronto";
      texto = "Falta " + faltan + ".";
    } else {
      nivel = "ok";
      texto = "Tarjeta al día: " + enViajes(filas.length) + ", " + suyo.pasajeros + " pasajeros" +
        (suyo.conPlata ? ", " + pesos(suyo.plata) : "") + ".";
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

    // Si estaba escribiendo un número, el campo vuelve a quedar listo.
    var activo = document.activeElement;
    var enfocado = activo && box.contains(activo) && activo.getAttribute("data-lectura")
      ? { clave: activo.getAttribute("data-lectura"), campo: activo.getAttribute("data-campo") }
      : null;

    var n = filas.length;
    // Los totales son los del conductor: el del sensor dejaría sacar, por resta,
    // el número de un viaje que todavía no ha escrito.
    var suyo = totalesDelConductor(filas);
    var tiquetes = filas.reduce(function (s, f) { return s + Number(f.tiquetes_escaneados || 0); }, 0);
    var primeraFalta = filas.findIndex(faltaAlgo);
    var faltan = faltanEnTarjeta(filas);

    var html =
      '<div class="viajes-hero">' +
        '<div class="viajes-total"><strong>' + n + "</strong><span>" + (n === 1 ? "viaje" : "viajes") + "</span></div>" +
        '<div class="viajes-info">' +
          "<strong>" + suyo.pasajeros + (suyo.pasajeros === 1 ? " pasajero" : " pasajeros") +
            (suyo.conPlata ? " · " + pesos(suyo.plata) : "") +
            (n ? " · " + tiquetes + (tiquetes === 1 ? " tiquete" : " tiquetes") : "") + "</strong>" +
          "<span>" +
            (!n ? "Todavía no hay viajes hoy" : faltan ? "Falta " + faltan : "Tarjeta completa") +
          "</span>" +
        "</div>" +
      "</div>";

    if (tarj.guardadoEn && (tarj.error || !navigator.onLine)) {
      html += '<p class="viajes-aviso">' + (navigator.onLine ? "No se pudo actualizar" : "Sin conexión") +
        ": es la tarjeta guardada a las " + escapeHtml(horaDeMs(tarj.guardadoEn)) + ".</p>";
    }

    if (n) {
      html += '<ol class="tarj-lista">' +
        filas.map(function (f, i) { return renglonTarjeta(f, i, i === primeraFalta); }).join("") +
        "</ol>";
    } else {
      html += '<p class="viajes-nota">Cada viaje aparece aquí un par de minutos después del despacho.</p>';
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
    pintarResumenTarjeta();

    if (enfocado) {
      Array.prototype.some.call(box.querySelectorAll("[data-lectura]"), function (campo) {
        if (campo.getAttribute("data-lectura") !== enfocado.clave ||
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
        (f.lectura_corregida ? '<span class="tv-chip" data-nivel="espera">Corregida por el despachador</span>' : "") +
      "</div>";
    }
    if (!faltaPasajeros) {
      html += '<div class="tv-civica">' +
        "<span>Pasajeros que llevaste <b>" + escapeHtml(f.pasajeros_conductor) + "</b></span>" +
        (f.tarifa != null
          ? '<span class="tv-plata">' + pesos(Number(f.pasajeros_conductor) * Number(f.tarifa)) + "</span>"
          : "") +
        (f.pasajeros_conductor_corregidos ? '<span class="tv-chip" data-nivel="espera">Corregidos por el despachador</span>' : "") +
      "</div>";
    }
    if (!faltaTiquetes) {
      html += '<div class="tv-civica">' +
        "<span>Tiquetes escaneados <b>" + escapeHtml(f.tiquetes_escaneados) + "</b></span>" +
        (f.tiquetes_corregidos ? '<span class="tv-chip" data-nivel="espera">Corregidos por el despachador</span>' : "") +
      "</div>";
    }

    // Lo que falta: el "¿Guardar?" o el formulario
    var c = tarj.confirmando;
    if (falta && c && c.clave === f.clave) {
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
        "<p>Después solo el despachador lo puede corregir.</p>" +
        '<div class="tv-acciones">' +
          '<button class="btn btn-primary btn-sm" type="button" data-confirmar="' + escapeHtml(f.clave) + '"' +
            (tarj.guardando ? " disabled" : "") + ">" + (guardando ? "Guardando…" : "Sí, guardar") + "</button>" +
          '<button class="btn btn-ghost btn-sm" type="button" data-cambiar="' + escapeHtml(f.clave) + '"' +
            (guardando ? " disabled" : "") + ">Cambiar</button>" +
        "</div>" +
      "</div>";
    } else if (falta) {
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
        '<button class="btn btn-primary btn-sm tv-guardar" type="submit">Guardar</button>' +
        (esLaQueSigue && faltaPasajeros
          ? '<p class="tv-ayuda">Pasajeros: cuántas personas llevaste en este viaje, contadas por ti.</p>'
          : "") +
        (esLaQueSigue && faltaTiquetes
          ? '<p class="tv-ayuda">Tiquetes: los que escaneaste en Distribusion para este viaje. Si no hubo, pon 0.</p>'
          : "") +
      "</form>";
    }

    var m = tarj.mensaje;
    if (m && m.clave === f.clave) {
      html += '<p class="tv-msg" data-tipo="' + m.tipo + '" role="status">' + escapeHtml(m.texto) + "</p>";
    }
    return '<li class="tv"' + (falta ? " data-falta" : "") + ">" + html + "</li>";
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
      : "";
    if (falla) {
      tarj.mensaje = { clave: clave, tipo: "error", texto: falla };
      pintarTarjeta();
      return;
    }

    // Los tiquetes se comparan con los pasajeros que dijo: los de ahora o los ya guardados.
    var suyos = pasajeros ? Number(pasajeros) : f.pasajeros_conductor != null ? Number(f.pasajeros_conductor) : null;
    var avisos = (civica ? avisosDeLectura(filas, i, Number(civica)) : [])
      .concat(pasajeros ? avisosDePasajeros(Number(pasajeros)) : [])
      .concat(tiquetes ? avisosDeTiquetes(Number(tiquetes), suyos) : []);
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
        // Se ve al instante; las cívicas del viaje anterior llegan con la recarga.
        f.civica_lectura = c.civica;
        f.estado_civica = "pendiente_cierre";
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
    box.addEventListener("input", function (ev) {
      var clave = ev.target.getAttribute && ev.target.getAttribute("data-lectura");
      if (!clave) return;
      var limpio = ev.target.value.replace(/\D/g, "");
      if (limpio !== ev.target.value) ev.target.value = limpio;
      tarj.borrador[clave] = tarj.borrador[clave] || {};
      tarj.borrador[clave][ev.target.getAttribute("data-campo")] = limpio;
      if (tarj.mensaje && tarj.mensaje.clave === clave && tarj.mensaje.tipo === "error") {
        tarj.mensaje = null;
        var msg = ev.target.closest(".tv") && ev.target.closest(".tv").querySelector(".tv-msg");
        if (msg) msg.remove();
      }
    });
    box.addEventListener("submit", function (ev) {
      var form = ev.target.closest ? ev.target.closest(".tv-form") : null;
      if (!form) return;
      ev.preventDefault();
      prepararLectura(form.getAttribute("data-clave"));
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
      }
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
    // mientras confirma o guarda un número, no se le mueve la pantalla.
    setInterval(function () {
      if (!state.user || !VISTAS_NATIVAS[state.vista] || document.hidden || $("appView").hidden) return;
      if (tarj.confirmando || tarj.guardando) return;
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
      else esqueleto(box, "lineas");
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

  // ============================================================ GESTORES
  // Los gestores se suben a los buses y el sensor de la puerta los cuenta como
  // pasajeros. El gestor muestra un código firmado con la huella de su celular
  // (js/gestores.js) y el conductor lo lee aquí; la tarjeta lo resta del viaje.
  //  - Gestor: desde la v1.11.0 usa SU PROPIA app (gestores/), sin correo ni
  //    clave: así no tiene el usuario Combuses con que se abre Control.
  //  - Conductor: "Leer código del gestor". Funciona sin internet: la lista de
  //    gestores aprobados queda guardada en el teléfono y lo leído espera en
  //    cola hasta que haya señal, como las confirmaciones de tiquetes.
  var LS_GESTORES = "portal_gestores_aprobados";
  var LS_GESTORES_USADOS = "portal_gestores_usados";
  var LS_SUBIDAS = "portal_gestores_subidas_pendientes";
  var LS_SUBIDAS_LEIDAS = "portal_gestores_leidas";
  var MAX_SUBIDAS_PENDIENTES = 300;
  var enviandoSubidas = false;
  var refrescandoGestores = null;
  var scriptsCargados = {};

  function leerJson(clave, porDefecto) {
    try {
      var v = JSON.parse(localStorage.getItem(clave) || "null");
      return v == null ? porDefecto : v;
    } catch (_) { return porDefecto; }
  }

  function guardarJson(clave, valor) {
    try { localStorage.setItem(clave, JSON.stringify(valor)); return true; } catch (_) { return false; }
  }

  // Las librerías del QR se cargan solo cuando hacen falta. El service worker
  // las tiene guardadas, así que también sirven sin internet.
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

  function apagarCamara(stream) {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
  }

  // ---------------------------------------------- conductor: leer el código
  function listaGestores() {
    var g = leerJson(LS_GESTORES, null);
    return g && Array.isArray(g.lista) ? g.lista : [];
  }

  // Los gestores aprobados, con su llave y su foto: se guardan en el teléfono
  // para revisar los códigos sin internet.
  function refrescarGestores(forzar) {
    var guardado = leerJson(LS_GESTORES, null);
    var fresco = guardado && Date.now() - guardado.guardadoEn < (cfg.GESTORES_REFRESCAR_MS || 2 * HORA_MS);
    if (!state.user || !navigator.onLine || (fresco && !forzar)) return Promise.resolve(listaGestores());
    if (refrescandoGestores) return refrescandoGestores;
    refrescandoGestores = (async function () {
      try {
        var res = await conTiempoLimite(client.rpc(cfg.RPC_GESTORES_APROBADOS), 15000);
        if (res.error) throw res.error;
        var lista = (res.data || []).map(function (g) {
          return {
            dni: String(g.dni),
            nombre: g.nombre || "",
            cargo: g.cargo || "",
            llave_publica: g.llave_publica,
            selfie: /^data:image\//.test(g.selfie || "") ? g.selfie : "",
          };
        });
        guardarJson(LS_GESTORES, { guardadoEn: Date.now(), lista: lista });
        return lista;
      } catch (err) {
        console.warn("[portal] lista de gestores:", err && err.message ? err.message : err);
        return listaGestores();
      } finally {
        refrescandoGestores = null;
      }
    })();
    return refrescandoGestores;
  }

  // Cada código sirve una sola vez: los ya leídos en este celular (un día).
  function nonceUsado(nonce) {
    return leerJson(LS_GESTORES_USADOS, []).some(function (u) { return u.n === nonce; });
  }

  function anotarNonce(nonce) {
    var desde = Date.now() - DIA_MS;
    var lista = leerJson(LS_GESTORES_USADOS, []).filter(function (u) { return u.t > desde; });
    lista.push({ n: nonce, t: Date.now() });
    guardarJson(LS_GESTORES_USADOS, lista.slice(-500));
  }

  var lector = { stream: null, activo: false, detector: null, lienzo: null, timer: null };

  async function abrirLector() {
    show($("lectorResultado"), false);
    show($("lectorOtro"), false);
    show($("lectorCamara"), true);
    show($("lectorAyuda"), true);
    show($("lectorSheet"), true);

    if (!state.vehiculo) {
      show($("lectorCamara"), false);
      show($("lectorAyuda"), false);
      mostrarResultadoLector(false, "Primero confirme su bus", "",
        "Toque Perfil, Cambiar de conductor, y escriba el vehículo que maneja hoy.", "");
      return;
    }
    refrescarGestores(false);

    try {
      lector.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
    } catch (_) {
      show($("lectorCamara"), false);
      show($("lectorAyuda"), false);
      mostrarResultadoLector(false, "No se pudo abrir la cámara", "", "Dele permiso de cámara al portal y vuelva a intentar.", "");
      show($("lectorOtro"), true);
      return;
    }
    if ($("lectorSheet").hidden) { apagarCamara(lector.stream); lector.stream = null; return; }
    var v = $("lectorVideo");
    v.srcObject = lector.stream;
    try { await v.play(); } catch (_) { /* algunos navegadores arrancan solos */ }

    // El lector del propio teléfono si lo tiene (Chrome en Android); si no, jsQR.
    lector.detector = null;
    if ("BarcodeDetector" in window) {
      try {
        var formatos = await window.BarcodeDetector.getSupportedFormats();
        if (formatos.indexOf("qr_code") >= 0) lector.detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      } catch (_) { /* sin lector propio */ }
    }
    if (!lector.detector) {
      try { await cargarScript("./js/vendor/jsQR.min.js"); } catch (err) {
        pararLector();
        mostrarResultadoLector(false, "No se pudo abrir el lector", "", String(err && err.message || err), "");
        return;
      }
    }
    lector.activo = true;
    buscarCodigo();
  }

  async function buscarCodigo() {
    if (!lector.activo) return;
    var v = $("lectorVideo");
    var texto = null;
    try {
      if (v.readyState >= 2 && v.videoWidth) {
        if (lector.detector) {
          var hallados = await lector.detector.detect(v);
          if (hallados && hallados.length) texto = hallados[0].rawValue;
        } else if (window.jsQR) {
          var escala = Math.min(1, 800 / Math.max(v.videoWidth, v.videoHeight));
          var w = Math.round(v.videoWidth * escala);
          var h = Math.round(v.videoHeight * escala);
          lector.lienzo = lector.lienzo || document.createElement("canvas");
          lector.lienzo.width = w;
          lector.lienzo.height = h;
          var ctx = lector.lienzo.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(v, 0, 0, w, h);
          var r = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
          if (r && r.data) texto = r.data;
        }
      }
    } catch (_) { /* un cuadro malo: se sigue con el próximo */ }
    if (!lector.activo) return;
    if (texto) { await procesarCodigo(texto); return; }
    lector.timer = setTimeout(buscarCodigo, 200);
  }

  function pararLector() {
    lector.activo = false;
    clearTimeout(lector.timer);
    apagarCamara(lector.stream);
    lector.stream = null;
    try { $("lectorVideo").srcObject = null; } catch (_) {}
  }

  function cerrarLector() {
    pararLector();
    show($("lectorSheet"), false);
    pintarResumenGestores();
  }

  async function procesarCodigo(texto) {
    pararLector();
    show($("lectorCamara"), false);
    show($("lectorAyuda"), false);
    show($("lectorOtro"), true);

    var res = await GestoresQR.revisar(texto, listaGestores(), { usado: nonceUsado });
    if (!res.ok && res.motivo === "no_aprobado" && navigator.onLine) {
      // Lo pudieron aprobar hace poco: se pide la lista otra vez y se revisa de nuevo.
      res = await GestoresQR.revisar(texto, await refrescarGestores(true), { usado: nonceUsado });
    }
    if (res.motivo === "no_es") {
      mostrarResultadoLector(false, "No es un código de gestor", "", res.texto,
        "Pídale que abra Mi código en el Portal del Conductor.");
      return;
    }
    if (res.motivo === "usado") {
      mostrarResultadoLector(false, "Ese código ya se leyó", "",
        "Ya quedó guardado en este celular. Cada código sirve una sola vez.", "");
      return;
    }

    // Lo demás queda guardado, también lo que no pasó: control revisa los intentos raros.
    var guardado = guardarSubida(res, texto);
    if (res.ok) anotarNonce(res.codigo.nonce);
    var sinSenal = !navigator.onLine || !internet.ok;
    if (res.ok) {
      var g = res.gestor;
      mostrarResultadoLector(true, "Gestor verificado", g.nombre || "Gestor",
        capitalizarPalabras(g.cargo || "Gestor") + " · subió a las " + horaDeMs(Date.now()) + " al bus " + state.vehiculo,
        (guardado ? "Quedó guardado" : "No se pudo guardar en el celular") +
        (sinSenal ? "; se envía solo cuando vuelva la señal." : ".") +
        " Mire que la foto sea la persona que tiene enfrente.", g.selfie);
    } else {
      mostrarResultadoLector(false, "No se pudo verificar", "", res.texto,
        "Quedó anotado para que control lo revise. Si se sube, cuéntelo como pasajero.");
    }
    pintarResumenGestores();
  }

  function mostrarResultadoLector(ok, titulo, nombre, texto, nota, foto) {
    var box = $("lectorResultado");
    box.dataset.ok = String(!!ok);
    box.innerHTML =
      (foto ? '<img alt="Foto del gestor">' : "") +
      '<p class="resultado-titulo">' + (ok ? "✓ " : "✗ ") + escapeHtml(titulo) + "</p>" +
      (nombre ? '<p class="resultado-nombre">' + escapeHtml(nombre) + "</p>" : "") +
      (texto ? '<p class="resultado-texto">' + escapeHtml(texto) + "</p>" : "") +
      (nota ? '<p class="resultado-nota">' + escapeHtml(nota) + "</p>" : "");
    if (foto) box.querySelector("img").src = foto;   // por propiedad: nunca como HTML
    show(box, true);
  }

  function guardarSubida(res, texto) {
    var c = res.codigo;
    var pos = ubicacion.posicion && Date.now() - ubicacion.ultimaMs < 3 * 60 * 1000 ? ubicacion.posicion : null;
    var pendientes = leerJson(LS_SUBIDAS, []);
    pendientes.push({
      id_local: idLocal(),
      dni_gestor: c.dni,
      codigo: String(texto).slice(0, 4000),
      marcado_en: new Date(c.t).toISOString(),
      leido_en: new Date().toISOString(),
      interno: String(state.vehiculo || "").trim().slice(0, 20),
      dni_conductor: state.dni || "",
      lat: pos ? pos.lat : null,
      lon: pos ? pos.lng : null,
      precision_m: pos ? pos.precision : null,
      en_el_bus: res.ok ? "ok" : res.motivo,
    });
    var ok = guardarJson(LS_SUBIDAS, pendientes.slice(-MAX_SUBIDAS_PENDIENTES));
    var hoy = hoyColombia();
    var leidas = leerJson(LS_SUBIDAS_LEIDAS, []).filter(function (l) { return l.fecha === hoy; });
    leidas.push({ fecha: hoy, ok: !!res.ok });
    guardarJson(LS_SUBIDAS_LEIDAS, leidas);
    enviarSubidasPendientes();
    return ok;
  }

  // Como las confirmaciones de tiquetes: en orden, y un duplicado (23505)
  // cuenta como enviado. Un renglón que la base nunca va a aceptar (dato
  // inválido) se descarta para no trancar los demás.
  async function enviarSubidasPendientes() {
    if (enviandoSubidas || !navigator.onLine || !state.user) return;
    if (!leerJson(LS_SUBIDAS, []).length) return;

    enviandoSubidas = true;
    try {
      while (true) {
        var pendientes = leerJson(LS_SUBIDAS, []);
        if (!pendientes.length) break;
        var registro = pendientes[0];
        var res = await conTiempoLimite(client.from(cfg.TABLA_GESTORES_SUBIDAS).insert(registro), 10000);
        var codigo = res.error ? String(res.error.code || "") : "";
        if (res.error && codigo !== "23505" && !/^22|^23514$/.test(codigo)) {
          console.warn("[portal] código de gestor en espera:", res.error.message || res.error);
          break;
        }
        if (res.error && codigo !== "23505") console.warn("[portal] código de gestor descartado:", res.error.message);
        guardarJson(LS_SUBIDAS, leerJson(LS_SUBIDAS, []).filter(function (r) { return r.id_local !== registro.id_local; }));
      }
    } catch (err) {
      console.warn("[portal] código de gestor en espera:", err && err.message ? err.message : err);
    } finally {
      enviandoSubidas = false;
      pintarResumenGestores();
    }
  }

  function pintarResumenGestores() {
    var el = $("gestorResumen");
    if (!el) return;
    var hoy = hoyColombia();
    var leidos = leerJson(LS_SUBIDAS_LEIDAS, []).filter(function (l) { return l.fecha === hoy && l.ok; }).length;
    var pendientes = leerJson(LS_SUBIDAS, []).length;
    var partes = [];
    if (leidos) partes.push(leidos === 1 ? "Hoy leyó 1 gestor" : "Hoy leyó " + leidos + " gestores");
    if (pendientes) partes.push(pendientes === 1 ? "1 por enviar" : pendientes + " por enviar");
    el.textContent = partes.join(" · ");
    show(el, partes.length > 0);
  }

  // En la pantalla de "Sin conexión": leer el código de un gestor sí funciona sin internet.
  function pintarBotonesSinInternet() {
    var enApp = !!state.user && !!state.dni && !$("appView").hidden;
    show($("btnSinInternetLeer"), enApp);
  }

  function initGestores() {
    $("btnLeerGestor").addEventListener("click", abrirLector);
    $("btnSinInternetLeer").addEventListener("click", abrirLector);
    $("lectorCerrar").addEventListener("click", cerrarLector);
    $("lectorListo").addEventListener("click", cerrarLector);
    $("lectorOtro").addEventListener("click", function () { pararLector(); abrirLector(); });

    window.addEventListener("online", enviarSubidasPendientes);
    // La lista de gestores aprobados se mantiene al día mientras el portal está abierto.
    setInterval(function () {
      if (!document.hidden && state.user) refrescarGestores(false);
    }, 15 * 60 * 1000);
    // En segundo plano no se deja la cámara prendida.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && !$("lectorSheet").hidden) cerrarLector();
    });
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
    enviarSubidasPendientes();
    if (state.user) refrescarGestores(false);
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
    var ocupado = ["bootOverlay", "perfilSheet", "tiquetesSheet", "sinInternet", "sinUbicacion", "instalarSheet"]
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
    var hojaAbierta = ["perfilSheet", "tiquetesSheet", "instalarSheet"].some(function (id) {
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
    initGestores();

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
