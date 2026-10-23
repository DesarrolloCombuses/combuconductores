# Módulo: Alistamiento (SICOV)

La revisión diaria del bus antes de salir, la que va a la Supertransporte por GESMOVIL. Es el **mismo formulario** de
la app de alistamiento (repositorio `gesmovil-sicov`, carpeta `web/`, copiado en `b0a1cbd`, la v1.10.1 publicada),
dentro del Portal del Conductor desde la v1.23.0 (pestaña **Alistar**).

| Archivo | Qué es |
|---|---|
| `alistamiento.html` | el de `web/`, sin manifest ni iconos, con `modo-portal.css` y `modo-portal.js` |
| `assets/app.css`, `assets/alistamiento.js` | iguales a los de `web/assets/` |
| `assets/comun.js` | igual, menos una línea: dentro del portal no registra su service worker (el del portal es el que manda); y un comentario sin el nombre de ejemplo |
| `modo-portal.js` | lo propio del portal (abajo) |
| `modo-portal.css` | oculta la versión del SICOV, el "Cargando…" mientras revisa, y los avisos propios |

## Qué hace `modo-portal.js` (solo con `?embed=portal`)

- Le pide al portal la cédula y el bus del turno (`PORTAL_PEDIR_CONDUCTOR` → `PORTAL_CONDUCTOR`, el mismo mensaje del
  módulo de asistencia).
- La **cédula** va escrita y fija (el formulario busca el nombre en la nómina como si la tecleara).
- La **placa** de su bus va escogida, con la nota "Bus de su turno: 749. Si hoy maneja otro, cambie la placa". Si el
  bus tiene dos placas en la lista (708, 709 y 757 tienen una vieja), van arriba y él escoge.
- Si ese bus **ya tiene el alistamiento de hoy** (lo hizo el del turno 1), no sale el formulario: sale que ya está,
  la placa, quién y a qué hora. Es uno por bus y por día (lo decidió el usuario el 22-oct-2026).
- Al registrar, avisa al portal (`PORTAL_ALISTAMIENTO_REGISTRADO`) y el Inicio pasa a verde.
- Para saber las placas y cuándo quedó registrado, envuelve `fetch`: no se cambia nada de `alistamiento.js`.

El registro va igual que en la app: `POST /functions/v1/sicov-alistar/registrar`, sin la sesión del portal (la función
no la pide). La app de siempre (el enlace de GitHub Pages) sigue funcionando igual.

## Si cambia la app de alistamiento

Copiar otra vez `web/alistamiento.html` y `web/assets/{app.css,comun.js,alistamiento.js}`, y volver a hacer los dos
cambios: en el HTML los `<link>`/`<script>` de modo-portal (y sin manifest), y en `comun.js` la línea del service worker (y el ejemplo de nombre del comentario de nombreLimpio, que aquí va sin nombre).
Probar con `probar_portal_alistamiento.py`: contesta `/hoy`, `/conductor` y `/registrar` en el navegador, así que no
registra nada de verdad.
