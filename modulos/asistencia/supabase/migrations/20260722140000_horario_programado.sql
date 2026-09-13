-- Consulta del horario programado de los conductores para verlo en la app.
-- Devuelve la programacion (v_programacion_turnos) por rango de fechas, con la cedula
-- cruzada cuando existe. Es solo de LECTURA del plan; no aplica fecha de corte
-- (esa solo rige las verificaciones de comportamiento).

create or replace function public.horario_programado(
  p_desde date,
  p_hasta date,
  p_buscar text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_filas jsonb;
  v_total int;
  v_buscar text;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  if p_desde > p_hasta then
    return jsonb_build_object('ok', false, 'error', 'La fecha inicial no puede ser mayor que la final.');
  end if;
  if p_hasta - p_desde > 45 then
    return jsonb_build_object('ok', false, 'error', 'El rango no puede superar 45 dias.');
  end if;

  v_buscar := nullif(trim(coalesce(p_buscar, '')), '');

  with base as (
    select
      t.fecha, t.turno, t.hora_entrada, t.hora_salida,
      t.vehiculo, t.base, t.puesto, t.nombre_programacion,
      p.dni, p.nombre_colaborador
    from public.v_programacion_turnos t
    left join public.programacion_conductor_dni p
      on p.nombre_norm = public.normalizar_nombre(t.nombre_programacion)
    where t.fecha between p_desde and p_hasta
      and (
        v_buscar is null
        or t.nombre_programacion ilike '%' || v_buscar || '%'
        or coalesce(p.dni, '') ilike '%' || v_buscar || '%'
        or coalesce(t.vehiculo, '') ilike '%' || v_buscar || '%'
        or coalesce(t.base, '') ilike '%' || v_buscar || '%'
        or coalesce(t.puesto, '') ilike '%' || v_buscar || '%'
      )
  ),
  limitado as (
    select * from base
    order by fecha, hora_entrada nulls last, vehiculo, turno
    limit 2000
  )
  select jsonb_agg(jsonb_build_object(
           'fecha', fecha, 'turno', turno,
           'entrada', to_char(hora_entrada, 'HH24:MI'),
           'salida', to_char(hora_salida, 'HH24:MI'),
           'vehiculo', vehiculo, 'base', base, 'puesto', puesto,
           'conductor', coalesce(nombre_colaborador, nombre_programacion),
           'dni', dni
         )),
         (select count(*) from base)
    into v_filas, v_total
    from limitado;

  return jsonb_build_object(
    'ok', true, 'desde', p_desde, 'hasta', p_hasta,
    'total', coalesce(v_total, 0),
    'mostrados', coalesce(jsonb_array_length(v_filas), 0),
    'filas', coalesce(v_filas, '[]'::jsonb)
  );
end;
$function$;

grant execute on function public.horario_programado(date, date, text) to authenticated;
