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
    ]);
    return {
      conductor: resultados[0],
      turnos: resultados[1].turnos,
      guardadoEn: resultados[1].guardadoEn,
      error: resultados[1].error,
      estado: resultados[2],
    };
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

  function mostrarConfirmacion(dni, ident) {
    identificacion = { dni: dni, conductor: ident.conductor, turnos: ident.turnos, estado: ident.estado };

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
  };

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
    $("topbarSubtitle").textContent = vista === "inicio" && state.vehiculo
      ? "Vehículo " + state.vehiculo
      : TITULOS[vista].sub;
    show($("btnReloadModule"), vista !== "inicio");

    if (vista !== "inicio") {
      crearIframe(vista);
      pintarBusEnBarras();
    }
    if (vista === "inicio") cargarInicio();

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
  // sistema externo no lo recibe, y la salida a otra pestaña por si su login
  // no funciona dentro del marco (Google no deja abrir el suyo en un iframe, y
  // Safari en iPhone puede bloquear sus cookies).
  function barraExterna(modulo) {
    var barra = document.createElement("div");
    barra.className = "externo-barra";
    barra.innerHTML =
      '<div class="externo-dato"><span>Seleccione el vehículo</span>' +
        "<strong data-bus-turno>" + escapeHtml(state.vehiculo || "—") + "</strong></div>" +
      '<a class="btn btn-ghost btn-sm" href="' + escapeHtml(modulo.src) + '" target="_blank" rel="noopener">' +
        "Abrir aparte</a>";
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
  // cargarTurno() es quien dispara cargarFila() y cargarViajes(), porque
  // los dos se ubican por el vehículo que da el turno: no tiene sentido
  // pedirlos antes.
  function cargarInicio() {
    pintarSaludo();
    cargarTurno();
    cargarJornada();
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
      cargarViajes();
      return;
    }

    if (state.turno) pintarTurno(state.turno); else esqueleto(box, "turno");
    cargarFila();
    cargarViajes();

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
        cargarViajes();
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

  function pintarTurno(turno) {
    var box = $("turnoBody");

    if (!turno) {
      box.innerHTML = '<p class="placeholder">No tienes turno programado para hoy.' +
        (state.vehiculo
          ? " Vehículo indicado: <strong>" + escapeHtml(state.vehiculo) + "</strong>."
          : "") +
        "</p>";
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
        : "");
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

  function pintarViajes() {
    var box = $("viajesBody");
    var lista = viajes.lista || [];
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
      var resFila = await conTiempoLimite(client.from(cfg.TABLA_ENTURNAMIENTO).select("*"));
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

      var fila = (resFila.data || [])
        .filter(function (r) {
          return !ocultos.has(String(r.vehicle_id || "") + "|" + String(r.llegada_aeropuerto || ""));
        })
        // FIFO por hora de llegada confirmada, igual que el módulo aeropuerto.
        .sort(function (a, b) {
          return String(a.llegada_aeropuerto || "").localeCompare(String(b.llegada_aeropuerto || ""));
        });

      var idx = fila.findIndex(function (r) {
        return normalizarInterno(r.interno) === normalizarInterno(interno);
      });

      if (idx < 0) {
        box.innerHTML =
          '<p class="placeholder">Tu vehículo (' + escapeHtml(interno) +
          ") no está en la fila del aeropuerto en este momento.</p>";
        return;
      }

      var mio = fila[idx];
      box.innerHTML =
        '<div class="fila-hero">' +
          '<div class="fila-puesto"><strong>' + (idx + 1) + "</strong><span>de " + fila.length + "</span></div>" +
          '<div class="fila-info">' +
            "<strong>Bus " + escapeHtml(mio.interno || interno) + "</strong>" +
            "<span>Llegó " + escapeHtml(haceCuanto(mio.llegada_aeropuerto) || horaCorta(mio.llegada_aeropuerto)) +
              (mio.itinerario ? " · " + escapeHtml(mio.itinerario) : "") + "</span>" +
          "</div>" +
        "</div>";
    } catch (err) {
      pintarErrorTarjeta(box, "No se pudo cargar la fila.", err, cargarFila);
    }
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
    show($("sinInternet"), true);
    try { $("btnReintentarInternet").focus(); } catch (_) {}
  }

  // Al volver: se quita el bloqueo y se pone al día lo que quedó quieto. Los
  // módulos abiertos no se recargan: si estaba a mitad de una marca, sigue
  // donde iba.
  function alRecuperarInternet() {
    show($("sinInternet"), false);
    if (state.user && !$("appView").hidden && state.vista === "inicio") cargarInicio();
    enviarConfirmacionesPendientes();
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
    var ocupado = ["bootOverlay", "perfilSheet", "tiquetesSheet", "sinInternet", "instalarSheet"]
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
    initPwa();
    initActualizaciones();
    initMensajesModulos();
    initViajes();
    initConfirmacionTiquetes();

    $("btnLogout").addEventListener("click", logout);
    $("btnReloadModule").addEventListener("click", recargarModulo);
    $("btnCambiarVehiculo").addEventListener("click", cambiarSeleccion);

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
