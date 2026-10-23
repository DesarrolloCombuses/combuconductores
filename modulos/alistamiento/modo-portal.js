/* ==========================================================================
   Modo portal - módulo de alistamiento (SICOV)

   Se carga siempre, pero solo actúa si la URL trae ?embed=portal, que es como
   el Portal del Conductor abre este módulo (v1.23.0). Abierto normalmente no
   toca nada.

   El formulario es el mismo de la app de alistamiento (assets/, sin cambios
   salvo el service worker en comun.js). Lo que se hace aquí, sin tocar su
   código:
     - la cédula con la que el conductor entró al portal va escrita (y fija);
     - la placa del bus de su turno va escogida (si hoy maneja otro, la cambia);
     - si ese bus ya tiene el alistamiento de hoy (lo hizo el del turno 1), en
       vez del formulario sale que ya está hecho, a qué hora y quién lo hizo;
     - al registrar, se le avisa al portal para que su Inicio pase a verde.

   Lo que alistamiento.js pide y recibe se mira envolviendo fetch: así se sabe
   la lista de placas (cada una con su interno) y cuándo quedó registrado.
   ========================================================================== */

(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  if (params.get("embed") !== "portal") return;

  var raiz = document.documentElement;
  raiz.setAttribute("data-embed", "portal");
  // Mientras se averigua si el bus ya está alistado, el formulario no se muestra: que no alcance a empezar a llenar
  // algo que no va a poder enviar.
  raiz.setAttribute("data-revisando", "");

  var RUTA = window.SICOV.API("sicov-alistar");
  var conductor = null;     // { dni, vehiculo, turno }, lo manda el portal
  var vehiculos = null;     // la lista del formulario: [{ placa, interno, ruta }]
  var aplicado = false;
  var reloj = null;

  function $(id) { return document.getElementById(id); }
  function soloDigitos(v) { return String(v == null ? "" : v).replace(/\D/g, ""); }
  function bus(v) { return String(v == null ? "" : v).trim().replace(/^0+/, ""); }
  function quitarRevisando() { raiz.removeAttribute("data-revisando"); }

  // ---- lo que pide y recibe alistamiento.js
  var fetchOriginal = window.fetch.bind(window);
  window.fetch = function (recurso, opciones) {
    var url = String((recurso && recurso.url) || recurso);
    var metodo = String((opciones && opciones.method) || (recurso && recurso.method) || "GET").toUpperCase();
    return fetchOriginal(recurso, opciones).then(function (resp) {
      if (metodo === "GET" && resp.ok && /\/sicov-alistar\/formulario$/.test(url)) {
        resp.clone().json().then(function (d) {
          vehiculos = (d && d.vehiculos) || [];
          aplicar();
        }).catch(function () {});
      }
      if (metodo === "POST" && resp.ok && /\/sicov-alistar\/registrar$/.test(url)) {
        resp.clone().json().then(function (d) {
          if (d && d.success) avisarPortal(d.alistamiento || {});
        }).catch(function () {});
      }
      return resp;
    });
  };

  // ---- lo que manda el portal
  window.addEventListener("message", function (event) {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.type !== "PORTAL_CONDUCTOR") return;
    conductor = data.payload || {};
    if (!bus(conductor.vehiculo)) quitarRevisando();
    aplicar();
  });

  try {
    window.parent.postMessage({ type: "PORTAL_PEDIR_CONDUCTOR" }, window.location.origin);
  } catch (_) {}

  // Si el portal no contesta o el formulario no carga (sin señal), que se vea lo que haya: el formulario o el error.
  setTimeout(function () { if (!conductor) quitarRevisando(); }, 4000);
  setTimeout(quitarRevisando, 12000);

  // El formulario ya pintó la lista de placas cuando el select tiene opciones.
  function listo() {
    var sel = $("placa");
    return !!(conductor && vehiculos && sel && sel.options.length > 1);
  }

  function aplicar() {
    if (aplicado || !conductor || !vehiculos) return;
    if (!listo()) {
      if (reloj) return;
      var intentos = 0;
      reloj = setInterval(function () {
        if (listo() || ++intentos > 75) {
          clearInterval(reloj);
          reloj = null;
          if (listo()) aplicar();
          else quitarRevisando();
        }
      }, 200);
      return;
    }
    aplicado = true;
    ponerCedula();
    ponerBus();
  }

  // La cédula con la que entró al portal: escrita y fija, como si la tecleara (el evento input hace que el formulario
  // busque el nombre en la nómina).
  function ponerCedula() {
    var input = $("cedula");
    var dni = soloDigitos(conductor.dni);
    if (!input || !dni) return;
    input.value = dni;
    input.readOnly = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function ponerBus() {
    var mio = bus(conductor.vehiculo);
    if (!mio) return;
    var sel = $("placa");
    var suyas = vehiculos.filter(function (v) { return bus(v.interno) === mio; });
    if (!suyas.length) {
      notaDelTurno("Su bus " + mio + " no está en la lista del alistamiento (la ruta Aeropuerto). " +
        "Escoja la placa del bus que va a manejar.");
      quitarRevisando();
      return;
    }
    // Las placas de su bus van arriba de la lista. Algunos buses tienen dos (una vieja): esas las escoge él.
    var primera = sel.options[1];
    suyas.forEach(function (v) {
      var op = Array.prototype.find.call(sel.options, function (o) { return o.value === v.placa; });
      if (op) sel.insertBefore(op, primera);
    });

    revisarHoy(suyas).then(function (ya) {
      if (ya) {
        mostrarHecho(mio, ya);
        return;
      }
      quitarRevisando();
      if (suyas.length === 1) {
        notaDelTurno("Bus de su turno: " + mio + ". Si hoy maneja otro, cambie la placa.");
        sel.value = suyas[0].placa;
        // El formulario comprueba otra vez y dice "Disponible para alistar hoy".
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        notaDelTurno("Su bus " + mio + " tiene " + suyas.length + " placas en la lista (" +
          suyas.map(function (v) { return v.placa; }).join(" y ") + "): escoja la que tiene pintada el bus.");
      }
    });
  }

  // ¿Alguna de las placas de su bus ya tiene el alistamiento de hoy? undefined si no se pudo saber.
  function revisarHoy(suyas) {
    return Promise.all(suyas.map(function (v) {
      return fetchOriginal(RUTA + "/hoy?placa=" + encodeURIComponent(v.placa), { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return d && d.yaRegistrado ? Object.assign({ placa: v.placa }, d.registro || {}) : null; })
        .catch(function () { return null; });
    })).then(function (lista) { return lista.find(Boolean) || null; });
  }

  // Una línea arriba del panel del vehículo: el bus del turno (la pista de la placa la usa el formulario).
  function notaDelTurno(texto) {
    var sel = $("placa");
    var caja = sel && sel.closest("label");
    if (!caja) return;
    var p = document.querySelector(".portal-turno");
    if (!p) {
      p = document.createElement("p");
      p.className = "portal-turno";
      caja.parentNode.insertBefore(p, caja);
    }
    p.textContent = texto;
  }

  function horaCol(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return "";
    return d.toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "numeric", minute: "2-digit", hour12: true });
  }

  // El turno 2 (o quien abra el módulo después): el bus ya está alistado hoy. Uno por bus y por día; no hay nada que
  // llenar (lo decidió el usuario el 22-oct-2026).
  function mostrarHecho(mio, ya) {
    ["formulario", "barra", "pendientes", "aviso"].forEach(function (id) { var el = $(id); if (el) el.hidden = true; });
    var hero = document.querySelector(".hero");
    if (hero) hero.hidden = true;
    var caja = document.createElement("section");
    caja.className = "panel portal-hecho";
    var icono = document.createElement("div");
    icono.className = "portal-hecho-icono";
    icono.setAttribute("aria-hidden", "true");
    icono.textContent = "✓";
    var h = document.createElement("h2");
    h.textContent = "El bus " + mio + " ya tiene el alistamiento de hoy";
    var dl = document.createElement("dl");
    [["Placa", ya.placa], ["Lo registró", ya.conductor], ["Hora", horaCol(ya.registrado_en)]].forEach(function (x) {
      if (!x[1]) return;
      var dt = document.createElement("dt");
      dt.textContent = x[0];
      var dd = document.createElement("dd");
      dd.textContent = x[1];
      dl.append(dt, dd);
    });
    var p = document.createElement("p");
    p.textContent = "Se hace uno por bus y por día. Si encuentra una falla en el bus, avísele al despachador.";
    caja.append(icono, h, dl, p);
    var envoltura = document.querySelector(".envoltura");
    envoltura.insertBefore(caja, envoltura.firstChild);
    quitarRevisando();
    // Que el Inicio del portal también lo sepa (sale en verde).
    avisarPortal({ placa: ya.placa, registrado_en: ya.registrado_en, yaEstaba: true });
  }

  function avisarPortal(registro) {
    try {
      window.parent.postMessage({ type: "PORTAL_ALISTAMIENTO_REGISTRADO", payload: registro }, window.location.origin);
    } catch (_) { /* el portal no está escuchando: no pasa nada */ }
  }
})();
