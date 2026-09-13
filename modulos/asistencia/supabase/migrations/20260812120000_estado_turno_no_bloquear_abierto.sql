-- Correccion del bloqueo por "jornada ya cumplida".
--
-- Caso real que lo destapo (BOHORQUEZ HERNANDEZ JAIR, 71879309):
--   11-ago  entrada 04:24 -> salida 18:08   (turno 1 programado 04:20-12:20, se extendio)
--   12-ago  entrada 06:12 -> SIN salida     (ese dia no tenia programacion)
-- Al intentar cerrar su turno el 12-ago a las 13:33, la funcion no encontraba turno
-- programado para hoy, se iba al turno mas cercano -el del 11-ago, ya cumplido- y lo
-- bloqueaba. El conductor quedaba sin poder cerrar su jornada.
--
-- Dos arreglos:
--  1. NUNCA se bloquea a quien tiene un turno ABIERTO. Si entro y no ha cerrado, la
--     unica marca que le falta es la salida: bloquearla es siempre un error.
--  2. No se toma un turno cuya ventana ya paso hace rato. El momento debe caer entre
--     6 h antes de la entrada programada y 12 h despues de la salida programada; si
--     ningun turno cumple, se responde que no hay programacion para ese momento.

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

  -- Turno cuya ventana contiene el momento; si ninguna lo contiene, el mas cercano,
  -- pero solo dentro de un margen razonable (no un turno de ayer ya terminado).
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
                              'turno_abierto', v_abierta);
  end if;

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
    -- Cumplida solo si tiene entrada y salida Y no arrastra un turno abierto.
    -- Quien tiene un turno abierto siempre debe poder cerrarlo.
    'completa', (v_ent.id is not null and v_sal.id is not null and not v_abierta),
    'dentro_ventana', (v_mom between v_pt.entrada_ts and v_pt.salida_ts)
  );
end;
$function$;

grant execute on function public.estado_turno_actual(text, timestamp) to authenticated;
