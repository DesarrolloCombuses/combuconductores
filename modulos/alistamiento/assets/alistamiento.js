/* ---------------------------------------------------------------------------
   Formulario de alistamiento diario
   ---------------------------------------------------------------------------
   Lo llena el conductor en el movil, sin login. La autorizacion la pone el
   servidor: solo acepta placas que existen en la flota y actividades del
   catalogo oficial de la Supertransporte.
--------------------------------------------------------------------------- */

(function () {
  "use strict";

  const { API, $, mostrarAviso, ocultarAviso, soloDigitos, nombreLimpio } = window.SICOV;
  const RUTA = API("sicov-alistar");

  const estado = {
    actividades: [],
    marcas: new Map(),
    // Lo ya resuelto por /conductor, para no repetir la consulta mientras el
    // conductor corrige un digito y vuelve atras.
    nombresVistos: new Map(),
    // placa -> interno, para que el comprobante diga "EQR790 · interno 717".
    // El conductor reconoce su bus por el interno, no por la placa.
    internos: new Map(),
    // nombre del grupo -> { caja, cuerpo, cuenta, todoBien, actividades }.
    // El acordeon consulta esto en cada marca; recorrer el DOM 40 veces por
    // toque se sentia en los telefonos viejos.
    grupos: new Map(),
    // Autorreporte: null = sin responder, true = si, false = no.
    apto: { descanso: null, sustancias: null },
    enviando: false,
    enviado: false,
  };

  // Si hay algo marcado o escrito, una actualizacion de la app no debe
  // recargar la pagina y llevarse el trabajo. Despues de enviar ya no importa.
  window.SICOV.registrarGuardia(() => {
    if (estado.enviado) return false;
    return (
      estado.marcas.size > 0 ||
      estado.apto.descanso !== null ||
      estado.apto.sustancias !== null ||
      !!$("placa")?.value ||
      !!$("cedula")?.value ||
      !!$("observaciones")?.value
    );
  });

  // -------------------------------------------------------------------------
  // Carga inicial
  // -------------------------------------------------------------------------

  async function cargar() {
    try {
      const resp = await fetch(RUTA + "/formulario");
      const datos = await resp.json();
      if (!resp.ok || !datos.success) {
        throw new Error(datos.message || "No se pudo cargar el formulario.");
      }

      const selPlaca = $("placa");
      for (const v of datos.vehiculos) {
        if (v.interno) estado.internos.set(v.placa, v.interno);
        const op = document.createElement("option");
        op.value = v.placa;
        op.textContent = v.interno ? `${v.placa} — interno ${v.interno}` : v.placa;
        selPlaca.appendChild(op);
      }

      // Aqui ya no se pinta ninguna lista de conductores: el formulario no
      // recibe la nomina. El nombre se resuelve de a uno contra la cedula que
      // el conductor digita.

      estado.actividades = datos.actividades || [];
      pintarChecklist();

      $("cargando").hidden = true;
      $("formulario").hidden = false;
      // La barra de envio NO se muestra todavia: aparece junto con el resto
      // del formulario, cuando la declaracion este respondida. Un boton
      // Registrar flotando sobre dos preguntas sin contestar invita a tocarlo
      // para nada.
      pintarEstadoDeclaracion();

      if (!datos.listo) {
        mostrarAviso(
          "La plataforma todavía no está lista para recibir registros: " +
            (datos.faltante || []).join("; ") + ". Avisa al administrador.",
          "info",
        );
        $("enviar").disabled = true;
        return;
      }

      actualizarProgreso();
    } catch (e) {
      $("cargando").hidden = true;
      mostrarAviso(e.message || "No se pudo conectar. Revisa tu señal e intenta de nuevo.");
    }
  }

  // -------------------------------------------------------------------------
  // Validacion
  // -------------------------------------------------------------------------
  // El error va pegado a su campo y no en un aviso suelto arriba: con cuatro
  // campos y cuarenta puntos, "faltan datos" obliga a buscar a mano cual es.
  //
  // Nada se marca mientras se escribe por primera vez. Un campo vacio que
  // todavia no se ha tocado no es un error, es un campo pendiente; pintarlo de
  // rojo al abrir el formulario convierte el rojo en ruido y deja de leerse.
  // Despues del primer intento de enviar, el campo ya corregido se limpia solo.

  const CAMPOS = ["placa", "cedula", "kilometraje", "apto-descanso", "apto-sustancias"];
  let intentoDeEnvio = false;

  /** La caja del campo. Se busca por [data-campo] y no por el id del control,
      porque las declaraciones son un fieldset con botones, sin un input que
      llevara el id. */
  function cajaDe(campo) {
    return document.querySelector(`[data-campo="${campo}"]`);
  }

  function ponerError(campo, texto) {
    const el = $("err-" + campo);
    if (el) {
      el.textContent = texto;
      el.hidden = false;
    }
    const caja = cajaDe(campo);
    if (caja) caja.dataset.error = "si";
    const control = $(campo);
    if (control) control.setAttribute("aria-invalid", "true");
  }

  function quitarError(campo) {
    const el = $("err-" + campo);
    if (el) el.hidden = true;
    const caja = cajaDe(campo);
    if (caja) delete caja.dataset.error;
    const control = $(campo);
    if (control) control.removeAttribute("aria-invalid");
  }

  /**
   * Revisa el formulario entero y devuelve lo que falta, en el orden en que
   * aparece en pantalla. Devolver la lista completa y no el primer fallo es
   * deliberado: corregir de a uno, con un viaje al servidor entre cada
   * intento, es lo que hace que un formulario se sienta hostil.
   */
  function revisar() {
    const faltas = [];
    const placa = $("placa").value;
    const cedula = soloDigitos($("cedula").value);
    const nombre = $("nombre").value.trim();
    const km = soloDigitos($("kilometraje").value);

    if (!placa) {
      faltas.push({ campo: "placa", texto: "Falta elegir la placa del vehículo." });
    }

    if (!cedula) {
      faltas.push({ campo: "cedula", texto: "Falta la cédula del conductor." });
    } else if (cedula.length < 6) {
      faltas.push({ campo: "cedula", texto: "La cédula está incompleta: son al menos 6 dígitos." });
    } else if (!nombre) {
      // Sin nombre, la cedula no quedo verificada contra la nomina. El
      // servidor lo rechazaria igual con un 403; se corta aqui para no hacerle
      // perder el viaje ni el checklist ya marcado.
      faltas.push({
        campo: "cedula",
        texto: "Esa cédula no corresponde a un conductor activo. Revisa el número.",
      });
    }

    // El kilometraje es opcional, pero si se escribe tiene que ser creible: un
    // digito de mas en el tablero convierte el historico del vehiculo en algo
    // que no sirve para programar el mantenimiento.
    if (km && Number(km) > 3000000) {
      faltas.push({
        campo: "kilometraje",
        texto: "Ese kilometraje parece muy alto. Revisa el número.",
      });
    }

    if (estado.apto.descanso === null) {
      faltas.push({
        campo: "apto-descanso",
        texto: "Falta responder la pregunta sobre descanso y fatiga.",
      });
    }
    if (estado.apto.sustancias === null) {
      faltas.push({
        campo: "apto-sustancias",
        texto: "Falta responder la pregunta sobre alcohol y sustancias.",
      });
    }

    const sinMarcar = estado.actividades.filter((a) => !estado.marcas.has(a.id));
    if (sinMarcar.length > 0) {
      const grupos = [...new Set(sinMarcar.map((a) => a.grupo || "Otros"))];
      faltas.push({
        grupo: grupos[0],
        cuenta: sinMarcar.length,
        texto:
          sinMarcar.length === 1
            ? `Falta 1 punto por verificar, en ${grupos[0].toLowerCase()}.`
            : `Faltan ${sinMarcar.length} puntos por verificar, en ${grupos.length === 1 ? grupos[0].toLowerCase() : grupos.length + " bloques"}.`,
      });
    }

    return faltas;
  }

  /** Pinta lo que falta. Con `llevar`, ademas desplaza al primero. */
  function pintarFaltas(faltas, llevar) {
    for (const campo of CAMPOS) quitarError(campo);

    const caja = $("pendientes");
    const lista = $("pendientes-lista");
    lista.textContent = "";

    if (faltas.length === 0) {
      caja.hidden = true;
      return;
    }

    $("pendientes-titulo-texto").textContent =
      faltas.length === 1 ? "Falta una cosa" : `Faltan ${faltas.length} cosas`;

    for (const f of faltas) {
      if (f.campo) ponerError(f.campo, f.texto);

      // Cada linea lleva a su sitio. Con el checklist en acordeon, el punto sin
      // marcar puede estar dentro de un bloque cerrado: ahi no basta con hacer
      // scroll, hay que abrirlo.
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pendiente";
      b.textContent = f.texto;
      b.addEventListener("click", () => irA(f));
      li.appendChild(b);
      lista.appendChild(li);
    }

    caja.hidden = false;
    if (llevar) irA(faltas[0]);
  }

  /** Lleva la pantalla a lo que falta, abriendo el bloque si hace falta. */
  function irA(falta) {
    if (falta.campo) {
      const caja = cajaDe(falta.campo);
      if (caja) caja.scrollIntoView({ behavior: "smooth", block: "center" });
      // El foco va despues del scroll: en iOS, enfocar un campo lo desplaza
      // por su cuenta y pelea con el scrollIntoView.
      const control = $(falta.campo);
      if (control && !control.readOnly && control.tagName !== "SELECT") {
        setTimeout(() => control.focus({ preventScroll: true }), 320);
      }
      return;
    }
    if (falta.grupo) {
      abrirGrupo(falta.grupo, true);
      const g = estado.grupos.get(falta.grupo);
      if (g) setTimeout(() => g.caja.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
    }
  }

  /** Revalida en vivo, pero solo despues del primer intento de enviar: antes
      de eso un campo vacio esta pendiente, no equivocado. */
  function revalidarSiHaceFalta() {
    if (!intentoDeEnvio) return;
    pintarFaltas(revisar(), false);
  }

  // -------------------------------------------------------------------------
  // Checklist
  // -------------------------------------------------------------------------
  // Ningun punto viene premarcado: hay que tocar OK o Falla en cada uno. Un
  // formulario que llegara todo en "OK" se enviaria sin mirar el vehiculo, y
  // eso vaciaria de sentido el registro. Un toque por punto sigue siendo
  // rapido, y el contador de la barra deja claro cuanto falta.

  function pintarChecklist() {
    const cont = $("checklist");
    cont.innerHTML = "";
    estado.grupos.clear();

    if (estado.actividades.length === 0) {
      const p = document.createElement("p");
      p.className = "sub";
      p.textContent = "El catálogo de actividades está vacío. No se puede registrar todavía.";
      cont.appendChild(p);
      return;
    }

    // Se agrupa primero para saber cuantos grupos hay antes de pintar: el
    // numero de paso de la cabecera necesita el total.
    const porGrupo = new Map();
    for (const act of estado.actividades) {
      const g = act.grupo || "Otros";
      if (!porGrupo.has(g)) porGrupo.set(g, []);
      porGrupo.get(g).push(act);
    }
    const nombres = [...porGrupo.keys()];

    nombres.forEach((nombre, i) => {
      const actividades = porGrupo.get(nombre);

      const caja = document.createElement("section");
      caja.className = "bloque";
      caja.dataset.grupo = nombre;

      // --- Cabecera: abre y cierra ---
      const cab = document.createElement("button");
      cab.type = "button";
      cab.className = "bloque-cab";
      cab.setAttribute("aria-expanded", "false");

      const paso = document.createElement("span");
      paso.className = "bloque-paso";
      paso.textContent = String(i + 1);

      const titulo = document.createElement("span");
      titulo.className = "bloque-nombre";
      titulo.textContent = nombre;

      const cuenta = document.createElement("span");
      cuenta.className = "bloque-cuenta";
      cuenta.textContent = "0/" + actividades.length;

      const flecha = document.createElement("span");
      flecha.className = "bloque-flecha";
      flecha.setAttribute("aria-hidden", "true");
      flecha.textContent = "▾";

      cab.append(paso, titulo, cuenta, flecha);

      // Tres capas para poder animar: la envoltura hace de grid 0fr/1fr, el
      // cuerpo recorta, y el interior lleva el padding. Con el padding en el
      // cuerpo, la altura nunca llega a cero y el bloque cerrado deja un borde
      // visible.
      const envoltura = document.createElement("div");
      envoltura.className = "bloque-envoltura";
      const cuerpo = document.createElement("div");
      cuerpo.className = "bloque-cuerpo";
      const interior = document.createElement("div");
      interior.className = "bloque-interior";
      cuerpo.appendChild(interior);
      envoltura.appendChild(cuerpo);

      cab.addEventListener("click", () => abrirGrupo(nombre, !(caja.dataset.abierto === "si")));

      // --- "Todo bien": marca OK lo que quede pendiente de ESTE grupo ---
      // Por grupo y no global a proposito. Un boton unico para los 40 puntos
      // convierte el alistamiento en un solo toque, y lo que queda firmado es
      // que se revisaron 40 cosas. Por grupo hay que recorrer los nueve, que
      // es justo el recorrido que el formulario debe provocar.
      const todoBien = document.createElement("button");
      todoBien.type = "button";
      todoBien.className = "todo-bien";
      todoBien.textContent = "✓  Todo bien en " + nombre.toLowerCase();
      todoBien.addEventListener("click", () => marcarGrupoOk(nombre));
      interior.appendChild(todoBien);

      for (const act of actividades) {
        interior.appendChild(construirItem(act));
      }

      caja.append(cab, envoltura);
      cont.appendChild(caja);

      estado.grupos.set(nombre, { caja, cab, cuerpo: interior, cuenta, todoBien, actividades });
    });

    // El primero abierto: el formulario debe empezar mostrando algo que hacer,
    // no nueve filas cerradas.
    if (nombres.length > 0) abrirGrupo(nombres[0], true);

    actualizarProgreso();
  }

  /** Una tarjeta de punto, con su switch OK / Falla. */
  function construirItem(act) {
    const tarjeta = document.createElement("div");
    tarjeta.className = "item";
    tarjeta.dataset.grupo = act.grupo || "Otros";
    tarjeta.dataset.id = String(act.id);

    // El texto y el switch van juntos en una fila propia, y la tarjeta es un
    // grid de una columna. Antes la tarjeta ERA la fila, asi que el campo de
    // observacion entraba como tercera columna y encimaba el texto.
    const fila = document.createElement("div");
    fila.className = "item-fila";

    const texto = document.createElement("div");
    texto.className = "item-texto";
    texto.textContent = act.descripcion;
    texto.id = "act-" + act.id;

    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "group");
    sw.setAttribute("aria-labelledby", texto.id);

    for (const [valor, rotulo, glifo] of [["ok", "Sin novedad", "✓"], ["mal", "Con falla", "!"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.valor = valor;
      b.setAttribute("aria-pressed", "false");
      // Solo el glifo: con el nombre del punto al lado, escribir "OK" y
      // "Falla" en cada uno de los 40 repetia lo que la forma y el color ya
      // dicen, y se comia el ancho del texto. El rotulo va en aria-label, que
      // es lo que lee el lector de pantalla.
      b.setAttribute("aria-label", rotulo);
      b.textContent = glifo;
      b.addEventListener("click", () => marcar(act.id, valor, sw, tarjeta));
      sw.appendChild(b);
    }

    fila.append(texto, sw);
    tarjeta.appendChild(fila);
    return tarjeta;
  }

  /** Abre un grupo y cierra los demas. Uno a la vez: con dos abiertos vuelve
      el scroll largo que es justo lo que el acordeon viene a resolver. */
  function abrirGrupo(nombre, abrir) {
    for (const [n, g] of estado.grupos) {
      const abierto = abrir && n === nombre;
      // Sin [hidden]: la altura la anima el CSS con grid-template-rows, y un
      // display:none corta la transicion. Para el lector de pantalla lo dice
      // aria-expanded, y inert evita que el teclado entre en lo cerrado.
      g.caja.dataset.abierto = abierto ? "si" : "no";
      g.cab.setAttribute("aria-expanded", String(abierto));
      if (abierto) g.cuerpo.removeAttribute("inert");
      else g.cuerpo.setAttribute("inert", "");
    }
  }

  /** Marca OK los pendientes del grupo. No toca lo ya marcado: si el conductor
      señaló una falla y despues da "todo bien", esa falla se queda. */
  function marcarGrupoOk(nombre) {
    const g = estado.grupos.get(nombre);
    if (!g) return;
    for (const act of g.actividades) {
      if (estado.marcas.has(act.id)) continue;
      const tarjeta = g.cuerpo.querySelector('.item[data-id="' + act.id + '"]');
      const sw = tarjeta && tarjeta.querySelector(".switch");
      if (sw) marcar(act.id, "ok", sw, tarjeta, true);
    }
    actualizarProgreso();
    revalidarSiHaceFalta();
    pasarAlSiguiente(nombre);
  }

  /** Cierra el grupo resuelto y abre el primero que siga pendiente. El avance
      se explica solo: al terminar un bloque aparece el que falta. */
  function pasarAlSiguiente(desde) {
    const nombres = [...estado.grupos.keys()];
    const i = nombres.indexOf(desde);
    const pendiente = nombres
      .slice(i + 1)
      .concat(nombres.slice(0, i))
      .find((n) => {
        const g = estado.grupos.get(n);
        return g.actividades.some((a) => !estado.marcas.has(a.id));
      });
    if (pendiente) {
      abrirGrupo(pendiente, true);
      estado.grupos.get(pendiente).caja.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      abrirGrupo(null, false);
    }
  }

  function marcar(id, valor, sw, tarjeta, enLote) {
    estado.marcas.set(id, valor);
    for (const b of sw.querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(b.dataset.valor === valor));
    }
    // Tiñe la tarjeta entera, no solo el boton: al bajar por la lista se ve de
    // un vistazo que quedo resuelto y que no.
    tarjeta.dataset.estado = valor;

    // Una falla pide decir cual: "algo esta mal" sin detalle no le sirve ni al
    // taller ni al reporte.
    let obs = tarjeta.querySelector(".item-obs");
    if (valor === "mal" && !obs) {
      obs = document.createElement("input");
      obs.type = "text";
      obs.className = "item-obs";
      obs.placeholder = "¿Qué encontraste? (opcional)";
      obs.dataset.obs = String(id);
      tarjeta.appendChild(obs);
    } else if (valor === "ok" && obs) {
      obs.remove();
    }

    // En lote el llamador actualiza y avanza una sola vez al final: hacerlo
    // por punto recalculaba los nueve grupos en cada iteracion.
    if (enLote) return;

    actualizarProgreso();
    revalidarSiHaceFalta();

    // Una falla deja el grupo abierto: el conductor acaba de encontrar algo y
    // probablemente quiere escribir que fue. Solo se avanza al completar el
    // grupo sin novedades pendientes.
    if (valor === "ok") {
      const grupo = tarjeta.dataset.grupo;
      const g = estado.grupos.get(grupo);
      if (g && g.actividades.every((a) => estado.marcas.has(a.id))) pasarAlSiguiente(grupo);
    }
  }

  function actualizarProgreso() {
    const total = estado.actividades.length;
    const hechas = estado.marcas.size;
    const fallas = [...estado.marcas.values()].filter((v) => v === "mal").length;

    // La cifra grande de la cabecera.
    $("hero-hechas").textContent = String(hechas);
    $("hero-total").textContent = "/" + total;

    // Y la linea de debajo, armada con nodos y no con innerHTML: las
    // descripciones vienen de la base y aqui no hace falta interpretar HTML.
    const t = $("progreso-texto");
    t.textContent = "";
    if (hechas === 0) {
      t.textContent = `Sin empezar · ${total} puntos por verificar`;
    } else if (hechas < total) {
      const n = document.createElement("strong");
      n.textContent = String(total - hechas);
      t.append(document.createTextNode("Faltan "), n, document.createTextNode(" puntos"));
    } else {
      t.textContent = "Todo verificado";
    }
    if (fallas) {
      const f = document.createElement("span");
      f.className = "fallas";
      f.textContent = `${fallas} con falla`;
      t.append(document.createTextNode(" · "), f);
    }

    const lleno = $("progreso-lleno");
    lleno.style.width = total ? `${Math.round((hechas / total) * 100)}%` : "0%";
    // Verde solo al completarse: mientras falte algo sigue siendo azul, para
    // que el color no diga "listo" antes de tiempo.
    if (total > 0 && hechas === total) lleno.dataset.lleno = "si";
    else delete lleno.dataset.lleno;

    // Estado de cada grupo, para que la cabecera cerrada ya lo diga todo.
    for (const [, g] of estado.grupos) {
      const marcadas = g.actividades.filter((a) => estado.marcas.has(a.id)).length;
      const conFalla = g.actividades.some((a) => estado.marcas.get(a.id) === "mal");
      const completo = marcadas === g.actividades.length;

      g.cuenta.textContent = `${marcadas}/${g.actividades.length}`;
      if (completo) g.caja.dataset.completo = "si";
      else delete g.caja.dataset.completo;
      // El rojo gana al verde: un grupo completo con una falla dentro es lo
      // que hay que ver, no un grupo terminado.
      if (conFalla) g.caja.dataset.falla = "si";
      else delete g.caja.dataset.falla;

      // Sin pendientes no hay nada que marcar en lote.
      g.todoBien.hidden = completo;
    }

    const listo = total > 0 && hechas === total;
    $("enviar").disabled = estado.enviando || !listo;
    const rotulo = $("enviar-texto");
    if (rotulo && !estado.enviando) {
      // Un boton apagado sin explicacion obliga a adivinar por que no deja
      // seguir; con la cuenta encima, la respuesta esta donde se mira.
      const sinRed = document.documentElement.dataset.sinred === "si";
      rotulo.textContent = !listo
        ? `Faltan ${total - hechas} de ${total} puntos`
        : sinRed
          ? "Sin conexión · tocar para reintentar"
          : "Registrar alistamiento";
    }
  }

  // -------------------------------------------------------------------------
  // Ayudas de digitacion
  // -------------------------------------------------------------------------

  // El nombre se pide al servidor de a una cedula. La nomina completa ya no
  // baja al navegador: son 298 cedulas con nombre y apellido, dato personal
  // que no tiene por que viajar a un movil para llenar un formulario.
  //
  // Se espera a que deje de escribir en vez de consultar por tecla: una cedula
  // de 10 digitos dispararia cinco consultas inutiles camino de la buena.
  let relojCedula = null;
  let consultaVigente = 0;

  $("cedula").addEventListener("input", (ev) => {
    // Se limpia el valor en el propio evento y no solo al enviar: asi lo que el
    // conductor ve escrito es exactamente lo que se va a mandar. Cubre el
    // pegado desde WhatsApp, que suele traer puntos, espacios y saltos de
    // linea, y los teclados que insertan un punto al doble espacio.
    const cedula = soloDigitos(ev.target.value);
    if (ev.target.value !== cedula) ev.target.value = cedula;
    const pista = $("pista-conductor");
    revalidarSiHaceFalta();

    clearTimeout(relojCedula);
    // Invalida lo que este en vuelo: si corrigio un digito, la respuesta de la
    // cedula anterior ya no debe escribir nada en el campo del nombre.
    consultaVigente++;

    if (cedula.length < 6) {
      decirPista(pista, "");
      $("nombre").value = "";
      return;
    }

    if (estado.nombresVistos.has(cedula)) {
      aplicarNombre(estado.nombresVistos.get(cedula), pista);
      return;
    }

    decirPista(pista, "Buscando…");
    const mia = consultaVigente;

    relojCedula = setTimeout(async () => {
      // Sin verificar no hay nombre, y sin nombre el servidor rechaza el
      // registro. Asi que estos tres casos no dicen "escribe el nombre": no se
      // puede. Dicen que se siga llenando el checklist, que no se pierde, y
      // que al volver la señal la cedula se resuelve sola.
      if (!window.SICOV.hayConexion()) {
        decirPista(pista, "Sin conexión. Sigue llenando el checklist: al volver la señal se verifica.");
        return;
      }
      try {
        const resp = await fetch(RUTA + "/conductor?cedula=" + encodeURIComponent(cedula));
        const datos = await resp.json();
        if (mia !== consultaVigente) return;

        if (resp.status === 429) {
          decirPista(pista, "Demasiadas consultas desde esta conexión. Espera unos minutos.");
          return;
        }
        const nombre = datos.habilitado ? nombreLimpio(datos.nombre) : null;
        estado.nombresVistos.set(cedula, nombre);
        aplicarNombre(nombre, pista);
      } catch {
        if (mia !== consultaVigente) return;
        decirPista(pista, "No se pudo verificar la cédula. Reintenta en un momento.");
      }
    }, 400);
  });

  /** Un solo sitio donde se escribe la pista, para que la clase no se quede pegada. */
  function decirPista(pista, texto, bien) {
    pista.className = bien ? "pista bien" : "pista";
    pista.textContent = texto;
  }

  /**
   * Instante en hora de Colombia.
   *
   * Se fija la zona en vez de usar la del telefono: el comprobante tiene que
   * decir la misma hora que quedo en el registro y que vera el regulador. Un
   * telefono con la zona mal puesta mostraria otra, y el conductor creeria que
   * se guardo a una hora distinta de la real.
   */
  function fechaHoraCol(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleString("es-CO", {
      timeZone: "America/Bogota",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  }

  // El campo del nombre no se escribe a mano: lo llena la nomina o queda
  // vacio. Un conductor inactivo, o que no este en la nomina, no puede
  // alistar, asi que no tiene sentido dejarle teclear un nombre que el
  // servidor va a rechazar de todas formas.
  function aplicarNombre(nombre, pista) {
    if (nombre) {
      $("nombre").value = nombre;
      decirPista(pista, "Conductor encontrado.", true);
    } else {
      $("nombre").value = "";
      decirPista(pista, "Esa cédula no corresponde a un conductor activo. Comunícate con Talento Humano.");
    }
  }

  // Avisa si la placa ya se alisto hoy, antes de que llene el checklist entero.
  // Kilometraje: solo digitos y con separador de miles mientras escribe. El
  // separador no viaja -- se quita antes de enviar -- pero "418.200" se
  // comprueba de un vistazo contra el tablero y "418200" no.
  $("kilometraje").addEventListener("input", (ev) => {
    const crudo = soloDigitos(ev.target.value).slice(0, 7);
    const conPuntos = crudo.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    if (ev.target.value !== conPuntos) {
      // Se conserva la posicion del cursor contando digitos y no caracteres:
      // al insertar un punto, un cursor fijado por indice salta de sitio.
      const antes = ev.target.selectionStart;
      const digitosAntes = soloDigitos(ev.target.value.slice(0, antes)).length;
      ev.target.value = conPuntos;
      let i = 0, vistos = 0;
      while (i < conPuntos.length && vistos < digitosAntes) {
        if (/\d/.test(conPuntos[i])) vistos++;
        i++;
      }
      try { ev.target.setSelectionRange(i, i); } catch (_) { /* no en todos */ }
    }
    revalidarSiHaceFalta();
  });

  // Contador de observaciones. Aparece al acercarse al limite y no antes: un
  // "0/500" permanente es ruido en un campo que casi siempre va vacio.
  const LIMITE_OBS = 500;
  $("observaciones").addEventListener("input", (ev) => {
    const usados = ev.target.value.length;
    const cuenta = $("cuenta-obs");
    if (usados > LIMITE_OBS - 80) {
      cuenta.textContent = `${usados} de ${LIMITE_OBS} caracteres`;
      cuenta.dataset.cerca = usados >= LIMITE_OBS ? "limite" : "si";
      cuenta.hidden = false;
    } else {
      cuenta.hidden = true;
    }
  });

  // -------------------------------------------------------------------------
  // Autorreporte de condiciones
  // -------------------------------------------------------------------------
  // No bloquea el registro. Si lo bloqueara, el conductor aprenderia en un dia
  // que respondiendo "si" puede trabajar, y se perderia justo el dato que se
  // queria capturar. Lo que hace es dejar constancia, marcar el alistamiento
  // con novedad y decirle que no debe operar y a quien avisar.

  let avisoAptitudVisto = { descanso: false, sustancias: false };

  for (const boton of document.querySelectorAll("[data-pregunta]")) {
    boton.addEventListener("click", () => {
      const pregunta = boton.dataset.pregunta;
      const valor = boton.dataset.valor === "si";
      estado.apto[pregunta] = valor;

      const grupo = boton.parentElement;
      for (const b of grupo.querySelectorAll("button")) {
        const marcado = b === boton;
        b.setAttribute("aria-checked", String(marcado));
        // Se quita el atributo en vez de dejarlo vacio: el CSS apaga los que
        // NO lo tienen, y un data-elegido="" seguiria contando como presente.
        if (marcado) b.dataset.elegido = b.dataset.valor;
        else delete b.dataset.elegido;
      }
      grupo.closest(".declaracion").dataset.respondida = "si";

      if (!valor && !avisoAptitudVisto[pregunta]) {
        avisoAptitudVisto[pregunta] = true;
        avisarNoApto(pregunta);
      }

      pintarEstadoDeclaracion();
      revalidarSiHaceFalta();
    });
  }

  /** Muestra el resto del formulario cuando las dos estan respondidas, y el
      campo de explicacion si alguna fue "no". */
  function pintarEstadoDeclaracion() {
    const algunNo = estado.apto.descanso === false || estado.apto.sustancias === false;
    $("apto-explicacion").hidden = !algunNo;

    const completas = estado.apto.descanso !== null && estado.apto.sustancias !== null;
    const resto = $("resto");
    const abriendo = completas && resto.hidden;
    resto.hidden = !completas;

    // La barra de envio acompaña al resto: un boton Registrar flotando sobre
    // dos preguntas sin responder invita a tocarlo para nada.
    const barra = $("barra");
    if (barra) barra.hidden = !completas || estado.enviado;

    if (abriendo) {
      // Se lleva la vista a lo que acaba de aparecer. Sin esto, en un telefono
      // el formulario crece por debajo del pliegue y parece que no paso nada.
      setTimeout(() => resto.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    }
  }

  function avisarNoApto(pregunta) {
    const esDescanso = pregunta === "descanso";
    window.SICOV.modal({
      tipo: "aviso",
      titulo: esDescanso ? "No debe operar con fatiga" : "No debe operar en esa condición",
      mensaje: esDescanso
        ? "Conducir con fatiga o somnolencia pone en riesgo su vida y la de los pasajeros. " +
          "Informe a su supervisor antes de salir: la empresa debe asignar otro conductor."
        : "No puede operar el vehículo en esa condición. Informe a su supervisor de inmediato.",
      datos: [
        ["Qué pasa ahora", "Su respuesta queda registrada"],
        ["Puede continuar", "Sí, el alistamiento se guarda"],
        ["El registro queda", "Marcado como novedad"],
      ],
      acciones: [
        {
          texto: "Entendido, avisaré a mi supervisor",
          primario: true,
          alTocar: () => window.SICOV.cerrarModal(),
        },
        {
          texto: "Cambiar mi respuesta",
          alTocar: () => {
            // Se deshace la respuesta, no se pone "si": ponerla por el
            // conductor seria responder por el.
            estado.apto[pregunta] = null;
            avisoAptitudVisto[pregunta] = false;
            const grupo = document.querySelector(`[data-campo="apto-${pregunta}"] .si-no`);
            for (const b of grupo.querySelectorAll("button")) {
              b.setAttribute("aria-checked", "false");
              delete b.dataset.elegido;
            }
            delete grupo.closest(".declaracion").dataset.respondida;
            pintarEstadoDeclaracion();
            window.SICOV.cerrarModal();
            revalidarSiHaceFalta();
          },
        },
      ],
    });
  }

  /**
   * Comprueba si la placa ya se alisto hoy. Devuelve el registro existente, o
   * null si esta libre; `undefined` si no se pudo comprobar.
   *
   * La diferencia entre null y undefined importa: sin red no se puede afirmar
   * que el vehiculo esta libre, y tratarlo como libre dejaria al conductor
   * llenar cuarenta puntos para que el servidor se lo rechace al final.
   */
  async function consultarSiYaAlisto(placa) {
    try {
      const resp = await fetch(RUTA + "/hoy?placa=" + encodeURIComponent(placa), {
        cache: "no-store",
      });
      if (!resp.ok) return undefined;
      const datos = await resp.json();
      return datos.yaRegistrado ? datos.registro || {} : null;
    } catch (_) {
      return undefined;
    }
  }

  function avisarYaAlistado(placa, r, alElegirOtra) {
    window.SICOV.modal({
      tipo: "aviso",
      titulo: "Este vehículo ya se alistó hoy",
      mensaje:
        "Solo se registra un alistamiento por vehículo y por día. Si hay que corregir algo " +
        "del que ya está, se corrige ese registro; no se crea otro.",
      datos: [
        ["Vehículo", placa],
        ["Lo registró", r.conductor],
        ["Fecha y hora", r.registrado_en ? fechaHoraCol(r.registrado_en) : null],
      ],
      acciones: [
        {
          texto: "Elegir otro vehículo",
          primario: true,
          alTocar: () => {
            // Se limpia la placa: dejarla elegida invita a seguir llenando un
            // formulario que no se va a poder enviar.
            $("placa").value = "";
            window.SICOV.cerrarModal();
            if (typeof alElegirOtra === "function") alElegirOtra();
            $("placa").focus();
          },
        },
      ],
    });
  }

  $("placa").addEventListener("change", async (ev) => {
    ocultarAviso();
    revalidarSiHaceFalta();
    const placa = ev.target.value;
    if (!placa) return;

    const pista = $("pista-placa");
    if (pista) decirPista(pista, "Comprobando…");

    const ya = await consultarSiYaAlisto(placa);

    if (ya === undefined) {
      // Sin red no se puede afirmar que esta libre. Se dice, en vez de callar:
      // callar equivale a decir que si.
      if (pista) decirPista(pista, "No se pudo comprobar si ya se alistó. Se verifica al enviar.", false);
      return;
    }
    if (ya === null) {
      if (pista) decirPista(pista, "Disponible para alistar hoy", true);
      return;
    }
    if (pista) decirPista(pista, "");
    avisarYaAlistado(placa, ya);
  });


  // -------------------------------------------------------------------------
  // Envio
  // -------------------------------------------------------------------------

  $("enviar").addEventListener("click", async () => {
    // Puerta de entrada contra el doble envio. La comprobacion de red tarda
    // hasta seis segundos, y sin esto un segundo toque en esa ventana entraba
    // como un envio aparte: el servidor rechaza el duplicado por la
    // restriccion de placa y dia, pero el conductor veria un error sobre un
    // alistamiento que SI quedo registrado.
    if (estado.enviando || estado.enviado) return;
    estado.enviando = true;
    $("enviar").disabled = true;

    try {
      await intentarEnviar();
    } finally {
      // Si quedo registrado, el estado final lo pone el cierre del modal.
      if (!estado.enviado) {
        estado.enviando = false;
        actualizarProgreso();
      }
    }
  });

  async function intentarEnviar() {
    ocultarAviso();

    // Desde aqui los campos corregidos se limpian solos mientras escribe.
    intentoDeEnvio = true;

    const faltas = revisar();
    if (faltas.length > 0) return pintarFaltas(faltas, true);
    pintarFaltas([], false);

    const placa = $("placa").value;
    const cedula = soloDigitos($("cedula").value);
    const nombre = $("nombre").value.trim();

    // La conexion se comprueba de verdad contra el servidor, no con
    // navigator.onLine: ese solo dice que hay una interfaz de red levantada, y
    // en el patio de buses el telefono queda enganchado a un wifi sin salida
    // mas veces de las que queda sin señal. Enviar en ese estado deja el
    // formulario colgado hasta que vence el tiempo de espera.
    $("enviar-texto").textContent = "Comprobando conexión…";
    const hayRed = await window.SICOV.comprobarConexion();
    if (!hayRed) {
      // Se corta aqui con el formulario intacto: el conductor recupera señal y
      // vuelve a tocar Registrar sin perder nada. El finally de arriba vuelve a
      // habilitar el boton.
      return mostrarAviso(
        "Sin conexión con el servidor. Lo que llenaste sigue aquí: busca señal y vuelve a tocar Registrar.",
      );
    }

    // Segunda comprobacion, ya con red confirmada. La primera fue al elegir la
    // placa, y entre ese momento y este pasan los minutos que toma marcar
    // cuarenta puntos: en ese rato otro conductor pudo alistar el mismo
    // vehiculo, o la primera comprobacion pudo no haberse hecho por falta de
    // señal. El servidor lo rechazaria con un 409, pero entonces el conductor
    // ya habria hecho el trabajo dos veces.
    $("enviar-texto").textContent = "Verificando el vehículo…";
    const ya = await consultarSiYaAlisto(placa);
    if (ya) {
      avisarYaAlistado(placa, ya, () => {
        // Al elegir otra placa se conserva el checklist: los puntos verificados
        // son del vehiculo anterior, asi que se limpian. Lo que se conserva es
        // la cedula y la declaracion, que son del conductor.
        estado.marcas.clear();
        for (const [, g] of estado.grupos) {
          for (const t of g.cuerpo.querySelectorAll(".item")) {
            delete t.dataset.estado;
            const obs = t.querySelector(".item-obs");
            if (obs) obs.remove();
            for (const b of t.querySelectorAll(".switch button")) {
              b.setAttribute("aria-pressed", "false");
            }
          }
        }
        const primero = [...estado.grupos.keys()][0];
        if (primero) abrirGrupo(primero, true);
        actualizarProgreso();
      });
      return;
    }

    const actividades = estado.actividades.map((act) => {
      const obs = document.querySelector(`[data-obs="${act.id}"]`);
      return {
        id: act.id,
        conforme: estado.marcas.get(act.id) === "ok",
        observacion: obs ? obs.value.trim() : null,
      };
    });

    // Al span, no al boton: escribir sobre el boton borraria el span y la
    // siguiente actualizacion del progreso no tendria donde escribir.
    $("enviar-texto").textContent = "Enviando…";

    try {
      const resp = await fetch(RUTA + "/registrar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          placa,
          // No se manda el nombre: el servidor lo resuelve contra la nomina y
          // lo que llegue del formulario lo ignora. Mandarlo sugeriria que
          // cuenta para algo.
          conductorCedula: cedula,
          kilometraje: soloDigitos($("kilometraje").value),
          observaciones: $("observaciones").value.trim(),
          // Se queda en la base de COMBUSES: la API de GESMOVIL selecciona
          // columna por columna y estas no estan en su lista.
          aptoDescanso: estado.apto.descanso,
          aptoSustancias: estado.apto.sustancias,
          aptoObservacion: $("apto-observacion").value.trim(),
          actividades,
        }),
      });
      const datos = await resp.json();

      if (!resp.ok || !datos.success) throw new Error(datos.message || "No se pudo registrar.");

      estado.enviado = true;

      const reg = datos.alistamiento || {};
      const conNovedad = reg.estado === "CON_NOVEDAD";
      const fallas = [...estado.marcas.values()].filter((v) => v === "mal").length;
      const interno = estado.internos.get(placa);

      // Se vacia la pantalla detras: si el formulario siguiera ahi, cerrar el
      // modal dejaria a la vista un Registrar que intentaria duplicar el
      // alistamiento del dia.
      const envoltura = document.querySelector(".envoltura");
      envoltura.innerHTML = "";
      const cab = document.createElement("header");
      const h = document.createElement("h1");
      h.textContent = "Alistamiento registrado";
      cab.appendChild(h);
      const p = document.createElement("p");
      p.className = "sub";
      p.textContent = `Placa ${placa} · ${fechaHoraCol(reg.registrado_en)}`;
      cab.appendChild(p);
      envoltura.appendChild(cab);
      $("barra").hidden = true;
      window.scrollTo(0, 0);

      window.SICOV.modal({
        tipo: conNovedad ? "aviso" : "bien",
        titulo: conNovedad ? "Registrado con novedad" : "Alistamiento registrado",
        mensaje: conNovedad
          ? `Quedó guardado, pero con ${fallas} punto(s) marcados como falla. Repórtalo al taller antes de salir.`
          : "Quedó guardado y disponible para el reporte a la Superintendencia.",
        datos: [
          ["Consecutivo", reg.id ? `N° ${reg.id}` : null],
          ["Vehículo", interno ? `${placa} · interno ${interno}` : placa],
          ["Conductor", nombre],
          ["Fecha y hora", fechaHoraCol(reg.registrado_en)],
          ["Puntos verificados", `${estado.marcas.size} de ${estado.actividades.length}`],
          ["Novedades", fallas > 0 ? `${fallas}` : "Ninguna"],
        ],
        acciones: [
          {
            texto: "Registrar otro vehículo",
            primario: true,
            // Recarga en vez de limpiar campos a mano: asi vuelve a pedir la
            // flota y el checklist, y no arrastra nada del anterior.
            alTocar: () => location.reload(),
          },
          { texto: "Cerrar", alTocar: () => window.SICOV.cerrarModal() },
        ],
      });
    } catch (e) {
      // El finally del llamador reactiva el boton y restaura el rotulo.
      mostrarAviso(e.message || "No se pudo enviar. Revisa tu señal e intenta de nuevo.");
    }
  }

  cargar();
})();
