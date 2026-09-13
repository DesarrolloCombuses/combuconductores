-- Cambio de turno: el conductor entra a una hora que no es la suya.
--
-- Caso real (ARRIAGA PEREA VICTOR WILMAN, 1077446967, 13-ago-2026):
--   programado hoy   turno 2, 15:45 a 00:45, vehiculo 736, BASE 8
--   se presento a    05:48   -> 597 minutos ANTES de su turno
--   razon            cambio de turno con un companero por una cita medica
--
-- La app no le pedia explicacion: directamente NO LO DEJABA MARCAR. A las 05:48
-- estado_turno_actual devolvia completa=true, porque el turno que encontraba era el
-- del DIA ANTERIOR:
--
--   turno 12-ago  14:40 a 23:00   ventana [12-ago 08:40 .. 13-ago 11:00]  <- 05:48 cae aqui
--   turno 13-ago  15:45 a 00:45   ventana [13-ago 09:45 .. 14-ago 12:45]  <- todavia no
--
-- Y el del 12-ago si estaba cumplido (entro 14:55, salio 22:56), asi que la app decia
-- "jornada de hoy ya cumplida, no admite mas marcas". La ventana de 12 h despues de la
-- salida es necesaria para los turnos que cruzan medianoche, pero aqui alcanzaba a
-- tapar la llegada del dia siguiente.
--
-- Arreglo, quirurgico: no se declara CUMPLIDA una jornada apoyandose en un turno de un
-- dia ANTERIOR cuando la persona tiene un turno para HOY que todavia no ha cumplido.
-- Si le falta entrar a su turno de hoy, una entrada nueva es legitima, venga a la hora
-- que venga. Se agrega ademas la bandera `cambio_turno` para que la app pueda pedir la
-- explicacion en vez de limitarse a dejarlo pasar.

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
                              'turno_hoy_pendiente', v_hoy_pendiente);
  end if;

  -- El turno que se encontro es de AYER, pero el de hoy sigue pendiente: la persona
  -- esta llegando, no repitiendo. Es la firma de un cambio de turno.
  v_cambio := (v_pt.fecha < v_mom::date and v_hoy_pendiente and not v_abierta);

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
    -- Cumplida solo si tiene entrada y salida, no arrastra un turno abierto Y no le
    -- falta cumplir el turno de hoy. Sin esto ultimo, quien llega temprano por un
    -- cambio de turno queda bloqueado con la jornada de AYER.
    'completa', (v_ent.id is not null and v_sal.id is not null
                 and not v_abierta and not v_cambio),
    'dentro_ventana', (v_mom between v_pt.entrada_ts and v_pt.salida_ts)
  );
end;
$function$;

grant execute on function public.estado_turno_actual(text, timestamp) to authenticated;
