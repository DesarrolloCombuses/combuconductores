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
  APP_VERSION: "v1.6.0",

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

  // Espejo de "esperando turno" en el aeropuerto (FIFO por hora de llegada
  // confirmada). Se usa para decirle al conductor en qué posición de la fila
  // va su vehículo.
  TABLA_ENTURNAMIENTO: "enturnamiento_actual",

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

  // Constancia de que el conductor confirmó el vehículo antes de abrir el
  // validador de tiquetes. Se crea con
  // supabase/migrations/20260913120000_confirmaciones_tiquetes.sql.
  TABLA_CONFIRMACIONES_TIQUETES: "portal_confirmaciones_tiquetes",

  // Internet obligatorio: el portal no se usa sin conexión. La verificación
  // consulta el endpoint de salud de Supabase (~100 bytes) en vez de fiarse de
  // navigator.onLine, que dice "conectado" con un Wi-Fi sin salida.
  INTERNET_VERIFICAR_MS: 30 * 1000,      // con conexión: cada cuánto se comprueba
  INTERNET_REINTENTO_MS: 5 * 1000,       // sin conexión: cada cuánto se reintenta
  INTERNET_TIEMPO_LIMITE_MS: 10 * 1000,  // sin respuesta en este tiempo = sin internet

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
  //            lleva una barra con el bus del turno y "Abrir aparte".
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
      // un iframe; su login con Google no, por eso la barra trae "Abrir aparte".
      src: "https://portal.distribusion.com/bookings/ticket-validator",
      externo: true,
      permisos: "camera; clipboard-read; clipboard-write; fullscreen",
      precarga: false,
    },
  ],
};
