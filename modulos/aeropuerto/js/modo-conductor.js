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
     Listas: una sola fila de espera, en orden de llegada

     El módulo original agrupa la tabla por itinerario y numera 1..N DENTRO
     de cada grupo, que es lo que necesita un despachador. Al conductor eso
     le miente: ve "1" cuando en realidad es el octavo de la fila.

     Aquí se rehace la tabla como una sola lista ordenada por hora de llegada
     al aeropuerto -- el mismo criterio FIFO que usa el módulo -- numerada de
     1 a N de corrido, y con la ruta como una columna más. Los chips de filtro
     por ruta sobran y se ocultan por CSS.

     Se trabaja sobre el DOM ya pintado en vez de tocar main.js: así el módulo
     sigue sirviendo igual a los despachadores cuando se abre suelto.
     ------------------------------------------------------------------ */

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

  function reorganizarListas() {
    var box = document.getElementById("tablaBox");
    if (!box) return;

    // Si no hay grupos, o ya está rehecha, no hay nada que hacer. Esta salida
    // es la que evita que el observador se dispare con sus propios cambios.
    var grupos = box.querySelectorAll(".itin-group");
    if (!grupos.length) return;

    var items = [];
    Array.prototype.forEach.call(grupos, function (grupo) {
      var ruta = textoRuta(grupo);
      Array.prototype.forEach.call(grupo.querySelectorAll("tr.bus-row"), function (tr) {
        var celdas = tr.querySelectorAll("td");
        if (celdas.length < 5) return;
        items.push({
          llegada: llegadaDeFila(tr),
          hora: celdas[1].textContent.trim(),
          hace: celdas[2].textContent.trim(),
          bus: celdas[3].textContent.trim(),
          puesto: celdas[4].textContent.trim(),
          estado: celdaEstado(tr),
          ruta: ruta,
        });
      });
    });

    if (!items.length) return;

    // FIFO: primero el que lleva más rato esperando.
    items.sort(function (a, b) { return String(a.llegada).localeCompare(String(b.llegada)); });

    var filas = items.map(function (it, idx) {
      return '<tr class="fila-espera">' +
        '<td class="pos">' + (idx + 1) + "</td>" +
        '<td class="hora">' + it.hora + "</td>" +
        '<td class="hace">' + it.hace + "</td>" +
        '<td class="interno">' + it.bus + "</td>" +
        '<td class="col-ruta">' + it.ruta + "</td>" +
        "<td>" + it.puesto + "</td>" +
        '<td class="col-estado">' + it.estado + "</td>" +
      "</tr>";
    }).join("");

    box.innerHTML =
      '<div class="lista-espera">' +
        '<table class="arrivals">' +
          "<thead><tr>" +
            "<th>#</th><th>Hora</th><th>Hace</th><th>Bus</th>" +
            "<th>Ruta</th><th>Puesto</th><th>Estado</th>" +
          "</tr></thead>" +
          "<tbody>" + filas + "</tbody>" +
        "</table>" +
      "</div>";
  }

  function observarListas() {
    var box = document.getElementById("tablaBox");
    if (!box) return false;

    reorganizarListas();

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
