window.APP_CONFIG = {
  SUPABASE_URL: "https://cbplebkmxrkaafqdhiyi.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_DZCceNTENY4ViP17-eZrGg_bdMElZ9X",
  FOTO_BUCKET: "asistencia-fotos",
  COLABORADORES_CSV_URL: "https://docs.google.com/spreadsheets/d/e/2PACX-1vQhcZDdAeeACcX0D5zVxGotVpA4vuTfkrlZAxFumqHwyfkoI9EvbYGjAv9mEkuOCpqYw6J3cQvrg3lh/pub?gid=0&single=true&output=csv",
  // Solo se marca en estos puntos (19-oct-2026; el Aeropuerto, Exposiciones y la oficina de la Av. Oriental no).
  // Los CUADROS de las geocercas del mapa del enturne (enturnes/zonas.json), no un circulo: pedido del usuario el 19-oct-2026.
  // Iguales a PUNTOS_MARCA de la funcion personal-marcar-asistencia y de la app del personal (gestores/gestores-app.js).
  PUNTOS_OPERATIVOS: [
    { nombre: "Almacentro", zona: "Almacentro", poligono: [[6.2355, -75.5719], [6.2373, -75.5719], [6.2373, -75.57], [6.2355, -75.57]] },
    { nombre: "Almacentro", zona: "CC San Diego (bahia de despacho)", poligono: [[6.2364, -75.5709], [6.2369, -75.5709], [6.2369, -75.5702], [6.23745, -75.5702], [6.23745, -75.5689], [6.2364, -75.5689]] },
    { nombre: "Nutibara", zona: "Nutibara", poligono: [[6.2535359, -75.5669743], [6.2531093, -75.5661964], [6.2522721, -75.5667749], [6.2526933, -75.5673874]] },
    { nombre: "Terminal Norte", zona: "Terminal Norte", poligono: [[6.280523, -75.5715718], [6.2803417, -75.5710459], [6.2791579, -75.5714294], [6.2792059, -75.5716682]] }
  ],
  MANUAL_EXIT_WEBHOOK_URL: "https://connect.pabbly.com/webhook-listener/webhook/IjU3NjEwNTY4MDYzMDA0MzQ1MjZjNTUzMiI_3D_pc/IjU3NjcwNTZlMDYzMTA0MzA1MjZkNTUzNTUxMzYi_pc",
  MANUAL_ADMIN_EXIT_WEBHOOK_URL: "https://connect.pabbly.com/webhook-listener/webhook/IjU3NjEwNTY4MDYzMDA0MzQ1MjZjNTUzMiI_3D_pc/IjU3NjcwNTZlMDYzZTA0MzY1MjY4NTUzZDUxMzci_pc"
};
