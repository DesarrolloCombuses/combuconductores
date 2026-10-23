/* ---------------------------------------------------------------------------
   Utilidades compartidas + ciclo de vida de la PWA
   ---------------------------------------------------------------------------
   Lo que usan los dos formularios: configuracion, avisos, estado de conexion,
   y el manejo de versiones del service worker.

   Se expone como window.SICOV para que cada formulario solo tenga que
   preocuparse de lo suyo.
--------------------------------------------------------------------------- */

(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // Configuracion
  // -------------------------------------------------------------------------
  // La URL del proyecto no es un secreto: es el endpoint publico. La anon key
  // tampoco -- va en frontends por diseño y no da acceso a nada por si sola,
  // porque las tablas tienen RLS y los registros pasan por edge functions.
  const CONFIG = {
    SUPABASE_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co",
    SUPABASE_ANON_KEY: "PEGAR_AQUI_LA_ANON_KEY",
  };

  const API = (fn) => `${CONFIG.SUPABASE_URL}/functions/v1/${fn}`;

  const $ = (id) => document.getElementById(id);

  // -------------------------------------------------------------------------
  // Avisos
  // -------------------------------------------------------------------------

  function mostrarAviso(texto, clase) {
    const el = $("aviso");
    if (!el) return;
    el.textContent = texto;
    el.className = "aviso " + (clase || "error");
    el.hidden = false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function ocultarAviso() {
    const el = $("aviso");
    if (el) el.hidden = true;
  }

  // -------------------------------------------------------------------------
  // Modal
  // -------------------------------------------------------------------------
  // Para los dos momentos en que una linea de texto en el flujo no alcanza:
  // cuando el alistamiento queda registrado, y cuando la placa elegida ya se
  // alisto hoy. Los dos exigen que el conductor pare y lea.
  //
  // Se construye en el DOM al vuelo en vez de venir en cada HTML: asi los dos
  // formularios lo tienen sin repetir el marcado, y no hay un div escondido
  // esperando en paginas que no lo usan.
  //
  // Sin boton de cerrar en la esquina a proposito. Las acciones son
  // explicitas: registrar otro, elegir otra placa, cerrar. Una X invita a
  // descartar sin leer, que es justo lo que no interesa aqui.

  let modalAbierto = null;

  function modal({ tipo, titulo, mensaje, datos, acciones }) {
    cerrarModal();

    const fondo = document.createElement("div");
    fondo.className = "modal-fondo";

    const caja = document.createElement("div");
    caja.className = "modal";
    caja.setAttribute("role", "dialog");
    caja.setAttribute("aria-modal", "true");
    caja.setAttribute("aria-labelledby", "modal-titulo");

    const icono = document.createElement("div");
    icono.className = "modal-icono";
    icono.dataset.tipo = tipo || "bien";
    icono.setAttribute("aria-hidden", "true");
    icono.textContent = tipo === "aviso" ? "!" : tipo === "error" ? "×" : "✓";

    const h = document.createElement("h2");
    h.id = "modal-titulo";
    h.className = "modal-titulo";
    h.textContent = titulo || "";

    caja.append(icono, h);

    if (mensaje) {
      const p = document.createElement("p");
      p.className = "modal-mensaje";
      p.textContent = mensaje;
      caja.appendChild(p);
    }

    // Los datos van en una lista de definiciones y no en un parrafo: el
    // conductor los usa como comprobante, y a veces les hace foto.
    if (datos && datos.length) {
      const dl = document.createElement("dl");
      dl.className = "modal-datos";
      for (const [clave, valor] of datos) {
        if (valor === null || valor === undefined || valor === "") continue;
        const dt = document.createElement("dt");
        dt.textContent = clave;
        const dd = document.createElement("dd");
        dd.textContent = String(valor);
        dl.append(dt, dd);
      }
      if (dl.children.length) caja.appendChild(dl);
    }

    const pie = document.createElement("div");
    pie.className = "modal-acciones";
    for (const acc of acciones || []) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = acc.primario ? "primario ancho" : "discreto ancho";
      b.textContent = acc.texto;
      b.addEventListener("click", () => {
        if (typeof acc.alTocar === "function") acc.alTocar();
      });
      pie.appendChild(b);
    }
    if (pie.children.length) caja.appendChild(pie);

    fondo.appendChild(caja);
    document.body.appendChild(fondo);
    modalAbierto = fondo;

    // Que el fondo no se desplace mientras el modal esta abierto.
    document.body.style.overflow = "hidden";
    // El foco al primer boton: quien navega con teclado o lector de pantalla
    // aterriza en la accion, no al principio de la pagina.
    pie.querySelector("button")?.focus();

    return fondo;
  }

  function cerrarModal() {
    if (modalAbierto) {
      modalAbierto.remove();
      modalAbierto = null;
    }
    document.body.style.overflow = "";
  }

  // -------------------------------------------------------------------------
  // Limpieza de datos
  // -------------------------------------------------------------------------

  /** Solo digitos: evita que "12.345.678" llegue al servidor con puntos. */
  function soloDigitos(valor) {
    return String(valor || "").replace(/[^\d]/g, "");
  }

  /**
   * Quita el estado que la operacion pega al nombre ("[nombre] [INCAPACITADO]").
   * Ese corchete es dato de salud de una persona identificada: dato sensible
   * bajo la Ley 1581 de 2012. No tiene por que aparecer en una lista abierta.
   */
  function nombreLimpio(valor) {
    return String(valor || "").replace(/\s*\[[^\]]*\]\s*/g, " ").trim();
  }

  // -------------------------------------------------------------------------
  // Estado de conexion
  // -------------------------------------------------------------------------
  // Una cinta pegada arriba, no un aviso en el flujo: el conductor tiene que
  // poder ver que esta sin red en cualquier momento del formulario, no solo
  // cuando lo abrio.
  //
  // Se puede llenar el formulario sin red -- el catalogo viene del cache del
  // service worker -- pero enviarlo no. Un alistamiento es una afirmacion ante
  // el regulador con una restriccion de uno por placa y dia; guardarlo aqui
  // para mandarlo luego acabaria en duplicados o en un "crei que lo envie".
  // Por eso la cinta dice exactamente eso y lo escrito no se pierde.

  // navigator.onLine solo dice que hay una interfaz de red levantada. En el
  // patio, el telefono queda enganchado a un wifi sin salida mas veces de las
  // que queda sin señal, y ahi onLine responde true mientras ninguna peticion
  // llega. Por eso ademas se prueba contra el servidor de verdad.
  //
  // La prueba es un HEAD al endpoint publico con un tiempo de espera corto: si
  // responde cualquier cosa, incluido un error, la red funciona. Lo que
  // interesa es que el paquete haya ido y vuelto, no que la respuesta sea 200.
  const TIEMPO_PRUEBA_MS = 6000;
  let ultimaPrueba = { cuando: 0, hubo: true };

  async function comprobarConexion(forzar) {
    if (!navigator.onLine) {
      ultimaPrueba = { cuando: Date.now(), hubo: false };
      pintarConexion();
      return false;
    }

    // Una respuesta de hace menos de 15 segundos se reusa: encadenar pruebas
    // en cada pulsacion gastaria datos del conductor sin decir nada nuevo.
    if (!forzar && Date.now() - ultimaPrueba.cuando < 15000) return ultimaPrueba.hubo;

    const corte = new AbortController();
    const reloj = setTimeout(() => corte.abort(), TIEMPO_PRUEBA_MS);
    let hubo = false;
    try {
      await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/sicov-alistar/formulario`, {
        method: "HEAD",
        cache: "no-store",
        signal: corte.signal,
      });
      hubo = true;
    } catch (_) {
      // Abortado por tiempo, DNS caido, portal cautivo que corta la conexion:
      // desde aqui todos significan lo mismo, que no se puede enviar.
      hubo = false;
    } finally {
      clearTimeout(reloj);
    }

    ultimaPrueba = { cuando: Date.now(), hubo };
    pintarConexion();
    return hubo;
  }

  function pintarConexion() {
    const cinta = $("cinta-conexion");
    if (!cinta) return;

    const sinInterfaz = !navigator.onLine;
    // Una prueba fallida reciente vale como "sin red" aunque el sistema diga
    // que hay: es justo el caso del wifi sin salida.
    const pruebaFallida = !ultimaPrueba.hubo && Date.now() - ultimaPrueba.cuando < 60000;

    if (!sinInterfaz && !pruebaFallida) {
      cinta.hidden = true;
      document.documentElement.removeAttribute("data-sinred");
      return;
    }

    cinta.textContent = sinInterfaz
      ? "Sin conexión — puedes llenar el formulario, pero no enviarlo hasta recuperar señal."
      : "La red no responde — puedes seguir llenando; al enviar se vuelve a intentar.";
    cinta.className = "cinta sinred";
    cinta.hidden = false;
    // Marca en la raiz, para que el CSS pueda apagar el boton de envio sin que
    // cada formulario tenga que enterarse.
    document.documentElement.dataset.sinred = "si";
  }

  // Al volver la interfaz se prueba de verdad: el evento 'online' dispara en
  // cuanto el wifi engancha, que es antes de que haya salida a internet.
  window.addEventListener("online", () => comprobarConexion(true));
  window.addEventListener("offline", pintarConexion);

  // Al volver a la app desde segundo plano. El telefono pudo cambiar de red o
  // perderla mientras estaba guardado en el bolsillo, y ningun evento de los
  // de arriba dispara en ese caso.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") comprobarConexion(true);
  });

  // -------------------------------------------------------------------------
  // Service worker y versiones
  // -------------------------------------------------------------------------

  // Cada formulario puede declarar si tiene trabajo a medias, para que una
  // actualizacion no recargue la pagina y se lleve lo que el conductor llevaba
  // escrito. Por defecto se asume que no hay nada que perder.
  let hayTrabajoSinGuardar = () => false;

  let recargando = false;
  let registro = null;

  /** Aplica el worker en espera. La recarga la dispara controllerchange. */
  function aplicarActualizacion() {
    if (!registro || !registro.waiting) return;
    pararCuenta();
    const cinta = $("cinta-version");
    if (cinta) {
      cinta.textContent = "Actualizando…";
      cinta.className = "cinta nueva";
    }
    registro.waiting.postMessage({ tipo: "SKIP_WAITING" });
  }

  // -------------------------------------------------------------------------
  // Aviso de version nueva, con cuenta atras
  // -------------------------------------------------------------------------
  // La cuenta atras solo corre cuando no hay nada que perder. Con el
  // formulario a medias, una recarga automatica se lleva los puntos ya
  // marcados, y el conductor no tiene por que pagar con su trabajo el momento
  // en que se publico una version. Ahi el aviso se queda quieto y espera.

  const SEGUNDOS_CUENTA = 10;
  let relojCuenta = null;
  let pospuesta = false;

  function pararCuenta() {
    clearInterval(relojCuenta);
    relojCuenta = null;
  }

  function anunciarVersionNueva() {
    const cinta = $("cinta-version");
    if (!cinta) {
      // Pagina sin cinta: no hay donde avisar, y esperar indefinidamente
      // dejaria la version vieja para siempre.
      aplicarActualizacion();
      return;
    }
    if (pospuesta) return;
    marcarVersion("nueva");

    const conTrabajo = hayTrabajoSinGuardar();
    cinta.className = "cinta nueva";
    cinta.hidden = false;
    cinta.textContent = "";

    // Barra que se vacia con la cuenta. Un numero solo no se percibe mientras
    // se mira otra cosa; la barra se ve de reojo.
    const barra = document.createElement("div");
    barra.className = "cinta-barra";
    barra.setAttribute("aria-hidden", "true");

    const texto = document.createElement("span");
    texto.className = "cinta-texto";

    const acciones = document.createElement("span");
    acciones.className = "cinta-acciones";

    const ahora = document.createElement("button");
    ahora.type = "button";
    ahora.textContent = conTrabajo ? "Actualizar" : "Ahora";
    ahora.addEventListener("click", aplicarActualizacion);
    acciones.appendChild(ahora);

    if (conTrabajo) {
      texto.textContent = "Hay una versión nueva. Se instala cuando termines.";
      cinta.append(texto, acciones);
      return;
    }

    const luego = document.createElement("button");
    luego.type = "button";
    luego.className = "discreta";
    luego.textContent = "Luego";
    luego.addEventListener("click", () => {
      pararCuenta();
      pospuesta = true;
      cinta.hidden = true;
      // Queda instalada y esperando: entra sola la proxima vez que se abra la
      // app. "Luego" aplaza el corte, no la actualizacion.
      marcarVersion("pendiente");
    });
    acciones.append(luego);

    cinta.append(barra, texto, acciones);

    let restan = SEGUNDOS_CUENTA;
    const pintar = () => {
      texto.textContent = `Versión nueva · se instala en ${restan} s`;
      barra.style.setProperty("--restante", (restan / SEGUNDOS_CUENTA) * 100 + "%");
    };
    pintar();

    pararCuenta();
    relojCuenta = setInterval(() => {
      restan -= 1;
      if (restan <= 0) {
        pararCuenta();
        aplicarActualizacion();
        return;
      }
      // Si empezo a llenar el formulario durante la cuenta, se para: ya hay
      // algo que perder.
      if (hayTrabajoSinGuardar()) {
        pararCuenta();
        texto.textContent = "Hay una versión nueva. Se instala cuando termines.";
        barra.remove();
        luego.remove();
        ahora.textContent = "Actualizar";
        return;
      }
      pintar();
    }, 1000);
  }

  function vigilarRegistro(reg) {
    registro = reg;

    // Ya hay una version instalada esperando de una visita anterior.
    if (reg.waiting) anunciarVersionNueva();

    reg.addEventListener("updatefound", () => {
      const nuevo = reg.installing;
      if (!nuevo) return;
      nuevo.addEventListener("statechange", () => {
        // 'installed' con un controller ya presente significa version nueva
        // esperando. Sin controller es la primera instalacion, que no se
        // anuncia: no hay nada que actualizar.
        if (nuevo.state === "installed" && navigator.serviceWorker.controller) {
          anunciarVersionNueva();
        }
      });
    });

    // Buscar actualizaciones al volver a la app y cada media hora: la app
    // instalada puede quedarse abierta dias, y sin esto no se enteraria de una
    // version nueva hasta que alguien la cierre.
    const buscar = () => reg.update().catch(() => {});
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") buscar();
    });
    setInterval(buscar, 30 * 60 * 1000);
  }

  async function registrarServiceWorker() {
    if (!("serviceWorker" in navigator)) return;

    // Una sola recarga cuando el worker nuevo toma el control. El guardia
    // evita el bucle de recargas que sale si dos eventos llegan juntos.
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (recargando) return;
      recargando = true;
      window.location.reload();
    });

    try {
      const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      vigilarRegistro(reg);
      mostrarVersion();
    } catch (e) {
      // Sin service worker la app funciona igual, solo pierde el modo sin red.
      // No vale la pena molestar al usuario con esto.
      console.warn("[sicov] no se pudo registrar el service worker:", e);
    }
  }

  // -------------------------------------------------------------------------
  // Version visible
  // -------------------------------------------------------------------------
  // Se le pregunta al worker en vez de guardar el numero tambien aqui: dos
  // copias acabarian discrepando, y la que importa es la que atiende. Si el
  // pie dijera 1.7 mientras el worker sirve 1.6, el dato no serviria para lo
  // unico que se usa, que es saber que version tiene un telefono concreto
  // cuando alguien reporta algo raro.

  let versionActual = null;

  /** Pinta el estado del indicador: al dia, version nueva lista, o sin SW. */
  function marcarVersion(estado) {
    const caja = $("version-caja");
    if (caja) caja.dataset.estado = estado;
    const nota = $("version-nota");
    if (!nota) return;
    nota.textContent =
      estado === "nueva" || estado === "pendiente"
        ? "versión nueva lista"
        : estado === "sinsw"
          ? "sin modo sin red"
          : "al día";
  }

  function mostrarVersion() {
    const pie = $("version");
    if (!pie) return;

    const sw = navigator.serviceWorker.controller;
    if (!sw) {
      // Primera visita: el worker se instalo pero todavia no controla esta
      // pagina. Se sabra al recargar.
      pie.textContent = "—";
      marcarVersion("sinsw");
      return;
    }

    const canal = new MessageChannel();
    canal.port1.onmessage = (ev) => {
      if (ev.data?.tipo !== "VERSION") return;
      versionActual = ev.data.version;
      pie.textContent = "v" + versionActual;
      if (!registro || !registro.waiting) marcarVersion("aldia");
    };
    sw.postMessage({ tipo: "VERSION" }, [canal.port2]);
  }

  /** Busca una version nueva a mano. Lo dispara el toque en el indicador. */
  async function buscarActualizacion() {
    const nota = $("version-nota");
    if (!registro) {
      if (nota) nota.textContent = "sin modo sin red";
      return;
    }
    if (nota) nota.textContent = "buscando…";
    try {
      await registro.update();
      // update() resuelve tanto si hay version nueva como si no; si la hay, el
      // evento updatefound ya habra llamado a anunciarVersionNueva.
      if (!registro.waiting && nota) {
        // Se vuelve a permitir el aviso: si pospuso y luego pregunta a mano,
        // es que ahora si quiere saber.
        pospuesta = false;
        nota.textContent = "al día";
      }
    } catch (_) {
      if (nota) nota.textContent = "no se pudo comprobar";
    }
  }

  // -------------------------------------------------------------------------
  // Arranque
  // -------------------------------------------------------------------------

  pintarConexion();
  // Una prueba al abrir, sin bloquear el arranque: si la red esta caida, el
  // conductor lo sabe antes de llenar cuarenta puntos y no al tocar Registrar.
  comprobarConexion(true);
  // Dentro del Portal del Conductor (copia del modulo, v1.23.0) el service worker es el del portal: uno propio en
  // esta carpeta le quitaria el control de estas paginas. Es el unico cambio a este archivo.
  if (new URLSearchParams(location.search).get("embed") !== "portal") registrarServiceWorker();

  // El indicador de version es un boton: al tocarlo busca actualizaciones. Es
  // la via para que alguien de soporte pueda decir "toca el numero de abajo"
  // sin tener que explicar como se desinstala una PWA.
  const cajaVersion = $("version-caja");
  if (cajaVersion) cajaVersion.addEventListener("click", buscarActualizacion);

  window.SICOV = {
    CONFIG,
    API,
    $,
    mostrarAviso,
    ocultarAviso,
    modal,
    cerrarModal,
    soloDigitos,
    nombreLimpio,
    hayConexion: () => navigator.onLine,
    /** Prueba la red de verdad contra el servidor. Devuelve una promesa. */
    comprobarConexion,
    /** Version que esta sirviendo el worker, o null si todavia no respondio. */
    version: () => versionActual,
    /** Busca una version nueva a mano. */
    buscarActualizacion,
    /** Declara como sabe este formulario si tiene trabajo a medias. */
    registrarGuardia(fn) {
      if (typeof fn === "function") hayTrabajoSinGuardar = fn;
    },
  };
})();
