-- Caso real (MARTINEZ EDISON ANDRES, 1017160598, 21-ago-2026):
--   turno 20-ago  04:20 a 14:20 (entro 04:23, salio 16:02) -> CERRADO
--   para el 21-ago no tiene turno: tiene una NOVEDAD "Disponible" (tabla `novedades`,
--   cargada desde el panel de enturnamiento). No es un turno con hora fija, asi que
--   `programacion_turnos` no tiene fila para el 21-ago.
--
-- A las 21-ago 01:30 intento marcar la ENTRADA y la app lo bloqueo con "Jornada de
-- hoy ya cumplida, no admite mas marcas": estado_turno_actual encontro el turno del
-- 20-ago (su ventana llega hasta 12 h despues de la salida programada, es decir hasta
-- 21-ago 02:20) y, como `v_hoy_pendiente` solo mira `programacion_turnos` -que aqui no
-- tiene nada para hoy-, dio falso. Sin turno de hoy pendiente, `v_cambio` tambien dio
-- falso y la funcion declaro CUMPLIDA la jornada apoyandose en un turno de AYER.
--
-- El fix del 13-ago (cambio_de_turno) ya resuelve esto cuando hay un TURNO de hoy sin
-- cumplir, pero nunca consulto `novedades`. Esa tabla SI se consulta en
-- obtener_programacion_dia() -via novedad_conductor_dia()-, pero solo para el mensaje
-- informativo ("sin programacion: Disponible"), no para esta funcion. Por eso alguien
-- marcado "Disponible" (o "Descanso", "Pendiente", "Reconocimiento de ruta": estados
-- que segun novedad_bloquea_labor() son compatibles con trabajar) quedaba bloqueado
-- igual que si estuviera de vacaciones o incapacitado.
--
-- Arreglo: ademas del turno de hoy pendiente, tambien libera el bloqueo una novedad de
-- HOY que no bloquea labor. Se reutiliza novedad_conductor_dia() (mismo cruce por
-- nombre que ya usa el aviso informativo) en vez de duplicar esa logica aqui.

create or replace function public.estado_turno_actual(
  p_dni text,
  p_momento timestamp default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_mom timestamp;
  v_pt record;
  v_ent record;
  v_sal record;
  v_colab uuid;
  v_abierta boolean;
  v_hoy_pendiente boolean;
  v_novedad_hoy jsonb;
  v_novedad_libera boolean;
  v_novedad_aplica boolean;
  v_cambio boolean;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  v_mom := coalesce(p_momento, (now() at time zone 'America/Bogota'));

  select id into v_colab from public.colaboradores where dni = p_dni;
  if v_colab is null then
    return jsonb_build_object('ok', true, 'existe', false, 'motivo', 'colaborador');
  end if;

  -- ¿Tiene una entrada sin cerrar? Si la tiene, jamas se bloquea: le falta la salida.
  select exists (
    select 1 from public.asistencias e
     where e.colaborador_id = v_colab and e.sentido = 'entrada'
       and not exists (
         select 1 from public.asistencias s
          where s.colaborador_id = v_colab and s.sentido = 'salida'
            and (s.fecha + s.hora)::timestamp > (e.fecha + e.hora)::timestamp)
  ) into v_abierta;

  -- ¿Le falta cumplir un turno de HOY? Si es asi, una entrada nueva es legitima
  -- aunque llegue muy fuera de hora: es lo que pasa en un cambio de turno.
  select exists (
    select 1 from public.programacion_turnos pt
     where pt.dni = p_dni
       and pt.fecha = v_mom::date
       and pt.entrada_ts is not null
       and not exists (
         select 1 from public.asistencias a
          where a.colaborador_id = v_colab and a.sentido = 'entrada'
            and abs(extract(epoch from ((a.fecha + a.hora)::timestamp - pt.entrada_ts))) <= 6 * 3600)
  ) into v_hoy_pendiente;

  -- ¿Hay una novedad de HOY (Disponible, Descanso, etc.) que no impide trabajar?
  -- Mismo cruce por nombre que ya usa obtener_programacion_dia() para el aviso.
  v_novedad_hoy := public.novedad_conductor_dia(p_dni, v_mom::date);
  v_novedad_libera := coalesce((v_novedad_hoy->>'existe')::boolean, false)
                      and not coalesce((v_novedad_hoy->>'bloquea')::boolean, false);

  select pt.turno, pt.entrada_ts, pt.salida_ts, pt.vehiculo, pt.base, pt.fecha
    into v_pt
    from public.programacion_turnos pt
   where pt.dni = p_dni
     and pt.fecha between v_mom::date - 1 and v_mom::date + 1
     and pt.entrada_ts is not null and pt.salida_ts is not null
     and v_mom between pt.entrada_ts - interval '6 hours'
                   and pt.salida_ts + interval '12 hours'
   order by case when v_mom between pt.entrada_ts and pt.salida_ts then 0
                 else least(abs(extract(epoch from (v_mom - pt.entrada_ts))),
                            abs(extract(epoch from (v_mom - pt.salida_ts)))) end
   limit 1;

  if v_pt.turno is null then
    return jsonb_build_object('ok', true, 'existe', false, 'motivo', 'sin_programacion',
                              'turno_abierto', v_abierta,
                              'turno_hoy_pendiente', v_hoy_pendiente,
                              'novedad_hoy', v_novedad_hoy);
  end if;

  -- El turno que se encontro es de AYER, pero el de hoy sigue pendiente: la persona
  -- esta llegando, no repitiendo. Es la firma de un cambio de turno.
  v_cambio := (v_pt.fecha < v_mom::date and v_hoy_pendiente and not v_abierta);

  -- Misma idea para la novedad: solo libera el bloqueo si el turno que se encontro
  -- es de un dia ANTERIOR. Sin este `v_pt.fecha < v_mom::date`, una novedad de hoy
  -- que cruce (por nombre, via novedad_conductor_dia) con la persona equivocada
  -- -el cruce por nombre no es exacto, ~96% de acierto- podria des-bloquear una
  -- jornada de HOY que si se cumplio de verdad, dejando marcar de mas.
  v_novedad_aplica := (v_pt.fecha < v_mom::date and v_novedad_libera and not v_abierta);

  select a.id, a.fecha, a.hora into v_ent
    from public.asistencias a
   where a.colaborador_id = v_colab and a.sentido = 'entrada'
     and a.fecha between v_pt.fecha - 1 and v_pt.fecha + 1
     and abs(extract(epoch from ((a.fecha + a.hora)::timestamp - v_pt.entrada_ts))) <= 6 * 3600
   order by abs(extract(epoch from ((a.fecha + a.hora)::timestamp - v_pt.entrada_ts)))
   limit 1;

  select a.id, a.fecha, a.hora into v_sal
    from public.asistencias a
   where a.colaborador_id = v_colab and a.sentido = 'salida'
     and a.fecha between v_pt.fecha - 1 and v_pt.fecha + 2
     and abs(extract(epoch from ((a.fecha + a.hora)::timestamp - v_pt.salida_ts))) <= 6 * 3600
   order by abs(extract(epoch from ((a.fecha + a.hora)::timestamp - v_pt.salida_ts)))
   limit 1;

  return jsonb_build_object(
    'ok', true,
    'existe', true,
    'fecha', v_pt.fecha,
    'turno', v_pt.turno,
    'vehiculo', v_pt.vehiculo,
    'base', v_pt.base,
    'entrada_prog', to_char(v_pt.entrada_ts, 'HH24:MI'),
    'salida_prog', to_char(v_pt.salida_ts, 'HH24:MI'),
    'entrada_real', to_char(v_ent.hora, 'HH24:MI'),
    'entrada_fecha', v_ent.fecha,
    'salida_real', to_char(v_sal.hora, 'HH24:MI'),
    'salida_fecha', v_sal.fecha,
    'turno_abierto', v_abierta,
    'turno_hoy_pendiente', v_hoy_pendiente,
    'cambio_turno', v_cambio,
    'novedad_hoy', v_novedad_hoy,
    -- Cumplida solo si tiene entrada y salida, no arrastra un turno abierto, no le
    -- falta cumplir el turno de hoy Y no tiene una novedad de hoy que lo libere.
    -- Sin esto ultimo, alguien "Disponible" o en "Descanso" quedaba bloqueado con la
    -- jornada de AYER en vez de poder marcar la entrada que le estan pidiendo hoy.
    'completa', (v_ent.id is not null and v_sal.id is not null
                 and not v_abierta and not v_cambio and not v_novedad_aplica),
    'dentro_ventana', (v_mom between v_pt.entrada_ts and v_pt.salida_ts)
  );
end;
$function$;

grant execute on function public.estado_turno_actual(text, timestamp) to authenticated;
