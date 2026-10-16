// Configuración del Portal del Conductor - Combuses
//
// Las dos apps que integra este portal (asistencia biométrica y despachos
// aeropuerto) apuntan al MISMO proyecto Supabase, así que aquí vive una sola
// copia de las credenciales. La anon key es pública por diseño: la protección
// real está en las políticas Row Level Security de cada tabla.
//
// OJO: los módulos embebidos declaran su propio window.APP_CONFIG dentro de su
// iframe. Como cada iframe es un documento aparte, no chocan con este objeto.
window.PORTAL_CONFIG = {
  // Versión que ve el conductor en el login, el inicio y Perfil. Para publicar
  // una nueva no se edita a mano, se corre (desde la carpeta portal):
  //   powershell -ExecutionPolicy Bypass -File .\nueva-version.ps1 1.6.1
  // que la cambia aquí, en sw.js y en index.html a la vez.
  APP_VERSION: "v1.12.0",

  // Cada cuánto se pregunta al servidor si hay una versión nueva, con el
  // portal a la vista. También se pregunta al abrirlo y al volver a él.
  ACTUALIZACION_VERIFICAR_MS: 10 * 60 * 1000,

  SUPABASE_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_DZCceNTENY4ViP17-eZrGg_bdMElZ9X",

  // Programación de turnos del día: quién conduce, en qué vehículo, desde qué
  // base y en qué puesto. Es la tabla que alimenta la tarjeta "Mi turno de hoy".
  // Columnas usadas: fecha, turno, dni, hora_entrada, hora_salida, vehiculo,
  // base, puesto.
  TABLA_PROGRAMACION_TURNOS: "programacion_turnos",

  // Vista de la que se alimenta la tabla anterior. Trae TODOS los nombres de
  // la programación, también los que aún no tienen cédula cruzada (esos no
  // llegan a programacion_turnos). Solo se usa para poder mostrarle al conductor
  // quién es el relevo aunque su nombre aún no tenga cédula cruzada.
  VISTA_PROGRAMACION_TURNOS: "v_programacion_turnos",

  // La fila de espera: de aquí sale el puesto que ve el conductor.
  //
  // Hasta el 24-sep-2026 esto leyó `enturnamiento_actual` y le mentió a todo el
  // mundo: de 19 conductores esperando turno de verdad, a 13 les decía que su
  // bus no estaba en la fila y a los otros 6 les daba un puesto equivocado --
  // al 746 le decía que iba de 6 cuando iba de 17. Ninguno veía el puesto bien.
  //
  // `enturne_filas` la calcula el programa de enturnes con las geocercas
  // dibujadas y el cruce de la raya de llegada. Para devolverse basta dejar
  // estas dos líneas como estaban:
  //     TABLA_ENTURNAMIENTO: "enturnamiento_actual",
  //     SOLO_PUNTO_ENTURNAMIENTO: null,
  TABLA_ENTURNAMIENTO: "enturne_filas",

  // La tabla nueva guarda la fila de TODOS los puntos (Aeropuerto, Almacentro,
  // Nutibara, Terminal Norte, Exposiciones).
  //
  // En null, la tarjeta busca el bus del conductor en CUALQUIERA de esos puntos
  // y le muestra el puesto de la fila donde esté. Antes solo miraba el
  // aeropuerto, así que a los que esperaban en Almacentro les decía que su
  // vehículo no estaba en ninguna fila -- eran 13 el 24-sep-2026.
  //
  // Con el nombre de un punto ("Aeropuerto"), la tarjeta vuelve a mirar solo ese.
  SOLO_PUNTO_ENTURNAMIENTO: null,

  // Buses que un despachador ocultó a mano de la fila. Se descuentan para que
  // la posición que ve el conductor coincida con la que ve el despachador.
  TABLA_ENTURNAMIENTO_OCULTOS: "enturnamiento_ocultos",

  // Marcas de asistencia, para el resumen de jornada en el inicio.
  TABLA_ASISTENCIAS: "asistencias",

  // Despachos de cada bus, la misma tabla de la pestaña Realizados del módulo
  // de aeropuerto. La tarjeta "Viajes de hoy" cuenta los ACTIVOS del bus del
  // turno desde las 00:00. Columnas usadas: created_at, interno, itinerario,
  // estado.
  TABLA_DESPACHOS_REALIZADOS: "despachos_realizados",

  // Cada cuánto se vuelven a consultar los viajes con el inicio a la vista.
  DESPACHOS_REFRESCO_MS: 3 * 60 * 1000,

  // Despachos repetidos: la misma ruta registrada otra vez dentro de este
  // tiempo (doble registro del despachador) se muestra como un solo viaje.
  VIAJES_REPETIDOS_VENTANA_MS: 15 * 60 * 1000,

  // Tarjeta "Mi tarjeta" del inicio: la tarjeta de despacho del bus del turno
  // (viajes, pasajeros) y la lectura de la cívica en cada despacho. Las tablas
  // las crea almacentro/enturnes/sql/tarjeta_despacho.sql y los viajes los
  // publica el programa de enturnes.
  //   v_tarjeta_viajes   un renglón por viaje, con su lectura y sus cívicas
  //   civica_lecturas    el número del validador en cada despacho (una vez)
  //   civica_danos       los reportes de daño del validador, con foto
  //   tarjeta_tiquetes   cuántos tiquetes escaneó en cada despacho (una vez)
  //   tarjeta_pasajeros_conductor  cuántos pasajeros dice que movió en cada
  //                      despacho (una vez); control lo audita contra el sensor
  VISTA_TARJETA_VIAJES: "v_tarjeta_viajes",
  TABLA_CIVICA_LECTURAS: "civica_lecturas",
  TABLA_TARJETA_TIQUETES: "tarjeta_tiquetes",
  TABLA_TARJETA_PASAJEROS: "tarjeta_pasajeros_conductor",
  TABLA_CIVICA_DANOS: "civica_danos",
  BUCKET_CIVICA: "civica-evidencias",
  // Con el inicio a la vista se vuelve a pedir cada 2 min: un viaje aparece
  // un par de minutos después del despacho.
  TARJETA_REFRESCO_MS: 2 * 60 * 1000,
  // La foto del validador se achica a este lado antes de subirla: con datos
  // móviles, una foto de 4 MB no sube.
  CIVICA_FOTO_LADO_MAX: 1600,

  // Tarjeta "Documentos del bus" del inicio: los papeles del vehículo del
  // turno y el estado de la licencia del conductor. Son las mismas tablas
  // que llenan el Portal de Documentos por ruta y el panel de despachos.
  //   flota_vehiculos            interno -> placa
  //   flota_documentos_estado    el documento vigente de cada tipo por placa
  //   conductor_documentos_estado la licencia vigente por cédula
  TABLA_FLOTA_VEHICULOS: "flota_vehiculos",
  VISTA_FLOTA_DOCUMENTOS: "flota_documentos_estado",
  VISTA_CONDUCTOR_DOCUMENTOS: "conductor_documentos_estado",
  BUCKET_FLOTA_DOCUMENTOS: "flota-documentos",
  // Desde cuántos días antes del vencimiento se avisa "Por vencer" (el mismo
  // umbral de las vistas en la base de datos).
  DOCUMENTOS_POR_VENCER_DIAS: 30,
  // Los documentos cambian poco: con el inicio a la vista se vuelven a pedir
  // como mucho cada 15 min. Los enlaces para abrir un archivo duran 1 hora.
  DOCUMENTOS_REFRESCO_MS: 15 * 60 * 1000,
  DOCUMENTOS_ENLACE_S: 60 * 60,

  // Constancia de que el conductor confirmó el vehículo antes de abrir el
  // validador de tiquetes. Se crea con
  // supabase/migrations/20260913120000_confirmaciones_tiquetes.sql.
  TABLA_CONFIRMACIONES_TIQUETES: "portal_confirmaciones_tiquetes",

  // Personal de la empresa (v1.12.0): el conductor muestra un código QR que
  // cambia cada 20 s y la persona (gestora, auxiliar...) lo lee con la app del
  // personal (gestores/). Suma en los pasajeros del viaje pero no se cobra. Lo
  // crea la v10 de sql/tarjeta_despacho.sql (personal_empresa.sql).
  //   colaboradores ..... si la cédula es de un gestor: va a la app del personal
  //   personal_del_bus .. quiénes se registraron en el bus (sin cédula ni selfie)
  TABLA_COLABORADORES: "colaboradores",
  RPC_PERSONAL_DEL_BUS: "personal_del_bus",

  // Internet obligatorio: el portal no se usa sin conexión. La verificación
  // consulta el endpoint de salud de Supabase (~100 bytes) en vez de fiarse de
  // navigator.onLine, que dice "conectado" con un Wi-Fi sin salida.
  INTERNET_VERIFICAR_MS: 30 * 1000,      // con conexión: cada cuánto se comprueba
  INTERNET_REINTENTO_MS: 5 * 1000,       // sin conexión: cada cuánto se reintenta
  INTERNET_TIEMPO_LIMITE_MS: 10 * 1000,  // sin respuesta en este tiempo = sin internet

  // Ubicación obligatoria: sin permiso de ubicación, o con la del teléfono
  // apagada, el portal se bloquea igual que sin internet. Un túnel no bloquea:
  // solo cuenta como apagada si pasa este tiempo sin ninguna posición.
  UBICACION_SIN_POSICION_MS: 2 * 60 * 1000,
  UBICACION_REINTENTO_MS: 10 * 1000,     // bloqueado: cada cuánto se reintenta solo

  // Nómina de conductores publicada como CSV desde Google Sheets.
  // Columnas: dr_id, cedula, fleet, nombre, status, email, celular
  CONDUCTORES_CSV_URL:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vThNrFZLbNklMFtPeg0wF4TA1vZHnZ4YNMmGcnHfty_RoNuAQw__iV2GMXqTsv36MPiks1ARpYui1JK/pub?gid=0&single=true&output=csv",

  // Módulos del portal. Cada uno se carga en un iframe de mismo origen.
  //
  //   id       clave interna y hash de navegación (#/asistencia)
  //   src      ruta del documento a embeber
  //   permisos atributo allow= del iframe (cámara y GPS para el biométrico)
  //   precarga si true, el iframe se crea al entrar al portal en vez de al
  //            abrir el módulo.
  //   externo  sistema de otro dominio: no recibe la sesión ni la cédula, y
  //            lleva una barra con el bus del turno a la vista.
  //
  // Los dos módulos van SIN precarga a propósito. El de asistencia son ~530 KB
  // entre JS y CSS: descargarlos al entrar castiga a un conductor con datos
  // móviles que solo quería mirar su turno. Se cargan cuando se abren, y a
  // partir de la segunda vez ya salen del service worker.
  MODULOS: [
    {
      id: "asistencia",
      nombre: "Asistencia",
      descripcion: "Registra tu entrada y salida con foto",
      icono: "fingerprint",
      src: "./modulos/asistencia/asistencia-web.html?embed=portal",
      permisos: "geolocation; camera; fullscreen",
      precarga: false,
    },
    {
      id: "aeropuerto",
      nombre: "Aeropuerto",
      descripcion: "Tu posición en la fila y el mapa de la flota",
      icono: "plane",
      // modo=conductor recorta la vista a lo que le compete al conductor:
      // ver js/modo-conductor.js dentro del módulo.
      src: "./modulos/aeropuerto/aplicacion-aeropuerto.html?embed=portal&modo=conductor",
      permisos: "geolocation; fullscreen",
      precarga: false,
    },
    {
      id: "tiquetes",
      nombre: "Tiquetes",
      descripcion: "Valida los tiquetes en Distribusion",
      icono: "ticket",
      // Validador de Distribusion, con su propio login (Ory). Se deja abrir en
      // un iframe y su login con usuario y contraseña funciona ahí dentro.
      // OJO: el login CON GOOGLE no funciona embebido, Google no lo permite.
      src: "https://portal.distribusion.com/bookings/ticket-validator",
      externo: true,
      permisos: "camera; clipboard-read; clipboard-write; fullscreen",
      precarga: false,
    },
  ],
};
