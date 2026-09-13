# Portal del Conductor · Combuses

Un solo sitio donde el conductor entra una vez y encuentra su turno, marca su
asistencia y ve en qué puesto va la fila del aeropuerto. Une dos aplicaciones
que hoy viven separadas:

| Módulo | Repositorio de origen | Qué aporta |
|---|---|---|
| Asistencia | [`biometricoconductores`](https://github.com/DesarrolloCombuses/biometricoconductores) | Registro de entrada y salida con foto y ubicación |
| Aeropuerto | [`despachosaeropuerto`](https://github.com/DesarrolloCombuses/despachosaeropuerto) | Fila de espera, mapa de la flota y turnos del día |
| Tiquetes | Distribusion (sistema externo) | Validación de tiquetes en `portal.distribusion.com` |

## Cómo probarlo

Desde la raíz del repositorio:

```powershell
python -m http.server 8080
```

Abre <http://127.0.0.1:8080>. Hace falta servidor: abrir `index.html` con doble
clic (`file://`) no permite service workers ni iframes de mismo origen.

## Cómo está armado

```
portal/
├── index.html                  Cascarón: login, identificación, inicio y navegación
├── css/portal.css              Estilos del cascarón (no tocan a los módulos)
├── js/portal-config.js         Credenciales Supabase, tablas y lista de módulos
├── js/portal.js                Sesión, router, tarjetas del inicio, iframes
├── manifest.webmanifest        Único manifest de la PWA
├── sw.js                       Único service worker (scope de todo el portal)
└── modulos/
    ├── asistencia/             Copia de biometricoconductores
    └── aeropuerto/             Copia de despachosaeropuerto
```

Cada módulo se carga en un **iframe de mismo origen** y conserva su código. Se
eligió así en vez de fusionar los archivos porque las dos apps declaran
`window.APP_CONFIG`, ambas tienen un `id="loginForm"` y comparten nombres de
clase (`.tabs`, `.panel`, `.tab-badge`). Dentro de un iframe nada de eso choca,
y cada módulo puede seguir evolucionando en su propio repositorio.

### Un solo login

Las dos apps ya apuntaban al mismo proyecto Supabase con la misma anon key. Al
servirlas desde el mismo origen comparten el `localStorage` donde supabase-js
guarda la sesión, así que **el conductor se autentica una vez** y los módulos
entran solos.

Como refuerzo, el portal empuja la sesión por `postMessage`. El módulo de
asistencia ya traía implementado ese protocolo (`setupEmbeddedAutoLogin`), así
que no hubo que tocarle una línea:

```
iframe → portal : BIOMETRICO_READY
portal → iframe : BIOMETRICO_SESSION { access_token, refresh_token, … }
iframe → portal : BIOMETRICO_SESSION_OK | BIOMETRICO_SESSION_FAIL
```

### Quién es el conductor: cédula → programación

El login autentica el **usuario Combuses**; no dice qué conductor está frente al
teléfono. Justo después, el portal pide la **cédula** y trae de la programación
quién es y qué vehículo tiene hoy:

1. El conductor escribe su cédula.
2. El portal consulta **a la vez** la nómina (nombre) y `programacion_turnos`
   (turno de hoy, y el de ayer si sigue en curso de madrugada).
3. Muestra su nombre y su turno con el **vehículo en grande**, horario, base,
   puesto y si está *Próximo*, *En curso* o *Terminado*.
4. El conductor toca **Confirmar y continuar**. Si tuviera más de un turno
   vigente, toca el que va a hacer; si no es él, **No soy yo** vuelve atrás.

Sin programación para hoy puede escribir el vehículo a mano (opcional) y seguir.

La elección se guarda en el dispositivo (`localStorage`, clave
`portal_seleccion`) y **vale por el día**. Si el turno cruza la medianoche se
mantiene hasta 4 h después de la hora fin, para no volver a preguntar a mitad de
la jornada.

Detalles que importan:

- **Relevo.** Con el vehículo del turno se consulta la programación completa de
  ese vehículo, incluida la vista `v_programacion_turnos`, para mostrar con quién
  releva aunque su nombre aún no tenga cédula cruzada. La hora de `INICIA 2` es un
  límite programado, no la hora exacta del relevo.
- **Cambios de última hora.** Cada vez que se abre el inicio se vuelve a leer la
  programación de esa cédula: si le cambiaron el vehículo, lo ve.
- **Entrada ya registrada.** Si el conductor ya marcó su entrada con el
  biométrico, el turno sale como *Iniciado* (o *Cumplido* si también cerró), con
  la hora real y si fue con reconocimiento facial (`origen` `movil`/`web`) o por
  administración (`admin_form`/`manual`). Lo decide `estado_turno_actual()`, la
  misma función con la que el biométrico decide si deja marcar, así que los dos
  dicen lo mismo. Se refresca solo al registrar una marca desde Asistencia.
- **Sin señal.** La programación de cada cédula se guarda por día; sin red se
  muestra lo guardado con aviso.
- **Suplantación.** Escribir la cédula de otro no permite marcar por él: el módulo
  de asistencia exige la foto y la compara con el rostro enrolado.

Con la elección el portal arma el inicio:

- **Mi turno de hoy** — horario, vehículo, base, puesto y relevo.
- **Viajes de hoy** — encuentra el bus del turno en `despachos_realizados` (la
  tabla de la pestaña Realizados del aeropuerto) y muestra cuántos viajes lleva
  hoy, con la lista de hora e itinerario. Cuenta los despachos `ACTIVO` con ese
  número interno desde las 00:00; los cancelados no cuentan. Un despacho
  registrado dos veces (misma ruta con menos de 15 min de diferencia,
  `VIAJES_REPETIDOS_VENTANA_MS`) se muestra una sola vez. Se guarda por día
  para verlo sin señal y se vuelve a consultar cada 3 min con el inicio a la
  vista.
- **Mi jornada de hoy** — marcas de `asistencias` del día, resolviendo antes el
  `colaborador_id` a partir de la cédula.
- **Mi fila en el aeropuerto** — posición del vehículo en `enturnamiento_actual`,
  ordenando por hora de llegada y descontando los buses ocultados a mano, igual
  que hace el módulo de aeropuerto.

Y al abrir **Asistencia**, el portal le pasa la cédula al módulo
(`PORTAL_CONDUCTOR` por `postMessage`): el paso 1 se llena solo y dispara la
misma validación que el teclado, así que el vehículo programado también se
autocompleta. Si alguien escribió otra cédula a mano, no se pisa.

### Tiquetes: un sistema externo

El módulo **Tiquetes** abre el validador de Distribusion
(`portal.distribusion.com/bookings/ticket-validator`) dentro del portal. Es de
otro dominio, así que funciona distinto a los otros dos:

- **No recibe nada del portal.** Ni la sesión de Supabase ni la cédula: los
  mensajes del portal van dirigidos a su propio origen, y el módulo se marca
  `externo: true` para no intentarlo siquiera.
- **Tiene su propio login** (Ory, en `auth-ory.distribusion.com`). El conductor
  inicia sesión dentro del marco con su correo y contraseña de Distribusion.
- **Barra superior** con el bus del turno a la vista, porque el validador no lo
  recibe, y un botón **Abrir aparte** que abre la página en otra pestaña. Es la
  salida si el login falla dentro del marco: "Iniciar sesión con Google" no
  funciona embebido (Google no deja abrir su login en un iframe), y Safari en
  iPhone puede bloquear las cookies de un sitio dentro de otro.
- **Cámara** permitida en el iframe (`allow="camera"`), por si el validador lee
  códigos.
- **Recordatorio del vehículo.** Cada vez que entra a Tiquetes aparece: "Usted
  está validando tiquetes del vehículo **737**. En Distribusion debe
  seleccionar el vehículo 737". La página de Distribusion solo abre después de
  **Confirmo, es el vehículo 737**; cancelar lo deja donde estaba. Sin vehículo
  en la programación no deja seguir y lo manda a ingresar cédula o vehículo.
  Arriba del validador queda la barra "Seleccione el vehículo 737".
- **Constancia en Supabase.** Cada confirmación se guarda en
  `portal_confirmaciones_tiquetes` (cédula, conductor, vehículo, turno, usuario
  y hora). Sin señal queda en el teléfono (`localStorage`) y sube al volver la
  conexión; un id generado en el teléfono evita duplicados al reintentar. La
  tabla se crea con `supabase/migrations/20260913120000_confirmaciones_tiquetes.sql`
  y solo permite insertar: se consulta desde el panel de Supabase.
- **No es estricto.** El portal no puede fijar el bus dentro de Distribusion
  (otro dominio, y su validador no acepta el bus por el enlace). El conductor
  aún debe elegirlo; el recordatorio y la constancia reducen el error y dejan
  registro.

### Qué se recortó de cada módulo

El portal es **solo para conductores**, así que cada módulo se abre en una vista
reducida. El recorte se activa por la URL y vive en archivos aparte, sin
modificar el código original:

| Módulo | Activa | Archivos | Oculta |
|---|---|---|---|
| Asistencia | `?embed=portal` | `modo-portal.css`, `modo-portal.js` | Cabecera duplicada, pestañas Fichos Base 3, Administración y Salida incapacidad |
| Aeropuerto | `?modo=conductor` | `css/modo-conductor.css`, `js/modo-conductor.js` | Cabecera duplicada, pestañas Realizados, Despachos, Vuelos y Subida, y todas las acciones de despacho. Renombra **Listas** → "Lista de enturnamiento aeropuerto" y **Turnos** → "Programación" |

Abiertos fuera del portal, ambos módulos funcionan exactamente como antes: las
reglas cuelgan de un atributo que solo se pone con esos parámetros.

> **Esto recorta la interfaz, no los permisos.** Lo que un usuario puede leer o
> escribir de verdad lo deciden las políticas Row Level Security de Supabase. Si
> se quiere impedir que un conductor despache, hay que asegurarlo en la base de
> datos, no solo aquí.

### Instalación y iPhone

El portal **pide instalarse** desde la primera visita, antes del login (en
iPhone la app instalada no comparte sesión con Safari, así que conviene
instalar antes de entrar):

| Dónde | Qué ve el conductor |
|---|---|
| Android / computador | Hoja "Instale la aplicación" con **Instalar aplicación**: abre el aviso del navegador (`beforeinstallprompt`) |
| iPhone / iPad | Los 3 pasos: **Compartir** → **Agregar a pantalla de inicio** → **Agregar** |
| Navegador de WhatsApp, Facebook… | Aviso de abrir el enlace en Safari o Chrome, porque ahí no se puede instalar |

"Ahora no" lo calla 3 días. Instalada, no vuelve a salir. Mientras no esté
instalada queda el botón de descarga en la cabecera y **Instalar aplicación** en
Perfil. Dentro de la app no interrumpe: solo sale en el inicio y sin otra hoja
abierta.

Ajustes para iOS:

- Barra de estado `default`: con `black-translucent` la hora y la batería
  salían en blanco sobre la cabecera blanca.
- `apple-touch-icon.png` de 180 px y opaco: iOS rellena de negro la
  transparencia de los bordes del icono.
- `format-detection: telephone=no`: iOS convertía cédulas y números de bus en
  enlaces de llamada.
- Márgenes de muesca (`safe-area-inset-*`) arriba, abajo y a los lados en
  horizontal; `100vh` de respaldo para iOS anterior a 15.4.
- Los paneles de módulo no hacen scroll propio (lo hace el iframe): así iOS no
  encadena dos rebotes. Sin recuadro gris ni zoom por doble toque en botones.

### Internet obligatorio

El portal no se usa sin conexión: asistencia, viajes, fila y tiquetes dependen
del servidor. Una verificación real decide si hay internet, porque
`navigator.onLine` dice "conectado" aunque el Wi-Fi no tenga salida.

- Consulta `auth/v1/health` de Supabase (~100 bytes) al abrir, cada 30 s con la
  app a la vista, al volver a primer plano y cuando el teléfono avisa un cambio
  de red. En segundo plano no consulta.
- Si falla dos veces seguidas (la segunda a los 3 s), o el teléfono ya dice que
  no hay red, aparece **Sin conexión a internet** encima de todo: login,
  módulos, hojas y pantalla de carga. Reintenta sola cada 5 s y tiene botón
  **Reintentar**.
- Solo cuenta como conectado una respuesta real del servidor (código menor a
  500). Un 5xx de Supabase también bloquea: sin servidor el portal no sirve.
- Al volver la conexión se quita sola, refresca el inicio y sube las
  confirmaciones de tiquetes pendientes. Los módulos abiertos no se recargan:
  si el conductor estaba a mitad de una marca, sigue donde iba.
- Tiempos en `portal-config.js`: `INTERNET_VERIFICAR_MS`,
  `INTERNET_REINTENTO_MS` y `INTERNET_TIEMPO_LIMITE_MS`.

Lo guardado en el teléfono (turno, viajes, confirmaciones) se conserva, pero ya
no sirve para usar el portal sin red: solo cubre los segundos que tarda en
confirmarse una caída.

### Service worker

Manda uno solo, el del portal, con scope sobre todo el sitio. Los service
workers de los módulos quedaron desactivados **solo cuando van embebidos**
(`window.parent !== window`); sueltos siguen registrando el suyo. Dos service
workers compitiendo por el mismo scope se pisan las cachés y dejan versiones
viejas pegadas.

Estrategias de caché:

| Recurso | Estrategia |
|---|---|
| Páginas (navegación) | Network-first sin caché HTTP, cae al shell guardado |
| App shell (HTML/CSS/JS/iconos) | Cache-first con revalidación de fondo |
| Librerías de CDN y tipografías | Cache-first (van versionadas) |
| Tiles del mapa | Network-first, cae a caché, tope de 300 |
| API Supabase | Network-only, nunca se cachea |
| Nómina en Google Sheets | Network-first, cae a caché |

### Versión y actualizaciones

La versión se ve en el login, en la pantalla de la cédula, al pie del inicio y
en Perfil. Los teléfonos se actualizan solos: nadie tiene que reinstalar ni
borrar datos.

Cómo llega una versión nueva:

1. El portal pregunta si hay un `sw.js` nuevo al abrirse, al volver a primer
   plano y cada `ACTUALIZACION_VERIFICAR_MS` (10 min) con la pantalla a la
   vista.
2. El service worker nuevo descarga la versión completa y **queda en espera**.
   No se activa solo: la página vieja terminaría pidiendo archivos de la
   versión nueva.
3. El portal lo activa y recarga en un **momento seguro**: con el inicio, la
   fila del aeropuerto, el login o la cédula a la vista, sin hojas abiertas ni
   un campo a medio escribir, después de un aviso de 5 segundos.
4. Marcando asistencia o validando tiquetes solo avisa abajo. Se instala al
   volver al inicio, al tocar **Actualizar**, o cuando el conductor regresa a
   la app después de 10 minutos fuera.
5. Si la página ya llegó en la versión nueva y no hay módulos abiertos, se
   activa sin recargar.

En Perfil, **Buscar actualización** revisa en el momento.

**Publicar una versión**, desde la carpeta `portal`:

```powershell
powershell -ExecutionPolicy Bypass -File .\nueva-version.ps1 1.6.1
git commit -am "Descripción del cambio"
git push
```

El script cambia la versión en los tres sitios donde vive: `APP_VERSION` en
`js/portal-config.js`, `VERSION` en `sw.js` y los `?v=` de `index.html`. Si
`sw.js` no cambia, los teléfonos no se enteran de que hay algo nuevo, así que
**todo cambio que se publique debe pasar por el script**.

## Configuración

Todo lo editable está en [`js/portal-config.js`](js/portal-config.js):
credenciales, nombres de tablas, URL del CSV de nómina y la lista de módulos.

La `SUPABASE_ANON_KEY` es **pública por diseño** — Supabase la creó para usarse
en navegadores. La protección está en las políticas RLS de cada tabla.

## Pendientes antes de publicar

- [ ] Probar en un móvil real: cámara y GPS dentro del iframe de asistencia
      (el atributo `allow` ya los concede, pero conviene confirmarlo en Android
      y en iOS).
- [ ] Revisar las políticas RLS para que un conductor no pueda escribir en
      `despachos_realizados` ni en `enturnamiento_ocultos`.
- [ ] Aplicar en Supabase la migración
      `supabase/migrations/20260913120000_confirmaciones_tiquetes.sql`. Hasta
      entonces las confirmaciones se acumulan en cada teléfono y suben solas
      después.
- [ ] Probar el login de Distribusion y una validación de tiquete dentro del
      marco, en Android y en iPhone. Si falla, usar **Abrir aparte**.
- [ ] Decidir el repositorio y el despliegue (GitHub Pages sirve, igual que hoy).
- [ ] Definir si cada conductor tendrá su propio usuario o se seguirá usando una
      cuenta compartida por dispositivo.
