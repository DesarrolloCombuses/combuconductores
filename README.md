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

**Solo conductores (v1.24.1).** Antes de mostrar nada se mira el cargo en
`colaboradores` (la tabla de la asistencia, columna `especialidad`): tiene que
decir **CONDUCTOR** y estar **VINCULADO**. La nómina de Google Sheets no sirve para
esto: es la lista de Sonar y trae también gestores, auxiliares y líderes.

- Personal vinculado con otro cargo → *"Este portal es solo para conductores"* y
  el botón a la app del personal (`gestores/`).
- Cédula que no está en `colaboradores` → no entra (*"pide en Gestión Humana que
  revisen tu cargo"*). Un conductor nuevo entra cuando aparezca allí.
- Sin poder consultar y sin nada guardado de hoy → *"Intenta de nuevo"*.
- Una elección guardada antes se vuelve a revisar al abrir el portal y al volver la
  señal; si el cargo no es conductor, se borra y vuelve a pedir la cédula.

Al hacerlo (23-oct-2026) las 139 cédulas programadas del último mes eran todas
CONDUCTOR VINCULADO. Es un control del portal: todos los conductores entran con el
mismo usuario Combuses, así que la base no distingue quién escribe.

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
  confirmaciones de tiquetes pendientes y los códigos de gestor leídos sin
  señal. Los módulos abiertos no se recargan: si el conductor estaba a mitad de
  una marca, sigue donde iba.
- Lo único que funciona sin internet es el código de los gestores (ver abajo):
  la pantalla de "Sin conexión" trae su botón.
- Tiempos en `portal-config.js`: `INTERNET_VERIFICAR_MS`,
  `INTERNET_REINTENTO_MS` y `INTERNET_TIEMPO_LIMITE_MS`.

Lo guardado en el teléfono (turno, viajes, confirmaciones) se conserva, pero ya
no sirve para usar el portal sin red: solo cubre los segundos que tarda en
confirmarse una caída.

### Ubicación obligatoria

Igual que sin internet, el portal se bloquea sin la ubicación del teléfono, en
Android, iPhone y computador, desde la pantalla de login:

| Situación | Qué ve el conductor |
|---|---|
| Nunca se le ha pedido | "Comparta su ubicación" y **Permitir ubicación**, que lanza la pregunta del sistema |
| La negó | Los pasos para activarla en su teléfono (iPhone, Android o computador) y **Reintentar** |
| Ubicación del teléfono apagada | Pasos para encenderla; se reintenta sola cada `UBICACION_REINTENTO_MS` |
| Navegador sin ubicación | Pide abrir el portal en Chrome o Safari |

Con permiso, la posición se sigue mientras el portal está abierto
(`watchPosition`) y en Perfil se ve su estado. Un túnel o un sótano no
bloquean: solo cuenta como apagada si pasa `UBICACION_SIN_POSICION_MS` (2 min)
sin ninguna posición y los intentos fallan. Si Chrome avisa que el permiso
cambió, el portal se bloquea o desbloquea al instante.

**Límite de una aplicación web:** no puede seguir la ubicación con el portal
cerrado o en segundo plano, ni pedir "Permitir siempre". En iPhone la app
instalada puede volver a preguntar el permiso al abrirse. Seguir la ubicación
todo el tiempo, con la app cerrada, exige una app nativa (por ejemplo,
empaquetar el portal con Capacitor).

### Dónde se puede marcar la asistencia (v1.15.0)

Desde el 19-oct-2026 la entrada y la salida solo se marcan en **Almacentro,
Nutibara o Terminal Norte** (el Aeropuerto y Exposiciones no). Lejos de esos
puntos la app no toma la ubicación y no deja registrar: dice a cuántos metros
está del punto más cercano. Aplica a la pestaña Asistencia del portal
(`PUNTOS_OPERATIVOS` en `modulos/asistencia/supabase-config.js`) y a la app del
personal (`PUNTOS_MARCA` en `gestores/gestores-app.js` y en la función
`personal-marcar-asistencia`, que es la que decide). Las tres listas van iguales.

Desde la v1.15.2 (g2.3.2) cuenta el **cuadro de la geocerca** del mapa del enturne
(`enturnes/zonas.json`), no un círculo:

| Punto | Cuadros |
|---|---|
| Almacentro | Almacentro y la bahía del CC San Diego |
| Nutibara | Nutibara (la bahía; la oficina de la Av. Oriental, 535 m al oriente, no cuenta) |
| Terminal Norte | Terminal Norte |

Al borde del cuadro se le perdona lo que el celular diga que se puede equivocar, hasta
20 m (con el cuadro estricto, 1 de cada 20 marcas reales de la Terminal quedaba afuera).

Desde la v1.15.3 (g2.3.3) el **GPS tiene que estar prendido**: con el GPS apagado el
celular igual da una ubicación, pero por wifi o antena (± 100 m o más), y esa ya no
sirve. La app espera hasta 15 s a que el GPS enganche (la primera ubicación suele ser la
de wifi) y, si no engancha, dice "Prende el GPS del celular" y no deja seguir. La
función `personal-marcar-asistencia` rechaza lo mismo (`sin_gps`). El kiosco (cuenta
admin) no tiene GPS y no se le exige. En el mes anterior ninguna marca del celular pasó
de ± 100 m; las de ± 100 m justos (78 de 2016, de 59 personas que otras veces sí
marcaron con GPS) eran esa primera ubicación.

En la v1.15.4 (g2.3.4) se arregló que, con un GPS que tarda unos segundos, a los 15 s
saliera "Tardamos mucho en obtener tu ubicación" estando en el punto: al validar la cédula
se pedía la ubicación dos veces y la segunda cancelaba la primera. Ahora la segunda espera
a la que ya va (`captureCurrentLocation`), y en la app del personal una búsqueda vieja ya no
pinta nada cuando hay otra o se cerró la hoja.

También en la v1.15.4: **Tiquetes se abre aparte**. Distribusion cambió su página para que
solo se pueda mostrar dentro de su propio sitio y de unos socios (`frame-ancestors`), y en
el portal salía "portal.distribusion.com rechazó la conexión". Ahora, después de "Confirmo,
es el vehículo …", la pestaña muestra el botón "Abrir Distribusion" (se abre en el
navegador) con el bus y los pasos (`abrirAparte` en el módulo de `js/portal-config.js`).

Desde la v1.15.1 (y g2.3.1) se avisa **antes** de hacer el proceso: en el portal, apenas
se valida la cédula sale "Estás en …" o "Aquí no se puede marcar" con los lugares
autorizados (a cuánto queda cada uno y su mapa) y "Ya llegué: revisar otra vez"; lejos,
"Sí, soy yo" queda bloqueado. En la app del personal, la foto no se deja tomar hasta
saber que está en un punto.

### Personal de la empresa que se sube al bus (v1.12.0)

El personal de la empresa (gestoras, auxiliares, mecánicos, un conductor que va
de pasajero...) se sube a los buses y el sensor de la puerta lo cuenta. Desde la
v1.12.0 (16-oct-2026, a pedido del usuario) **suma en los pasajeros del viaje
pero no se cobra**, y en las observaciones queda quién fue.

- **El conductor**, en **Mi tarjeta**, en el viaje que está haciendo (el último),
  toca **Personal de la empresa** (desde la v1.14.0; antes estaba en el inicio): su
  celular muestra un código QR que **cambia cada 15 segundos**
  (`CBP1.<bus>.<cédula del conductor>.<hora ms>.<al azar>`) y, debajo, quiénes se
  registraron en su bus en las últimas 4 horas (`personal_del_bus`). El código
  sale también sin internet (botón en la pantalla de "Sin conexión").
- **La persona** usa la **app del personal** (`gestores/`, publicada en
  `https://desarrollocombuses.github.io/combuconductores/gestores/`), **sin correo
  ni clave**: escribe su cédula una vez (`personal_quien_soy`: cualquier persona
  vinculada en `colaboradores`), y al subir toca **Leer código del bus**, apunta
  la cámara, se toma una **selfie** y toca **Registrarme**
  (`personal_registrar_subida`, con dónde estaba si el celular lo permite). Sin
  señal queda guardado en su celular y se manda solo cuando vuelve.
  No tiene el usuario Combuses: no tiene con qué abrir Control.
- **Supabase** pega cada registro al viaje de ese bus (desde 30 minutos antes del
  despacho hasta que llega): `v_tarjeta_viajes.personal` y `personal_detalle`; la
  plata del conductor y la del sensor ya no lo cobran. Lo calculan las vistas: el
  programa de la oficina no cambia.
- **Mi tarjeta** muestra en el viaje *"Personal de la empresa 1 · Va en tus
  pasajeros, no se cobra"* y quién fue, y la plata sin él. Si la base todavía no
  tiene la v10, la tarjeta se pide sin esas columnas y sirve igual.
- Si un gestor escribe su cédula en el portal del conductor, le sale el botón
  **Abrir la app del personal** y no entra.

Archivos: el bloque PERSONAL DE LA EMPRESA de `js/portal.js` (el código del bus,
con `js/vendor/qrcode.min.js`), la app del personal en `gestores/`
(`index.html`, `gestores-app.js`, `gestores.css`, `sw.js` propio, su manifest y
sus iconos; usa `css/portal.css`, `js/vendor/jsQR.min.js` y la llave pública de
`js/portal-config.js`). Lo de Supabase lo crea la v10 de
`almacentro/enturnes/sql/tarjeta_despacho.sql` (para pasar de la v9:
`personal_empresa.sql`).

**g2.4.0 (20-oct-2026, pedido del usuario):** la app del personal usa los **mismos colores del portal** (el verde de
Combuses; hasta la g2.3.4 era morada): sin los colores propios en `gestores.css`, `theme-color` y el manifest en
verde, y los iconos de `gestores/assets/` pasados de morado a verde (solo el morado; el logo igual). Y tiene las
**noticias de la empresa**, las mismas de `NOTICIAS` del portal: el aviso flotante abajo en su inicio, la campana al
lado del saludo y la hoja con la noticia; "Ver" abre la página a pantalla completa dentro de la app, con "Volver" y la
cédula de ese celular ya escrita (`llenarCedula`). Lo quitado o visto hoy usa las mismas llaves del portal
(`portal_noticias_ocultas`, `portal_noticias_avisadas`).

**g2.5.0:** como el portal v1.20.0, la noticia ya no va en el aviso pequeño de abajo: al abrir la app sale
**completa en una ventana encima**, una vez al día ("Ahora no" o la X la dejan para mañana; "Ya los inscribí…" la
quita), y la campana sigue junto al saludo.

**g2.6.0 (21-oct-2026, pedido del usuario: "se ve muy vacía; que tenga un menú que explique, que se vea que es para
los gestores de servicio y gestores de movilidad, que explique los puntos donde hacer la marcación"):** la app se llama
**Gestores** ("Gestores · Combuses", *Servicio y movilidad*; el manifest también) y tiene un **menú abajo**:

- **Inicio:** el saludo con el cargo, Mi asistencia, "Leer código del bus", los registros de hoy y dos atajos.
- **Dónde marcar:** un mapa (Leaflet, el mismo del enturne; se carga al abrir esta parte) con los cuadros de
  `PUNTOS_MARCA` (los mismos que deciden la marca), los 3 puntos con lo que es cada uno, "Ver en el mapa" y "Cómo
  llegar" (Google Maps), **"¿A cuánto estoy?"** (pide la ubicación solo al tocarlo: "Usted está en Nutibara: aquí sí
  puede marcar" o a cuánto queda el más cercano), "Aquí no se marca" (Aeropuerto, Exposiciones, la oficina de la Av.
  Oriental) y lo del GPS encendido. Los cuadritos del mapa no se guardan en el celular.
- **Cómo se hace:** la guía con dibujos (antes una hoja; la primera vez sale sola, con la bienvenida) y **"Si algo
  falla"**: no me deja marcar, la cámara no lee el código, se me olvidó la salida, sin señal, mi cédula no aparece,
  cambié de celular.
- **Mi cuenta:** el nombre, el cargo y la cédula (solo los 4 últimos), para quién es la app y "No soy yo: cambiar la
  cédula".

La noticia del día sale solo en el Inicio. La puede seguir usando cualquier persona vinculada (no se cerró a otros
cargos).

**g2.6.1 (21-oct-2026, pedido del usuario: "personas de gestores y colaboradores administrativos"):** solo textos.
La app se llama **Personal** ("Personal · Combuses", *Gestores y administrativos*; el manifest también, y así
coincide con el ícono, que ya decía PERSONAL) y dice que es para los gestores y los colaboradores
administrativos. Sigue abierta a cualquier persona vinculada: un mecánico que se sube al bus se sigue
registrando.

La versión de la app del personal va aparte (`g2.6.1`): está en
`gestores/gestores-app.js`, en `gestores/sw.js` y en los `?v=` y el `esta` del
final de `gestores/index.html`. Si cambia `css/portal.css` o `js/vendor/jsQR.min.js`, hay
que subirla también, o los celulares siguen con los guardados.

La primera vez que se abre después de una actualización, el service worker viejo
todavía entrega el programa que tenía guardado (desde la g2.0.0, sin asistencia, la
tarjeta se quedaba en "Consultando…"). Desde la g2.2.1 la página revisa que el
programa que corrió sea de su misma versión; si no, espera al service worker nuevo y
se recarga sola (máximo 2 veces). Y el service worker nuevo busca cada archivo con
su `?v=` exacto, para que no vuelva a pasar.

#### Mi asistencia: el biométrico del personal (g2.1.0)

Desde la g2.1.0 (17-oct-2026, a pedido del usuario) la persona **marca su ENTRADA
y su SALIDA** en la app del personal, como en el biométrico (la app de asistencia,
`modulos/asistencia`), y la app trae **¿Cómo se hace?**, la guía con dibujos
(la entrada, el bus, el código, la foto, sin señal y la salida), que sale sola la
primera vez.

- La tarjeta **Mi asistencia** dice qué le toca (*"Hoy no ha marcado"*, *"Está
  adentro: entró hoy a las 7:02 a. m."*) y el botón **Marcar ENTRADA** o **Marcar
  SALIDA**; la marca lleva una **selfie de evidencia** (no se compara la cara) y la
  **ubicación**, las dos obligatorias. Necesita internet: la hora es la del
  servidor.
- Queda **completa**: en `asistencias` (origen `app_personal`, foto en
  `asistencia-fotos` por 15 días) **y en Buk** en el momento. Si Buk no la recibe,
  la marca queda igual y sale en "Rechazos Buk" del biométrico, donde gestión
  humana la reenvía; la app dice *"Buk pendiente"*.
- **Quién puede**: la cédula tiene que estar **activa en la base de empleados**
  (`employees.activo`, la misma que exige el biométrico) y con ficha en
  `colaboradores`. Así se habilita o se quita a alguien.
- Las mismas reglas del biométrico: entrada y salida alternadas (desde el
  9-jul-2026), la salida mínimo 1 hora después de la entrada, nada repetido en 30
  minutos, máximo 6 marcas al día desde la app. Una entrada de **más de 16 horas**
  sin salida (Buk la rechaza) no deja marcar: hay que cerrarla primero.
- **Solo se marca en Almacentro, Nutibara o Terminal Norte** (g2.3.0): la app avisa
  apenas tiene el GPS, antes de la selfie, y la función lo vuelve a revisar.
- **La tarjeta Mi asistencia va en verde** (g2.2.2, pedido del usuario); el resto de
  la app sigue morado.
- **Se me olvidó marcar la salida** (g2.2.0): sale con una entrada de otro día sin
  salida (el botón grande si lleva más de 16 h). Es el **cierre declarado** del
  biométrico (`cerrar_turno_automatico`): la persona dice a qué hora salió (se le
  propone la de la última vez que entró a una hora parecida) y por qué no marcó.
  Queda una salida `cierre_declarado` que **no va a Buk** (gestión humana la revisa
  en Verificador de horarios › Cierres declarados y la pasa a Buk), su renglón en
  `cierres_turno` y, si el turno pasa de 16 h, la novedad de `jornadas_excedidas`
  ya explicada con el mismo motivo. Máximo 20 horas; si la hora es igual o anterior
  a la de la entrada, la salida es del día siguiente.
- Si el celular la manda y no le llega la respuesta, al tocar otra vez manda la
  misma (`id_local`): no queda doble ni en la base ni en Buk.

La app no tiene sesión, así que todo eso lo hace la edge function
**`personal-marcar-asistencia`** (`backend-supabase/supabase/functions/`), con la
llave de servicio y el mismo secreto de Buk (`CTRLIT_API_TOKEN`) que usa
`enviar-asistencia-buk` (esa y `consultar-colaborador-buk` exigen sesión).
Acciones: `{ accion: "estado", dni }`, `{ accion: "marcar", dni, sentido, foto,
lat, lon, precision, id_local }` y `{ accion: "cerrar", dni, hora, motivo,
id_local }`. Necesita la revisión de sesión
("Enforce JWT verification") apagada. Mientras la función no esté en el servidor,
la tarjeta dice *"todavía no está habilitada en el servidor"* y lo demás de la app
funciona igual.

Antes (v1.10.0 y v1.11.0) el gestor mostraba un código firmado con la huella de
su celular, que control tenía que aprobar, y el conductor lo leía. Eso se quitó:
la v10 cierra esas funciones para quien no tiene sesión.

### Novedades del conductor: trasbordo, varado, accidente u otra (v1.13.0)

**Cada novedad es de un viaje** (v1.14.0, a pedido del usuario: "todo eso es
dentro de la tarjeta"). En **Mi tarjeta**, cada viaje tiene el botón **Reportar
novedad**, y debajo salen las novedades de ese viaje con su número, si tienen
video o si control las anuló. También está en la pantalla de "Sin conexión":
ahí no se sabe el viaje y la base la pega al viaje de ese bus a esa hora; si no
hay ninguno, sale en "Novedades sin viaje". El conductor escoge qué pasó,
completa lo que pide y puede grabar un **video de máximo 1 minuto**:

- **Trasbordo:** de qué bus venían los pasajeros y cuántos recibió. Lo reporta el
  bus que **recibe** (ejemplo: el 722 se vara y sus 15 pasajeros pasan al 735; el
  conductor del 735 reporta "15 del 722"). El sensor del 735 los contó otra vez,
  así que en la **movilidad** del 735 esos 15 van a **Ajustes**. Cuenta de una vez;
  un despachador lo puede anular en Control (pestaña Novedades).
- **Bus varado o daño, accidente o incidente:** la nota es opcional; solo quedan
  registrados con su video. **Otra novedad:** la nota es obligatoria.
- Cada novedad recibe su **número** (N° 1001, 1002...), que le sale al conductor y
  queda en su viaje de la tarjeta.
- **El video:** se graba desde la app con la cámara trasera, en 640×480 y unos 600
  kbps (≈ 4,5 MB el minuto); a los 60 s para solo. También se puede **elegir del
  celular**: si pesa más de 8 MB se vuelve a grabar en calidad media (tarda lo que
  dura el video); si dura más de 1 minuto no se acepta. El depósito no recibe más
  de 20 MB ni otra cosa que webm, mp4 o mov. Se borra a los **90 días**.
- **Sin señal:** la novedad y el video quedan en el celular (IndexedDB) y se
  mandan solos cuando vuelve internet (al volver, al abrir el inicio y cada
  minuto). Si la base dice que no (por ejemplo, la cédula no está vinculada), se
  le muestra al conductor y no queda en la cola.

Supabase lo crea `almacentro/enturnes/sql/novedades.sql` (la v11): la hoja
`conductor_novedades`, `conductor_novedad_reportar` (devuelve el número; mandarla dos veces no la
repite), el depósito privado `conductor-novedades` (el celular solo puede subir el
video de su novedad recién hecha, a `<año-mes>/<número>-<id_local>.<ext>`) y
`conductor_novedad_video_listo`. Todo va con la sesión del portal. Archivos: el bloque
NOVEDADES de `js/portal.js`, la hoja `#novedadSheet` y la cámara `#grabador` de
`index.html`, y lo de `.nov-*`, `.novedad-*` y `.grabador*` en `css/portal.css`.

### La plata del viaje: tiquetes, cívica y efectivo, y el cupo de 19 (v1.16.0 y v1.16.1)

Pedido del usuario el 20-oct-2026. En **Mi tarjeta**, la plata de cada viaje (pasajeros x el pasaje, sin el
personal de la empresa) se reparte en lo que pagaron **con tiquete** y lo que pagaron **en efectivo**. Los tiquetes
van dentro de los pasajeros y valen lo mismo. Ejemplo: 19 pasajeros y 12 tiquetes a $20.000 = $380.000, de los
que $240.000 son en tiquetes y $140.000 en efectivo (7 pasajeros).

- Cada viaje: *Pasajeros que llevaste 19 · $380.000*, *Tiquetes escaneados 12 · $240.000* y *En efectivo 7 ·
  $140.000*. El efectivo sale cuando están los pasajeros y los tiquetes.
- Arriba, el total del día con *"En tiquetes … · en efectivo …"* (y *"falta repartir …"* si en algún viaje faltan los
  tiquetes). El inicio lo dice cuando la tarjeta está al día. El "¿Guardar?" muestra cómo queda la plata.
- **Cupo de 19:** más de 19 pasajeros, o más tiquetes que pasajeros (escritos ahora o ya guardados), ya no se deja
  guardar; antes era solo un aviso. Solo en el portal: la base de datos no lo revisa.
- **v1.16.1, la cívica también cuenta:** los 19 se reparten en tiquete, **cívica** y efectivo (más el personal, que
  no paga). Las cívicas de un viaje son la lectura del despacho siguiente menos la suya (del viaje 2 en 2773 al 3 en
  2774: el 2 tuvo 1). Ej.: 19 pasajeros, 4 tiquetes y 1 cívica = $80.000 + $20.000 + $280.000 en efectivo (14).
  Mientras no hay lectura siguiente, lo que no es tiquete sale como *"Cívica o efectivo · se separa en el próximo
  despacho"*. Arriba: *"Tiquetes … · cívica … · efectivo …"*.
- **La cuenta en vivo:** mientras escribe, el formulario dice *"19 pasajeros = 4 con tiquete ($80.000) + …"*; con más
  de 19 dice *"Máximo 19 pasajeros: es el cupo del bus"* y el botón Guardar se apaga; igual si tiquetes y cívicas
  pasan de los pasajeros. La lectura que escribe dice cómo le queda el viaje anterior (si no cuadra, avisa).

### El conductor registra al personal sin internet (v1.24.0, app del personal g2.7.0, SQL v17)

Pedido del usuario el 22-oct-2026: los gestores dicen que no tienen datos, y es requisito que queden registrados al
subir al bus. En la hoja **Registrar personal de la empresa**, debajo del código del bus, sale *"¿La persona no tiene
internet?"* con dos botones; el conductor la registra desde su celular:

- **Leer su código:** en la app del personal la persona toca **Mostrar mi código** (sale sin internet y cambia cada 30 s):
  `CBPP1.<cédula>.<hora ms>.<al azar>.<"Nombre|Cargo" en base64url>`. El conductor lo lee con la cámara de atrás.
  La base acepta cada código **una sola vez**: una foto del código no sirve para registrar dos veces.
- **Escribir la cédula:** `personal_buscar_cedula` le muestra el nombre completo y el cargo (*"¿Es esta persona?"*).
  Su propia cédula no se deja. Cada búsqueda queda anotada (`personal_busquedas`, máx. 30 por conductor en una hora).
- Después, **una foto de la persona** con la cámara de atrás (obligatoria, decisión del usuario: es la prueba de que
  iba en el bus) y **Registrar** (`personal_registrar_por_conductor`). Cuenta igual que si la persona leyera el código:
  suma en los pasajeros y no se cobra.
- **Sin internet** (botón en la pantalla de "Sin conexión"): queda en el celular (`portal_personal_cola`) con la foto y
  se manda sola cuando vuelve la señal; el nombre se confirma entonces. En la lista sale *"Por enviar"*; si la base no
  lo acepta, *"No quedó"* con el motivo. Si la base todavía no tiene la v17, avisa y queda guardado.
- En Control sale **"Lo registró el conductor"** con la foto, y un despachador lo puede **anular**.

### El alistamiento del bus (v1.23.0)

Pedido del usuario el 22-oct-2026: *"integremos la aplicación de alistamiento, va atada a todo"*. Es la revisión diaria
del bus que va a la Supertransporte por GESMOVIL (repositorio `gesmovil-sicov`); ya la usaban desde su enlace.

- **Pestaña "Alistar"** abajo (módulo `modulos/alistamiento/`, ver su README): el mismo formulario de la app, con la
  cédula con la que entró y la placa del bus de su turno ya puestas. Si hoy maneja otro bus, cambia la placa.
- **Uno por bus y por día:** si el bus ya lo tiene (lo hizo el del turno 1), la pestaña dice que ya está, quién y a
  qué hora; no hay nada que llenar.
- **El Inicio** trae la tarjeta *"Alistamiento de hoy"*: en rojo *"Falta el alistamiento del bus 749"* con el botón
  *"Hacer el alistamiento"*, o en verde *"Hecho hoy a las 03:40"*. Mientras falte, la pestaña lleva un punto rojo.
  **No bloquea nada** (decisión del usuario): puede marcar, llenar la tarjeta y lo demás.
- Se pregunta a la función pública del formulario (`sicov-alistar`): `/formulario` una vez por sesión (las placas de
  cada bus) y `/hoy?placa=` al cargar el turno; hecho no se vuelve a preguntar ese día, pendiente cada 5 minutos como
  mucho al volver al Inicio. Si el bus no es de la ruta del SICOV (Aeropuerto), la tarjeta no sale.
- Con siete botones abajo, la letra baja a 9,5 px en teléfonos de 420 px o menos y a 9 px en los de 375 px o menos.

### Mi tarjeta por conductor (v1.22.0)

Pedido del usuario el 22-oct-2026: *"separar por conductor la liquidación del carro"*. Un bus tiene dos conductores al
día y la tarjeta es del bus: el del turno 2 veía también los viajes y la plata del turno 1.

- **De quién es cada viaje:** lo dice la base (`tarjeta_viajes_conductor`, SQL v15 en
  `almacentro/enturnes/sql/tarjeta_viajes_conductor.sql`): el último conductor del bus que marcó **entrada** en el
  biométrico antes de que el bus saliera (30 min de gracia); si nadie había marcado, el del turno programado. Con los
  viajes del 19 al 21-oct coincide en el 94 % con quien escribió la cívica (el nombre de Sonar, en el 75 %).
- **Arriba, lo suyo:** *"Tus viajes · turno 2 · entraste a las 12:40"*, sus viajes, sus totales y **"Efectivo que
  entregas"** (lo que no fue tiquete ni cívica). Lo que falta y el aviso del Inicio cuentan solo sus viajes.
- **Abajo, cerrado:** *"Viajes del otro conductor · turno 1 · …"* con cuántos viajes, pasajeros y plata, y *"no van en
  tu liquidación"*. Se puede abrir y llenar (por si la regla se equivoca); sigue abierto o cerrado aunque la tarjeta se
  actualice.
- **Sin la función en la base,** o si el conductor no es de ese bus ese día (ni programado en él ni con viajes), la
  tarjeta sale entera, como antes: se puede publicar antes de correr el SQL.
- En el celular no se guarda la cédula de nadie: solo si cada viaje es suyo, el turno y el nombre programado.

### El conductor corrige su tarjeta (v1.21.0)

Pedido del usuario el 22-oct-2026: "poner corrección en la app del portal conductor en la tarjeta". Escogió que el
conductor corrija él mismo, **el mismo día y una sola vez por número**. Ejemplo: el conductor del 722 guardó 15
pasajeros y eran 16.

- En **Mi tarjeta**, el viaje tiene el botón **Corregir** (junto a *Reportar novedad*) cuando algo se puede corregir.
- Al tocarlo sale primero la ventana **"Corregir un número"** (`#corrSheet`; la pidió el usuario: "un modal de
  confirmación mostrando cómo se hace el proceso"). Muestra:
  - el viaje (número, hora y ruta);
  - *Puedes corregir*: lo de ese viaje que se puede corregir, con su número;
  - *Así se hace*, en 3 pasos con un ejemplo (15 → 16): escribe el bueno, escoge por qué, revisa y confirma;
  - *Antes de seguir*: una sola vez, solo hoy, después el despachador, y que él ve lo de antes, lo nuevo y por qué;
  - los botones **Sí, quiero corregir** y **Cancelar**.
- Con *Sí, quiero corregir* se abre la corrección en el viaje, con cada número guardado que se puede corregir
  (*"Pasajeros · ahora dice 15"*). El conductor escribe solo el bueno y escoge por qué: *Lo escribí mal*, *Conté
  mal* u *Otra razón* (la escribe).
- La cuenta en vivo es la misma de cuando lo llenó: más de 19 o más tiquetes que pasajeros no deja seguir, y si cambia
  la cívica dice cómo quedan este viaje y el siguiente. Después, *"¿Corregir el viaje 3?"* con el número de antes
  tachado y el nuevo, y **Sí, corregir**.
- Queda en el viaje: *"Corregidos por ti"* (o *"por el despachador"*, si fue él). No se borra nada: es otro renglón
  con `corrige_a` y el motivo, como las correcciones de Control. Allá sale en *Lo que escribieron* con *desde el
  celular* y el motivo.
- **Quién puede, lo decide la base** (`almacentro/enturnes/sql/conductor_corrige_tarjeta.sql`, v14). El conductor
  puede corregir si el número lo escribió el celular con su misma cédula, es del día de hoy (2:30 a. m. a 2:30 a. m.)
  y nadie lo ha corregido. Si ya lo corrigió el despachador, o pasó el día, ya no puede; su corrección sí la puede
  corregir después el despachador. Para devolverse: `quitar_conductor_corrige_tarjeta.sql`.
- El portal pregunta una vez si la base ya tiene la función (`tarjeta_conductor_puede_corregir`): mientras el SQL no
  esté corrido, el botón no sale. Para saber qué es suyo lee `id, clave_viaje, corrige_a, origen, cedula` de las tres
  hojas; la cédula no se guarda en el celular, solo si es la suya.

### La noticia en una ventana encima (v1.20.0)

El aviso pequeño de abajo "no es informativo" (usuario, 20-oct): ahora, al abrir el Inicio, la noticia vigente sale
**completa en una ventana encima** (la misma tarjeta de la campana: imagen, texto, plazo y el botón), **una vez al
día** (`portal_noticias_presentadas`). "Ahora no", la X o tocar afuera la dejan para mañana; el botón la abre dentro
del portal; "Ya los inscribí…" la quita. No sale si hay otra hoja abierta, y el aviso para instalar la app espera. El
aviso flotante pequeño queda solo para los documentos vencidos o por vencer.

### Notificaciones de documentos (v1.19.0)

Pedido del usuario (20-oct-2026): "los documentos, si están próximos a vencer, esas notificaciones les faltan en la
aplicación; eso es súper importante". Los papeles del bus del turno (SOAT, técnico-mecánica, tarjeta de operación,
certificación de amparo; los mismos de la tarjeta "Documentos del bus") y la licencia del conductor que están
**vencidos o vencen en 30 días** (`DOCUMENTOS_POR_VENCER_DIAS`) salen como notificación:

- en la **campana** de arriba (ahora "Notificaciones"), antes que las noticias, con lo que dice la tarjeta ("Vence en
  5 días. Avísale a tu coordinador") y un botón "Ver los documentos";
- en el **aviso flotante** del Inicio, el más urgente primero: **rojo** si venció, **amarillo** si vence pronto, con
  "y N documentos más". **Ver** baja a la tarjeta "Documentos del bus" y la resalta. El de un documento vencido
  vuelve cada vez que se abre la app; el de uno por vencer, una vez al día.

Salen de la misma consulta de la tarjeta de documentos (`alertasDeDocumentos`): no hay tabla nueva. Son avisos
dentro de la app; las notificaciones del celular con la app cerrada (push) serían otro paso.

### La cívica de cada viaje (v1.18.0)

Desde el 20-oct-2026 (pedido del usuario, con el bus 710: "cuando se repite el validador no debe contar, solo
cuando cambia positivamente") las cívicas de un viaje son **su lectura menos la del despacho anterior del bus**, no
la siguiente menos la suya. El conductor escribe la lectura ya hecho el viaje (junto con sus pasajeros y tiquetes):
si el número se repite, ese viaje no tuvo cívicas. Ej.: viaje 1 en 2773, viaje 2 en 2773, viaje 3 en 2774 → el 2
tuvo 0 y el 3 tuvo 1. Lo calcula la vista `v_tarjeta_viajes` (v12, `civica_lectura_anterior.sql`, con
`lectura_anterior` al final); el portal hace la misma cuenta mientras escribe, así que al escribir la lectura ya se ve
cuánto fue tiquete, cívica y efectivo de ese mismo viaje. Si con las cívicas no cuadra con los pasajeros, solo avisa
(la lectura anterior pudo quedar mal escrita y esa la corrige el despachador); más de 19 pasajeros o más tiquetes que
pasajeros sigue sin dejar guardar. El daño del validador va en el viaje en que se dañó (el que ya tiene la lectura
del nuevo).

### Noticias de la empresa (v1.17.0)

Cada noticia de `NOTICIAS` en `js/portal-config.js` sale solo entre su `desde` y su `hasta` (hora de Colombia): se
quita sola al terminar. Desde la v1.17.2 no va encima del Inicio (la tarjeta grande tapaba todo):

- **Campana** arriba, con el número de noticias vigentes. Abre la hoja "Noticias" con cada una completa: imagen
  (`imagen`), etiqueta (`etiqueta`), título, texto, el plazo con los días que quedan, el botón y `ocultar`.
- **Aviso flotante** pequeño abajo, solo en el Inicio: icono (`icono`), nombre corto (`corto`), `aviso` y los días
  que quedan, con **Ver** y una **X**. Ver o la X lo dejan quieto por ese día (vuelve al día siguiente mientras la
  noticia siga vigente); con el aviso de versión nueva a la vista, no sale.

Con `ocultar` ("Ya los inscribí o no tengo hijos de esa edad"), el conductor la quita de su celular: ni campana ni
aviso (queda guardado en el teléfono). Para poner otra noticia se agrega a la lista y se publica el portal.

Desde la v1.17.1, al tocarla (el botón o la imagen) su enlace se abre **dentro del portal**, en el panel `noticia`:
arriba "Volver al inicio" y el nombre corto (`corto`), abajo la página; Inicio sigue marcado en la barra de abajo y
el formulario queda abierto si el conductor va y vuelve. La página de la noticia no está en `MODULOS`: nunca recibe la
sesión del portal. Desde la v1.17.3, con `llenarCedula` (el selector de un campo de esa página, en Halloween
`#ccAcudiente`) el portal escribe ahí la cédula con la que entró el conductor, como si la tecleara, y el formulario
trae solo el nombre y el cargo. Solo funciona si la página es del mismo sitio (desarrollocombuses.github.io); si no,
o si el campo ya tiene algo, no hace nada y el conductor la escribe. Para una página que no se deje mostrar dentro de otra, `abrirAparte: true` la abre
en el navegador, como Tiquetes.

La primera (20-oct-2026, pedido del usuario): **Obsequios de Halloween**, para que los conductores con hijos de 0 a
10 años los inscriban en el formulario de la empresa (https://desarrollocombuses.github.io/obsequios-halloween/), del
19 al viernes 23 de octubre. El formulario pide la cédula y el celular; el portal no le pasa nada.


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
