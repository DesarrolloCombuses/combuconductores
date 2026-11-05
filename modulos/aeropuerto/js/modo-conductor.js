/* ==========================================================================
   Modo conductor - módulo de despachos aeropuerto

   Se carga siempre, pero solo hace algo si la URL trae ?modo=conductor, que
   es como el Portal del Conductor embebe este módulo. Abierto normalmente
   (un despachador entrando a la app suelta) este archivo no toca nada.

   Lo estático lo resuelve css/modo-conductor.css. Aquí va lo que el CSS no
   puede: el atributo que activa esas reglas, forzar una pestaña visible de
   arranque, y bloquear los gestos de despacho que main.js engancha por
   delegación sobre elementos que se vuelven a crear en cada render.

   Insistimos: esto recorta la interfaz, no los permisos. Lo que un usuario
   puede escribir de verdad lo deciden las políticas RLS de Supabase.
   ========================================================================== */

(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  if (params.get("modo") !== "conductor") return;

  // Se pone cuanto antes para que el CSS aplique sin parpadeo. El script va
  // en el <head> justo después de la hoja de estilos.
  document.documentElement.setAttribute("data-modo", "conductor");

  var PESTANAS_PERMITIDAS = ["mapa", "listas", "turnos"];

  // ¿Heredamos sesión del portal? Portal e iframe son del mismo origen, así
  // que comparten localStorage y supabase-js guarda ahí la sesión bajo una
  // clave sb-<ref>-auth-token. Si no la encontramos, dejamos visible el login
  // del módulo (ver modo-conductor.css) en vez de mostrar un hueco vacío.
  function haySesionHeredada() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("sb-") === 0 && k.indexOf("-auth-token") > 0) return true;
      }
    } catch (_) {
      // Almacenamiento bloqueado: no podemos afirmar que haya sesión.
      return false;
    }
    return false;
  }

  if (!haySesionHeredada()) {
    document.documentElement.setAttribute("data-sesion", "no");
  }

  // Interceptamos en fase de captura y detenemos la propagación: así el
  // listener que main.js tiene en el documento nunca llega a ver el clic.
  // Cubre los elementos que se recrean en cada render, donde no basta con
  // esconderlos por CSS.
  // .bus-row (tabla de la fila) y .turno-stop (línea de turno sobre el mapa)
  // abren el modal de asignación con un listener puesto en el elemento mismo;
  // cortar en captura desde el documento evita que el evento llegue hasta él.
  var SELECTOR_BLOQUEADO =
    '.btn-assign, [data-action="assign"], [data-action="ocultar"], ' +
    '[data-action="cancelar"], #btnManualDispatch, .bus-row, .turno-stop';

  document.addEventListener("click", function (ev) {
    if (!ev.target.closest || !ev.target.closest(SELECTOR_BLOQUEADO)) return;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);

  // main.js también abre el modal de asignación con Enter/Espacio sobre una
  // fila (las hizo focusables con tabindex y role="button").
  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    if (!ev.target.closest || !ev.target.closest(".bus-row")) return;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);

  /* ------------------------------------------------------------------
     Listas: la fila del itinerario con que el conductor fue despachado

     El turno del conductor en el aeropuerto sale del itinerario con el que
     fue despachado hasta allá (Almacentro-Tunel-Aeropuerto,
     Nutibara-exposiciones-tunel-aeropuerto...), no de todo el aeropuerto.
     Ejemplo: si el 742 llegó por Almacentro-Tunel-Aeropuerto y es el cuarto
     de ese itinerario en llegar, ve "4 de 6", aunque en el aeropuerto haya
     diecisiete buses esperando.

     Por eso la lista muestra:
       - arriba, su posición: "4 de 6" y el itinerario;
       - la fila de SU itinerario, en orden de hora de llegada, numerada de
         1 a N y con su bus resaltado;
       - un botón para ver los demás itinerarios, cada uno con su propia
         numeración (por si quiere mirar).
     Si su bus no está en la fila, o el portal no tiene bus para él, se ven
     todos los itinerarios, cada uno con su numeración.

     El bus lo dice el portal: lo manda con un mensaje PORTAL_CONDUCTOR al
     cargar el módulo y cada vez que el conductor cambia de bus. Mientras
     llega, se toma el que el portal dejó guardado (mismo origen, mismo
     localStorage).

     main.js ya pinta un grupo por itinerario, pero numera por el "turno"
     global del programa. Aquí se toma lo que pintó y se rehace. Ojo: lo
     rehecho NO puede llevar la clase .itin-group, que es la que dice "main.js
     acaba de pintar" (ver reorganizarListas).

     Se trabaja sobre el DOM ya pintado en vez de tocar main.js: así el módulo
     sigue sirviendo igual a los despachadores cuando se abre suelto.
     ------------------------------------------------------------------ */

  // main.js pone este nombre a los buses que llegan sin itinerario.
  var SIN_ITINERARIO = "Sin itinerario";

  // Lo último que pintó main.js, ya leído: { itinerario: [buses...] }.
  // Se guarda para repintar cuando llega el bus del portal o se toca el botón
  // de ver los demás, sin esperar al próximo minuto.
  var ultimaFila = null;
  var miBus = busGuardadoPorElPortal();
  var verOtros = false;

  function escaparHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Igual que normalizarInterno() del portal: "0742", "742 " y "742" son el mismo bus.
  function normalizarInterno(v) {
    return String(v == null ? "" : v)
      .replace(/[^0-9A-Za-z]/g, "")
      .toUpperCase()
      .replace(/^0+(?=.)/, "");
  }

  function busGuardadoPorElPortal() {
    try {
      var sel = JSON.parse(localStorage.getItem("portal_seleccion") || "null");
      return sel && sel.vehiculo ? String(sel.vehiculo).trim() : null;
    } catch (_) {
      return null;
    }
  }

  window.addEventListener("message", function (ev) {
    if (ev.origin !== window.location.origin) return;
    var d = ev.data;
    if (!d || typeof d !== "object" || d.type !== "PORTAL_CONDUCTOR" || !d.payload) return;
    var nuevo = d.payload.vehiculo ? String(d.payload.vehiculo).trim() : null;
    if (normalizarInterno(nuevo) === normalizarInterno(miBus)) return;
    miBus = nuevo;
    verOtros = false;
    pintarLista();
  });

  // El timestamp real de llegada no está en ninguna celda, pero sí como
  // atributo del botón de ocultar que main.js pinta en cada fila.
  function llegadaDeFila(tr) {
    var btn = tr.querySelector('[data-action="ocultar"]');
    return btn ? btn.getAttribute("data-llegada") || "" : "";
  }

  function textoRuta(grupo) {
    var head = grupo.querySelector(".itin-head");
    if (!head) return "";
    // El encabezado trae el nombre y, dentro de un span, el contador.
    var clon = head.cloneNode(true);
    var contador = clon.querySelector(".itin-count");
    if (contador) contador.remove();
    return clon.textContent.trim();
  }

  function celdaEstado(tr) {
    var pill = tr.querySelector(".estado-pill, .estado-vacio");
    return pill ? pill.outerHTML : '<span class="estado-vacio">—</span>';
  }

  // Lee lo que pintó main.js. Devuelve null si no hay nada suyo que leer.
  function leerFilaDeMain(box) {
    var grupos = box.querySelectorAll(".itin-group");
    if (!grupos.length) return null;

    var porRuta = {};
    var hayFilas = false;
    Array.prototype.forEach.call(grupos, function (grupo) {
      var ruta = textoRuta(grupo) || SIN_ITINERARIO;
      Array.prototype.forEach.call(grupo.querySelectorAll("tr.bus-row"), function (tr) {
        var celdas = tr.querySelectorAll("td");
        if (celdas.length < 5) return;
        hayFilas = true;
        (porRuta[ruta] = porRuta[ruta] || []).push({
          llegada: llegadaDeFila(tr),
          hora: celdas[1].textContent.trim(),
          hace: celdas[2].textContent.trim(),
          bus: celdas[3].textContent.trim(),
          puesto: celdas[4].textContent.trim(),
          estado: celdaEstado(tr),
        });
      });
    });
    if (!hayFilas) return null;

    // FIFO dentro de cada itinerario: primero el que lleva más rato esperando.
    Object.keys(porRuta).forEach(function (ruta) {
      porRuta[ruta].sort(function (a, b) { return String(a.llegada).localeCompare(String(b.llegada)); });
    });
    return porRuta;
  }

  function reorganizarListas() {
    var box = document.getElementById("tablaBox");
    if (!box) return;

    // Si main.js no acaba de pintar (no hay .itin-group), no hay nada que
    // hacer. Esta salida es la que evita que el observador se dispare con
    // nuestros propios cambios.
    var leida = leerFilaDeMain(box);
    if (!leida) {
      // main.js pintó otra cosa ("Sin buses en la geocerca", cargando...):
      // lo guardado ya no vale y no hay que repintarlo encima.
      if (!box.querySelector(".lista-espera")) ultimaFila = null;
      return;
    }
    ultimaFila = leida;
    pintarLista();
  }

  function tablaDeRuta(ruta, lista, claseExtra) {
    var mio = normalizarInterno(miBus);
    var filas = lista.map(function (it, idx) {
      var esMio = mio && normalizarInterno(it.bus) === mio;
      return '<tr class="fila-espera' + (idx === 0 ? " primero" : "") + (esMio ? " mio" : "") + '">' +
        '<td class="pos"><span class="pos-num">' + (idx + 1) + "</span></td>" +
        '<td class="hora">' + escaparHtml(it.hora) + "</td>" +
        '<td class="hace">' + escaparHtml(it.hace) + "</td>" +
        '<td class="interno">' + escaparHtml(it.bus) + (esMio ? ' <span class="tu">Tú</span>' : "") + "</td>" +
        '<td class="col-puesto">' + escaparHtml(it.puesto) + "</td>" +
        '<td class="col-estado">' + it.estado + "</td>" +
      "</tr>";
    }).join("");

    return '<section class="ruta-grupo' + (claseExtra ? " " + claseExtra : "") + '">' +
      '<h3 class="ruta-head">' +
        '<span class="ruta-nombre">' + escaparHtml(ruta) + "</span>" +
        '<span class="ruta-count">' + lista.length + (lista.length === 1 ? " bus" : " buses") + "</span>" +
      "</h3>" +
      '<table class="arrivals">' +
        "<thead><tr>" +
          "<th>#</th><th>Hora</th><th>Hace</th><th>Bus</th>" +
          "<th>Puesto</th><th>Estado</th>" +
        "</tr></thead>" +
        "<tbody>" + filas + "</tbody>" +
      "</table>" +
    "</section>";
  }

  function pintarLista() {
    var box = document.getElementById("tablaBox");
    if (!box || !ultimaFila) return;

    // Los itinerarios van por nombre (siempre en el mismo orden, para que
    // nadie tenga que buscar el suyo) y los sin itinerario al final.
    var rutas = Object.keys(ultimaFila).sort(function (a, b) {
      if (a === SIN_ITINERARIO) return 1;
      if (b === SIN_ITINERARIO) return -1;
      return a.localeCompare(b, "es");
    });

    // ¿En qué itinerario y en qué posición está el bus del conductor?
    var mio = normalizarInterno(miBus);
    var miRuta = null;
    var miIdx = -1;
    if (mio) {
      rutas.some(function (ruta) {
        var i = ultimaFila[ruta].findIndex(function (it) { return normalizarInterno(it.bus) === mio; });
        if (i < 0) return false;
        miRuta = ruta;
        miIdx = i;
        return true;
      });
    }

    var html;
    if (miRuta) {
      var lista = ultimaFila[miRuta];
      var yo = lista[miIdx];
      var antes = miIdx;
      var otras = rutas.filter(function (r) { return r !== miRuta; });
      var busesOtras = otras.reduce(function (n, r) { return n + ultimaFila[r].length; }, 0);

      html =
        '<div class="mi-turno' + (antes === 0 ? " sigue" : "") + '">' +
          '<div class="mi-turno-pos"><strong>' + (miIdx + 1) + "</strong><span>de " + lista.length + "</span></div>" +
          '<div class="mi-turno-info">' +
            "<strong>" + (antes === 0
              ? "¡Sigues tú!"
              : (antes === 1 ? "Falta 1 bus antes que tú" : "Faltan " + antes + " buses antes que tú")) + "</strong>" +
            "<span>Bus " + escaparHtml(yo.bus) + " · despachado por <b>" + escaparHtml(miRuta) + "</b></span>" +
            "<span>Llegó " + escaparHtml(yo.hora) + (yo.hace ? " · " + escaparHtml(yo.hace) : "") + "</span>" +
          "</div>" +
        "</div>" +
        tablaDeRuta(miRuta, lista, "ruta-mia") +
        (otras.length
          ? '<button type="button" class="ver-otros" aria-expanded="' + (verOtros ? "true" : "false") + '">' +
              (verOtros ? "Ocultar los otros itinerarios" : "Ver los otros itinerarios (" + busesOtras +
                (busesOtras === 1 ? " bus" : " buses") + ")") +
            "</button>" +
            (verOtros ? '<div class="otros-itinerarios">' +
              otras.map(function (r) { return tablaDeRuta(r, ultimaFila[r]); }).join("") + "</div>" : "")
          : "");
    } else {
      var aviso = miBus
        ? "Tu bus " + escaparHtml(miBus) + " no está esperando turno en el aeropuerto en este momento. " +
          "Abajo están los que esperan, cada itinerario con su fila."
        : "Abajo están los buses que esperan turno, cada itinerario con su fila.";
      html = '<p class="mi-turno-aviso">' + aviso + "</p>" +
        rutas.map(function (r) { return tablaDeRuta(r, ultimaFila[r]); }).join("");
    }

    box.innerHTML = '<div class="lista-espera">' + html + "</div>";
  }

  function observarListas() {
    var box = document.getElementById("tablaBox");
    if (!box) return false;

    reorganizarListas();

    // Botón de ver los otros itinerarios. Se escucha en la caja, que no se
    // reemplaza, porque lo de adentro se repinta cada minuto.
    box.addEventListener("click", function (ev) {
      if (!ev.target.closest || !ev.target.closest(".ver-otros")) return;
      verOtros = !verOtros;
      pintarLista();
    });

    if (typeof MutationObserver !== "undefined") {
      // main.js repinta esta caja en cada actualización de la fila (realtime,
      // botón de refrescar, cambio de pestaña); hay que rehacerla cada vez.
      new MutationObserver(function () { reorganizarListas(); })
        .observe(box, { childList: true });
    }
    return true;
  }

  // Si el módulo arranca en una pestaña que aquí está oculta (por ejemplo
  // porque quedó recordada de otra sesión), lo mandamos al mapa. Se hace
  // cuando main.js ya pintó las pestañas.
  function normalizarPestanaActiva() {
    var activa = document.querySelector(".tab.active");
    if (!activa) return false;

    var nombre = activa.dataset.tab;
    if (PESTANAS_PERMITIDAS.indexOf(nombre) >= 0) return true;

    var mapa = document.querySelector('.tab[data-tab="mapa"]');
    if (mapa) mapa.click();
    return true;
  }

  /* ------------------------------------------------------------------
     Nombres pensados para el conductor

     "Listas" y "Turnos" son palabras del despachador. Para el conductor la
     primera es la lista de enturnamiento del aeropuerto y la segunda, la
     programación. Solo cambia el texto visible: data-tab y los ids quedan
     igual, así main.js sigue funcionando sin enterarse.
     ------------------------------------------------------------------ */
  var NOMBRE_LISTA = "Lista de enturnamiento aeropuerto";
  var NOMBRE_PROGRAMACION = "Programación";

  function renombrarSecciones() {
    [["listas", NOMBRE_LISTA], ["turnos", NOMBRE_PROGRAMACION]].forEach(function (par) {
      var boton = document.querySelector('.tab[data-tab="' + par[0] + '"]');
      if (!boton) return;
      var etiqueta = boton.querySelector("span:not(.tab-badge)");
      if (etiqueta) etiqueta.textContent = par[1];
      boton.setAttribute("title", par[1]);
    });

    var tituloProgramacion = document.querySelector("#paneTurnos .despachos-titles h2");
    if (tituloProgramacion) tituloProgramacion.textContent = NOMBRE_PROGRAMACION;

    // Título propio de la lista, entre la línea de turno y el contador.
    var stats = document.querySelector("#paneListas .stats");
    if (stats && !document.querySelector(".lista-enturnamiento-titulo")) {
      var titulo = document.createElement("h2");
      titulo.className = "lista-enturnamiento-titulo";
      titulo.textContent = NOMBRE_LISTA;
      stats.parentNode.insertBefore(titulo, stats);
    }
  }

  function alEstarListo() {
    // Las pestañas y los títulos vienen en el HTML: se renombran de una vez.
    renombrarSecciones();

    // main.js arranca la interfaz después de autenticar, así que al cargar el
    // documento puede que las pestañas y la tabla todavía no existan.
    // Reintentamos un rato corto hasta que las dos cosas estén enganchadas.
    var pestanasListas = normalizarPestanaActiva();
    var listasListas = observarListas();
    if (pestanasListas && listasListas) return;

    var intentos = 0;
    var timer = setInterval(function () {
      if (!pestanasListas) pestanasListas = normalizarPestanaActiva();
      if (!listasListas) listasListas = observarListas();
      if ((pestanasListas && listasListas) || ++intentos > 40) clearInterval(timer);
    }, 250);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", alEstarListo, { once: true });
  } else {
    alEstarListo();
  }
})();
