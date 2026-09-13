-- Vista consolidada POR DIA: para una fecha, trae CADA turno programado
-- (programacion_turnos) junto con lo que el conductor realmente marco en el
-- biometrico, para ver en conjunto la programacion, el turno que le tocaba y lo
-- que hizo. A diferencia de reporte_jornadas_anomalas (solo errores), aqui salen
-- TODOS los programados del dia, con o sin novedad.
--
-- Emparejamiento: para cada turno se busca la marca de ENTRADA (y la de SALIDA)
-- del mismo conductor mas cercana a la hora programada, dentro de +-6 h (los
-- turnos estan ~8 h aparte, asi no se roba la marca del otro turno). La salida del
-- turno 2 puede caer al dia siguiente, por eso se miran marcas de p_fecha +-1.

create or replace function public.verificacion_dia(p_fecha date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_filas jsonb;
begin
  if auth.uid() is null then
    raise exception 'No autorizado: debes iniciar sesion.';
  end if;

  with prog as (
    select pt.dni, pt.turno, pt.base, pt.vehiculo,
           pt.entrada_ts, pt.salida_ts,
           coalesce(c.nombre, pt.nombre_programacion) as nombre
      from public.programacion_turnos pt
      left join public.colaboradores c on c.dni = pt.dni
     where pt.fecha = p_fecha
       and pt.entrada_ts is not null
  )
  select jsonb_agg(jsonb_build_object(
           'dni', p.dni, 'nombre', p.nombre, 'base', p.base, 'turno', p.turno,
           'vehiculo_prog', p.vehiculo,
           'entrada_prog', to_char(p.entrada_ts, 'HH24:MI'),
           'salida_prog', to_char(p.salida_ts, 'HH24:MI'),
           -- Marca real de ENTRADA (editable).
           'entrada_id', ent.id::text,
           'entrada_fecha', ent.fecha::text,
           'entrada_real', to_char(ent.hora, 'HH24:MI'),
           'entrada_veh', ent.vehiculo_reporte,
           'entrada_dif', ent.dif_min,
           -- Marca real de SALIDA (editable).
           'salida_id', sal.id::text,
           'salida_fecha', sal.fecha::text,
           'salida_real', to_char(sal.hora, 'HH24:MI'),
           'salida_veh', sal.vehiculo_reporte,
           'salida_dif', sal.dif_min
         ) order by p.vehiculo, p.turno, p.nombre)
    into v_filas
    from prog p
    left join lateral (
      select a.id, a.fecha, a.hora, a.vehiculo_reporte,
             round(extract(epoch from ((a.fecha + a.hora)::timestamp - p.entrada_ts)) / 60.0)::int as dif_min
        from public.asistencias a
        join public.colaboradores c2 on c2.id = a.colaborador_id
       where c2.dni = p.dni and a.sentido = 'entrada'
         and a.fecha between p_fecha - 1 and p_fecha + 1
         and abs(extract(epoch from ((a.fecha + a.hora)::timestamp - p.entrada_ts))) <= 6 * 3600
       order by abs(extract(epoch from ((a.fecha + a.hora)::timestamp - p.entrada_ts)))
       limit 1
    ) ent on true
    left join lateral (
      select a.id, a.fecha, a.hora, a.vehiculo_reporte,
             round(extract(epoch from ((a.fecha + a.hora)::timestamp - p.salida_ts)) / 60.0)::int as dif_min
        from public.asistencias a
        join public.colaboradores c2 on c2.id = a.colaborador_id
       where c2.dni = p.dni and a.sentido = 'salida'
         and a.fecha between p_fecha - 1 and p_fecha + 1
         and abs(extract(epoch from ((a.fecha + a.hora)::timestamp - p.salida_ts))) <= 6 * 3600
       order by abs(extract(epoch from ((a.fecha + a.hora)::timestamp - p.salida_ts)))
       limit 1
    ) sal on true;

  return jsonb_build_object(
    'ok', true,
    'fecha', p_fecha,
    'filas', coalesce(v_filas, '[]'::jsonb)
  );
end;
$function$;

grant execute on function public.verificacion_dia(date) to authenticated;
