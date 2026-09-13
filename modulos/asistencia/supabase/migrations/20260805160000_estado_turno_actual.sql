-- Estado del turno programado que corresponde a un momento dado.
--
-- Problema que resuelve: si el conductor YA cumplio su jornada (entrada + salida del
-- turno programado), la app igual le permitia registrar otra entrada, porque el
-- sentido solo miraba "no hay turno abierto -> entrada". Con esto se sabe que la
-- jornada del dia ya esta completa y se bloquea la marca de mas.
--
-- Devuelve el turno mas cercano al momento (0 si el momento cae dentro de la ventana
-- del turno) con sus horas programadas y las marcas reales ya registradas.

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
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  v_mom := coalesce(p_momento, (now() at time zone 'America/Bogota'));

  select id into v_colab from public.colaboradores where dni = p_dni;
  if v_colab is null then
    return jsonb_build_object('ok', true, 'existe', false, 'motivo', 'colaborador');
  end if;

  -- Turno cuya ventana contiene el momento; si ninguna lo contiene, el mas cercano.
  select pt.turno, pt.entrada_ts, pt.salida_ts, pt.vehiculo, pt.base, pt.fecha
    into v_pt
    from public.programacion_turnos pt
   where pt.dni = p_dni
     and pt.fecha between v_mom::date - 1 and v_mom::date + 1
     and pt.entrada_ts is not null and pt.salida_ts is not null
   order by case when v_mom between pt.entrada_ts and pt.salida_ts then 0
                 else least(abs(extract(epoch from (v_mom - pt.entrada_ts))),
                            abs(extract(epoch from (v_mom - pt.salida_ts)))) end
   limit 1;

  if v_pt.turno is null then
    return jsonb_build_object('ok', true, 'existe', false, 'motivo', 'sin_programacion');
  end if;

  -- Marca de ENTRADA de ese turno (la mas cercana a la hora programada, +-6 h).
  select a.id, a.fecha, a.hora into v_ent
    from public.asistencias a
   where a.colaborador_id = v_colab and a.sentido = 'entrada'
     and a.fecha between v_pt.fecha - 1 and v_pt.fecha + 1
     and abs(extract(epoch from ((a.fecha + a.hora)::timestamp - v_pt.entrada_ts))) <= 6 * 3600
   order by abs(extract(epoch from ((a.fecha + a.hora)::timestamp - v_pt.entrada_ts)))
   limit 1;

  -- Marca de SALIDA de ese turno (idem contra la hora fin programada).
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
    -- La jornada de ese turno ya se cumplio: no deberia admitir otra marca.
    'completa', (v_ent.id is not null and v_sal.id is not null),
    'dentro_ventana', (v_mom between v_pt.entrada_ts and v_pt.salida_ts)
  );
end;
$function$;

grant execute on function public.estado_turno_actual(text, timestamp) to authenticated;
