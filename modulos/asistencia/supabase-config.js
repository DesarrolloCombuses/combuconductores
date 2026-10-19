window.APP_CONFIG = {
  SUPABASE_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_DZCceNTENY4ViP17-eZrGg_bdMElZ9X",
  FOTO_BUCKET: "asistencia-fotos",
  COLABORADORES_CSV_URL: "https://docs.google.com/spreadsheets/d/e/2PACX-1vQhcZDdAeeACcX0D5zVxGotVpA4vuTfkrlZAxFumqHwyfkoI9EvbYGjAv9mEkuOCpqYw6J3cQvrg3lh/pub?gid=0&single=true&output=csv",
  // Solo se marca en estos puntos (19-oct-2026; el Aeropuerto y Exposiciones no). Iguales a PUNTOS_MARCA de
  // la funcion personal-marcar-asistencia y de la app del personal (gestores/gestores-app.js).
  PUNTOS_OPERATIVOS: [
    { nombre: "Almacentro", latitud: 6.23640, longitud: -75.57095, radio_metros: 150 },
    { nombre: "Almacentro", latitud: 6.23692, longitud: -75.57000, radio_metros: 150 },     // bahia del CC San Diego
    { nombre: "Nutibara", latitud: 6.25184, longitud: -75.56211, radio_metros: 200 },       // donde esta el biometrico
    { nombre: "Nutibara", latitud: 6.25290, longitud: -75.56683, radio_metros: 150 },       // la bahia del mapa
    { nombre: "Terminal Norte", latitud: 6.27981, longitud: -75.57143, radio_metros: 150 }
  ],
  MANUAL_EXIT_WEBHOOK_URL: "https://connect.pabbly.com/webhook-listener/webhook/IjU3NjEwNTY4MDYzMDA0MzQ1MjZjNTUzMiI_3D_pc/IjU3NjcwNTZlMDYzMTA0MzA1MjZkNTUzNTUxMzYi_pc",
  MANUAL_ADMIN_EXIT_WEBHOOK_URL: "https://connect.pabbly.com/webhook-listener/webhook/IjU3NjEwNTY4MDYzMDA0MzQ1MjZjNTUzMiI_3D_pc/IjU3NjcwNTZlMDYzZTA0MzY1MjY4NTUzZDUxMzci_pc"
};
